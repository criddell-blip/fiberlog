// Quarterly consumption enrichment — offline mirror of the two Sonar import sheets.
//
// Enriches the raw Sonar exports with what the app would have resolved (part SKU,
// user, source location, destination project/bucket) using the SAME rules as
// SonarImportSheet.jsx / FiberJobsImportSheet.jsx, against a snapshot of the live
// mapping tables (imports/quarterly-2026Q2/refs/). Rows that the app would make
// the manager decide are marked with a `needs` code, and each DISTINCT unresolved
// value gets one line in a decision sheet (imports/quarterly-2026Q2/decisions/).
// Fill the YOUR_PICK columns and re-run — picks are read back on the next run and
// carried forward, so re-running never loses work.
//
// Deliberate divergence from the app: already-imported rows ([sonar:…] marker
// already on a movement) are NOT skipped — they resolve normally and carry
// already_imported=yes, so quarterly totals stay complete while the FiberLog-
// ledger overlap stays visible.
//
// Usage: node scripts/quarterly-consumption.mjs
//
// Rule provenance (file:line refs are redesign/console @ 165fc55):
//   dedup             SonarImportSheet.jsx:234-265
//   part match        SonarImportSheet.jsx:306-322  (pre-run in SQL → refs/part-matches.json)
//   crew match        SonarImportSheet.jsx:293-304
//   city auto-seed    SonarImportSheet.jsx:325-338
//   project auto-seed SonarImportSheet.jsx:344-358
//   resolve ladder    SonarImportSheet.jsx:452-565
//   fiber user match  FiberJobsImportSheet.jsx:178-188
//   homeLocFor        FiberJobsImportSheet.jsx:199-204
//   fiber resolve     FiberJobsImportSheet.jsx:249-324
//   parseFiberRow     lib/inventory.js:1773-1821 (imported logic ported verbatim below)
//   markers           lib/useCsvImport.js:264-275

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCsv } from '../src/lib/csvImport.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = path.join(ROOT, 'imports', 'quarterly-2026Q2')
const REFS = path.join(BASE, 'refs')
const DECISIONS = path.join(BASE, 'decisions')
const OUT = path.join(BASE, 'out')

const ASSET_CSV = path.join(ROOT, 'imports', 'Field tech asset consumption (2).csv')
const FIBER_CSV = path.join(ROOT, 'imports', 'All fiber all jobs (5).csv')

const Q_START = '2026-04-01'
const Q_END = '2026-06-30'

// ─── HELPERS PORTED FROM THE APP ─────────────────────────────────────────

// SonarImportSheet.jsx:57-60
function extractFirstName(sonarLoc) {
  const m = /\(([^)]+)\)/.exec(sonarLoc || '')
  return m ? m[1].trim() : null
}

// SonarImportSheet.jsx:67-80
function parseCityFromFullAddress(full) {
  if (!full || typeof full !== 'string') return ''
  const parts = full.split(',').map(s => s.trim()).filter(Boolean)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(parts[i])) {
      if (i > 0) return parts[i - 1]
    }
  }
  if (parts.length >= 2) return parts[parts.length - 2]
  return ''
}

// SonarImportSheet.jsx:86-93
function extractItemIdFromValueList(valueList) {
  if (!valueList || typeof valueList !== 'string') return ''
  const tokens = valueList.split('|').map(s => s.trim()).filter(Boolean)
  for (const t of tokens) {
    if (/^\d{3,}$/.test(t)) return t
  }
  return tokens[0] || ''
}

// lib/inventory.js:1704-1708
const FIBER_NA_VALUES = new Set(['', 'n/a', 'na', 'n/a.', 'none', 'no', '-', '--'])
function isFiberValueIgnored(v) {
  return FIBER_NA_VALUES.has((v || '').trim().toLowerCase())
}

// lib/inventory.js:1760-1764
function extractFirstNumber(text) {
  if (!text) return null
  const m = /(-?\d+(?:\.\d+)?)/.exec(String(text))
  return m ? parseFloat(m[1]) : null
}

// lib/inventory.js:1826-1835
const FIBER_NON_MATERIAL_COLUMNS = new Set([
  'Job | Address on Completion',
  'Job Type | Name',
  'Job | Completion Notes',
  'Account | ID',
  'User | Username',
  'Job | Completion Date time',
  'Project',
  'length of flat used',
])

// lib/inventory.js:1773-1821
function parseFiberRow(row, fiberValueMap, columnsConsidered = null) {
  const cols = columnsConsidered || Object.keys(row || {})
  const out = []
  for (const col of cols) {
    const raw = (row[col] != null ? String(row[col]) : '').trim()
    if (isFiberValueIgnored(raw)) {
      out.push({ columnName: col, valueText: raw, sku: null, qty: 0, qtyMode: 'ignore', status: 'ignore', reason: 'N/A or blank' })
      continue
    }
    const key = `${col}::${raw.toLowerCase()}`
    const map = fiberValueMap?.get(key)
    if (!map) {
      out.push({ columnName: col, valueText: raw, sku: null, qty: 0, qtyMode: null, status: 'unmapped', reason: 'No mapping' })
      continue
    }
    if (map.qty_mode === 'ignore') {
      out.push({ columnName: col, valueText: raw, sku: null, qty: 0, qtyMode: 'ignore', status: 'ignore', reason: 'Mapped to ignore' })
      continue
    }
    let qty = map.default_qty || 1
    if (map.qty_mode === 'fixed_unit') {
      qty = 1
    } else if (map.qty_mode === 'length_from_text') {
      const n = extractFirstNumber(raw)
      if (n == null) {
        out.push({ columnName: col, valueText: raw, sku: map.sku, qty: 0, qtyMode: map.qty_mode, status: 'manual', reason: 'No number in value — enter qty' })
        continue
      }
      qty = n
    } else if (map.qty_mode === 'pair_with_column') {
      const pairRaw = (row[map.pair_column] != null ? String(row[map.pair_column]) : '').trim()
      const n = extractFirstNumber(pairRaw)
      if (n == null) {
        out.push({ columnName: col, valueText: raw, sku: map.sku, qty: 0, qtyMode: map.qty_mode, status: 'pair-missing', reason: `Paired column "${map.pair_column}" had no number` })
        continue
      }
      qty = n
    } else if (map.qty_mode === 'manual') {
      out.push({ columnName: col, valueText: raw, sku: map.sku, qty: 0, qtyMode: map.qty_mode, status: 'manual', reason: 'Manual qty required' })
      continue
    }
    if (qty > 0 && map.sku) {
      out.push({ columnName: col, valueText: raw, sku: map.sku, qty, qtyMode: map.qty_mode, status: 'ready' })
    } else {
      out.push({ columnName: col, valueText: raw, sku: map.sku || null, qty, qtyMode: map.qty_mode, status: 'manual', reason: qty <= 0 ? 'Qty is zero — enter qty' : 'No SKU configured' })
    }
  }
  return out
}

