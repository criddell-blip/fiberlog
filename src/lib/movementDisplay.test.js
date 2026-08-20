// Unit tests for lib/movementDisplay.js — the shared derivation behind the
// Activity feed, the Activity CSV export, and the part-history panel.
//
// Two things here are money paths, not cosmetics:
//   • signedQty decides the sign of every adjust in the Activity CSV, which is
//     the only route full movement history takes out of the app and gets
//     SUMmed in a spreadsheet.
//   • resolveReceiveMeta decides which string is the vendor and which is the
//     reference, across two writers that record them in opposite columns.
import { describe, it, expect } from 'vitest'
import { movementDisplay, signedQty, resolveReceiveMeta, TYPE_LABELS } from './movementDisplay'

// ─── movementDisplay ─────────────────────────────────────────────────────────

describe('movementDisplay', () => {
  it('labels a receive and calls its missing source "Vendor"', () => {
    const d = movementDisplay({ movement_type: 'receive', to_location_id: 'w1' })
    expect(d.label).toBe('Receive')
    expect(d.fromName).toBe('Vendor')
    expect(d.toName).toBeNull()
    expect(d.sign).toBe(1)
    expect(d.qtyPrefix).toBe('')
  })

  // receipt_kind decides the receive's "source": a field return did not come
  // from a vendor, and the Activity feed must not say it did.
  it('names the receive source by receipt_kind (purchase default)', () => {
    expect(movementDisplay({ movement_type: 'receive', receipt_kind: 'purchase' }).fromName).toBe('Vendor')
    expect(movementDisplay({ movement_type: 'receive', receipt_kind: 'field_return' }).fromName).toBe('Field return')
    expect(movementDisplay({ movement_type: 'receive', receipt_kind: 'found' }).fromName).toBe('Found')
    expect(movementDisplay({ movement_type: 'receive', receipt_kind: 'field_return' }).receiptKind).toBe('field_return')
    expect(movementDisplay({ movement_type: 'receive' }).receiptKind).toBe('purchase')
    expect(movementDisplay({ movement_type: 'transfer', receipt_kind: 'purchase' }).receiptKind).toBeNull()
  })

  it('resolveReceiveMeta reads "Returned from:" on field returns and never as a vendor', () => {
    const m = resolveReceiveMeta({ movement_type: 'receive', receipt_kind: 'field_return', notes: 'Returned from: 123 Main St — J. Smith', vendor_invoice: 'TKT-48213' })
    expect(m.source).toBe('field_return')
    expect(m.vendor).toBeNull()
    expect(m.returnedFrom).toBe('123 Main St — J. Smith')
    expect(m.reference).toBe('TKT-48213')
    expect(m.notesConsumed).toBe(true)
  })

  it('calls a missing destination "Consumed" for issue and scrap only', () => {
    expect(movementDisplay({ movement_type: 'issue', from_location_id: 't1' }).toName).toBe('Consumed')
    expect(movementDisplay({ movement_type: 'scrap', from_location_id: 't1' }).toName).toBe('Consumed')
    expect(movementDisplay({ movement_type: 'transfer', from_location_id: 't1' }).toName).toBeNull()
  })

  it('prefers the joined location name when present', () => {
    const d = movementDisplay({
      movement_type: 'transfer',
      from_location: { id: 'a', name: "Cody's truck" },
      to_location: { id: 'b', name: 'Heber' },
    })
    expect(d.fromName).toBe("Cody's truck")
    expect(d.toName).toBe('Heber')
  })

  it('reads adjust direction from the scalar FK columns', () => {
    const up = movementDisplay({ movement_type: 'adjust', to_location_id: 'w1' })
    expect(up.isAdjustUp).toBe(true)
    expect(up.label).toBe('Adjust up')
    expect(up.qtyPrefix).toBe('+')
    expect(up.sign).toBe(1)

    const down = movementDisplay({ movement_type: 'adjust', from_location_id: 'w1' })
    expect(down.isAdjustDown).toBe(true)
    expect(down.label).toBe('Adjust down')
    expect(down.qtyPrefix).toBe('−')
    expect(down.sign).toBe(-1)
  })

  // THE regression guard. getMovementsForActivityExport selects the joined
  // location objects but NOT the scalar from_location_id/to_location_id
  // columns. A derivation that only reads the scalars classifies every
  // exported adjust-down as an "adjust up" with a positive quantity.
  it('reads adjust direction from the joined objects when the scalars are absent', () => {
    const down = movementDisplay({ movement_type: 'adjust', from_location: { id: 'w1', name: 'Warehouse' } })
    expect(down.isAdjustDown).toBe(true)
    expect(down.label).toBe('Adjust down')

    const up = movementDisplay({ movement_type: 'adjust', to_location: { id: 'w1', name: 'Warehouse' } })
    expect(up.isAdjustUp).toBe(true)
    expect(up.label).toBe('Adjust up')
  })

  it('falls back to the adjust palette for an unknown type without throwing', () => {
    const d = movementDisplay({ movement_type: 'teleport' })
    expect(d.colors).toBeTruthy()
    expect(d.label).toBe('teleport')
  })

  it('exposes a label for every movement_type the DB CHECK allows', () => {
    for (const t of ['receive', 'transfer', 'return', 'issue', 'scrap', 'adjust']) {
      expect(TYPE_LABELS[t]).toBeTruthy()
    }
  })
})

