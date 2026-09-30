// Unit tests for lib/refurbConvert.js — the new → refurbished-twin stock
// conversion. Money path: a half-booked pair would destroy or mint stock.
import { describe, it, expect } from 'vitest'
import { buildRefurbConversionPayloads, isRefurbConversion, refurbConversionPairId } from './refurbConvert'
import { isExportableMovement, validateMovement } from './inventory'
import { movementDisplay, signedQty } from './movementDisplay'

const parent = { id: 'WAVE-LR', unit: 'ea', refurb_of: null }
const twin = { id: 'WAVE-LR-R', unit: 'ea', refurb_of: 'WAVE-LR' }
const base = { parent, twin, locationId: 'bin1', quantity: 3, onHand: 5, pairId: 'p1', createdBy: 'u1' }

describe('buildRefurbConversionPayloads', () => {
  it('books parent −N and twin +N at the same location', () => {
    const [down, up] = buildRefurbConversionPayloads(base)
    expect(down).toMatchObject({ movement_type: 'adjust', part_id: 'WAVE-LR', quantity: 3, from_location_id: 'bin1', to_location_id: null, created_by: 'u1' })
    expect(up).toMatchObject({ movement_type: 'adjust', part_id: 'WAVE-LR-R', quantity: 3, from_location_id: null, to_location_id: 'bin1', created_by: 'u1' })
    // Both halves pass the same endpoint check the DB CHECK enforces.
    expect(() => validateMovement(down)).not.toThrow()
    expect(() => validateMovement(up)).not.toThrow()
    // Net stock at the location is unchanged; only the SKU moved.
    expect(signedQty(down) + signedQty(up)).toBe(0)
  })

  it('links the two halves with the same marker and keeps the reason', () => {
    const [down, up] = buildRefurbConversionPayloads({ ...base, reason: ' bench-tested used ' })
    expect(down.notes).toBe(up.notes)
    expect(down.notes).toContain('WAVE-LR → WAVE-LR-R')
    expect(down.notes).toContain('bench-tested used')
    expect(refurbConversionPairId(down)).toBe('p1')
    expect(isRefurbConversion(down)).toBe(true)
    expect(isRefurbConversion(up)).toBe(true)
  })

  it('never exports to Sage (internal only)', () => {
    for (const m of buildRefurbConversionPayloads(base)) {
      expect(isExportableMovement({ ...m, from_location: m.from_location_id ? { id: 'bin1', type: 'bin' } : null, to_location: m.to_location_id ? { id: 'bin1', type: 'bin' } : null })).toBe(false)
    }
  })

  it('blocks converting more than is on hand', () => {
    expect(() => buildRefurbConversionPayloads({ ...base, quantity: 6 })).toThrow(/Only 5/)
    expect(() => buildRefurbConversionPayloads({ ...base, onHand: undefined })).toThrow(/Only 0/)
  })

  it('rejects zero, negative and fractional each-quantities', () => {
    expect(() => buildRefurbConversionPayloads({ ...base, quantity: 0 })).toThrow()
    expect(() => buildRefurbConversionPayloads({ ...base, quantity: -1 })).toThrow()
    expect(() => buildRefurbConversionPayloads({ ...base, quantity: 1.5 })).toThrow(/whole/)
    // Non-each units may be fractional.
    const ft = { ...base, parent: { ...parent, unit: 'ft' }, twin: { ...twin, unit: 'ft' }, quantity: 1.5 }
    expect(() => buildRefurbConversionPayloads(ft)).not.toThrow()
  })

  it('refuses a twin that belongs to another part, or a refurb as the source', () => {
    expect(() => buildRefurbConversionPayloads({ ...base, twin: { ...twin, refurb_of: 'OTHER' } })).toThrow(/not the refurbished twin/)
    expect(() => buildRefurbConversionPayloads({ ...base, twin: null })).toThrow(/no refurbished twin/)
    expect(() => buildRefurbConversionPayloads({ ...base, parent: { ...parent, refurb_of: 'X' } })).toThrow(/already a refurbished/)
  })

  it('requires a location and a signed-in user', () => {
    expect(() => buildRefurbConversionPayloads({ ...base, locationId: null })).toThrow()
    expect(() => buildRefurbConversionPayloads({ ...base, createdBy: null })).toThrow()
  })
})

describe('movementDisplay for conversions', () => {
  it('labels the halves without changing adjust arithmetic', () => {
    const [down, up] = buildRefurbConversionPayloads(base)
    const d = movementDisplay(down)
    const u = movementDisplay(up)
    expect(d.label).toBe('To refurb')
    expect(d.isAdjustDown).toBe(true)
    expect(d.sign).toBe(-1)
    expect(u.label).toBe('From new')
    expect(u.isAdjustUp).toBe(true)
    // A plain adjust is untouched.
    expect(movementDisplay({ movement_type: 'adjust', from_location_id: 'b', notes: 'count fix' }).label).toBe('Adjust down')
    // The marker only means something on an adjust.
    expect(isRefurbConversion({ movement_type: 'transfer', notes: '[refurb_convert:x]' })).toBe(false)
  })
})
