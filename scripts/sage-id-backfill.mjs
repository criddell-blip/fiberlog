#!/usr/bin/env node
// Backfill parts_catalog.sage_id from the owner's "Sage Inventory Item IDs"
// workbook (accounting's export: Item ID, Name, Product line ID, GL group,
// Item type — two sheets, Inventory + Non Inventory).
//
// The workbook has NO SKU column, so the join is by part NAME. Catalog names
// were aligned to Sage's in the June 2026 reset, which is why ~87% land on
// an exact match; the rest go through normalisation / token / fuzzy tiers and
// every uncertain match is written to a REVIEW file for a human to approve.
// The SKU (parts_catalog.id) is never changed — sage_id is an added column.
//
// This script never touches the DB. Two modes:
//
//   node scripts/sage-id-backfill.mjs match <sage.xlsx> <catalog.csv>
//       catalog.csv = id,name,is_active,sage_id (the Parts-tab export works
//       too: headers SKU,Sage ID,Name,...,Status). Writes imports/sage-ids/
//         matched.csv             auto-approved (exact / norm / tokens)
//         review.csv              fuzzy + ambiguous — fill/clear the `sku`
//                                 column; a blank sku is skipped
//         unmatched.csv           Sage rows with no candidate at all
//         parts_without_sage.csv  active parts still NULL after this run
//
//   node scripts/sage-id-backfill.mjs sql <catalog.csv> <matched.csv> [review.csv ...]
//       Prints ONE `update ... from (values ...)` statement from the approved
//       rows (non-empty sku), fills NULLs only. Every sku must exist in
//       catalog.csv — refuses otherwise. Run it via the Supabase MCP / SQL
//       editor.
//
// ⚠ Editing review.csv: do it in a text editor, or format the `sku` column as
// TEXT in Excel first — Excel strips leading zeros (0069198 → 69198) and that
// is exactly an active/retired SKU pair in this catalog. The `sql` mode's
// catalog check catches a mangled SKU only if the mangled form doesn't exist.
//
// Zero deps: the xlsx is unzipped with the system `unzip` (present under Git
// Bash; not on a stock Windows PATH) and parsed with regex (sharedStrings +
// sheet XML).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const OUT_DIR = path.resolve('imports/sage-ids')

// ─── CSV ─────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = []
  let row = [], cell = '', q = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else if (c !== '\r') cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  const [hdr, ...body] = rows
  return body
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(hdr.map((h, i) => [h.trim(), r[i] ?? ''])))
}
const esc = v => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const toCsv = (headers, rows) =>
  [headers, ...rows.map(r => headers.map(h => r[h]))].map(r => r.map(esc).join(',')).join('\n') + '\n'

// ─── XLSX (Sage workbook) ────────────────────────────────────────────────────

const unxml = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'")

