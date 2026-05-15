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

export async function deactivateLocation(id) {
  return updateLocation(id, { is_active: false })
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

export async function getStockByPart(partId) {
  const { data, error } = await db
    .from('inventory_stock')
    .select('quantity, last_movement_at, location:inventory_locations(id, name, type, assigned_to)')
    .eq('part_id', partId)
  if (error) throw error
  return (data || []).filter(r => Number(r.quantity) !== 0)
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

// Resolve the caller's personal truck (the inventory_location auto-created
// when the user was made a crew/contractor). Returns the row or null if
// the caller has none — e.g. role isn't crew yet, or the trigger hasn't
// fired (shouldn't happen post-backfill but defensive).
export async function getMyTruck() {
  const { data: { session } } = await db.auth.getSession()
  if (!session?.user?.id) return null
  const { data, error } = await db
    .from('inventory_locations')
    .select('*')
    .eq('assigned_to', session.user.id)
    .eq('type', 'truck')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
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
    cols: 'id, name, unit, category, material_group, is_active',
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
