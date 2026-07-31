// Unit tests for the pure logic in lib/inventory.js that the app actually
// runs on money paths:
//   • validateMovement — client mirror of the DB movement_endpoints_valid
//     CHECK; every movement entry point funnels through it.
//   • isExportableMovement / buildSageCsv — the Sage Intacct export builder
//     (what accounting ultimately receives).
// The async DB helpers are deliberately untested here — they're thin
// PostgREST queries with no local logic worth mocking.
import { describe, it, expect } from 'vitest'
import {
  validateMovement,
  isExportableMovement,
  buildSageCsv,
  movementEffectiveDate,
  aggregateDeductions,
} from './inventory'

// ─── validateMovement ────────────────────────────────────────────────────────

describe('validateMovement', () => {
  const ok = (movement_type, from_location_id, to_location_id) =>
    expect(() => validateMovement({ movement_type, from_location_id, to_location_id }))
      .not.toThrow()
  const bad = (movement_type, from_location_id, to_location_id, msgRe) =>
    expect(() => validateMovement({ movement_type, from_location_id, to_location_id }))
      .toThrow(msgRe)

  it('rejects unknown movement types', () => {
    bad('teleport', 'L1', 'L2', /Unknown movement type "teleport"/)
    bad(undefined, 'L1', 'L2', /Unknown movement type/)
  })

  it('receive: to-only', () => {
    ok('receive', null, 'WH')
    bad('receive', 'WH', null, /Receive needs a destination/)
    bad('receive', 'A', 'B', /Receive needs a destination/)
    bad('receive', null, null, /Receive needs a destination/)
  })

  it('issue: from-only', () => {
    ok('issue', 'TRUCK', null)
    bad('issue', null, 'WH', /Issue needs a source/)
    bad('issue', 'A', 'B', /Issue needs a source/)
    bad('issue', null, null, /Issue needs a source/)
  })

  it('scrap: from-only', () => {
    ok('scrap', 'TRUCK', null)
    bad('scrap', null, 'WH', /Scrap needs a source/)
    bad('scrap', 'A', 'B', /Scrap needs a source/)
    bad('scrap', null, null, /Scrap needs a source/)
  })

  it('transfer: both endpoints, and they must differ', () => {
    ok('transfer', 'WH', 'TRUCK')
    bad('transfer', 'WH', null, /Transfer needs both/)
    bad('transfer', null, 'TRUCK', /Transfer needs both/)
    bad('transfer', null, null, /Transfer needs both/)
    bad('transfer', 'SAME', 'SAME', /must be different/)
  })

  it('return: both endpoints, and they must differ', () => {
    ok('return', 'TRUCK', 'WH')
    bad('return', 'TRUCK', null, /Return needs both/)
    bad('return', null, 'WH', /Return needs both/)
    bad('return', null, null, /Return needs both/)
    bad('return', 'SAME', 'SAME', /must be different/)
  })

  it('adjust: exactly one side (positive → to-only, negative → from-only)', () => {
    ok('adjust', null, 'WH')   // positive adjustment
    ok('adjust', 'WH', null)   // negative adjustment
    bad('adjust', 'A', 'B', /one-sided/)
    bad('adjust', null, null, /either a source .* or destination/)
  })
})

// ─── Sage export: fixtures ───────────────────────────────────────────────────

const WAREHOUSE = { id: 'wh1', name: 'Main Warehouse', type: 'warehouse', parent_location_id: null }
const WAREHOUSE2 = { id: 'wh2', name: 'North Warehouse', type: 'warehouse', parent_location_id: null }
const BIN_A = { id: 'binA', name: 'A-01', type: 'bin', parent_location_id: 'wh1' }
const BIN_B = { id: 'binB', name: 'B-02', type: 'bin', parent_location_id: 'wh1' }
const BIN_OTHER = { id: 'binC', name: 'C-01', type: 'bin', parent_location_id: 'wh2' }
const TRUCK1 = { id: 'tr1', name: 'Francisco Molina', type: 'truck', parent_location_id: null }
const TRUCK2 = { id: 'tr2', name: 'Edgar Molina', type: 'truck', parent_location_id: null }
const BUCKET = { id: 'js1', name: 'Heber', type: 'job_site', parent_location_id: null, project_id: 'p1' }

const PART = { id: 'SKU-1', name: 'Lag Bolt', unit: 'ea', department: 'Hardware' }

