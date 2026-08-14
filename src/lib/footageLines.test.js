import { describe, it, expect } from 'vitest'
import {
  sumLines, toggleLine, setLineFt, removalLosesWork,
  linesToParts, typeLabel, hasFootageLines, migrateLegacyFootage,
  footageKind, autoPickType,
} from './footageLines'
import { FOOTAGE_TYPE_VALUES, STRAND_SIZES } from './footageTypes'

// The assemblies the app actually flags (verified against the live DB):
// fiber-ft is isFiber, bore-ft/plow-ft are isConduit, strand-ft is isStrand.
// misc-ft has no kind flag and exists to prove untyped footage stays out.
const ASSEMBLIES = [
  { id: 'strand-ft', label: 'Strand', isFootage: true, isStrand: true, parts: [] },
  { id: 'fiber-ft', label: 'Fiber', isFootage: true, isFiber: true, parts: [] },
  { id: 'bore-ft', label: 'Bore', isFootage: true, isConduit: true, parts: [] },
  { id: 'plow-ft', label: 'Plow', isFootage: true, isConduit: true, parts: [] },
  { id: 'misc-ft', label: 'Misc', isFootage: true, parts: [] },
]

const MAP = {
  fiber: {
    '144ct': { partId: 'SKU-144', name: 'R-144 144 ct sm fiber', unit: 'ft' },
    '288ct': { partId: 'SKU-288', name: 'R-288 288 ct sm fiber', unit: 'ft' },
    '12ct': { partId: 'SKU-12', name: 'R-12 12 ct sm fiber', unit: 'ft' },
  },
  conduit: {
    '2"': { partId: 'SKU-C2', name: 'Conduit 2"', unit: 'ea' },
    '3/4"': { partId: 'SKU-C34', name: 'Conduit 3/4"', unit: 'ft' },
  },
  strand: {
    '1/4"': { partId: 'STRAND-EHS', name: 'Strand, EHS, 1/4"', unit: 'ea' },
  },
}

const parts = (footageLines, assemblies = ASSEMBLIES) =>
  linesToParts({ assemblies, footageLines, footageMap: MAP })

describe('sumLines', () => {
  it('sums feet and tolerates junk', () => {
    expect(sumLines([{ type: 'a', ft: 2500 }, { type: 'b', ft: 300 }])).toBe(2800)
    expect(sumLines([{ type: 'a', ft: '500' }, { type: 'b' }, { type: 'c', ft: null }])).toBe(500)
    expect(sumLines([])).toBe(0)
    expect(sumLines(undefined)).toBe(0)
  })
})

describe('toggleLine', () => {
  it('first pick adopts the feet already typed in the header', () => {
    // The pre-multi-select flow: type the footage, then say what it was.
    expect(toggleLine([], '144ct', 2500)).toEqual([{ type: '144ct', ft: 2500 }])
  })

  it('later picks start empty so they never inherit another type\'s feet', () => {
    const after = toggleLine([{ type: '144ct', ft: 2500 }], '288ct', 2500)
    expect(after).toEqual([{ type: '144ct', ft: 2500 }, { type: '288ct', ft: 0 }])
  })

  it('toggling an existing type off removes just that line', () => {
    const cur = [{ type: '144ct', ft: 2500 }, { type: '288ct', ft: 300 }]
    expect(toggleLine(cur, '144ct')).toEqual([{ type: '288ct', ft: 300 }])
  })

  it('is order-preserving so the UI does not reshuffle under the crew', () => {
    let l = []
    l = toggleLine(l, '288ct', 0)
    l = toggleLine(l, '12ct', 0)
    l = toggleLine(l, '144ct', 0)
    expect(l.map(x => x.type)).toEqual(['288ct', '12ct', '144ct'])
  })
})

