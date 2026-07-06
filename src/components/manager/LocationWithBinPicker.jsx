// Two-step location picker: pick a top-level location, then (if it's a
// warehouse with bins) drill into a specific bin. The effective destination
// is `binId || topLevelId` — bin when chosen, otherwise the warehouse level
// ("unbinned"). Shared by every stock-destination flow so the recovery
// dialogs (retire location, decommission site) target bins the same way the
// movement sheets do. See lib/inventory.js getBinsForWarehouse.
//
// Callers own the topLevelId/binId state and should reset binId whenever
// topLevelId changes (a stale bin from another warehouse must not survive).
export default function LocationWithBinPicker({
  topLevelId, setTopLevelId, binId, setBinId,
  options, binsByWarehouse, locations, excludeId,
}) {
  const selectedTop = locations.find(l => l.id === topLevelId)
  const isWarehouse = selectedTop?.type === 'warehouse'
  // excludeId lets a caller keep the location being retired/moved out of its
  // own destination list (both the top options and a parent warehouse's bins).
  const topOptions = excludeId ? options.filter(l => l.id !== excludeId) : options
  const bins = (isWarehouse ? (binsByWarehouse[topLevelId] || []) : [])
    .filter(b => b.id !== excludeId)

  return (
    <div>
      <select
        value={topLevelId}
        onChange={e => setTopLevelId(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
      >
        <option value="">— Pick a location —</option>
        {topOptions.map(loc => (
          <option key={loc.id} value={loc.id}>
            {loc.assigned_user?.name || loc.name} ({loc.type})
          </option>
        ))}
      </select>

      {isWarehouse && bins.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>↳ Bin:</span>
          <select
            value={binId}
            onChange={e => setBinId(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 13, background: 'var(--bg)' }}
          >
            <option value="">(unbinned — warehouse level)</option>
            {bins.map(b => (
              <option key={b.id} value={b.id}>📥 {b.name}</option>
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