// ─── signedQty ───────────────────────────────────────────────────────────────

describe('signedQty', () => {
  it('negates adjust-down so a spreadsheet SUM nets out', () => {
    expect(signedQty({ movement_type: 'adjust', from_location_id: 'w1', quantity: 9 })).toBe(-9)
    expect(signedQty({ movement_type: 'adjust', to_location_id: 'w1', quantity: 9 })).toBe(9)
  })

  it('negates adjust-down derived from joined objects too (export shape)', () => {
    expect(signedQty({ movement_type: 'adjust', from_location: { id: 'w1' }, quantity: 4 })).toBe(-4)
  })

  it('leaves every other type positive', () => {
    expect(signedQty({ movement_type: 'transfer', from_location_id: 'a', to_location_id: 'b', quantity: 5 })).toBe(5)
    expect(signedQty({ movement_type: 'receive', to_location_id: 'b', quantity: 60 })).toBe(60)
  })

  it('coerces PostgREST numeric strings and survives garbage', () => {
    expect(signedQty({ movement_type: 'receive', quantity: '60' })).toBe(60)
    expect(signedQty({ movement_type: 'receive', quantity: null })).toBe(0)
    expect(signedQty({ movement_type: 'receive', quantity: 'abc' })).toBe(0)
  })

  it('uses the absolute value so an already-negative adjust-down stays negative', () => {
    expect(signedQty({ movement_type: 'adjust', from_location_id: 'w1', quantity: -9 })).toBe(-9)
  })
})

// ─── resolveReceiveMeta ──────────────────────────────────────────────────────

