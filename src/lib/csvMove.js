// Pure logic for "Move from CSV" (CsvMoveSheet) — a spreadsheet of
// part / qty / from / to rows becomes one `transfer` movement per row.
// Kept free of React + Supabase so the matching rules (which decide what
// leaves which shelf) are unit-tested in csvMove.test.js.
//
// Built Oct 2026 for binning: download the warehouse's unbinned stock as a
// template, fill in the To column with bin names, upload.

import { escapeCsvField } from './csvImport'

// ─── COLUMNS ─────────────────────────────────────────────────────────────────

// Header aliases, compared after lowercasing + collapsing non-alphanumerics
// so "Part ID", "part_id" and "PART-ID" all match. Order = preference when a
// sheet happens to carry two of them.
const COLUMN_ALIASES = {
  sku:  ['sku', 'partid', 'part', 'itemid', 'item', 'partnumber'],
  qty:  ['qty', 'quantity', 'qtytomove', 'moveqty', 'movequantity'],
  from: ['from', 'source', 'fromlocation', 'frombin'],
  to:   ['to', 'destination', 'dest', 'tolocation', 'tobin', 'bin'],
}

const headerKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// → { sku, qty, from, to } holding the ACTUAL header text (or null).
export function findMoveColumns(headers) {
  const out = { sku: null, qty: null, from: null, to: null }
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const hit = headers.find(h => headerKey(h) === alias)
      if (hit) { out[field] = hit; break }
    }
  }
  return out
}

// ─── LOCATION MATCHING ───────────────────────────────────────────────────────

// Loose key for a location name. Bins are named "Aisle 4, shelf a2" with
// inconsistent capitalisation ("Shelf d5"), and people type "4-a2" or
// "Aisle 4 Shelf A2" — dropping the filler words + punctuation makes all of
// those "4a2". Collisions are reported as ambiguous, never guessed.
export function locationKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(aisle|shelf|bin)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
}

// locations: active top-level rows (getLocations — trucks carry
// assigned_user) PLUS active bins (parent_location_id set). Returns
// resolve(text) → { location } | { error }.
export function buildLocationIndex(locations) {
  const top = new Map()          // key → [loc]
  const bins = new Map()         // key → [bin]
  const qualified = new Map()    // `${warehouseKey}/${binKey}` → bin
  const byId = new Map(locations.map(l => [l.id, l]))
  const add = (map, key, loc) => {
    if (!key) return
    const list = map.get(key) || []
    if (!list.some(l => l.id === loc.id)) list.push(loc)
    map.set(key, list)
  }

  for (const l of locations) {
    if (l.type === 'bin') {
      add(bins, locationKey(l.name), l)
      const parent = byId.get(l.parent_location_id)
      if (parent) qualified.set(`${locationKey(parent.name)}/${locationKey(l.name)}`, l)
    } else {
      add(top, locationKey(l.name), l)
      // A truck can be named after the truck OR its driver.
      if (l.assigned_user?.name) add(top, locationKey(l.assigned_user.name), l)
    }
  }

  function resolve(text) {
    const raw = String(text || '').trim()
    if (!raw) return { error: 'blank' }
    // "Warehouse / Bin". A bin name can itself contain a slash ("Crew
    // construction/ construction items…"), so try every split point.
    for (let i = raw.indexOf('/'); i > 0; i = raw.indexOf('/', i + 1)) {
      const hit = qualified.get(`${locationKey(raw.slice(0, i))}/${locationKey(raw.slice(i + 1))}`)
      if (hit) return { location: hit }
    }
    const key = locationKey(raw)
    const matches = [...(top.get(key) || []), ...(bins.get(key) || [])]
    if (matches.length === 1) return { location: matches[0] }
    if (matches.length > 1) return { error: `"${raw}" matches ${matches.length} locations — write it as Warehouse / Bin` }
    return { error: `No location named "${raw}"` }
  }

  return { resolve }
}

// Display name: "Warehouse / Bin" for bins, driver name for trucks.
export function locationLabel(loc, locationsById) {
  if (!loc) return ''
  if (loc.type === 'bin') {
    const parent = locationsById.get(loc.parent_location_id)
    return parent ? `${parent.name} / ${loc.name}` : loc.name
  }
  return loc.assigned_user?.name || loc.name
}

// ─── PART MATCHING ───────────────────────────────────────────────────────────

