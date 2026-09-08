import { describe, it, expect } from 'vitest'
import { buildSonarJobIndex, jobIndexFromRows, nearestSonarJob, normalizeJobType } from './sonarJobIndex.js'

const HDR = 'Job | Address on Completion,Job Type | Name,Job | Completion Notes,Account | ID,User | Username,Job | Completion Date time,Project,Account | Name'
const line = (addr, type, acct, date, proj = 'West Mountain Fiber', name = 'X') =>
  `"${addr}",${type},,${acct},thorrocks,${date},${proj},${name}`

// Real August 2026 West Mountain shapes.
const deliveryA = [
  HDR,
  line('6033 W 8800 S, PAYSON, UT 84651', 'Fiber Install', '140420', '2026-08-23'),          // Karla: ONT 8/20
  line('8806 S 6200 W, PAYSON, UT 84651', 'Fiber Install with Router', '140379', '2026-08-28'), // Troy: ONT 8/26
  line('9105 S 6200 W, PAYSON, UT 84651', 'Fiber Fix', '138163', '2026-08-04'),               // Cooper: ONT 8/3
  line('8958 S 6000 W, PAYSON, UT 84651', 'Fiber Install with Router', '139587', '2026-08-18'), // Russel Smith install
  line('8958 S 6000 W, PAYSON, UT 84651', 'Drop Fix', '139587', '2026-08-21'),                // Russel Smith 2nd ONT 8/21
].join('\n')
const deliveryB = [   // overlapping re-delivery of two of the same jobs
  HDR,
  line('6033 W 8800 S, PAYSON, UT 84651', 'Fiber Install', '140420', '2026-08-23'),
  line('8958 S 6000 W, PAYSON, UT 84651', 'Drop Fix', '139587', '2026-08-21'),
  line('', 'Drop Fix', '', '2026-08-21'),                                                       // blank account → ignored
].join('\n')

describe('buildSonarJobIndex', () => {
  const idx = buildSonarJobIndex([deliveryA, deliveryB, '', null])
  it('dedupes the same job across overlapping deliveries', () => {
    expect(idx.get('140420')).toHaveLength(1)
    expect(idx.get('139587')).toHaveLength(2)
  })
  it('ignores rows with a blank account', () => {
    expect(idx.has('')).toBe(false)
  })
  it('normalises the job type like the fiber-jobs dedup key', () => {
    expect(idx.get('138163')[0].jobType).toBe('fiber_fix')
    expect(normalizeJobType('Fiber Install with Router')).toBe('fiber_install_with_router')
  })
})

describe('nearestSonarJob', () => {
  const idx = buildSonarJobIndex([deliveryA])
  it('matches an ONT assigned days BEFORE the install closed (Karla 8/20 → 8/23, Troy 8/26 → 8/28)', () => {
    expect(nearestSonarJob(idx, '140420', '2026-08-20 15:12:18')?.jobTypeRaw).toBe('Fiber Install')
    expect(nearestSonarJob(idx, '140379', '2026-08-26 15:03:03')?.jobTypeRaw).toBe('Fiber Install with Router')
  })
  it('matches an ONT swapped the day before a Fiber Fix closed (Cooper 8/3 → 8/4)', () => {
    expect(nearestSonarJob(idx, '138163', '2026-08-03')?.jobTypeRaw).toBe('Fiber Fix')
  })
  it('picks the nearest job when an account has several (Russel Smith)', () => {
    expect(nearestSonarJob(idx, '139587', '2026-08-21')?.jobTypeRaw).toBe('Drop Fix')       // same day
    expect(nearestSonarJob(idx, '139587', '2026-08-18')?.jobTypeRaw).toBe('Fiber Install with Router')
    expect(nearestSonarJob(idx, '139587', '2026-08-17')?.jobTypeRaw).toBe('Fiber Install with Router') // 1 day early
  })
  it('breaks a tie toward the later job (the one the asset was staged for)', () => {
    // 8/19–8/20 sit between install (8/18) and drop fix (8/21): 8/19 is 1 day after the
    // install and 2 before the fix → install; 8/20 is 2 after / 1 before → fix.
    expect(nearestSonarJob(idx, '139587', '2026-08-19')?.jobTypeRaw).toBe('Fiber Install with Router')
    expect(nearestSonarJob(idx, '139587', '2026-08-20')?.jobTypeRaw).toBe('Drop Fix')
    const tie = jobIndexFromRows([
      { 'Account | ID': '1', 'Job | Completion Date time': '2026-08-10', 'Job Type | Name': 'Fiber Install' },
      { 'Account | ID': '1', 'Job | Completion Date time': '2026-08-12', 'Job Type | Name': 'Drop Fix' },
    ])
    expect(nearestSonarJob(tie, '1', '2026-08-11')?.jobTypeRaw).toBe('Drop Fix')
  })
  it('returns null outside the window (asset 10 days early, or 3 days after) and for unknown accounts', () => {
    expect(nearestSonarJob(idx, '140420', '2026-08-13')).toBeNull()
    expect(nearestSonarJob(idx, '140420', '2026-08-26')).toBeNull()
    expect(nearestSonarJob(idx, '999999', '2026-08-20')).toBeNull()
    expect(nearestSonarJob(idx, '', '2026-08-20')).toBeNull()
    expect(nearestSonarJob(null, '140420', '2026-08-20')).toBeNull()
  })
  it('honours a custom window', () => {
    expect(nearestSonarJob(idx, '140420', '2026-08-13', { before: 2, after: 14 })?.jobTypeRaw).toBe('Fiber Install')
  })
})
