// Shared presentation logic for an inventory_movements row.
//
// This lived inline in InventoryMovementsTab.jsx and was already duplicated
// *within that one file* — the feed and its CSV builder each re-derived adjust
// direction, and the two disagreed about which columns to read (see
// endpointIds below). Adding a third copy for the part-history panel is how
// that drift becomes permanent, so the derivation moved here where it can be
// tested. Purely presentational: no db import, no state.

// ─── Movement-type accents ───────────────────────────────────────────────────

// Receive/issue are the in/out pair; the rest keep distinct hues so the
// activity feed is scannable at a glance.
export const TYPE_COLORS = {
  receive:  { bg: 'var(--teal-lt)',   text: 'var(--accent-dk)', icon: 'download' },
  transfer: { bg: 'var(--blue-lt)',   text: 'var(--blue)',      icon: 'move' },
  return:   { bg: 'var(--purple-lt)', text: 'var(--purple)',    icon: 'rotate' },
  issue:    { bg: 'var(--amber-lt)',  text: 'var(--amber)',     icon: 'upload' },
  scrap:    { bg: 'var(--red-lt)',    text: 'var(--red)',       icon: 'x' },
  adjust:   { bg: 'var(--gray-lt)',   text: 'var(--muted)',     icon: 'sliders' },
}

export const TYPE_LABELS = {
  receive:  'Receive',
  transfer: 'Transfer',
  return:   'Return',
  issue:    'Issue',
  scrap:    'Scrap',
  adjust:   'Adjust',
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

// Resolve a movement's endpoints from EITHER the scalar FK columns or the
// joined location objects.
//
// This is load-bearing, not defensive padding. getRecentMovements selects `*`
// so its rows carry from_location_id/to_location_id; getMovementsForActivityExport
// selects an explicit column list that includes the JOINS but NOT those two
// scalars. Read only the scalars and every exported adjust looks like an
// "adjust up" with a positive quantity — silently breaking the SUM in the one
// full-history export the business has. Read only the joins and a row whose
// location was hard-deleted loses its direction. Take whichever is present.
function endpointIds(m) {
  return {
    fromId: m?.from_location_id ?? m?.from_location?.id ?? null,
    toId:   m?.to_location_id   ?? m?.to_location?.id   ?? null,
  }
}

// ─── Row display ─────────────────────────────────────────────────────────────

// Everything a movement row needs to render, derived once.
//
// fromName/toName come back as null (not '') when there's nothing to show —
// the feed renders them conditionally, the CSV coalesces to ''.
export function movementDisplay(m) {
  const type = m?.movement_type
  const base = TYPE_COLORS[type] || TYPE_COLORS.adjust
  const { fromId, toId } = endpointIds(m)

  // Adjust has two directions: positive (to only, adds stock) and negative
  // (from only, removes stock). Surface that visually — an unsigned adjust
  // reads as a receipt.
  const isAdjust     = type === 'adjust'
  const isAdjustUp   = isAdjust && !fromId && !!toId
  const isAdjustDown = isAdjust && !!fromId && !toId

  const colors = isAdjustUp
    ? { bg: 'var(--teal-lt)', text: 'var(--accent-dk)', icon: 'plus' }
    : isAdjustDown
    ? { bg: 'var(--red-lt)',  text: 'var(--red)',       icon: 'x' }
    : base

  return {
    colors,
    isAdjustUp,
    isAdjustDown,
    label: isAdjustUp ? 'Adjust up' : isAdjustDown ? 'Adjust down' : (TYPE_LABELS[type] || type || 'Movement'),
    sign: isAdjustDown ? -1 : 1,
    qtyPrefix: isAdjustUp ? '+' : isAdjustDown ? '−' : '',
    qtyColor: isAdjustUp ? 'var(--accent-dk)' : isAdjustDown ? 'var(--red)' : 'var(--text)',
    // A receive has no source location (it comes from outside the system) and
    // issue/scrap have no destination (the stock is gone). The receive's
    // "source" is its receipt_kind — a field return did not come from a vendor.
    fromName: m?.from_location?.name || (type === 'receive' ? receiveSourceName(m) : null),
    receiptKind: type === 'receive' ? (m?.receipt_kind || 'purchase') : null,
    toName:   m?.to_location?.name   || (type === 'issue' || type === 'scrap' ? 'Consumed' : null),
  }
}

// Where a receive "came from", by receipt_kind. Rows that predate the column
// are NULL only in theory (the migration backfilled every receive) but the
// trigger default is 'purchase', so treat missing as purchase.
export const RECEIPT_KIND_SOURCE = {
  purchase:     'Vendor',
  field_return: 'Field return',
  found:        'Found',
  decommission: 'Site decommission',
  seed:         'Seed',
}
export const RECEIPT_KIND_LABEL = {
  purchase:     'Purchase',
  field_return: 'Field return',
  found:        'Found',
  decommission: 'Decommission',
  seed:         'Seed',
}
export function receiveSourceName(m) {
  return RECEIPT_KIND_SOURCE[m?.receipt_kind] || RECEIPT_KIND_SOURCE.purchase
}

// Quantity signed for arithmetic: adjust-down is negative, everything else
// positive. The Activity CSV's SUM depends on this.
export function signedQty(m) {
  const n = Number(m?.quantity)
  if (!Number.isFinite(n)) return 0
  return movementDisplay(m).isAdjustDown ? -Math.abs(n) : n
}

// ─── Receive metadata ────────────────────────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clean(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || null
}

