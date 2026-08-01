// Lightweight CSV parsing utilities, sufficient for BoxHero exports and
// Sonar transaction reports. We avoid pulling in papaparse to keep the
// dependency surface small.
//
// Handles:
//   - UTF-8 BOM at start of file (BoxHero exports include this)
//   - Double-quoted fields with embedded commas
//   - Escaped quotes inside quoted fields ("" → ")
//   - CRLF or LF line endings

// Parse a single CSV file. Returns { headers, rows } where rows is an array
// of objects keyed by header name.
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  const records = parseRecords(text)
  if (records.length === 0) return { headers: [], rows: [] }

  const headers = records[0]
  const rows = records.slice(1).map(fields => {
    const row = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fields[i] != null ? fields[i] : ''
    }
    return row
  })
  return { headers, rows }
}

function parseRecords(text) {
  const records = []
  let current = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"')  { inQuotes = true; i++; continue }
    if (c === ',')  { current.push(field); field = ''; i++; continue }
    if (c === '\r') {
      if (text[i + 1] === '\n') { i++; continue }
      current.push(field); records.push(current); current = []; field = ''; i++; continue
    }
    if (c === '\n') { current.push(field); records.push(current); current = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field !== '' || current.length > 0) {
    current.push(field); records.push(current)
  }
  return records.filter(r => !(r.length === 1 && r[0] === ''))
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, 'utf-8')
  })
}

// ─── BOXHERO-SPECIFIC HELPERS ────────────────────────────────────────────────

export function detectBoxHeroQtyColumns(headers) {
  const out = []
  for (const h of headers) {
    const m = /^Qty\((.+)\)\s*$/.exec(h)
    if (m) out.push({ columnName: h, locationLabel: m[1].trim() })
  }
  return out
}

export function summarizeBoxHeroColumns(rows, qtyColumns) {
  return qtyColumns.map(col => {
    let total = 0
    let nonZeroRowCount = 0
    for (const row of rows) {
      const v = Number(row[col.columnName])
      if (!Number.isNaN(v) && v !== 0) { total += v; nonZeroRowCount++ }
    }
    return { ...col, total, nonZeroRowCount }
  })
}

export function classifyBoxHeroColumn(label) {
  const l = label.toLowerCase()
  if (l === 'warehouse') return 'warehouse'
  if (l.startsWith('crew') || l.startsWith('contractor')) return 'crew'
  if (l.includes('project') || l.includes('green field')) return 'project'
  if (l.startsWith('region')) return 'region'
  if (l.includes('cycle count')) return 'cycle_count'
  return 'other'
}

// ─── CSV SERIALIZATION + DOWNLOAD ───────────────────────────────────────────

// Produce CSV text from an array of unmatched-SKU objects. The `row` field
// on each entry (when present) carries the full BoxHero row dict so we
// can include the relevant metadata columns.
export function buildUnmatchedCsv(unmatchedSkus) {
  const headers = [
    'SKU', 'Name', 'Total Qty',
    'Department', 'Type', 'Material Group',
    'Vendor', 'Vendor Part #', 'Unit Cost', 'Barcode',
  ]
  const lines = [headers.join(',')]
  for (const u of unmatchedSkus) {
    const r = u.row || {}
    const fields = [
      u.sku,
      u.name || '',
      String(u.totalQty || 0),
      r['Department'] || '',
      r['Type'] || '',
      r['Material Group'] || '',
      r['Vendor'] || '',
      r['Vendor part number'] || '',
      r['Unit Cost'] || '',
      r['Barcode'] || '',
    ]
    lines.push(fields.map(escapeCsvField).join(','))
  }
  return lines.join('\n')
}

// Exported so new exports can share ONE escaper — the repo already grew six
// private copies of this function before it was exported; don't add a seventh.
export function escapeCsvField(v) {
  const s = String(v == null ? '' : v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

// Trigger a browser download of arbitrary text content. Used for every
// CSV export in the app (reports, audit, Sage, etc.).
//
// Excel + Numbers default to guessing the encoding of CSVs they open,
// and they almost always guess Windows-1252 instead of UTF-8 — so a
// phase name like "West Mountain — phase 4" (with a real em dash)
// renders as "West Mountain â€" phase 4". Prepending a UTF-8 BOM
// (﻿) tells the spreadsheet to use UTF-8 and the dashes / accents
// / em dashes render correctly. Already-BOMed content is left alone.
export function downloadTextAsFile(filename, content, mime = 'text/csv;charset=utf-8;') {
  let payload = content
  if (mime.startsWith('text/csv') && typeof payload === 'string' && payload.charCodeAt(0) !== 0xFEFF) {
    payload = '﻿' + payload
  }
  const blob = new Blob([payload], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Defer revoke so Safari/iOS finishes downloading before URL is released
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
