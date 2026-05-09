import { useState, useMemo, useEffect, useRef } from 'react'
import { useApp } from '../../AppContext'
import { startSession, saveEntry, db, searchPartsCatalog } from '../../lib/supabase'
import { t } from '../../lib/i18n'

const TABS = (lang) => [
  { id: 'aerial',      label: t('aerialTab', lang),      icon: '🏗️' },
  { id: 'footage',     label: t('footageTab', lang),     icon: '📏' },
  { id: 'splice',      label: t('spliceTab', lang),      icon: '🔌' },
  { id: 'underground', label: t('undergroundTab', lang), icon: '⛏️' },
]

const POLE_IDS = ['inter-12','inter-14','inter-16','term-12','term-14','term-16']

export default function TaskWorkspace({ project, phase, task, onBack, onSubmitDone, onUserTap }) {
  const { currentUser, showToast, lang, assemblies, updateTask } = useApp()

  // assemblies is now { aerial: [], footage: [], splice: [], underground: [] } from Supabase
  const ASSEMBLIES = assemblies || { aerial: [], footage: [], splice: [], underground: [] }
  const ALL_ASSEMBLIES = useMemo(() => [
    ...(ASSEMBLIES.aerial || []),
    ...(ASSEMBLIES.footage || []),
    ...(ASSEMBLIES.splice || []),
    ...(ASSEMBLIES.underground || []),
  ], [assemblies])

  const [tab, setTab] = useState('aerial')
  // Working counts are loaded from the task row in the DB, so they survive
  // refresh, device switch, and crew handoff. We init empty and hydrate
  // in the effect below.
  const [counts, setCounts] = useState({})
  const [sessionId, setSessionId] = useState(null)
  const [hoursWorked, setHoursWorked] = useState(8)
  const [note, setNote] = useState('')
  const [showSummary, setShowSummary] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [fiberCount, setFiberCount] = useState('')
  const [partQtyOverrides, setPartQtyOverrides] = useState({})
  const [extraParts, setExtraParts] = useState([])
  const [showPartSearch, setShowPartSearch] = useState(false)
  const [partSearchQuery, setPartSearchQuery] = useState('')
  const [partSearchResults, setPartSearchResults] = useState([])
  const [conduitSizes, setConduitSizes] = useState({ 'bore-ft': '', 'plow-ft': '' })

  // Track when the draft is loaded so we don't overwrite the DB with empty
  // state during the initial render before fetch completes
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [lastWorkedInfo, setLastWorkedInfo] = useState(null)
  const [flagInfo, setFlagInfo] = useState(null)
  const saveTimeoutRef = useRef(null)

  // If this task was previously flagged by the manager, surface the reason
  // so the crew knows what to fix. Only relevant when the task is back to
  // 'open' (the flow when manager flags: submission='flagged', task reverts
  // 'pending' → 'open'). After a successful resubmit, task→'pending' and
  // this banner won't be shown.
  useEffect(() => {
    if (task.status !== 'open' || !task.id || !currentUser?.id) {
      setFlagInfo(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await db
        .from('submissions')
        .select(`
          flag_reason, reviewed_at,
          reviewer:users!submissions_reviewed_by_fkey(name, initials),
          work_sessions!inner(task_id)
        `)
        .eq('user_id', currentUser.id)
        .eq('status', 'flagged')
        .eq('work_sessions.task_id', task.id)
        .order('reviewed_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      if (error) {
        console.warn('Flag info load failed:', error)
        return
      }
      if (data && data.length > 0) {
        setFlagInfo({
          reason: data[0].flag_reason,
          managerName: data[0].reviewer?.name,
          at: data[0].reviewed_at,
        })
      } else {
        setFlagInfo(null)
      }
    })()
    return () => { cancelled = true }
  }, [task.id, task.status, currentUser?.id])

  useEffect(() => {
    if (currentUser?.id) {
      startSession(currentUser.id, task.id)
        .then(s => setSessionId(s.id))
        .catch(e => console.warn('Session:', e))
    }
  }, [currentUser?.id, task.id])

  // Load the saved working draft from the task row
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await db.from('tasks')
          .select('working_counts, last_worked_by, last_worked_at, last_user:users!tasks_last_worked_by_fkey(name, initials)')
          .eq('id', task.id)
          .single()

        if (cancelled) return

        if (error) {
          // Fall back to localStorage if the column query failed for any reason
          console.warn('Draft load failed, falling back to localStorage:', error.message)
          try {
            const saved = localStorage.getItem('fiberlog_counts_' + task.id)
            if (saved) setCounts(JSON.parse(saved))
          } catch {}
          setDraftLoaded(true)
          return
        }

        const wc = data?.working_counts || {}
        if (wc.counts) setCounts(wc.counts)
        if (wc.partQtyOverrides) setPartQtyOverrides(wc.partQtyOverrides)
        if (wc.extraParts) setExtraParts(wc.extraParts)
        if (wc.conduitSizes) setConduitSizes(wc.conduitSizes)
        if (wc.fiberCount) setFiberCount(wc.fiberCount)
        if (wc.note) setNote(wc.note)
        if (typeof wc.hoursWorked === 'number') setHoursWorked(wc.hoursWorked)

        // Show "continued from X" indicator if someone else worked on this task
        if (data.last_worked_by && data.last_worked_by !== currentUser?.id && data.last_user) {
          setLastWorkedInfo({
            name: data.last_user.name,
            initials: data.last_user.initials,
            at: data.last_worked_at,
          })
        }

        setDraftLoaded(true)
      } catch (e) {
        console.warn('Draft load error:', e)
        setDraftLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [task.id, currentUser?.id])

  // Auto-save the working draft whenever relevant state changes (debounced 800ms)
  useEffect(() => {
    if (!draftLoaded || !currentUser?.id) return
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      const draft = { counts, partQtyOverrides, extraParts, conduitSizes, fiberCount, note, hoursWorked }
      try {
        const { error } = await db.from('tasks').update({
          working_counts: draft,
          last_worked_by: currentUser.id,
          last_worked_at: new Date().toISOString(),
        }).eq('id', task.id)
        if (error) console.warn('Draft save failed:', error.message)
        // Mirror counts to localStorage as a fast offline backup
        try { localStorage.setItem('fiberlog_counts_' + task.id, JSON.stringify(counts)) } catch {}
      } catch (e) {
        console.warn('Draft save error:', e)
      }
    }, 800)
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current) }
  }, [counts, partQtyOverrides, extraParts, conduitSizes, fiberCount, note, hoursWorked, task.id, currentUser?.id, draftLoaded])

  async function handlePartSearch(q) {
    setPartSearchQuery(q)
    if (q.length < 2) { setPartSearchResults([]); return }
    try {
      const data = await searchPartsCatalog(q, { limit: 8 })
      setPartSearchResults(data || [])
    } catch(e) { console.warn('Search failed:', e) }
  }

  function adjust(id, delta) {
    setCounts(prev => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }))
  }

  function setFootage(id, val) {
    setCounts(prev => ({ ...prev, [id]: parseFloat(val) || 0 }))
  }

  const allParts = useMemo(() => {
    const totals = {}
    ALL_ASSEMBLIES.forEach(asm => {
      const count = counts[asm.id] || 0
      if (!count) return
      asm.parts.forEach(p => {
        const qty = p.perFt ? count : p.qty * count
        if (!totals[p.id]) totals[p.id] = { id: p.id, name: p.name, unit: p.unit || 'ea', qty: 0 }
        totals[p.id].qty += qty
      })
    })
    return Object.values(totals)
      .filter(p => p.qty > 0 && partQtyOverrides[p.id] !== -1)
      .map(p => partQtyOverrides[p.id] !== undefined ? { ...p, qty: partQtyOverrides[p.id] } : p)
      .filter(p => p.qty > 0)
  }, [counts, partQtyOverrides, ALL_ASSEMBLIES])

  const summary = useMemo(() => {
    let strandFt = 0, fiberFt = 0, boreFt = 0, plowFt = 0, poles = 0, mstHst = 0, spliceCases = 0, handholes = 0, vaults = 0
    ALL_ASSEMBLIES.forEach(asm => {
      const count = counts[asm.id] || 0
      if (!count) return
      if (asm.id === 'strand-ft') strandFt += count
      if (asm.id === 'fiber-ft') fiberFt += count
      if (asm.id === 'bore-ft') boreFt += count
      if (asm.id === 'plow-ft') plowFt += count
      if (POLE_IDS.includes(asm.id)) poles += count
      if (asm.isMst) mstHst += count
      if (asm.isSpliceCase) spliceCases += count
      if (asm.isHandhole) handholes += count
      if (asm.isVault) vaults += count
    })
    return { strandFt, fiberFt, boreFt, plowFt, poles, mstHst, spliceCases, handholes, vaults }
  }, [counts, ALL_ASSEMBLIES])

  const totalLogged = useMemo(() => {
    return ALL_ASSEMBLIES
      .filter(asm => !asm.isFootage)
      .reduce((a, asm) => a + (counts[asm.id] || 0), 0)
  }, [counts, ALL_ASSEMBLIES])

  async function handleSubmit() {
    if (!currentUser?.id) { showToast(t('toastSelectUser', lang)); return }
    setSubmitting(true)

    // Cancel any pending debounced draft save so we don't race with the
    // post-submit clear below
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }

    try {
      let sid = sessionId
      if (!sid) {
        const s = await startSession(currentUser.id, task.id)
        sid = s.id
        setSessionId(sid)
      }

      // Save the new log_entry first so we know its id and can exclude it
      // from the cleanup that follows. Letting saveEntry errors propagate
      // is intentional — the entry+parts insert is atomic, so failure means
      // nothing landed and we shouldn't continue.
      let newEntryId = null
      if (allParts.length > 0) {
        const newEntry = await saveEntry(sid, currentUser.id, task.id, {
          type: 'material', qty: totalLogged,
          notes: note || null,
          parts: [...allParts, ...extraParts],
        })
        newEntryId = newEntry?.id || null
      }

      // Delete any PRIOR log_entries for this session+task (entry_parts
      // cascade away via FK). Without this, the manager's parts view
      // shows duplicates after a flag→resubmit cycle because the parts
      // query is scoped by session_id, not submission_id.
      let oldEntriesDel = db
        .from('log_entries')
        .delete()
        .eq('session_id', sid)
        .eq('task_id', task.id)
      if (newEntryId) oldEntriesDel = oldEntriesDel.neq('id', newEntryId)
      const { error: oldEntriesErr } = await oldEntriesDel
      if (oldEntriesErr) console.warn('Prior log_entries cleanup failed:', oldEntriesErr)

      // On re-submit, clear out any prior pending OR flagged submission for
      // this session so the manager only sees the latest one.
      const { error: cleanupErr } = await db
        .from('submissions')
        .delete()
        .eq('user_id', currentUser.id)
        .in('status', ['pending', 'flagged'])
        .eq('session_id', sid)
      if (cleanupErr) console.warn('Prior pending/flagged cleanup failed:', cleanupErr)

      const { error } = await db.from('submissions').insert({
        session_id: sid, user_id: currentUser.id,
        hours_worked: hoursWorked,
        total_footage: (summary.strandFt || 0) + (summary.fiberFt || 0),
        total_strand_ft: summary.strandFt || 0,
        total_fiber_ft: summary.fiberFt || 0,
        total_assemblies: totalLogged,
        total_poles: summary.poles || 0,
        total_conduit_ft: (summary.boreFt || 0) + (summary.plowFt || 0),
        total_mst_hst: summary.mstHst || 0,
        total_splice_cases: summary.spliceCases || 0,
        total_handholes: summary.handholes || 0,
        total_vaults: summary.vaults || 0,
        status: 'pending',
      })
      if (error) throw error

      // Submit succeeded — flip task status. We intentionally preserve
      // working_counts / last_worked_by / last_worked_at so that if the
      // manager flags this submission and the task reverts to 'open',
      // the crew can reopen and see exactly what they submitted (and
      // edit instead of re-entering). The approve_submission RPC is
      // what clears working_counts — that's the real "task is done"
      // signal.
      const { error: taskErr } = await db.from('tasks').update({
        status: 'pending',
      }).eq('id', task.id)
      if (taskErr) console.error('Task status update failed:', taskErr)

      // Propagate the status flip to AppContext immediately, so when TaskList
      // re-mounts (after the user exits this workspace) it shows the task in
      // the Submitted bucket. The realtime UPDATE fires too, but the listener
      // is in TaskList which is currently unmounted — so it'd miss this event.
      const updatedTask = {
        ...task,
        status: 'pending',
        updated_at: new Date().toISOString(),
      }
      updateTask(project.id, phase.id, updatedTask)
      showToast(t('toastSubmitted', lang))
      onSubmitDone()
    } catch(e) {
      console.error('Submit failed:', e)
      showToast('Submit failed: ' + e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const tabAsms = ASSEMBLIES[tab] || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
          </div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.name} · {phase.name}
          </div>
        </div>
        <button className="user-btn" onClick={onUserTap}>{currentUser?.initials || 'Me'}</button>
      </div>

      {/* Flag banner — shown when this task was previously flagged by the
          manager and is now back to 'open' awaiting resubmit. Surfaces the
          reason so the crew knows what to fix. */}
      {flagInfo && (
        <div style={{
          background: 'var(--red-lt)', borderBottom: '1px solid var(--border)',
          padding: '8px 14px', display: 'flex', alignItems: 'flex-start',
          gap: 8, flexShrink: 0
        }}>
          <span style={{ fontSize: 14, color: 'var(--red)', flexShrink: 0, lineHeight: 1.3 }}>⚠️</span>
          <div style={{ fontSize: 11, color: 'var(--red)', flex: 1, minWidth: 0, lineHeight: 1.4 }}>
            <span style={{ fontWeight: 700 }}>
              {lang === 'es' ? 'Marcado' : 'Flagged'}
              {flagInfo.managerName ? (lang === 'es' ? ` por ${flagInfo.managerName}` : ` by ${flagInfo.managerName}`) : ''}
            </span>
            {flagInfo.reason && (
              <div style={{ marginTop: 2, fontWeight: 500 }}>{flagInfo.reason}</div>
            )}
          </div>
        </div>
      )}

      {/* "Continued from X" indicator — visible when picking up someone else's draft */}
      {lastWorkedInfo && (
        <div style={{
          background: 'var(--teal-lt)', borderBottom: '1px solid var(--border)',
          padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0
        }}>
          <span style={{ fontSize: 11, color: 'var(--teal-dk)' }}>↻</span>
          <span style={{ fontSize: 11, color: 'var(--teal-dk)', fontWeight: 600 }}>
            {lang === 'es' ? 'Continuando desde ' : 'Continuing from '}
            {lastWorkedInfo.name}
            {lastWorkedInfo.at && (
              <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 4 }}>
                · {new Date(lastWorkedInfo.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
        {TABS(lang).map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)} style={{
            flex: 1, padding: '8px 4px', fontSize: 10, fontWeight: 600,
            background: 'none', border: 'none', cursor: 'pointer',
            borderBottom: `2px solid ${tab === tb.id ? 'var(--orange)' : 'transparent'}`,
            color: tab === tb.id ? 'var(--orange)' : 'var(--muted)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2
          }}>
            <span style={{ fontSize: 18 }}>{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>

      {/* Footage totals bar */}
      {(summary.strandFt > 0 || summary.fiberFt > 0 || summary.boreFt > 0 || summary.plowFt > 0) && (
        <div style={{ background: 'var(--orange-lt)', borderBottom: '1px solid var(--border)', padding: '8px 14px', display: 'flex', gap: 16, flexShrink: 0, flexWrap: 'wrap' }}>
          {summary.strandFt > 0 && <div style={{ fontSize: 12 }}><span style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('strandLabel', lang)} </span><span style={{ fontWeight: 800, color: 'var(--orange)' }}>{summary.strandFt.toLocaleString()} ft</span></div>}
          {summary.fiberFt > 0 && <div style={{ fontSize: 12 }}><span style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('fiberLabel', lang)} </span><span style={{ fontWeight: 800, color: 'var(--orange)' }}>{summary.fiberFt.toLocaleString()} ft {fiberCount}</span></div>}
          {summary.boreFt > 0 && <div style={{ fontSize: 12 }}><span style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('boreLabel', lang)} </span><span style={{ fontWeight: 800, color: 'var(--orange)' }}>{summary.boreFt.toLocaleString()} ft</span></div>}
          {summary.plowFt > 0 && <div style={{ fontSize: 12 }}><span style={{ color: 'var(--muted)', fontWeight: 600 }}>{t('plowLabel', lang)} </span><span style={{ fontWeight: 800, color: 'var(--orange)' }}>{summary.plowFt.toLocaleString()} ft</span></div>}
        </div>
      )}

      {/* Assembly list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 100px' }}>
        {tabAsms.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)', fontSize: 13 }}>Loading assemblies...</div>
        )}
        {tabAsms.map(asm => {
          const count = counts[asm.id] || 0
          return (
            <div key={asm.id} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8,
              borderLeft: `3px solid ${count > 0 ? 'var(--orange)' : 'transparent'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{asm.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{asm.sub}</div>
                </div>
                {asm.isFootage ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="number" value={count || ''} placeholder="0"
                      onChange={e => setFootage(asm.id, e.target.value)}
                      style={{ width: 72, padding: '6px 8px', fontSize: 16, fontWeight: 700, textAlign: 'center', border: '1.5px solid var(--border2)', borderRadius: 6, background: 'var(--bg)', color: 'var(--orange)' }} />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>ft</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {count > 0 && (<>
                      <button className="tally-btn tally-minus" onClick={() => adjust(asm.id, -1)}>−</button>
                      <div className="tally-count">{count}</div>
                    </>)}
                    <button className={`tally-btn ${count > 0 ? 'tally-plus' : 'tally-plus-big'}`} onClick={() => adjust(asm.id, 1)}>+</button>
                  </div>
                )}
              </div>

              {/* Conduit size picker */}
              {asm.isConduit && count > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>{t('conduitSize', lang)}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {['3/4"','1"','1-1/4"','1-1/2"','2"','3"'].map(sz => (
                      <button key={sz} onClick={() => setConduitSizes(prev => ({ ...prev, [asm.id]: sz }))}
                        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          border: `1.5px solid ${conduitSizes[asm.id] === sz ? 'var(--teal)' : 'var(--border2)'}`,
                          background: conduitSizes[asm.id] === sz ? 'var(--teal-lt)' : 'var(--bg)',
                          color: conduitSizes[asm.id] === sz ? 'var(--teal-dk)' : 'var(--muted)' }}>{sz}</button>
                    ))}
                  </div>
                  {conduitSizes[asm.id] && (
                    <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 6, fontWeight: 600 }}>
                      {count.toLocaleString()} ft of {conduitSizes[asm.id]} conduit + tracer wire + pull tape
                    </div>
                  )}
                </div>
              )}

              {/* Fiber count picker */}
              {asm.isFiber && count > 0 && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>{t('fiberCount', lang)}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {['12ct','24ct','48ct','72ct','144ct','288ct'].map(fc => (
                      <button key={fc} onClick={() => setFiberCount(fc)}
                        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                          border: `1.5px solid ${fiberCount === fc ? 'var(--teal)' : 'var(--border2)'}`,
                          background: fiberCount === fc ? 'var(--teal-lt)' : 'var(--bg)',
                          color: fiberCount === fc ? 'var(--teal-dk)' : 'var(--muted)' }}>{fc}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '10px 14px 28px' }}>
        {totalLogged > 0 && (
          <div style={{ fontSize: 12, color: 'var(--orange)', fontWeight: 600, marginBottom: 8, textAlign: 'center' }}>
            {summary.poles > 0 && `${summary.poles} ${t('polesLabel', lang)} · `}
            {summary.mstHst > 0 && `${summary.mstHst} MST/HST · `}
            {summary.spliceCases > 0 && `${summary.spliceCases} cases · `}
            {allParts.length} {t('partTypes', lang)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onBack}>
            {lang === 'es' ? 'Pausar' : 'Pause'}
          </button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => setShowSummary(true)}>{t('wrapUpDay', lang)}</button>
        </div>
      </div>

      {/* Submit summary sheet */}
      {showSummary && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowSummary(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>{t('submitYourDay', lang)}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
              {currentUser?.name} · {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
              {[
                summary.strandFt > 0 && { label: t('strandLabel', lang), value: `${summary.strandFt.toLocaleString()} ft` },
                summary.fiberFt > 0 && { label: t('fiberLabel', lang), value: `${summary.fiberFt.toLocaleString()} ft ${fiberCount}` },
                summary.boreFt > 0 && { label: t('boreLabel', lang), value: `${summary.boreFt.toLocaleString()} ft` },
                summary.plowFt > 0 && { label: t('plowLabel', lang), value: `${summary.plowFt.toLocaleString()} ft` },
                summary.poles > 0 && { label: t('polesLabel', lang), value: summary.poles },
                summary.mstHst > 0 && { label: 'MST/HST', value: summary.mstHst },
                summary.spliceCases > 0 && { label: 'Cases', value: summary.spliceCases },
                summary.handholes > 0 && { label: 'Handholes', value: summary.handholes },
                summary.vaults > 0 && { label: 'Vaults', value: summary.vaults },
              ].filter(Boolean).map(s => (
                <div key={s.label} style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>{t('partsAdjust', lang)}</div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 10, maxHeight: 220, overflowY: 'auto' }}>
              {allParts.length === 0 && (
                <div style={{ padding: '14px', textAlign: 'center', fontSize: 12, color: 'var(--hint)' }}>{t('noPartsLogged', lang)}</div>
              )}
              {allParts.map((p, i) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: i < allParts.length - 1 ? '1px solid var(--border)' : 'none', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--hint)' }}>{p.id}</div>
                  </div>
                  <button onClick={() => setPartQtyOverrides(prev => { const cur = prev[p.id] !== undefined ? prev[p.id] : p.qty; const next = Math.max(0, cur - 1); return next === 0 ? { ...prev, [p.id]: -1 } : { ...prev, [p.id]: next } })}
                    style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--border2)', background: 'var(--bg)', fontSize: 16, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>−</button>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--orange)', minWidth: 28, textAlign: 'center' }}>
                    {(partQtyOverrides[p.id] !== undefined ? partQtyOverrides[p.id] : p.qty).toLocaleString()}
                  </span>
                  <button onClick={() => setPartQtyOverrides(prev => { const cur = prev[p.id] !== undefined ? prev[p.id] : p.qty; return { ...prev, [p.id]: cur + 1 } })}
                    style={{ width: 26, height: 26, borderRadius: '50%', border: '1px solid var(--teal)', background: 'var(--orange-lt)', fontSize: 16, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--orange)' }}>+</button>
                  <span style={{ fontSize: 10, color: 'var(--muted)', minWidth: 14 }}>{p.unit}</span>
                </div>
              ))}
              {extraParts.map(p => (
                <div key={'extra-'+p.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--border)', gap: 8, background: 'var(--orange-lt)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{p.name} <span style={{ fontSize: 10, color: 'var(--orange)' }}>added</span></div>
                    <div style={{ fontSize: 10, color: 'var(--hint)' }}>{p.id}</div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--orange)', minWidth: 28, textAlign: 'center' }}>{p.qty}</span>
                  <span style={{ fontSize: 10, color: 'var(--muted)' }}>{p.unit}</span>
                  <button onClick={() => setExtraParts(prev => prev.filter(ep => ep.id !== p.id))}
                    style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--red-lt)', color: 'var(--red)', border: 'none', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                </div>
              ))}
            </div>

            {!showPartSearch ? (
              <button onClick={() => setShowPartSearch(true)}
                style={{ width: '100%', padding: '10px', marginBottom: 14, background: 'var(--gray-lt)', border: '1.5px dashed var(--border2)', borderRadius: 'var(--r-sm)', fontSize: 13, fontWeight: 600, color: 'var(--muted)', cursor: 'pointer' }}>
                {t('addPartNotInList', lang)}
              </button>
            ) : (
              <div style={{ marginBottom: 14 }}>
                <input type="text" placeholder={t('searchPartPlaceholder', lang)} value={partSearchQuery}
                  onChange={e => handlePartSearch(e.target.value)} autoFocus
                  style={{ width: '100%', padding: '10px 12px', border: '1.5px solid var(--teal)', borderRadius: 'var(--r-sm)', fontSize: 14, background: 'var(--bg)', marginBottom: 6 }} />
                {partSearchResults.map(p => (
                  <div key={p.id} onClick={() => { setExtraParts(prev => [...prev, { id: p.id, name: p.name, unit: p.unit || 'ea', qty: 1 }]); setShowPartSearch(false); setPartSearchQuery(''); setPartSearchResults([]) }}
                    style={{ padding: '10px 12px', background: 'var(--surface)', borderRadius: 6, marginBottom: 4, cursor: 'pointer', border: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--hint)' }}>{p.id}</div>
                  </div>
                ))}
                <button onClick={() => { setShowPartSearch(false); setPartSearchQuery(''); setPartSearchResults([]) }}
                  style={{ fontSize: 12, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', marginTop: 4 }}>
                  {t('cancel', lang)}
                </button>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>{t('hoursWorked', lang)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="tally-btn tally-minus" onClick={() => setHoursWorked(h => Math.max(0, Math.round((h-.5)*2)/2))}>−</button>
                <div style={{ fontSize: 28, fontWeight: 800, flex: 1, textAlign: 'center' }}>{hoursWorked.toFixed(1)}</div>
                <button className="tally-btn tally-plus" onClick={() => setHoursWorked(h => Math.min(16, Math.round((h+.5)*2)/2))}>+</button>
                <span style={{ color: 'var(--muted)' }}>hrs</span>
              </div>
            </div>

            <div className="field">
              <label>{t('noteOptional', lang)}</label>
              <textarea placeholder={t('noteplaceholder', lang)} value={note} onChange={e => setNote(e.target.value)} style={{ minHeight: 56 }} />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setShowSummary(false); setPartQtyOverrides({}); setExtraParts([]); setShowPartSearch(false) }}>{t('keepLogging', lang)}</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit} disabled={submitting}>
                {submitting ? t('submitting', lang) : t('submitDay', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