describe('resolveReceiveMeta', () => {
  const recv = o => ({ movement_type: 'receive', ...o })

  it('reads the ReceivePOSheet shape: vendor in notes, ref in vendor_invoice', () => {
    // Real row, Aug 13 2026.
    const r = resolveReceiveMeta(recv({ vendor_invoice: '4884', notes: 'Vendor: ISP Supplies' }))
    expect(r).toEqual({ vendor: 'ISP Supplies', reference: '4884', unitCost: null, source: 'po', notesConsumed: true })
  })

  it('does not print the vendor twice when both columns hold it', () => {
    // Real row, Aug 5 2026 — someone typed the vendor into the PO ref box.
    const r = resolveReceiveMeta(recv({ vendor_invoice: 'Cisco new part skus', notes: 'Vendor: Cisco new part skus' }))
    expect(r.vendor).toBe('Cisco new part skus')
    expect(r.reference).toBeNull()
  })

  it('dedupes case-insensitively and ignores surrounding whitespace', () => {
    const r = resolveReceiveMeta(recv({ vendor_invoice: '  graybar ', notes: 'Vendor:  Graybar  ' }))
    expect(r.vendor).toBe('Graybar')
    expect(r.reference).toBeNull()
  })

  it('stops the vendor at the first separator', () => {
    expect(resolveReceiveMeta(recv({ notes: 'Vendor: Graybar | inv 123' })).vendor).toBe('Graybar')
    expect(resolveReceiveMeta(recv({ notes: 'Vendor: Graybar · rush order' })).vendor).toBe('Graybar')
  })

  it('treats an empty or whitespace-only vendor_invoice as absent', () => {
    expect(resolveReceiveMeta(recv({ vendor_invoice: '', notes: 'Vendor: ISP Supplies' })).reference).toBeNull()
    expect(resolveReceiveMeta(recv({ vendor_invoice: '   ', notes: 'Vendor: ISP Supplies' })).reference).toBeNull()
    expect(resolveReceiveMeta(recv({ vendor_invoice: null, notes: 'Vendor: ISP Supplies' })).reference).toBeNull()
  })

  it('reads the purchase-request shape, where the columns are inverted', () => {
    const r = resolveReceiveMeta(recv({ vendor_invoice: 'ISP Supplies', notes: 'Received from PR-2026-0044' }))
    expect(r).toEqual({ vendor: 'ISP Supplies', reference: 'PR-2026-0044', unitCost: null, source: 'pr', notesConsumed: true })
  })

  it('keeps only the PR number when a reason is appended', () => {
    const r = resolveReceiveMeta(recv({ vendor_invoice: 'ISP Supplies', notes: 'Received from PR-2026-0044 · West Mountain rebuild' }))
    expect(r.reference).toBe('PR-2026-0044')
    expect(r.vendor).toBe('ISP Supplies')
  })

  it('handles a PR receive with no vendor recorded', () => {
    const r = resolveReceiveMeta(recv({ vendor_invoice: null, notes: 'Received from PR-2026-0044' }))
    expect(r.vendor).toBeNull()
    expect(r.reference).toBe('PR-2026-0044')
  })

  it('passes free prose through as a reference, never as a vendor', () => {
    // Real row, Aug 5 2026 — 47 chars of prose in the PO ref column.
    const prose = 'moving from drop cable 1500" to preconnectorized'
    const r = resolveReceiveMeta(recv({ vendor_invoice: prose, notes: null }))
    expect(r).toEqual({ vendor: null, reference: prose, unitCost: null, source: 'freeform', notesConsumed: false })
  })

  it('resolves nothing when there is nothing to resolve', () => {
    const r = resolveReceiveMeta(recv({ vendor_invoice: null, notes: null }))
    expect(r).toEqual({ vendor: null, reference: null, unitCost: null, source: 'none', notesConsumed: false })
  })

  it('never reads vendor metadata off a non-receive', () => {
    const r = resolveReceiveMeta({ movement_type: 'transfer', vendor_invoice: '4884', notes: 'Vendor: Graybar' })
    expect(r.vendor).toBeNull()
    expect(r.reference).toBeNull()
    expect(r.source).toBe('none')
  })

  // Both renderers print Vendor/Ref from the resolver AND the raw notes
  // underneath. Without this flag a PO receive shows "Vendor: ISP Supplies"
  // twice on every row.
  it('flags notes that were entirely consumed by the parse', () => {
    expect(resolveReceiveMeta(recv({ vendor_invoice: '4884', notes: 'Vendor: ISP Supplies' })).notesConsumed).toBe(true)
    expect(resolveReceiveMeta(recv({ notes: 'Received from PR-2026-0044' })).notesConsumed).toBe(true)
  })

  it('does not flag notes that carry more than the marker', () => {
    // The tail is real information — keep showing the notes line.
    expect(resolveReceiveMeta(recv({ notes: 'Vendor: Graybar · damaged box, 2 short' })).notesConsumed).toBe(false)
    expect(resolveReceiveMeta(recv({ notes: 'Received from PR-2026-0044 · West Mountain rebuild' })).notesConsumed).toBe(false)
    expect(resolveReceiveMeta(recv({ vendor_invoice: 'prose', notes: null })).notesConsumed).toBe(false)
  })

  it('coerces unit_cost, including the PostgREST numeric string', () => {
    expect(resolveReceiveMeta(recv({ unit_cost: '12.40' })).unitCost).toBe(12.4)
    expect(resolveReceiveMeta(recv({ unit_cost: 0 })).unitCost).toBe(0)
    expect(resolveReceiveMeta(recv({ unit_cost: null })).unitCost).toBeNull()
    expect(resolveReceiveMeta(recv({ unit_cost: '' })).unitCost).toBeNull()
    expect(resolveReceiveMeta(recv({ unit_cost: 'abc' })).unitCost).toBeNull()
  })

  it('still reports unit_cost on a non-receive (cost is type-agnostic)', () => {
    expect(resolveReceiveMeta({ movement_type: 'transfer', unit_cost: '3.50' }).unitCost).toBe(3.5)
  })
})
