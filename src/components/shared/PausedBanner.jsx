import { useApp } from '../../AppContext'

// Slim sticky banner that appears at the top of any inventory-displaying
// surface (manager Inventory section, crew shells) when the org-wide
// stock display mode is paused. Reminds everyone — managers and crew —
// that Sage is authoritative and the qty numbers they used to see are
// hidden by design.
//
// Owner sees a Resume button inline; non-owners just see the notice.
export default function PausedBanner() {
  const {
    isQtyPaused, qtyDisplayUpdatedAt, qtyDisplayUpdatedBy,
    users, currentUser, setInventoryQtyDisplayMode, showToast,
  } = useApp()
  if (!isQtyPaused) return null

  const isOwner = currentUser?.role === 'owner'
  const updatedByUser = qtyDisplayUpdatedBy && users
    ? users.find(u => u.id === qtyDisplayUpdatedBy)
    : null

  async function handleResume() {
    try {
      await setInventoryQtyDisplayMode('tracking')
      showToast('Stock display resumed — qty numbers are back')
    } catch (e) {
      showToast(e.message || 'Resume failed')
    }
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 14px',
        background: 'var(--amber-lt)',
        borderBottom: '1px solid var(--amber)',
        fontSize: 12, color: 'var(--amber)', fontWeight: 600,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 14 }}>📵</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        Stock display paused — Sage is authoritative for counts.
        {qtyDisplayUpdatedAt && (
          <span style={{ fontWeight: 400, color: 'var(--amber)', opacity: 0.85, marginLeft: 6 }}>
            Paused {new Date(qtyDisplayUpdatedAt).toLocaleDateString()}
            {updatedByUser ? ` by ${updatedByUser.name}` : ''}
          </span>
        )}
      </div>
      {isOwner && (
        <button
          type="button"
          onClick={handleResume}
          style={{
            padding: '3px 10px', borderRadius: 999,
            background: 'transparent', color: 'var(--amber)',
            border: '1.5px solid var(--amber)',
            fontWeight: 700, fontSize: 11, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Resume tracking
        </button>
      )}
    </div>
  )
}
