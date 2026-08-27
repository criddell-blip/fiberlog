// Running balance of ONE part at ONE location, reconstructed from the ledger.
//
// No movement row stores the on-hand before/after it — the stock trigger just
// overwrites inventory_stock. So the balance history is rebuilt BACKWARDS:
// start from what's on hand right now and un-apply each movement, newest
// first. Anchoring on today's stock (not on row 1) is what makes this exact
// even when the fetch is capped: the 200 most recent rows still get correct
// before/after figures because nothing older than them is needed.
//
// The only assumption is the ledger's own invariant — inventory_stock equals
// the sum of movements at that location. `driftAtOldest` reports the one case
// where that's visibly false (an uncapped history whose oldest row doesn't
// start from zero), so the panel can say so instead of printing a number that
// looks authoritative and isn't.

// Signed effect of a movement on the balance at `locationId`. Direction comes
// from the endpoints, never from the sign of `quantity`: an adjust-down is
// stored with from_location only and a positive magnitude, and a row that
// touches neither endpoint (defensive — the query is location-filtered)
// contributes nothing.
export function deltaAtLocation(m, locationId) {
  if (!m || !locationId) return 0
  const q = Math.abs(Number(m.quantity)) || 0
  let d = 0
  if (m.to_location_id === locationId) d += q
  if (m.from_location_id === locationId) d -= q
  return d
}

// Booking order, newest first. The trigger applied movements in insert order,
// so the balance chain MUST follow created_at — not the effective work date
// the rest of the history panel sorts by (the ~487 backfilled import rows
// disagree between the two, and sorting by work date would print a chain
// where one row's "before" isn't the next row's "after"). `id` breaks ties
// inside a batch insert so the output is deterministic.
export function byBookingOrderDesc(rows) {
  return [...rows].sort((a, b) => {
    const ta = new Date(a?.created_at || 0).getTime()
    const tb = new Date(b?.created_at || 0).getTime()
    if (tb !== ta) return tb - ta
    return String(b?.id || '').localeCompare(String(a?.id || ''))
  })
}

// → { rows: [{ m, delta, before, after }] (newest first), driftAtOldest }
//
// `currentQty` is the location's on-hand RIGHT NOW (0 when there's no stock
// row). `truncated` tells us whether rows older than these exist; when they
// don't, the oldest row's `before` should be 0 and anything else is drift.
export function withRunningBalance(movements, locationId, currentQty, { truncated = false } = {}) {
  const ordered = byBookingOrderDesc(movements || [])
  let running = Number(currentQty) || 0
  const rows = ordered.map(m => {
    const delta = deltaAtLocation(m, locationId)
    const after = running
    const before = after - delta
    running = before
    return { m, delta, before, after }
  })
  const oldestBefore = rows.length ? rows[rows.length - 1].before : Number(currentQty) || 0
  const driftAtOldest = !truncated && rows.length > 0 && oldestBefore !== 0 ? oldestBefore : 0
  return { rows, driftAtOldest }
}
