import { describe, it, expect } from 'vitest'
import { buildStockIndex, buildBinsByWarehouse, allocateBinSources } from './binSource'

const WH = 'wh-main'
const locations = [
  { id: WH, name: 'Main Warehouse', type: 'warehouse', parent_location_id: null },
  { id: 'bin-a', name: 'A-1', type: 'bin', parent_location_id: WH },
  { id: 'bin-b', name: 'B-2', type: 'bin', parent_location_id: WH },
  { id: 'bin-x', name: 'Retired', type: 'bin', parent_location_id: WH, is_active: false },
  { id: 'bin-other', name: 'Z-9', type: 'bin', parent_location_id: 'wh-yard' },
]
const binsByWarehouse = buildBinsByWarehouse(locations)
const warehouseNames = new Map([[WH, 'Main Warehouse']])
const idx = rows => buildStockIndex(rows.map(([part_id, location_id, quantity]) => ({ part_id, location_id, quantity })))

describe('buildBinsByWarehouse', () => {
  it('groups active bins under their warehouse, skipping retired', () => {
    expect(binsByWarehouse.get(WH).map(b => b.id)).toEqual(['bin-a', 'bin-b'])
    expect(binsByWarehouse.get('wh-yard').map(b => b.id)).toEqual(['bin-other'])
  })
})

describe('allocateBinSources', () => {
  it('picks the bin holding the most of the part', () => {
    const stockIndex = idx([['ont', 'bin-a', 2], ['ont', 'bin-b', 9], ['ont', WH, 50]])
    const r = allocateBinSources([{ key: 1, partId: 'ont', warehouseId: WH, qty: 1 }], { stockIndex, binsByWarehouse, warehouseNames })
    expect(r.get(1)).toMatchObject({ locationId: 'bin-b', auto: true, available: 9, short: false })
  })

  it('falls back to unbinned only when no bin has any', () => {
    const stockIndex = idx([['ont', 'bin-a', 0], ['ont', 'bin-b', -3], ['ont', WH, 4]])
    const r = allocateBinSources([{ key: 1, partId: 'ont', warehouseId: WH, qty: 1 }], { stockIndex, binsByWarehouse })
    expect(r.get(1).locationId).toBe(WH)
  })

  it('spreads successive draws by running remaining qty', () => {
    const stockIndex = idx([['ont', 'bin-a', 2], ['ont', 'bin-b', 3]])
    const lines = [1, 2, 3, 4, 5].map(k => ({ key: k, partId: 'ont', warehouseId: WH, qty: 1 }))
    const r = allocateBinSources(lines, { stockIndex, binsByWarehouse })
    expect(lines.map(l => r.get(l.key).locationId)).toEqual(['bin-b', 'bin-a', 'bin-b', 'bin-a', 'bin-b'])
    expect(lines.every(l => !r.get(l.key).short)).toBe(true)
  })

  it('never splits a line; flags short instead', () => {
    const stockIndex = idx([['conduit', 'bin-a', 100], ['conduit', 'bin-b', 100]])
    const r = allocateBinSources([{ key: 'k', partId: 'conduit', warehouseId: WH, qty: 188 }], { stockIndex, binsByWarehouse })
    expect(r.get('k')).toMatchObject({ locationId: 'bin-a', available: 100, short: true })
  })

  it('a manual override wins and consumes from the picked location', () => {
    const stockIndex = idx([['ont', 'bin-a', 1], ['ont', 'bin-b', 1]])
    const r = allocateBinSources([
      { key: 1, partId: 'ont', warehouseId: WH, qty: 1, overrideId: 'bin-b' },
      { key: 2, partId: 'ont', warehouseId: WH, qty: 1 },
    ], { stockIndex, binsByWarehouse })
    expect(r.get(1)).toMatchObject({ locationId: 'bin-b', auto: false })
    expect(r.get(2).locationId).toBe('bin-a')   // bin-b already drawn down
  })

  it('drops a stale override from another warehouse', () => {
    const stockIndex = idx([['ont', 'bin-a', 3]])
    const r = allocateBinSources([{ key: 1, partId: 'ont', warehouseId: WH, qty: 1, overrideId: 'bin-other' }], { stockIndex, binsByWarehouse })
    expect(r.get(1)).toMatchObject({ locationId: 'bin-a', auto: true })
  })

  it('options list bins by on-hand, unbinned last, labelled with the warehouse', () => {
    const stockIndex = idx([['ont', 'bin-a', 1], ['ont', 'bin-b', 5], ['ont', WH, 2]])
    const r = allocateBinSources([{ key: 1, partId: 'ont', warehouseId: WH, qty: 1 }], { stockIndex, binsByWarehouse, warehouseNames })
    expect(r.get(1).options).toEqual([
      { id: 'bin-b', label: 'B-2', qty: 5, isUnbinned: false },
      { id: 'bin-a', label: 'A-1', qty: 1, isUnbinned: false },
      { id: WH, label: 'Unbinned (Main Warehouse)', qty: 2, isUnbinned: true },
    ])
  })

  it('ignores lines that are not warehouse-sourced', () => {
    const r = allocateBinSources([{ key: 1, partId: 'ont', warehouseId: null, qty: 1 }], { stockIndex: new Map(), binsByWarehouse })
    expect(r.size).toBe(0)
  })
})
