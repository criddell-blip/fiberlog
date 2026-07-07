// Small pure helpers shared across crew components. These sit on the submit /
// load money paths (TaskWorkspace submit merge, CrewMovementSheet part search),
// so they live here where they can be unit-tested directly.

// Dedup a list of {id, name, unit, qty} parts by id, summing quantities.
export function mergePartsById(list) {
  const m = {}
  for (const p of list) {
    if (!p || !p.id) continue
    if (!m[p.id]) m[p.id] = { ...p }
    else m[p.id] = { ...m[p.id], qty: (m[p.id].qty || 0) + (p.qty || 0) }
  }
  return Object.values(m).filter(p => p.qty > 0)
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
