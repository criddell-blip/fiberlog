import { describe, it, expect } from 'vitest'
import {
  findMoveColumns, locationKey, buildLocationIndex, buildPartFinder,
  parseMoveRows, applyStock, buildCsvMovePayloads, buildMoveTemplateCsv,
} from './csvMove'
import { parseCsv } from './csvImport'

const WH = { id: 'wh', type: 'warehouse', name: 'Main Warehouse locations' }
const WH2 = { id: 'wh2', type: 'warehouse', name: 'Yard' }
const B4A2 = { id: 'b4a2', type: 'bin', name: 'Aisle 4, shelf a2', parent_location_id: 'wh' }
const B4D5 = { id: 'b4d5', type: 'bin', name: 'Aisle 4, Shelf d5', parent_location_id: 'wh' }
const B14A2 = { id: 'b14a2', type: 'bin', name: 'Aisle 14, shelf a2', parent_location_id: 'wh' }
const DOCK1 = { id: 'dock1', type: 'bin', name: 'Dock', parent_location_id: 'wh' }
const DOCK2 = { id: 'dock2', type: 'bin', name: 'Dock', parent_location_id: 'wh2' }
const TRUCK = { id: 'tr', type: 'truck', name: 'Truck 7', assigned_user: { name: 'Leo Tamayo' } }
const REGION = { id: 'rg', type: 'job_site', name: 'Heber' }
const LOCS = [WH, WH2, B4A2, B4D5, B14A2, DOCK1, DOCK2, TRUCK, REGION]
const byId = new Map(LOCS.map(l => [l.id, l]))
const idx = buildLocationIndex(LOCS)

const PARTS = { 'ONT-1': { id: 'ONT-1', name: 'ONT', unit: 'ea' }, 'CBL-2': { id: 'CBL-2', name: 'Cable', unit: 'ft' } }
const findPart = t => PARTS[t.toUpperCase()] || null

function run(csv, { defaultFromId = 'wh', stock = {} } = {}) {
  const { headers, rows } = parseCsv(csv)
  const parsed = parseMoveRows({
    rows, cols: findMoveColumns(headers), findPart,
    resolveLoc: idx.resolve, defaultFromId, locationsById: byId,
  })
  return applyStock(parsed, (p, l) => stock[`${p}|${l}`] || 0)
}

describe('findMoveColumns', () => {
  it('matches aliases regardless of case/punctuation', () => {
    expect(findMoveColumns(['Part ID', 'Quantity', 'Source', 'To Bin', 'Name']))
      .toEqual({ sku: 'Part ID', qty: 'Quantity', from: 'Source', to: 'To Bin' })
  })
  it('prefers SKU over Part when both exist', () => {
    expect(findMoveColumns(['Part', 'SKU', 'To']).sku).toBe('SKU')
  })
})

describe('location matching', () => {
  it('normalises bin names + shorthand to the same key', () => {
    for (const s of ['Aisle 4, shelf a2', 'aisle 4 SHELF A2', '4-a2', '4 a2', '4A2']) {
      expect(locationKey(s)).toBe('4a2')
    }
  })
  it('does not confuse aisle 4 with aisle 14', () => {
    expect(idx.resolve('4-a2').location.id).toBe('b4a2')
    expect(idx.resolve('14-a2').location.id).toBe('b14a2')
  })
  it('handles inconsistent capitalisation in stored names', () => {
    expect(idx.resolve('Aisle 4, shelf d5').location.id).toBe('b4d5')
  })
  it('resolves a warehouse name to the warehouse (unbinned) level', () => {
    expect(idx.resolve('Main Warehouse locations').location.id).toBe('wh')
  })
  it('resolves trucks by driver name', () => {
    expect(idx.resolve('leo tamayo').location.id).toBe('tr')
  })
  it('reports ambiguity instead of guessing, and Warehouse / Bin disambiguates', () => {
    expect(idx.resolve('Dock').error).toMatch(/matches 2/)
    expect(idx.resolve('Yard / Dock').location.id).toBe('dock2')
  })
  it('handles a bin whose own name contains a slash', () => {
    const odd = { id: 'odd', type: 'bin', name: 'Crew construction/ to research', parent_location_id: 'wh' }
    const ix = buildLocationIndex([...LOCS, odd])
    expect(ix.resolve('Crew construction/ to research').location.id).toBe('odd')
    expect(ix.resolve('Main Warehouse locations / Crew construction/ to research').location.id).toBe('odd')
  })
  it('reports unknown names', () => {
    expect(idx.resolve('Aisle 9, shelf z9').error).toMatch(/No location/)
  })
})

