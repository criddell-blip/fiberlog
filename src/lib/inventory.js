// FiberLog inventory API. Operations on inventory_locations, inventory_movements,
// inventory_stock, and parts_catalog. Keeps the inventory module decoupled
// from the rest of supabase.js so we can extract it later if needed.

import { db, searchPartsCatalog } from './supabase'

// Natural / "logical" name compare. Beats plain localeCompare on alnum bin
// labels: "A2" < "A10" instead of "A10" < "A2". Used everywhere bins or
// alphanumeric labels are listed so creating a new bin slots it into the
// expected spot rather than the lexicographic one.
export function compareNamesNatural(a, b) {
  return (a || '').localeCompare(b || '', undefined, { numeric: true, sensitivity: 'base' })
}

// Group locations by their "Aisle N" name prefix for a tidy picker: numbered
// aisles ascending (1,2,…10 via numeric sortKey), then an "Other" group for
// non-aisle bins + warehouses/trucks/buckets. Each item gets `shelfLabel` =
// its name minus the "Aisle N," prefix, so rows under an aisle header read just
// "shelf e2". Tolerates inconsistent bin names ("Aisle 1, E4" vs "…, shelf c1")
// by grouping/sorting on the remainder. Mirrors the cycle-count bin picker.
export function groupLocationsByAisle(locations) {
  const map = new Map()
  for (const loc of locations || []) {
    const name = loc.name || ''
    const m = name.match(/^Aisle\s+(\S+?)\s*[,/]\s*(.*)$/i)
    const key = m ? `aisle-${m[1].toLowerCase()}` : 'other'
    const label = m ? `Aisle ${m[1]}` : 'Other'
    const sortKey = m ? (parseInt(m[1], 10) || 9998) : 9999
    const shelfLabel = m ? (m[2].trim() || name) : (loc.displayLabel || name)
    if (!map.has(key)) map.set(key, { key, label, sortKey, items: [] })
    map.get(key).items.push({ ...loc, shelfLabel })
  }
  const groups = Array.from(map.values())
  for (const g of groups) g.items.sort((a, b) => compareNamesNatural(a.shelfLabel, b.shelfLabel))
  return groups.sort((a, b) => a.sortKey - b.sortKey)
}

// ─── LOCATIONS ───────────────────────────────────────────────────────────────

// Get top-level locations (warehouses, trucks, job sites, etc.). By default
// excludes bins — bins are queried separately via getBinsForWarehouse so
// the flat location list (used by pickers and pill rows) doesn't get
// flooded once warehouses start having sub-locations.
//
// Backward compatible: callers that pass a bare boolean still work
// (treated as `includeInactive`).
export async function getLocations(opts = {}) {
  if (typeof opts === 'boolean') opts = { includeInactive: opts }
  const { includeInactive = false, includeBins = false } = opts

  let q = db
    .from('inventory_locations')
    .select('*, assigned_user:users!inventory_locations_assigned_to_fkey(id, name, initials)')
  if (!includeInactive) q = q.eq('is_active', true)
  if (!includeBins)     q = q.is('parent_location_id', null)
  const { data, error } = await q
  if (error) throw error
  const typeOrder = { warehouse: 0, truck: 1, group: 2, job_site: 3, vendor: 4, scrap: 5, bin: 6 }
  return (data || []).sort((a, b) => {
    const t = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)
    if (t !== 0) return t
    const an = a.assigned_user?.name || a.name || ''
    const bn = b.assigned_user?.name || b.name || ''
    return compareNamesNatural(an, bn)
  })
}

// List bins under a specific warehouse. Empty array if the warehouse has
// no bins yet.
export async function getBinsForWarehouse(warehouseId, { includeInactive = false } = {}) {
  if (!warehouseId) return []
  let q = db
    .from('inventory_locations')
    .select('*')
    .eq('parent_location_id', warehouseId)
    .eq('type', 'bin')
  if (!includeInactive) q = q.eq('is_active', true)
  const { data, error } = await q
  if (error) throw error
  return (data || []).sort((a, b) => compareNamesNatural(a.name, b.name))
}

export async function createLocation({ name, type, assigned_to, notes, parent_location_id }) {
  const payload = {
    name,
    type,
    assigned_to: assigned_to || null,
    notes: notes || null,
  }
  // Only set parent_location_id when relevant — passing null on a non-bin
  // is fine but verbose.
  if (parent_location_id) payload.parent_location_id = parent_location_id

  const { data, error } = await db
    .from('inventory_locations')
    .insert(payload)
    .select('*, assigned_user:users!inventory_locations_assigned_to_fkey(id, name, initials)')
    .single()
  if (error) throw error
  return data
}

export async function updateLocation(id, updates) {
  const { data, error } = await db
    .from('inventory_locations')
    .update(updates)
    .eq('id', id)
    .select('*, assigned_user:users!inventory_locations_assigned_to_fkey(id, name, initials)')
    .single()
  if (error) throw error
  return data
}

// Back-compat thin wrapper. New flow uses deactivateLocationWithRecovery
// directly to enable the materials-recovery UX. This one stays so any
// caller that just wants the legacy "flip the bit" behavior keeps working.
export async function deactivateLocation(id) {
  return deactivateLocationWithRecovery(id, [], null)
}

// Atomic retire + optional materials recovery. RPC handles owner-only
// gating, source/destination validation, transfer movement inserts, and
// the final is_active=false flip in one transaction.
//
// recoveryItems shape: [{ partId, quantity, unit }]. Empty = retire only.
// destinationLocationId required when recoveryItems.length > 0.
export async function deactivateLocationWithRecovery(locationId, recoveryItems, destinationLocationId) {
  const items = (recoveryItems || []).map(i => ({
    part_id: i.partId,
    quantity: i.quantity,
    unit: i.unit || 'ea',
  }))
  const { data, error } = await db.rpc('deactivate_location_with_recovery', {
    p_location_id: locationId,
    p_recovery_items: items,
    p_destination_location_id: destinationLocationId || null,
  })
  if (error) throw error
  return data
}

// ─── STOCK ───────────────────────────────────────────────────────────────────

export async function getStockByLocation(locationId) {
  const { data, error } = await db
    .from('inventory_stock')
    .select('quantity, last_movement_at, parts_catalog(id, name, unit, category, material_group, is_active)')
    .eq('location_id', locationId)
  if (error) throw error
  return (data || [])
    .filter(r => Number(r.quantity) !== 0)
    .sort((a, b) => (a.parts_catalog?.name || '').localeCompare(b.parts_catalog?.name || ''))
}