// Pull the vendor / reference / cost out of a receive movement.
//
// Two writers record this with MUTUALLY INVERTED conventions:
//   ReceivePOSheet:             vendor_invoice = PO/invoice ref, notes = "Vendor: X"
//   receivePurchaseRequestLine: vendor_invoice = vendor NAME,    notes = "Received from PR-####"
// and hand entry puts free prose in vendor_invoice (one live row holds
// 'moving from drop cable 1500" to preconnectorized'). So a raw
// `Invoice: {vendor_invoice}` label — what the Activity feed used to print —
// is wrong for two of the three shapes.
//
// `source` tells the caller which shape it got so labels stay honest.
// `notesConsumed` says the whole notes string was just the vendor/PR marker we
// already extracted — callers that also render raw notes must skip them then,
// or the vendor prints twice on every PO receive.
//
// Returns { vendor, reference, unitCost, source, notesConsumed }.
export function resolveReceiveMeta(m) {
  const unitCost = num(m?.unit_cost)
  // Only receives carry this metadata; a transfer whose notes happen to
  // mention a vendor must not be read as a receipt.
  if (m?.movement_type !== 'receive') {
    return { vendor: null, reference: null, unitCost, source: 'none', notesConsumed: false }
  }

  const notes = typeof m?.notes === 'string' ? m.notes : ''
  const invoice = clean(m?.vendor_invoice)

  // Shape 0 — field return (receipt_kind column, Aug 2026). No vendor by
  // definition; "Returned from: X" names the customer/site/tech and the
  // optional vendor_invoice holds a ticket/RMA ref. Checked first so a
  // customer name never gets parsed as a vendor below.
  if (m?.receipt_kind === 'field_return') {
    const rf = notes.match(/Returned from:\s*([^|·\n]+)/i)
    return {
      vendor: null,
      returnedFrom: rf ? clean(rf[1]) : null,
      reference: invoice,
      unitCost,
      source: 'field_return',
      notesConsumed: !!rf && /^Returned from:\s*[^|·\n]+$/i.test(notes.trim()),
    }
  }

  // Shape 1 — ReceivePOSheet. Stop the vendor at the first separator so
  // "Vendor: Graybar · PO 88" doesn't swallow the tail (same shape the Sage
  // export's VENDORID parse expects).
  const poMatch = notes.match(/Vendor:\s*([^|·\n]+)/i)
  if (poMatch) {
    const vendor = clean(poMatch[1])
    // One live row carries the vendor name in BOTH columns — printing it
    // again as a reference would read as an invoice number that isn't one.
    const dupe = vendor && invoice && vendor.toLowerCase() === invoice.toLowerCase()
    return {
      vendor,
      reference: dupe ? null : invoice,
      unitCost,
      source: 'po',
      notesConsumed: /^Vendor:\s*[^|·\n]+$/i.test(notes.trim()),
    }
  }

  // Shape 2 — receivePurchaseRequestLine. The PR number is the reference and
  // vendor_invoice holds the vendor name, the exact inverse of shape 1.
  const prMatch = notes.match(/Received from\s+(PR-[\w-]+)/i)
  if (prMatch) {
    return {
      vendor: invoice,
      reference: prMatch[1],
      unitCost,
      source: 'pr',
      notesConsumed: /^Received from\s+PR-[\w-]+$/i.test(notes.trim()),
    }
  }

  // Shape 3 — free text in vendor_invoice. Show it, but never label it as an
  // invoice number.
  if (invoice) return { vendor: null, reference: invoice, unitCost, source: 'freeform', notesConsumed: false }

  return { vendor: null, reference: null, unitCost, source: 'none', notesConsumed: false }
}
