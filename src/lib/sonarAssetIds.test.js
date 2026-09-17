import { describe, it, expect } from 'vitest'
import { extractItemIdFromValueList, parseSonarValueList, formatSonarLineNote, sonarLineNoteFromValueList, isMacLike, sonarAssetIdFromMovement } from './sonarAssetIds'

describe('extractItemIdFromValueList', () => {
  it('returns the first 3+-digit token (the dedup key must never shift)', () => {
    expect(extractItemIdFromValueList('92858 | CXNK0125B87D | 04:BC:9F:4D:AD:8B | 59995')).toBe('92858')
    expect(extractItemIdFromValueList('92858 | 92858 | CXNK0125B87D | CXNK0125B87D')).toBe('92858')
  })
  it('falls back to the first token, then empty', () => {
    expect(extractItemIdFromValueList('CXNK0125B87D | 04:BC:9F:4D:AD:8B')).toBe('CXNK0125B87D')
    expect(extractItemIdFromValueList('')).toBe('')
    expect(extractItemIdFromValueList(null)).toBe('')
  })
})

describe('parseSonarValueList', () => {
  it('classifies the four-field GigaSpire shape (tag, serial, MAC, alt tag)', () => {
    const p = parseSonarValueList('92858 | 92858 | CXNK0125B87D | CXNK0125B87D | 04:BC:9F:4D:AD:8B | 04:BC:9F:4D:AD:8B | 59995 | 59995')
    expect(p).toEqual({ assetTag: '92858', serial: 'CXNK0125B87D', mac: '04:BC:9F:4D:AD:8B', altTag: '59995', other: [] })
  })
  it('handles Calix ONTs whose MAC has no separators', () => {
    const p = parseSonarValueList('103046 | 103046 | CXNK01EF4D4E | CXNK01EF4D4E | 88DA3619E361 | 88DA3619E361')
    expect(p.assetTag).toBe('103046')
    expect(p.serial).toBe('CXNK01EF4D4E')
    expect(p.mac).toBe('88DA3619E361')
    expect(p.altTag).toBeNull()
  })
  it('handles wireless radios with MAC only', () => {
    const p = parseSonarValueList('103142 | 6C:63:F8:A3:65:83')
    expect(p).toEqual({ assetTag: '103142', serial: null, mac: '6C:63:F8:A3:65:83', altTag: null, other: [] })
  })
  it('handles the old MAC-then-alt-tag shape with no serial', () => {
    const p = parseSonarValueList('55452 | 00:27:22:DA:A7:E1 | 34799')
    expect(p).toEqual({ assetTag: '55452', serial: null, mac: '00:27:22:DA:A7:E1', altTag: '34799', other: [] })
  })
  it('uppercases lowercase MACs and serials so search hits either spelling', () => {
    const p = parseSonarValueList('99834 | CXNK01BC27C4 | e4:6c:d1:c3:07:aa')
    expect(p.mac).toBe('E4:6C:D1:C3:07:AA')
  })
  it('keeps unrecognised tokens instead of dropping them', () => {
    const p = parseSonarValueList('100 | ab | 200 | 300')
    expect(p.assetTag).toBe('100')
    expect(p.altTag).toBe('200')
    expect(p.other).toEqual(['ab', '300'])
  })
  it('returns an empty shape for blank input', () => {
    expect(parseSonarValueList('')).toEqual({ assetTag: null, serial: null, mac: null, altTag: null, other: [] })
    expect(parseSonarValueList(undefined).assetTag).toBeNull()
  })
})

describe('isMacLike', () => {
  it('accepts colon, dash and bare-hex forms', () => {
    expect(isMacLike('04:BC:9F:4D:AD:8B')).toBe(true)
    expect(isMacLike('04-BC-9F-4D-AD-8B')).toBe(true)
    expect(isMacLike('88DA3619E361')).toBe(true)
  })
  it('rejects serials that contain non-hex letters', () => {
    expect(isMacLike('CXNK0125B87D')).toBe(false)
    expect(isMacLike('AV2510164823')).toBe(false)
  })
})

describe('formatSonarLineNote', () => {
  it('renders the labelled note in a fixed order', () => {
    expect(sonarLineNoteFromValueList('92858 | CXNK0125B87D | 04:BC:9F:4D:AD:8B | 59995'))
      .toBe('Tag 92858 · SN CXNK0125B87D · MAC 04:BC:9F:4D:AD:8B · Alt tag 59995')
  })
  it('omits absent fields', () => {
    expect(sonarLineNoteFromValueList('103142 | 6C:63:F8:A3:65:83')).toBe('Tag 103142 · MAC 6C:63:F8:A3:65:83')
  })
  it('returns null when nothing usable was present', () => {
    expect(formatSonarLineNote(parseSonarValueList(''))).toBeNull()
    expect(sonarLineNoteFromValueList(null)).toBeNull()
  })
})

describe('sonarAssetIdFromMovement', () => {
  it('reads the importer marker, even with no line_note', () => {
    expect(sonarAssetIdFromMovement({ notes: 'Sonar install · 2026-08-03 10:37 · PAYSON · [sonar:93380]', line_note: null })).toBe('93380')
  })
  it('falls back to the Tag prefix on a reclass row (own notes, copied line_note)', () => {
    expect(sonarAssetIdFromMovement({
      notes: 'Reclass: fix job (Drop Fix 2026-08-03, acct 140697) [reclass:07655b83]',
      line_note: 'Tag 93380 · SN CXNK011DCE09 · MAC B8:94:70:DB:11:9D · Alt tag 60519',
    })).toBe('93380')
  })
  it('prefers the marker when both are present', () => {
    expect(sonarAssetIdFromMovement({ notes: '[sonar:111222]', line_note: 'Tag 333444 · SN X' })).toBe('111222')
  })
  it('never returns the account from the composite fallback key', () => {
    expect(sonarAssetIdFromMovement({ notes: 'Sonar install · [sonar:140647-2026-08-03 11:46]', line_note: null })).toBe('')
  })
  it('ignores fiber-jobs markers and free-text infra tags', () => {
    expect(sonarAssetIdFromMovement({ notes: '[sonar_jobs:141195_2026-06-10_drop_fix]', line_note: null })).toBe('')
    expect(sonarAssetIdFromMovement({ notes: 'Auto-deduct', line_note: '55123, 55124' })).toBe('')
  })
  it('is blank-safe', () => {
    expect(sonarAssetIdFromMovement(null)).toBe('')
    expect(sonarAssetIdFromMovement({})).toBe('')
  })
})
