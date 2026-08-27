import { describe, it, expect } from 'vitest'
import { deltaAtLocation, byBookingOrderDesc, withRunningBalance } from './runningBalance'

const WH = 'loc-warehouse'
const TRUCK = 'loc-truck'
const REGION = 'loc-region'

// Ledger for one part at the warehouse, in the order it was booked:
//   receive 50 → transfer 12 out → adjust-down 3 → transfer 5 in → transfer 10 out
// Final warehouse on-hand: 50 - 12 - 3 + 5 - 10 = 30.
const LEDGER = [
  { id: 'a', created_at: '2026-08-01T10:00:00Z', movement_type: 'receive',  quantity: '50', from_location_id: null,  to_location_id: WH },
  { id: 'b', created_at: '2026-08-05T10:00:00Z', movement_type: 'transfer', quantity: '12', from_location_id: WH,    to_location_id: TRUCK },
  { id: 'c', created_at: '2026-08-10T10:00:00Z', movement_type: 'adjust',   quantity: '3',  from_location_id: WH,    to_location_id: null },
  { id: 'd', created_at: '2026-08-12T10:00:00Z', movement_type: 'return',   quantity: '5',  from_location_id: TRUCK, to_location_id: WH },
  { id: 'e', created_at: '2026-08-20T10:00:00Z', movement_type: 'transfer', quantity: '10', from_location_id: WH,    to_location_id: REGION },
]

describe('deltaAtLocation', () => {
  it('signs by endpoint, not by the stored quantity sign', () => {
    expect(deltaAtLocation(LEDGER[0], WH)).toBe(50)
    expect(deltaAtLocation(LEDGER[1], WH)).toBe(-12)
    expect(deltaAtLocation(LEDGER[1], TRUCK)).toBe(12)
    // adjust-down: from only, positive magnitude in the row
    expect(deltaAtLocation(LEDGER[2], WH)).toBe(-3)
    // a negative magnitude (should never happen) still resolves by endpoint
    expect(deltaAtLocation({ ...LEDGER[2], quantity: '-3' }, WH)).toBe(-3)
  })

  it('is zero for a location the movement does not touch', () => {
    expect(deltaAtLocation(LEDGER[0], TRUCK)).toBe(0)
    expect(deltaAtLocation(LEDGER[1], REGION)).toBe(0)
    expect(deltaAtLocation(null, WH)).toBe(0)
    expect(deltaAtLocation(LEDGER[1], null)).toBe(0)
  })
})

describe('byBookingOrderDesc', () => {
  it('orders by created_at desc and breaks ties by id', () => {
    const shuffled = [LEDGER[2], LEDGER[4], LEDGER[0], LEDGER[3], LEDGER[1]]
    expect(byBookingOrderDesc(shuffled).map(m => m.id)).toEqual(['e', 'd', 'c', 'b', 'a'])
    const tied = [
      { id: 'x', created_at: '2026-08-01T10:00:00Z' },
      { id: 'z', created_at: '2026-08-01T10:00:00Z' },
      { id: 'y', created_at: '2026-08-01T10:00:00Z' },
    ]
    expect(byBookingOrderDesc(tied).map(m => m.id)).toEqual(['z', 'y', 'x'])
  })

  it('does not mutate the input', () => {
    const input = [LEDGER[0], LEDGER[4]]
    byBookingOrderDesc(input)
    expect(input.map(m => m.id)).toEqual(['a', 'e'])
  })
})

describe('withRunningBalance', () => {
  it('reconstructs before/after backwards from the current on-hand', () => {
    const { rows, driftAtOldest } = withRunningBalance(LEDGER, WH, 30)
    expect(rows.map(r => [r.m.id, r.delta, r.before, r.after])).toEqual([
      ['e', -10, 40, 30],
      ['d',   5, 35, 40],
      ['c',  -3, 38, 35],
      ['b', -12, 50, 38],
      ['a',  50,  0, 50],
    ])
    expect(driftAtOldest).toBe(0)
  })

  it('stays exact when the fetch is capped (anchored on today, not on row 1)', () => {
    // Only the 3 newest rows came back; the warehouse still holds 30.
    const capped = LEDGER.slice(2)
    const { rows, driftAtOldest } = withRunningBalance(capped, WH, 30, { truncated: true })
    expect(rows.map(r => [r.m.id, r.before, r.after])).toEqual([
      ['e', 40, 30],
      ['d', 35, 40],
      ['c', 38, 35],
    ])
    // Oldest visible row's before (38) is not 0 — expected when truncated, so no drift flag.
    expect(driftAtOldest).toBe(0)
  })

  it('flags drift when an uncapped history does not start from zero', () => {
    // Someone edited inventory_stock directly to 33 without a movement.
    const { rows, driftAtOldest } = withRunningBalance(LEDGER, WH, 33)
    expect(rows[rows.length - 1].before).toBe(3)
    expect(driftAtOldest).toBe(3)
  })

  it('walks the same ledger from the truck side', () => {
    // Truck: +12 then -5 → 7 on hand.
    const { rows } = withRunningBalance(LEDGER, TRUCK, 7)
    const touching = rows.filter(r => r.delta !== 0)
    expect(touching.map(r => [r.m.id, r.delta, r.before, r.after])).toEqual([
      ['d', -5, 12, 7],
      ['b', 12,  0, 12],
    ])
  })

  it('handles an empty ledger and a missing current qty', () => {
    expect(withRunningBalance([], WH, undefined)).toEqual({ rows: [], driftAtOldest: 0 })
    expect(withRunningBalance(null, WH, 0)).toEqual({ rows: [], driftAtOldest: 0 })
  })
})
