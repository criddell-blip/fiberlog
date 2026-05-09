// Unit tests for calculations.js. Focused on the arithmetic that matters:
// bolt-size SKU mapping, lashing math (ceil-based), structure mappings,
// and the mergeParts dedupe utility. These are the parts most likely to
// silently regress when someone tweaks a SKU map or a per-100ft ratio.

import { describe, it, expect } from 'vitest'
import {
  calcStrandParts,
  calcLashingParts,
  calcStrandFootageParts,
  calcUndergroundParts,
  calcSpliceParts,
  mergeParts,
} from './calculations'

describe('calcStrandParts', () => {
  it('returns no parts for empty input', () => {
    expect(calcStrandParts([])).toEqual([])
  })

  it('intermediate pole: 2 nuts, 2 washers, 1 bolt (default 14"), 1 clamp', () => {
    const parts = calcStrandParts([{ type: 'intermediate', count: 1 }])
    const byId = Object.fromEntries(parts.map(p => [p.id, p.qty]))
    expect(byId['SKU-STLVBCPS']).toBe(2)
    expect(byId['600-100023-ALB']).toBe(2)
    expect(byId['600-100003-ALB']).toBe(1)
    expect(byId['600-100028-ALB']).toBe(1)
  })

  it('boltOverride maps to the right machine-bolt SKU (12/14/16)', () => {
    const get = size => {
      const parts = calcStrandParts([{ type: 'intermediate', count: 1, boltOverride: size }])
      return parts.find(p => p.id.startsWith('600-1000') && !p.id.includes('600-10002'))?.id
    }
    expect(get('12')).toBe('600-100002-ALB')
    expect(get('14')).toBe('600-100003-ALB')
    expect(get('16')).toBe('600-100004-ALB')
  })

  it('terminal pole uses thimble-eye bolt; override maps to thimble SKU', () => {
    const def = calcStrandParts([{ type: 'terminal', count: 1 }])
    expect(def.find(p => p.id.startsWith('600-10004')).id).toBe('600-100048-ALB')
    const ovr = calcStrandParts([{ type: 'terminal', count: 1, boltOverride: '12' }])
    expect(ovr.find(p => p.id.startsWith('600-10004')).id).toBe('600-100047-ALB')
  })

  it('multiplies hardware by count', () => {
    const parts = calcStrandParts([{ type: 'intermediate', count: 5 }])
    expect(parts.find(p => p.id === 'SKU-STLVBCPS').qty).toBe(10) // 2 per pole * 5
    expect(parts.find(p => p.id === '600-100003-ALB').qty).toBe(5)
  })

  it('merges shared SKUs across pole types', () => {
    // intermediate adds 2 nuts, terminal adds 1 nut -> total 3
    const parts = calcStrandParts([
      { type: 'intermediate', count: 1 },
      { type: 'terminal', count: 1 },
    ])
    expect(parts.find(p => p.id === 'SKU-STLVBCPS').qty).toBe(3)
  })

  it('downGuy includes 20 ft of strand and 4 deadend grips per guy', () => {
    const parts = calcStrandParts([{ type: 'downGuy', count: 1 }])
    const strand = parts.find(p => p.id === '600-200001-5000-ERC')
    expect(strand.qty).toBe(20)
    expect(strand.unit).toBe('ft')
    expect(parts.find(p => p.id === '600-200009-ALB').qty).toBe(4)
    expect(parts.find(p => p.id === '600-300001-ALB').qty).toBe(1) // anchor
  })

  it('unknown pole types are silently skipped', () => {
    expect(calcStrandParts([{ type: 'imaginaryPole', count: 99 }])).toEqual([])
  })
})

describe('calcLashingParts', () => {
  it('produces no fiber or lashing wire at 0 footage', () => {
    const parts = calcLashingParts(0, 'intermediate', 'FIB-X')
    expect(parts.find(p => p.id === 'FIB-X')).toBeUndefined()
    expect(parts.find(p => p.id === '600-210001-CWP')).toBeUndefined()
  })

  it('includes fiber cable at the requested footage', () => {
    const parts = calcLashingParts(500, 'intermediate', 'FIB-XYZ')
    const fiber = parts.find(p => p.id === 'FIB-XYZ')
    expect(fiber.qty).toBe(500)
    expect(fiber.unit).toBe('ft')
  })

  it('omits fiber row when fiberPartId is null', () => {
    const parts = calcLashingParts(500, 'intermediate', null)
    expect(parts.some(p => p.unit === 'ft')).toBe(false)
  })

  it('lashing wire = ceil(footage / 1200)', () => {
    const wireQty = footage =>
      calcLashingParts(footage, 'intermediate', null).find(p => p.id === '600-210001-CWP').qty
    expect(wireQty(1)).toBe(1)
    expect(wireQty(1200)).toBe(1)
    expect(wireQty(1201)).toBe(2)
    expect(wireQty(2400)).toBe(2)
    expect(wireQty(2401)).toBe(3)
  })

  it('hardware quantities round up via ceil', () => {
    // intermediate clamp: 0.5 per 100ft. 100ft -> ceil(0.5)=1; 300ft -> ceil(1.5)=2
    const clampAt = footage =>
      calcLashingParts(footage, 'intermediate', null).find(p => p.id === '600-100029-ALB').qty
    expect(clampAt(100)).toBe(1)
    expect(clampAt(200)).toBe(1)
    expect(clampAt(300)).toBe(2)
  })

  it('terminal lashing includes deadend grip; intermediate does not', () => {
    const term = calcLashingParts(200, 'terminal', null)
    const inter = calcLashingParts(200, 'intermediate', null)
    expect(term.find(p => p.id === '600-200009-ALB')).toBeDefined()
    expect(inter.find(p => p.id === '600-200009-ALB')).toBeUndefined()
  })

  it('unknown lashType falls back to intermediate hardware list', () => {
    const parts = calcLashingParts(100, 'whoops-not-a-real-type', null)
    expect(parts.find(p => p.id === '600-200009-ALB')).toBeUndefined() // no terminal-only grip
    expect(parts.find(p => p.id === '600-100029-ALB')).toBeDefined()   // intermediate clamp present
  })
})

