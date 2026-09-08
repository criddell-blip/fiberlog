// ─── Sonar job index: which job was an asset assigned on? ───────────────────
//
// The asset-consumption report (ONTs / routers by tag) has no job-type column.
// The fiber-jobs report (one row per completed job) does. They meet only on
// the Sonar account and the date — and the asset is usually assigned 0–3 days
// BEFORE dispatch closes the job. This module builds a per-account index from
// raw fiber-jobs CSVs and answers "nearest job to this assignment" so the
// asset importer can tell a fix-job ONT from an install ONT.
//
// Pure (no Supabase) — it decides which ledger a unit lands in, so it is
// unit-tested against the real August 2026 shapes.
import { parseCsv } from './csvImport'

export const JOB_TYPE_COL = 'Job Type | Name'
export const JOB_ACCOUNT_COL = 'Account | ID'
export const JOB_DATE_COL = 'Job | Completion Date time'

// Same normalisation the fiber-jobs importer uses for its dedup key.
export function normalizeJobType(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_')
}

// rows: parsed CSV row objects from ANY number of deliveries (they overlap —
// the same job appears in several daily reports). Deduped on
// account + completion date + normalised type.
// Returns Map<account, Array<{ account, date, jobType, jobTypeRaw, project, address }>>
export function jobIndexFromRows(rows) {
  const index = new Map()
  const seen = new Set()
  for (const row of rows || []) {
    const account = String(row[JOB_ACCOUNT_COL] || '').trim()
    const date = String(row[JOB_DATE_COL] || '').slice(0, 10)
    const jobTypeRaw = String(row[JOB_TYPE_COL] || '').trim()
    if (!account || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !jobTypeRaw) continue
    const jobType = normalizeJobType(jobTypeRaw)
    const key = `${account}_${date}_${jobType}`
    if (seen.has(key)) continue
    seen.add(key)
    const job = {
      account, date, jobType, jobTypeRaw,
      project: String(row['Project'] || '').trim(),
      address: String(row['Job | Address on Completion'] || '').trim(),
    }
    if (!index.has(account)) index.set(account, [])
    index.get(account).push(job)
  }
  return index
}

export function buildSonarJobIndex(csvTexts) {
  const rows = []
  for (const text of csvTexts || []) {
    if (!text) continue
    try { rows.push(...parseCsv(text).rows) } catch (e) { /* a bad delivery just contributes nothing */ }
  }
  return jobIndexFromRows(rows)
}

// Nearest job for an account to an asset-assignment date. Window is
// asymmetric because assets precede completion: default 2 days before the
// assignment through 7 days after. Ties (same distance either side) go to the
// LATER job — the one the asset was staged for.
//   assetDate: 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (naive Denver wall time)
export function nearestSonarJob(index, account, assetDate, { before = 2, after = 7 } = {}) {
  if (!index || !account) return null
  const jobs = index.get(String(account).trim())
  if (!jobs || jobs.length === 0) return null
  const a = dayNumber(String(assetDate || '').slice(0, 10))
  if (a == null) return null
  let best = null, bestDist = Infinity, bestDelta = 0
  for (const j of jobs) {
    const d = dayNumber(j.date)
    if (d == null) continue
    const delta = d - a          // +N = job closed N days after the asset went out
    if (delta < -before || delta > after) continue
    const dist = Math.abs(delta)
    if (dist < bestDist || (dist === bestDist && delta > bestDelta)) {
      best = j; bestDist = dist; bestDelta = delta
    }
  }
  return best
}

// Days since epoch for a naive 'YYYY-MM-DD' — no timezone involved, so two
// Denver wall dates compare exactly.
function dayNumber(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '')
  if (!m) return null
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000)
}