function readSageWorkbook(xlsxPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-ids-'))
  execFileSync('unzip', ['-o', '-q', xlsxPath, 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/worksheets/*', '-d', tmp])
  const ss = [...fs.readFileSync(path.join(tmp, 'xl/sharedStrings.xml'), 'utf8').matchAll(/<si>(.*?)<\/si>/gs)]
    .map(m => unxml([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(t => t[1]).join('')))

  // Resolve sheet names → files so the GL-list sheet can be skipped by name.
  const wb = fs.readFileSync(path.join(tmp, 'xl/workbook.xml'), 'utf8')
  const rels = fs.readFileSync(path.join(tmp, 'xl/_rels/workbook.xml.rels'), 'utf8')
  const relMap = {}
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[1])?.[1], target = /Target="([^"]+)"/.exec(m[1])?.[1]
    if (id && target) relMap[id] = target
  }
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => ({
    name: unxml(/name="([^"]+)"/.exec(m[1])?.[1] || ''),
    file: relMap[/r:id="([^"]+)"/.exec(m[1])?.[1]],
  }))

  const out = []
  for (const sh of sheets) {
    if (!sh.file || !/inventory/i.test(sh.name)) continue   // skips "GL List for Non PO Invoices"
    const xml = fs.readFileSync(path.join(tmp, 'xl', sh.file.replace(/^\/?(xl\/)?/, '')), 'utf8')
    const rows = []
    for (const r of xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
      const cells = {}
      for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>(?:<v>(.*?)<\/v>)?/gs)) {
        let v = c[3] ?? ''
        if (/t="s"/.test(c[2])) v = ss[+v]
        cells[c[1]] = v
      }
      rows.push(cells)
    }
    const [hdr, ...body] = rows
    const col = label => Object.keys(hdr).find(k => String(hdr[k]).trim().toLowerCase() === label)
    const cId = col('item id'), cName = col('name'), cType = col('item type')
    if (!cId || !cName) throw new Error(`Sheet "${sh.name}" has no Item ID / Name header`)
    for (const r of body) {
      const sageId = String(r[cId] || '').trim()
      if (!sageId) continue
      out.push({ sage_id: sageId, sage_name: String(r[cName] || '').trim(), item_type: String(r[cType] || '').trim(), sheet: sh.name })
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  return out
}

// ─── Name matching ───────────────────────────────────────────────────────────
// Tiers, strictest first. exact / norm / tokens are auto-approved (they differ
// only in punctuation, unit spelling, or word order — the same latitude the
// June renames used); fuzzy and ambiguous go to review.csv.

const norm = s => String(s).toLowerCase()
  .replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"')
  .replace(/(\d)\s*'/g, '$1ft').replace(/(\d)\s*"/g, '$1in')
  .replace(/\bfeet\b|\bfoot\b/g, 'ft').replace(/\binch(es)?\b/g, 'in')
  .replace(/[^a-z0-9]+/g, ' ').trim()
const tokens = s => norm(s).split(' ').filter(Boolean)
const tokKey = s => [...new Set(tokens(s))].sort().join(' ')
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b)
  let i = 0
  for (const t of A) if (B.has(t)) i++
  return i / (A.size + B.size - i || 1)
}

// Sage carries PARALLEL item IDs for one physical item — `UB000024` (GL
// 53040) alongside `UB_L024` (GL 53020), and a few `_R` rows — because
// accounting posts the same part to different GL groups. FiberLog holds one
// Sage ID per part (unique index), so the canonical `UB000nnn` form wins and
// the alternates are reported in variants.csv rather than silently dropped.
// Ranking: canonical → non-inventory UB_9 → UB_L → _R → anything else.
// Collapsing is by lowercased name across BOTH sheets, so two genuinely
// different Sage items that happen to share a name also collapse — scan
// variants.csv for anything that is NOT a UB_L / _R twin of its preferred id.
function sageIdRank(id) {
  if (/^UB\d{6}$/.test(id)) return 0
  if (/^UB_9\d+$/.test(id)) return 1
  if (/^UB_L\d+$/.test(id)) return 2
  if (/_R$/.test(id)) return 3
  return 4
}
function collapseSageVariants(sage) {
  const byName = new Map()
  for (const s of sage) {
    const k = s.sage_name.toLowerCase()
    if (!byName.has(k)) byName.set(k, [])
    byName.get(k).push(s)
  }
  const primary = [], variants = []
  for (const group of byName.values()) {
    group.sort((a, b) => sageIdRank(a.sage_id) - sageIdRank(b.sage_id) || a.sage_id.localeCompare(b.sage_id))
    primary.push(group[0])
    for (const v of group.slice(1)) variants.push({ ...v, preferred_sage_id: group[0].sage_id })
  }
  return { primary, variants }
}

function matchAll(sage, parts) {
  const idx = { exact: new Map(), norm: new Map(), tokens: new Map() }
  const add = (m, k, p) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(p) }
  for (const p of parts) { add(idx.exact, p.name, p); add(idx.norm, norm(p.name), p); add(idx.tokens, tokKey(p.name), p) }

  const matched = [], review = [], unmatched = []
  const taken = new Map()   // sku → sage_id claimed this run (unique index)
  // Several catalog rows sharing a name is almost always an active SKU plus
  // its retired duplicate (0069198 vs 69198): prefer the lone active one.
  const disambiguate = c => { if (c.length <= 1) return c; const act = c.filter(p => p.is_active); return act.length === 1 ? act : c }
  const describe = p => `${p.id} = ${p.name}${p.is_active ? '' : ' (retired)'}`

  for (const s of sage) {
    let how = null, cands = null
    for (const tier of ['exact', 'norm', 'tokens']) {
      const key = tier === 'exact' ? s.sage_name : tier === 'norm' ? norm(s.sage_name) : tokKey(s.sage_name)
      const c = idx[tier].get(key)
      if (c && c.length) { how = tier; cands = disambiguate(c); break }
    }
    if (!cands) {
      const st = tokens(s.sage_name)
      const scored = parts
        .map(p => ({ p, score: jaccard(st, tokens(p.name)) }))
        .filter(x => x.score >= 0.5)
        .sort((a, b) => b.score - a.score || (b.p.is_active - a.p.is_active))
      if (!scored.length) { unmatched.push(s); continue }
      const top = scored.slice(0, 3)
      // Pre-fill the sku only when the top candidate clearly wins; the human
      // still approves every fuzzy row.
      // 0.5-scorers were wrong often enough (C6 → B8 closures, DUP-H → DUP-L)
      // that they come to the reviewer blank.
      const clear = top[0].p.is_active && top[0].score >= 0.6 && top[0].score - (top[1]?.score ?? 0) >= 0.15
      review.push({ ...s, matched_by: 'fuzzy', sku: clear ? top[0].p.id : '', candidates: top.map(x => `${describe(x.p)} [${x.score.toFixed(2)}]`).join(' | ') })
      continue
    }
    if (cands.length > 1) {
      review.push({ ...s, matched_by: 'ambiguous', sku: '', candidates: cands.map(describe).join(' | ') })
      continue
    }
    const p = cands[0]
    if (p.sage_id && p.sage_id !== s.sage_id) {
      review.push({ ...s, matched_by: 'conflict', sku: '', candidates: `${p.id} already has ${p.sage_id}` }); continue
    }
    if (taken.has(p.id)) {
      review.push({ ...s, matched_by: 'dup-sku', sku: '', candidates: `${p.id} already claimed by ${taken.get(p.id)}` }); continue
    }
    taken.set(p.id, s.sage_id)
    matched.push({ sage_id: s.sage_id, sku: p.id, part_name: p.name, sage_name: s.sage_name, matched_by: how, item_type: s.item_type })
  }
  return { matched, review, unmatched, taken }
}

// ─── Modes ───────────────────────────────────────────────────────────────────

function loadCatalog(csvPath) {
  return parseCsv(fs.readFileSync(csvPath, 'utf8')).map(r => ({
    id: r.id ?? r.SKU ?? r.sku,
    name: r.name ?? r.Name,
    is_active: r.is_active != null ? /^(t|true|1)$/i.test(r.is_active) : /^active$/i.test(r.Status ?? 'active'),
    sage_id: (r.sage_id ?? r['Sage ID'] ?? '').trim() || null,
  })).filter(p => p.id)
}

function runMatch(xlsx, catalogCsv) {
  const all = readSageWorkbook(xlsx)
  const { primary: sage, variants } = collapseSageVariants(all)
  const parts = loadCatalog(catalogCsv)
  const { matched, review, unmatched, taken } = matchAll(sage, parts)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const w = (f, h, rows) => fs.writeFileSync(path.join(OUT_DIR, f), toCsv(h, rows))
  w('variants.csv', ['sage_id', 'sage_name', 'item_type', 'sheet', 'preferred_sage_id'], variants)
  w('matched.csv', ['sage_id', 'sku', 'part_name', 'sage_name', 'matched_by', 'item_type'], matched)
  w('review.csv', ['sage_id', 'sage_name', 'item_type', 'matched_by', 'sku', 'candidates'], review)
  w('unmatched.csv', ['sage_id', 'sage_name', 'item_type', 'sheet'], unmatched)
  const without = parts.filter(p => p.is_active && !p.sage_id && !taken.has(p.id)).map(p => ({ sku: p.id, name: p.name }))
  w('parts_without_sage.csv', ['sku', 'name'], without)
  const by = k => matched.filter(m => m.matched_by === k).length
  console.log(`Sage rows ${all.length} → ${sage.length} distinct names (${variants.length} parallel-ID variants set aside in variants.csv) · catalog ${parts.length} (${parts.filter(p => p.is_active).length} active)`)
  console.log(`matched ${matched.length} (exact ${by('exact')}, norm ${by('norm')}, tokens ${by('tokens')})`)
  console.log(`review ${review.length} · unmatched ${unmatched.length} · active parts still without Sage ID ${without.length}`)
  console.log(`→ ${OUT_DIR}`)
}

function runSql(catalogCsv, files) {
  const catalog = new Map(loadCatalog(catalogCsv).map(p => [p.id, p]))
  const pairs = new Map()
  const unknown = []
  for (const f of files) {
    for (const r of parseCsv(fs.readFileSync(f, 'utf8'))) {
      const sku = (r.sku || '').trim(), sid = (r.sage_id || '').trim().toUpperCase()
      if (!sku || !sid) continue
      if (!catalog.has(sku)) { unknown.push(`${sku} (${sid}, ${path.basename(f)})`); continue }
      if (pairs.has(sku) && pairs.get(sku) !== sid) throw new Error(`SKU ${sku} given two Sage IDs: ${pairs.get(sku)} / ${sid}`)
      pairs.set(sku, sid)
    }
  }
  if (unknown.length) {
    throw new Error(`${unknown.length} sku(s) not in the catalog — typo or Excel stripped leading zeros?\n  ${unknown.join('\n  ')}`)
  }
  const seen = new Map()
  for (const [sku, sid] of pairs) {
    if (seen.has(sid)) throw new Error(`Sage ID ${sid} given to two SKUs: ${seen.get(sid)} / ${sku}`)
    seen.set(sid, sku)
  }
  const q = s => `'${String(s).replace(/'/g, "''")}'`
  const values = [...pairs].map(([sku, sid]) => `(${q(sku)}, ${q(sid)})`).join(',\n  ')
  console.log(`-- ${pairs.size} parts. Fills NULLs only — a part already carrying a different Sage ID is left alone.
update public.parts_catalog p
   set sage_id = v.sage_id
  from (values
  ${values}
  ) as v(sku, sage_id)
 where p.id = v.sku
   and p.sage_id is null;`)
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === 'match' && rest.length === 2) runMatch(rest[0], rest[1])
else if (mode === 'sql' && rest.length >= 2) runSql(rest[0], rest.slice(1))
else {
  console.error('usage:\n  node scripts/sage-id-backfill.mjs match <sage.xlsx> <catalog.csv>\n  node scripts/sage-id-backfill.mjs sql <catalog.csv> <matched.csv> [review.csv ...]')
  process.exit(1)
}