let seq = 0
function mv(overrides = {}) {
  seq++
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    movement_type: 'transfer',
    quantity: 5,
    unit: 'ea',
    unit_cost: null,
    notes: '',
    created_at: '2026-06-15T10:30:00.000Z',
    occurred_at: null,
    submission_id: null,
    part: PART,
    from_location: TRUCK1,
    to_location: BUCKET,
    phase: null,
    ...overrides,
  }
}

// Minimal quoted-field-aware CSV line parser for assertions.
function parseCsvLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQ = false
      else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

const HEADERS = [
  'TRANSACTIONTYPE', 'DATE', 'REFERENCENO', 'LINE', 'ITEMID', 'ITEMDESC',
  'QUANTITY', 'UNIT', 'PRICE', 'FROM_WAREHOUSE', 'TO_WAREHOUSE', 'TO_BIN',
  'PROJECTID', 'CLASSID', 'DEPARTMENTID', 'VENDORID', 'MEMO',
  'FIBERLOG_MOVEMENT_ID',
]
const col = name => HEADERS.indexOf(name)

function csvRows(csv) {
  return csv.split('\n').slice(1).map(parseCsvLine)
}

// ─── isExportableMovement ────────────────────────────────────────────────────

describe('isExportableMovement', () => {
  it('always excludes adjust (FiberLog-internal count corrections)', () => {
    expect(isExportableMovement(mv({ movement_type: 'adjust', from_location: null, to_location: WAREHOUSE }))).toBe(false)
    expect(isExportableMovement(mv({ movement_type: 'adjust', from_location: WAREHOUSE, to_location: null }))).toBe(false)
  })

  it('always excludes truck → truck handoffs', () => {
    expect(isExportableMovement(mv({ from_location: TRUCK1, to_location: TRUCK2 }))).toBe(false)
  })

  it('excludes movements that never leave a warehouse (bin↔bin, bin↔parent)', () => {
    expect(isExportableMovement(mv({ from_location: BIN_A, to_location: BIN_B }))).toBe(false)
    expect(isExportableMovement(mv({ from_location: WAREHOUSE, to_location: BIN_A }))).toBe(false)
    expect(isExportableMovement(mv({ from_location: BIN_A, to_location: WAREHOUSE }))).toBe(false)
  })

  it('keeps inter-warehouse transfers (different parent warehouses)', () => {
    expect(isExportableMovement(mv({ from_location: WAREHOUSE, to_location: WAREHOUSE2 }))).toBe(true)
    expect(isExportableMovement(mv({ from_location: BIN_A, to_location: BIN_OTHER }))).toBe(true)
  })

  it('keeps receives, consumption transfers, issues, and scraps', () => {
    expect(isExportableMovement(mv({ movement_type: 'receive', from_location: null, to_location: WAREHOUSE }))).toBe(true)
    expect(isExportableMovement(mv({ from_location: TRUCK1, to_location: BUCKET }))).toBe(true)
    expect(isExportableMovement(mv({ movement_type: 'issue', from_location: TRUCK1, to_location: null }))).toBe(true)
    expect(isExportableMovement(mv({ movement_type: 'scrap', from_location: TRUCK1, to_location: null }))).toBe(true)
  })

  it('strictConsumption additionally drops crew loadouts and returns, keeps auto-deduct', () => {
    const loadout = mv({ from_location: WAREHOUSE, to_location: TRUCK1 })
    const ret = mv({ movement_type: 'return', from_location: TRUCK1, to_location: WAREHOUSE })
    const autoDeduct = mv({ from_location: TRUCK1, to_location: BUCKET })
    expect(isExportableMovement(loadout)).toBe(true)
    expect(isExportableMovement(loadout, { strictConsumption: true })).toBe(false)
    expect(isExportableMovement(ret)).toBe(true)
    expect(isExportableMovement(ret, { strictConsumption: true })).toBe(false)
    expect(isExportableMovement(autoDeduct, { strictConsumption: true })).toBe(true)
  })
})

// ─── buildSageCsv ────────────────────────────────────────────────────────────