// Returns ALL active stock grouped by part. Used by the crew "Find a
// part" Load mode. Three parallel flat queries instead of one embedded
// join — PostgREST's nested select() is convenient but joins per row
// and is markedly slower than three lookup-by-key fetches that the
// client merges. Significant savings even on small datasets (~3-5×).
// Filters: active parts only, non-zero qty only. excludeLocationId
// drops the caller's truck (or whatever pull location they're loading
// INTO) so they don't see it as a possible source.
export async function getAllStockGrouped({ excludeLocationId = null } = {}) {
  const [stockRes, partsRes, locsRes] = await Promise.all([
    db.from('inventory_stock').select('part_id, location_id, quantity'),
    db.from('parts_catalog')
      .select('id, name, nickname, attributes, unit, category, material_group, department')
      .eq('is_active', true),
    db.from('inventory_locations')
      .select('id, name, type, parent_location_id, assigned_to')
      .eq('is_active', true),
  ])
  if (stockRes.error) throw stockRes.error
  if (partsRes.error) throw partsRes.error
  if (locsRes.error) throw locsRes.error

  // Index part + location lookups
  const partById = new Map((partsRes.data || []).map(p => [p.id, p]))
  const locById = new Map((locsRes.data || []).map(l => [l.id, l]))
  const parentNameById = new Map(
    (locsRes.data || []).filter(l => l.type === 'warehouse').map(l => [l.id, l.name])
  )

  const byPart = new Map()
  for (const r of stockRes.data || []) {
    const qty = Number(r.quantity || 0)
    if (qty <= 0) continue
    const part = partById.get(r.part_id)
    if (!part) continue  // part is inactive or missing
    const loc = locById.get(r.location_id)
    if (!loc) continue  // location is inactive or missing
    if (excludeLocationId && loc.id === excludeLocationId) continue
    if (!byPart.has(part.id)) {
      byPart.set(part.id, {
        partId: part.id,
        name: part.name,
        nickname: part.nickname || null,
        attributes: part.attributes || {},
        unit: part.unit,
        category: part.category,
        material_group: part.material_group,
        department: part.department,
        locations: [],
        totalQty: 0,
      })
    }
    const entry = byPart.get(part.id)
    const parentName = loc.parent_location_id ? parentNameById.get(loc.parent_location_id) : null
    entry.locations.push({
      locationId: loc.id,
      name: loc.name,
      type: loc.type,
      hasOwner: !!loc.assigned_to,
      parentName,
      // Bin labels show their own name only ("Aisle 4, shelf e2"). The
      // warehouse prefix is redundant — only one warehouse has aisle bins, so
      // the aisle implies it. (Restore `parentName · name` here if a second
      // aisle-bearing warehouse is ever added, for disambiguation.)
      displayLabel: loc.name,
      qty,
    })
    entry.totalQty += qty
  }
  for (const e of byPart.values()) {
    e.locations.sort((a, b) => b.qty - a.qty)
  }
  return Array.from(byPart.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

// Per-part location breakdown. Returns where a given SKU has been
// logged (any qty > 0), each row labeled "Warehouse · Bin" when the
// location is a bin, or just the location name otherwise. Matches the
// formatting used by getAllStockGrouped (line 184) so labels are
// consistent across surfaces.
//
// Used by the Parts tab "📍 Locations" drill-in. Cheap enough to
// re-fetch on every overlay open — bypasses caching to keep the
// payload fresh after recent movements.
export async function getPartLocations(partId) {
  if (!partId) return { totalQty: 0, locations: [] }
  const [stockRes, locsRes] = await Promise.all([
    db.from('inventory_stock')
      .select('location_id, quantity, last_movement_at')
      .eq('part_id', partId),
    db.from('inventory_locations')
      .select('id, name, type, parent_location_id, assigned_to, is_active'),
  ])
  if (stockRes.error) throw stockRes.error
  if (locsRes.error) throw locsRes.error

  const locById = new Map((locsRes.data || []).map(l => [l.id, l]))
  const parentNameById = new Map(
    (locsRes.data || []).filter(l => l.type === 'warehouse').map(l => [l.id, l.name])
  )

  let totalQty = 0
  const locations = []
  for (const r of stockRes.data || []) {
    const qty = Number(r.quantity || 0)
    if (qty <= 0) continue  // Surface only places it's actually located
    const loc = locById.get(r.location_id)
    if (!loc) continue
    const parentName = loc.parent_location_id ? parentNameById.get(loc.parent_location_id) : null
    locations.push({
      locationId: loc.id,
      name: loc.name,
      type: loc.type,
      hasOwner: !!loc.assigned_to,
      isActive: !!loc.is_active,
      parentLocationId: loc.parent_location_id || null,
      parentName,
      // Bin name only — warehouse prefix dropped (one aisle-warehouse; aisle implies it).
      displayLabel: loc.name,
      qty,
      lastMovementAt: r.last_movement_at || null,
    })
    totalQty += qty
  }
  locations.sort((a, b) => b.qty - a.qty)
  return { totalQty, locations }
}

export async function getStockSummary() {
  const { data, error } = await db
    .from('inventory_stock')
    .select('part_id, quantity, parts_catalog(id, name, unit, category, material_group, is_active)')
  if (error) throw error
  const byPart = new Map()
  for (const row of data || []) {
    const qty = Number(row.quantity) || 0
    if (qty === 0) continue
    const cur = byPart.get(row.part_id)
    if (cur) {
      cur.total += qty
      cur.locationCount++
    } else {
      byPart.set(row.part_id, {
        part_id: row.part_id,
        name: row.parts_catalog?.name || row.part_id,
        unit: row.parts_catalog?.unit || 'ea',
        category: row.parts_catalog?.category || null,
        is_active: row.parts_catalog?.is_active !== false,
        total: qty,
        locationCount: 1,
      })
    }
  }
  return [...byPart.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ─── SONAR ROUTING ───────────────────────────────────────────────────────────

// Each part has a sonar_routing policy that determines where a Sonar import
// sends its issue/transfer movements. 'ask' = manager picks per row.
export const SONAR_ROUTING_OPTIONS = [
  { id: 'region',  label: 'Region (by city)',   desc: 'Look up customer city → region bucket' },
  { id: 'gigwave', label: 'Always Gigwave',     desc: 'Wireless equipment that always goes to Gigwave' },
  // 'none' is a legacy token; the standalone "None" bucket was retired and
  // Fixed Wireless took over. Kept as-is to avoid a sonar_routing CHECK change.
  { id: 'none',    label: 'Always Fixed Wireless', desc: 'Wireless equipment that always goes to Fixed Wireless' },
  { id: 'ask',     label: 'Ask per row',        desc: 'Manager picks the destination for each row at import time' },
]

// Update a single part's sonar_routing policy. Used by SonarImportSheet's
// per-model picker; persists across imports so the manager only sets each
// SKU once.
export async function setPartSonarRouting(partId, policy) {
  if (!partId) throw new Error('partId required')
  if (!['region','gigwave','none','ask'].includes(policy)) {
    throw new Error(`Invalid sonar_routing: ${policy}`)
  }
  const { error } = await db
    .from('parts_catalog')
    .update({ sonar_routing: policy })
    .eq('id', partId)
  if (error) throw error
}

// Fetch all city → bucket mappings. Returns a Map<city, location_id>.
// city keys are stored case-sensitive but we'll do uppercase lookups
// in the sheet to match Sonar's variable casing.
export async function getSonarCityMap() {
  const { data, error } = await db
    .from('sonar_city_bucket_map')
    .select('city, location_id')
  if (error) throw error
  const m = new Map()
  for (const row of data || []) {
    if (row.city) m.set(row.city.toUpperCase(), row.location_id)
  }
  return m
}

// Upsert a city → bucket mapping.
export async function setSonarCityBucket(city, locationId) {
  if (!city || !locationId) throw new Error('city and locationId required')
  const { error } = await db
    .from('sonar_city_bucket_map')
    .upsert(
      { city: city.toUpperCase(), location_id: locationId },
      { onConflict: 'city' }
    )
  if (error) throw error
}

// Clear a city → bucket mapping (revert to "needs manual pick").
export async function clearSonarCityBucket(city) {
  if (!city) return
  const { error } = await db
    .from('sonar_city_bucket_map')
    .delete()
    .eq('city', city.toUpperCase())
  if (error) throw error
}

// Sonar Project → FiberLog phase map. Sonar's install report tags each
// row with a project (Center Creek, Cold Springs, etc.); these are
// sub-regions of the FiberLog regional projects. We map them to phases
// under those regional projects so:
//   • Materials still land in the regional inventory bucket (no bucket
//     explosion in the picker)
//   • Each movement carries phase_id for per-cost-center Sage export
//
// Bucket resolution happens at apply-time: phase.project_id → look up
// the project's job_site bucket.
export async function getSonarProjectMap() {
  const { data, error } = await db
    .from('sonar_project_phase_map')
    .select('project, phase_id')
  if (error) throw error
  const m = new Map()
  for (const row of data || []) {
    if (row.project) m.set(row.project.toUpperCase(), row.phase_id)
  }
  return m
}

export async function setSonarProjectPhase(project, phaseId) {
  if (!project || !phaseId) throw new Error('project and phaseId required')
  const { error } = await db
    .from('sonar_project_phase_map')
    .upsert(
      { project: project.toUpperCase(), phase_id: phaseId },
      { onConflict: 'project' }
    )
  if (error) throw error
}

export async function clearSonarProjectPhase(project) {
  if (!project) return
  const { error } = await db
    .from('sonar_project_phase_map')
    .delete()
    .eq('project', project.toUpperCase())
  if (error) throw error
}

// Sonar source → FiberLog location map. Used for Previous Inventory
// Location values that aren't crew members — most commonly "Warehouse" —
// so when a tech grabs equipment without first logging the truck loadout
// in Sonar, the resulting install row still routes correctly (warehouse →
// project bucket) instead of silently failing as 'no-crew'. Picks persist
// so the manager configures once per source string, forever.
export async function getSonarSourceLocationMap() {
  const { data, error } = await db
    .from('sonar_source_location_map')
    .select('sonar_source, location_id')
  if (error) throw error
  const m = new Map()
  for (const row of data || []) {
    if (row.sonar_source) m.set(row.sonar_source.toUpperCase(), row.location_id)
  }
  return m
}

export async function setSonarSourceLocation(sonarSource, locationId) {
  if (!sonarSource || !locationId) throw new Error('sonarSource and locationId required')
  const { error } = await db
    .from('sonar_source_location_map')
    .upsert(
      { sonar_source: sonarSource.toUpperCase(), location_id: locationId },
      { onConflict: 'sonar_source' }
    )
  if (error) throw error
}

export async function clearSonarSourceLocation(sonarSource) {
  if (!sonarSource) return
  const { error } = await db
    .from('sonar_source_location_map')
    .delete()
    .eq('sonar_source', sonarSource.toUpperCase())
  if (error) throw error
}

// Bulk-create phases and seed the Sonar project map in one pass. Each
// item: { sonarProject: string, projectId: uuid, phaseName: string }.
// For each, creates a phase under projectId (auto-incrementing
// sequence_order against existing phases) and upserts sonar_project_phase_map.
// Returns { created: number, skipped: number, errors: [{sonarProject, message}] }.
export async function bulkCreateSonarPhases(items) {
  if (!Array.isArray(items) || items.length === 0) return { created: 0, skipped: 0, errors: [] }
  // Fetch current max sequence_order per project once, in bulk
  const projectIds = [...new Set(items.map(i => i.projectId).filter(Boolean))]
  const seqByProject = new Map()
  for (const pid of projectIds) {
    const { data } = await db
      .from('phases')
      .select('sequence_order')
      .eq('project_id', pid)
      .order('sequence_order', { ascending: false })
      .limit(1)
    seqByProject.set(pid, (data?.[0]?.sequence_order || 0))
  }

  let created = 0
  let skipped = 0
  const errors = []
  for (const item of items) {
    if (!item.projectId || !item.phaseName) { skipped++; continue }
    // Skip if a phase with the same name already exists under that project
    const { data: existing } = await db
      .from('phases')
      .select('id')
      .eq('project_id', item.projectId)
      .ilike('name', item.phaseName.trim())
      .maybeSingle()
    let phaseId = existing?.id || null
    if (!phaseId) {
      const nextSeq = (seqByProject.get(item.projectId) || 0) + 1
      seqByProject.set(item.projectId, nextSeq)
      const { data, error } = await db
        .from('phases')
        .insert({
          project_id: item.projectId,
          name: item.phaseName.trim(),
          sequence_order: nextSeq,
        })
        .select('id')
        .single()
      if (error) { errors.push({ sonarProject: item.sonarProject, message: error.message }); continue }
      phaseId = data.id
      created++
    } else {
      skipped++
    }
    // Always set/refresh the map entry
    if (item.sonarProject && phaseId) {
      const { error: mapErr } = await db
        .from('sonar_project_phase_map')
        .upsert(
          { project: item.sonarProject.toUpperCase(), phase_id: phaseId },
          { onConflict: 'project' }
        )
      if (mapErr) errors.push({ sonarProject: item.sonarProject, message: 'phase created but map upsert failed: ' + mapErr.message })
    }
  }
  return { created, skipped, errors }
}

// Phases enriched with their parent project + the project's job_site
// bucket — used by the SonarImportSheet picker (one dropdown for both
// mapping AND bucket resolution).
export async function getPhasesWithBuckets() {
  const { data, error } = await db
    .from('phases')
    .select(`
      id, name, project_id, status,
      project:projects(id, name)
    `)
    .order('name')
  if (error) throw error
  // Fetch buckets per project in one shot
  const { data: buckets, error: bErr } = await db
    .from('inventory_locations')
    .select('id, project_id')
    .eq('type', 'job_site')
    .eq('is_active', true)
    .not('project_id', 'is', null)
  if (bErr) throw bErr
  const bucketByProject = new Map()
  for (const b of buckets || []) bucketByProject.set(b.project_id, b.id)
  return (data || []).map(ph => ({
    ...ph,
    project_name: ph.project?.name || '',
    bucket_id: bucketByProject.get(ph.project_id) || null,
  }))
}

// ─── Sonar pending-imports queue ──────────────────────────────────────────
// Rows are inserted by the sonar-webhook edge function (daily Sonar push).
// Manager reviews + applies them via SonarImportSheet — same UI as a
// manual CSV upload, but with the CSV pre-loaded from the pending row.

// List pending webhook deliveries, newest first. Includes status='discarded'
// rows so the manager can see auto-discarded deliveries (e.g. unzip
// failures) without digging in the DB. Filter by report_type to scope
// to one report ('asset_consumption' or 'fiber_jobs').
export async function getPendingSonarImports({ includeProcessed = false, limit = 30, reportType = null } = {}) {
  let q = db.from('sonar_pending_imports')
    .select('id, received_at, filename, parsed_row_count, status, error_message, applied_at, applied_movement_count, discarded_at, discard_reason, report_type')
    .order('received_at', { ascending: false })
    .limit(limit)
  if (!includeProcessed) q = q.eq('status', 'pending')
  if (reportType) q = q.eq('report_type', reportType)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Recently processed (imported OR discarded) deliveries — the audit
// trail behind the pending queue. Doesn't include the raw_csv to keep
// the list lightweight; the table grows but each row is tiny without it.
export async function getProcessedSonarImports({ limit = 30, reportType = null } = {}) {
  let q = db.from('sonar_pending_imports')
    .select('id, received_at, filename, parsed_row_count, status, error_message, applied_at, applied_movement_count, discarded_at, discard_reason, report_type')
    .in('status', ['imported', 'discarded'])
    .order('received_at', { ascending: false })
    .limit(limit)
  if (reportType) q = q.eq('report_type', reportType)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Fetch a single pending import's full raw_csv. Separate from the list
// query so we don't ship the CSV blob for every row in the queue.
export async function getPendingSonarImport(id) {
  const { data, error } = await db
    .from('sonar_pending_imports')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data
}

// Mark a pending import as imported after the manager applies its
// movements. movementCount is the actual number of transfers created
// (may be less than parsed_row_count if rows were excluded/unmapped).
export async function markSonarPendingImportApplied(id, { movementCount, userId }) {
  if (!id) throw new Error('id required')
  const { error } = await db
    .from('sonar_pending_imports')
    .update({
      status: 'imported',
      applied_at: new Date().toISOString(),
      applied_by: userId || null,
      applied_movement_count: movementCount || 0,
    })
    .eq('id', id)
    .eq('status', 'pending')  // guard against double-applying via stale UI
  if (error) throw error
}

// Soft-discard a pending import — manager judged it not worth importing
// (test fire, duplicate, etc). Stays in the table for audit.
export async function discardSonarPendingImport(id, { reason, userId }) {
  if (!id) throw new Error('id required')
  const { error } = await db
    .from('sonar_pending_imports')
    .update({
      status: 'discarded',
      discarded_at: new Date().toISOString(),
      discarded_by: userId || null,
      discard_reason: reason || 'Discarded by manager',
    })
    .eq('id', id)
    .eq('status', 'pending')
  if (error) throw error
}

// Cheap per-location summary: how many distinct parts and total units sit
// at each location. One inventory_stock pull, aggregated client-side.
// Returns Map<location_id, { distinctParts, totalUnits }>. Used by the
// Locations tab to badge each card with what's actually inside.
export async function getStockCountsByLocation() {
  const { data, error } = await db
    .from('inventory_stock')
    .select('location_id, quantity')
  if (error) throw error
  const m = new Map()
  for (const r of data || []) {
    const qty = Number(r.quantity) || 0
    if (qty === 0) continue
    const cur = m.get(r.location_id) || { distinctParts: 0, totalUnits: 0 }
    cur.distinctParts += 1
    cur.totalUnits += qty
    m.set(r.location_id, cur)
  }
  return m
}

// Get total stock per part across all locations. Used by the Parts admin
// to sort drafts by stock volume (so high-volume drafts surface first).
// Returns Map<part_id, totalQty>.
export async function getStockTotalsByPart() {
  const { data, error } = await db
    .from('inventory_stock')
    .select('part_id, quantity')
  if (error) throw error
  const totals = new Map()
  for (const row of data || []) {
    totals.set(row.part_id, (totals.get(row.part_id) || 0) + Number(row.quantity || 0))
  }
  return totals
}

// Get stock at a warehouse including all its bins. Returns flat rows with
// the location attached so the UI can show which bin each row came from.
// Used when the Stock tab is scoped to a warehouse and we want the rollup
// view (warehouse-level stock + every bin's stock).
export async function getStockForWarehouseTree(warehouseId) {
  if (!warehouseId) return []
  // Fetch the warehouse itself plus every bin under it
  const { data: locs, error: locsErr } = await db
    .from('inventory_locations')
    .select('id, name, type, parent_location_id')
    .or(`id.eq.${warehouseId},parent_location_id.eq.${warehouseId}`)
  if (locsErr) throw locsErr

  const locIds = (locs || []).map(l => l.id)
  if (locIds.length === 0) return []

  const { data: stock, error: stockErr } = await db
    .from('inventory_stock')
    .select(`
      quantity, last_movement_at, location_id,
      parts_catalog(id, name, unit, category, material_group, is_active),
      location:inventory_locations(id, name, type, parent_location_id)
    `)
    .in('location_id', locIds)
  if (stockErr) throw stockErr
  return (stock || []).filter(r => Number(r.quantity) !== 0)
}

// ─── MOVEMENTS ───────────────────────────────────────────────────────────────

// Movement-type rules. Mirrors the DB's movement_endpoints_valid CHECK
// constraint so we fail fast in the client with a friendly message instead
// of a generic Postgres CHECK error after the round-trip. Also validates
// the type itself, which the DB enum constraint covers separately.
//
// Throws Error with a human-readable message; returns nothing on success.
export function validateMovement({ movement_type, from_location_id, to_location_id }) {
  const TYPES = ['receive', 'transfer', 'return', 'issue', 'scrap', 'adjust']
  if (!TYPES.includes(movement_type)) {
    throw new Error(`Unknown movement type "${movement_type}"`)
  }

  const hasFrom = !!from_location_id
  const hasTo   = !!to_location_id

  switch (movement_type) {
    case 'receive':
      if (hasFrom || !hasTo) throw new Error('Receive needs a destination location and no source')
      break
    case 'issue':
      if (!hasFrom || hasTo) throw new Error('Issue needs a source location and no destination')
      break
    case 'scrap':
      if (!hasFrom || hasTo) throw new Error('Scrap needs a source location and no destination')
      break
    case 'transfer':
      if (!hasFrom || !hasTo)             throw new Error('Transfer needs both source and destination')
      if (from_location_id === to_location_id) throw new Error('Transfer source and destination must be different')
      break
    case 'return':
      if (!hasFrom || !hasTo)             throw new Error('Return needs both source and destination')
      if (from_location_id === to_location_id) throw new Error('Return source and destination must be different')
      break
    case 'adjust':
      if (hasFrom && hasTo)  throw new Error('Adjust must be one-sided (positive: destination only; negative: source only)')
      if (!hasFrom && !hasTo) throw new Error('Adjust needs either a source (negative) or destination (positive)')
      break
  }
}

export async function getRecentMovements({ limit = 100, locationId = null, type = null } = {}) {
  let q = db
    .from('inventory_movements')
    .select(`
      *,
      part:parts_catalog(id, name, unit),
      from_location:inventory_locations!inventory_movements_from_location_id_fkey(id, name, type),
      to_location:inventory_locations!inventory_movements_to_location_id_fkey(id, name, type),
      created_by_user:users!inventory_movements_created_by_fkey(id, name, initials)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (type) q = q.eq('movement_type', type)
  if (locationId) {
    q = q.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`)
  }
  const { data, error } = await q
  if (error) throw error
  return data || []
}

export async function recordMovement({
  movement_type, part_id, quantity, unit,
  from_location_id, to_location_id,
  vendor_invoice, unit_cost, notes,
  task_id, submission_id, created_by,
}) {
  if (!created_by) throw new Error('recordMovement requires created_by')
  if (!part_id) throw new Error('recordMovement requires part_id')
  if (!quantity || Number(quantity) <= 0) throw new Error('quantity must be > 0')
  validateMovement({ movement_type, from_location_id, to_location_id })

  const { data, error } = await db
    .from('inventory_movements')
    .insert({
      movement_type, part_id, quantity: Number(quantity), unit: unit || null,
      from_location_id: from_location_id || null,
      to_location_id: to_location_id || null,
      vendor_invoice: vendor_invoice || null,
      unit_cost: unit_cost == null || unit_cost === '' ? null : Number(unit_cost),
      notes: notes || null,
      task_id: task_id || null,
      submission_id: submission_id || null,
      created_by,
    })
    .select(`
      *,
      part:parts_catalog(id, name, unit),
      from_location:inventory_locations!inventory_movements_from_location_id_fkey(id, name, type),
      to_location:inventory_locations!inventory_movements_to_location_id_fkey(id, name, type)
    `)
    .single()
  if (error) throw error
  return data
}

export async function recordMovementsBatch(movements) {
  if (!Array.isArray(movements) || movements.length === 0) return []

  // Validate every row up front. Throwing here rather than after the round
  // trip lets the existing chunk-and-fall-back-to-single-row callers
  // (BulkMoveSheet, InventoryImportSheet) isolate the bad row without
  // wasting a network insert that the DB would have rejected anyway.
  movements.forEach((m, i) => {
    if (!m.created_by) throw new Error(`row ${i}: created_by required`)
    if (!m.part_id) throw new Error(`row ${i}: part_id required`)
    if (!m.quantity || Number(m.quantity) <= 0) throw new Error(`row ${i}: quantity must be > 0`)
    try {
      validateMovement(m)
    } catch (e) {
      throw new Error(`row ${i}: ${e.message}`)
    }
  })

  const payload = movements.map(m => ({
    movement_type: m.movement_type,
    part_id: m.part_id,
    quantity: Number(m.quantity),
    unit: m.unit || null,
    from_location_id: m.from_location_id || null,
    to_location_id: m.to_location_id || null,
    vendor_invoice: m.vendor_invoice || null,
    unit_cost: m.unit_cost == null || m.unit_cost === '' ? null : Number(m.unit_cost),
    notes: m.notes || null,
    task_id: m.task_id || null,
    submission_id: m.submission_id || null,
    // Cost-center tag + crew attribution. The Sonar / fiber-jobs importers
    // stamp these on each row (for Sage per-phase rollups + "by consumer"
    // reporting); without forwarding them here they'd silently write NULL.
    phase_id: m.phase_id || null,
    consumed_by_user_id: m.consumed_by_user_id || null,
    created_by: m.created_by,
  }))
  const { data, error } = await db.from('inventory_movements').insert(payload).select('id')
  if (error) throw error
  return data || []
}

// ─── CREW SELF-SERVICE ──────────────────────────────────────────────────────

// Resolve the caller's effective pull location — the place inventory
// auto-deducts from on submission approval, and the destination for
// Load / source for Return.
//
// Resolution order:
//   1. users.default_pull_location_id  — explicit shared-trailer assignment
//   2. The user's personal truck       — legacy default (auto-created)
//
// Returns the inventory_locations row plus a synthesized `_isShared` bool
// so the UI can adapt copy ("What's on your truck" vs "What's at Grady's
// Trailer · shared"). Returns null if the caller has neither.
export async function getMyTruck() {
  const { data: { session } } = await db.auth.getSession()
  if (!session?.user?.id) return null
  const userId = session.user.id

  // Step 1: explicit pull-location assignment
  const { data: userRow, error: userErr } = await db
    .from('users')
    .select('default_pull_location_id')
    .eq('id', userId)
    .maybeSingle()
  if (userErr) throw userErr

  if (userRow?.default_pull_location_id) {
    const { data: loc, error: locErr } = await db
      .from('inventory_locations')
      .select('*')
      .eq('id', userRow.default_pull_location_id)
      .maybeSingle()
    if (locErr) throw locErr
    if (loc) return { ...loc, _isShared: loc.assigned_to !== userId }
  }

  // Step 2: fall back to personal truck
  const { data, error } = await db
    .from('inventory_locations')
    .select('*')
    .eq('assigned_to', userId)
    .eq('type', 'truck')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return { ...data, _isShared: false }
}

// Bulk-assign N users to a shared pull location. Atomic per-user:
// transfers personal-truck stock to the new location, sets the assignment,
// deactivates the personal truck. Returns { assigned, skipped, transfers }.
// Used by AdminUsersView's bulk-assign action.
export async function bulkAssignPullLocation({ userIds, locationId }) {
  const { data, error } = await db.rpc('bulk_assign_pull_location', {
    p_user_ids: userIds,
    p_location_id: locationId,
  })
  if (error) throw error
  return data
}

// ─── Group location membership ────────────────────────────────────────
// A group location's "members" are the users whose default_pull_location_id
// points at it (so getMyTruck resolves the group as their My-Stock). Adding
// a member reuses bulkAssignPullLocation (consolidates their personal-truck
// stock into the group + retires that truck — shared-truck semantics).

// Members of one group location.
export async function getGroupMembers(locationId) {
  if (!locationId) return []
  const { data, error } = await db
    .from('users')
    .select('id, name, initials, crew_type, is_active')
    .eq('default_pull_location_id', locationId)
    .order('name')
  if (error) throw error
  return data || []
}

// Member counts for many locations at once → Map<location_id, count>.
// Used for the group-row badge in the Locations admin.
export async function getMemberCountsByLocation(locationIds) {
  const ids = (locationIds || []).filter(Boolean)
  if (ids.length === 0) return new Map()
  const { data, error } = await db
    .from('users')
    .select('default_pull_location_id')
    .in('default_pull_location_id', ids)
  if (error) throw error
  const m = new Map()
  for (const r of data || []) {
    m.set(r.default_pull_location_id, (m.get(r.default_pull_location_id) || 0) + 1)
  }
  return m
}

// Remove a user from a group: clear the pointer and make sure they still
// have a personal truck to fall back to (getMyTruck step 2). Stock stays in
// the group — removing someone doesn't extract their share from the pool.
export async function removeUserFromGroup(userId) {
  if (!userId) throw new Error('userId required')
  const { error: uErr } = await db
    .from('users')
    .update({ default_pull_location_id: null })
    .eq('id', userId)
  if (uErr) throw uErr

  const { data: existing, error: tErr } = await db
    .from('inventory_locations')
    .select('id')
    .eq('assigned_to', userId)
    .eq('type', 'truck')
    .eq('is_active', true)
    .limit(1)
  if (tErr) throw tErr
  if (!existing || existing.length === 0) {
    const { data: u } = await db.from('users').select('name').eq('id', userId).maybeSingle()
    const first = (u?.name || 'Crew').split(' ')[0]
    await createLocation({ name: `${first}'s truck`, type: 'truck', assigned_to: userId })
  }
}

// Build + download an audit-format CSV scoped to one location. Same row
// shape as InventoryAuditTab's cross-location export so the resulting
// file imports cleanly into the existing Reconcile sheet flow.
// Triggered from the LocationDetailPanel's Export CSV button.
export async function exportLocationStockCSV(location) {
  // Match the headers/format from InventoryAuditTab.buildAuditCsv
  const HEADERS = [
    'SKU', 'Name', 'Category', 'Department', 'Material Group', 'Unit',
    'Location', 'Bin', 'Expected Qty', 'Actual Qty', 'Variance',
    'Last Movement', 'Notes',
  ]
  const csvField = v => {
    if (v == null) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }

  const isWarehouse = location.type === 'warehouse'
  const isBin = location.type === 'bin'

  // For a warehouse export, expand the scope to include the warehouse
  // itself (unbinned stock) AND every bin under it. Without this, binned
  // stock — which lives at location_id = bin_id, not warehouse_id — is
  // silently excluded from the CSV and the Bin column comes out empty.
  let bins = []
  if (isWarehouse) {
    bins = await getBinsForWarehouse(location.id)
  }
  const locationIds = isWarehouse
    ? [location.id, ...bins.map(b => b.id)]
    : [location.id]

  // Lookup for per-row Bin column labeling. For a warehouse export each
  // row's location_id will be either the warehouse (unbinned) or one of
  // its bins; we need both in the map.
  const locById = new Map()
  locById.set(location.id, location)
  for (const b of bins) locById.set(b.id, b)

  // Get stock at all scope-relevant locations. inventory_stock.last_movement_at
  // already tracks the last touch per (part, location) — use it directly
  // instead of a separate movements round trip.
  const { data: stock, error: stockErr } = await db
    .from('inventory_stock')
    .select('location_id, part_id, quantity, last_movement_at, parts_catalog (id, name, category, department, material_group, unit)')
    .in('location_id', locationIds)
  if (stockErr) throw stockErr

  // Resolve parent warehouse name for a bin-only export so the Location
  // column reads as the warehouse, not "Aisle 3 B-2".
  let parentName = ''
  if (isBin && location.parent_location_id) {
    const { data: parent } = await db
      .from('inventory_locations')
      .select('name')
      .eq('id', location.parent_location_id)
      .maybeSingle()
    parentName = parent?.name || ''
  }

  // The warehouse name for this export: itself when exporting a warehouse,
  // the parent when exporting a single bin. For non-warehouse/non-bin
  // locations (truck, job_site), it's just the location's own name.
  const warehouseName = isWarehouse ? location.name
                     : isBin        ? parentName
                     : location.name

  // Sort: warehouse-level (unbinned) first, then bins alphabetically;
  // within each group, parts alphabetically. Makes the printed sheet
  // walkable for the person doing the physical audit.
  const sortedStock = (stock || []).slice().sort((a, b) => {
    const al = locById.get(a.location_id)
    const bl = locById.get(b.location_id)
    const aBin = al?.type === 'bin' ? al.name : ''
    const bBin = bl?.type === 'bin' ? bl.name : ''
    if (aBin !== bBin) return aBin.localeCompare(bBin)
    const aName = (a.parts_catalog?.name) || a.part_id || ''
    const bName = (b.parts_catalog?.name) || b.part_id || ''
    return aName.localeCompare(bName)
  })

  const lines = [HEADERS.map(csvField).join(',')]
  sortedStock.forEach((r, idx) => {
    const rowNum = idx + 2  // 1-based + header row
    const pc = r.parts_catalog || {}
    const rowLoc = locById.get(r.location_id)
    // Bin column: bin name if this row's location is a bin; for a
    // bin-only export, every row IS a bin row, so always show its name.
    const rowBinName = rowLoc?.type === 'bin'
      ? rowLoc.name
      : (isBin ? location.name : '')
    const fields = [
      pc.id || r.part_id,
      pc.name || '',
      pc.category || '',
      pc.department || '',
      pc.material_group || '',
      pc.unit || 'ea',
      warehouseName,
      rowBinName,
      Number(r.quantity) || 0,
      '',                          // Actual qty — blank for the counter to fill in
      `=J${rowNum}-I${rowNum}`,    // Variance formula (Excel/Sheets — Actual minus Expected)
      r.last_movement_at ? new Date(r.last_movement_at).toISOString().slice(0, 10) : '',
      '',                          // Notes — blank
    ]
    lines.push(fields.map(csvField).join(','))
  })

  const csv = lines.join('\n')
  const safeName = (location.name || 'location').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
  const stamp = new Date().toISOString().slice(0, 10)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `fiberlog-audit-${safeName}-${stamp}.csv`
  a.click()
  URL.revokeObjectURL(url)
  return sortedStock.length
}

// Fetch caller's truck + stock at it in one round trip. Stock rows have
// the parts_catalog joined. Returns { truck, stock: [...] } — truck is
// null if the caller has none, in which case stock is [].
export async function getMyTruckStock() {
  const truck = await getMyTruck()
  if (!truck) return { truck: null, stock: [] }
  const stock = await getStockByLocation(truck.id)
  return { truck, stock }
}

// Return the calling user's operation-permission rows. Empty array = the
// caller can do every crew operation (default-allow). Each row in the
// result is `{ operation, allowed, reason, updated_at }`; rows with
// allowed=false are denials the UI should honor. Authoritative check
// is server-side in record_crew_movement; this is just so the UI can
// hide buttons it shouldn't show.
export async function getMyCrewPermissions() {
  const { data: { session } } = await db.auth.getSession()
  if (!session?.user?.id) return []
  const { data, error } = await db
    .from('crew_operation_permissions')
    .select('operation, allowed, reason, updated_at')
    .eq('user_id', session.user.id)
  if (error) throw error
  return data || []
}

// Record a movement on behalf of the calling crew member via the
// public.record_crew_movement RPC. Operation is one of:
//   'load'     warehouse/bucket → my truck   (other = source)
//   'return'   my truck → warehouse          (other = destination)
//   'issue'    my truck → install            (no other)
//   'scrap'    my truck → scrapped           (no other)
//   'transfer' my truck → another crew truck (other = destination)
// The RPC enforces auth, validates the operation, and inserts the
// movement; the existing inventory_stock trigger handles stock math.
export async function recordCrewMovement({
  operation, partId, quantity, otherLocationId,
  unit, notes, vendorInvoice, unitCost, taskId,
  // Load-only: optional destination override. When null/undefined the
  // RPC defaults to the caller's own truck (today's behavior). When set
  // to a non-truck location, the RPC verifies the caller has a row in
  // crew_load_destinations for it (owner bypasses).
  destinationLocationId,
} = {}) {
  if (!operation) throw new Error('operation required')
  if (!partId) throw new Error('partId required')
  if (!quantity || Number(quantity) <= 0) throw new Error('quantity must be > 0')

  const { data, error } = await db.rpc('record_crew_movement', {
    p_operation: operation,
    p_part_id: partId,
    p_quantity: Number(quantity),
    p_other_location_id: otherLocationId || null,
    p_unit: unit || null,
    p_notes: notes || null,
    p_vendor_invoice: vendorInvoice || null,
    p_unit_cost: unitCost == null || unitCost === '' ? null : Number(unitCost),
    p_task_id: taskId || null,
    p_destination_location_id: destinationLocationId || null,
  })
  if (error) throw error
  return data
}

// Allowed-destination helpers (per-user crew_load_destinations table).
// The crew picker uses getMyAllowedLoadDestinations; the Users admin
// uses get/setCrewLoadDestinations.

// Returns the caller's allowed Load destinations: own truck (always)
// plus whitelist entries. Shape:
//   [{ id, name, type, parentName, isOwnTruck }]
// Own truck is always the first entry. Empty whitelist → length 1.
export async function getMyAllowedLoadDestinations() {
  const { data: { session } } = await db.auth.getSession()
  if (!session?.user?.id) return []
  const userId = session.user.id

  // Resolve the caller's "home" load target via getMyTruck — that honors
  // users.default_pull_location_id, so a member of a shared group location
  // gets the group as their primary destination (not just a personal truck).
  // Plus the whitelist row IDs and all active locations (for name/parent
  // resolution). Flat queries — cheaper/more robust than an embedded join.
  const [home, wlRes, locsRes] = await Promise.all([
    getMyTruck(),
    db.from('crew_load_destinations')
      .select('location_id')
      .eq('user_id', userId),
    db.from('inventory_locations')
      .select('id, name, type, parent_location_id, is_active')
      .eq('is_active', true),
  ])
  if (wlRes.error) throw wlRes.error
  if (locsRes.error) throw locsRes.error

  const locById = new Map((locsRes.data || []).map(l => [l.id, l]))
  const parentNameById = new Map(
    (locsRes.data || []).filter(l => l.type === 'warehouse').map(l => [l.id, l.name])
  )

  const out = []
  if (home) {
    out.push({
      id: home.id, name: home.name, type: home.type,
      parentName: null, isOwnTruck: true,
    })
  }
  for (const row of wlRes.data || []) {
    if (home && row.location_id === home.id) continue  // de-dup
    const loc = locById.get(row.location_id)
    if (!loc) continue  // inactive or deleted; skip
    out.push({
      id: loc.id, name: loc.name, type: loc.type,
      parentName: loc.type === 'bin' ? parentNameById.get(loc.parent_location_id) || null : null,
      isOwnTruck: false,
    })
  }
  return out
}

// Owner / staff: returns a user's whitelist with location details.
export async function getCrewLoadDestinations(userId) {
  if (!userId) return []
  const { data, error } = await db
    .from('crew_load_destinations')
    .select('location_id')
    .eq('user_id', userId)
  if (error) throw error
  const ids = (data || []).map(r => r.location_id)
  if (ids.length === 0) return []
  const { data: locs } = await db
    .from('inventory_locations')
    .select('id, name, type, parent_location_id, is_active, assigned_to')
    .in('id', ids)
  return locs || []
}

// Owner-only (RLS enforced server-side). Replaces a user's whitelist
// atomically: delete all existing rows, insert the new set. Pass an
// empty array to clear the whitelist (revert to truck-only).
export async function setCrewLoadDestinations(userId, locationIds, { grantedBy = null, notes = null } = {}) {
  if (!userId) throw new Error('userId required')
  const ids = Array.from(new Set((locationIds || []).filter(Boolean)))

  // Atomic replace: delete existing, then insert (best-effort — Postgres
  // can't transact two REST calls, but the second failing leaves the user
  // with no rows which matches today's "truck-only" default. Reasonable
  // failure mode.)
  const del = await db.from('crew_load_destinations').delete().eq('user_id', userId)
  if (del.error) throw del.error
  if (ids.length === 0) return 0

  const rows = ids.map(location_id => ({
    user_id: userId, location_id,
    granted_by: grantedBy, notes,
  }))
  const ins = await db.from('crew_load_destinations').insert(rows)
  if (ins.error) throw ins.error
  return ids.length
}

// ─── PARTS CATALOG ──────────────────────────────────────────────────────────

export async function getPartsCatalogIndex() {
  const { data, error } = await db
    .from('parts_catalog')
    .select('id, name, unit, category, material_group, is_active')
  if (error) throw error
  const byId = new Map()
  const byName = new Map()
  for (const p of data || []) {
    byId.set(p.id, p)
    if (p.name) byName.set(p.name.trim().toLowerCase(), p)
  }
  return { byId, byName, all: data || [] }
}

// Get all parts with full metadata. Filtering and search happen in the UI
// since the dataset (~600 rows) is small enough to load once.
export async function getAllParts() {
  const { data, error } = await db
    .from('parts_catalog')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

// Build a category string in the same `Department / Material Group` pattern
// that's already used in parts_catalog.
function buildCategory(department, materialGroup) {
  const d = (department || '').trim()
  const m = (materialGroup || '').trim()
  if (d && m) return `${d} / ${m}`
  if (d) return d
  if (m) return m
  return 'Uncategorized'
}

// Update a part's editable metadata. Auto-rebuilds `category` whenever
// department or material_group changes.
export async function updatePart(id, updates) {
  let category
  if ('department' in updates || 'material_group' in updates) {
    const { data: cur, error: fetchErr } = await db
      .from('parts_catalog')
      .select('department, material_group')
      .eq('id', id)
      .single()
    if (fetchErr) throw fetchErr
    const dept = 'department' in updates ? updates.department : cur.department
    const matgrp = 'material_group' in updates ? updates.material_group : cur.material_group
    category = buildCategory(dept, matgrp)
  }

  const payload = { ...updates }
  if (category !== undefined) payload.category = category

  const { data, error } = await db
    .from('parts_catalog')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Bulk-update many parts with the SAME partial update. Handles category
// recomputation correctly:
//   - If both department and material_group are set in updates, every row
//     gets the same category (single bulk UPDATE).
//   - If only one is set, we fetch each row's current sibling value so
//     each part gets its own correct category (per-row UPDATE).
//   - If neither, single bulk UPDATE with payload as-is.
//
// Returns { updated, errors } where errors is per-row { id, message }.
export async function updatePartsBatch(ids, updates) {
  if (!Array.isArray(ids) || ids.length === 0) return { updated: [], errors: [] }

  const hasDept = 'department' in updates
  const hasMatGrp = 'material_group' in updates

  // Path 1: both dept + matgrp present, OR neither present → single bulk UPDATE
  if ((hasDept && hasMatGrp) || (!hasDept && !hasMatGrp)) {
    const payload = { ...updates }
    if (hasDept && hasMatGrp) {
      payload.category = buildCategory(updates.department, updates.material_group)
    }
    const { data, error } = await db
      .from('parts_catalog')
      .update(payload)
      .in('id', ids)
      .select('id')
    if (error) throw error
    return { updated: data || [], errors: [] }
  }

  // Path 2: only one of dept/matgrp — need per-row category recompute
  const { data: current, error: fetchErr } = await db
    .from('parts_catalog')
    .select('id, department, material_group')
    .in('id', ids)
  if (fetchErr) throw fetchErr

  const updated = []
  const errors = []
  for (const row of current || []) {
    const dept   = hasDept   ? updates.department    : row.department
    const matgrp = hasMatGrp ? updates.material_group : row.material_group
    const payload = { ...updates, category: buildCategory(dept, matgrp) }
    const { data, error } = await db
      .from('parts_catalog')
      .update(payload)
      .eq('id', row.id)
      .select('id')
      .maybeSingle()
    if (error) errors.push({ id: row.id, message: error.message })
    else if (data) updated.push(data)
  }
  return { updated, errors }
}

// Insert a single part. Used by the Receive PO flow when the manager
// types a part the catalog hasn't seen before. Defaults to is_active=true
// since this is a real-world receive (the part exists, you're holding it).
// `category` is recomputed from department + material_group so it stays
// consistent with the rest of the catalog.
export async function createPart({ id, name, unit, department, material_group, barcode, is_active = true }) {
  if (!id || !String(id).trim()) throw new Error('Part SKU is required')
  if (!name || !String(name).trim()) throw new Error('Part name is required')
  const cleanId = String(id).trim()
  const cleanName = String(name).trim()
  const dept = department && String(department).trim() ? String(department).trim() : null
  const matGrp = material_group && String(material_group).trim() ? String(material_group).trim() : null

  const { data, error } = await db
    .from('parts_catalog')
    .insert({
      id: cleanId,
      name: cleanName,
      unit: unit && String(unit).trim() ? String(unit).trim() : 'ea',
      department: dept,
      material_group: matGrp,
      category: buildCategory(dept, matGrp),
      barcode: barcode && String(barcode).trim() ? String(barcode).trim() : null,
      is_active,
    })
    .select()
  if (error) throw error
  return Array.isArray(data) && data.length > 0 ? data[0] : null
}

// Bulk-create draft parts during a CSV import. Each draft gets is_active=false
// so it's marked as needing review.
//
// Strategy: row-by-row inserts so we get per-SKU success/failure visibility.
// Slower than a single batch but completely deterministic — no silent
// "empty success" cases possible.
//
// Returns { created, errors } where errors is an array of { id, message }
// per failed row.
export async function createDraftParts(drafts) {
  console.log('[createDraftParts] called with', drafts.length, 'drafts')

  if (!Array.isArray(drafts) || drafts.length === 0) {
    return { created: [], errors: [] }
  }

  const created = []
  const errors = []

  for (const d of drafts) {
    const row = {
      id: d.id,
      name: d.name && d.name.trim() ? d.name.trim() : d.id,
      unit: d.unit && d.unit.trim() ? d.unit.trim() : 'ea',
      is_active: false,
      barcode: d.barcode || null,
      department: d.department || null,
      item_type: d.item_type || null,
      material_group: d.material_group || null,
      category: buildCategory(d.department, d.material_group),
    }
    const { data, error } = await db
      .from('parts_catalog')
      .insert(row)
      .select('id')
      .maybeSingle()
    if (error) {
      console.warn('[createDraftParts] failed for', d.id, error.message)
      errors.push({ id: d.id, message: error.message })
    } else if (data) {
      created.push(data)
    } else {
      console.warn('[createDraftParts] empty result for', d.id)
      errors.push({ id: d.id, message: 'Insert returned no row (possible RLS/visibility issue)' })
    }
  }

  console.log('[createDraftParts] completed:', created.length, 'created,', errors.length, 'errors')
  return { created, errors }
}

export async function searchInventoryParts(query) {
  if (!query || query.length < 2) return []
  return searchPartsCatalog(query, {
    cols: 'id, name, nickname, unit, category, material_group, is_active',
    limit: 20,
  })
}

// ─── AUDIT ─────────────────────────────────────────────────────────────────────

// Pull stock data for an audit/cycle-count export. Returns one row per
// (location, part) combination that matches the filters, sorted in
// walk-order (location → bin → part name).
//
// Filters:
//   - locationIds: null (= all) OR array of specific location ids to include
//   - partStatus: 'active' | 'draft' | 'all' (default 'active')
//   - stockLevel: 'with' | 'zero_negative' | 'all' (default 'with')
//   - department: optional exact match
//   - materialGroup: optional exact match
//   - staleDays: optional — only rows whose last_movement_at is older than N days
export async function getStockForAudit({
  locationIds = null,
  partStatus = 'active',
  stockLevel = 'with',
  department = null,
  materialGroup = null,
  staleDays = null,
} = {}) {
  let q = db
    .from('inventory_stock')
    .select(`
      quantity, last_movement_at, location_id, part_id,
      parts_catalog!inner(id, name, unit, category, department, material_group, item_type, is_active),
      location:inventory_locations!inner(
        id, name, type, parent_location_id,
        assigned_user:users!inventory_locations_assigned_to_fkey(id, name)
      )
    `)
    .limit(20000)   // safety ceiling for big audits

  if (Array.isArray(locationIds) && locationIds.length > 0) {
    q = q.in('location_id', locationIds)
  }

  if (partStatus === 'active') q = q.eq('parts_catalog.is_active', true)
  if (partStatus === 'draft')  q = q.eq('parts_catalog.is_active', false)

  if (department)    q = q.eq('parts_catalog.department', department)
  if (materialGroup) q = q.eq('parts_catalog.material_group', materialGroup)

  if (staleDays != null && Number(staleDays) > 0) {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - Number(staleDays))
    q = q.lt('last_movement_at', cutoff.toISOString())
  }

  const { data, error } = await q
  if (error) throw error

  // Stock-level filter happens client-side since it's a numeric comparison
  // on quantity (inventory_stock has rows with zero qty too).
  let rows = data || []
  if (stockLevel === 'with') {
    rows = rows.filter(r => Number(r.quantity) > 0)
  } else if (stockLevel === 'zero_negative') {
    rows = rows.filter(r => Number(r.quantity) <= 0)
  }

  return rows
}

// Distinct department + material_group values from the catalog. Used by
// the audit tab to populate filter dropdowns.
export async function getPartsCatalogTaxonomy() {
  const { data, error } = await db
    .from('parts_catalog')
    .select('department, material_group')
  if (error) throw error
  const depts = new Set()
  const matGroups = new Set()
  for (const p of data || []) {
    if (p.department) depts.add(p.department)
    if (p.material_group) matGroups.add(p.material_group)
  }
  return {
    departments: [...depts].sort(),
    materialGroups: [...matGroups].sort(),
  }
}

// ─── SONAR FIBER-JOBS REPORT ────────────────────────────────────────────
//
// Second Sonar report shape: "All fiber all jobs". Each row is a customer
// job (install / drop / fix) and the consumed materials are buried in
// free-text columns (box used, Drop type/length, Pushable fiber, etc.).
// One row → 0–N transfer movements, parsed via sonar_fiber_value_map.
//
// Parse modes for the mapping table:
//   • fixed_unit         — value present → 1 unit of mapped SKU
//   • length_from_text   — extract first number → qty in unit (typically ft)
//   • pair_with_column   — qty comes from another column in same row
//   • ignore             — skip silently (N/A, na, none, blank)
//   • manual             — surface as 'ask' in per-row preview; no SKU yet

export const FIBER_QTY_MODE_OPTIONS = [
  { id: 'fixed_unit',       label: 'Fixed 1 unit' },
  { id: 'length_from_text', label: 'Length from text (ft)' },
  { id: 'pair_with_column', label: 'Qty from paired column' },
  { id: 'ignore',           label: 'Ignore (no movement)' },
  { id: 'manual',           label: 'Ask per row (manual qty)' },
]

// Values that always mean "nothing was used" — never generate a movement.
const FIBER_NA_VALUES = new Set(['', 'n/a', 'na', 'n/a.', 'none', 'no', '-', '--'])

export function isFiberValueIgnored(v) {
  return FIBER_NA_VALUES.has((v || '').trim().toLowerCase())
}

export async function getFiberValueMap() {
  const { data, error } = await db
    .from('sonar_fiber_value_map')
    .select('column_name, value_text, sku, qty_mode, pair_column, default_qty')
  if (error) throw error
  // Keyed by `${column_name}::${value_text}` (case-insensitive on value)
  const m = new Map()
  for (const row of data || []) {
    const key = `${row.column_name}::${(row.value_text || '').toLowerCase()}`
    m.set(key, row)
  }
  return m
}

export async function setFiberValueMap({ columnName, valueText, sku, qtyMode, pairColumn = null, defaultQty = 1 }) {
  if (!columnName || !valueText) throw new Error('columnName and valueText required')
  if (!['fixed_unit', 'length_from_text', 'pair_with_column', 'ignore', 'manual'].includes(qtyMode)) {
    throw new Error(`Invalid qty_mode: ${qtyMode}`)
  }
  if (qtyMode === 'pair_with_column' && !pairColumn) {
    throw new Error('pair_column required for pair_with_column mode')
  }
  const { error } = await db
    .from('sonar_fiber_value_map')
    .upsert(
      {
        column_name: columnName,
        value_text: valueText,
        sku: qtyMode === 'ignore' ? null : sku,
        qty_mode: qtyMode,
        pair_column: qtyMode === 'pair_with_column' ? pairColumn : null,
        default_qty: defaultQty || 1,
      },
      { onConflict: 'column_name,value_text' }
    )
  if (error) throw error
}

export async function clearFiberValueMap({ columnName, valueText }) {
  if (!columnName || !valueText) return
  const { error } = await db
    .from('sonar_fiber_value_map')
    .delete()
    .eq('column_name', columnName)
    .eq('value_text', valueText)
  if (error) throw error
}

// Extract first numeric value from a text. "Pre-termed Drop - 150'" → 150.
// "Pushable Bullet Fiber Cable 75 ft" → 75. Falls back to null.
export function extractFirstNumber(text) {
  if (!text) return null
  const m = /(-?\d+(?:\.\d+)?)/.exec(String(text))
  return m ? parseFloat(m[1]) : null
}

// Parse one fiber-jobs row into 0–N material lines based on the map.
// `row` is a parsed CSV record (object keyed by column name).
// `columnsConsidered` is the set of columns we'll inspect — defaults to
// all keys of the row.
// Returns an array of:
//   { columnName, valueText, sku, qty, qtyMode, status, reason }
// where status is 'ready' | 'ignore' | 'unmapped' | 'manual' | 'pair-missing'.
export function parseFiberRow(row, fiberValueMap, columnsConsidered = null) {
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

// Columns we know NEVER carry a material (no point checking them).
// Includes the report's identity columns + the "length of flat used"
// column which is only a paired qty source (never its own SKU).
export const FIBER_NON_MATERIAL_COLUMNS = new Set([
  'Job | Address on Completion',
  'Job Type | Name',
  'Job | Completion Notes',
  'Account | ID',
  'User | Username',
  'Job | Completion Date time',
  'Project',
  'length of flat used',  // referenced by Drop type/length pair_with_column
])

// ─── SAGE INTACCT EXPORT ─────────────────────────────────────────────────
//
// Build a CSV of movements in Sage Intacct's Inventory Transactions
// import format. Prototype: starts with Intacct defaults for transaction
// type names + uses FiberLog names directly as warehouse/project codes.
// We'll layer in a code mapping table once the actual Sage column codes
// are known.
//
// Three-step lifecycle:
//   1. getMovementsForSageExport(...) — fetch movements ready to export
//   2. buildSageCsv(movements) — generate the CSV text
//   3. markMovementsExported(ids, batchId) — stamp exported_at + batch_id
//      so the next export skips them

// Movement type → Sage Intacct transaction type. Defaults; customize per
// company in Sage Settings if these names don't match.
const SAGE_TRANSACTION_TYPE = {
  receive: 'Inventory Receipt',
  transfer: 'Inventory Transfer',
  return: 'Inventory Transfer',
  issue: 'Inventory Issue',
  scrap: 'Inventory Adjustment',
  adjust: 'Inventory Adjustment',
}

// Fetch movements that haven't been exported yet, joined with everything
// we need to populate the Sage columns. Personal trucks are filtered at
// export-time (see buildSageCsv) — they're FiberLog-internal staging,
// not Sage-relevant.
export async function getMovementsForSageExport({ since, until, includeExported = false } = {}) {
  // FK constraints must be referenced by full constraint name (matches
  // the rest of the codebase's PostgREST embed pattern). The column-name
  // shorthand silently broke this query in the first cut — looked like
  // "no movements" because the preflight was rejecting the join.
  let q = db.from('inventory_movements')
    .select(`
      id, movement_type, quantity, unit, unit_cost, notes, created_at,
      exported_at, export_batch_id, submission_id, task_id, vendor_invoice,
      part:parts_catalog(id, name, unit, department, material_group, category),
      from_location:inventory_locations!inventory_movements_from_location_id_fkey(id, name, type, parent_location_id, project_id),
      to_location:inventory_locations!inventory_movements_to_location_id_fkey(id, name, type, parent_location_id, project_id),
      phase:phases!inventory_movements_phase_id_fkey(id, name, project_id, project:projects(id, name))
    `)
    .order('created_at', { ascending: true })
  if (since) q = q.gte('created_at', since)
  if (until) q = q.lte('created_at', until)
  if (!includeExported) q = q.is('exported_at', null)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Decide whether a movement should be included in the export.
//
// Always-excluded:
//   • truck → truck (internal crew handoffs)
//   • warehouse/bin ↔ warehouse/bin under the SAME parent warehouse
//     (internal binning / unbinning / bin rearrangement — these are
//      noise in an accounting export and were the user's flag for the
//      "transfers within the warehouse" bug).
//
// Opt-in via {strictConsumption: true}:
//   • Additionally exclude warehouse/bin ↔ truck (crew loadouts +
//     returns) — these are staging, not consumption. The follow-up
//     auto-deduct (truck → project bucket) IS consumption and stays.
//
// What always stays in the export (default mode AND strict):
//   receive, transfer to job_site (consumption), issue/scrap, adjust,
//   inter-warehouse transfers (warehouse → warehouse different parents).
export function isExportableMovement(m, { strictConsumption = false } = {}) {
  // (0) Always exclude `adjust` — count corrections are FiberLog-internal
  // bookkeeping (cycle-count reconciliations, audit-CSV variances, manual
  // fixes). They don't represent purchases, consumption, transfers, or
  // scrap, and Sage Intacct runs its own physical-inventory reconciliation
  // — double-correcting in both systems would misstate the books.
  if (m.movement_type === 'adjust') return false

  const fromType = m.from_location?.type
  const toType = m.to_location?.type

  // (1) Always exclude truck → truck.
  if (fromType === 'truck' && toType === 'truck') return false

  // (2) Always exclude warehouse-internal movements. For a warehouse,
  //     its "hierarchy id" is itself; for a bin it's its parent. When
  //     both endpoints resolve to the same hierarchy id, the move
  //     never left the warehouse — no Sage relevance.
  const isWhOrBin = t => t === 'warehouse' || t === 'bin'
  if (isWhOrBin(fromType) && isWhOrBin(toType)) {
    const fromWh = m.from_location?.type === 'bin'
      ? m.from_location?.parent_location_id
      : m.from_location?.id
    const toWh = m.to_location?.type === 'bin'
      ? m.to_location?.parent_location_id
      : m.to_location?.id
    if (fromWh && toWh && fromWh === toWh) return false
  }

  // (3) Strict consumption: also exclude truck staging.
  if (strictConsumption) {
    if (fromType === 'truck' && toType !== 'job_site') return false
    if (toType === 'truck' && fromType !== 'job_site') return false
  }

  return true
}

// Build CSV text in Sage Intacct Inventory Transactions format.
// One row per movement. Quote anything with commas/newlines.
export function buildSageCsv(movements, opts = {}) {
  const headers = [
    'TRANSACTIONTYPE',
    'DATE',
    'REFERENCENO',
    'LINE',
    'ITEMID',
    'ITEMDESC',
    'QUANTITY',
    'UNIT',
    'PRICE',
    'FROM_WAREHOUSE',
    'TO_WAREHOUSE',
    'TO_BIN',
    'PROJECTID',
    'CLASSID',
    'DEPARTMENTID',
    'VENDORID',
    'MEMO',
    'FIBERLOG_MOVEMENT_ID',
  ]
  const lines = [headers.join(',')]
  let lineIdx = 0
  for (const m of movements) {
    if (!isExportableMovement(m, opts)) continue
    lineIdx++

    const date = m.created_at ? String(m.created_at).slice(0, 10) : ''
    const txnType = SAGE_TRANSACTION_TYPE[m.movement_type] || 'Inventory Adjustment'
    const referenceNo = m.submission_id
      ? `SUB-${String(m.submission_id).slice(0, 8)}`
      : `MV-${String(m.id).slice(0, 8)}`

    // Warehouse columns: bin-aware. If destination is a bin, the
    // warehouse code is the parent warehouse's name, and BIN holds
    // the bin name. Source is treated the same way.
    const fromName = m.from_location?.type === 'bin'
      ? '' // bin source: parent warehouse name not joined; leave blank for now
      : (m.from_location?.name || '')
    const toName = m.to_location?.type === 'bin'
      ? '' // see above
      : (m.to_location?.name || '')
    const toBin = m.to_location?.type === 'bin' ? m.to_location.name : ''

    // PROJECTID + CLASSID — phase tag drives both when present.
    // Phase's parent project becomes PROJECTID; phase name → CLASSID.
    // Fallback: destination bucket's project_id resolves to project name.
    const projectId = m.phase?.project?.name
      || (m.to_location?.type === 'job_site' ? (m.to_location.name || '') : '')
    const classId = m.phase?.name || ''

    // Vendor parsed from receive notes "Vendor: X" pattern (best-effort)
    let vendorId = ''
    if (m.movement_type === 'receive' && m.notes) {
      const vm = /Vendor:\s*([^|·\n]+)/i.exec(m.notes)
      if (vm) vendorId = vm[1].trim()
    }

    const row = [
      txnType,
      date,
      referenceNo,
      lineIdx,
      m.part?.id || '',
      m.part?.name || '',
      m.quantity,
      m.unit || m.part?.unit || 'ea',
      m.unit_cost ?? '',
      fromName,
      toName,
      toBin,
      projectId,
      classId,
      m.part?.department || '',
      vendorId,
      m.notes || '',
      m.id,
    ]
    lines.push(row.map(escapeSageCsvField).join(','))
  }
  return lines.join('\n')
}

function escapeSageCsvField(v) {
  const s = String(v == null ? '' : v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

// Stamp a batch of movements as exported. Two writes:
//   1. INSERT a row in inventory_export_batches (parent of the FK from
//      inventory_movements.export_batch_id — must exist before referencing)
//   2. UPDATE each movement's exported_at + export_batch_id
// Returns the inserted batch row so the UI can show batchId + the
// canonical exported_at timestamp.
export async function markMovementsExported(movementIds, { userId = null, notes = null } = {}) {
  if (!Array.isArray(movementIds) || movementIds.length === 0) return null
  const { data: batch, error: bErr } = await db
    .from('inventory_export_batches')
    .insert({
      exported_by: userId,
      movement_count: movementIds.length,
      notes: notes || 'Sage Intacct export',
    })
    .select('id, exported_at, movement_count')
    .single()
  if (bErr) throw bErr

  const { error: uErr } = await db
    .from('inventory_movements')
    .update({
      exported_at: batch.exported_at,  // align with the batch's canonical timestamp
      export_batch_id: batch.id,
    })
    .in('id', movementIds)
  if (uErr) throw uErr

  return batch
}

// ─── PURCHASE REQUESTS ───────────────────────────────────────────────────────
//
// FiberLog-originated PRs. Replaces the manual spreadsheet workflow:
// composition + cost-history lookup happens in the app; export is CSV
// (column order matches Utah Broadband's PR template) or a plaintext
// email body for handoff to procurement. Lifecycle: pending → ordered
// → received (or cancelled).

// Most recent unit_cost recorded on a receive movement for this part.
// NULL if the part has never been received through FiberLog.
export async function getLastUnitCost(partId) {
  if (!partId) return null
  const { data, error } = await db
    .from('inventory_movements')
    .select('unit_cost, created_at')
    .eq('movement_type', 'receive')
    .eq('part_id', partId)
    .not('unit_cost', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data?.unit_cost != null ? Number(data.unit_cost) : null
}

// Top recent vendor strings parsed from inventory_movements.vendor_invoice
// on receive movements. Receive PO writes vendor info into that column
// (sometimes the bare vendor name, sometimes "Vendor: X · ..." style).
// Returns a deduped list of vendor strings ordered by recency.
export async function getRecentVendors({ limit = 25 } = {}) {
  const { data, error } = await db
    .from('inventory_movements')
    .select('vendor_invoice, created_at')
    .eq('movement_type', 'receive')
    .not('vendor_invoice', 'is', null)
    .order('created_at', { ascending: false })
    .limit(400)  // overscan; we'll dedupe client-side
  if (error) throw error
  const seen = new Set()
  const out = []
  for (const r of data || []) {
    const v = (r.vendor_invoice || '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= limit) break
  }
  return out
}

// Insert a PR + its lines. Allocates pr_number via next_pr_number RPC.
// Returns the inserted PR row joined with its lines.
export async function createPurchaseRequest({
  dateRequested = null,
  targetLocationId = null,
  notes = null,
  lines = [],
  createdBy = null,
} = {}) {
  if (!createdBy) throw new Error('createdBy required')
  if (lines.length === 0) throw new Error('At least one line is required')

  // Allocate the PR number via the helper function.
  const { data: prNumData, error: prNumErr } = await db.rpc('next_pr_number')
  if (prNumErr) throw prNumErr

  const { data: prRow, error: prErr } = await db
    .from('purchase_requests')
    .insert({
      pr_number: prNumData,
      date_requested: dateRequested || new Date().toISOString().slice(0, 10),
      target_location_id: targetLocationId || null,
      notes: notes || null,
      created_by: createdBy,
    })
    .select()
    .single()
  if (prErr) throw prErr

  // Insert lines. Use a stable ordered_position so re-renders don't shuffle.
  const linesPayload = lines.map((l, i) => ({
    request_id: prRow.id,
    ordered_position: i,
    vendor: (l.vendor || null) && String(l.vendor).trim() || null,
    quantity: Number(l.quantity || 0),
    part_id: l.part_id || null,
    item_number: (l.item_number || null) && String(l.item_number).trim() || null,
    description: (l.description || '').trim(),
    project_reason: (l.project_reason || null) && String(l.project_reason).trim() || null,
    unit_cost: l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost),
    notes: (l.notes || null) && String(l.notes).trim() || null,
  }))
  for (const lp of linesPayload) {
    if (!lp.description) throw new Error('Each line needs a description')
    if (!lp.quantity || lp.quantity <= 0) throw new Error('Each line needs a quantity > 0')
  }
  const { data: insertedLines, error: linesErr } = await db
    .from('purchase_request_lines')
    .insert(linesPayload)
    .select()
  if (linesErr) throw linesErr

  return { ...prRow, lines: insertedLines || [] }
}

// List PRs with their line counts + totals. Filters by status; defaults
// to "active" set (pending + ordered).
export async function getPurchaseRequests({ statuses = ['pending', 'ordered', 'partial'], limit = 100 } = {}) {
  let q = db
    .from('purchase_requests')
    .select(`
      *,
      created_by_user:users!purchase_requests_created_by_fkey(id, name),
      target_location:inventory_locations!purchase_requests_target_location_id_fkey(id, name, type),
      lines:purchase_request_lines(id, quantity, unit_cost, vendor)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (statuses && statuses.length > 0) q = q.in('status', statuses)
  const { data, error } = await q
  if (error) throw error
  // Compute aggregates client-side so the UI doesn't have to.
  return (data || []).map(pr => {
    const lineCount = pr.lines?.length || 0
    let estTotal = 0
    const vendors = new Set()
    for (const l of pr.lines || []) {
      const qty = Number(l.quantity || 0)
      const uc = l.unit_cost == null ? null : Number(l.unit_cost)
      if (uc != null) estTotal += qty * uc
      if (l.vendor) vendors.add(l.vendor)
    }
    return {
      ...pr,
      lineCount,
      estTotal,
      vendors: Array.from(vendors),
    }
  })
}

// Full PR detail with lines. Used by the detail/edit sheet.
export async function getPurchaseRequest(prId) {
  if (!prId) return null
  const { data: pr, error: prErr } = await db
    .from('purchase_requests')
    .select(`
      *,
      created_by_user:users!purchase_requests_created_by_fkey(id, name),
      approved_by_user:users!purchase_requests_approved_by_fkey(id, name),
      target_location:inventory_locations!purchase_requests_target_location_id_fkey(id, name, type)
    `)
    .eq('id', prId)
    .maybeSingle()
  if (prErr) throw prErr
  if (!pr) return null
  const { data: lines, error: linesErr } = await db
    .from('purchase_request_lines')
    .select('*, part:parts_catalog(id, name, unit)')
    .eq('request_id', prId)
    .order('ordered_position', { ascending: true, nullsFirst: false })
  if (linesErr) throw linesErr
  return { ...pr, lines: lines || [] }
}

// Update PR header fields (status, vendor, po, ETA, notes, etc.).
export async function updatePurchaseRequest(prId, fields = {}) {
  if (!prId) throw new Error('prId required')
  const patch = { ...fields }
  // Stamp approved_at when status flips to ordered (procurement got it).
  if (patch.status === 'ordered' && !patch.approved_at) {
    patch.approved_at = new Date().toISOString()
  }
  const { data, error } = await db
    .from('purchase_requests')
    .update(patch)
    .eq('id', prId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Replace a PR's lines (delete all + insert new). Used by the edit
// flow while PR is still pending. Throws if PR isn't pending.
export async function replacePurchaseRequestLines(prId, lines = []) {
  if (!prId) throw new Error('prId required')
  if (lines.length === 0) throw new Error('At least one line is required')
  const { data: pr } = await db.from('purchase_requests').select('status').eq('id', prId).maybeSingle()
  if (pr && pr.status !== 'pending') {
    throw new Error('Lines can only be edited while PR is pending')
  }
  const { error: delErr } = await db.from('purchase_request_lines').delete().eq('request_id', prId)
  if (delErr) throw delErr
  const linesPayload = lines.map((l, i) => ({
    request_id: prId,
    ordered_position: i,
    vendor: (l.vendor || null) && String(l.vendor).trim() || null,
    quantity: Number(l.quantity || 0),
    part_id: l.part_id || null,
    item_number: (l.item_number || null) && String(l.item_number).trim() || null,
    description: (l.description || '').trim(),
    project_reason: (l.project_reason || null) && String(l.project_reason).trim() || null,
    unit_cost: l.unit_cost == null || l.unit_cost === '' ? null : Number(l.unit_cost),
    notes: (l.notes || null) && String(l.notes).trim() || null,
  }))
  for (const lp of linesPayload) {
    if (!lp.description) throw new Error('Each line needs a description')
    if (!lp.quantity || lp.quantity <= 0) throw new Error('Each line needs a quantity > 0')
  }
  const { data, error: insErr } = await db
    .from('purchase_request_lines')
    .insert(linesPayload)
    .select()
  if (insErr) throw insErr
  return data || []
}

export async function deletePurchaseRequest(prId) {
  if (!prId) throw new Error('prId required')
  const { error } = await db.from('purchase_requests').delete().eq('id', prId)
  if (error) throw error
}

// Receive a single PR line — books one `receive` movement into the PR's
// target location and advances the line's running `received_qty`. Supports
// partial quantities (receive some now, the rest later) so partial vendor
// deliveries / backorders book accurately.
//
// Freeform lines (no catalog part_id) require the caller to resolve a
// `partId` first — either by linking an existing SKU or creating a new part
// (via createPart). The resolved id is persisted onto the line so it stops
// being freeform.
//
// After the line updates, the PR status is recomputed from the full line
// set: all lines fully received → 'received'; some received → 'partial'.
//
// Returns the reloaded PR (header + lines) so the caller can re-render.
export async function receivePurchaseRequestLine({ lineId, partId = null, quantity, createdBy } = {}) {
  if (!lineId) throw new Error('lineId required')
  if (!createdBy) throw new Error('createdBy required')
  const qty = Number(quantity)
  if (!qty || qty <= 0) throw new Error('quantity must be > 0')

  // Load the line (+ catalog part for the unit).
  const { data: line, error: lineErr } = await db
    .from('purchase_request_lines')
    .select('*, part:parts_catalog(id, name, unit)')
    .eq('id', lineId)
    .maybeSingle()
  if (lineErr) throw lineErr
  if (!line) throw new Error('PR line not found')

  // Header gives us the target location + pr_number for the movement note.
  const { data: header, error: hErr } = await db
    .from('purchase_requests')
    .select('id, pr_number, status, target_location_id, received_at')
    .eq('id', line.request_id)
    .maybeSingle()
  if (hErr) throw hErr
  if (!header) throw new Error('PR not found')
  if (header.status === 'cancelled') throw new Error('PR is cancelled')
  if (!header.target_location_id) {
    throw new Error('PR has no "Deliver to" location set — open the PR and pick one before receiving')
  }

  // A movement needs a real catalog part. Freeform lines must bring one in.
  const effectivePartId = line.part_id || partId
  if (!effectivePartId) {
    throw new Error('This freeform line has no catalog part — link or create one before receiving')
  }

  const already = Number(line.received_qty || 0)
  const remaining = Number(line.quantity || 0) - already
  if (remaining <= 0) throw new Error('This line is already fully received')
  if (qty - remaining > 1e-9) throw new Error(`Can only receive up to ${remaining} more on this line`)

  // Persist the resolved part_id so a freeform line is no longer freeform.
  if (!line.part_id && partId) {
    const { error: pErr } = await db
      .from('purchase_request_lines')
      .update({ part_id: partId })
      .eq('id', lineId)
    if (pErr) throw pErr
  }

  // Book the receive movement (trigger increments inventory_stock).
  await recordMovement({
    movement_type: 'receive',
    part_id: effectivePartId,
    quantity: qty,
    unit: line.part?.unit || null,
    from_location_id: null,
    to_location_id: header.target_location_id,
    vendor_invoice: line.vendor || null,
    unit_cost: line.unit_cost != null ? Number(line.unit_cost) : null,
    notes: `Received from ${header.pr_number}` + (line.project_reason ? ` · ${line.project_reason}` : ''),
    created_by: createdBy,
  })

  // Advance the line's running received counter.
  const { error: uErr } = await db
    .from('purchase_request_lines')
    .update({ received_qty: already + qty, received_at: new Date().toISOString() })
    .eq('id', lineId)
  if (uErr) throw uErr

  // Recompute PR status from the (now-updated) full line set.
  const fresh = await getPurchaseRequest(header.id)
  const allLines = fresh.lines || []
  const allReceived = allLines.length > 0 &&
    allLines.every(l => Number(l.received_qty || 0) >= Number(l.quantity || 0))
  const anyReceived = allLines.some(l => Number(l.received_qty || 0) > 0)
  const nextStatus = allReceived ? 'received' : (anyReceived ? 'partial' : fresh.status)
  if (nextStatus !== fresh.status || (allReceived && !fresh.received_at)) {
    const patch = { status: nextStatus }
    if (allReceived && !fresh.received_at) patch.received_at = new Date().toISOString()
    await updatePurchaseRequest(header.id, patch)
    fresh.status = nextStatus
    if (patch.received_at) fresh.received_at = patch.received_at
  }
  return fresh
}

// Receive all *remaining* catalog lines on a PR in one shot (the bulk
// convenience action). Loops the per-line receive for every line that has a
// part_id and still has quantity outstanding. Freeform lines can't be
// auto-received (no SKU) — they're returned in `skippedFreeform` so the UI
// can prompt the manager to link/create a part and receive them one-by-one.
//
// Returns: { linesReceived: int, skippedFreeform: array }
export async function markPurchaseRequestReceived(prId, { createdBy } = {}) {
  if (!prId) throw new Error('prId required')
  if (!createdBy) throw new Error('createdBy required')

  const pr = await getPurchaseRequest(prId)
  if (!pr) throw new Error('PR not found')
  if (pr.status === 'received') throw new Error('PR is already received')
  if (!pr.target_location_id) {
    throw new Error('PR has no "Deliver to" location set — open the PR and pick one before receiving')
  }

  const skippedFreeform = []
  let linesReceived = 0
  for (const l of pr.lines || []) {
    const remaining = Number(l.quantity || 0) - Number(l.received_qty || 0)
    if (remaining <= 0) continue                         // already fully received
    if (!l.part_id) { skippedFreeform.push(l); continue } // freeform → manual resolve
    // Each call re-reads the line, so looping stays consistent. Status is
    // recomputed inside, so by the last line the PR settles to received.
    await receivePurchaseRequestLine({ lineId: l.id, quantity: remaining, createdBy })
    linesReceived++
  }

  return { linesReceived, skippedFreeform }
}

// Build a CSV that matches Utah Broadband's PR spreadsheet column order
// so purchasing can paste directly into their template.
export function buildPurchaseRequestCsv(pr) {
  const headers = [
    'PR Number', 'Date Requested', 'Deliver To', 'Requested By',
    'Vendor', 'Qty', 'Item #', 'Description', 'Project/Reason',
    'Unit Price', 'Line Total',
  ]
  const csvField = v => {
    if (v == null) return ''
    const s = String(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
  const deliverTo = pr.target_location?.name || ''
  const requestedBy = pr.created_by_user?.name || ''
  const lines = [headers.map(csvField).join(',')]
  for (const l of pr.lines || []) {
    const qty = Number(l.quantity || 0)
    const uc = l.unit_cost == null ? null : Number(l.unit_cost)
    const lineTotal = uc == null ? '' : (qty * uc).toFixed(2)
    const row = [
      pr.pr_number || '',
      pr.date_requested || '',
      deliverTo,
      requestedBy,
      l.vendor || '',
      qty,
      l.item_number || l.part_id || '',
      l.description || '',
      l.project_reason || '',
      uc == null ? '' : uc.toFixed(2),
      lineTotal,
    ]
    lines.push(row.map(csvField).join(','))
  }
  // UTF-8 BOM so Excel reads accented characters / em-dashes correctly.
  return '﻿' + lines.join('\n')
}

// Plaintext email body — manager copies to clipboard and pastes into
// whichever mail client.
export function buildPurchaseRequestEmail(pr) {
  const deliverTo = pr.target_location?.name || '—'
  const requestedBy = pr.created_by_user?.name || '—'
  const dateRequested = pr.date_requested || ''
  const fmt$ = n => n == null ? '—' : '$' + Number(n).toFixed(2)

  let subtotal = 0
  let anyUnknownCost = false
  const lineRows = (pr.lines || []).map(l => {
    const qty = Number(l.quantity || 0)
    const uc = l.unit_cost == null ? null : Number(l.unit_cost)
    const total = uc == null ? null : qty * uc
    if (uc == null) anyUnknownCost = true
    else subtotal += total
    return {
      vendor: l.vendor || '—',
      qty,
      item: l.item_number || l.part_id || '',
      desc: l.description || '',
      reason: l.project_reason || '',
      unit$: fmt$(uc),
      total$: fmt$(total),
    }
  })
  // Pad columns for readable plaintext alignment.
  const widths = {
    vendor: Math.max(8, ...lineRows.map(r => r.vendor.length)),
    qty: Math.max(3, ...lineRows.map(r => String(r.qty).length)),
    item: Math.max(8, ...lineRows.map(r => r.item.length)),
    desc: Math.max(20, ...lineRows.map(r => r.desc.length)),
    reason: Math.max(8, ...lineRows.map(r => r.reason.length)),
    unit$: Math.max(8, ...lineRows.map(r => r.unit$.length)),
    total$: Math.max(10, ...lineRows.map(r => r.total$.length)),
  }
  const pad = (s, w, right = false) => {
    const str = String(s)
    if (str.length >= w) return str
    const padding = ' '.repeat(w - str.length)
    return right ? padding + str : str + padding
  }
  const head = `  ${pad('Vendor', widths.vendor)}  ${pad('Qty', widths.qty, true)}  ${pad('Item #', widths.item)}  ${pad('Description', widths.desc)}  ${pad('Project/Reason', widths.reason)}  ${pad('Unit $', widths.unit$, true)}  ${pad('Line Total', widths.total$, true)}`
  const sep = '  ' + '─'.repeat(head.length - 2)
  const body = lineRows.map(r =>
    `  ${pad(r.vendor, widths.vendor)}  ${pad(r.qty, widths.qty, true)}  ${pad(r.item, widths.item)}  ${pad(r.desc, widths.desc)}  ${pad(r.reason, widths.reason)}  ${pad(r.unit$, widths.unit$, true)}  ${pad(r.total$, widths.total$, true)}`
  ).join('\n')

  return [
    `Purchase Request ${pr.pr_number}`,
    `Date requested: ${dateRequested}`,
    `Deliver to: ${deliverTo}`,
    `Requested by: ${requestedBy}`,
    pr.notes ? `Notes: ${pr.notes}` : '',
    '',
    head,
    sep,
    body,
    sep,
    `${' '.repeat(head.length - widths.total$ - 12)}Subtotal:  ${pad(fmt$(subtotal), widths.total$, true)}`,
    `${' '.repeat(head.length - widths.total$ - 12)}Total:     ${pad(fmt$(subtotal), widths.total$, true)}`,
    anyUnknownCost ? '\nNote: One or more lines have no unit price; fill in before sending.' : '',
  ].filter(Boolean).join('\n')
}

// ─── FOUND-INVENTORY INTAKE REQUESTS (backlog #19) ───────────────────────────
//
// A crew member physically holding a part the system doesn't show files a
// PENDING request — NO stock moves yet. A manager approves it (approve_intake_
// request RPC) which books a `receive` movement into a warehouse and, for parts
// not yet in the catalog, creates a draft part inside the RPC (crew can't write
// parts_catalog or receive/adjust movements — that's why this is gated through
// approval, not record_crew_movement). Reject carries a reason.

// Create a pending intake request. RLS scopes the insert to the caller
// (requested_by = auth.uid()). For a part already in the catalog pass `partId`;
// for one that isn't, pass `isDraft:true` + the draft fields and the part is
// materialized (is_active=false) when the manager approves.
export async function createIntakeRequest({
  partId = null, isDraft = false,
  draftName = null, draftUnit = null, draftDepartment = null, draftMaterialGroup = null,
  quantity, targetLocationId, reason = null, requestedBy = null,
} = {}) {
  if (!requestedBy) throw new Error('requestedBy required')
  if (!targetLocationId) throw new Error('Pick a destination warehouse')
  const qty = Number(quantity)
  if (!qty || qty <= 0) throw new Error('Quantity must be greater than 0')
  if (!partId && !isDraft) throw new Error('Pick a part or add a new one')
  if (isDraft && !String(draftName || '').trim()) throw new Error('New part needs a name')

  const { data, error } = await db
    .from('inventory_intake_requests')
    .insert({
      part_id: partId || null,
      is_draft: !!isDraft,
      draft_name: isDraft ? String(draftName).trim() : null,
      draft_unit: isDraft ? (String(draftUnit || 'ea').trim() || 'ea') : null,
      draft_department: isDraft ? (String(draftDepartment || '').trim() || null) : null,
      draft_material_group: isDraft ? (String(draftMaterialGroup || '').trim() || null) : null,
      quantity: qty,
      target_location_id: targetLocationId,
      reason: (reason || '').trim() || null,
      requested_by: requestedBy,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// List intake requests (manager queue). Defaults to pending. Joins the
// requester, destination location, and (when set) the catalog part.
export async function getIntakeRequests({ statuses = ['pending'], limit = 200 } = {}) {
  let q = db
    .from('inventory_intake_requests')
    .select(`
      *,
      requested_by_user:users!inventory_intake_requests_requested_by_fkey(id, name, initials),
      reviewed_by_user:users!inventory_intake_requests_reviewed_by_fkey(id, name),
      target_location:inventory_locations!inventory_intake_requests_target_location_id_fkey(id, name, type),
      part:parts_catalog!inventory_intake_requests_part_id_fkey(id, name, unit, is_active)
    `)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (statuses && statuses.length > 0) q = q.in('status', statuses)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

// Approve → books the receive movement (+ creates the draft part if needed),
// transactionally + idempotently inside the RPC. Manager identity comes from
// auth.uid() server-side. Mirrors approveSubmission's wrapper shape.
export async function approveIntakeRequest(id, note = null) {
  const { data, error } = await db.rpc('approve_intake_request', {
    p_request_id: id,
    p_note: note || null,
  })
  if (error) throw error
  return data
}

// Reject with an optional reason. No stock moves.
export async function rejectIntakeRequest(id, note = null) {
  const { data, error } = await db.rpc('reject_intake_request', {
    p_request_id: id,
    p_note: note || null,
  })
  if (error) throw error
  return data
}

// ─── FOOTAGE TYPE → PART MAP ──────────────────────────────────────────────────
//
// Ties a crew footage "type" pick (fiber strand count / conduit size) to the
// canonical parts_catalog SKU that footage should consume. The crew workspace
// resolves the selected fiberCount / conduitSize + footage into an entry_parts
// row at submit; approve_submission then auto-deducts it like any other part.
// Manager-curated (staff write). Mirrors the sonar_fiber_value_map pattern.

// Returns { fiber: { '144ct': { partId, name, unit } }, conduit: { '2"': {…} } }.
export async function getFootageTypePartMap() {
  const { data, error } = await db
    .from('footage_type_part_map')
    .select('kind, type_value, part_id, part:parts_catalog!footage_type_part_map_part_id_fkey(id, name, unit)')
  if (error) throw error
  const out = { fiber: {}, conduit: {} }
  for (const r of data || []) {
    if (!out[r.kind]) out[r.kind] = {}
    out[r.kind][r.type_value] = {
      partId: r.part_id,
      name: r.part?.name || r.part_id,
      unit: r.part?.unit || 'ft',
    }
  }
  return out
}

// Upsert one mapping (kind = 'fiber' | 'conduit'). Staff-only via RLS.
export async function setFootageTypePart(kind, typeValue, partId) {
  const { data: { user } } = await db.auth.getUser()
  const { error } = await db
    .from('footage_type_part_map')
    .upsert(
      { kind, type_value: typeValue, part_id: partId, updated_by: user?.id || null },
      { onConflict: 'kind,type_value' }
    )
  if (error) throw error
}

// Remove a mapping (reverts that type to footage-only, no material).
export async function clearFootageTypePart(kind, typeValue) {
  const { error } = await db
    .from('footage_type_part_map')
    .delete()
    .eq('kind', kind)
    .eq('type_value', typeValue)
  if (error) throw error
}
