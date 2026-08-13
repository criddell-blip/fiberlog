// Per-line source truck picker (Aug 2026). Opened from a part row on the
// submit sheet: "this line came off ___'s truck". Picking "My truck" clears
// the override (nothing stored — approval resolves the submitter's truck,
// exactly the pre-source behavior); picking anyone else tags the line so
// approve_submission deducts THAT truck instead.
//
// Shows live on-hand of THIS part per truck so the crew picks a truck that
// plausibly supplied it. Zero-stock trucks are dimmed but still selectable —
// stock records lag the field, and manager approval is the backstop
// (same warn-but-allow philosophy as CrewMovementSheet's over-load path).
//
// The list defaults to trucks whose owner shares the picker-user's crew_type
// (an infra user sees infra trucks) plus group locations; "Show all trucks…"
// expands for cross-crew help. This is a convenience filter, not a security
// boundary — the manager approval is the control point.
import { useState, useEffect } from 'react'
import { getStockForLocations } from '../../../lib/inventory'
import { t } from '../../../lib/i18n'
import { useBackClose } from '../../../lib/backStack'

export default function SourceTruckSheet({ part, current, myTruck, trucks, crewType, lang, onPick, onClose }) {
  // Mounted only while open → depth 1. Display-only (picking IS the action).
  useBackClose(1, onClose)
  // No crew_type (e.g. a staff user acting as crew before one is set) means
  // the same-crew filter would match nothing — start expanded instead.
  const [showAll, setShowAll] = useState(!crewType)
  const [onHand, setOnHand] = useState(null) // { [locationId]: qty } | null while loading

  const others = (trucks || []).filter(l => l.id !== myTruck?.id)
  const visible = showAll
    ? others
    : others.filter(l => l.type === 'group' || l.assigned_user?.crew_type === crewType)
  const hiddenCount = others.length - visible.length

  useEffect(() => {
    let cancelled = false
    const ids = [myTruck?.id, ...others.map(l => l.id)].filter(Boolean)
    getStockForLocations(ids, { partId: part.id })
      .then(rows => {
        if (cancelled) return
        const m = {}
        for (const r of rows) m[r.location_id] = (m[r.location_id] || 0) + Number(r.quantity || 0)
        setOnHand(m)
      })
      .catch(e => console.warn('Source on-hand load failed:', e))
    return () => { cancelled = true }
    // trucks is stable per open (fetched once by the workspace); part is fixed.
  }, [part.id])  // eslint-disable-line react-hooks/exhaustive-deps

  function row(loc, { isMine = false } = {}) {
    const selected = isMine ? !current : current === loc?.id
    const qty = onHand === null ? null : (onHand[loc?.id] || 0)
    const dim = qty === 0 && !isMine
    const displayName = isMine
      ? t('myTruckWord', lang)
      : (loc.assigned_user?.name || loc.name)
    return (
      <div
        key={isMine ? 'mine' : loc.id}
        onClick={() => onPick(isMine ? null : loc.id)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '11px 8px',
          borderBottom: '1px solid var(--border)', cursor: 'pointer',
          opacity: dim ? 0.45 : 1,
        }}
      >
        <span style={{
          width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
          border: selected ? '5px solid var(--teal)' : '2px solid var(--border2)',
          background: 'var(--surface)',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {displayName}
            {loc?.type === 'group' && (
              <span style={{
                marginLeft: 6, fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
                textTransform: 'uppercase', color: 'var(--muted)',
                background: 'var(--surface2)', border: '1px solid var(--border2)',
                borderRadius: 4, padding: '1px 5px', verticalAlign: 1,
              }}>{t('groupWord', lang)}</span>
            )}
          </div>
          {isMine && myTruck?.name && (
            <div style={{ fontSize: 11, color: 'var(--hint)' }}>{myTruck.name}</div>
          )}
        </div>
        <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>
          {qty === null ? '…' : `${qty.toLocaleString()} ${t('onHandWord', lang)}`}
        </span>
      </div>
    )
  }

  return (
    // Shares .overlay's z-index — stacks over the summary sheet by DOM order
    // (rendered after it in TaskWorkspace).
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2, flexShrink: 0 }}>
          {t('pulledFromWhich', lang).replace('{part}', part.name)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, flexShrink: 0 }}>
          {part.id}
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {row(myTruck, { isMine: true })}
          {visible.map(l => row(l))}
          {!showAll && hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              style={{ width: '100%', textAlign: 'center', padding: 12, fontSize: 13, fontWeight: 700, color: 'var(--teal)' }}
            >
              {t('showAllTrucks', lang)}
            </button>
          )}
        </div>
        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12, flexShrink: 0 }} onClick={onClose}>
          {lang === 'es' ? 'Cancelar' : 'Cancel'}
        </button>
      </div>
    </div>
  )
}
