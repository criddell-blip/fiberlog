// Footage type breakdown — pure helpers.
//
// A crew's footage on a task splits across types: 2,000 ft of 144ct AND 500 ft
// of 288ct on the same span. The shape is { [assemblyId]: [{ type, ft }] }.
//
// This is a money path — these functions decide which SKU (and how much of it)
// leaves the truck at approval — so it lives here with tests rather than inline
// in TaskWorkspace, same reasoning as mergePartsById in shared.js.
//
// The invariant everything else depends on: whenever an assembly has >= 1 line,
// `counts[assemblyId]` equals the sum of that assembly's line feet. `counts` is
// what feeds summary + the submissions.total_*_ft rollups; the lines are what
// feed material consumption. If they drift, the passdown reports one number and
// deducts another, with nothing to flag it.

export function sumLines(lines) {
  return (lines || []).reduce((a, l) => a + (Number(l.ft) || 0), 0)
}

// Toggle a type on/off for one assembly. Returns the next lines array, or the
// SAME array reference when nothing should change (caller can skip the write).
//
// headerTotal: the feet already typed into the card's header box. The first
// type picked adopts it — that's the pre-multi-select behavior, where you typed
// the footage and then said what it was. Later picks start empty.
export function toggleLine(lines, type, headerTotal = 0) {
  const cur = lines || []
  const hit = cur.find(l => l.type === type)
  if (hit) return cur.filter(l => l.type !== type)
  return [...cur, { type, ft: cur.length === 0 ? (Number(headerTotal) || 0) : 0 }]
}

export function setLineFt(lines, type, val) {
  return (lines || []).map(l => l.type === type ? { ...l, ft: parseFloat(val) || 0 } : l)
}

// Does removing this type destroy entered work? Dropping the LAST line just
// un-types the footage (the feet stay in counts as untyped footage, a legal
// state), so only a removal that actually takes feet off the total deserves a
// confirm.
export function removalLosesWork(lines, type) {
  const cur = lines || []
  if (cur.length <= 1) return false
  const hit = cur.find(l => l.type === type)
  return !!hit && Number(hit.ft) > 0
}

// Resolve every picked type into its mapped SKU. One part row per line.
//
// assemblies: the ALL_ASSEMBLIES list (needs .id/.isFiber/.isConduit)
// footageLines: { [assemblyId]: [{ type, ft }] }
// footageMap: { fiber: { '144ct': {partId,name,unit} }, conduit: {...} }
// assemblyPartIds: Set of part ids the assemblies already derive — a footage
//   SKU that collides with one is skipped so it can't double-count.
export function linesToParts({ assemblies, footageLines, footageMap, assemblyPartIds }) {
  const out = []
  const skip = assemblyPartIds || new Set()
  for (const asm of assemblies || []) {
    // Driven by the assembly's own flags rather than hardcoded ids, so the
    // picker and the consumption can't disagree about which cards are typed.
    const kind = asm.isFiber ? 'fiber' : asm.isConduit ? 'conduit' : null
    if (!kind) continue
    for (const line of footageLines?.[asm.id] || []) {
      const ft = Number(line.ft) || 0
      const hit = line.type && footageMap?.[kind]?.[line.type]
      if (ft <= 0 || !hit || skip.has(hit.partId)) continue
      // srcKey, not partId, is the React key at the call site: two types CAN
      // map to one SKU via a mis-curated footage map, and duplicate keys make
      // React silently drop a row from the review sheet.
      out.push({
        id: hit.partId, name: hit.name, unit: hit.unit || 'ft', qty: ft,
        fromFootage: true, srcKey: asm.id + ':' + line.type, srcType: line.type,
      })
    }
  }
  return out
}

// "144ct", "144ct + 288ct", "144ct + 288ct +2". Capped because the totals
// banner it feeds is a flex-wrap row on a 390px phone.
export function typeLabel(lines, max = 2) {
  const ts = (lines || []).map(l => l.type).filter(Boolean)
  if (ts.length === 0) return ''
  return ts.length <= max ? ts.join(' + ') : `${ts.slice(0, max).join(' + ')} +${ts.length - max}`
}

// A picked type with no feet yet is still a tap the crew made — the
// coworker-clobber confirm and the flag-restore guard both respect it.
export function hasFootageLines(map) {
  return Object.values(map || {}).some(arr => (arr || []).length > 0)
}

// Draft-shape migration (multi-type footage, July 2026). Drafts written before
// this shipped carry a scalar `fiberCount` + a one-size-per-slot `conduitSizes`,
// with the feet living only in `counts`. Returns the footageLines shape.
//
// Takes the raw working_counts object. Crews have open drafts at any moment, so
// dropping the legacy keys would silently stop their cable deducting at
// approval — the footage would survive as a stat and the material wouldn't.
export function migrateLegacyFootage(wc) {
  if (!wc) return {}
  if (wc.footageLines) return wc.footageLines
  const migrated = {}
  // The old fiberCount was global to the task but only ever consumed against
  // fiber-ft, so that's the only assembly it can honestly migrate onto.
  if (wc.fiberCount) {
    migrated['fiber-ft'] = [{ type: wc.fiberCount, ft: Number(wc.counts?.['fiber-ft']) || 0 }]
  }
  for (const [cid, sz] of Object.entries(wc.conduitSizes || {})) {
    // The old default was {'bore-ft':'', 'plow-ft':''} — empty strings are not
    // a pick and must not become a line.
    if (String(sz || '').trim()) {
      migrated[cid] = [{ type: sz, ft: Number(wc.counts?.[cid]) || 0 }]
    }
  }
  return migrated
}
