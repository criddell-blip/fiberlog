import { useState, useEffect } from 'react'
import { approveSubmission, saveSubmissionParts, setTaskClosed, db } from '../../lib/supabase'
import { useApp } from '../../AppContext'
import useRealtimeQueue from '../../lib/useRealtimeQueue'
import { useBackClose } from '../../lib/backStack'
import ReviewQueue, { ReviewActions, InitialsAvatar, StatusPill, fmtShortDateTime } from './ReviewQueue'
import PartSearch from '../crew/workspace/PartSearch'
import Icon from '../shared/Icon'

// The core daily manager flow — crew passdown review. Built on the shared
// ReviewQueue chassis (backlog #22) for the header/filter/list/overlay
// shell; everything submission-specific stays here: project grouping +
// expansion, the archived toggle + query, per-submission parts loading,
// stat pills, close-task (backlog #2), and archive.

const STATUS_COLORS = {
  pending: { bg: 'var(--amber-lt)', text: 'var(--amber)', label: 'Pending' },
  approved: { bg: 'var(--teal-lt)', text: 'var(--teal-dk)', label: 'Approved' },
  flagged: { bg: 'var(--red-lt)', text: 'var(--red)', label: 'Flagged' },
}

const STATUS_OPTIONS = [
  { id: 'pending',  label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'flagged',  label: 'Flagged' },
  { id: 'all',      label: 'All statuses' },
]

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