// ─── IO HELPERS ──────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function csvEscape(v) {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function writeCsv(file, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
  for (const r of rows) lines.push(headers.map(h => csvEscape(r[h])).join(','))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n', 'utf8')
}

// Read a decision sheet if it exists; returns array of row objects (or []).
function readDecisionCsv(name) {
  const file = path.join(DECISIONS, name)
  if (!fs.existsSync(file)) return []
  return parseCsv(fs.readFileSync(file, 'utf8')).rows
}

const pick = v => (v == null ? '' : String(v).trim())

// ─── LOAD REFS ───────────────────────────────────────────────────────────

const usersRef = readJson(path.join(REFS, 'users.json'))
const locsRef = readJson(path.join(REFS, 'locations.json'))
const phasesRef = readJson(path.join(REFS, 'phases.json'))
const mapsRef = readJson(path.join(REFS, 'maps.json'))
const markersRef = readJson(path.join(REFS, 'markers.json'))
const partMatches = readJson(path.join(REFS, 'part-matches.json'))
const nameResolutions = fs.existsSync(path.join(REFS, 'name-resolutions.json'))
  ? readJson(path.join(REFS, 'name-resolutions.json')).resolutions : {}

// Turn a human name into a stable NEW-<slug> SKU for parts not in the catalog.
function mintNewSku(name) {
  const slug = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
  return 'NEW-' + (slug || 'PART')
}
// Resolve a typed YOUR_PICK_name → { sku, name, unit, routing }. Uses the
// verified name-resolutions map (catalog match), else mints a NEW- draft part.
function resolveTypedName(nm) {
  const hit = nameResolutions[nm.toLowerCase()]
  if (hit) return hit
  return { sku: mintNewSku(nm), name: nm, unit: 'ea', routing: 'ask', method: 'new' }
}

// Levenshtein (small strings) — tolerate typos in decision-sheet user names.
function lev(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase()
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}
// Resolve a typed user name → user id: exact → email-prefix → levenshtein<=2.
function resolveTypedUser(nm) {
  const t = nm.toLowerCase()
  let u = users.find(x => x.name.toLowerCase() === t) ||
          users.find(x => (x.email || '').toLowerCase().startsWith(t + '@'))
  if (u) return u
  const near = users.map(x => ({ x, d: lev(x.name, nm) })).filter(o => o.d <= 2).sort((a, b) => a.d - b.d)
  return near.length ? near[0].x : null
}
// Resolve a typed location name → id: exact (ci) → unique active-location substring.
function resolveTypedLocation(nm) {
  const t = nm.toLowerCase()
  const exact = locations.find(l => l.name.toLowerCase() === t)
  if (exact) return exact
  const subs = locations.filter(l => l.is_active && l.name.toLowerCase().includes(t))
  return subs.length === 1 ? subs[0] : null
}

// users ordered by name (as the app loads them)
const users = usersRef.rows.map(([id, name, email, role, crew_type, pull]) => ({ id, name, email, role, crew_type, default_pull_location_id: pull }))
const usersById = new Map(users.map(u => [u.id, u]))

const locations = locsRef.rows.map(([id, name, type, assigned_to, project_id, is_active]) => ({ id, name, type, assigned_to, project_id, is_active }))
const locsById = new Map(locations.map(l => [l.id, l]))
const locsByNameLower = new Map()
for (const l of locations) if (l.is_active) locsByNameLower.set(l.name.toLowerCase(), l)
const activeLocIds = new Set(locations.filter(l => l.is_active).map(l => l.id))

// trucksByUser: active trucks with assigned_to (SonarImportSheet.jsx:169-173,195-197)
const trucksByUser = {}
for (const l of locations) if (l.type === 'truck' && l.is_active && l.assigned_to) trucksByUser[l.assigned_to] = l.id

// buckets: active job_site locations, name order (SonarImportSheet.jsx:178-182)
const buckets = locations.filter(l => l.type === 'job_site' && l.is_active).sort((a, b) => a.name.localeCompare(b.name))
const bucketsById = new Map(buckets.map(b => [b.id, b]))

// phases with project + bucket (mirrors getPhasesWithBuckets)
const phases = phasesRef.rows.map(([id, name, project_id, project_name, bucket_id, bucket_name]) => ({ id, name, project_id, project_name, bucket_id, bucket_name }))
const phasesById = new Map(phases.map(p => [p.id, p]))

// markers
const markerKeys = new Set(markersRef.keys)
const importedAssetIds = new Set([...markerKeys].filter(k => k.startsWith('sonar:')).map(k => k.slice('sonar:'.length)))
const importedFiberKeys = new Set([...markerKeys].filter(k => k.startsWith('sonar_jobs:')).map(k => k.slice('sonar_jobs:'.length)))

// ─── LOAD DECISION PICKS (round 2+) ──────────────────────────────────────

const decAssetParts = readDecisionCsv('decisions-asset-parts.csv')
const decFiberValues = readDecisionCsv('decisions-fiber-values.csv')
const decProjects = readDecisionCsv('decisions-projects.csv')
const decCities = readDecisionCsv('decisions-cities.csv')
const decUsers = readDecisionCsv('decisions-users.csv')
const decRouting = readDecisionCsv('decisions-routing.csv')
const decRowQty = readDecisionCsv('decisions-row-qty.csv')

// ─── ASSET SHEET PIPELINE ────────────────────────────────────────────────

const assetParsed = parseCsv(fs.readFileSync(ASSET_CSV, 'utf8'))
const ASSET_REQUIRED = ['Previous Inventory Location', 'Model | Display Name', 'Date Time', 'Current Assignee', 'Address | Full Address', 'Account | ID']
for (const c of ASSET_REQUIRED) if (!assetParsed.headers.includes(c)) throw new Error(`Asset CSV missing column: ${c}`)

