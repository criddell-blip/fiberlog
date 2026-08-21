// Two-step location picker: pick a top-level location, then (if it's a
// warehouse with bins) drill into a specific bin. The effective destination
// is `binId || topLevelId` — bin when chosen, otherwise the warehouse level
// ("unbinned"). Shared by every stock-destination flow so the recovery
// dialogs (retire location, decommission site) target bins the same way the
// movement sheets do. See lib/inventory.js getBinsForWarehouse.
//
// Callers own the topLevelId/binId state and should reset binId whenever
// topLevelId changes (a stale bin from another warehouse must not survive).
//
// Optional part-awareness: pass `stock` ({ byId, byTop } from
// buildLocationQtyMaps) and the top-level list splits into a "Has this part"
// group (qty desc, "· N on hand") over "Other locations" — the manager sees
// where the part plausibly is/goes instead of hunting a flat list. byTop is
// the bin→warehouse rollup so a warehouse whose stock all sits in bins still
// surfaces before its bins have lazy-loaded; byId keeps warehouse-own
// ("unbinned") stock separate for the bin sub-select's annotations. Absent
// `stock` → renders exactly as before (location-only callers unaffected).
import { locationTypeLabel } from '../../lib/locationTypes'

export default function LocationWithBinPicker({
  topLevelId, setTopLevelId, binId, setBinId,
  options, binsByWarehouse, locations, excludeId,
  stock, stockGroupLabel,
}) {
  const selectedTop = locations.find(l => l.id === topLevelId)
  const isWarehouse = selectedTop?.type === 'warehouse'
  // excludeId lets a caller keep the location being retired/moved out of its
  // own destination list (both the top options and a parent warehouse's bins).
  const topOptions = excludeId ? options.filter(l => l.id !== excludeId) : options
  const bins = (isWarehouse ? (binsByWarehouse[topLevelId] || []) : [])
    .filter(b => b.id !== excludeId)

  const topQty = id => Number(stock?.byTop?.get(id) || 0)
  const exactQty = id => Number(stock?.byId?.get(id) || 0)
  const hasStock = stock ? topOptions.filter(l => topQty(l.id) > 0) : []
  const others = stock ? topOptions.filter(l => topQty(l.id) <= 0) : topOptions
  const optionText = loc => `${loc.assigned_user?.name || loc.name} (${locationTypeLabel(loc.type)})`

  // Stocked bins first (qty desc); unstocked keep their existing name order.
  const sortedBins = stock
    ? [...bins].sort((a, b) => exactQty(b.id) - exactQty(a.id))
    : bins
  const unbinnedQty = exactQty(topLevelId)

  return (
    <div>
      <select
        value={topLevelId}
        onChange={e => setTopLevelId(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
      >
        <option value="">— Pick a location —</option>
        {hasStock.length > 0 ? (
          <>
            <optgroup label={stockGroupLabel || 'Has this part'}>
              {[...hasStock].sort((a, b) => topQty(b.id) - topQty(a.id)).map(loc => (
                <option key={loc.id} value={loc.id}>
                  {optionText(loc)} · {topQty(loc.id).toLocaleString()} on hand
                </option>
              ))}
            </optgroup>
            {others.length > 0 && (
              <optgroup label="Other locations">
                {others.map(loc => (
                  <option key={loc.id} value={loc.id}>{optionText(loc)}</option>
                ))}
              </optgroup>
            )}
          </>
        ) : (
          others.map(loc => (
            <option key={loc.id} value={loc.id}>{optionText(loc)}</option>
          ))
        )}
      </select>

      {isWarehouse && bins.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>↳ Bin:</span>
          <select
            value={binId}
            onChange={e => setBinId(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 13, background: 'var(--bg)' }}
          >
            <option value="">
              (unbinned — warehouse level){unbinnedQty > 0 ? ` · ${unbinnedQty.toLocaleString()} on hand` : ''}
            </option>
            {sortedBins.map(b => (
              <option key={b.id} value={b.id}>
                📥 {b.name}{exactQty(b.id) > 0 ? ` · ${exactQty(b.id).toLocaleString()} on hand` : ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {isWarehouse && bins.length === 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--hint)' }}>
          No bins under this warehouse — stock goes to the warehouse level.
        </div>
      )}
    </div>
  )
}