describe('removalLosesWork', () => {
  it('is false for the last line — that only un-types footage, it keeps the feet', () => {
    expect(removalLosesWork([{ type: '144ct', ft: 2500 }], '144ct')).toBe(false)
  })

  it('is true when the removal actually takes feet off the total', () => {
    const cur = [{ type: '144ct', ft: 2500 }, { type: '288ct', ft: 300 }]
    expect(removalLosesWork(cur, '288ct')).toBe(true)
  })

  it('is false for a zero-ft line — nothing to lose, so no confirm', () => {
    const cur = [{ type: '144ct', ft: 2500 }, { type: '288ct', ft: 0 }]
    expect(removalLosesWork(cur, '288ct')).toBe(false)
  })
})

describe('the counts === sum(lines) invariant', () => {
  // This is the whole safety argument for leaving summary/rollups untouched:
  // counts feeds submissions.total_*_ft, lines feed material consumption. If a
  // sequence of edits can desync them, the passdown reports one number and
  // deducts another.
  it('holds across a realistic edit sequence', () => {
    let lines = []
    lines = toggleLine(lines, '144ct', 2500)   // adopt header total
    expect(sumLines(lines)).toBe(2500)
    lines = toggleLine(lines, '288ct', 2500)   // second type starts at 0
    expect(sumLines(lines)).toBe(2500)
    lines = setLineFt(lines, '288ct', 300)
    expect(sumLines(lines)).toBe(2800)
    lines = setLineFt(lines, '144ct', '2000')  // string from the DOM input
    expect(sumLines(lines)).toBe(2300)
    lines = toggleLine(lines, '288ct')         // drop it
    expect(sumLines(lines)).toBe(2000)
  })
})

describe('linesToParts', () => {
  it('emits one part per type — the actual bug this change fixes', () => {
    const out = parts({ 'fiber-ft': [{ type: '144ct', ft: 2000 }, { type: '288ct', ft: 500 }] })
    expect(out).toHaveLength(2)
    expect(out.map(p => [p.id, p.qty])).toEqual([['SKU-144', 2000], ['SKU-288', 500]])
  })

  it('carries srcType and a unique srcKey per line', () => {
    const out = parts({ 'fiber-ft': [{ type: '144ct', ft: 10 }, { type: '288ct', ft: 20 }] })
    expect(out.map(p => p.srcKey)).toEqual(['fiber-ft:144ct', 'fiber-ft:288ct'])
    expect(out.map(p => p.srcType)).toEqual(['144ct', '288ct'])
    expect(new Set(out.map(p => p.srcKey)).size).toBe(out.length)
  })

  it('keeps two conduit sizes on the SAME slot distinct', () => {
    // Previously impossible: bore-ft held exactly one size.
    const out = parts({ 'bore-ft': [{ type: '2"', ft: 400 }, { type: '3/4"', ft: 100 }] })
    expect(out.map(p => [p.id, p.qty])).toEqual([['SKU-C2', 400], ['SKU-C34', 100]])
  })

  it('handles fiber and conduit together across assemblies', () => {
    const out = parts({
      'fiber-ft': [{ type: '144ct', ft: 900 }],
      'bore-ft': [{ type: '2"', ft: 400 }],
      'plow-ft': [{ type: '3/4"', ft: 250 }],
    })
    expect(out.map(p => p.id)).toEqual(['SKU-144', 'SKU-C2', 'SKU-C34'])
  })

  it('drops zero and negative feet', () => {
    const out = parts({ 'fiber-ft': [{ type: '144ct', ft: 0 }, { type: '288ct', ft: -5 }] })
    expect(out).toEqual([])
  })

  it('drops unmapped types without touching the mapped ones', () => {
    // '72ct' has no SKU — its feet stay a stat, the rest still consume.
    const out = parts({ 'fiber-ft': [{ type: '72ct', ft: 800 }, { type: '144ct', ft: 200 }] })
    expect(out.map(p => p.id)).toEqual(['SKU-144'])
  })

  it('skips a SKU the SAME assembly already derives, so it cannot double-count', () => {
    // fiber-ft itself carries SKU-144 as an assembly part.
    const asms = ASSEMBLIES.map(a =>
      a.id === 'fiber-ft' ? { ...a, parts: [{ id: 'SKU-144' }] } : a)
    const out = parts({ 'fiber-ft': [{ type: '144ct', ft: 500 }, { type: '288ct', ft: 100 }] }, asms)
    expect(out.map(p => p.id)).toEqual(['SKU-288'])
  })

  it('does NOT let a DIFFERENT assembly consuming the same SKU suppress the line', () => {
    // The regression this guard exists for: down-guy burns 20 ft of the strand
    // SKU per guy. Under an app-wide skip set, hanging one down guy silently
    // deleted the entire day's strand footage. Different assemblies consuming
    // one SKU is additive consumption, not a double-count.
    const asms = [...ASSEMBLIES, { id: 'down-guy', parts: [{ id: 'STRAND-EHS' }] }]
    const out = parts({ 'strand-ft': [{ type: '1/4"', ft: 1200 }] }, asms)
    expect(out.map(p => [p.id, p.qty])).toEqual([['STRAND-EHS', 1200]])
  })

  it('resolves a strand line to its mapped SKU', () => {
    const out = parts({ 'strand-ft': [{ type: '1/4"', ft: 850 }] })
    expect(out.map(p => [p.id, p.qty, p.srcType])).toEqual([['STRAND-EHS', 850, '1/4"']])
  })

  it('emits nothing for strand while strand-ft still carries the per_ft part', () => {
    // The cutover window: both paths live, same SKU, assembly row wins.
    const asms = ASSEMBLIES.map(a =>
      a.id === 'strand-ft' ? { ...a, parts: [{ id: 'STRAND-EHS' }] } : a)
    expect(parts({ 'strand-ft': [{ type: '1/4"', ft: 850 }] }, asms)).toEqual([])
  })

  it('ignores a footage assembly with no kind flag', () => {
    expect(parts({ 'misc-ft': [{ type: '144ct', ft: 999 }] })).toEqual([])
  })

  it('emits two rows when two types map to ONE sku, for mergePartsById to sum', () => {
    // A mis-curated footage map. Distinct srcKeys keep React from dropping a
    // row; mergePartsById then sums them onto one entry_parts line.
    const dupMap = { fiber: { '144ct': { partId: 'SKU-X', name: 'X', unit: 'ft' }, '288ct': { partId: 'SKU-X', name: 'X', unit: 'ft' } }, conduit: {} }
    const out = linesToParts({
      assemblies: ASSEMBLIES, footageMap: dupMap,
      footageLines: { 'fiber-ft': [{ type: '144ct', ft: 500 }, { type: '288ct', ft: 300 }] },
    })
    expect(out).toHaveLength(2)
    expect(new Set(out.map(p => p.srcKey)).size).toBe(2)
  })

  it('survives empty/missing input', () => {
    expect(parts({})).toEqual([])
    expect(linesToParts({})).toEqual([])
  })
})