// Dedup (SonarImportSheet.jsx:234-265)
const groups = new Map()
assetParsed.rows.forEach((row, originalIdx) => {
  const itemId = extractItemIdFromValueList(row['Model Field Data | Value List'] || '')
  const key = itemId
    ? `item:${itemId}`
    : `composite:${row['Account | ID'] || ''}|${row['Date Time'] || ''}|${row['Model | Display Name'] || ''}|${row['Address | Full Address'] || ''}`
  const valueListLen = (row['Model Field Data | Value List'] || '').length
  const isWarehouse = (row['Previous Inventory Location'] || '').toUpperCase() === 'WAREHOUSE'
  const entry = { row, originalIdx, valueListLen, isWarehouse, sonarItemId: itemId }
  const existing = groups.get(key)
  if (!existing) groups.set(key, { canonical: entry, dupCount: 1 })
  else {
    existing.dupCount += 1
    const isBetter = (!entry.isWarehouse && existing.canonical.isWarehouse) ||
      (entry.isWarehouse === existing.canonical.isWarehouse && entry.valueListLen > existing.canonical.valueListLen)
    if (isBetter) existing.canonical = entry
  }
})
const dedupedRows = Array.from(groups.values()).map(g => ({
  row: g.canonical.row, originalIdx: g.canonical.originalIdx, sonarItemId: g.canonical.sonarItemId, dupCount: g.dupCount,
}))

// crewMap: parenthetical first name vs first token of active crew/contractor names (293-304)
const crewUsers = users.filter(u => ['crew', 'contractor'].includes(u.role))
const uniqueSonarLocs = [...new Set(dedupedRows.map(d => d.row['Previous Inventory Location'] || '').filter(Boolean))]
const crewMap = {}
for (const loc of uniqueSonarLocs) {
  const first = extractFirstName(loc)?.toLowerCase()
  if (!first) continue
  const u = crewUsers.find(u => u.name.toLowerCase().split(' ')[0] === first)
  if (u) crewMap[loc] = u.id
}

// source map: persisted + user decisions (keyed UPPER; asset + fiber share the table)
const sourceMap = new Map(mapsRef.source_location.map(([k, v]) => [k, v]))
const fiberUserPicks = new Map() // username → user id picks from decisions-users.csv
// user decisions: pick_user resolves crew, pick_source_location resolves a location by name
for (const d of decUsers) {
  const key = pick(d.source_value)
  const pu = pick(d.YOUR_PICK_user)
  const ps = pick(d.YOUR_PICK_source_location)
  if (!key) continue
  if (ps) {
    const loc = resolveTypedLocation(ps)
    if (loc) sourceMap.set(key.toUpperCase(), loc.id)
    else console.warn(`decisions-users: unknown location name "${ps}" for "${key}"`)
  } else if (pu) {
    const u = resolveTypedUser(pu)
    if (u) {
      if (pick(d.kind) === 'username') fiberUserPicks.set(key, u.id)
      else crewMap[key] = u.id
    } else console.warn(`decisions-users: unknown user "${pu}" for "${key}"`)
  }
}

// partMap: SQL-precomputed app matches + decisions
const partMap = {}         // model → sku
const partInfo = new Map() // sku → {name, unit, routing, method}
for (const [model, hit] of Object.entries(partMatches.matched)) {
  const [sku, name, unit, routing, method] = hit
  partMap[model] = sku
  partInfo.set(sku, { name, unit, routing, method })
}
for (const [sku, [name, unit]] of Object.entries(partMatches.sku_units)) {
  if (!partInfo.has(sku)) partInfo.set(sku, { name, unit, routing: 'ask', method: 'value-map' })
}
for (const d of decAssetParts) {
  const model = pick(d.model)
  let sku = pick(d.YOUR_PICK_sku)
  const nm = pick(d.YOUR_PICK_name)
  if (!model || (!sku && !nm)) continue
  if ((sku || nm).toLowerCase() === 'skip' || (sku || nm).toLowerCase() === 'ignore') { partMap[model] = '__SKIP__'; continue }
  if (sku) {
    // explicit SKU pick (existing catalog id or invented NEW-...)
    partMap[model] = sku
    if (!partInfo.has(sku)) partInfo.set(sku, { name: nm || sku, unit: 'ea', routing: 'ask', method: 'decision' })
    else partInfo.get(sku).method = 'decision'
  } else {
    // name-only pick: resolve name → catalog SKU (or mint NEW-)
    const r = resolveTypedName(nm)
    partMap[model] = r.sku
    if (!partInfo.has(r.sku)) partInfo.set(r.sku, { name: r.name, unit: r.unit || 'ea', routing: r.routing || 'ask', method: r.method })
  }
}

// routing decisions: per-SKU policy override or fixed bucket
const routingOverride = new Map() // sku → {routing} | {bucketId}
for (const d of decRouting) {
  const sku = pick(d.sku)
  if (!sku) continue
  const pol = pick(d.YOUR_PICK_routing).toLowerCase()
  const bname = pick(d.YOUR_PICK_bucket)
  if (bname) {
    const loc = locsByNameLower.get(bname.toLowerCase())
    if (loc) routingOverride.set(sku, { bucketId: loc.id })
    else console.warn(`decisions-routing: unknown bucket "${bname}" for ${sku}`)
  } else if (['region', 'gigwave', 'none', 'fixed-wireless', 'fixed wireless'].includes(pol)) {
    routingOverride.set(sku, { routing: pol.startsWith('fixed') ? 'none' : pol })
  }
}

// cityMap: persisted + auto-seed (bucket name match, 325-338) + decisions
const cityMap = new Map(mapsRef.city_bucket.map(([k, v]) => [k, v]))
const uniqueCities = [...new Set(dedupedRows.map(d => parseCityFromFullAddress(d.row['Address | Full Address'] || '')).filter(Boolean))]
for (const city of uniqueCities) {
  const uc = city.toUpperCase()
  if (cityMap.has(uc)) continue
  const match = buckets.find(b => (b.name || '').toUpperCase() === uc)
  if (match) cityMap.set(uc, match.id)
}
for (const d of decCities) {
  const city = pick(d.city), bname = pick(d.YOUR_PICK_bucket)
  if (!city || !bname) continue
  const loc = locsByNameLower.get(bname.toLowerCase())
  if (loc) cityMap.set(city.toUpperCase(), loc.id)
  else console.warn(`decisions-cities: unknown bucket "${bname}" for ${city}`)
}