describe('buildSageCsv', () => {
  it('emits the 18 Sage columns in the documented order', () => {
    const csv = buildSageCsv([mv()])
    expect(csv.split('\n')[0]).toBe(HEADERS.join(','))
    expect(parseCsvLine(csv.split('\n')[1])).toHaveLength(18)
  })

  it('maps movement types to Sage transaction types', () => {
    const rows = csvRows(buildSageCsv([
      mv({ movement_type: 'receive', from_location: null, to_location: WAREHOUSE }),
      mv({ movement_type: 'transfer', from_location: TRUCK1, to_location: BUCKET }),
      mv({ movement_type: 'return', from_location: TRUCK1, to_location: WAREHOUSE }),
      mv({ movement_type: 'issue', from_location: TRUCK1, to_location: null }),
      mv({ movement_type: 'scrap', from_location: TRUCK1, to_location: null }),
    ]))
    expect(rows.map(r => r[col('TRANSACTIONTYPE')])).toEqual([
      'Inventory Receipt',
      'Inventory Transfer',
      'Inventory Transfer', // return also exports as a transfer
      'Inventory Issue',
      'Inventory Adjustment', // scrap
    ])
  })

  it('dates by the effective work date: occurred_at wins over created_at, YYYY-MM-DD', () => {
    const rows = csvRows(buildSageCsv([
      mv({ occurred_at: '2026-06-01T08:00:00.000Z', created_at: '2026-07-02T12:00:00.000Z' }),
      mv({ occurred_at: null, created_at: '2026-06-15T10:30:00.000Z' }),
    ]))
    expect(rows[0][col('DATE')]).toBe('2026-06-01')
    expect(rows[1][col('DATE')]).toBe('2026-06-15')
  })

  it('numbers LINE over included rows only (exclusions leave no gap)', () => {
    const rows = csvRows(buildSageCsv([
      mv({ from_location: TRUCK1, to_location: BUCKET }),
      mv({ from_location: TRUCK1, to_location: TRUCK2 }), // excluded
      mv({ movement_type: 'adjust', from_location: null, to_location: WAREHOUSE }), // excluded
      mv({ from_location: TRUCK1, to_location: BUCKET }),
    ]))
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r[col('LINE')])).toEqual(['1', '2'])
  })

  it('builds REFERENCENO from submission when present, movement id otherwise', () => {
    const rows = csvRows(buildSageCsv([
      mv({ submission_id: 'abcdef12-3456-7890-aaaa-bbbbbbbbbbbb' }),
      mv({ id: '12345678-dead-beef-0000-000000000000', submission_id: null }),
    ]))
    expect(rows[0][col('REFERENCENO')]).toBe('SUB-abcdef12')
    expect(rows[1][col('REFERENCENO')]).toBe('MV-12345678')
  })

  it('fills item, qty, unit and falls back to the part unit', () => {
    const rows = csvRows(buildSageCsv([
      mv({ quantity: 7, unit: 'ft' }),
      mv({ unit: null, part: { ...PART, unit: 'lb' } }),
      mv({ unit: null, part: { ...PART, unit: null } }),
    ]))
    expect(rows[0][col('ITEMID')]).toBe('SKU-1')
    expect(rows[0][col('ITEMDESC')]).toBe('Lag Bolt')
    expect(rows[0][col('QUANTITY')]).toBe('7')
    expect(rows[0][col('UNIT')]).toBe('ft')
    expect(rows[1][col('UNIT')]).toBe('lb')
    expect(rows[2][col('UNIT')]).toBe('ea') // final fallback
  })

  it('is bin-aware on the destination: TO_WAREHOUSE blank, TO_BIN set', () => {
    const rows = csvRows(buildSageCsv([
      mv({ from_location: WAREHOUSE2, to_location: BIN_A }),
    ]))
    expect(rows[0][col('TO_WAREHOUSE')]).toBe('')
    expect(rows[0][col('TO_BIN')]).toBe('A-01')
    expect(rows[0][col('FROM_WAREHOUSE')]).toBe('North Warehouse')
  })

  it('derives PROJECTID/CLASSID from the phase, falling back to the job_site bucket', () => {
    const phased = mv({
      phase: { id: 'ph1', name: 'Phase 2', project_id: 'p1', project: { id: 'p1', name: 'Heber' } },
      to_location: WAREHOUSE2, from_location: WAREHOUSE,
    })
    const bucketed = mv({ phase: null, from_location: TRUCK1, to_location: BUCKET })
    const neither = mv({ phase: null, from_location: WAREHOUSE, to_location: WAREHOUSE2 })
    const rows = csvRows(buildSageCsv([phased, bucketed, neither]))
    expect(rows[0][col('PROJECTID')]).toBe('Heber')
    expect(rows[0][col('CLASSID')]).toBe('Phase 2')
    expect(rows[1][col('PROJECTID')]).toBe('Heber') // bucket name fallback
    expect(rows[1][col('CLASSID')]).toBe('')
    expect(rows[2][col('PROJECTID')]).toBe('')
  })

  it('parses VENDORID from receive notes only', () => {
    const rows = csvRows(buildSageCsv([
      mv({ movement_type: 'receive', from_location: null, to_location: WAREHOUSE, notes: 'Vendor: Graybar | inv 123' }),
      mv({ notes: 'Vendor: Graybar' }), // transfer — vendor parse skipped
    ]))
    expect(rows[0][col('VENDORID')]).toBe('Graybar')
    expect(rows[1][col('VENDORID')]).toBe('')
  })

  it('CSV-escapes fields containing commas and quotes', () => {
    const rows = csvRows(buildSageCsv([
      mv({
        notes: 'auto-deduct: 5x "Lag Bolt", approved',
        part: { ...PART, name: 'Bolt, Machine 1/2' },
      }),
    ]))
    expect(rows[0][col('ITEMDESC')]).toBe('Bolt, Machine 1/2')
    expect(rows[0][col('MEMO')]).toBe('auto-deduct: 5x "Lag Bolt", approved')
    expect(rows[0]).toHaveLength(18) // escaping kept the column count intact
  })

  it('returns a header-only CSV for an empty movement list', () => {
    expect(buildSageCsv([])).toBe(HEADERS.join(','))
  })

  it('forwards opts to the exclusion filter (strictConsumption)', () => {
    const loadout = mv({ from_location: WAREHOUSE, to_location: TRUCK1 })
    expect(csvRows(buildSageCsv([loadout]))).toHaveLength(1)
    expect(csvRows(buildSageCsv([loadout], { strictConsumption: true }))).toHaveLength(0)
  })
})

