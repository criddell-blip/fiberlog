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

// THE derivation of a footage assembly's type kind. Flag-driven, never
// id-driven, so the crew picker, the consumption path and the manager's flag
// checkbox cannot disagree about which cards are typed. Returning null rather
// than falling through to a default is deliberate: it's what keeps untyped
// footage (and every non-footage assembly) out of the consumption path.
export function footageKind(asm) {
  if (!asm) return null
  if (asm.isFiber) return 'fiber'
  if (asm.isConduit) return 'conduit'
  if (asm.isStrand) return 'strand'
  return null
}

// A kind whose chip list holds exactly ONE value isn't really a choice — the
// crew would tap the same chip every time, and forgetting to would mean the
// footage consumes nothing. So create the line for them.
//
// Keyed on the CHIP LIST, not on how many types the manager has mapped. A
// map-derived rule would race the async footage-map fetch (a crew on a slow
// connection types feet before it lands, gets no auto-pick, and silently logs
// zero material), and it would switch itself on for fiber the day someone
// cleared four of the five fiber mappings. The chip list is a code constant:
// deterministic, and it matches what the crew actually sees on screen.
export function autoPickType(lines, values) {
  if ((lines || []).length > 0) return null
  return (values || []).length === 1 ? values[0] : null
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
// assemblies: the ALL_ASSEMBLIES list (needs .id, a kind flag, and .parts)
// footageLines: { [assemblyId]: [{ type, ft }] }
// footageMap: { fiber: { '144ct': {partId,name,unit} }, conduit: {...}, strand: {...} }
export function linesToParts({ assemblies, footageLines, footageMap }) {
  const out = []
  for (const asm of assemblies || []) {
    const kind = footageKind(asm)
    if (!kind) continue
    // Collision guard, scoped to THIS assembly's own parts. When the assembly
    // already derives the SKU a picked type maps to, the assembly row wins and
    // the footage row is dropped — otherwise the same feet land twice.
    //
    // It MUST be per-assembly, not app-wide. `down-guy` consumes 20 ft of the
    // SAME strand SKU per guy, so an app-wide skip set would let a single down
    // guy silently delete a whole day of strand footage. Two different
    // assemblies consuming one SKU is legitimate additive consumption, not a
    // double-count — only the assembly that owns the line can shadow it.
    const own = new Set((asm.parts || []).map(p => p.id))
    for (const line of footageLines?.[asm.id] || []) {
      const ft = Number(line.ft) || 0
      const hit = line.type && footageMap?.[kind]?.[line.type]
      if (ft <= 0 || !hit || own.has(hit.partId)) continue
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
