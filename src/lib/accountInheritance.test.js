import { describe, it, expect } from 'vitest'
import { applyAccountInheritance, groupRowsByAccount } from './accountInheritance.js'

const row = (over = {}) => ({
  idx: 0,
  accountId: '',
  date: '2026-08-06 12:00:00',
  partId: 'X',
  partName: 'Part X',
  destId: null,
  destName: null,
  destReason: null,
  phaseTagId: null,
  status: 'ask',
  ...over,
})

describe('applyAccountInheritance', () => {
  it('ask row inherits destination, phase tag, and reason from its resolved sibling', () => {
    const ont = row({ idx: 0, accountId: 'A1', partId: 'GP1100X', partName: 'ONT', status: 'ready', destId: 'pc', destName: 'Park City', phaseTagId: 'ph-snyderville' })
    const adapter = row({ idx: 1, accountId: 'A1', partId: '100-06062', partName: 'U6.3 Adapter' })
    const [, out] = applyAccountInheritance([ont, adapter])
    expect(out.status).toBe('ready')
    expect(out.destId).toBe('pc')
    expect(out.destName).toBe('Park City')
    expect(out.phaseTagId).toBe('ph-snyderville')
    expect(out.destReason).toBe('same account → follows ONT')
    expect(out.inheritedFromAccount).toBe(true)
  })

  it('stays ask when resolved siblings disagree on destination', () => {
    const a = row({ idx: 0, accountId: 'A1', status: 'ready', destId: 'pc' })
    const b = row({ idx: 1, accountId: 'A1', status: 'ready', destId: 'gigwave' })
    const adapter = row({ idx: 2, accountId: 'A1' })
    const out = applyAccountInheritance([a, b, adapter])[2]
    expect(out.status).toBe('ask')
    expect(out.destId).toBeNull()
  })

  it('stays ask with no resolved sibling or no account id', () => {
    const blockedSib = row({ idx: 0, accountId: 'A1', status: 'no-crew' })
    const adapter = row({ idx: 1, accountId: 'A1' })
    const orphan = row({ idx: 2, accountId: '' })
    const out = applyAccountInheritance([blockedSib, adapter, orphan])
    expect(out[1].status).toBe('ask')
    expect(out[2].status).toBe('ask')
  })

  it('does not touch non-ask statuses (explicit routing intent needs its mapping)', () => {
    const donor = row({ idx: 0, accountId: 'A1', status: 'ready', destId: 'pc' })
    const unmappedCity = row({ idx: 1, accountId: 'A1', status: 'city-unmapped' })
    const out = applyAccountInheritance([donor, unmappedCity])[1]
    expect(out.status).toBe('city-unmapped')
    expect(out.destId).toBeNull()
  })

  it('donors agreeing on bucket but not phase tag inherit the destination with a NULL phase', () => {
    // Two Sonar projects whose phases share a parent project resolve to the
    // same bucket with different phase tags — the phase must not coin-flip.
    const a = row({ idx: 0, accountId: 'A1', status: 'ready', destId: 'pc', destName: 'Park City', phaseTagId: 'ph-snyderville' })
    const b = row({ idx: 1, accountId: 'A1', status: 'ready', destId: 'pc', destName: 'Park City', phaseTagId: 'ph-pinebrook' })
    const adapter = row({ idx: 2, accountId: 'A1' })
    const out = applyAccountInheritance([a, b, adapter])[2]
    expect(out.status).toBe('ready')
    expect(out.destId).toBe('pc')
    expect(out.phaseTagId).toBeNull()
  })

  it('every ask row on the account inherits, and a manual-pick donor counts', () => {
    const manual = row({ idx: 0, accountId: 'A1', partName: 'Wave LR', status: 'ready', destId: 'gw', destName: 'Gigwave', destReason: 'manual pick' })
    const a1 = row({ idx: 1, accountId: 'A1' })
    const a2 = row({ idx: 2, accountId: 'A1' })
    const out = applyAccountInheritance([manual, a1, a2])
    expect(out[1].destId).toBe('gw')
    expect(out[2].destId).toBe('gw')
    expect(out[1].destReason).toBe('same account → follows Wave LR')
  })
})

describe('groupRowsByAccount', () => {
  it('pulls an account\'s rows together at the account\'s first chronological position', () => {
    const rows = [
      row({ idx: 0, accountId: 'A1', date: '2026-08-06 09:00' }),
      row({ idx: 1, accountId: 'A2', date: '2026-08-06 10:00' }),
      row({ idx: 2, accountId: 'A1', date: '2026-08-06 11:00' }),
    ]
    expect(groupRowsByAccount(rows).map(r => r.idx)).toEqual([0, 2, 1])
  })

  it('rows without an account id keep pure date order as singleton groups', () => {
    const rows = [
      row({ idx: 0, accountId: '', date: '2026-08-06 10:00' }),
      row({ idx: 1, accountId: '', date: '2026-08-06 09:00' }),
    ]
    expect(groupRowsByAccount(rows).map(r => r.idx)).toEqual([1, 0])
  })
})
