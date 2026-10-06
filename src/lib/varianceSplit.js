// Pure logic behind the shared "where did the difference go?" panel
// (components/shared/VarianceSplitPanel.jsx) — used by the cycle-count
// review, Reconcile and Record movement → Counted total, so the three book a
// split identically. The movements themselves come from
// buildSplitVariancePayloads (lib/inventory.js) / resolve_count_resolution.

// Sums in SQL numeric are exact; JS floats aren't (0.1 + 0.2).
export const roundQty = n => Math.round(n * 1e6) / 1e6

// Where a set of split lines stands against a difference.
//   diff  — counted − books (signed); null while unknown
//   lines — [{ locationId, qty }] with qty as typed (string or number)
// A line counts once it has a location AND a quantity above 0; anything else
// is `incomplete` and must block the submit (never silently dropped).
export function splitStatus(diff, lines = []) {
  const qty = diff == null ? null : Math.abs(Number(diff))
  const okLine = l => l.locationId && l.qty !== '' && l.qty != null && Number.isFinite(Number(l.qty)) && Number(l.qty) > 0
  const good = lines.filter(okLine).map(l => ({ locationId: l.locationId, qty: Number(l.qty) }))
  const total = roundQty(good.reduce((t, l) => t + l.qty, 0))
  return {
    qty,
    good,
    total,
    incomplete: good.length !== lines.length,
    over: qty != null && total > qty,
    remainder: qty == null ? null : Math.max(0, roundQty(qty - total)),
  }
}

// Default qty when a location is added: what's still unassigned, capped —
// for a loss — at how far negative that location is (a −3 truck most likely
// took 3), and for a gain at what it actually holds.
export function splitPrefillQty({ gain, remaining, onBooks = null }) {
  let q = Math.max(0, Number(remaining) || 0)
  if (onBooks != null) {
    if (!gain && onBooks < 0) q = Math.min(q, -onBooks)
    if (gain && onBooks > 0) q = Math.min(q, onBooks)
  }
  return roundQty(q)
}