describe('calcStrandFootageParts', () => {
  it('returns [] for 0 footage', () => {
    expect(calcStrandFootageParts(0)).toEqual([])
  })

  it('returns one strand row at given footage', () => {
    const parts = calcStrandFootageParts(247)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({
      id: '600-200001-5000-ERC',
      qty: 247,
      unit: 'ft',
    })
  })
})

describe('calcUndergroundParts', () => {
  it('bore footage adds conduit + tracer wire (ceil 1 spool per 2500ft)', () => {
    const parts = calcUndergroundParts(
      [{ footage: 2501, conduitId: 'CON-X', conduitName: 'Conduit X' }], [], []
    )
    expect(parts.find(p => p.id === 'CON-X').qty).toBe(2501)
    expect(parts.find(p => p.id === 'SKU-BY9IKNAP').qty).toBe(2) // ceil(2501/2500)
  })

  it('place footage adds conduit + pull tape (1 ft per 1 ft)', () => {
    const parts = calcUndergroundParts(
      [], [{ footage: 100, conduitId: 'CON-Y', conduitName: 'Conduit Y' }], []
    )
    expect(parts.find(p => p.id === '200-130001').qty).toBe(100)
  })

  it('bore + place sharing a conduit SKU sum into one row', () => {
    const parts = calcUndergroundParts(
      [{ footage: 100, conduitId: 'CON-Z', conduitName: 'Conduit Z' }],
      [{ footage: 200, conduitId: 'CON-Z', conduitName: 'Conduit Z' }],
      []
    )
    expect(parts.find(p => p.id === 'CON-Z').qty).toBe(300)
  })

  it.each([
    ['handhole_plastic', 'SKU-26H3G0GO'],
    ['handhole_poly',    '400-300815-ODC'],
    ['vault_large',      '400-3001080-ODC'],
  ])('structure type %s maps to SKU %s', (type, expectedId) => {
    const parts = calcUndergroundParts([], [], [{ type, count: 4 }])
    expect(parts.find(p => p.id === expectedId).qty).toBe(4)
  })

  it('unknown structure type is silently skipped', () => {
    expect(calcUndergroundParts([], [], [{ type: 'fake_struct', count: 99 }])).toEqual([])
  })
})

describe('calcSpliceParts', () => {
  it('A4 closure adds case + gel kit + aerial clamp kit per closure', () => {
    const parts = calcSpliceParts([{ type: 'A4', count: 3, trays: 0 }], [])
    const qtyById = Object.fromEntries(parts.map(p => [p.id, p.qty]))
    expect(qtyById['OFDC-A4-S2/44-14-N-12']).toBe(3)
    expect(qtyById['CZ3388-000']).toBe(3)
    expect(qtyById['FOSC-ACC-450-AERIAL-CLMP']).toBe(3)
  })

  it('trays add separately based on trays count', () => {
    const parts = calcSpliceParts([{ type: 'A4', count: 1, trays: 5 }], [])
    expect(parts.find(p => p.id === '429567-000').qty).toBe(5)
  })

  it.each([
    ['1x2', 'PLC-102-ST-25-15'],
    ['1x4', 'PLC-104-ST-25-15'],
    ['1x8', 'PLC-108-ST-25-15'],
  ])('splitter %s maps to SKU %s', (type, expectedId) => {
    const parts = calcSpliceParts([], [{ type, count: 2 }])
    expect(parts.find(p => p.id === expectedId).qty).toBe(2)
  })

  it('unknown closure / splitter types are silently skipped', () => {
    const parts = calcSpliceParts(
      [{ type: 'X9', count: 1, trays: 1 }],
      [{ type: '1x99', count: 5 }]
    )
    expect(parts).toEqual([])
  })
})

describe('mergeParts', () => {
  it('flattens nested arrays', () => {
    const merged = mergeParts([
      [{ id: 'A', name: 'A', unit: 'ea', qty: 1 }],
      [{ id: 'B', name: 'B', unit: 'ea', qty: 2 }],
    ])
    expect(merged).toHaveLength(2)
  })

  it('sums qty across arrays for the same id', () => {
    const merged = mergeParts([
      [{ id: 'A', name: 'A', unit: 'ea', qty: 3 }],
      [{ id: 'A', name: 'A', unit: 'ea', qty: 4 }],
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].qty).toBe(7)
  })

  it('filters out zero-qty rows after merging', () => {
    const merged = mergeParts([
      [{ id: 'A', name: 'A', unit: 'ea', qty: 5 }, { id: 'B', name: 'B', unit: 'ea', qty: 0 }],
    ])
    expect(merged.find(p => p.id === 'B')).toBeUndefined()
    expect(merged.find(p => p.id === 'A').qty).toBe(5)
  })

  it('preserves metadata from the first occurrence', () => {
    const merged = mergeParts([
      [{ id: 'A', name: 'Original', unit: 'ft', qty: 1 }],
      [{ id: 'A', name: 'Different', unit: 'ea', qty: 2 }],
    ])
    expect(merged[0].name).toBe('Original')
    expect(merged[0].unit).toBe('ft')
    expect(merged[0].qty).toBe(3)
  })
})
