// Truck-stock-first "Add parts used" browser (Aug 2026, Phase 2b of the
// per-line source truck feature). Replaces the blind catalog search as the
// PRIMARY add path on the submit sheet: pick a truck (own truck default),
// see what's actually ON it, tap to add — the line is tagged with that truck
// automatically, so the deduction hits the right stock at approval.
//
// Why stock-first: picking from real truck stock means the SKU is always
// valid and the quantity is anchored to what the truck carries, instead of
// free-text catalog guessing. Especially load-bearing for infra crew, whose
// assembly catalog is still empty — this browser IS their logging flow.
//
// The From dropdown lists same-crew_type trucks + groups by default with a
// "Show all trucks…" expand (convenience filter, not a security boundary —
// manager approval is the control point). The old PartSearch survives via
// the "Search the full catalog" fallback link for parts not on any truck.
import { useState, useEffect } from 'react'
import { getStockByLocation } from '../../../lib/inventory'
import { matchesAllTokens } from '../../../lib/shared'
import { t } from '../../../lib/i18n'
import { useBackClose } from '../../../lib/backStack'
import Icon from '../../shared/Icon'

export default function TruckStockSheet({ myTruck, trucks, crewType, lang, extraParts, onAdd, onCatalog, onClose }) {
  // Mounted only while open → depth 1. The filter box is a filter, not
  // data entry — Back closes without a dirty confirm.
  useBackClose(1, onClose)
  const [fromId, setFromId] = useState(myTruck?.id || null)
  // No own truck (staff who gained a crew_type after creation never get an
  // auto-truck — documented gap): start with the dropdown open so the first
  // action is picking a real source instead of staring at an empty list.
  const [ddOpen, setDdOpen] = useState(!myTruck?.id)
  const [showAll, setShowAll] = useState(!crewType)
  const [filter, setFilter] = useState('')
  const [stock, setStock] = useState(null) // null = loading

  const others = (trucks || []).filter(l => l.id !== myTruck?.id)
  const ddList = showAll
    ? others
    : others.filter(l => l.type === 'group' || l.assigned_user?.crew_type === crewType)
  const hiddenCount = others.length - ddList.length
  const fromLoc = (fromId && fromId === myTruck?.id) ? myTruck : others.find(l => l.id === fromId)
  const fromName = !fromId
    ? '—'
    : fromId === myTruck?.id
      ? t('myTruckWord', lang)
      : (fromLoc?.assigned_user?.name || fromLoc?.name || '…')

  useEffect(() => {
    if (!fromId) return
    let cancelled = false
    setStock(null)
    getStockByLocation(fromId)
      .then(rows => { if (!cancelled) setStock(rows) })
      .catch(e => { console.warn('Truck stock load failed:', e); if (!cancelled) setStock([]) })
    return () => { cancelled = true }
  }, [fromId])

  // The source a tapped row will be tagged with: own truck = null (untagged).
  const tagFor = fromId === myTruck?.id ? null : fromId

  const rows = (stock || [])
    .filter(r => r.parts_catalog && r.parts_catalog.is_active !== false && Number(r.quantity) > 0)
    .filter(r => !filter.trim() || matchesAllTokens(filter, [r.parts_catalog.name, r.parts_catalog.id]))

  const alreadyAdded = (partId) =>
    (extraParts || []).some(ep => ep.id === partId && (ep.sourceLocationId || null) === tagFor)

  return (
    // Shares .overlay's z-index — stacks over the summary sheet by DOM order
    // (rendered after it in TaskWorkspace); PartSearch renders after THIS, so
    // the catalog fallback stacks over the browser in turn.
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2, flexShrink: 0 }}>{t('addFromTruckTitle', lang)}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10, flexShrink: 0 }}>{t('addFromTruckSub', lang)}</div>

        {/* From dropdown — inline expanding list, matching the picker sheet. */}
        <button
          onClick={() => setDdOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            background: 'var(--surface2)', border: '1.5px solid var(--border2)',
            borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 8,
            fontSize: 14, fontWeight: 700, color: 'var(--text)', textAlign: 'left', flexShrink: 0,
          }}
        >
          <Icon name="truck" size={14} />
          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('fromWord', lang)} {fromName}
            {fromLoc?.type === 'group' && (
              <span style={{
                marginLeft: 6, fontSize: 9, fontWeight: 800, letterSpacing: '0.05em',
                textTransform: 'uppercase', color: 'var(--muted)',
                background: 'var(--surface)', border: '1px solid var(--border2)',
                borderRadius: 4, padding: '1px 5px', verticalAlign: 1,
              }}>{t('groupWord', lang)}</span>
            )}
          </span>
          <span style={{ color: 'var(--hint)', fontSize: 11 }}>{ddOpen ? '▲' : '▼'}</span>
        </button>
        {ddOpen && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            marginBottom: 8, overflow: 'hidden', flexShrink: 0, maxHeight: 220, overflowY: 'auto',
          }}>
            {[...(myTruck?.id ? [{ id: myTruck.id, _mine: true }] : []), ...ddList].map(l => (
              <div
                key={l._mine ? 'mine' : l.id}
                onClick={() => { setFromId(l.id); setDdOpen(false); setFilter('') }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                  borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 13.5,
                  fontWeight: fromId === l.id ? 800 : 600,
                  color: fromId === l.id ? 'var(--teal-dk)' : 'var(--text)',
                  background: fromId === l.id ? 'var(--teal-lt)' : 'var(--surface)',
                }}
              >
                {l._mine ? t('myTruckWord', lang) : (l.assigned_user?.name || l.name)}
                {l.type === 'group' && (
                  <span style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase',
                    color: 'var(--muted)', background: 'var(--surface2)',
                    border: '1px solid var(--border2)', borderRadius: 4, padding: '1px 5px',
                  }}>{t('groupWord', lang)}</span>
                )}
              </div>
            ))}
            {!showAll && hiddenCount > 0 && (
              <button
                onClick={() => setShowAll(true)}
                style={{ width: '100%', textAlign: 'center', padding: 10, fontSize: 12.5, fontWeight: 700, color: 'var(--teal)' }}
              >
                {t('showAllTrucks', lang)}
              </button>
            )}
          </div>
        )}

        <div className="field" style={{ flexShrink: 0 }}>
          <input
            type="text"
            placeholder={t('filterTruckStock', lang)}
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
            name="truck-stock-filter"
          />
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {!fromId && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--hint)', fontSize: 13 }}>{t('pickTruckFirst', lang)}</div>
          )}
          {fromId && stock === null && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)', fontSize: 13 }}>…</div>
          )}
          {stock !== null && rows.length === 0 && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--hint)', fontSize: 13 }}>
              {t('noStockOnTruck', lang)}
            </div>
          )}
          {rows.map(r => {
            const p = r.parts_catalog
            const added = alreadyAdded(p.id)
            return (
              <div key={p.id} className="parts-row" style={{ gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                  <div className="part-id">{p.id}</div>
                </div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', flexShrink: 0 }}>
                  {Number(r.quantity).toLocaleString()} {p.unit || 'ea'}
                </span>
                <button
                  onClick={() => onAdd({ id: p.id, name: p.name, unit: p.unit || 'ea' }, tagFor)}
                  style={added ? {
                    flexShrink: 0, fontSize: 12, fontWeight: 800, borderRadius: 'var(--r-pill)',
                    padding: '6px 12px', background: 'var(--surface2)',
                    border: '1px solid var(--border2)', color: 'var(--hint)',
                  } : {
                    flexShrink: 0, fontSize: 12, fontWeight: 800, borderRadius: 'var(--r-pill)',
                    padding: '6px 12px', background: 'var(--teal-lt)',
                    border: '1px solid var(--teal)', color: 'var(--teal-dk)',
                  }}
                >
                  {added ? `✓ ${t('addedWord', lang)}` : `＋ ${t('addWord', lang)}`}
                </button>
              </div>
            )
          })}
        </div>

        <button
          onClick={onCatalog}
          style={{
            width: '100%', textAlign: 'center', padding: 12, fontSize: 12,
            color: 'var(--muted)', borderTop: '1px solid var(--border)', marginTop: 8, flexShrink: 0,
          }}
        >
          {t('notOnTruckCatalog', lang)}
        </button>
        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8, flexShrink: 0 }} onClick={onClose}>
          {t('doneWord', lang)}
        </button>
      </div>
    </div>
  )
}
