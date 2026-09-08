// Reclass primitive + ledger expansion (service projects, Sep 2026) — the
// pure pieces that decide how consumption moves between two project ledgers.
import { describe, it, expect } from 'vitest'
import {
  buildReclassPayload, expandConsumptionRow, consumptionSource, isExportableMovement, buildSageCsv,
} from './inventory'
import { movementDisplay, signedQty } from './movementDisplay'

describe('buildReclassPayload', () => {
  const region = (id, name) => ({ id, name, type: 'job_site' })
  const original = {
    id: 'orig-1', movement_type: 'transfer', part_id: 'GP1100X', quantity: 1, unit: 'ea',
    to_location_id: 'wm', to_location: region('wm', 'West Mountain'),
    occurred_at: '2026-08-21T21:27:00Z', created_at: '2026-09-02T10:00:00Z',
    consumed_by_user_id: 'u-taryn', sonar_account_id: '139587', line_note: 'Tag 93220 · SN X',
  }
  const ok = { toBucketId: 'wm-svc', phaseId: 'ph-svc', quantity: 1, reason: 'Drop Fix 8/21', userId: 'owner' }

  it('copies identity, dates the row like the original, links it and records the reason', () => {
    expect(buildReclassPayload(original, ok)).toEqual({
      movement_type: 'transfer', part_id: 'GP1100X', quantity: 1, unit: 'ea',
      from_location_id: 'wm', to_location_id: 'wm-svc',
      notes: 'Reclass: Drop Fix 8/21 [reclass:orig-1]',
      created_by: 'owner', occurred_at: '2026-08-21T21:27:00Z', phase_id: 'ph-svc',
      consumed_by_user_id: 'u-taryn', sonar_account_id: '139587', line_note: 'Tag 93220 · SN X',
      reclass_of: 'orig-1',
    })
  })
  it('rejects more than what is left, zero, negative and non-numeric quantities', () => {
    expect(() => buildReclassPayload({ ...original, quantity: 3 }, { ...ok, quantity: 2, alreadyReclassed: 2 })).toThrow(/Only 1 left/)
    expect(() => buildReclassPayload(original, { ...ok, quantity: 0 })).toThrow(/positive/)
    expect(() => buildReclassPayload(original, { ...ok, quantity: -1 })).toThrow(/positive/)
    expect(() => buildReclassPayload(original, { ...ok, quantity: 'x' })).toThrow(/positive/)
  })
  it('rejects the same Region, a non-Region target, a non-transfer original, a non-Region original, no reason, no user', () => {
    expect(() => buildReclassPayload(original, { ...ok, toBucketId: 'wm' })).toThrow(/same Region/)
    expect(() => buildReclassPayload(original, { ...ok, toBucketType: 'truck' })).toThrow(/must be a Region/)
    expect(() => buildReclassPayload({ ...original, movement_type: 'receive' }, ok)).toThrow(/consumption transfers/)
    expect(() => buildReclassPayload({ ...original, to_location: { id: 't', type: 'truck' } }, ok)).toThrow(/Region/)
    expect(() => buildReclassPayload(original, { ...ok, reason: '  ' })).toThrow(/reason/)
    expect(() => buildReclassPayload(original, { ...ok, userId: null })).toThrow(/signed in/)
  })
  it('a reclass row can itself be reclassed back (original = the reclass)', () => {
    const reclass = { ...original, id: 'rc-1', to_location_id: 'wm-svc', to_location: region('wm-svc', 'West Mountain - Service'), reclass_of: 'orig-1' }
    const back = buildReclassPayload(reclass, { ...ok, toBucketId: 'wm', reason: 'was an install after all' })
    expect(back.from_location_id).toBe('wm-svc')
    expect(back.to_location_id).toBe('wm')
    expect(back.reclass_of).toBe('rc-1')
  })
})

