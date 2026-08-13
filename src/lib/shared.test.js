// Unit tests for lib/shared.js — the two pure helpers extracted from the
// crew components. Both sit on money paths: mergePartsById builds the final
// parts list on TaskWorkspace submit (what actually gets logged + deducted),
// matchesAllTokens is the part-picker filter in CrewMovementSheet load/return.
import { describe, it, expect } from 'vitest'
import { mergePartsById, matchesAllTokens } from './shared'

describe('mergePartsById', () => {
  it('returns [] for an empty list', () => {
    expect(mergePartsById([])).toEqual([])
  })

  it('passes through distinct parts unchanged', () => {
    const list = [
      { id: 'A', name: 'Part A', unit: 'ea', qty: 2 },
      { id: 'B', name: 'Part B', unit: 'ft', qty: 100 },
    ]
    expect(mergePartsById(list)).toEqual(list)
  })

  it('sums quantities for duplicate ids', () => {
    const out = mergePartsById([
      { id: 'A', name: 'Part A', unit: 'ea', qty: 2 },
      { id: 'A', name: 'Part A', unit: 'ea', qty: 3 },
      { id: 'A', name: 'Part A', unit: 'ea', qty: 5 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].qty).toBe(10)
  })

  it('keeps the first occurrence\'s fields (isExtra etc.) when merging', () => {
    // TaskWorkspace merges [...assemblyParts, ...footageParts, ...extraParts];
    // a later duplicate must not clobber flags from the first-seen entry.
    const out = mergePartsById([
      { id: 'A', name: 'Part A', unit: 'ea', qty: 1, isExtra: true },
      { id: 'A', name: 'Part A (dup)', unit: 'ea', qty: 4 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].isExtra).toBe(true)
    expect(out[0].name).toBe('Part A')
    expect(out[0].qty).toBe(5)
  })

  it('skips null entries and entries without an id', () => {
    const out = mergePartsById([
      null,
      undefined,
      { name: 'no id', qty: 5 },
      { id: 'A', qty: 1 },
    ])
    expect(out).toEqual([{ id: 'A', qty: 1 }])
  })

  it('treats missing qty as 0 when summing', () => {
    const out = mergePartsById([
      { id: 'A', qty: 2 },
      { id: 'A' }, // no qty
    ])
    expect(out[0].qty).toBe(2)
  })

  it('drops parts whose merged qty is 0 or negative', () => {
    const out = mergePartsById([
      { id: 'A', qty: 0 },
      { id: 'B', qty: 3 },
      { id: 'B', qty: -3 },
      { id: 'C', qty: -1 },
      { id: 'D', qty: 1 },
    ])
    expect(out.map(p => p.id)).toEqual(['D'])
  })

  // ── per-line source truck (Aug 2026) ──────────────────────────────────────
  it('keeps the same SKU from two different trucks as two lines', () => {
    const out = mergePartsById([
      { id: 'A', qty: 2 },                              // my truck
      { id: 'A', qty: 3, sourceLocationId: 'truck-f' }, // Francisco's
    ])
    expect(out).toHaveLength(2)
    expect(out.find(p => !p.sourceLocationId).qty).toBe(2)
    expect(out.find(p => p.sourceLocationId === 'truck-f').qty).toBe(3)
  })

  it('sums duplicates within the same source', () => {
    const out = mergePartsById([
      { id: 'A', qty: 2, sourceLocationId: 'truck-f' },
      { id: 'A', qty: 3, sourceLocationId: 'truck-f' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].qty).toBe(5)
    expect(out[0].sourceLocationId).toBe('truck-f')
  })

  it('treats null/undefined/absent source as the same ("my truck") line', () => {
    const out = mergePartsById([
      { id: 'A', qty: 1 },
      { id: 'A', qty: 2, sourceLocationId: null },
      { id: 'A', qty: 3, sourceLocationId: undefined },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].qty).toBe(6)
  })

  it('drops a zero-sum source line without touching the other source', () => {
    const out = mergePartsById([
      { id: 'A', qty: 2, sourceLocationId: 'truck-f' },
      { id: 'A', qty: -2, sourceLocationId: 'truck-f' },
      { id: 'A', qty: 5 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].qty).toBe(5)
    expect(out[0].sourceLocationId).toBeUndefined()
  })
})

describe('matchesAllTokens', () => {
  const FIELDS = ['Lag Bolts, 1/2 x 4 (Box of 50)', 'LB-12X4-BOX']

  it('matches when every token appears somewhere (AND semantics)', () => {
    expect(matchesAllTokens('lag bolt box', FIELDS)).toBe(true)
  })

  it('fails when any single token is missing', () => {
    expect(matchesAllTokens('lag bolt pallet', FIELDS)).toBe(false)
  })

  it('is case-insensitive both ways', () => {
    expect(matchesAllTokens('LAG bOlTs', FIELDS)).toBe(true)
    expect(matchesAllTokens('lb-12x4', FIELDS)).toBe(true)
  })

  it('lets tokens match across different fields (name + SKU)', () => {
    // 'lag' only in name, 'lb-12x4' only in SKU — deliberate asymmetry vs
    // the server-side search, documented in the helper.
    expect(matchesAllTokens('lag lb-12x4', FIELDS)).toBe(true)
  })

  it('ignores null/undefined/empty fields in the haystack', () => {
    expect(matchesAllTokens('lag', [null, undefined, '', 'Lag Bolts'])).toBe(true)
    expect(matchesAllTokens('lag', [null, undefined, ''])).toBe(false)
  })

  it('matches everything on an empty or whitespace-only query', () => {
    expect(matchesAllTokens('', FIELDS)).toBe(true)
    expect(matchesAllTokens('   ', FIELDS)).toBe(true)
  })

  it('collapses repeated whitespace between tokens', () => {
    expect(matchesAllTokens('  lag   bolt  ', FIELDS)).toBe(true)
  })
})
