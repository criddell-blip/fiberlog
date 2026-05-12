import { useState, useEffect } from 'react'
import { approveSubmission, db } from '../../lib/supabase'
import { useApp } from '../../AppContext'

const STATUS_COLORS = {
  pending: { bg: 'var(--amber-lt)', text: 'var(--amber)', label: 'Pending' },
  approved: { bg: 'var(--teal-lt)', text: 'var(--teal-dk)', label: 'Approved' },
  flagged: { bg: 'var(--red-lt)', text: 'var(--red)', label: 'Flagged' },
}

function StatPill({ label, value }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span style={{ color: 'var(--muted)' }}>{label} </span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </div>
  )
}

export default function SubmissionsQueue() {
  const { showToast, reload, currentUser } = useApp()
  const [submissions, setSubmissions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [note, setNote] = useState('')
  const [acting, setActing] = useState(false)
  const [selectedParts, setSelectedParts] = useState([])
  const [partsLoading, setPartsLoading] = useState(false)
  const [filter, setFilter] = useState('pending')
  const [showArchived, setShowArchived] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState({})

  // Set up realtime channel with auto-reconnect on disconnect.
  // We listen for both INSERT (new submissions from crew) and UPDATE
  // (re-submitted, flagged, archived) so the queue stays current
  // without manual refresh.
  useEffect(() => {
    let channel = null
    let reconnectTimer = null
    let cancelled = false

    const setupChannel = () => {
      if (cancelled) return
      if (channel) {
        try { channel.unsubscribe() } catch {}
      }

      // Use a unique name per setup so a reconnect doesn't collide with
      // a stale channel that hasn't been GC'd yet.
      channel = db.channel('manager_submissions_' + Date.now())
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'submissions' },
          payload => {
            console.log('[Submissions] INSERT', payload.new?.id)
            loadSubmissions()
            showToast('New submission received')
          }
        )
        .on('postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'submissions' },
          payload => {
            console.log('[Submissions] UPDATE', payload.new?.id, payload.new?.status)
            loadSubmissions()
          }
        )
        .subscribe(status => {
          console.log('[Submissions] Channel status:', status)
          // Reconnect if the channel drops for any reason
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (reconnectTimer) clearTimeout(reconnectTimer)
            reconnectTimer = setTimeout(setupChannel, 2000)
          }
        })
    }

    loadSubmissions()
    setupChannel()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (channel) {
        try { channel.unsubscribe() } catch {}
      }
    }
  }, [])

  async function loadSubmissions() {
    setLoading(true)
    try {
      const { data, error } = await db
        .from('submissions')
        .select(`*, users!submissions_user_id_fkey ( name, initials, crew_type ),
          work_sessions!submissions_session_id_fkey (
            session_date, task_id,
            tasks ( name, task_type, phases ( name, projects ( name ) ) )
          ),
          override_project:projects!submissions_project_id_override_fkey ( id, name )`)
        .order('created_at', { ascending: false })
        .eq('archived', false)
        .limit(200)
      if (error) throw error
      setSubmissions(data || [])
      const pending = {}
      ;(data || []).forEach(s => {
        const proj = s.work_sessions?.tasks?.phases?.projects?.name || 'Unknown'
        if (s.status === 'pending') pending[proj] = true
      })
      setExpandedProjects(pending)
    } catch (e) {
      console.error('Load submissions failed:', e)
    } finally {
      setLoading(false)
    }
  }

  async function loadPartsForSubmission(sub) {
    if (!sub.session_id) return
    setPartsLoading(true)
    setSelectedParts([])
    try {
      // Use task_id not session_id - one session can span multiple tasks
      const taskId = sub.work_sessions?.task_id
      const { data: entries } = await db
        .from('log_entries').select('id, footage_amt, task_id').eq('session_id', sub.session_id)
      // Filter to this task's entries if task_id exists on log_entries
      const filteredEntries = taskId
        ? (entries || []).filter(e => !e.task_id || e.task_id === taskId)
        : (entries || [])
      if (!filteredEntries || filteredEntries.length === 0) { setSelectedParts([]); setPartsLoading(false); return }
      const entryIds = filteredEntries.map(e => e.id)
      const { data: parts } = await db
        .from('entry_parts').select('quantity, part_id, parts_catalog ( id, name, unit )').in('entry_id', entryIds)
      const totals = {}
      ;(parts || []).forEach(p => {
        const id = p.parts_catalog?.id || p.part_id || 'unknown'
        if (!totals[id]) totals[id] = { name: p.parts_catalog?.name || p.part_id || id, unit: p.parts_catalog?.unit || 'ea', qty: 0 }
        totals[id].qty += p.quantity || 0
      })
      setSelectedParts(Object.values(totals).filter(p => p.qty > 0))
    } catch(e) { console.warn('Parts load failed:', e) }
    finally { setPartsLoading(false) }
  }

  async function handleApprove(sub) {
    setActing(true)
    try {
      await approveSubmission(sub.id, note)
      setSelected(null); setNote('')
      showToast(`Approved — ${sub.users?.name}`)
      await loadSubmissions()
      reload()
    } catch (e) { showToast('Approve failed: ' + e.message) }
    finally { setActing(false) }
  }

  async function handleFlag(sub) {
    setActing(true)
    try {
      await db.from('submissions').update({
        status: 'flagged',
        flag_reason: note || 'Flagged by manager',
        reviewed_by: currentUser?.id || null,
        reviewed_at: new Date().toISOString(),
      }).eq('id', sub.id)

      // Revert the underlying task to 'open' so it reappears in the crew's
      // sidebar — they need to see it to fix and resubmit. Without this,
      // the task stays 'pending' and is hidden from the sidebar by
      // isActiveCrewTask, leaving the crew with no visible way to act on
      // the flag.
      const taskId = sub.work_sessions?.task_id
      if (taskId) {
        const { error: taskErr } = await db.from('tasks').update({ status: 'open' }).eq('id', taskId)
        if (taskErr) console.warn('Task revert-to-open failed:', taskErr)
      }

      setSelected(null); setNote('')
      showToast(`Flagged — ${sub.users?.name}`)
      await loadSubmissions()
    } catch (e) { showToast('Flag failed: ' + e.message) }
    finally { setActing(false) }
  }

  async function handleArchive(sub) {
    try {
      await db.from('submissions').update({
        archived: true,
        archived_at: new Date().toISOString(),
      }).eq('id', sub.id)
      setSelected(null)
      showToast('Archived')
      await loadSubmissions()
    } catch(e) { showToast('Archive failed: ' + e.message) }
  }

  function toggleProject(projName) {
    setExpandedProjects(prev => ({ ...prev, [projName]: !prev[projName] }))
  }

  // When showArchived is true, load archived submissions separately
  const [archivedSubs, setArchivedSubs] = useState([])
  useEffect(() => {
    if (showArchived) {
      db.from('submissions')
        .select(`*, users!submissions_user_id_fkey ( name, initials, crew_type ),
          work_sessions!submissions_session_id_fkey (
            session_date, task_id,
            tasks ( name, task_type, phases ( name, projects ( name ) ) )
          ),
          override_project:projects!submissions_project_id_override_fkey ( id, name )`)
        .eq('archived', true)
        .order('archived_at', { ascending: false })
        .limit(100)
        .then(({ data }) => setArchivedSubs(data || []))
    }
  }, [showArchived])

  const filtered = showArchived
    ? archivedSubs
    : submissions.filter(s => filter === 'all' || s.status === filter)
  const grouped = {}
  filtered.forEach(s => {
    const proj = s.work_sessions?.tasks?.phases?.projects?.name || 'Unknown'
    if (!grouped[proj]) grouped[proj] = []
    grouped[proj].push(s)
  })
  const sortedProjects = Object.entries(grouped).sort(([, a], [, b]) =>
    new Date(b[0].created_at) - new Date(a[0].created_at)
  )
  const pendingCount = submissions.filter(s => s.status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            Submissions
            {pendingCount > 0 && <span style={{ marginLeft: 8, background: 'var(--amber)', color: 'white', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{pendingCount}</span>}
          </div>
          <button onClick={loadSubmissions} style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {['pending', 'approved', 'flagged', 'all'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: filter === f ? 'var(--orange)' : 'var(--gray-lt)',
              color: filter === f ? 'white' : 'var(--muted)', border: 'none', cursor: 'pointer', textTransform: 'capitalize'
            }}>{f}</button>
          ))}
          <button onClick={() => setShowArchived(prev => !prev)} style={{
            padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
            background: showArchived ? 'var(--gray-mid)' : 'var(--gray-lt)',
            color: showArchived ? 'white' : 'var(--muted)', border: 'none', cursor: 'pointer'
          }}>📦 Archived</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>}
        {!loading && sortedProjects.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
            <div>No {filter} submissions</div>
          </div>
        )}

        {sortedProjects.map(([projName, subs]) => {
          const isOpen = expandedProjects[projName]
          const pendingInGroup = subs.filter(s => s.status === 'pending').length
          return (
            <div key={projName} style={{ marginBottom: 12 }}>
              <button onClick={() => toggleProject(projName)} style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: isOpen ? 'var(--r-sm) var(--r-sm) 0 0' : 'var(--r-sm)',
                cursor: 'pointer'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>{projName}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{subs.length} submission{subs.length !== 1 ? 's' : ''}</span>
                  {pendingInGroup > 0 && <span style={{ background: 'var(--amber)', color: 'white', fontSize: 11, fontWeight: 700, padding: '1px 7px', borderRadius: 20 }}>{pendingInGroup} pending</span>}
                </div>
                <span style={{ fontSize: 16, color: 'var(--muted)', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>›</span>
              </button>

              {isOpen && subs.map((sub, i) => {
                const colors = STATUS_COLORS[sub.status] || STATUS_COLORS.pending
                const task = sub.work_sessions?.tasks
                const phase = task?.phases
                return (
                  <div key={sub.id} onClick={() => { setSelected(sub); loadPartsForSubmission(sub) }}
                    style={{
                      background: 'var(--surface)',
                      borderLeft: `4px solid ${colors.text}`,
                      borderRight: '1px solid var(--border)',
                      borderBottom: i === subs.length - 1 ? '1px solid var(--border)' : 'none',
                      borderRadius: i === subs.length - 1 ? '0 0 var(--r-sm) var(--r-sm)' : 0,
                      padding: '12px 14px', cursor: 'pointer'
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--teal-lt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11, color: 'var(--teal-dk)', flexShrink: 0 }}>{sub.users?.initials || '?'}</div>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{sub.users?.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                              {new Date(sub.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                            </div>
                          </div>
                        </div>
                        {task && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>📍 {phase?.name} › {task.name}</div>}
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <StatPill label="Hrs" value={sub.hours_worked || 0} />
                          {sub.total_poles > 0 && <StatPill label="Poles" value={sub.total_poles} />}
                          {sub.total_strand_ft > 0 && <StatPill label="Strand" value={`${sub.total_strand_ft.toLocaleString()}ft`} />}
                          {sub.total_fiber_ft > 0 && <StatPill label="Fiber" value={`${sub.total_fiber_ft.toLocaleString()}ft`} />}
                          {sub.total_mst_hst > 0 && <StatPill label="MST/HST" value={sub.total_mst_hst} />}
                          {sub.total_splice_cases > 0 && <StatPill label="Cases" value={sub.total_splice_cases} />}
                          {sub.total_conduit_ft > 0 && <StatPill label="Conduit" value={`${sub.total_conduit_ft.toLocaleString()}ft`} />}
                          {sub.total_handholes > 0 && <StatPill label="HH" value={sub.total_handholes} />}
                          {sub.total_vaults > 0 && <StatPill label="Vaults" value={sub.total_vaults} />}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: colors.bg, color: colors.text, flexShrink: 0, marginLeft: 8 }}>{colors.label}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {selected && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setSelected(null)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>{selected.users?.name}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              {new Date(selected.created_at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>

            {selected.work_sessions?.tasks && (
              <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 14, fontSize: 13 }}>
                <div style={{ fontWeight: 700 }}>{selected.work_sessions.tasks.name}</div>
                <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                  {selected.work_sessions.tasks.phases?.projects?.name} › {selected.work_sessions.tasks.phases?.name}
                </div>
                {selected.override_project && (
                  <div style={{
                    marginTop: 8, padding: '6px 10px',
                    background: 'var(--amber-lt)', color: 'var(--amber)',
                    borderRadius: 'var(--r-xs)', fontSize: 11, fontWeight: 700,
                    display: 'inline-block',
                  }}>
                    ⤳ Materials routing to <strong>{selected.override_project.name}</strong> on approval
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              {[
                { label: 'Hours', value: selected.hours_worked || 0 },
                selected.total_poles > 0 && { label: 'Poles', value: selected.total_poles },
                selected.total_strand_ft > 0 && { label: 'Strand', value: `${(selected.total_strand_ft||0).toLocaleString()}ft` },
                selected.total_fiber_ft > 0 && { label: 'Fiber', value: `${(selected.total_fiber_ft||0).toLocaleString()}ft` },
                selected.total_mst_hst > 0 && { label: 'MST/HST', value: selected.total_mst_hst },
                selected.total_splice_cases > 0 && { label: 'Cases', value: selected.total_splice_cases },
                selected.total_conduit_ft > 0 && { label: 'Conduit', value: `${(selected.total_conduit_ft||0).toLocaleString()}ft` },
                selected.total_handholes > 0 && { label: 'HH', value: selected.total_handholes },
                selected.total_vaults > 0 && { label: 'Vaults', value: selected.total_vaults },
              ].filter(Boolean).map(s => (
                <div key={s.label} style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 800 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>Parts logged</div>
            {partsLoading ? (
              <div style={{ textAlign: 'center', padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading parts...</div>
            ) : selectedParts.length > 0 ? (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 14, maxHeight: 200, overflowY: 'auto' }}>
                {selectedParts.map((p, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', borderBottom: i < selectedParts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal-dk)', flexShrink: 0, marginLeft: 8 }}>
                      {p.qty.toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--hint)', marginBottom: 14, textAlign: 'center', padding: 12 }}>No parts logged</div>
            )}

            {selected.status === 'pending' && (
              <div className="field">
                <label>Note (optional)</label>
                <textarea placeholder="Add a note..." value={note} onChange={e => setNote(e.target.value)} style={{ minHeight: 56 }} />
              </div>
            )}

            {selected.status === 'pending' ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => handleFlag(selected)} disabled={acting}>🚩 Flag</button>
                <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => handleApprove(selected)} disabled={acting}>{acting ? 'Saving...' : '✅ Approve'}</button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 12, borderRadius: 'var(--r-sm)', fontWeight: 700, background: STATUS_COLORS[selected.status]?.bg, color: STATUS_COLORS[selected.status]?.text }}>
                {STATUS_COLORS[selected.status]?.label}
              </div>
            )}

            {selected.status === 'approved' && !selected.archived && (
              <button
                onClick={() => handleArchive(selected)}
                style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--gray-lt)', border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                📦 Archive this submission
              </button>
            )}
            <button style={{ width: '100%', marginTop: 10, padding: 12, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
