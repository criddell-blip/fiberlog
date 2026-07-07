import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { getTaskSummary } from '../../lib/supabase'
import Icon from '../shared/Icon'
import PassdownList from './PassdownList'

// Read-only inspection of a task's submitted work. Shows the crew EVERY
// passdown they turned in (hours, parts, footage totals) plus the
// manager's verdict per passdown (pending / approved / flagged) and any
// flag reason or notes. Under the is_closed model (backlog #2) a task can
// accumulate many passdowns, so this renders the full list, newest first.
//
// Routed to from CrewApp + InfraCrewApp whenever the selected task is
// closed (isReadOnlyTask). The editable workspace (TaskWorkspace) is for
// open tasks — it shows the same history in its "submitted passdowns"
// overlay (backlog #34), rendered by the shared PassdownList.
//
// `phase` is the location-shaped object (phase for fiber, site for
// infra via the shim) — we only use its .name for the header line.

export default function TaskSummaryView({ project, phase, task, onBack, onUserTap }) {
  const { currentUser } = useApp()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [summary, setSummary] = useState(null)

  useEffect(() => {
    if (!task?.id) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getTaskSummary(task.id)
      .then(data => { if (!cancelled) setSummary(data) })
      .catch(e => {
        console.error('Task summary load failed:', e)
        if (!cancelled) setError(e.message)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [task?.id])

  const subs = summary?.submissions || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        background: 'var(--surface)',
      }}>
        {onBack && (
          <button onClick={onBack}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', padding: 4 }}>
            ‹
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {phase?.name ? `${phase.name} · ` : ''}{project?.name || ''}
          </div>
        </div>
        {onUserTap && (
          <button onClick={onUserTap}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--orange-lt)', color: 'var(--orange)',
              border: '1.5px solid var(--orange-dk)',
              fontWeight: 800, fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
            }}>
            {currentUser?.initials || <Icon name="users" size={15} />}
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading summary…</div>
        )}

        {error && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--red)', fontSize: 13 }}>
            Could not load summary: {error}
          </div>
        )}

        {!loading && !error && subs.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: 'var(--gray-mid)' }}><Icon name="layers" size={30} /></div>
            <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>No submission yet</div>
            <div style={{ fontSize: 12 }}>This task was closed without a submission attached.</div>
          </div>
        )}

        {!loading && !error && subs.length > 0 && (
          <>
            {/* Task scope notes — "what was this task for" before "what
                was logged." Both `notes` (getFullTree's alias for
                scope_notes) and `scope_notes` so raw-fetched tasks work. */}
            {(task.notes || task.scope_notes) && (
              <>
                <div className="sec-label" style={{ marginBottom: 8 }}>Task notes</div>
                <div className="card" style={{
                  padding: '10px 14px', marginBottom: 14,
                  fontSize: 'var(--fs-base)', whiteSpace: 'pre-wrap',
                }}>
                  {task.notes || task.scope_notes}
                </div>
              </>
            )}

            <div className="sec-label" style={{ marginBottom: 8 }}>
              {subs.length === 1
                ? 'Submitted passdown'
                : `${subs.length} passdowns · ${(summary.totalHours || 0).toLocaleString()} hrs total`}
            </div>
            <PassdownList submissions={subs} />

            {/* Footer hint — a flagged passdown reopens via the manager's
                flag flow; the crew resubmits from the open workspace. */}
            <div style={{
              background: 'var(--gray-lt)', color: 'var(--muted)',
              borderRadius: 'var(--r-xs)', padding: '8px 10px',
              fontSize: 11, textAlign: 'center', marginTop: 14,
            }}>
              Read-only view. To make changes, ask your manager to flag the submission or reopen the task.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
