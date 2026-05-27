// Cycle-counting JS layer — wraps the Phase 1 RPCs + adds the read
// helpers the UI uses (active run, session detail, pending runs queue).
//
// All RPCs are server-side gated on is_staff() (owner/manager). Calls
// from crew accounts will throw 42501 — fail-fast in the UI.

import { db } from './supabase'

// ─── Bin barcode format ─────────────────────────────────────────────────
// Bin labels encode `BIN:<uuid>`. The prefix lets us distinguish bin scans
// from part SKU scans in the same input field.
const BIN_PREFIX = 'BIN:'

export function isBinCode(code) {
  return typeof code === 'string' && code.startsWith(BIN_PREFIX)
}

export function parseBinCode(code) {
  if (!isBinCode(code)) return null
  return code.slice(BIN_PREFIX.length).trim()
}

export function formatBinCode(binId) {
  return `${BIN_PREFIX}${binId}`
}

// ─── RPCs ───────────────────────────────────────────────────────────────

export async function startCountRun({
  warehouseId = null,
  notes = null,
  isFirstBinning = false,
} = {}) {
  const { data, error } = await db.rpc('start_count_run', {
    p_warehouse_id: warehouseId,
    p_notes: notes,
    p_is_first_binning: isFirstBinning,
  })
  if (error) throw error
  return data
}

export async function startOrResumeCountSession({ runId, binId }) {
  const { data, error } = await db.rpc('start_or_resume_count_session', {
    p_run_id: runId,
    p_bin_id: binId,
  })
  if (error) throw error
  return data
}

export async function recordCountLine({ sessionId, partId, countedQty }) {
  const { data, error } = await db.rpc('record_count_line', {
    p_session_id: sessionId,
    p_part_id: partId,
    p_counted_qty: countedQty,
  })
  if (error) throw error
  return data
}

export async function submitCountSession(sessionId) {
  const { data, error } = await db.rpc('submit_count_session', {
    p_session_id: sessionId,
  })
  if (error) throw error
  return data
}

export async function endCountRunAndReconcile(runId) {
  const { data, error } = await db.rpc('end_count_run_and_reconcile', {
    p_run_id: runId,
  })
  if (error) throw error
  return data
}

export async function approveCountResolution({ resolutionId, note = null }) {
  const { data, error } = await db.rpc('approve_count_resolution', {
    p_resolution_id: resolutionId,
    p_note: note,
  })
  if (error) throw error
  return data
}

export async function discardCountResolution({ resolutionId, reason }) {
  const { data, error } = await db.rpc('discard_count_resolution', {
    p_resolution_id: resolutionId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

export async function discardCountRun({ runId, reason }) {
  const { data, error } = await db.rpc('discard_count_run', {
    p_run_id: runId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

// ─── Read helpers ───────────────────────────────────────────────────────

// Most recent in-progress run started by the caller. Used at sheet-open
// time to offer "Resume your run from earlier" instead of always starting
// a new one.
export async function getMyActiveRun(userId) {
  const { data, error } = await db
    .from('count_runs')
    .select('*, scope_warehouse:scope_warehouse_id(id,name)')
    .eq('started_by', userId)
    .eq('status', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

// All sessions in a run with bin info. Used to render the "bins counted so
// far" list at the top of the counter screen.
export async function getRunSessions(runId) {
  const { data, error } = await db
    .from('count_sessions')
    .select('*, location:location_id(id,name,parent_location_id)')
    .eq('run_id', runId)
    .order('started_at', { ascending: true })
  if (error) throw error
  return data || []
}

// All count_lines for a session, joined with part info. The counter screen
// renders one row per line; lines without counted_qty are "unfinished".
export async function getSessionLines(sessionId) {
  const { data, error } = await db
    .from('count_lines')
    .select('*, part:parts_catalog(id,name,unit,category)')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

// Resolve a bin by id (after scanning BIN:<uuid>). Returns null if not
// found or not a bin or inactive.
export async function getBinById(binId) {
  const { data, error } = await db
    .from('inventory_locations')
    .select('id,name,type,is_active,parent_location_id')
    .eq('id', binId)
    .maybeSingle()
  if (error) throw error
  if (!data || data.type !== 'bin' || data.is_active === false) return null
  return data
}

// Resolve a part by SKU. SKU is the parts_catalog.id (text). Returns null
// if not found.
export async function getPartBySku(sku) {
  const { data, error } = await db
    .from('parts_catalog')
    .select('id,name,unit,category,is_active')
    .eq('id', sku)
    .maybeSingle()
  if (error) throw error
  return data
}

// Warehouses for the run-start picker. Active warehouses only.
export async function getWarehousesForCount() {
  const { data, error } = await db
    .from('inventory_locations')
    .select('id,name')
    .eq('type', 'warehouse')
    .eq('is_active', true)
    .order('name')
  if (error) throw error
  return data || []
}

// Closed + discarded runs for the history view. Newest first.
export async function getCompletedCountRuns({ limit = 30 } = {}) {
  const { data, error } = await db
    .from('count_runs')
    .select(`
      *,
      counter:started_by(id,name),
      scope_warehouse:scope_warehouse_id(id,name)
    `)
    .in('status', ['closed', 'discarded'])
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (error) throw error
  return data || []
}

// Pending-review runs for the manager queue (Phase 3, prebuilt here for
// when we get there).
export async function getPendingCountRuns() {
  const { data, error } = await db
    .from('count_runs')
    .select(`
      *,
      counter:started_by(id,name),
      scope_warehouse:scope_warehouse_id(id,name)
    `)
    .eq('status', 'pending_review')
    .order('completed_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Full detail of one run for the review sheet: sessions, lines, resolutions.
export async function getCountRunDetail(runId) {
  const [runRes, sessionsRes, resolutionsRes] = await Promise.all([
    db.from('count_runs')
      .select('*, counter:started_by(id,name), scope_warehouse:scope_warehouse_id(id,name), reviewer:count_resolutions(reviewed_by(id,name))')
      .eq('id', runId)
      .maybeSingle(),
    db.from('count_sessions')
      .select('*, location:location_id(id,name,parent_location_id)')
      .eq('run_id', runId)
      .order('started_at'),
    db.from('count_resolutions')
      .select(`
        *,
        part:part_id(id,name,unit),
        from_session:from_session_id(id,location:location_id(id,name)),
        to_session:to_session_id(id,location:location_id(id,name))
      `)
      .eq('run_id', runId)
      .order('created_at'),
  ])
  if (runRes.error) throw runRes.error
  if (sessionsRes.error) throw sessionsRes.error
  if (resolutionsRes.error) throw resolutionsRes.error
  return {
    run: runRes.data,
    sessions: sessionsRes.data || [],
    resolutions: resolutionsRes.data || [],
  }
}