// projectMap: persisted + auto-seed by phase name (344-358, asset sheet only) + decisions
const projectMap = new Map(mapsRef.project_phase.map(([k, v]) => [k, v]))
const uniqueAssetProjects = [...new Set(dedupedRows.map(d => (d.row['Project'] || '').trim()).filter(Boolean))]
function autoSeedProject(proj) {
  const up = proj.toUpperCase()
  if (projectMap.has(up)) return
  let match = phases.find(p => (p.name || '').toUpperCase() === up)
  if (!match) match = phases.find(p => {
    const pn = (p.name || '').toUpperCase()
    return pn && (pn.includes(up) || up.includes(pn))
  })
  if (match) projectMap.set(up, match.id)
}
for (const proj of uniqueAssetProjects) autoSeedProject(proj)
for (const d of decProjects) {
  const proj = pick(d.project), phname = pick(d.YOUR_PICK_phase)
  if (!proj || !phname) continue
  const ph = phases.find(p => p.name.toLowerCase() === phname.toLowerCase() ||
    `${p.project_name} / ${p.name}`.toLowerCase() === phname.toLowerCase())
  if (ph) projectMap.set(proj.toUpperCase(), ph.id)
  else console.warn(`decisions-projects: unknown phase "${phname}" for ${proj}`)
}

const inQuarter = d => d >= Q_START && d <= Q_END

// Resolve every deduped asset row (mirrors SonarImportSheet.jsx:452-565, minus
// the already-imported short-circuit — see header note)
const NEEDS = {
  'no-crew': 'PICK_USER', 'no-truck': 'PICK_USER', 'no-source-location': 'PICK_SOURCE',
  'no-part': 'PICK_PART', 'project-unmapped': 'PICK_PROJECT', 'no-project-bucket': 'PICK_PROJECT',
  'no-city': 'PICK_DEST', 'city-unmapped': 'PICK_DEST', 'ask': 'PICK_DEST', 'unresolved': 'PICK_DEST',
  'no-project': 'PICK_PROJECT', 'no-materials': 'ADD_MATERIALS', 'unmapped': 'PICK_PART',
  'manual': 'PICK_QTY', 'pair-missing': 'PICK_QTY',
}

const assetOut = []
for (const entry of dedupedRows) {
  const row = entry.row
  const sonarLoc = row['Previous Inventory Location'] || ''
  const sonarModel = row['Model | Display Name'] || ''
  const city = parseCityFromFullAddress(row['Address | Full Address'] || '')
  const sonarProject = (row['Project'] || '').trim()

  const sourceLocationId = sourceMap.get(sonarLoc.toUpperCase()) || null
  const sourceIsWarehouse = !!sourceLocationId
  const userId = sourceIsWarehouse ? null : (crewMap[sonarLoc] || null)
  const truckId = userId ? trucksByUser[userId] : null
  const fromLocationId = sourceLocationId || truckId || null
  let partSku = partMap[sonarModel] || null
  const skipped = partSku === '__SKIP__'
  if (skipped) partSku = null
  const info = partSku ? partInfo.get(partSku) : null
  const ro = partSku ? routingOverride.get(partSku) : null
  const routing = partSku ? (ro?.routing || info?.routing || 'ask') : null

  const itemFromValueList = entry.sonarItemId
  const accountId = (row['Account | ID'] || '').trim()
  const sonarItemId = itemFromValueList || (accountId && row['Date Time'] ? `${accountId}-${row['Date Time']}` : '')
  const alreadyImported = !!(itemFromValueList && importedAssetIds.has(itemFromValueList))

  let destId = null, destReason = null, status = 'ready'
  if (skipped) { status = 'skipped'; destReason = 'decision: skip' }
  else if (!fromLocationId) status = sourceIsWarehouse ? 'no-source-location' : 'no-crew'
  else if (!sourceIsWarehouse && !truckId) status = 'no-truck'
  else if (!partSku) status = 'no-part'
  else if (ro?.bucketId) { destId = ro.bucketId; destReason = 'decision: fixed bucket' }
  else if (sonarProject) {
    const phaseId = projectMap.get(sonarProject.toUpperCase())
    const phase = phaseId ? phasesById.get(phaseId) : null
    if (phase && phase.bucket_id) { destId = phase.bucket_id; destReason = `Sonar project: ${sonarProject} → ${phase.project_name} / ${phase.name}` }
    else if (phase && !phase.bucket_id) status = 'no-project-bucket'
    else status = 'project-unmapped'
  } else {
    switch (routing) {
      case 'gigwave': {
        const b = buckets.find(b => b.name === 'Gigwave')
        if (b) { destId = b.id; destReason = 'policy: gigwave' } else status = 'no-gigwave-bucket'
        break
      }
      case 'none': {
        const b = buckets.find(b => b.name === 'Fixed Wireless')
        if (b) { destId = b.id; destReason = 'policy: fixed wireless' } else status = 'no-fixed-wireless-bucket'
        break
      }
      case 'region': {
        if (!city) status = 'no-city'
        else {
          const bucketId = cityMap.get(city.toUpperCase())
          if (bucketId) { destId = bucketId; destReason = `city: ${city}` } else status = 'city-unmapped'
        }
        break
      }
      default:
        status = 'ask'
    }
  }
  if (status === 'ready' && !destId) status = 'unresolved'

  let phaseTagId = null
  if (sonarProject) phaseTagId = projectMap.get(sonarProject.toUpperCase()) || null
  const phaseTag = phaseTagId ? phasesById.get(phaseTagId) : null
  const destBucket = destId ? bucketsById.get(destId) || locsById.get(destId) : null
  const destProject = destBucket?.project_id
    ? (phases.find(p => p.project_id === destBucket.project_id)?.project_name || destBucket.name)
    : (destBucket?.name || '')

  const effDate = (row['Date Time'] || '').slice(0, 10)
  assetOut.push({
    ...row,
    dup_count: entry.dupCount,
    effective_date: effDate,
    in_quarter: effDate ? (inQuarter(effDate) ? 'yes' : 'no') : 'no',
    city,
    resolved_user: userId ? usersById.get(userId)?.name || '' : '',
    source_location: fromLocationId ? (locsById.get(fromLocationId)?.name || fromLocationId) : '',
    resolved_part_sku: partSku || '',
    resolved_part_name: info?.name || '',
    match_method: partSku ? info?.method || '' : '',
    qty: partSku ? 1 : '',
    unit: info?.unit || '',
    routing: routing || '',
    resolved_project: destProject,
    resolved_phase: phaseTag ? `${phaseTag.project_name} / ${phaseTag.name}` : '',
    dest_bucket: destBucket?.name || '',
    dest_reason: destReason || '',
    status,
    needs: (effDate && inQuarter(effDate)) ? (NEEDS[status] || '') : '',
    already_imported: alreadyImported ? 'yes' : 'no',
    marker: sonarItemId ? `[sonar:${sonarItemId}]` : '',
  })
}