const SUBMISSION_SELECT = `*, users!submissions_user_id_fkey ( name, initials, crew_type ),
  work_sessions!submissions_session_id_fkey (
    session_date, task_id,
    tasks ( name, task_type,
      phases ( name, projects ( name ) ),
      sites  ( name, projects ( name ) )
    )
  ),
  override_project:projects!submissions_project_id_override_fkey ( id, name )`

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
  // Manager edit-then-approve (pending submissions only). editParts mirrors
  // selectedParts but carries part_id for the write-back; editHours mirrors
  // sel.hours_worked. Reset whenever a different submission is opened or the
  // overlay closes so edit state never leaks between submissions.
  const [editMode, setEditMode] = useState(false)
  const [editParts, setEditParts] = useState([])
  const [editHours, setEditHours] = useState(0)
  const [showPartSearch, setShowPartSearch] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadSubmissions() }, [])

  // Realtime — INSERT (new submissions from crew) + UPDATE (re-submitted,
  // flagged, archived), with auto-reconnect (shared hook), so the queue
  // stays current without manual refresh.
  useRealtimeQueue('submissions', {
    channelPrefix: 'manager_submissions_',
    onEvent: type => {
      loadSubmissions()
      if (type === 'INSERT') showToast('New submission received')
    },
  })

  // Dirty = the editable copy diverges from what's loaded. Drives Save
  // enablement AND the Back/Cancel discard confirm below.
  const editDirty = editMode && !!selected && (
    editHours !== (Number(selected.hours_worked) || 0) ||
    editParts.length !== selectedParts.length ||
    editParts.some(ep => {
      const o = selectedParts.find(s => s.part_id === ep.part_id)
      return !o || o.qty !== ep.qty
    })
  )

  // Hardware/browser Back guard for edit mode (project convention: data-entry
  // Back confirms when dirty). Registered here at the component top level —
  // renderDetail is a plain render helper, not a component, so it can't hold
  // hooks. Depth 1 while editing; the nested PartSearch (also depth 1) activates
  // later so Back closes it first, then exits edit mode, then the overlay.
  useBackClose(editMode ? 1 : 0, () => { setShowPartSearch(false); setEditMode(false) }, {
    confirm: () => !editDirty || window.confirm('Discard changes?'),
  })

  async function loadSubmissions() {
    setLoading(true)
    try {
      const { data, error } = await db
        .from('submissions')
        .select(SUBMISSION_SELECT)
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
    // A fresh submission — drop any in-flight edit state from the last one.
    setEditMode(false); setEditParts([]); setShowPartSearch(false)
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
        // part_id is carried so the manager edit path can write it back.
        if (!totals[id]) totals[id] = { part_id: id, name: p.parts_catalog?.name || p.part_id || id, unit: p.parts_catalog?.unit || 'ea', qty: 0 }
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

  // Enter edit mode — seed the editable copy from the currently-loaded parts
  // (deep-copied so cancelling discards) and the submission's hours.
  function startEdit(sel) {
    setEditParts(selectedParts.map(p => ({ ...p })))
    setEditHours(Number(sel.hours_worked) || 0)
    setEditMode(true)
  }

  // Save the edited parts + hours via the replace_submission_parts RPC, then
  // re-aggregate from the DB so the read-only view reflects the DB truth. The
  // submission stays pending — the manager then clicks Approve normally, and
  // approve_submission deducts the edited quantities.
  async function handleSaveEdits(sub) {
    setSaving(true)
    try {
      await saveSubmissionParts(sub.id, editParts, editHours)
      setEditMode(false); setShowPartSearch(false)
      showToast('Changes saved')
      // Reflect the new hours on the selected row without a full refetch.
      setSelected(prev => prev && prev.id === sub.id ? { ...prev, hours_worked: editHours } : prev)
      await loadSubmissions()
      await loadPartsForSubmission({ ...sub, hours_worked: editHours })
    } catch (e) { showToast('Save failed: ' + e.message) }
    finally { setSaving(false) }
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
        .select(SUBMISSION_SELECT)
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
    <ReviewQueue
      title="Submissions"
      pendingCount={pendingCount}
      onRefresh={loadSubmissions}
      filter={filter}
      onFilterChange={setFilter}
      statusOptions={STATUS_OPTIONS}
      headerExtras={
        // Archived toggle stays separate as a pill since it's a 2-state toggle.
        <button onClick={() => setShowArchived(prev => !prev)}
          className={`chip${showArchived ? ' chip-active' : ''}`}>
          <Icon name="box" size={14} /> Archived
        </button>
      }
      loading={loading}
      isEmpty={sortedProjects.length === 0}
      emptyIcon="layers"
      emptyMessage={`No ${showArchived ? 'archived' : (filter === 'all' ? '' : filter + ' ')}submissions`}
      selected={selected}
      onCloseDetail={() => { setSelected(null); setEditMode(false); setEditParts([]); setShowPartSearch(false) }}
      renderDetail={renderDetail}
    >
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
                        <InitialsAvatar initials={sub.users?.initials} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{sub.users?.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {fmtShortDateTime(sub.created_at)}
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
                    <StatusPill colors={colors} style={{ marginLeft: 8 }} />
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </ReviewQueue>
  )

  function renderDetail(sel) {
    const isPending = sel.status === 'pending'
    const dirty = editDirty  // computed at component scope (also drives the Back guard)
    return (
      <>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>{sel.users?.name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {new Date(sel.created_at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>

        {sel.work_sessions?.tasks && (() => {
          const { projectName, locationName } = submissionLocation(sel)
          return (
          <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 14, fontSize: 13 }}>
            <div style={{ fontWeight: 700 }}>{sel.work_sessions.tasks.name}</div>
            <div style={{ color: 'var(--muted)', marginTop: 2 }}>
              {projectName}{locationName ? ` › ${locationName}` : ''}
            </div>
            {sel.override_project && (
              <div style={{
                marginTop: 8, padding: '6px 10px',
                background: 'var(--amber-lt)', color: 'var(--amber)',
                borderRadius: 'var(--r-xs)', fontSize: 11, fontWeight: 700,
                display: 'inline-block',
              }}>
                ⤳ Materials routing to <strong>{sel.override_project.name}</strong> on approval
              </div>
            )}
          </div>
          )
        })()}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
          {[
            { label: 'Hours', value: editMode ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <button className="tally-btn tally-sm tally-minus" onClick={() => setEditHours(h => Math.max(0, Math.round((h - 0.5) * 2) / 2))}>−</button>
                <span className="mono" style={{ minWidth: 30, fontSize: 15 }}>{editHours.toFixed(1)}</span>
                <button className="tally-btn tally-sm tally-plus" onClick={() => setEditHours(h => Math.min(16, Math.round((h + 0.5) * 2) / 2))}>+</button>
              </div>
            ) : (sel.hours_worked || 0) },
            sel.total_poles > 0 && { label: 'Poles', value: sel.total_poles },
            sel.total_strand_ft > 0 && { label: 'Strand', value: `${(sel.total_strand_ft||0).toLocaleString()}ft` },
            sel.total_fiber_ft > 0 && { label: 'Fiber', value: `${(sel.total_fiber_ft||0).toLocaleString()}ft` },
            sel.total_mst_hst > 0 && { label: 'MST/HST', value: sel.total_mst_hst },
            sel.total_splice_cases > 0 && { label: 'Cases', value: sel.total_splice_cases },
            sel.total_conduit_ft > 0 && { label: 'Conduit', value: `${(sel.total_conduit_ft||0).toLocaleString()}ft` },
            sel.total_handholes > 0 && { label: 'HH', value: sel.total_handholes },
            sel.total_vaults > 0 && { label: 'Vaults', value: sel.total_vaults },
          ].filter(Boolean).map(s => (
            <div key={s.label} style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>
          Parts logged{editMode ? ' — editing' : ''}
        </div>
        {partsLoading ? (
          <div style={{ textAlign: 'center', padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading parts...</div>
        ) : editMode ? (
          <div style={{ marginBottom: 14 }}>
            {editParts.length > 0 && (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', maxHeight: 220, overflowY: 'auto' }}>
                {editParts.map((p, i) => (
                  <div key={p.part_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: i < editParts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>{p.part_id}</div>
                    </div>
                    <button className="tally-btn tally-sm tally-minus" onClick={() => setEditParts(prev => prev.map((x, j) => j === i ? { ...x, qty: Math.max(1, x.qty - 1) } : x))}>−</button>
                    <span className="mono" style={{ minWidth: 30, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{p.qty.toLocaleString()}</span>
                    <button className="tally-btn tally-sm tally-plus" onClick={() => setEditParts(prev => prev.map((x, j) => j === i ? { ...x, qty: x.qty + 1 } : x))}>+</button>
                    <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 16 }}>{p.unit}</span>
                    <button onClick={() => setEditParts(prev => prev.filter((_, j) => j !== i))} className="tally-btn tally-sm" style={{ background: 'var(--red-lt)', color: 'var(--red)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={14} /></button>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setShowPartSearch(true)} className="add-dashed" style={{ width: '100%', padding: 10, marginTop: 8, fontSize: 13 }}>
              + Add a part
            </button>
          </div>
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

        {editMode ? (
          // Edit-then-approve: Save leaves the submission PENDING (approve is a
          // separate, deliberate step — it posts the irreversible deduction).
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} disabled={saving}
              onClick={() => { if (!editDirty || window.confirm('Discard changes?')) { setEditMode(false); setShowPartSearch(false) } }}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 2 }} disabled={saving || !dirty}
              onClick={() => handleSaveEdits(sel)}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        ) : (
          <>
            <ReviewActions
              isPending={isPending}
              note={note}
              onNoteChange={setNote}
              noteLabel="Note (optional)"
              notePlaceholder="Add a note..."
              noteMinHeight={56}
              acting={acting}
              danger={{ label: 'Flag', icon: 'flag', onClick: () => handleFlag(sel) }}
              primary={{ label: 'Approve', icon: 'check', busyLabel: 'Saving...', onClick: () => handleApprove(sel) }}
              banner={STATUS_COLORS[sel.status] || {}}
            />
            {/* Fix wrong materials/hours in place instead of flagging back to
                the crew. Pending-only; approve reads the edited entry_parts. */}
            {isPending && (
              <button onClick={() => startEdit(sel)} disabled={partsLoading}
                style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--bg)', border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)', color: 'var(--text)', cursor: partsLoading ? 'default' : 'pointer', fontSize: 13, fontWeight: 700, opacity: partsLoading ? 0.6 : 1 }}>
                <Icon name="edit" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Edit materials &amp; hours
              </button>
            )}
          </>
        )}

        {/* Backlog #2: close the task once its work is truly done. The
            task stays open across passdowns otherwise — approving alone
            no longer completes it. */}
        {!editMode && sel.work_sessions?.task_id && (
          selTaskClosed ? (
            <div style={{ width: '100%', marginTop: 8, padding: 10, textAlign: 'center', background: 'var(--teal-lt)', borderRadius: 'var(--r-sm)', color: 'var(--teal-mid)', fontSize: 13, fontWeight: 700 }}>
              <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Task closed
            </div>
          ) : (
            <button
              onClick={() => handleCloseTask(sel)}
              disabled={acting || selTaskClosed === null}
              style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--teal-lt)', border: '1px solid var(--teal-mid)', borderRadius: 'var(--r-sm)', color: 'var(--teal-mid)', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
            >
              <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Close task — work is done
            </button>
          )
        )}

        {sel.status === 'approved' && !sel.archived && (
          <button
            onClick={() => handleArchive(sel)}
            style={{ width: '100%', marginTop: 8, padding: 10, background: 'var(--gray-lt)', border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
          >
            <Icon name="box" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Archive this submission
          </button>
        )}

        {/* Add-part catalog search (reused crew overlay). Stacks over the
            detail overlay and self-registers hardware-Back. Re-selecting an
            existing part bumps its qty rather than duplicating the row. */}
        {showPartSearch && (
          <PartSearch
            onSelect={p => {
              setEditParts(prev => prev.some(x => x.part_id === p.id)
                ? prev.map(x => x.part_id === p.id ? { ...x, qty: x.qty + 1 } : x)
                : [...prev, { part_id: p.id, name: p.name, unit: p.unit || 'ea', qty: 1 }])
              setShowPartSearch(false)
            }}
            onClose={() => setShowPartSearch(false)}
          />
        )}
      </>
    )
  }
}
