// ─── Warehouse → bin source resolution (Sonar + fiber-jobs importers) ─────
//
// A Sonar "Main Warehouse" source maps to the FiberLog *warehouse* row, but
// stock actually lives in that warehouse's bins. Deducting from the warehouse
// row itself drove "unbinned" negative while the bins kept the stock (Nov
// 2026). So when an import line is sourced from a warehouse, the importers
// resolve it down to the bin holding that part:
//
//   • manual pick (bin or the warehouse itself = "unbinned") always wins;
//   • otherwise the bin with the MOST remaining qty of that part;
//   • unbinned only when no bin under the warehouse has any.
//
// "Remaining" is running: lines are processed in order and each draw is
// subtracted, so 10 ONTs against two bins of 6 + 5 spread instead of all
// landing on the 6. A line is never split across bins (one line = one
// movement); a line bigger than what its bin has left is flagged `short` —
// warn-but-allow, same posture as confirmNegativeStock.
//
// Pure + tested (binSource.test.js) because it decides which shelf a
// consumption movement drains.

// stockRows: getStockRowsForParts() output — [{ part_id, location_id, quantity }]
// → Map part_id → Map location_id → qty (raw; may be negative).
export function buildStockIndex(stockRows) {
  const idx = new Map()
  for (const r of stockRows || []) {
    if (!r?.part_id || !r?.location_id) continue
    let m = idx.get(r.part_id)
    if (!m) { m = new Map(); idx.set(r.part_id, m) }
    m.set(r.location_id, (m.get(r.location_id) || 0) + (Number(r.quantity) || 0))
  }
  return idx
}

// locations: any list carrying { id, name, type, parent_location_id, is_active }
// → Map warehouseId → [{ id, name }] of its active bins, name-sorted.
export function buildBinsByWarehouse(locations) {
  const out = new Map()
  for (const l of locations || []) {
    if (l?.type !== 'bin' || !l.parent_location_id || l.is_active === false) continue
    if (!out.has(l.parent_location_id)) out.set(l.parent_location_id, [])
    out.get(l.parent_location_id).push({ id: l.id, name: l.name })
  }
  for (const list of out.values()) list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))
  return out
}

// lines: [{ key, partId, warehouseId, qty, overrideId? }] in apply order.
// Lines without a partId or warehouseId are ignored (not warehouse-sourced).
// Returns Map key → {
//   locationId,   // the bin (or the warehouse = unbinned) to deduct from
//   auto,         // true when picked by the rule, false when overridden
//   available,    // qty left at locationId before this line's draw
//   short,        // qty > available
//   options,      // [{ id, label, qty, isUnbinned }] for the picker, most stock first
// }
export function allocateBinSources(lines, { stockIndex, binsByWarehouse, warehouseNames } = {}) {
  const remaining = new Map()   // `${part}::${loc}` → qty left
  const left = (partId, locId) => {
    const k = `${partId}::${locId}`
    if (!remaining.has(k)) remaining.set(k, stockIndex?.get(partId)?.get(locId) || 0)
    return remaining.get(k)
  }
  const out = new Map()
  for (const line of lines || []) {
    if (!line?.partId || !line?.warehouseId) continue
    const qty = Number(line.qty) || 0
    const bins = binsByWarehouse?.get(line.warehouseId) || []

    // An override only counts if it still belongs to this warehouse — the
    // row's source may have been re-pointed since the bin was picked.
    const ov = line.overrideId
    let locationId = ov && (ov === line.warehouseId || bins.some(b => b.id === ov)) ? ov : null
    const auto = !locationId
    if (auto) {
      let best = null, bestQty = 0
      for (const b of bins) {
        const q = left(line.partId, b.id)
        if (q > bestQty) { best = b.id; bestQty = q }   // strict > keeps name order on ties
      }
      locationId = best || line.warehouseId
    }
    const available = left(line.partId, locationId)
    remaining.set(`${line.partId}::${locationId}`, available - qty)

    const onHand = id => stockIndex?.get(line.partId)?.get(id) || 0
    const binOpts = bins
      .map(b => ({ id: b.id, label: b.name, qty: onHand(b.id), isUnbinned: false }))
      .sort((a, b) => b.qty - a.qty)
    const whName = warehouseNames?.get(line.warehouseId)
    const options = [
      ...binOpts,
      { id: line.warehouseId, label: `Unbinned${whName ? ` (${whName})` : ''}`, qty: onHand(line.warehouseId), isUnbinned: true },
    ]
    out.set(line.key, { locationId, auto, available, short: qty > available, options })
  }
  return out
}