describe('typeLabel', () => {
  it('joins and caps so the 390px banner does not overflow', () => {
    expect(typeLabel([])).toBe('')
    expect(typeLabel(undefined)).toBe('')
    expect(typeLabel([{ type: '144ct' }])).toBe('144ct')
    expect(typeLabel([{ type: '144ct' }, { type: '288ct' }])).toBe('144ct + 288ct')
    expect(typeLabel([{ type: '144ct' }, { type: '288ct' }, { type: '12ct' }])).toBe('144ct + 288ct +1')
  })
})

describe('hasFootageLines', () => {
  it('counts a picked type with no feet yet as work', () => {
    expect(hasFootageLines({ 'fiber-ft': [{ type: '144ct', ft: 0 }] })).toBe(true)
  })

  it('is false for empty shapes', () => {
    expect(hasFootageLines({})).toBe(false)
    expect(hasFootageLines({ 'fiber-ft': [] })).toBe(false)
    expect(hasFootageLines(undefined)).toBe(false)
  })
})

describe('migrateLegacyFootage', () => {
  it('folds a legacy fiber pick into one line carrying its feet', () => {
    const wc = { fiberCount: '144ct', counts: { 'fiber-ft': 2500 } }
    expect(migrateLegacyFootage(wc)).toEqual({ 'fiber-ft': [{ type: '144ct', ft: 2500 }] })
  })

  it('folds legacy conduit sizes per slot', () => {
    const wc = { conduitSizes: { 'bore-ft': '2"', 'plow-ft': '3/4"' }, counts: { 'bore-ft': 400, 'plow-ft': 250 } }
    expect(migrateLegacyFootage(wc)).toEqual({
      'bore-ft': [{ type: '2"', ft: 400 }],
      'plow-ft': [{ type: '3/4"', ft: 250 }],
    })
  })

  it('ignores the empty-string default that every live draft carries', () => {
    // All 12 open drafts hold exactly this shape — it must not become a line.
    expect(migrateLegacyFootage({ conduitSizes: { 'bore-ft': '', 'plow-ft': '' } })).toEqual({})
  })

  it('prefers an already-migrated shape and leaves it alone', () => {
    const wc = { footageLines: { 'fiber-ft': [{ type: '288ct', ft: 100 }] }, fiberCount: '144ct' }
    expect(migrateLegacyFootage(wc)).toEqual({ 'fiber-ft': [{ type: '288ct', ft: 100 }] })
  })

  it('keeps a type picked with no feet rather than dropping the pick', () => {
    expect(migrateLegacyFootage({ fiberCount: '144ct', counts: {} }))
      .toEqual({ 'fiber-ft': [{ type: '144ct', ft: 0 }] })
  })

  it('survives empty/missing input', () => {
    expect(migrateLegacyFootage({})).toEqual({})
    expect(migrateLegacyFootage(null)).toEqual({})
  })

  it('migrated lines satisfy the counts invariant', () => {
    const wc = { fiberCount: '144ct', counts: { 'fiber-ft': 2500 } }
    const lines = migrateLegacyFootage(wc)
    expect(sumLines(lines['fiber-ft'])).toBe(wc.counts['fiber-ft'])
  })
})

