import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { getTaskSummary } from '../../lib/supabase'

// Read-only inspection of a submitted task. Shows the crew what they
// turned in (hours, parts, footage totals if any) plus the manager's
// verdict (pending / approved / flagged) and any flag reason or notes.
//
// Routed to from CrewApp + InfraCrewApp whenever the selected task's
// status is 'pending' | 'approved' | 'done'. The editable workspace
// (TaskWorkspace) is reserved for 'open' tasks the crew can still
// act on. Reopen-after-flag still goes through the manager flagging
// flow, which reverts task.status to 'open' — that's the only path
// back into the editable workspace.
//
// `phase` is the location-shaped object (phase for fiber, site for
// infra via the shim) — we only use its .name for the header line.

const STATUS_CONFIG = {
  pending:  { bg: 'var(--amber-lt)', text: 'var(--amber)',    label: 'Pending review',  icon: '⏳' },
  approved: { bg: 'var(--teal-lt)',  text: 'var(--teal-mid)', label: 'Approved',        icon: '✅' },
  flagged:  { bg: 'var(--red-lt)',   text: 'var(--red)',      label: 'Flagged',         icon: '🚩' },
  done:     { bg: 'var(--gray-lt)',  text: 'var(--muted)',    label: 'Done',            icon: '✓'  },
  open:     { bg: 'var(--orange-lt)', text: 'var(--orange)',  label: 'Open',            icon: '○'  },
}

const FOOTAGE_FIELDS = [
  { key: 'total_strand_ft',    label: 'Strand',       unit: 'ft' },
  { key: 'total_fiber_ft',     label: 'Fiber',        unit: 'ft' },
  { key: 'total_conduit_ft',   label: 'Conduit',      unit: 'ft' },
  { key: 'total_mst_hst',      label: 'MST/HST',      unit: 'units' },
  { key: 'total_splice_cases', label: 'Splice cases', unit: 'cases' },
  { key: 'total_handholes',    label: 'Handholes',    unit: 'ea' },
  { key: 'total_vaults',       label: 'Vaults',       unit: 'ea' },
  { key: 'total_poles',        label: 'Poles',        unit: 'ea' },
]

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

  const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.open

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
            {currentUser?.initials || '👤'}
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

        {!loading && !error && !summary && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ fontSize: 32, marginBottom: 6 }}>📭</div>
            <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>No submission yet</div>
            <div style={{ fontSize: 12 }}>This task is marked “{task.status}” but doesn’t have a submission attached.</div>
          </div>
        )}

        {!loading && summary && (() => {
          const sub = summary.submission
          const subStatus = STATUS_CONFIG[sub.status] || status
          return (
            <>
              {/* Status banner — drives the eye to the verdict first.
                  For flagged tasks the manager's reason is the most
                  important thing to surface. */}
              <div style={{
                background: subStatus.bg, color: subStatus.text,
                borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 14 }}>
                  <span>{subStatus.icon}</span>
                  <span>{subStatus.label}</span>
                </div>
                <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>
                  Submitted {fmtWhen(sub.created_at)} by {sub.users?.name || 'you'}
                  {sub.reviewed_at && sub.reviewer?.name && (
                    <> · reviewed {fmtWhen(sub.reviewed_at)} by {sub.reviewer.name}</>
                  )}
                </div>
                {sub.status === 'flagged' && sub.flag_reason && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 600 }}>
                    Manager note: {sub.flag_reason}
                  </div>
                )}
                {sub.status !== 'flagged' && sub.manager_notes && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontStyle: 'italic' }}>
                    Manager note: {sub.manager_notes}
                  </div>
                )}
              </div>

              {/* Hours + footage totals — only rendered when non-zero so
                  infra-style submissions (which mostly have just hours +
                  parts) don't fill the screen with empty fiber metrics. */}
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 14,
                display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
              }}>
                <Stat label="Hours" value={(sub.hours_worked || 0).toLocaleString()} unit="hrs" emphasized />
                {FOOTAGE_FIELDS.filter(f => (sub[f.key] || 0) > 0).map(f => (
                  <Stat key={f.key} label={f.label} value={(sub[f.key] || 0).toLocaleString()} unit={f.unit} />
                ))}
              </div>

              {/* Parts list — aggregated across all entries for this task
                  in this session. Empty state matters: infra crew can
                  legitimately submit "hours only" days. */}
              <div className="sec-label" style={{ marginBottom: 8 }}>
                Parts used {summary.parts.length > 0 && `(${summary.parts.length})`}
              </div>
              {summary.parts.length === 0 ? (
                <div style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', padding: 16, textAlign: 'center',
                  color: 'var(--hint)', fontSize: 13, marginBottom: 14,
                }}>
                  No parts logged on this submission.
                </div>
              ) : (
                <div style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', marginBottom: 14, overflow: 'hidden',
                }}>
                  {summary.parts.map((p, i) => (
                    <div key={p.partId} style={{
                      display: 'flex', alignItems: 'center', padding: '10px 14px',
                      borderBottom: i < summary.parts.length - 1 ? '1px solid var(--border)' : 'none',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.name}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace', marginTop: 2 }}>
                          {p.partId}
                        </div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--orange)', flexShrink: 0, marginLeft: 10 }}>
                        {p.qty.toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Free-text notes the crew added when submitting (entry-
                  level notes, not the manager's). Usually empty. */}
              {summary.notes && summary.notes.length > 0 && (
                <>
                  <div className="sec-label" style={{ marginBottom: 8 }}>Notes from this submission</div>
                  <div style={{
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 14,
                    fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap',
                  }}>
                    {summary.notes.join('\n\n')}
                  </div>
                </>
              )}

              {/* Footer hint — for flagged tasks the manager's revert
                  flips status='open' so the task reappears in the active
                  sidebar; that's how the crew "edits" a flagged
                  submission. Until then, this view is intentionally
                  read-only — no edit affordances. */}
              <div style={{
                background: 'var(--gray-lt)', color: 'var(--muted)',
                borderRadius: 'var(--r-xs)', padding: '8px 10px',
                fontSize: 11, textAlign: 'center',
              }}>
                {sub.status === 'flagged'
                  ? 'Your manager flagged this submission. They’ll move it back to “open” when it’s ready for you to fix and resubmit.'
                  : 'Read-only view. To make changes, ask your manager to flag the submission so it reopens.'}
              </div>
            </>
          )
        })()}
      </div>
    </div>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function Stat({ label, value, unit, emphasized }) {
  return (
    <div style={{ fontSize: 12, lineHeight: 1.2 }}>
      <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>{label}</div>
      <div style={{
        fontSize: emphasized ? 18 : 15,
        fontWeight: 800,
        color: emphasized ? 'var(--orange)' : 'var(--text)',
      }}>
        {value} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{unit}</span>
      </div>
    </div>
  )
}

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
