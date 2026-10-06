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

// countedQty: null is a deliberate "un-count" — the RPC restores an expected
// line's counted_qty to NULL (back to "still missing"). Guarded server-side:
// NULL is rejected for unexpected (expected_qty=0) lines — those are removed
// via delete_count_line — and when no line exists at all (backlog #39).
export async function recordCountLine({ sessionId, partId, countedQty }) {
  const { data, error } = await db.rpc('record_count_line', {
    p_session_id: sessionId,
    p_part_id: partId,
    p_counted_qty: countedQty,
  })
  if (error) throw error
  return data
}

// Unlock a SUBMITTED bin session for corrections (backlog #39). Only valid
// while the parent run is still in_progress — once the run is ended
// (reconciling/pending_review/closed) the counts are consumed and the RPC
// refuses. Idempotent on an already-in_progress session.
export async function reopenCountSession(sessionId) {
  const { data, error } = await db.rpc('reopen_count_session', {
    p_session_id: sessionId,
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

// Hard-delete an unexpected (expected_qty=0) count line from an
// in_progress session. Used when a counter scans/picks a part by
// mistake during a count — the only previous "undo" was to clear
// counted_qty back to NULL, which left a phantom line in the session
// (and risked a fat-finger 0 turning into a real adjust at end of run).
//
// The RPC guards: expected lines (expected_qty != 0) cannot be removed
// — they must remain require-count for the audit. Submitted sessions
// cannot be edited.
export async function removeCountLine(lineId) {
  const { error } = await db.rpc('delete_count_line', {
    p_line_id: lineId,
  })
  if (error) throw error
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

// Settle a PENDING gain/loss some other way than "approve as counted":
//   countedNow         — reviewer's fresh recount of that bin. The adjustment
//                        becomes countedNow minus the books AT THAT BIN NOW;
//                        a match closes the variance with no movement.
//   counterLocationId  — book the difference as a transfer from (gain) / to
//                        (loss) the place the stock really came from / went.
//   splits             — [{ locationId, qty }]: the same, spread over several
//                        locations (3 to one truck, 1 to another…). Whatever
//                        the splits don't cover books as an adjust at the bin.
//                        Use instead of counterLocationId, never both.
// Any combination, or none (none = plain approve).
// expectedSystem = the book qty the reviewer was SHOWN; the RPC refuses
// ("Books changed…", isStaleBooksError) if stock at the bin moved since.
export async function resolveCountResolution({ resolutionId, countedNow = null, counterLocationId = null, splits = null, note = null, expectedSystem = null }) {
  const { data, error } = await db.rpc('resolve_count_resolution', {
    p_resolution_id: resolutionId,
    p_counted_now: countedNow,
    p_counter_location_id: counterLocationId,
    p_note: note,
    p_expected_system: countedNow == null ? null : expectedSystem,
    p_splits: splits?.length ? splits.map(s => ({ location_id: s.locationId, qty: Number(s.qty) })) : null,
  })
  if (error) throw error
  return data
}

// What resolve_count_resolution WILL post, computed client-side for the
// confirm button. Must mirror the RPC exactly:
//   diff = countedNow − systemNow when recounted, else ±resolution qty
//   diff 0 → nothing posted (variance closed as discarded)
//   counter location → transfer (gain: counter → bin, loss: bin → counter)
//   splits → one transfer per split + an adjust for the remainder; a split
//     that adds up to more than the difference is refused (over: true)
//   else → one-sided adjust at the bin
export function previewResolution({ resolutionType, quantity, countedNow = null, systemNow = null, counterLocationId = null, splits = null }) {
  const recounted = countedNow != null && countedNow !== ''
  if (recounted && systemNow == null) return null  // still loading the books
  const diff = recounted
    ? Number(countedNow) - Number(systemNow)
    : (resolutionType === 'net_gain' ? Number(quantity) : -Number(quantity))
  if (splits?.length) {
    const qty = Math.abs(diff)
    const splitTotal = Math.round(splits.reduce((sum, s) => sum + Number(s.qty), 0) * 1e6) / 1e6
    return {
      diff, action: 'split', qty, splitTotal,
      remainder: Math.max(0, qty - splitTotal),
      over: splitTotal > qty,
      direction: diff > 0 ? 'from_counter' : 'to_counter',
    }
  }
  if (diff === 0) return { diff: 0, action: 'none' }
  if (counterLocationId) return { diff, action: 'transfer', direction: diff > 0 ? 'from_counter' : 'to_counter', qty: Math.abs(diff) }
  return { diff, action: 'adjust', qty: Math.abs(diff) }
}

// Recount a (part, bin) the run counted that has NO pending variance — an
// auto-reconciled transfer or an already-approved line that turned out wrong.
// Posts one correcting adjust tagged with the run. Returns
// { movement_id, system_qty, counted_qty, diff } (movement_id null on a match).
export async function recountCountLocation({ runId, partId, locationId, countedNow, note = null, expectedSystem = null }) {
  const { data, error } = await db.rpc('recount_count_location', {
    p_run_id: runId,
    p_part_id: partId,
    p_location_id: locationId,
    p_counted_now: countedNow,
    p_note: note,
    p_expected_system: expectedSystem,
  })
  if (error) throw error
  return data
}

export function isStaleBooksError(e) {
  return e?.hint === 'stale_books' || /Books changed since/.test(e?.message || '')
}

// Book qty of one part at one location right now (0 when there's no row).
// The recount panels show it so the reviewer sees exactly what the
// adjustment will be before posting.
export async function getStockQtyAt(partId, locationId) {
  const { data, error } = await db
    .from('inventory_stock')
    .select('quantity')
    .eq('part_id', partId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw error
  return Number(data?.quantity || 0)
}

// Recent adjustments + count-run moves of ONE part anywhere, newest first.
// The review sheet shows these beside a variance: a −40 here next to last
// Tuesday's +40 on the next shelf is almost always the same stock.
export async function getRecentPartAdjustments(partId, { days = 21, limit = 25 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await db
    .from('inventory_movements')
    .select(`
      id, movement_type, quantity, notes, created_at, count_run_id,
      from_location_id, to_location_id,
      from_location:inventory_locations!inventory_movements_from_location_id_fkey(id, name, type),
      to_location:inventory_locations!inventory_movements_to_location_id_fkey(id, name, type)
    `)
    .eq('part_id', partId)
    .gte('created_at', since)
    .or('movement_type.eq.adjust,count_run_id.not.is.null')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
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
  // Corrections posted from the review sheet by recount_count_location are
  // tagged with the run but belong to no resolution — list them so the run
  // shows its whole story.
  const resMovementIds = new Set((resolutionsRes.data || []).map(r => r.movement_id).filter(Boolean))
  const { data: recountMoves, error: mvErr } = await db.from('inventory_movements')
    .select(`
      id, quantity, notes, created_at, from_location_id, to_location_id,
      part:parts_catalog(id, name, unit),
      from_location:inventory_locations!inventory_movements_from_location_id_fkey(id, name),
      to_location:inventory_locations!inventory_movements_to_location_id_fkey(id, name)
    `)
    .eq('count_run_id', runId)
    .eq('movement_type', 'adjust')
    .like('notes', 'Count review recount%')
    .order('created_at')
  if (mvErr) throw mvErr
  return {
    run: runRes.data,
    sessions: sessionsRes.data || [],
    resolutions: resolutionsRes.data || [],
    recounts: (recountMoves || []).filter(m => !resMovementIds.has(m.id)),
  }
}