describe('expandConsumptionRow', () => {
  const wm = { id: 'wm', name: 'West Mountain', type: 'job_site', project: { id: 'p-wm', name: 'West Mountain' } }
  const svc = { id: 'svc', name: 'West Mountain - Service', type: 'job_site', project: { id: 'p-svc', name: 'West Mountain - Service' } }
  const truck = { id: 't', name: "Owen's Truck", type: 'truck' }
  it('plain consumption (truck → Region) is one positive row for the destination project', () => {
    const rows = expandConsumptionRow({ id: 'a', quantity: 2, from_location: truck, to_location: wm })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ledgerQty: 2, ledgerSide: 'in', ledgerProject: { id: 'p-wm' } })
  })
  it('Region → Region reclass is −qty on the old project and +qty on the new one, net zero', () => {
    const rows = expandConsumptionRow({ id: 'r', quantity: 1, from_location: wm, to_location: svc, reclass_of: 'a' })
    expect(rows.map(r => [r.ledgerSide, r.ledgerQty, r.ledgerProject.id])).toEqual([['in', 1, 'p-svc'], ['out', -1, 'p-wm']])
    expect(rows.reduce((s, r) => s + r.ledgerQty, 0)).toBe(0)
  })
  it('Region → truck reversal is the negative side only', () => {
    const rows = expandConsumptionRow({ id: 'x', quantity: 1, from_location: wm, to_location: truck })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ledgerQty: -1, ledgerSide: 'out' })
  })
  it('a legacy project-less Region yields a null ledgerProject (callers fall back to the name)', () => {
    const rows = expandConsumptionRow({ id: 'l', quantity: 1, from_location: truck, to_location: { id: 'lg', name: 'Region Heber', type: 'job_site' } })
    expect(rows[0].ledgerProject).toBeNull()
  })
})

describe('reclass rows in the Sage export + displays', () => {
  const wm = { id: 'wm', name: 'West Mountain', type: 'job_site' }
  const svc = { id: 'svc', name: 'West Mountain - Service', type: 'job_site' }
  const base = {
    id: 'rc-1', movement_type: 'transfer', quantity: 1, unit: 'ea', reclass_of: 'orig-1',
    occurred_at: '2026-08-21T21:27:00Z', created_at: '2026-09-08T10:00:00Z',
    part: { id: 'GP1100X', name: 'ONT', unit: 'ea', department: 'Customer Installation', sage_id: 'UB000342' },
    from_location: wm, to_location: svc, notes: 'Reclass: fix job [reclass:orig-1]',
  }
  it('Region → Region stays exportable with default options', () => {
    expect(isExportableMovement(base)).toBe(true)
  })
  it('exports one transfer line: FROM/TO are the two Regions, PROJECTID follows the Service phase, CLASSID its name', () => {
    const csv = buildSageCsv([{ ...base, phase: { id: 'ph', name: 'Service', project: { id: 'p', name: 'West Mountain - Service' } } }])
    const line = csv.split('\n')[1].split(',')
    expect(line[1]).toBe('2026-08-21')
    expect(line[9]).toBe('West Mountain')
    expect(line[10]).toBe('West Mountain - Service')
    expect(line[12]).toBe('West Mountain - Service')
    expect(line[13]).toBe('Service')
  })
  it('with no phase, PROJECTID falls back to the destination Region name (which IS the project)', () => {
    const line = buildSageCsv([{ ...base, phase: null }]).split('\n')[1].split(',')
    expect(line[12]).toBe('West Mountain - Service')
    expect(line[13]).toBe('')
  })
  it('consumptionSource reports reclass ahead of any marker the copied notes might carry', () => {
    expect(consumptionSource({ reclass_of: 'x', notes: 'Reclass: … [sonar:123]' })).toBe('reclass')
    expect(consumptionSource({ notes: '[sonar:123]' })).toBe('field-tech-sonar')
  })
  it('Activity labels the row Reclass and keeps transfer arithmetic', () => {
    const d = movementDisplay(base)
    expect(d.label).toBe('Reclass')
    expect(d.isReclass).toBe(true)
    expect(d.sign).toBe(1)
    expect(signedQty(base)).toBe(1)
    expect(movementDisplay({ ...base, reclass_of: null }).label).toBe('Transfer')
  })
})
