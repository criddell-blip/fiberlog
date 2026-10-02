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
})
