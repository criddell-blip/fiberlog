// Small pure helpers shared across crew components. These sit on the submit /
// load money paths (TaskWorkspace submit merge, CrewMovementSheet part search),
// so they live here where they can be unit-tested directly.

// Dedup a list of {id, name, unit, qty, sourceLocationId?} parts by
// (id, sourceLocationId), summing quantities. The source is part of the
// identity: the same SKU pulled from two different trucks must stay two
// lines, because each becomes its own truck→bucket movement at approval.
// Lines without a source (undefined/null — "my truck") merge as before.
//
// `lineNote` (asset tags, infra crew) is NOT part of the identity — a note
// never splits a line into a second movement — but it must never be lost by
// a merge either, so notes on collapsing lines concatenate with ', '.
export function mergePartsById(list) {
  const m = {}
  for (const p of list) {
    if (!p || !p.id) continue
    const key = p.id + '|' + (p.sourceLocationId || '')
    if (!m[key]) m[key] = { ...p }
    else m[key] = { ...m[key], qty: (m[key].qty || 0) + (p.qty || 0), lineNote: joinLineNotes(m[key].lineNote, p.lineNote) }
  }
  return Object.values(m).filter(p => p.qty > 0)
}

// Concatenate two optional per-line notes; blank/undefined halves drop out
// and the result is undefined (not '') when both are empty so a merged line
// looks exactly like an un-noted one.
export function joinLineNotes(a, b) {
  const parts = [a, b].map(s => String(s || '').trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : undefined
}

// Multi-word search: every whitespace token must appear somewhere in the
// combined field list (case-insensitive). Whole-phrase .includes() made
// "lag bolt box" match nothing while "Lag Bolts, 1/2 x 4 (Box of 50)"
// sat right there — same bug class as the server-side searchPartsCatalog
// fix in lib/supabase.js. Deliberate asymmetry vs the server: here tokens
// may match ACROSS fields (name + SKU concatenated) since we're filtering
// a small already-loaded list; the server requires all tokens in the same
// column. A query can therefore match slightly more here — acceptable.
export function matchesAllTokens(query, fields) {
  const haystack = fields.filter(Boolean).join(' ').toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    .every(tok => haystack.includes(tok))
}
