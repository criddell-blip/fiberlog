// FiberLog inventory API. Operations on inventory_locations, inventory_movements,
// inventory_stock, and parts_catalog. Keeps the inventory module decoupled
// from the rest of supabase.js so we can extract it later if needed.

import { db, searchPartsCatalog } from './supabase'

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
  const typeOrder = { warehouse: 0, truck: 1, job_site: 2, vendor: 3, scrap: 4, bin: 5 }
  return (data || []).sort((a, b) => {
    const t = (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9)
    if (t !== 0) return t
    const an = a.assigned_user?.name || a.name || ''
    const bn = b.assigned_user?.name || b.name || ''
    return an.localeCompare(bn)
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
  return (data || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
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
      displayLabel: parentName ? `${parentName} · ${loc.name}` : loc.name,
      qty,
    })
    entry.totalQty += qty
  }
  for (const e of byPart.values()) {
    e.locations.sort((a, b) => b.qty - a.qty)
  }
  return Array.from(byPart.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
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
  { id: 'none',    label: 'Always None',        desc: 'Wireless equipment that always goes to None' },
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

  // Get stock at the location with full part info
  const { data: stock, error: stockErr } = await db
    .from('inventory_stock')
    .select('*, parts_catalog (id, name, category, department, material_group, unit)')
    .eq('location_id', location.id)
  if (stockErr) throw stockErr

  // Resolve last-movement timestamps per part at this location
  const partIds = (stock || []).map(s => s.part_id).filter(Boolean)
  let lastMoves = {}
  if (partIds.length > 0) {
    const { data: moves } = await db
      .from('inventory_movements')
      .select('part_id, created_at')
      .or(`from_location_id.eq.${location.id},to_location_id.eq.${location.id}`)
      .in('part_id', partIds)
      .order('created_at', { ascending: false })
    for (const m of (moves || [])) {
      if (!lastMoves[m.part_id]) lastMoves[m.part_id] = m.created_at
    }
  }

  // Resolve parent warehouse name for bins
  let parentName = ''
  if (location.type === 'bin' && location.parent_location_id) {
    const { data: parent } = await db
      .from('inventory_locations')
      .select('name')
      .eq('id', location.parent_location_id)
      .maybeSingle()
    parentName = parent?.name || ''
  }

  const isBin = location.type === 'bin'
  const locName = isBin ? parentName : location.name
  const binName = isBin ? location.name : ''

  const lines = [HEADERS.map(csvField).join(',')]
  ;(stock || []).forEach((r, idx) => {
    const rowNum = idx + 2  // 1-based + header row
    const pc = r.parts_catalog || {}
    const fields = [
      pc.id || r.part_id,
      pc.name || '',
      pc.category || '',
      pc.department || '',
      pc.material_group || '',
      pc.unit || 'ea',
      locName,
      binName,
      Number(r.quantity) || 0,
      '',                          // Actual qty — blank for the counter to fill in
      `=J${rowNum}-I${rowNum}`,    // Variance formula (Excel/Sheets — Actual minus Expected)
      lastMoves[r.part_id] ? new Date(lastMoves[r.part_id]).toISOString().slice(0, 10) : '',
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
  return (stock || []).length
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
  })
  if (error) throw error
  return data
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
// Currently filters out: truck → truck (internal crew handoffs).
// Truck → bucket (consumption) and warehouse → truck (load-out) are kept.
export function isExportableMovement(m) {
  const fromType = m.from_location?.type
  const toType = m.to_location?.type
  // Skip pure truck-to-truck (internal staging; no Sage relevance yet)
  if (fromType === 'truck' && toType === 'truck') return false
  return true
}

// Build CSV text in Sage Intacct Inventory Transactions format.
// One row per movement. Quote anything with commas/newlines.
export function buildSageCsv(movements) {
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
    if (!isExportableMovement(m)) continue
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
