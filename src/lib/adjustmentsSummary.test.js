import { describe, it, expect } from 'vitest'
import {
  adjustmentSource, toAdjustRows, filterBySources, summarizeByLocation,
  summarizeByArea, summarizeByPart, totals, fmtSigned, DEFAULT_SOURCES,
} from './adjustmentsSummary'

const WH = { id: 'wh', name: 'Main', type: 'warehouse', parent_location_id: null }
const B1 = { id: 'b1', name: 'Aisle 1 c1', type: 'bin', parent_location_id: 'wh' }
const B2 = { id: 'b2', name: 'Aisle 1 b2', type: 'bin', parent_location_id: 'wh' }
const T1 = { id: 't1', name: "Owen's Truck", type: 'truck', parent_location_id: null }
const locById = new Map([WH, B1, B2, T1].map(l => [l.id, l]))

let seq = 0
function adj({ part = 'P1', up = null, down = null, qty = 1, notes = '', run = null, at = '2026-09-30T10:00:00Z' }) {
  seq += 1
  return {
    id: 'm' + seq, movement_type: 'adjust', part_id: part, quantity: qty, notes, count_run_id: run,
    to_location_id: up, from_location_id: down, created_at: at, part: { id: part, name: part + ' name', unit: 'ea' },
  }
}

describe('adjustmentSource', () => {
  it('classifies by count_run_id before notes', () => {
    expect(adjustmentSource({ count_run_id: 'r', notes: 'Reconcile x' })).toBe('count_run')
  })
  it('classifies each flow by its fixed note prefix', () => {
    expect(adjustmentSource({ notes: 'Reconcile 2026-09-30 — counted 3, system had 5' })).toBe('reconcile')
    expect(adjustmentSource({ notes: 'Spot count 2026-09-30 — counted 3, system had 5' })).toBe('spot_count')
    expect(adjustmentSource({ notes: 'Converted to refurbished: A → A-R' })).toBe('refurb')
    expect(adjustmentSource({ notes: 'whatever', purchase_request_line_id: 'x' })).toBe('receipt_reversal')
    expect(adjustmentSource({ notes: null })).toBe('other')
  })
  it('leaves refurb conversions out of the default sources', () => {
    expect(DEFAULT_SOURCES).not.toContain('refurb')
    expect(DEFAULT_SOURCES).toContain('count_run')
  })
})

describe('toAdjustRows', () => {
  it('signs by direction and rolls bins up into their warehouse', () => {
    const rows = toAdjustRows([adj({ up: 'b1', qty: 5 }), adj({ down: 't1', qty: 2 })], locById)
    expect(rows[0]).toMatchObject({ signed: 5, locId: 'b1', areaId: 'wh', areaName: 'Main' })
    expect(rows[1]).toMatchObject({ signed: -2, locId: 't1', areaId: 't1' })
  })
  it('labels warehouse-level stock as unbinned and skips non-adjusts', () => {
    const rows = toAdjustRows([adj({ up: 'wh' }), { ...adj({ up: 'b1' }), movement_type: 'transfer' }], locById)
    expect(rows).toHaveLength(1)
    expect(rows[0].locName).toBe('Main (unbinned)')
  })
  it('coerces string quantities (numeric columns arrive as strings)', () => {
    const rows = toAdjustRows([adj({ down: 'b1', qty: '1054.0' })], locById)
    expect(rows[0].signed).toBe(-1054)
  })
})

describe('summaries', () => {
  const rows = toAdjustRows([
    adj({ part: 'P1', down: 'b1', qty: 44 }),
    adj({ part: 'P1', up: 'b2', qty: 40 }),
    adj({ part: 'P1', up: 'b2', qty: 75 }),
    adj({ part: 'P2', up: 't1', qty: 3 }),
    adj({ part: 'P3', up: 't1', qty: 2, notes: 'Converted to refurbished: P3 → P3-R' }),
  ], locById)

  it('counts lines and qty up vs down per location', () => {
    const byLoc = summarizeByLocation(rows)
    const b2 = byLoc.find(l => l.locId === 'b2')
    expect(b2).toMatchObject({ upLines: 2, upQty: 115, downLines: 0 })
    expect(byLoc[0].areaType).toBe('warehouse')  // warehouse bins before trucks
  })

  it('rolls bins into one warehouse area', () => {
    const areas = summarizeByArea(rows)
    const main = areas.find(a => a.areaId === 'wh')
    expect(main).toMatchObject({ upLines: 2, downLines: 1, locationCount: 2 })
  })

  it('flags a part that went down in one place and up in another', () => {
    const parts = summarizeByPart(rows)
    const p1 = parts.find(p => p.partId === 'P1')
    expect(p1).toMatchObject({ upAndDown: true, net: 71, repeats: 1 })
    expect(parts[0].partId).toBe('P1')  // flagged parts sort first
    expect(parts.find(p => p.partId === 'P2').upAndDown).toBe(false)
  })

  it('a recount that cancels nets to zero at that location', () => {
    const r = toAdjustRows([adj({ part: 'P9', up: 'b1', qty: 6 }), adj({ part: 'P9', down: 'b1', qty: 6 })], locById)
    const p = summarizeByPart(r)[0]
    expect(p.locations[0]).toMatchObject({ net: 0, lines: 2 })
    expect(p.upAndDown).toBe(false)
  })

  it('source filter drops refurb conversions by default', () => {
    const kept = filterBySources(rows, DEFAULT_SOURCES)
    expect(kept).toHaveLength(4)
    expect(totals(kept)).toMatchObject({ upLines: 3, downLines: 1, parts: 2, locations: 3 })
  })
})

describe('fmtSigned', () => {
  it('formats with a real minus and trims float noise', () => {
    expect(fmtSigned(12)).toBe('+12')
    expect(fmtSigned(-4)).toBe('−4')
    expect(fmtSigned(0.1 + 0.2 - 0.3)).toBe('0')
  })
})
