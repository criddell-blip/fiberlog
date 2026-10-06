import { describe, it, expect } from 'vitest'
import { previewResolution } from './cycleCount'

describe('previewResolution (mirrors resolve_count_resolution)', () => {
  it('no recount → the counted variance as an adjust', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 5 })).toEqual({ diff: 5, action: 'adjust', qty: 5 })
    expect(previewResolution({ resolutionType: 'net_loss', quantity: '3' })).toEqual({ diff: -3, action: 'adjust', qty: 3 })
  })

  it('recount compares against the books NOW, not the original variance', () => {
    // Counted a loss of 5, but on recount the bin has 12 and the books say 10.
    expect(previewResolution({ resolutionType: 'net_loss', quantity: 5, countedNow: 12, systemNow: 10 }))
      .toEqual({ diff: 2, action: 'adjust', qty: 2 })
  })

  it('a recount that matches the books posts nothing', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 7, countedNow: '10', systemNow: 10 }))
      .toEqual({ diff: 0, action: 'none' })
  })

  it('treats a recount of 0 as a real recount, not "no recount"', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 7, countedNow: 0, systemNow: 4 }))
      .toEqual({ diff: -4, action: 'adjust', qty: 4 })
  })

  it('counter location turns it into a transfer in the right direction', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 4, counterLocationId: 'truck' }))
      .toMatchObject({ action: 'transfer', direction: 'from_counter', qty: 4 })
    expect(previewResolution({ resolutionType: 'net_loss', quantity: 4, counterLocationId: 'truck' }))
      .toMatchObject({ action: 'transfer', direction: 'to_counter', qty: 4 })
  })

  it('waits for the books before previewing a recount', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 1, countedNow: 3, systemNow: null })).toBeNull()
  })

  it('splits book a transfer each and adjust the remainder', () => {
    // The owner's case: −16 at the bin, 3 went to one truck, 1 to another.
    expect(previewResolution({ resolutionType: 'net_loss', quantity: 16, splits: [{ locationId: 'jaco', qty: 3 }, { locationId: 'taryn', qty: '1' }] }))
      .toEqual({ diff: -16, action: 'split', qty: 16, splitTotal: 4, remainder: 12, over: false, direction: 'to_counter' })
  })

  it('splits that cover the whole difference leave no adjust', () => {
    expect(previewResolution({ resolutionType: 'net_gain', quantity: 4, splits: [{ locationId: 'a', qty: 1 }, { locationId: 'b', qty: 3 }] }))
      .toMatchObject({ action: 'split', remainder: 0, over: false, direction: 'from_counter' })
  })

  it('flags splits that add up to more than the difference', () => {
    expect(previewResolution({ resolutionType: 'net_loss', quantity: 2, splits: [{ locationId: 'a', qty: 3 }] }))
      .toMatchObject({ over: true, remainder: 0 })
  })

  it('splits follow the recount, not the original variance', () => {
    expect(previewResolution({ resolutionType: 'net_loss', quantity: 16, countedNow: 6, systemNow: 10, splits: [{ locationId: 'a', qty: 3 }] }))
      .toMatchObject({ diff: -4, qty: 4, remainder: 1 })
  })
})
