import { describe, it, expect } from 'vitest'
import { denverNaiveToIso } from './sonarDates'

describe('denverNaiveToIso', () => {
  it('interprets summer timestamps as MDT (UTC-6)', () => {
    // The Aug 28 2026 delivery's first row — booked wrong as 21:23Z by a
    // UTC-7 browser; correct Denver interpretation is 20:23Z.
    expect(denverNaiveToIso('2026-08-27 14:23:35')).toBe('2026-08-27T20:23:35.000Z')
  })

  it('interprets winter timestamps as MST (UTC-7)', () => {
    expect(denverNaiveToIso('2026-01-15 14:23:35')).toBe('2026-01-15T21:23:35.000Z')
  })

  it('treats date-only input as Denver midnight', () => {
    expect(denverNaiveToIso('2026-08-27')).toBe('2026-08-27T06:00:00.000Z')
    expect(denverNaiveToIso('2026-01-15')).toBe('2026-01-15T07:00:00.000Z')
  })

  it('accepts HH:MM without seconds', () => {
    expect(denverNaiveToIso('2026-08-27 14:23')).toBe('2026-08-27T20:23:00.000Z')
  })

  it('is DST-correct around the spring-forward boundary', () => {
    // 2026 spring forward: Mar 8, 02:00 MST → 03:00 MDT.
    expect(denverNaiveToIso('2026-03-07 12:00:00')).toBe('2026-03-07T19:00:00.000Z') // still MST
    expect(denverNaiveToIso('2026-03-08 12:00:00')).toBe('2026-03-08T18:00:00.000Z') // MDT
  })

  it('is DST-correct around the fall-back boundary', () => {
    // 2026 fall back: Nov 1, 02:00 MDT → 01:00 MST.
    expect(denverNaiveToIso('2026-10-31 12:00:00')).toBe('2026-10-31T18:00:00.000Z') // MDT
    expect(denverNaiveToIso('2026-11-01 12:00:00')).toBe('2026-11-01T19:00:00.000Z') // MST
  })

  it('returns null for garbage or non-string input', () => {
    expect(denverNaiveToIso('')).toBeNull()
    expect(denverNaiveToIso('not a date')).toBeNull()
    expect(denverNaiveToIso('08/27/2026 14:23')).toBeNull()
    expect(denverNaiveToIso(null)).toBeNull()
    expect(denverNaiveToIso(undefined)).toBeNull()
    expect(denverNaiveToIso(1724790000000)).toBeNull()
  })
})