// ─── movementEffectiveDate ───────────────────────────────────────────────────

describe('movementEffectiveDate', () => {
  it('prefers occurred_at, falls back to created_at, then null', () => {
    expect(movementEffectiveDate({ occurred_at: 'A', created_at: 'B' })).toBe('A')
    expect(movementEffectiveDate({ occurred_at: null, created_at: 'B' })).toBe('B')
    expect(movementEffectiveDate({})).toBe(null)
    expect(movementEffectiveDate(null)).toBe(null)
  })
})

describe('aggregateDeductions (negative-stock pre-flight)', () => {
  const mv = (part_id, from_location_id, quantity, extra = {}) =>
    ({ part_id, from_location_id, quantity, ...extra })

  it('sums several lines that hit the SAME part+location', () => {
    // The case that matters: each line alone may be affordable while the
    // batch as a whole overdraws the location.
    const out = aggregateDeductions([
      mv('P1', 'L1', 5),
      mv('P1', 'L1', 7),
      mv('P1', 'L2', 3),
    ])
    expect(out).toEqual({ 'P1|L1': 12, 'P1|L2': 3 })
  })

  it('ignores rows with no source — receives and positive adjusts', () => {
    expect(aggregateDeductions([
      { part_id: 'P1', to_location_id: 'L1', quantity: 50 },            // receive
      { part_id: 'P1', from_location_id: null, quantity: 10 },          // positive adjust
    ])).toEqual({})
  })

  it('ignores non-positive and unparseable quantities', () => {
    expect(aggregateDeductions([
      mv('P1', 'L1', 0),
      mv('P1', 'L1', -5),
      mv('P1', 'L1', null),
      mv('P1', 'L1', 'abc'),
    ])).toEqual({})
  })

  it('coerces numeric strings, as the sheets hand them over', () => {
    expect(aggregateDeductions([mv('P1', 'L1', '90'), mv('P1', 'L1', '9')]))
      .toEqual({ 'P1|L1': 99 })
  })

  it('skips rows missing a part id', () => {
    expect(aggregateDeductions([{ from_location_id: 'L1', quantity: 5 }])).toEqual({})
  })

  it('keeps different parts at one location apart', () => {
    expect(aggregateDeductions([mv('P1', 'L1', 2), mv('P2', 'L1', 3)]))
      .toEqual({ 'P1|L1': 2, 'P2|L1': 3 })
  })

  it('survives empty/missing input', () => {
    expect(aggregateDeductions([])).toEqual({})
    expect(aggregateDeductions(undefined)).toEqual({})
    expect(aggregateDeductions([null, undefined])).toEqual({})
  })
})
