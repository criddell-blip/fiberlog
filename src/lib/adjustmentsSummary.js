// Adjustments summary — pure aggregation behind Inventory → Activity's
// "Adjustments summary" sheet (Oct 2026).
//
// Why it exists: during the Sep/Oct 2026 warehouse + truck count, adjustments
// came from four places (count-run approvals, Reconcile CSV, Record movement's
// Counted total, refurb conversions) and the Activity feed only lists them one
// row at a time. Nobody could answer "how much did we adjust up vs down, where"
// — and the most common confusion, one part adjusted DOWN on one shelf and UP
// on another (stock counted in the wrong spot, not lost), was invisible.
//
// Everything here works on movement rows as fetched by
// getAdjustmentsForSummary (lib/inventory.js) plus a location lookup map.

// ─── Sources ────────────────────────────────────────────────────────────────
// Classified by count_run_id first (a column, reliable), then by the fixed
// note prefixes each flow writes. Note prefixes are a contract with:
//   ReconcileSheet       → "Reconcile <date> — counted N, system had M"
//   RecordMovementSheet  → "Spot count <date>…" (buildCountedAdjustPayloads)
//   refurbConvert.js     → "Converted to refurbished: …"
//   reverse_pr_line_receipt → PR-linked adjust-down (purchase_request_line_id)
export const ADJUST_SOURCES = [
  { key: 'count_run', label: 'Count runs' },
  { key: 'reconcile', label: 'Reconcile CSV' },
  { key: 'spot_count', label: 'Spot counts' },
  { key: 'refurb', label: 'Refurb conversions' },
  { key: 'receipt_reversal', label: 'Receipt reversals' },
  { key: 'other', label: 'Other' },
]

// Refurb conversions move stock new → its -R twin as an adjust PAIR. They are
// not a count difference, so the summary leaves them out unless asked.
export const DEFAULT_SOURCES = ADJUST_SOURCES.map(s => s.key).filter(k => k !== 'refurb')

export function adjustmentSource(m) {
  if (m.count_run_id) return 'count_run'
  if (m.purchase_request_line_id) return 'receipt_reversal'
  const n = m.notes || ''
  if (n.startsWith('Reconcile')) return 'reconcile'
  if (n.startsWith('Spot count')) return 'spot_count'
  if (n.startsWith('Converted to refurbished')) return 'refurb'
  return 'other'
}

// ─── Normalise ──────────────────────────────────────────────────────────────
// One row per adjust movement: which location, signed qty (+ up / − down),
// and the "area" it rolls up into — a bin rolls into its warehouse so the
// warehouse total covers every shelf; trucks/groups are their own area.
export function toAdjustRows(movements, locById) {
  const rows = []
  for (const m of movements || []) {
    if (m.movement_type !== 'adjust') continue
    const up = !!m.to_location_id
    const locId = up ? m.to_location_id : m.from_location_id
    if (!locId) continue
    const loc = locById.get(locId) || { id: locId, name: '(unknown location)', type: null }
    const parent = loc.parent_location_id ? locById.get(loc.parent_location_id) : null
    const area = parent || loc
    const qty = Number(m.quantity) || 0
    rows.push({
      id: m.id,
      at: m.created_at,
      partId: m.part_id || m.part?.id,
      partName: m.part?.name || m.part_id,
      unit: m.unit || m.part?.unit || 'ea',
      locId,
      locName: loc.type === 'warehouse' ? `${loc.name} (unbinned)` : loc.name,
      locType: loc.type,
      areaId: area.id,
      areaName: area.name,
      areaType: area.type,
      signed: up ? qty : -qty,
      source: adjustmentSource(m),
      by: m.created_by_user?.name || '',
      notes: m.notes || '',
      countRunId: m.count_run_id || null,
    })
  }
  return rows
}

export function filterBySources(rows, sources) {
  const set = new Set(sources)
  return rows.filter(r => set.has(r.source))
}

// ─── By location ────────────────────────────────────────────────────────────
// Quantities mix units (feet of cable vs each), so the UI leads with LINE
// counts across locations and only shows quantities per part.
function emptyTally() {
  return { upLines: 0, downLines: 0, upQty: 0, downQty: 0 }
}
function tally(t, r) {
  if (r.signed > 0) { t.upLines += 1; t.upQty += r.signed } else { t.downLines += 1; t.downQty += -r.signed }
}

