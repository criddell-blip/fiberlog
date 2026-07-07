import { useState, useEffect } from 'react'
import { approveSubmission, setTaskClosed, db, nextChannelSuffix } from '../../lib/supabase'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

const STATUS_COLORS = {
  pending: { bg: 'var(--amber-lt)', text: 'var(--amber)', label: 'Pending' },
  approved: { bg: 'var(--teal-lt)', text: 'var(--teal-dk)', label: 'Approved' },
  flagged: { bg: 'var(--red-lt)', text: 'var(--red)', label: 'Flagged' },
}

// Tasks anchor on either a phase (fiber crews) or a site (infra crews) —
// never both. submissionLocation picks the right one so the queue's grouping,
// labels, and overlay all show real project/location names regardless of
// crew type. Without this, infra submissions landed under "Unknown" with
// "undefined › TaskName" because the JOIN walked tasks.phases.projects only
// and phases is NULL for infra.
function submissionLocation(sub) {
  const task = sub?.work_sessions?.tasks
  const phase = task?.phases
  const site = task?.sites
  return {
    projectName: phase?.projects?.name || site?.projects?.name || 'Unknown',
    locationName: phase?.name || site?.name || null,
  }
}

function StatPill({ label, value }) {
  return (
    <div style={{ fontSize: 12 }}>
      <span className="eyebrow" style={{ fontSize: 10 }}>{label} </span>
      <span className="mono" style={{ fontWeight: 600 }}>{value}</span>
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
  // is_closed of the selected submission's task (backlog #2) — drives the
  // "Close task" affordance so Chris can approve the final passdown and
  // close the task in one place. null = not loaded yet.
  const [selTaskClosed, setSelTaskClosed] = useState(null)
  const [partsLoading, setPartsLoading] = useState(false)
  const [filter, setFilter] = useState('pending')
  const [showArchived, setShowArchived] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState({})

  // Back closes the submission detail/approval overlay.
  useBackClose(selected ? 1 : 0, () => setSelected(null))

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

      // Use a unique name per setup so a reconnect (or a re-mount on tab
      // switch) doesn't collide with a stale channel that hasn't been GC'd
      // yet. nextChannelSuffix() guarantees uniqueness even when two
      // setupChannel calls land in the same millisecond.
      // Wrap so a realtime throw degrades to "no live updates" rather than
      // bubbling into the render.
      try {
        channel = db.channel('manager_submissions_' + nextChannelSuffix())
          .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'submissions' },
            () => {
              loadSubmissions()
              showToast('New submission received')
            }
          )
          .on('postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'submissions' },
            () => loadSubmissions()
          )
          .subscribe(status => {
            // Reconnect if the channel drops for any reason
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
              if (reconnectTimer) clearTimeout(reconnectTimer)
              reconnectTimer = setTimeout(setupChannel, 2000)
            }
          })
      } catch (e) {
        console.warn('Submissions realtime subscribe failed:', e)
      }
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
            tasks ( name, task_type,
              phases ( name, projects ( name ) ),
              sites  ( name, projects ( name ) )
            )
          ),
          override_project:projects!submissions_project_id_override_fkey ( id, name )`)
        .order('created_at', { ascending: false })
        .eq('archived', false)
        .limit(200)
      if (error) throw error
      setSubmissions(data || [])
      const pending = {}
      ;(data || []).forEach(s => {
        const { projectName } = submissionLocation(s)
        if (s.status === 'pending') pending[projectName] = true
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
    setSelTaskClosed(null)
    try {
      // Use task_id not session_id - one session can span multiple tasks
      const taskId = sub.work_sessions?.task_id
      if (taskId) {
        db.from('tasks').select('is_closed').eq('id', taskId).single()
          .then(({ data }) => setSelTaskClosed(!!data?.is_closed))
          .catch(() => {})
      }
      const { data: entries } = await db
        .from('log_entries').select('id, footage_amt, task_id, submission_id').eq('session_id', sub.session_id)
      // Prefer entries LINKED to this submission (log_entries.submission_id,
      // set on every post-July-2026 submit) — with additive same-day
      // passdowns, session-scoped filtering would show the union of both
      // passdowns' parts on each. Legacy unlinked rows fall back to the old
      // session+task scope, excluding entries linked to OTHER submissions.
      const linked = (entries || []).filter(e => e.submission_id === sub.id)
      const filteredEntries = linked.length > 0
        ? linked
        : (entries || []).filter(e =>
            !e.submission_id && (taskId ? (!e.task_id || e.task_id === taskId) : true))
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

      // Mirror the task's status back to 'open' (backlog #2: the task is
      // still visible to the crew via is_closed regardless — this re-arms
      // the crew workspace flag banner, which is gated on status==='open',
      // and clears the stale pending/approved badge). Task stays open so
      // the crew can fix and resubmit.
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

  // Backlog #2: close the task once its work is done — the daily flow is
  // approve the final passdown, then close here without leaving the queue.
  async function handleCloseTask(sub) {
    const taskId = sub.work_sessions?.task_id
    if (!taskId) return
    setActing(true)
    try {
      await setTaskClosed(taskId, true, currentUser?.id)
      setSelTaskClosed(true)
      showToast('Task closed')
      reload()
    } catch (e) { showToast('Close task failed: ' + e.message) }
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
            tasks ( name, task_type,
              phases ( name, projects ( name ) ),
              sites  ( name, projects ( name ) )
            )
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
    const { projectName } = submissionLocation(s)
    if (!grouped[projectName]) grouped[projectName] = []
    grouped[projectName].push(s)
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
        {/* Status filter: dropdown (was 4 wrapping pills, saves ~30px on mobile).
            Archived toggle stays separate as a pill since it's a 2-state toggle. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              height: 30, padding: '0 10px', fontSize: 12, fontWeight: 600,
              border: '1px solid var(--border2)', borderRadius: 999,
              background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
            }}
          >
            {[
              { id: 'pending',  label: 'Pending' },
              { id: 'approved', label: 'Approved' },
              { id: 'flagged',  label: 'Flagged' },
              { id: 'all',      label: 'All statuses' },
            ].map(opt => (
              <option key={opt.id} value={opt.id}>Status: {opt.label}</option>
            ))}
          </select>
          <button onClick={() => setShowArchived(prev => !prev)}
            className={`chip${showArchived ? ' chip-active' : ''}`}>
            <Icon name="box" size={14} /> Archived
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>}
        {!loading && sortedProjects.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--gray-mid)' }}><Icon name="layers" size={32} /></div>
            <div>No {showArchived ? 'archived' : (filter === 'all' ? '' : filter + ' ')}submissions</div>
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
                borderRadius: isOpen ? 'var(--r) var(--r) 0 0' : 'var(--r)',
                cursor: 'pointer',
                boxShadow: isOpen ? 'none' : '0 1px 3px rgba(15,23,42,0.06)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>{projName}</span>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--hint)' }}>{subs.length} submission{subs.length !== 1 ? 's' : ''}</span>
                  {pendingInGroup > 0 && <span style={{ background: 'var(--amber-lt)', color: 'var(--amber)', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{pendingInGroup} pending</span>}
                </div>
                <span style={{ color: 'var(--hint)', display: 'inline-flex', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}><Icon name="chevron-right" size={16} /></span>
              </button>

              {isOpen && subs.map((sub, i) => {
                const colors = STATUS_COLORS[sub.status] || STATUS_COLORS.pending
                const task = sub.work_sessions?.tasks
                const { locationName } = submissionLocation(sub)
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
                        {task && <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 5 }}><Icon name="pin" size={12} /> {locationName || '—'} › {task.name}</div>}
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

            {selected.work_sessions?.tasks && (() => {
              const { projectName, locationName } = submissionLocation(selected)
              return (
              <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 14, fontSize: 13 }}>
                <div style={{ fontWeight: 700 }}>{selected.work_sessions.tasks.name}</div>
                <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                  {projectName}{locationName ? ` › ${locationName}` : ''}
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
              )
            })()}

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
                <button className="btn btn-danger" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => handleFlag(selected)} disabled={acting}><Icon name="flag" size={14} /> Flag</button>
                <button className="btn btn-primary" style={{ flex: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => handleApprove(selected)} disabled={acting}>{acting ? 'Saving...' : <><Icon name="check" size={14} /> Approve</>}</button>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 12, borderRadius: 'var(--r-sm)', fontWeight: 700, background: STATUS_COLORS[selected.status]?.bg, color: STATUS_COLORS[selected.status]?.text }}>
                {STATUS_COLORS[selected.status]?.label}
              </div>
            )}

            {/* Backlog #2: close the task once its work is truly done. The
                task stays open across passdowns otherwise — approving alone
                no longer completes it. */}
            {selected.work_sessions?.task_id && (
              selTaskClosed ? (
                <div style={{ width: '100%', marginTop: 8, padding: 10, textAlign: 'center', background: 'var(--teal-lt)', borderRadius: 'var(--r-sm)', color: 'var(--teal-mid)', fontSize: 13, fontWeight: 700 }}>
                  <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Task closed
                </div>
              ) : (
                <button
                  onClick={() => handleCloseTask(selected)}
                  disabled={acting || selTaskClosed === null}
                  style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--teal-lt)', border: '1px solid var(--teal-mid)', borderRadius: 'var(--r-sm)', color: 'var(--teal-mid)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
                >
                  <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Close task — work is done
                </button>
              )
            )}

            {selected.status === 'approved' && !selected.archived && (
              <button
                onClick={() => handleArchive(selected)}
                style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--gray-lt)', border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                <Icon name="box" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Archive this submission
              </button>
            )}
            <button style={{ width: '100%', marginTop: 10, padding: 12, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