// ─── FIBER JOBS PIPELINE ─────────────────────────────────────────────────

const fiberParsed = parseCsv(fs.readFileSync(FIBER_CSV, 'utf8'))
const FIBER_REQUIRED = ['Job | Address on Completion', 'Job Type | Name', 'Account | ID', 'User | Username', 'Job | Completion Date time']
for (const c of FIBER_REQUIRED) if (!fiberParsed.headers.includes(c)) throw new Error(`Fiber CSV missing column: ${c}`)
const materialColumns = fiberParsed.headers.filter(h => !FIBER_NON_MATERIAL_COLUMNS.has(h))

// username → user (email local-part, ALL active users; 178-188) + decision picks
const uniqueUsernames = [...new Set(fiberParsed.rows.map(r => (r['User | Username'] || '').trim()).filter(Boolean))]
const fiberCrewMap = {}
for (const uname of uniqueUsernames) {
  const target = uname.toLowerCase()
  const u = users.find(u => (u.email || '').toLowerCase().startsWith(target + '@'))
  if (u) fiberCrewMap[uname] = u.id
}
for (const [key, uid] of fiberUserPicks) fiberCrewMap[key] = uid

// pull locations (homeLocFor, 199-204)
const pullByUser = {}
for (const u of users) if (u.default_pull_location_id) pullByUser[u.id] = u.default_pull_location_id
function homeLocFor(userId) {
  if (!userId) return null
  const pull = pullByUser[userId]
  if (pull && activeLocIds.has(pull)) return pull
  return trucksByUser[userId] || null
}

// fiber value map: persisted + decisions
const valueMap = new Map()
for (const [column_name, value_text, sku, qty_mode, pair_column, default_qty] of mapsRef.fiber_value) {
  valueMap.set(`${column_name}::${(value_text || '').toLowerCase()}`, { column_name, value_text, sku, qty_mode, pair_column, default_qty })
}
for (const d of decFiberValues) {
  const col = pick(d.column), val = pick(d.value)
  const sku = pick(d.YOUR_PICK_sku), mode = pick(d.YOUR_PICK_qty_mode) || 'fixed_unit'
  const pair = pick(d.YOUR_PICK_pair_column) || null
  if (!col || !val) continue
  if (!sku && mode !== 'ignore') continue // not filled yet
  valueMap.set(`${col}::${val.toLowerCase()}`, {
    column_name: col, value_text: val, sku: mode === 'ignore' ? null : sku,
    qty_mode: mode, pair_column: mode === 'pair_with_column' ? pair : null, default_qty: 1,
  })
  if (sku && !partInfo.has(sku)) partInfo.set(sku, { name: pick(d.YOUR_PICK_name) || sku, unit: 'ea', routing: 'ask', method: 'decision' })
}

// per-row qty decisions: key = account|date|jobtype|column
const rowQtyPicks = new Map()
for (const d of decRowQty) {
  const k = `${pick(d.account)}|${pick(d.date)}|${pick(d.job_type)}|${pick(d.column)}`
  const q = Number(pick(d.YOUR_PICK_qty))
  const sku = pick(d.YOUR_PICK_sku)
  if (q > 0 || sku) rowQtyPicks.set(k, { qty: q, sku })
}

const fiberOut = []
const fiberRowStats = []
fiberParsed.rows.forEach((row, idx) => {
  const username = (row['User | Username'] || '').trim()
  const userId = fiberCrewMap[username] || null
  const sourceIsMapped = !!sourceMap.get(username.toUpperCase())
  const sourceLocId = sourceMap.get(username.toUpperCase()) || homeLocFor(userId)
  const sonarProject = (row['Project'] || '').trim()
  const projPhaseId = sonarProject ? projectMap.get(sonarProject.toUpperCase()) : null
  const phase = projPhaseId ? phasesById.get(projPhaseId) : null
  const destBucketId = phase?.bucket_id || null
  const account = (row['Account | ID'] || '').trim()
  const dateStr = (row['Job | Completion Date time'] || '').slice(0, 10)
  const jobType = (row['Job Type | Name'] || '').trim().toLowerCase().replace(/\s+/g, '_')
  const dedupKey = `${account}_${dateStr}_${jobType}`
  const alreadyImported = !!(dedupKey && importedFiberKeys.has(dedupKey))

  let lines = parseFiberRow(row, valueMap, materialColumns)
  // apply per-row qty/sku decisions
  lines = lines.map(line => {
    const k = `${account}|${dateStr}|${jobType}|${line.columnName}`
    const ov = rowQtyPicks.get(k)
    if (!ov) return line
    const sku = ov.sku || line.sku
    const qty = ov.qty > 0 ? ov.qty : line.qty
    return { ...line, sku, qty, status: sku && qty > 0 ? 'ready' : line.status }
  })

  // row-level status ladder (FiberJobsImportSheet.jsx:297-305, minus already-imported short-circuit)
  let rowStatus = 'ready'
  if (!userId && !sourceIsMapped) rowStatus = 'no-crew'
  else if (!sourceLocId) rowStatus = 'no-truck'
  else if (!sonarProject) rowStatus = 'no-project'
  else if (!projPhaseId) rowStatus = 'project-unmapped'
  else if (!destBucketId) rowStatus = 'no-project-bucket'
  else if (lines.filter(l => l.status === 'ready').length === 0) rowStatus = 'no-materials'
  fiberRowStats.push({ rowStatus, alreadyImported, dateStr })

  const jobCols = {
    'Job | Address on Completion': row['Job | Address on Completion'] || '',
    'Job Type | Name': row['Job Type | Name'] || '',
    'Account | ID': account,
    'User | Username': username,
    'Job | Completion Date time': row['Job | Completion Date time'] || '',
    'Project': sonarProject,
  }
  const base = {
    ...jobCols,
    effective_date: dateStr,
    in_quarter: dateStr ? (inQuarter(dateStr) ? 'yes' : 'no') : 'no',
    resolved_user: (!sourceIsMapped && userId) ? usersById.get(userId)?.name || '' : '',
    source_location: sourceLocId ? (locsById.get(sourceLocId)?.name || sourceLocId) : '',
    resolved_project: phase?.project_name || '',
    resolved_phase: phase ? `${phase.project_name} / ${phase.name}` : '',
    dest_bucket: destBucketId ? (locsById.get(destBucketId)?.name || '') : '',
    row_status: rowStatus,
    already_imported: alreadyImported ? 'yes' : 'no',
    marker: `[sonar_jobs:${dedupKey}]`,
  }
  const emit = lines.filter(l => l.status !== 'ignore')
  if (emit.length === 0) {
    fiberOut.push({
      ...base, material_column: '(none)', material_value: '', resolved_part_sku: '', resolved_part_name: '',
      qty: '', unit: '', line_status: 'no-materials',
      status: rowStatus === 'ready' ? 'no-materials' : rowStatus,
      needs: (dateStr && inQuarter(dateStr)) ? (NEEDS[rowStatus === 'ready' ? 'no-materials' : rowStatus] || '') : '',
    })
  } else {
    for (const line of emit) {
      const lineBlocked = ['unmapped', 'manual', 'pair-missing'].includes(line.status)
      const status = rowStatus !== 'ready' && rowStatus !== 'no-materials' ? rowStatus : (lineBlocked ? line.status : 'ready')
      const info = line.sku ? partInfo.get(line.sku) : null
      fiberOut.push({
        ...base,
        material_column: line.columnName, material_value: line.valueText,
        resolved_part_sku: line.sku || '', resolved_part_name: info?.name || '',
        qty: line.qty || '', unit: info?.unit || (line.sku ? 'ea' : ''),
        line_status: line.status,
        status,
        needs: (dateStr && inQuarter(dateStr)) ? (NEEDS[status] || '') : '',
      })
    }
  }
})

