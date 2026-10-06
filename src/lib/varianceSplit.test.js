import { describe, it, expect } from 'vitest'
import { splitStatus, splitPrefillQty } from './varianceSplit'

describe('splitStatus', () => {
  it('the owner case: −16, 3 + 1 assigned → 12 left', () => {
    expect(splitStatus(-16, [{ locationId: 'jaco', qty: '3' }, { locationId: 'taryn', qty: 1 }]))
      .toEqual({ qty: 16, good: [{ locationId: 'jaco', qty: 3 }, { locationId: 'taryn', qty: 1 }], total: 4, incomplete: false, over: false, remainder: 12 })
  })

  it('a line without a location or a positive qty is incomplete, not dropped', () => {
    expect(splitStatus(-5, [{ locationId: '', qty: '2' }]).incomplete).toBe(true)
    expect(splitStatus(-5, [{ locationId: 'a', qty: '' }]).incomplete).toBe(true)
    expect(splitStatus(-5, [{ locationId: 'a', qty: '0' }]).incomplete).toBe(true)
  })

  it('flags lines that add up to more than the difference', () => {
    expect(splitStatus(2, [{ locationId: 'a', qty: 3 }])).toMatchObject({ over: true, remainder: 0 })
    // A recount that matches the books (diff 0) with lines still listed.
    expect(splitStatus(0, [{ locationId: 'a', qty: 1 }])).toMatchObject({ over: true })
  })

  it('decimals add up exactly', () => {
    expect(splitStatus(-0.3, [{ locationId: 'a', qty: 0.1 }, { locationId: 'b', qty: 0.2 }])).toMatchObject({ over: false, remainder: 0 })
  })

  it('unknown diff → no over / remainder yet', () => {
    expect(splitStatus(null, [{ locationId: 'a', qty: 1 }])).toMatchObject({ qty: null, over: false, remainder: null })
  })
})

describe('splitPrefillQty', () => {
  it('loss: capped at how far negative the location is', () => {
    expect(splitPrefillQty({ gain: false, remaining: 16, onBooks: -3 })).toBe(3)
    expect(splitPrefillQty({ gain: false, remaining: 2, onBooks: -3 })).toBe(2)
  })
  it('loss into a location with positive stock: the whole remainder', () => {
    expect(splitPrefillQty({ gain: false, remaining: 12, onBooks: 3 })).toBe(12)
  })
  it('gain: capped at what the location holds', () => {
    expect(splitPrefillQty({ gain: true, remaining: 10, onBooks: 4 })).toBe(4)
    expect(splitPrefillQty({ gain: true, remaining: 10, onBooks: -2 })).toBe(10)
  })
  it('nothing left → 0', () => {
    expect(splitPrefillQty({ gain: false, remaining: 0, onBooks: -3 })).toBe(0)
  })
})
