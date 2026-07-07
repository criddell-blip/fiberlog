import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// ─── REVIEW QUEUE CHASSIS (backlog #22) ─────────────────────────────────────
// Config-driven shell shared by the manager review queues (SubmissionsQueue,
// IntakeRequestsQueue): header (title + amber pending badge + Refresh),
// status <select> filter, scrollable list body with loading/empty states,
// and the detail overlay wrapper (click-outside close, hardware-Back close,
// bottom Close button). The list rows and the detail sheet CONTENT stay
// bespoke per queue — they're passed as `children` and `renderDetail`.
//
// Queue-specific extras that would need >3 slot props to absorb (project
// grouping, archived toggle, parts loading, close-task, archive) deliberately
// live in the owning queue, not here.

export default function ReviewQueue({
  title,
  pendingCount = 0,
  onRefresh,
  filter,
  onFilterChange,
  statusOptions,          // [{ id, label }] — rendered as "Status: <label>"
  headerExtras = null,    // extra controls on the filter row (e.g. Archived chip)
  loading = false,
  isEmpty = false,        // empty-state check, evaluated only when !loading
  emptyIcon = 'box',
  emptyMessage = 'Nothing here',
  selected = null,        // truthy → detail overlay open
  onCloseDetail,
  renderDetail,           // (selected) => sheet content (Close button appended by the chassis)
  children,               // the list rows (always rendered, even during a refresh)
}) {
  // Back closes the detail overlay.
  useBackClose(selected ? 1 : 0, onCloseDetail)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            {title}
            {pendingCount > 0 && <span style={{ marginLeft: 8, background: 'var(--amber)', color: 'white', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{pendingCount}</span>}
          </div>
          <button onClick={onRefresh} style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
        </div>
        {/* Status filter: dropdown (was wrapping pills, saves ~30px on mobile). */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            style={{
              height: 30, padding: '0 10px', fontSize: 12, fontWeight: 600,
              border: '1px solid var(--border2)', borderRadius: 999,
              background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
            }}
          >
            {statusOptions.map(opt => (
              <option key={opt.id} value={opt.id}>Status: {opt.label}</option>
            ))}
          </select>
          {headerExtras}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>}
        {!loading && isEmpty && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--gray-mid)' }}><Icon name={emptyIcon} size={32} /></div>
            <div>{emptyMessage}</div>
          </div>
        )}
        {children}
      </div>

      {selected && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && onCloseDetail()}>
          <div className="overlay-sheet">
            {renderDetail(selected)}
            <button style={{ width: '100%', marginTop: 10, padding: 12, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }} onClick={onCloseDetail}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SHARED PIECES ──────────────────────────────────────────────────────────

// Note textarea (pending only) + danger/primary action pair, or the status
// banner once the record is decided. Both queues share this exact shape;
// wording/sizing differences are props.
export function ReviewActions({
  isPending,
  note, onNoteChange,
  noteLabel = 'Note (optional)',
  notePlaceholder = 'Add a note...',
  noteMinHeight = 56,
  acting = false,
  danger,   // { label, icon, onClick }
  primary,  // { label, icon, busyLabel, onClick }
  banner,   // { bg, text, label, suffix? } — shown when !isPending
}) {
  if (isPending) {
    return (
      <>
        <div className="field">
          <label>{noteLabel}</label>
          <textarea placeholder={notePlaceholder} value={note} onChange={e => onNoteChange(e.target.value)} style={{ minHeight: noteMinHeight }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-danger" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={danger.onClick} disabled={acting}>
            <Icon name={danger.icon} size={14} /> {danger.label}
          </button>
          <button className="btn btn-primary" style={{ flex: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={primary.onClick} disabled={acting}>
            {acting ? primary.busyLabel : <><Icon name={primary.icon} size={14} /> {primary.label}</>}
          </button>
        </div>
      </>
    )
  }
  return (
    <div style={{ textAlign: 'center', padding: 12, borderRadius: 'var(--r-sm)', fontWeight: 700, background: banner?.bg, color: banner?.text }}>
      {banner?.label}{banner?.suffix || ''}
    </div>
  )
}

// Teal initials circle used on every queue row.
export function InitialsAvatar({ initials }) {
  return (
    <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--teal-lt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11, color: 'var(--teal-dk)', flexShrink: 0 }}>
      {initials || '?'}
    </div>
  )
}

// Status pill (row right edge). `colors` is a STATUS_COLORS entry.
export function StatusPill({ colors, style }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: colors.bg, color: colors.text, flexShrink: 0, ...style }}>
      {colors.label}
    </span>
  )
}

// Row-level timestamp — both queues format created_at identically.
// Re-exported from lib/format so there's exactly one date formatter
// (and its null guard) to maintain.
export { fmtWhen as fmtShortDateTime } from '../../lib/format'
