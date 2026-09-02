import { describe, it, expect } from 'vitest'
import { extractItemIdFromValueList, parseSonarValueList, formatSonarLineNote, sonarLineNoteFromValueList, isMacLike } from './sonarAssetIds'

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