// Excel and Google Sheets turn "0065910" into the number 65910 on the round
// trip — and the catalog has zero-less twins of some of those SKUs (same
// name, separate part, Oct 2026), so a stripped SKU can silently match the
// WRONG part. Rules for an all-digit SKU:
//   - zero-padded twin exists alongside an exact match → error (ambiguous)
//   - only a zero-padded version exists → use it (unambiguous recovery)
// Then case-insensitive SKU, then exact part name.
//   → (text) → part | { error } | null
export function buildPartFinder(parts) {
  const byId = new Map(), byUpper = new Map(), byName = new Map(), byStripped = new Map()
  for (const p of parts) {
    const id = String(p.id)
    byId.set(id, p)
    byUpper.set(id.toUpperCase(), p)
    if (p.name) byName.set(p.name.trim().toLowerCase(), p)
    if (/^\d+$/.test(id)) {
      const k = id.replace(/^0+/, '')
      byStripped.set(k, [...(byStripped.get(k) || []), p])
    }
  }
  return text => {
    const t = String(text || '').trim()
    if (/^\d+$/.test(t)) {
      const family = byStripped.get(t.replace(/^0+/, '')) || []
      const exact = byId.get(t)
      // Only a LONGER twin is a risk — zeros get dropped, never added, so a
      // fully padded SKU that matches exactly is trusted.
      const others = family.filter(p => String(p.id).length > t.length)
      if (exact && others.length) {
        return { error: `SKU ${t} also exists as ${others.map(p => p.id).join(', ')} — the spreadsheet may have dropped leading zeros. Format the SKU column as text and re-check.` }
      }
      if (exact) return exact
      if (family.length === 1) return family[0]
      if (family.length > 1) return { error: `SKU ${t} could be ${family.map(p => p.id).join(' or ')} — write it in full` }
    }
    return byId.get(t) || byUpper.get(t.toUpperCase()) || byName.get(t.toLowerCase()) || null
  }
}

// ─── ROW RESOLUTION ──────────────────────────────────────────────────────────

// Endpoints a CSV move may not touch. Vendors aren't stock, scrap has its own
// movement type, and a Region is consumed material (moving out of one is the
// owner-only Reclassify flow).
const BLOCKED_TYPES = new Set(['vendor', 'job_site', 'scrap'])
const TYPE_WORD = { vendor: 'vendor', job_site: 'Region', scrap: 'scrap location' }

// Normalise a qty cell: "1,200" → 1200, "" → null, junk → NaN.
function parseQty(v) {
  const s = String(v ?? '').trim().replace(/,/g, '')
  if (s === '') return null
  return Number(s)
}

// Phase 1 — what each row names, before any stock is known. Lets the sheet
// fetch stock only for the From locations actually used.
//
//   rows          — parsed CSV rows (objects keyed by header)
//   cols          — findMoveColumns() result
//   findPart      — (skuText) → part | { error } | null   (buildPartFinder)
//   resolveLoc    — (text) → { location } | { error }   (overrides applied)
//   defaultFromId — used when the From cell is blank (or no From column)
//   locationsById — Map for the default-from lookup
export function parseMoveRows({ rows, cols, findPart, resolveLoc, defaultFromId, locationsById }) {
  return rows.map((row, i) => {
    const rowNum = i + 2   // spreadsheet line (header = 1)
    const skuText = String(row[cols.sku] ?? '').trim()
    const toText = cols.to ? String(row[cols.to] ?? '').trim() : ''
    const fromText = cols.from ? String(row[cols.from] ?? '').trim() : ''
    const qtyRaw = cols.qty ? row[cols.qty] : ''
    const base = { rowNum, skuText, toText, fromText, qtyRaw: String(qtyRaw ?? '').trim() }

    // A template row nobody filled in (blank To) is a skip, not an error —
    // the template lists every part and you only fill the ones you're moving.
    if (!toText) return { ...base, status: 'skip', message: skuText ? 'No destination' : 'Blank row' }
    if (!skuText) return { ...base, status: 'error', message: 'No SKU' }

    const part = findPart(skuText)
    if (!part) return { ...base, status: 'error', message: `Unknown SKU "${skuText}"` }
    if (part.error) return { ...base, status: 'error', message: part.error }

    const to = resolveLoc(toText)
    let from
    if (fromText) from = resolveLoc(fromText)
    else if (defaultFromId && locationsById.get(defaultFromId)) from = { location: locationsById.get(defaultFromId) }
    else from = { error: 'No From location (fill the From column or pick a default)' }

    const out = { ...base, part, from: from.location || null, to: to.location || null }
    if (!from.location) return { ...out, status: 'error', message: `From: ${from.error}`, badFrom: !!fromText }
    if (!to.location) return { ...out, status: 'error', message: `To: ${to.error}`, badTo: true }
    if (from.location.id === to.location.id) return { ...out, status: 'error', message: 'From and To are the same place' }
    for (const [label, loc] of [['From', from.location], ['To', to.location]]) {
      if (BLOCKED_TYPES.has(loc.type)) {
        return { ...out, status: 'error', message: `${label} is a ${TYPE_WORD[loc.type]} — not movable stock` }
      }
    }

    const qty = parseQty(qtyRaw)
    if (qty !== null && (!Number.isFinite(qty) || qty <= 0)) {
      return { ...out, status: 'error', message: `Bad qty "${base.qtyRaw}"` }
    }
    return { ...out, qty, status: 'ok' }
  })
}

