// Convert new-SKU stock onto its refurbished twin (Sep 2026).
//
// The case: used units sitting on a shelf or truck under the NEW part —
// returned before refurb twins existed, or tested at the bench and found to
// be used. Field returns already land on the twin at receipt (Receive PO →
// Returned from field); this is the after-the-fact correction for stock that
// didn't come in that way.
//
// Booking: a pair of one-sided adjusts at the SAME location — parent −N,
// twin +N — inserted in one statement so they land together or not at all.
// Owner decision: internal only. isExportableMovement drops adjusts, so Sage
// never sees these; accounting does the UB…→UB…_R reclass on their side (the
// Activity CSV carries the pair if they want the list).
//
// Both rows carry `[refurb_convert:<pairId>]` in notes. Notes are immutable,
// so the marker is the permanent link between the two halves and what
// movementDisplay keys its "To refurb" / "From new" labels on.
//
// Pure: no db import, so the money-path shape is unit-tested.

export const REFURB_CONVERT_MARKER = 'refurb_convert'
const MARKER_RE = /\[refurb_convert(?::([\w-]+))?\]/

export function isRefurbConversion(m) {
  return m?.movement_type === 'adjust' && typeof m?.notes === 'string' && MARKER_RE.test(m.notes)
}

export function refurbConversionPairId(m) {
  const hit = typeof m?.notes === 'string' ? m.notes.match(MARKER_RE) : null
  return hit ? (hit[1] || null) : null
}

// Returns [downFromParent, upToTwin]. Throws on anything that would book a
// half-conversion or move stock that isn't there.
export function buildRefurbConversionPayloads({
  parent, twin, locationId, quantity, onHand, reason = '', pairId, createdBy,
}) {
  if (!parent?.id) throw new Error('Pick the part to convert')
  if (!twin?.id) throw new Error(`${parent.id} has no refurbished twin yet`)
  if (twin.refurb_of !== parent.id) throw new Error(`${twin.id} is not the refurbished twin of ${parent.id}`)
  if (parent.refurb_of) throw new Error(`${parent.id} is already a refurbished part`)
  if (!locationId) throw new Error('Pick the location the units are at')
  if (!createdBy) throw new Error('Not signed in')
  if (!pairId) throw new Error('pairId required')

  const qty = Number(quantity)
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than zero')
  // Whole units only for `ea` — you can't refurbish half a router.
  if ((parent.unit || 'ea') === 'ea' && !Number.isInteger(qty)) throw new Error('Quantity must be a whole number')
  const have = Number(onHand)
  // Block rather than warn: converting phantom stock would push the parent
  // negative AND mint refurb units that don't exist.
  if (!Number.isFinite(have) || qty > have) {
    throw new Error(`Only ${Number.isFinite(have) ? have : 0} ${parent.unit || 'ea'} of ${parent.id} on hand here`)
  }

  const note = `Converted to refurbished: ${parent.id} → ${twin.id}`
    + (reason && reason.trim() ? ` · ${reason.trim()}` : '')
    + ` [${REFURB_CONVERT_MARKER}:${pairId}]`

  const common = { movement_type: 'adjust', quantity: qty, notes: note, created_by: createdBy }
  return [
    { ...common, part_id: parent.id, unit: parent.unit || 'ea', from_location_id: locationId, to_location_id: null },
    { ...common, part_id: twin.id,   unit: twin.unit || parent.unit || 'ea', from_location_id: null, to_location_id: locationId },
  ]
}