// ─── DECISION SHEETS (regenerated every run; picks carried forward) ──────

fs.mkdirSync(DECISIONS, { recursive: true })

function carry(dec, keyFn) {
  const m = new Map()
  for (const d of dec) m.set(keyFn(d), d)
  return m
}

// 1. asset parts — distinct unmatched models among in-quarter rows
{
  const prev = carry(decAssetParts, d => pick(d.model))
  const counts = new Map()
  for (const r of assetOut) {
    if (r.in_quarter !== 'yes') continue
    const model = r['Model | Display Name'] || ''
    if (!model || partMap[model]) continue
    counts.set(model, (counts.get(model) || 0) + 1)
  }
  // keep previously-listed models (even ones now resolved via pick) so picks survive
  for (const [model, d] of prev) if (!counts.has(model)) counts.set(model, Number(pick(d.rows_affected)) || 0)
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([model, n]) => {
    const cands = (partMatches.candidates[model] || []).map(([sku, name]) => `${sku} (${name})`).join(' | ')
    const p = prev.get(model) || {}
    return {
      model, rows_affected: n, suggestions: cands,
      YOUR_PICK_sku: pick(p.YOUR_PICK_sku), YOUR_PICK_name: pick(p.YOUR_PICK_name),
    }
  })
  writeCsv(path.join(DECISIONS, 'decisions-asset-parts.csv'),
    ['model', 'rows_affected', 'suggestions', 'YOUR_PICK_sku', 'YOUR_PICK_name'], rows)
}

// 2. fiber value mappings — distinct unmapped (column, value)
{
  const prev = carry(decFiberValues, d => `${pick(d.column)}::${pick(d.value).toLowerCase()}`)
  const counts = new Map()
  for (const r of fiberOut) {
    if (r.in_quarter !== 'yes' || r.line_status !== 'unmapped') continue
    const key = `${r.material_column}::${String(r.material_value).toLowerCase()}`
    if (!counts.has(key)) counts.set(key, { column: r.material_column, value: r.material_value, n: 0 })
    counts.get(key).n++
  }
  for (const [key, d] of prev) if (!counts.has(key)) counts.set(key, { column: pick(d.column), value: pick(d.value), n: Number(pick(d.rows_affected)) || 0 })
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).map(({ column, value, n }) => {
    const p = prev.get(`${column}::${String(value).toLowerCase()}`) || {}
    return {
      column, value, rows_affected: n,
      qty_mode_options: 'fixed_unit | length_from_text | pair_with_column | ignore',
      YOUR_PICK_sku: pick(p.YOUR_PICK_sku), YOUR_PICK_qty_mode: pick(p.YOUR_PICK_qty_mode),
      YOUR_PICK_pair_column: pick(p.YOUR_PICK_pair_column), YOUR_PICK_name: pick(p.YOUR_PICK_name),
    }
  })
  writeCsv(path.join(DECISIONS, 'decisions-fiber-values.csv'),
    ['column', 'value', 'rows_affected', 'qty_mode_options', 'YOUR_PICK_sku', 'YOUR_PICK_qty_mode', 'YOUR_PICK_pair_column', 'YOUR_PICK_name'], rows)
}

// 3. projects — distinct Project values with no phase mapping (both files)
{
  const prev = carry(decProjects, d => pick(d.project).toUpperCase())
  const counts = new Map()
  const bump = (proj, n = 1) => {
    const up = proj.toUpperCase()
    if (!counts.has(up)) counts.set(up, { project: proj, n: 0 })
    counts.get(up).n += n
  }
  for (const r of assetOut) if (r.in_quarter === 'yes' && ['project-unmapped', 'no-project-bucket'].includes(r.status)) bump((r['Project'] || '').trim())
  for (const r of fiberOut) if (r.in_quarter === 'yes' && ['project-unmapped', 'no-project-bucket'].includes(r.status)) bump(r['Project'])
  for (const [up, d] of prev) if (!counts.has(up)) counts.set(up, { project: pick(d.project), n: Number(pick(d.rows_affected)) || 0 })
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).map(({ project, n }) => {
    const p = prev.get(project.toUpperCase()) || {}
    return { project, rows_affected: n, phase_options_hint: 'see decisions-README.md', YOUR_PICK_phase: pick(p.YOUR_PICK_phase) }
  })
  writeCsv(path.join(DECISIONS, 'decisions-projects.csv'),
    ['project', 'rows_affected', 'phase_options_hint', 'YOUR_PICK_phase'], rows)
}