// Phase 2 — fill blank quantities from on-hand and flag overdraws.
//   onHand(partId, locationId) → number
// A blank qty means "everything at From" — only unambiguous when that
// (part, From) pair appears on one row; split rows must say how many.
export function applyStock(parsed, onHand) {
  const pairKey = r => `${r.part.id}|${r.from.id}`
  const rowsPerPair = new Map()
  for (const r of parsed) {
    if (r.status !== 'ok') continue
    rowsPerPair.set(pairKey(r), (rowsPerPair.get(pairKey(r)) || 0) + 1)
  }

  const filled = parsed.map(r => {
    if (r.status !== 'ok' || r.qty !== null) return r
    if (rowsPerPair.get(pairKey(r)) > 1) {
      return { ...r, status: 'error', message: 'Qty required — this part is split across several rows' }
    }
    const have = Number(onHand(r.part.id, r.from.id) || 0)
    if (have <= 0) return { ...r, status: 'error', message: 'Qty blank and nothing on hand at From' }
    return { ...r, qty: have, qtyFromStock: true }
  })

  // Overdraw is summed per (part, From) — two rows of 10 against 15 on hand
  // overdraw together even though each fits alone. Warn-but-allow, same
  // posture as every other movement sheet.
  const totals = new Map()
  for (const r of filled) {
    if (r.status !== 'ok') continue
    totals.set(pairKey(r), (totals.get(pairKey(r)) || 0) + r.qty)
  }
  return filled.map(r => {
    if (r.status !== 'ok') return r
    const have = Number(onHand(r.part.id, r.from.id) || 0)
    const total = totals.get(pairKey(r))
    if (total > have) {
      return { ...r, status: 'warn', message: `Moves ${fmt(total)} but only ${fmt(have)} on hand at From` }
    }
    return r
  })
}

const fmt = n => Number(n).toLocaleString()

export function buildCsvMovePayloads(resolved, { userId, notes }) {
  return resolved
    .filter(r => r.status === 'ok' || r.status === 'warn')
    .map(r => ({
      movement_type: 'transfer',
      part_id: r.part.id,
      quantity: r.qty,
      unit: r.part.unit || 'ea',
      from_location_id: r.from.id,
      to_location_id: r.to.id,
      notes: notes || null,
      created_by: userId,
    }))
}

// ─── TEMPLATE ────────────────────────────────────────────────────────────────

// Every part on hand at `sourceLabel`, with Qty + To left blank. Qty blank
// on upload = move all of it; To blank = leave it where it is.
//   stockRows — [{ part, quantity }] (quantity > 0 only)
export function buildMoveTemplateCsv(stockRows, sourceLabel) {
  const header = ['SKU', 'Name', 'On hand', 'Unit', 'Qty', 'From', 'To']
  const lines = [header.join(',')]
  const sorted = [...stockRows].sort((a, b) =>
    String(a.part?.name || a.part?.id).localeCompare(String(b.part?.name || b.part?.id)))
  for (const r of sorted) {
    lines.push([
      r.part.id, r.part.name || '', r.quantity, r.part.unit || 'ea', '', sourceLabel, '',
    ].map(escapeCsvField).join(','))
  }
  return lines.join('\n')
}
