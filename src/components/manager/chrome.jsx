import Icon from '../shared/Icon'

// Shared manager-console chrome atoms. These were copy-pasted (with slight
// drift) across the Inventory sub-tabs + PurchaseRequestsTab; this module is
// the single copy. Purely presentational — no state, no data fetching.

// ─── Filter chip ─────────────────────────────────────────────────────────────

// Console filter chip — active reads as a dark chip; inactive is a white
// hairline chip. Replaces the per-file `pillStyle`/`chipStyle` copies
// (Stock / Parts / Movements / Audit tabs + PurchaseRequestsTab), all of
// which were 30px tall — unified here at 30px, so no visual change.
// (The 28px `subPillStyle` in InventoryStockTab is a deliberately smaller
// accent sub-pill, not a drifted copy — it stays local.)
//
// opts.color: 'amber' → amber active background (Parts tab's Drafts filter).
export function chipStyle(selected, opts = {}) {
  const activeBg = opts.color === 'amber' ? 'var(--amber)' : 'var(--dark-bar)'
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 30, padding: '0 13px', borderRadius: 999, fontSize: 12, fontWeight: 600,
    whiteSpace: 'nowrap', cursor: 'pointer',
    background: selected ? activeBg : 'var(--surface)',
    color: selected ? '#fff' : 'var(--muted)',
    border: `1px solid ${selected ? activeBg : 'var(--border2)'}`,
  }
}

// ─── Card surface ────────────────────────────────────────────────────────────

// The Console card shadow, on its own for call sites that toggle the shadow
// conditionally (expanded rows, accent stats).
export const CARD_SHADOW = '0 1px 3px rgba(15,23,42,0.06)'

// Full card-surface chrome for list containers / feed rows. Spread it and
// override as needed: `{ ...cardSurface, overflow: 'hidden' }`.
export const cardSurface = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  boxShadow: CARD_SHADOW,
}

// ─── Placeholder blocks ──────────────────────────────────────────────────────

// Centered muted "Loading…" placeholder.
export function LoadingBlock({ label = 'Loading…', padding = 40 }) {
  return <div style={{ textAlign: 'center', padding, color: 'var(--muted)' }}>{label}</div>
}

// Centered empty-state hint. Optional line icon above the message.
export function EmptyState({ icon, padding = 40, children }) {
  return (
    <div style={{ textAlign: 'center', padding, color: 'var(--hint)' }}>
      {icon && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--border2)' }}>
          <Icon name={icon} size={36} />
        </div>
      )}
      {children}
    </div>
  )
}