// 4. cities — distinct unmapped cities on region-routed rows
{
  const prev = carry(decCities, d => pick(d.city).toUpperCase())
  const counts = new Map()
  for (const r of assetOut) {
    if (r.in_quarter !== 'yes' || r.status !== 'city-unmapped') continue
    const uc = r.city.toUpperCase()
    if (!counts.has(uc)) counts.set(uc, { city: r.city, n: 0 })
    counts.get(uc).n++
  }
  for (const [uc, d] of prev) if (!counts.has(uc)) counts.set(uc, { city: pick(d.city), n: Number(pick(d.rows_affected)) || 0 })
  const bucketNames = buckets.map(b => b.name).join(' | ')
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).map(({ city, n }) => {
    const p = prev.get(city.toUpperCase()) || {}
    return { city, rows_affected: n, bucket_options: bucketNames, YOUR_PICK_bucket: pick(p.YOUR_PICK_bucket) }
  })
  writeCsv(path.join(DECISIONS, 'decisions-cities.csv'),
    ['city', 'rows_affected', 'bucket_options', 'YOUR_PICK_bucket'], rows)
}

// 5. users/sources — unmatched asset source strings + unmatched fiber usernames
{
  const prev = carry(decUsers, d => pick(d.source_value))
  const counts = new Map()
  for (const r of assetOut) {
    if (r.in_quarter !== 'yes' || !['no-crew', 'no-truck', 'no-source-location'].includes(r.status)) continue
    const key = r['Previous Inventory Location'] || ''
    if (!counts.has(key)) counts.set(key, { source_value: key, kind: 'crew-name', n: 0 })
    counts.get(key).n++
  }
  for (const r of fiberOut) {
    if (r.in_quarter !== 'yes' || !['no-crew', 'no-truck'].includes(r.status)) continue
    const key = r['User | Username']
    if (!counts.has(key)) counts.set(key, { source_value: key, kind: 'username', n: 0 })
    counts.get(key).n++
  }
  for (const [k, d] of prev) if (!counts.has(k)) counts.set(k, { source_value: k, kind: pick(d.kind), n: Number(pick(d.rows_affected)) || 0 })
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).map(({ source_value, kind, n }) => {
    const p = prev.get(source_value) || {}
    return {
      source_value, kind, rows_affected: n,
      YOUR_PICK_user: pick(p.YOUR_PICK_user), YOUR_PICK_source_location: pick(p.YOUR_PICK_source_location),
    }
  })
  writeCsv(path.join(DECISIONS, 'decisions-users.csv'),
    ['source_value', 'kind', 'rows_affected', 'YOUR_PICK_user', 'YOUR_PICK_source_location'], rows)
}

// 6. routing — parts whose rows landed on 'ask'
{
  const prev = carry(decRouting, d => pick(d.sku))
  const counts = new Map()
  for (const r of assetOut) {
    if (r.in_quarter !== 'yes' || r.status !== 'ask') continue
    const sku = r.resolved_part_sku
    if (!counts.has(sku)) counts.set(sku, { sku, part_name: r.resolved_part_name, n: 0 })
    counts.get(sku).n++
  }
  for (const [sku, d] of prev) if (!counts.has(sku)) counts.set(sku, { sku, part_name: pick(d.part_name), n: Number(pick(d.rows_affected)) || 0 })
  const bucketNames = buckets.map(b => b.name).join(' | ')
  const rows = [...counts.values()].sort((a, b) => b.n - a.n).map(({ sku, part_name, n }) => {
    const p = prev.get(sku) || {}
    return {
      sku, part_name, rows_affected: n,
      routing_options: 'region | gigwave | fixed-wireless', bucket_options: bucketNames,
      YOUR_PICK_routing: pick(p.YOUR_PICK_routing), YOUR_PICK_bucket: pick(p.YOUR_PICK_bucket),
    }
  })
  writeCsv(path.join(DECISIONS, 'decisions-routing.csv'),
    ['sku', 'part_name', 'rows_affected', 'routing_options', 'bucket_options', 'YOUR_PICK_routing', 'YOUR_PICK_bucket'], rows)
}

// 7. per-row qty — fiber lines needing a manual qty (no per-value answer possible)
{
  const prevRows = decRowQty
  const seen = new Set(prevRows.map(d => `${pick(d.account)}|${pick(d.date)}|${pick(d.job_type)}|${pick(d.column)}`))
  const rows = prevRows.map(d => ({ ...d }))
  for (const r of fiberOut) {
    if (r.in_quarter !== 'yes' || !['manual', 'pair-missing'].includes(r.line_status)) continue
    const jobType = (r['Job Type | Name'] || '').trim().toLowerCase().replace(/\s+/g, '_')
    const k = `${r['Account | ID']}|${r.effective_date}|${jobType}|${r.material_column}`
    if (seen.has(k)) continue
    seen.add(k)
    rows.push({
      account: r['Account | ID'], date: r.effective_date, job_type: jobType,
      address: r['Job | Address on Completion'], column: r.material_column, value: r.material_value,
      current_sku: r.resolved_part_sku, reason: r.line_status,
      YOUR_PICK_qty: '', YOUR_PICK_sku: '',
    })
  }
  writeCsv(path.join(DECISIONS, 'decisions-row-qty.csv'),
    ['account', 'date', 'job_type', 'address', 'column', 'value', 'current_sku', 'reason', 'YOUR_PICK_qty', 'YOUR_PICK_sku'], rows)
}

// ─── ENRICHED OUTPUTS ────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true })

const assetHeaders = [...assetParsed.headers,
  'dup_count', 'effective_date', 'in_quarter', 'city', 'resolved_user', 'source_location',
  'resolved_part_sku', 'resolved_part_name', 'match_method', 'qty', 'unit', 'routing',
  'resolved_project', 'resolved_phase', 'dest_bucket', 'dest_reason', 'status', 'needs',
  'already_imported', 'marker']
writeCsv(path.join(OUT, 'enriched-field-tech-assets.csv'), assetHeaders, assetOut)

const fiberHeaders = ['Job | Address on Completion', 'Job Type | Name', 'Account | ID', 'User | Username',
  'Job | Completion Date time', 'Project', 'effective_date', 'in_quarter',
  'material_column', 'material_value', 'resolved_part_sku', 'resolved_part_name', 'qty', 'unit',
  'resolved_user', 'source_location', 'resolved_project', 'resolved_phase', 'dest_bucket',
  'line_status', 'row_status', 'status', 'needs', 'already_imported', 'marker']
