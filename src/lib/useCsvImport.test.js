// Unit tests for the pure marker parser behind the already-imported dedup
// (Sonar field-tech + fiber-jobs importers). The markers written by the
// importers look like:
//   field-tech:  [sonar:1234567]
//   field-tech (composite key): [sonar:9981-2026-06-24 08:00]
//   fiber-jobs:  [sonar_jobs:4521_2026-06-20_drop_fix]
// A false positive here silently SKIPS a real import row; a false negative
// double-imports it. Both are stock errors, hence the coverage.
import { describe, it, expect } from 'vitest'
import { extractMarkerKeys } from './useCsvImport'

const rows = (...notes) => notes.map(n => ({ notes: n }))

describe('extractMarkerKeys', () => {
  it('extracts a simple numeric field-tech marker', () => {
    const keys = extractMarkerKeys(rows('Sonar install · [sonar:1234567]'), 'sonar')
    expect(keys).toEqual(new Set(['1234567']))
  })

  it('extracts a composite key containing dashes and spaces', () => {
    const keys = extractMarkerKeys(rows('[sonar:9981-2026-06-24 08:00]'), 'sonar')
    expect(keys).toEqual(new Set(['9981-2026-06-24 08:00']))
  })

  it('extracts fiber-jobs markers with the sonar_jobs prefix', () => {
    const keys = extractMarkerKeys(
      rows('auto [sonar_jobs:4521_2026-06-20_drop_fix]'),
      'sonar_jobs'
    )
    expect(keys).toEqual(new Set(['4521_2026-06-20_drop_fix']))
  })

  it('prefix "sonar" does NOT match [sonar_jobs:...] markers', () => {
    // Load-bearing: the two importers share the notes column. If the
    // field-tech dedup set swallowed fiber-jobs keys (or vice versa) the
    // importers would cross-contaminate their skip lists.
    const keys = extractMarkerKeys(
      rows('[sonar_jobs:4521_2026-06-20_drop_fix]'),
      'sonar'
    )
    expect(keys.size).toBe(0)
  })

  it('prefix "sonar_jobs" does not match plain [sonar:...] markers', () => {
    const keys = extractMarkerKeys(rows('[sonar:1234567]'), 'sonar_jobs')
    expect(keys.size).toBe(0)
  })

  it('collects every marker when a note holds more than one', () => {
    const keys = extractMarkerKeys(
      rows('merged: [sonar:111] and [sonar:222]'),
      'sonar'
    )
    expect(keys).toEqual(new Set(['111', '222']))
  })

  it('aggregates across rows and dedupes repeated keys', () => {
    const keys = extractMarkerKeys(
      rows('[sonar:111]', '[sonar:222]', 'again [sonar:111]'),
      'sonar'
    )
    expect(keys).toEqual(new Set(['111', '222']))
  })

  it('trims whitespace inside the key', () => {
    const keys = extractMarkerKeys(rows('[sonar: 123 ]'), 'sonar')
    expect(keys).toEqual(new Set(['123']))
  })

  it('tolerates null/undefined notes and empty row lists', () => {
    expect(extractMarkerKeys(rows(null, undefined, ''), 'sonar').size).toBe(0)
    expect(extractMarkerKeys([], 'sonar').size).toBe(0)
  })

  it('ignores prose that mentions sonar without the bracket marker', () => {
    const keys = extractMarkerKeys(
      rows('Sonar install · 2026-06-24 08:00 · Jane Doe'),
      'sonar'
    )
    expect(keys.size).toBe(0)
  })
})