describe('row resolution', () => {
  it('blank To = skip; blank qty = everything on hand at From', () => {
    const r = run('SKU,Qty,To\nONT-1,,4-a2\nCBL-2,,', { stock: { 'ONT-1|wh': 12 } })
    expect(r[0]).toMatchObject({ status: 'ok', qty: 12, qtyFromStock: true })
    expect(r[1].status).toBe('skip')
  })
  it('blank qty with nothing on hand is an error', () => {
    expect(run('SKU,To\nONT-1,4-a2')[0]).toMatchObject({ status: 'error' })
  })
  it('a part split across rows must state its qty', () => {
    const r = run('SKU,Qty,To\nONT-1,,4-a2\nONT-1,3,4-d5', { stock: { 'ONT-1|wh': 10 } })
    expect(r[0].status).toBe('error')
    expect(r[1].status).toBe('ok')
  })
  it('warns when split rows overdraw together', () => {
    const r = run('SKU,Qty,To\nONT-1,6,4-a2\nONT-1,6,4-d5', { stock: { 'ONT-1|wh': 10 } })
    expect(r.map(x => x.status)).toEqual(['warn', 'warn'])
  })
  it('accepts "1,200" style quantities and rejects junk / zero', () => {
    const r = run('SKU,Qty,To\nCBL-2,"1,200",4-a2\nCBL-2,abc,4-d5\nONT-1,0,4-a2', { stock: { 'CBL-2|wh': 5000 } })
    expect(r[0]).toMatchObject({ status: 'ok', qty: 1200 })
    expect(r[1].status).toBe('error')
    expect(r[2].status).toBe('error')
  })
  it('rejects unknown SKU, same-place moves and Region endpoints', () => {
    const r = run('SKU,Qty,From,To\nNOPE,1,,4-a2\nONT-1,1,4-a2,4-a2\nONT-1,1,,Heber', { stock: { 'ONT-1|wh': 5, 'ONT-1|b4a2': 5 } })
    expect(r.map(x => x.status)).toEqual(['error', 'error', 'error'])
    expect(r[2].message).toMatch(/Region/)
  })
  it('flags the bad side so the sheet can offer a fix-up picker', () => {
    const r = run('SKU,Qty,To\nONT-1,1,Aisle 99 shelf q1', { stock: { 'ONT-1|wh': 5 } })
    expect(r[0]).toMatchObject({ status: 'error', badTo: true })
  })
  it('needs a From when there is no default', () => {
    expect(run('SKU,Qty,To\nONT-1,1,4-a2', { defaultFromId: null })[0].status).toBe('error')
  })
})

describe('buildPartFinder (spreadsheet-stripped leading zeros)', () => {
  const find = buildPartFinder([
    { id: '0065910', name: 'PVC adapter' }, { id: '65910', name: 'PVC adapter' },   // twins, live Oct 2026
    { id: '0069198', name: 'Conduit' },                                              // padded only
    { id: '76150', name: 'Attenuator' },                                             // plain numeric
    { id: 'ONT-1', name: 'ONT' },
  ])
  it('refuses a stripped SKU that has a zero-padded twin', () => {
    expect(find('65910').error).toMatch(/0065910/)
  })
  it('the full padded SKU still matches exactly', () => {
    expect(find('0065910').id).toBe('0065910')
  })
  it('recovers the padded SKU when it is the only candidate', () => {
    expect(find('69198').id).toBe('0069198')
  })
  it('leaves ordinary numeric + text SKUs alone', () => {
    expect(find('76150').id).toBe('76150')
    expect(find('ont-1').id).toBe('ONT-1')
    expect(find('nope')).toBeNull()
  })
  it('surfaces the error on the row', () => {
    const { headers, rows } = parseCsv('SKU,Qty,To\n65910,1,4-a2')
    const r = parseMoveRows({ rows, cols: findMoveColumns(headers), findPart: find, resolveLoc: idx.resolve, defaultFromId: 'wh', locationsById: byId })
    expect(r[0]).toMatchObject({ status: 'error' })
    expect(r[0].message).toMatch(/leading zeros/)
  })
})

describe('payloads + template', () => {
  it('builds one transfer per ok/warn row', () => {
    const r = run('SKU,Qty,To\nONT-1,2,4-a2\nNOPE,1,4-a2\nCBL-2,,', { stock: { 'ONT-1|wh': 5 } })
    expect(buildCsvMovePayloads(r, { userId: 'u1', notes: 'n' })).toEqual([{
      movement_type: 'transfer', part_id: 'ONT-1', quantity: 2, unit: 'ea',
      from_location_id: 'wh', to_location_id: 'b4a2', notes: 'n', created_by: 'u1',
    }])
  })
  it('template round-trips back through the importer', () => {
    const csv = buildMoveTemplateCsv(
      [{ part: PARTS['ONT-1'], quantity: 7 }, { part: PARTS['CBL-2'], quantity: 300 }],
      'Main Warehouse locations')
    // Fill in one To, leave the other blank.
    const filled = csv.split('\n').map((l, i) => i === 2 ? l + '"Aisle 4, shelf a2"' : l).join('\n')
    const r = run(filled, { defaultFromId: null, stock: { 'ONT-1|wh': 7 } })
    expect(r.find(x => x.skuText === 'ONT-1')).toMatchObject({ status: 'ok', qty: 7 })
    expect(r.find(x => x.skuText === 'CBL-2').status).toBe('skip')
  })
})
