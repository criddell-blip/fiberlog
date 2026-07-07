// Read-only list of a task's submitted passdowns — one card per submission,
// newest first: status banner, when/by whom, hours + non-zero footage stats,
// parts, crew notes, manager flag reason / notes. Shared by TaskSummaryView
// (closed tasks) and TaskWorkspace's history overlay (open tasks, backlog
// #34) so the two renderings can't drift. Data shape = getTaskSummary()'s
// submissions array.

export const STATUS_CONFIG = {
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

export default function PassdownList({ submissions }) {
  if (!submissions || submissions.length === 0) return null
  return submissions.map((sub, i) => {
    const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.open
    return (
      <div key={sub.id} style={{ marginBottom: i < submissions.length - 1 ? 18 : 0 }}>
        {/* Status banner — the verdict first; for flagged passdowns the
            manager's reason is the most important thing on screen. */}
        <div style={{
          background: cfg.bg, color: cfg.text,
          borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 14 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
            <span>{cfg.label}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700 }}>
              {(Number(sub.hours_worked) || 0).toLocaleString()} hrs
            </span>
          </div>
          <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>
            Submitted {fmtWhen(sub.created_at)} by {sub.users?.name || 'you'}
            {sub.reviewed_at && sub.reviewer?.name && (
              <> · reviewed {fmtWhen(sub.reviewed_at)} by {sub.reviewer.name}</>
            )}
          </div>
          {sub.status === 'flagged' && sub.flag_reason && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 600 }}>
              Manager note: {sub.flag_reason}
            </div>
          )}
          {sub.status !== 'flagged' && sub.manager_notes && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontStyle: 'italic' }}>
              Manager note: {sub.manager_notes}
            </div>
          )}
        </div>

        {/* Footage stats — only non-zero fields so hours-only passdowns
            don't fill the card with empty fiber metrics. */}
        {FOOTAGE_FIELDS.some(f => (sub[f.key] || 0) > 0) && (
          <div className="metric-row" style={{ marginBottom: 10, alignItems: 'center' }}>
            {FOOTAGE_FIELDS.filter(f => (sub[f.key] || 0) > 0).map(f => (
              <div key={f.key} style={{ fontSize: 12, lineHeight: 1.2 }}>
                <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>{f.label}</div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  {(sub[f.key] || 0).toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{f.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Parts — empty state matters: hours-only passdowns are legitimate. */}
        {(sub.parts || []).length === 0 ? (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: 12, textAlign: 'center',
            color: 'var(--hint)', fontSize: 12,
          }}>
            No parts logged on this passdown.
          </div>
        ) : (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', overflow: 'hidden', padding: '0 14px',
          }}>
            {sub.parts.map(p => (
              <div key={p.partId} className="parts-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div className="part-id">{p.partId}</div>
                </div>
                <div className="part-qty" style={{ flexShrink: 0, marginLeft: 10 }}>
                  {p.qty.toLocaleString()} <span className="part-unit" style={{ fontWeight: 400 }}>{p.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {(sub.notes || []).length > 0 && (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '8px 12px', marginTop: 8,
            fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap',
          }}>
            {sub.notes.join('\n\n')}
          </div>
        )}
      </div>
    )
  })
}

export function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