export function summarizeByLocation(rows) {
  const byLoc = new Map()
  for (const r of rows) {
    let e = byLoc.get(r.locId)
    if (!e) {
      e = { locId: r.locId, locName: r.locName, locType: r.locType, areaId: r.areaId, areaName: r.areaName, areaType: r.areaType, ...emptyTally(), parts: new Map() }
      byLoc.set(r.locId, e)
    }
    tally(e, r)
    let p = e.parts.get(r.partId)
    if (!p) { p = { partId: r.partId, partName: r.partName, unit: r.unit, net: 0, lines: 0 }; e.parts.set(r.partId, p) }
    p.net += r.signed
    p.lines += 1
  }
  return [...byLoc.values()]
    .map(e => ({ ...e, parts: [...e.parts.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)) }))
    .sort((a, b) => areaOrder(a) - areaOrder(b)
      || a.areaName.localeCompare(b.areaName)
      || (b.upLines + b.downLines) - (a.upLines + a.downLines)
      || a.locName.localeCompare(b.locName))
}

// Warehouses first, then trucks, then groups — matches the Locations admin.
function areaOrder(e) {
  return { warehouse: 0, truck: 1, group: 2 }[e.areaType] ?? 3
}

export function summarizeByArea(rows) {
  const byArea = new Map()
  for (const r of rows) {
    let e = byArea.get(r.areaId)
    if (!e) {
      e = { areaId: r.areaId, areaName: r.areaName, areaType: r.areaType, ...emptyTally(), locations: new Set() }
      byArea.set(r.areaId, e)
    }
    tally(e, r)
    e.locations.add(r.locId)
  }
  return [...byArea.values()]
    .map(e => ({ ...e, locationCount: e.locations.size }))
    .sort((a, b) => areaOrder(a) - areaOrder(b) || a.areaName.localeCompare(b.areaName))
}

// ─── By part ────────────────────────────────────────────────────────────────
// `upAndDown` = the part's net went UP at some location and DOWN at another
// in the window. That's the "counted in the wrong spot" signature — the two
// adjusts often cancel and the stock was never actually lost or found.
// `repeats` = locations where the part was adjusted more than once (recounts).
export function summarizeByPart(rows) {
  const byPart = new Map()
  for (const r of rows) {
    let e = byPart.get(r.partId)
    if (!e) { e = { partId: r.partId, partName: r.partName, unit: r.unit, upQty: 0, downQty: 0, lines: 0, locs: new Map() }; byPart.set(r.partId, e) }
    if (r.signed > 0) e.upQty += r.signed; else e.downQty += -r.signed
    e.lines += 1
    let l = e.locs.get(r.locId)
    if (!l) { l = { locId: r.locId, locName: r.locName, net: 0, lines: 0, rows: [] }; e.locs.set(r.locId, l) }
    l.net += r.signed
    l.lines += 1
    l.rows.push(r)
  }
  return [...byPart.values()].map(e => {
    const locations = [...e.locs.values()]
      .map(l => ({ ...l, rows: l.rows.sort((a, b) => String(a.at).localeCompare(String(b.at))) }))
      .sort((a, b) => a.net - b.net)
    const upAndDown = locations.some(l => l.net > 0) && locations.some(l => l.net < 0)
    return {
      partId: e.partId, partName: e.partName, unit: e.unit,
      upQty: e.upQty, downQty: e.downQty, net: e.upQty - e.downQty, lines: e.lines,
      locations, upAndDown,
      repeats: locations.filter(l => l.lines > 1).length,
    }
  }).sort((a, b) => (Number(b.upAndDown) - Number(a.upAndDown)) || (b.lines - a.lines) || String(a.partName).localeCompare(String(b.partName)))
}

export function totals(rows) {
  const t = emptyTally()
  for (const r of rows) tally(t, r)
  t.parts = new Set(rows.map(r => r.partId)).size
  t.locations = new Set(rows.map(r => r.locId)).size
  return t
}

// Display: "+12", "−4", "0" — trims float noise from footage sums.
export function fmtSigned(n) {
  const v = Math.round(Number(n) * 100) / 100
  if (v === 0) return '0'
  return (v > 0 ? '+' : '−') + Math.abs(v).toLocaleString()
}