writeCsv(path.join(OUT, 'enriched-fiber-jobs.csv'), fiberHeaders, fiberOut)

// ─── ROLLUPS (ready + in-quarter lines only) ─────────────────────────────

function rollup(keyFn, labelCols) {
  const agg = new Map()
  const add = (r, qty, source) => {
    const key = keyFn(r)
    if (!key) return
    if (!agg.has(key)) {
      agg.set(key, { ...labelCols(r), qty_total: 0, qty_already_in_fiberlog: 0, qty_not_in_fiberlog: 0, rows: 0, source_reports: new Set() })
    }
    const a = agg.get(key)
    a.qty_total += qty
    a.rows += 1
    a.source_reports.add(source)
    if (r.already_imported === 'yes') a.qty_already_in_fiberlog += qty
    else a.qty_not_in_fiberlog += qty
  }
  for (const r of assetOut) if (r.in_quarter === 'yes' && r.status === 'ready') add(r, 1, 'field-tech-assets')
  for (const r of fiberOut) if (r.in_quarter === 'yes' && r.status === 'ready') add(r, Number(r.qty) || 0, 'fiber-jobs')
  return [...agg.values()].map(a => ({ ...a, source_reports: [...a.source_reports].join('+') }))
}

const byProject = rollup(
  r => r.dest_bucket && r.resolved_part_sku ? `${r.dest_bucket}|${r.resolved_part_sku}` : null,
  r => ({ project_bucket: r.dest_bucket, sku: r.resolved_part_sku, part_name: r.resolved_part_name, unit: r.unit })
).sort((a, b) => a.project_bucket.localeCompare(b.project_bucket) || b.qty_total - a.qty_total)
writeCsv(path.join(OUT, 'consumption-2026Q2-by-project.csv'),
  ['project_bucket', 'sku', 'part_name', 'unit', 'qty_total', 'qty_already_in_fiberlog', 'qty_not_in_fiberlog', 'rows', 'source_reports'], byProject)

const byUser = rollup(
  r => r.resolved_part_sku ? `${r.resolved_user || r.source_location}|${r.resolved_part_sku}` : null,
  r => ({ consumer: r.resolved_user || `(source: ${r.source_location})`, sku: r.resolved_part_sku, part_name: r.resolved_part_name, unit: r.unit })
).sort((a, b) => a.consumer.localeCompare(b.consumer) || b.qty_total - a.qty_total)
writeCsv(path.join(OUT, 'consumption-2026Q2-by-user.csv'),
  ['consumer', 'sku', 'part_name', 'unit', 'qty_total', 'qty_already_in_fiberlog', 'qty_not_in_fiberlog', 'rows', 'source_reports'], byUser)

// ─── SUMMARY ─────────────────────────────────────────────────────────────

function tally(rows, statusKey) {
  const t = new Map()
  for (const r of rows) t.set(r[statusKey], (t.get(r[statusKey]) || 0) + 1)
  return [...t.entries()].sort((a, b) => b[1] - a[1])
}
const assetInQ = assetOut.filter(r => r.in_quarter === 'yes')
const fiberInQ = fiberOut.filter(r => r.in_quarter === 'yes')
const fiberJobsInQ = fiberRowStats.filter(r => r.dateStr && inQuarter(r.dateStr))

const dupTotal = dedupedRows.reduce((s, d) => s + d.dupCount, 0)
const summary = `# Q2 2026 consumption enrichment — run ${new Date().toISOString().slice(0, 16)}

## Inputs
- Field tech asset consumption: ${assetParsed.rows.length} raw rows → ${dedupedRows.length} deduped installs (dup_count sums to ${dupTotal})
- All fiber all jobs: ${fiberParsed.rows.length} jobs → ${fiberOut.length} material lines emitted

## Quarter window (${Q_START} … ${Q_END})
- Asset installs in quarter: ${assetInQ.length} / ${assetOut.length}
- Fiber jobs in quarter: ${fiberJobsInQ.length} / ${fiberParsed.rows.length} (material lines in quarter: ${fiberInQ.length})

## Asset install status (in-quarter)
${tally(assetInQ, 'status').map(([s, n]) => `- ${s}: ${n}`).join('\n')}

## Fiber material-line status (in-quarter)
${tally(fiberInQ, 'status').map(([s, n]) => `- ${s}: ${n}`).join('\n')}

## Already imported into FiberLog (marker match)
- Asset installs: ${assetOut.filter(r => r.already_imported === 'yes').length}
- Fiber jobs: ${fiberRowStats.filter(r => r.alreadyImported).length}

## Decisions outstanding (fill YOUR_PICK in decisions/*.csv, then re-run)
- decisions-asset-parts.csv: ${[...new Set(assetInQ.filter(r => r.status === 'no-part').map(r => r['Model | Display Name']))].length} models
- decisions-fiber-values.csv: ${[...new Set(fiberInQ.filter(r => r.line_status === 'unmapped').map(r => r.material_column + '::' + r.material_value))].length} column/value pairs
- decisions-projects.csv: ${[...new Set([...assetInQ, ...fiberInQ].filter(r => ['project-unmapped', 'no-project-bucket'].includes(r.status)).map(r => r['Project']))].length} projects
- decisions-cities.csv: ${[...new Set(assetInQ.filter(r => r.status === 'city-unmapped').map(r => r.city))].length} cities
- decisions-users.csv: ${[...new Set([...assetInQ.filter(r => ['no-crew', 'no-truck', 'no-source-location'].includes(r.status)).map(r => r['Previous Inventory Location']), ...fiberInQ.filter(r => ['no-crew', 'no-truck'].includes(r.status)).map(r => r['User | Username'])])].length} sources/usernames
- decisions-routing.csv: ${[...new Set(assetInQ.filter(r => r.status === 'ask').map(r => r.resolved_part_sku))].length} parts on 'ask' routing
- decisions-row-qty.csv: ${fiberInQ.filter(r => ['manual', 'pair-missing'].includes(r.line_status)).length} lines needing a manual qty
`
fs.writeFileSync(path.join(OUT, 'summary.md'), summary, 'utf8')
console.log(summary)
console.log('Outputs written to', OUT)
