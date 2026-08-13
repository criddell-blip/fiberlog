import { useState, useEffect, useRef } from 'react'
import { approveSubmission, saveSubmissionParts, setTaskClosed, db } from '../../lib/supabase'
import { getLocations } from '../../lib/inventory'
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

// Footage / count rollups the manager can correct in edit mode. These live on
// the submission itself (not entry_parts), and approve_submission reads them
// straight for phase actuals — so a wrong strand/fiber number can be fixed here
// instead of flagged back. total_footage is derived (strand + fiber) on save.
const FOOTAGE_FIELDS = [
  { key: 'total_strand_ft',    label: 'Strand',    unit: 'ft' },
  { key: 'total_fiber_ft',     label: 'Fiber',     unit: 'ft' },
  { key: 'total_conduit_ft',   label: 'Conduit',   unit: 'ft' },
  { key: 'total_poles',        label: 'Poles',     unit: '' },
  { key: 'total_mst_hst',      label: 'MST/HST',   unit: '' },
  { key: 'total_splice_cases', label: 'Cases',     unit: '' },
  { key: 'total_handholes',    label: 'Handholes', unit: '' },
  { key: 'total_vaults',       label: 'Vaults',    unit: '' },
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
  // Footage/count rollups being edited (keyed by FOOTAGE_FIELDS[].key). Kept
  // as raw strings so the fields can be cleared while typing; coerced on save.
  const [editTotals, setEditTotals] = useState({})
  const [showPartSearch, setShowPartSearch] = useState(false)
  const [saving, setSaving] = useState(false)
  // Per-line source truck (Aug 2026): trucks/groups list for the edit-mode
  // source picker (lazy-loaded on first edit), and which edit row's source
  // is being picked (null = sheet closed).
  const [mgrTrucks, setMgrTrucks] = useState(null)
  const [editSourceIdx, setEditSourceIdx] = useState(null)

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
    FOOTAGE_FIELDS.some(f => (Number(editTotals[f.key]) || 0) !== (Number(selected[f.key]) || 0)) ||
    editParts.length !== selectedParts.length ||
    editParts.some(ep => {
      // (part, source) is the line identity — a source change alone is dirty.
      const o = selectedParts.find(s =>
        s.part_id === ep.part_id && (s.source_location_id || null) === (ep.source_location_id || null))
      return !o || o.qty !== ep.qty
    })
  )

  // Back closes the edit-mode source picker before anything else (display-only).
  useBackClose(editSourceIdx !== null ? 1 : 0, () => setEditSourceIdx(null))

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

  // Monotonic ticket for loadPartsForSubmission — only the latest call may
  // write state (see the guard comment inside).
  const partsLoadSeqRef = useRef(0)

  async function loadPartsForSubmission(sub) {
    // Stale-response guard: this loader FEEDS A DB WRITE (edit-then-approve
    // seeds editParts from selectedParts). Without it, opening A on a slow
    // connection then quickly opening B lets A's parts resolve last and land
    // under B's detail — and a save would write A's materials onto B.
    // Bump BEFORE the session_id early-out so even a no-session selection
    // invalidates a prior in-flight load.
    const seq = ++partsLoadSeqRef.current
    if (!sub.session_id) return
    const fresh = () => partsLoadSeqRef.current === seq
    setPartsLoading(true)
    setSelectedParts([])
    setSelTaskClosed(null)
    // A fresh submission — drop any in-flight edit state from the last one.
    setEditMode(false); setEditParts([]); setEditTotals({}); setShowPartSearch(false)
    try {
      // Use task_id not session_id - one session can span multiple tasks
      const taskId = sub.work_sessions?.task_id
      if (taskId) {
        db.from('tasks').select('is_closed').eq('id', taskId).single()
          .then(({ data }) => { if (fresh()) setSelTaskClosed(!!data?.is_closed) })
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
      if (!fresh()) return
      if (!filteredEntries || filteredEntries.length === 0) { setSelectedParts([]); setPartsLoading(false); return }
      const entryIds = filteredEntries.map(e => e.id)
      const { data: parts } = await db
        .from('entry_parts').select(`quantity, part_id, source_location_id,
          parts_catalog ( id, name, unit ),
          source:inventory_locations ( id, name, assigned_user:users!inventory_locations_assigned_to_fkey ( name ) )`)
        .in('entry_id', entryIds)
      if (!fresh()) return
      const totals = {}
      ;(parts || []).forEach(p => {
        const id = p.parts_catalog?.id || p.part_id || 'unknown'
        // (part, source truck) is the line identity — the same SKU from two
        // trucks stays two lines because approval books two movements.
        const key = id + '|' + (p.source_location_id || '')
        // part_id + source_location_id are carried so the edit path writes
        // them back; sourceName is the display label (truck owner, else
        // the location name — groups).
        if (!totals[key]) totals[key] = {
          part_id: id,
          name: p.parts_catalog?.name || p.part_id || id,
          unit: p.parts_catalog?.unit || 'ea',
          qty: 0,
          source_location_id: p.source_location_id || null,
          sourceName: p.source_location_id
            ? (p.source?.assigned_user?.name || p.source?.name || null)
            : null,
        }
        totals[key].qty += p.quantity || 0
      })
      setSelectedParts(Object.values(totals).filter(p => p.qty > 0))
    } catch(e) { console.warn('Parts load failed:', e) }
    finally { if (fresh()) setPartsLoading(false) }
  }

  async function handleApprove(sub) {
    setActing(true)
    try {
      await approveSubmission(sub.id, note)
      showToast(`Approved — ${sub.users?.name}`)

      // Offer to close the task in the same beat. Backlog #2 decoupled the
      // task lifecycle from approval — a task stays open across passdowns so
      // the crew can keep logging the same day — but the common case at
      // approval is "this work is done." Rather than make the manager hunt
      // for the separate Close-task button below, ask right here. Only prompt
      // when the task is confirmed still open (selTaskClosed === false); a
      // null (parts still loading) or already-closed task skips the prompt.
      const taskId = sub.work_sessions?.task_id
      if (taskId && selTaskClosed === false) {
        const closeIt = window.confirm(
          `Approved ${sub.users?.name}'s passdown.\n\n` +
          `Is this task finished? Click OK to close it (removes it from the ` +
          `crew's active list), or Cancel to keep it open for more passdowns.`
        )
        if (closeIt) {
          try { await setTaskClosed(taskId, true, currentUser?.id) }
          catch (e) { showToast('Close task failed: ' + e.message) }
        }
      }

      setSelected(null); setNote('')
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
    setEditTotals(Object.fromEntries(FOOTAGE_FIELDS.map(f => [f.key, Number(sel[f.key]) || 0])))
    setEditMode(true)
    // Trucks + groups for the per-line source picker, fetched once per queue
    // visit. Managers see the full list (no crew_type filter here — they're
    // correcting records, not browsing).
    if (!mgrTrucks) {
      getLocations()
        .then(locs => setMgrTrucks((locs || []).filter(l =>
          (l.type === 'truck' && l.assigned_to) || l.type === 'group')))
        .catch(e => console.warn('Truck list load failed:', e))
    }
  }

  // Save the edited parts + hours via the replace_submission_parts RPC, then
  // re-aggregate from the DB so the read-only view reflects the DB truth. The
  // submission stays pending — the manager then clicks Approve normally, and
  // approve_submission deducts the edited quantities.
  async function handleSaveEdits(sub) {
    setSaving(true)
    try {
      await saveSubmissionParts(sub.id, editParts, editHours)

      // Footage/count rollups aren't part of replace_submission_parts (it only
      // touches entry_parts + hours). approve_submission reads these total_*
      // columns straight for phase actuals, so correcting a wrong strand/fiber
      // number here flows through on approval. total_footage is derived. Guard
      // on actuals_applied_at IS NULL (pending-only) so an already-approved
      // submission can never be mutated, even if the UI slipped.
      const clamp = k => Math.max(0, Number(editTotals[k]) || 0)
      const strand = clamp('total_strand_ft')
      const fiber = clamp('total_fiber_ft')
      const nextTotals = {
        total_strand_ft: strand,
        total_fiber_ft: fiber,
        total_footage: strand + fiber,
        total_conduit_ft: clamp('total_conduit_ft'),
        total_poles: clamp('total_poles'),
        total_mst_hst: clamp('total_mst_hst'),
        total_splice_cases: clamp('total_splice_cases'),
        total_handholes: clamp('total_handholes'),
        total_vaults: clamp('total_vaults'),
      }
      const { error: totErr } = await db.from('submissions')
        .update(nextTotals).eq('id', sub.id).is('actuals_applied_at', null)
      if (totErr) throw totErr

      setEditMode(false); setShowPartSearch(false)
      showToast('Changes saved')
      // Reflect the new hours + footage on the selected row without a full refetch.
      setSelected(prev => prev && prev.id === sub.id ? { ...prev, hours_worked: editHours, ...nextTotals } : prev)
      await loadSubmissions()
      await loadPartsForSubmission({ ...sub, hours_worked: editHours, ...nextTotals })
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
      onCloseDetail={() => { setSelected(null); setEditMode(false); setEditParts([]); setEditTotals({}); setShowPartSearch(false) }}
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
                // setNote(''): a note typed for one submission must not become
                // another's approval note / flag_reason (matches IntakeRequestsQueue).
                <div key={sub.id} onClick={() => { setSelected(sub); setNote(''); loadPartsForSubmission(sub) }}
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

        {editMode ? (
          // Editable footage/count grid — Hours plus every footage rollup shown
          // regardless of value so a wrong (or missing) strand/fiber/etc. can be
          // corrected or zeroed out. approve reads these straight for phase actuals.
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: 10, textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <button className="tally-btn tally-sm tally-minus" onClick={() => setEditHours(h => Math.max(0, Math.round((h - 0.5) * 2) / 2))}>−</button>
                <span className="mono" style={{ minWidth: 30, fontSize: 15 }}>{editHours.toFixed(1)}</span>
                <button className="tally-btn tally-sm tally-plus" onClick={() => setEditHours(h => Math.min(16, Math.round((h + 0.5) * 2) / 2))}>+</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>Hours</div>
            </div>
            {FOOTAGE_FIELDS.map(f => (
              <div key={f.key} style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: 10, textAlign: 'center' }}>
                <input
                  type="number" min="0" inputMode="decimal"
                  value={editTotals[f.key] ?? ''}
                  onChange={e => setEditTotals(prev => ({ ...prev, [f.key]: e.target.value }))}
                  style={{ width: '100%', padding: '2px 4px', textAlign: 'center', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border2)', color: 'var(--orange)', fontSize: 16, fontWeight: 800, outline: 'none' }}
                />
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{f.label}{f.unit ? ` (${f.unit})` : ''}</div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
            {[
              { label: 'Hours', value: (sel.hours_worked || 0) },
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
        )}

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
                  <div key={p.part_id + '|' + (p.source_location_id || '')} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: i < editParts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>{p.part_id}</div>
                      {/* Tappable in edit mode: re-point this line at a
                          different truck before approving. */}
                      <button onClick={() => setEditSourceIdx(i)} style={{ padding: 0, marginTop: 2, cursor: 'pointer' }}>
                        <SourcePill name={p.sourceName || `${sel.users?.name || 'Submitter'} (own truck)`} muted={!p.source_location_id} editable />
                      </button>
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
          <>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: selectedParts.some(p => p.source_location_id) ? 8 : 14, maxHeight: 200, overflowY: 'auto' }}>
              {selectedParts.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', borderBottom: i < selectedParts.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    {p.sourceName && <SourcePill name={p.sourceName} />}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal-dk)', flexShrink: 0, marginLeft: 8 }}>
                    {p.qty.toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
                  </div>
                </div>
              ))}
            </div>
            {/* Deduction preview — which trucks the approval will hit. Only
                rendered when some line is tagged; the everyday single-truck
                passdown stays visually unchanged. */}
            {selectedParts.some(p => p.source_location_id) && (() => {
              const groups = {}
              selectedParts.forEach(p => {
                const label = p.sourceName || `${sel.users?.name || 'Submitter'} (own truck)`
                if (!groups[label]) groups[label] = 0
                groups[label] += 1
              })
              return (
                <div style={{
                  background: 'var(--amber-lt)', color: 'var(--amber)',
                  borderRadius: 'var(--r-sm)', padding: '8px 12px', marginBottom: 14,
                  fontSize: 12, fontWeight: 600, lineHeight: 1.5,
                }}>
                  <Icon name="truck" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 5 }} />
                  Approval deducts {Object.keys(groups).length} trucks:{' '}
                  {Object.entries(groups).map(([n, c]) => `${n} (${c} line${c !== 1 ? 's' : ''})`).join(' · ')}
                </div>
              )
            })()}
          </>
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
              // Merge only into the untagged (submitter's-truck) line — a
              // line tagged to another truck is a different line now.
              setEditParts(prev => prev.some(x => x.part_id === p.id && !x.source_location_id)
                ? prev.map(x => (x.part_id === p.id && !x.source_location_id) ? { ...x, qty: x.qty + 1 } : x)
                : [...prev, { part_id: p.id, name: p.name, unit: p.unit || 'ea', qty: 1, source_location_id: null, sourceName: null }])
              setShowPartSearch(false)
            }}
            onClose={() => setShowPartSearch(false)}
          />
        )}

        {/* Edit-mode source picker — re-point a line at a different truck.
            "Submitter's truck" clears the override (NULL, resolved at
            approval). Rendered last so it stacks over the detail overlay. */}
        {editSourceIdx !== null && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setEditSourceIdx(null)}>
            <div className="overlay-sheet" style={{ maxHeight: '75vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2, flexShrink: 0 }}>
                {editParts[editSourceIdx]?.name} — pulled from which truck?
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, flexShrink: 0 }}>
                Approval deducts this line from the picked truck
              </div>
              <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                {[
                  { id: null, label: `${sel.users?.name || 'Submitter'}'s truck (default)` },
                  ...(mgrTrucks || []).map(l => ({
                    id: l.id,
                    label: l.assigned_user?.name || l.name,
                    group: l.type === 'group',
                  })),
                ].map(opt => {
                  const selectedOpt = (editParts[editSourceIdx]?.source_location_id || null) === opt.id
                  return (
                    <div
                      key={opt.id || 'default'}
                      onClick={() => {
                        setEditParts(prev => prev.map((x, j) => j === editSourceIdx
                          ? { ...x, source_location_id: opt.id, sourceName: opt.id ? opt.label : null }
                          : x))
                        setEditSourceIdx(null)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px',
                        borderBottom: '1px solid var(--border)', cursor: 'pointer',
                        fontSize: 13.5, fontWeight: selectedOpt ? 800 : 600,
                        color: selectedOpt ? 'var(--teal-dk)' : 'var(--text)',
                        background: selectedOpt ? 'var(--teal-lt)' : 'transparent',
                      }}
                    >
                      {opt.label}
                      {opt.group && (
                        <span style={{
                          fontSize: 9, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase',
                          color: 'var(--muted)', background: 'var(--surface2)',
                          border: '1px solid var(--border2)', borderRadius: 4, padding: '1px 5px',
                        }}>group</span>
                      )}
                    </div>
                  )
                })}
                {mgrTrucks === null && (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--muted)', fontSize: 13 }}>Loading trucks…</div>
                )}
              </div>
              <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12, flexShrink: 0 }} onClick={() => setEditSourceIdx(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </>
    )
  }
}

// ─── SOURCE PILL ─────────────────────────────────────────────────────────────
// Which truck a part line deducts from. Teal = tagged to a specific truck /
// group; muted = the submitter's own truck (the default, nothing stored).
function SourcePill({ name, muted = false, editable = false }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, fontWeight: 700, borderRadius: 20, padding: '1px 7px',
      background: muted ? 'var(--surface2)' : 'var(--teal-lt)',
      border: muted ? `1px ${editable ? 'dashed' : 'solid'} var(--border2)` : '1px solid var(--teal)',
      color: muted ? 'var(--hint)' : 'var(--teal-dk)',
    }}>
      <Icon name="truck" size={10} /> {name}{editable ? ' ▾' : ''}
    </span>
  )
}