describe('footageKind', () => {
  it('maps each flag to its kind', () => {
    expect(footageKind({ isFiber: true })).toBe('fiber')
    expect(footageKind({ isConduit: true })).toBe('conduit')
    expect(footageKind({ isStrand: true })).toBe('strand')
  })

  it('returns null for untyped footage and for nothing at all', () => {
    // The null is load-bearing: it's what keeps untyped footage (and every
    // non-footage assembly) out of the consumption path entirely.
    expect(footageKind({ isFootage: true })).toBe(null)
    expect(footageKind({})).toBe(null)
    expect(footageKind(null)).toBe(null)
    expect(footageKind(undefined)).toBe(null)
  })

  it('has a documented precedence when two flags are somehow set', () => {
    expect(footageKind({ isFiber: true, isConduit: true, isStrand: true })).toBe('fiber')
  })
})

describe('autoPickType', () => {
  it('picks the only value when a kind has exactly one chip', () => {
    expect(autoPickType([], ['1/4"'])).toBe('1/4"')
  })

  it('never picks for a multi-chip kind — that is a real choice', () => {
    expect(autoPickType([], ['12ct', '144ct', '288ct'])).toBe(null)
  })

  it('never overrides an existing pick, whatever the list length', () => {
    expect(autoPickType([{ type: '1/4"', ft: 10 }], ['1/4"'])).toBe(null)
  })

  it('survives empty/missing input', () => {
    expect(autoPickType([], [])).toBe(null)
    expect(autoPickType(undefined, undefined)).toBe(null)
  })
})

describe('footage kind registry', () => {
  // Tripwire. STRAND_SIZES having exactly one entry is what makes autoPickType
  // fire for strand — adding a size silently turns the auto-pick off and
  // reintroduces "typed feet, forgot the chip, consumed nothing". If you're
  // here because this failed: that's the decision to confront, not the test.
  it('keeps strand at a single size so the auto-pick stays deterministic', () => {
    expect(STRAND_SIZES).toHaveLength(1)
  })

  it('covers every kind footageKind can return', () => {
    const kinds = ['fiber', 'conduit', 'strand']
    expect(Object.keys(FOOTAGE_TYPE_VALUES).sort()).toEqual([...kinds].sort())
    for (const k of kinds) expect(FOOTAGE_TYPE_VALUES[k].length).toBeGreaterThan(0)
  })
})
