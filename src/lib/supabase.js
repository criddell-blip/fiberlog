import { createClient } from '@supabase/supabase-js'

// Read from Vite env vars (.env / .env.local). Hardcoded fallbacks are kept
// so a build still works if .env goes missing — the anon key is public
// (RLS is the access boundary), so embedding it in the bundle is intended.
// To point local dev at a different Supabase project, drop overrides into
// .env.local (gitignored).
// Exported so other modules (e.g. ReportsView calling an edge function)
// can avoid re-declaring the constants. Both are intentionally public —
// the anon key is RLS-gated and intended to ship in the bundle.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://attduslwidxecmjifsnl.supabase.co'
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0dGR1c2x3aWR4ZWNtamlmc25sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzkxMzcsImV4cCI6MjA5MTQxNTEzN30.Gg-W0XR2neAT9nVtPxnUiwk1HpHqsOi_PJjYVucdXkc'

export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// Search parts_catalog by name OR id, returning up to `limit` deduped rows.
// Implemented as two parallel `.ilike()` queries instead of one `.or()`
// filter because PostgREST's filter grammar treats `,()`:.` as reserved,
// and even with the documented quoted-value workaround, supabase-js's
// URLSearchParams encoding fails on certain combinations (e.g.
// "Bolt, Machine"). Two queries dodges the entire encoding problem at
// the cost of one extra round-trip — the calls run in parallel so the
// added latency is just the slower of the two, not a sum.
//
// `cols` lets callers tighten the projection for narrow dropdowns.
// Searches parts_catalog across every text attribute that could plausibly
// help a user find a part: SKU, name, barcode, BoxHero ID, department,
// material group, item type, and the computed category. Skipped: `unit`
// (matches "ea" / "ft" / "lb" too generically) and the numeric boxhero_item_id.
//
// Internally runs one ILIKE query per searchable column in parallel, then
// merges + de-dupes by SKU. Order of priority for the de-dupe is the same
// as the array below (name first, then SKU, then the metadata fields) so
// the most "intentional" match for a given query lands at the top.
//
// Single OR-query would be 1 round trip vs 8, but parallel queries avoid
// the PostgREST escaping hazard when the user's query contains commas
// (real-world example: "Bolt, Thimble Eye 5/8").
export async function searchPartsCatalog(query, { cols = 'id, name, nickname, unit', limit = 20 } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  // Tokenize on whitespace and AND the tokens within each column — chained
  // .ilike() calls on one builder combine with AND. A single whole-phrase
  // %pattern% made multi-word queries useless: "lag bolt box" found nothing
  // because no field contains that exact substring, while the part is named
  // "Lag Bolts, 1/2 x 4 (Box of 50)". Every token must hit the SAME column
  // (predictable; cross-column token splits don't match).
  const tokens = q.split(/\s+/).filter(Boolean)

  // Searched in priority order — first hit wins after de-dupe.
  const searchedCols = [
    'nickname',       // crew-facing alias ("house box" → Calix NID)
    'name',           // part description
    'id',             // SKU
    'barcode',        // scanned UPC/EAN
    'boxhero_id',     // legacy BoxHero text id (e.g. UB-12345)
    'department',     // e.g. "Construction"
    'material_group', // e.g. "Fiber"
    'item_type',      // e.g. "Splice"
    'category',       // computed "Department / Material Group"
  ]

  const results = await Promise.all(
    searchedCols.map(col => {
      let qb = db.from('parts_catalog').select(cols)
      for (const tok of tokens) qb = qb.ilike(col, `%${tok}%`)
      return qb.order('name').limit(limit)
    })
  )

  for (const r of results) {
    if (r.error) throw r.error
  }

  const seen = new Set()
  const out = []
  for (const r of results) {
    for (const row of (r.data || [])) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      out.push(row)
      if (out.length >= limit) break
    }
    if (out.length >= limit) break
  }
  return out
}

// ─── PROJECTS ────────────────────────────────────────────────────────────────
export async function getFullTree() {
  const [{ data: projects, error: pErr }, { data: phases, error: phErr }, { data: tasks, error: tErr }] =
    await Promise.all([
      db.from('projects').select('*').eq('status', 'active').order('name'),
      db.from('phases').select('*').order('sequence_order'),
      db.from('tasks').select('*, creator:users!tasks_created_by_fkey(id, name, initials)').order('name'),
    ])
  if (pErr) throw pErr
  if (phErr) throw phErr
  if (tErr) throw tErr

  return projects.map(p => ({
    ...p,
    fiber: p.total_fiber_ft || 0,
    conduit: p.total_conduit_ft || 0,
    phases: phases
      .filter(ph => ph.project_id === p.id)
      .map(ph => ({
        ...ph,
        tasks: tasks
          .filter(t => t.phase_id === ph.id)
          .map(t => ({ ...t, type: t.task_type || 'aerial', notes: t.scope_notes || '' }))
      }))
  }))
}

export async function addTask(phaseId, name, jobType, notes, userId) {
  const { data, error } = await db
    .from('tasks')
    .insert({
      phase_id: phaseId,
      name,
      task_type: jobType,
      scope_notes: notes,
      status: 'open',
      created_by: userId || null,
    })
    .select('*, creator:users!tasks_created_by_fkey(id, name, initials)')
    .single()
  if (error) throw error
  return data
}

// Manager-controlled task lifecycle (backlog #2). `is_closed` — not
// `status` — is what gates crew visibility/editability now: a task stays
// open across as many passdowns as needed and the manager closes it
// explicitly when the work is truly done. Approving a submission no longer
// touches this. Passing closed=false reopens (clears closed_at/closed_by).
export async function setTaskClosed(taskId, closed, userId) {
  const { error } = await db
    .from('tasks')
    .update({
      is_closed: closed,
      closed_at: closed ? new Date().toISOString() : null,
      closed_by: closed ? (userId || null) : null,
    })
    .eq('id', taskId)
  if (error) throw error
}

// ─── SITES (INFRA WORKFLOW) ──────────────────────────────────────────────────
// Infra crews work against sites (towers, business installs, MDU equipment
// closets) rather than fiber phases. Sites live under projects via
// sites.project_id. Tasks anchor to either phase_id (fiber) or site_id (infra)
// — enforced by the tasks_anchor_present CHECK constraint.

// getInfraTree builds the projects-with-sites-with-tasks shape consumed by
// InfraCrewApp. It mirrors getFullTree() but pivots on sites instead of phases.
// Returns only projects that actually have sites — keeps the sidebar focused
// on what infra crew can act on. Fiber-only regional projects (no sites) and
// projects in non-active status are hidden.
export async function getInfraTree() {
  const [{ data: projects, error: pErr }, { data: sites, error: sErr }, { data: tasks, error: tErr }] =
    await Promise.all([
      db.from('projects').select('*').eq('status', 'active').order('name'),
      db.from('sites').select('*').eq('status', 'active').order('name'),
      // Pull every site-anchored task — same join as getFullTree for creator chip.
      db.from('tasks')
        .select('*, creator:users!tasks_created_by_fkey(id, name, initials)')
        .not('site_id', 'is', null)
        .order('name'),
    ])
  if (pErr) throw pErr
  if (sErr) throw sErr
  if (tErr) throw tErr

  // Surface any unmapped sites (project_id IS NULL) so they can't silently
  // vanish from the tree. Right now we only warn — the Sites admin (TBD)
  // will give the owner a UI to fix these. Today there's one known case:
  // Prestige II (originally tagged "Fiber - Mdu") needs a regional project
  // assignment before infra crew can see it.
  const unmapped = sites.filter(s => s.project_id == null)
  if (unmapped.length > 0) {
    console.warn(
      `[getInfraTree] ${unmapped.length} site(s) have project_id IS NULL and will not appear in the infra tree until mapped:`,
      unmapped.map(s => s.name).join(', ')
    )
  }

  return projects
    .map(p => {
      const projSites = sites
        .filter(s => s.project_id === p.id)
        .map(s => ({
          ...s,
          tasks: tasks
            .filter(t => t.site_id === s.id)
            .map(t => ({ ...t, type: t.task_type || 'aerial', notes: t.scope_notes || '' }))
        }))
      return { ...p, sites: projSites }
    })
    .filter(p => p.sites.length > 0)
}

// Fetch all active sites for a project. Used by the manager-side Sites
// admin embedded in ProjectManager — the InfraCrewApp already gets sites
// nested under projects via getInfraTree(), so this is the standalone
// per-project flavor.
export async function getSitesByProject(projectId) {
  const { data, error } = await db
    .from('sites')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'active')
    .order('name')
  if (error) throw error
  return data || []
}

// Create a site under a project. type is 'wireless' or 'fiber'. Address +
// notes optional. Status defaults to 'active' at the DB layer.
export async function addSite({ projectId, name, type, address, notes }) {
  const { data, error } = await db
    .from('sites')
    .insert({
      project_id: projectId,
      name,
      type,
      address: address || null,
      notes: notes || null,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

// Update site attrs. patch is { name?, type?, address?, notes?, project_id? }.
// Empty strings get coerced to NULL on the optional fields so the DB doesn't
// store cosmetic blanks.
export async function updateSite(siteId, patch) {
  const clean = { ...patch }
  if ('address' in clean) clean.address = clean.address?.trim() || null
  if ('notes' in clean)   clean.notes   = clean.notes?.trim() || null
  const { data, error } = await db
    .from('sites')
    .update(clean)
    .eq('id', siteId)
    .select()
    .single()
  if (error) throw error
  return data
}

// Atomic decommission + optional materials recovery.
//
// Soft-delete via status='decommissioned'. Sites are FK targets for
// tasks.site_id, so a hard delete would break historical records.
// getInfraTree() + getSitesByProject() both filter status='active', so a
// decommissioned site falls out of the UI immediately while its tasks
// (and their submissions / movements) remain linked for the audit trail.
//
// recoveryItems is an array of { partId, quantity, unit } — empty means
// "decommission only, no transfers." destinationLocationId is required
// when recoveryItems has rows.
//
// The RPC writes one transfer movement per item (project bucket →
// destination) before flipping site.status. All in one tx so a mid-batch
// failure rolls back cleanly.
export async function decommissionSiteWithRecovery(siteId, recoveryItems, destinationLocationId) {
  const items = (recoveryItems || []).map(i => ({
    part_id: i.partId,
    quantity: i.quantity,
    unit: i.unit || 'ea',
  }))
  const { data, error } = await db.rpc('decommission_site_with_recovery', {
    p_site_id: siteId,
    p_recovery_items: items,
    p_destination_location_id: destinationLocationId || null,
  })
  if (error) throw error
  return data
}

// All tasks anchored to a specific site. Read-only view for the manager —
// the infra crew workflow already shows tasks under sites, this just lets
// the manager see them from ProjectManager without logging in as infra.
export async function getTasksBySite(siteId) {
  const { data, error } = await db
    .from('tasks')
    .select('*, creator:users!tasks_created_by_fkey(name, initials)')
    .eq('site_id', siteId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Aggregated parts consumed at a site, derived from inventory_movements
// keyed on (task_id IN site's tasks). Returns a flat array of
// { partId, name, unit, qty, lastMovedAt }, sorted by qty desc.
//
// Powers the "View materials consumed" modal — supports the
// decommission-and-recover decision (manager sees what was installed
// before deciding what to physically pull and log as a PO).
//
// We sum movements regardless of from/to direction — the question is
// "what landed at this site," and right now auto-deduct transfers
// (truck → project bucket with task_id set) are the primary signal.
// If a recovery PO with the same task_id later writes a return, this
// summary will (correctly) show the net consumption.
export async function getMaterialsAtSite(siteId) {
  // Two-step to avoid relying on a deep PostgREST join: get the site's
  // task ids first, then aggregate movements against them.
  const { data: tasks, error: tErr } = await db
    .from('tasks').select('id').eq('site_id', siteId)
  if (tErr) throw tErr
  const taskIds = (tasks || []).map(t => t.id)
  if (taskIds.length === 0) return []

  const { data: moves, error: mErr } = await db
    .from('inventory_movements')
    .select('part_id, quantity, movement_type, created_at, parts_catalog ( id, name, unit )')
    .in('task_id', taskIds)
  if (mErr) throw mErr

  const totals = {}
  ;(moves || []).forEach(m => {
    const id = m.parts_catalog?.id || m.part_id
    if (!id) return
    if (!totals[id]) {
      totals[id] = {
        partId: id,
        name: m.parts_catalog?.name || id,
        unit: m.parts_catalog?.unit || 'ea',
        qty: 0,
        lastMovedAt: null,
      }
    }
    totals[id].qty += m.quantity || 0
    if (!totals[id].lastMovedAt || m.created_at > totals[id].lastMovedAt) {
      totals[id].lastMovedAt = m.created_at
    }
  })
  return Object.values(totals)
    .filter(p => p.qty !== 0)
    .sort((a, b) => b.qty - a.qty)
}

// Count active tasks per site for a project. Used by ProjectManager's Sites
// section to badge each site with its workload. Returns { [site_id]: count }.
export async function getTaskCountsBySite(projectId) {
  // Two-step: get the site ids for the project, then count tasks against
  // those ids. Avoids relying on a deep join PostgREST has to navigate.
  const { data: sites, error: sErr } = await db
    .from('sites')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'active')
  if (sErr) throw sErr
  const ids = (sites || []).map(s => s.id)
  if (ids.length === 0) return {}
  const { data: tasks, error: tErr } = await db
    .from('tasks')
    .select('site_id')
    .in('site_id', ids)
  if (tErr) throw tErr
  const counts = {}
  ;(tasks || []).forEach(t => {
    if (!t.site_id) return
    counts[t.site_id] = (counts[t.site_id] || 0) + 1
  })
  return counts
}

// Create an infra task anchored to a site. phase_id stays NULL — the
// tasks_anchor_present CHECK lets this through because site_id is set.
export async function addInfraTask(siteId, name, jobType, notes, userId) {
  const { data, error } = await db
    .from('tasks')
    .insert({
      site_id: siteId,
      phase_id: null,
      name,
      task_type: jobType,
      scope_notes: notes,
      status: 'open',
      created_by: userId || null,
    })
    .select('*, creator:users!tasks_created_by_fkey(id, name, initials)')
    .single()
  if (error) throw error
  return data
}

// ─── ASSEMBLIES & PARTS ───────────────────────────────────────────────────────
export async function getAssemblies() {
  const { data, error } = await db
    .from('assemblies')
    .select('*, assembly_parts(part_id, default_qty, unit, per_ft, sort_order, parts_catalog(id, name, unit))')
    .eq('is_active', true)
    .order('sort_order')
  if (error) throw error

  // Group by crew_type, return as { aerial: [], footage: [], splice: [], underground: [] }
  const grouped = { aerial: [], footage: [], splice: [], underground: [] }
  ;(data || []).forEach(a => {
    const tab = a.crew_type || 'aerial'
    if (!grouped[tab]) grouped[tab] = []
    grouped[tab].push({
      id: a.id,
      label: a.label,
      sub: a.sub_label || '',
      isFootage: a.is_footage || false,
      isFiber: a.is_fiber || false,
      isMst: a.is_mst || false,
      isSpliceCase: a.is_splice_case || false,
      isHandhole: a.is_handhole || false,
      isVault: a.is_vault || false,
      isConduit: a.is_conduit || false,
      parts: (a.assembly_parts || [])
        .sort((x, y) => (x.sort_order || 0) - (y.sort_order || 0))
        .map(ap => ({
          id: ap.part_id,
          qty: ap.default_qty,
          name: ap.parts_catalog?.name || ap.part_id,
          unit: ap.unit || ap.parts_catalog?.unit || 'ea',
          perFt: ap.per_ft || false,
        }))
    })
  })
  return grouped
}

export async function getAssembliesRaw() {
  const { data, error } = await db
    .from('assemblies')
    .select('*, assembly_parts(id, part_id, default_qty, unit, per_ft, sort_order, parts_catalog(id, name, unit))')
    .order('sort_order')
  if (error) throw error
  return data || []
}

// Save an assembly + its parts atomically. Backed by the
// public.replace_assembly RPC, which upserts the assembly and replaces
// its parts in one transaction. Previously this was three separate
// statements from the client; if the parts insert errored after the
// delete, the assembly was left empty.
export async function saveAssembly(asm) {
  const { data, error } = await db.rpc('replace_assembly', {
    p_assembly: {
      id: asm.id,
      label: asm.label,
      sub_label: asm.sub,
      crew_type: asm.crew_type,
      is_footage: asm.isFootage || false,
      is_fiber: asm.isFiber || false,
      is_mst: asm.isMst || false,
      is_splice_case: asm.isSpliceCase || false,
      is_handhole: asm.isHandhole || false,
      is_vault: asm.isVault || false,
      is_conduit: asm.isConduit || false,
      is_active: asm.is_active !== false,
      sort_order: asm.sort_order || 0,
    },
    p_parts: (asm.parts || []).map((p, i) => ({
      part_id: p.id,
      default_qty: p.qty,
      unit: p.unit || 'ea',
      per_ft: p.perFt || false,
      sort_order: typeof p.sort_order === 'number' ? p.sort_order : i,
    })),
  })
  if (error) throw error
  return data
}

export async function deleteAssembly(id) {
  await db.from('assembly_parts').delete().eq('assembly_id', id)
  const { error } = await db.from('assemblies').delete().eq('id', id)
  if (error) throw error
}

export async function searchParts(query) {
  return searchPartsCatalog(query, {
    cols: 'id, name, nickname, unit, category, department, material_group',
    limit: 20,
  })
}

export async function getPartsByCategory(materialGroup) {
  const { data, error } = await db
    .from('parts_catalog')
    .select('id, name, unit, category, material_group')
    .eq('material_group', materialGroup)
    .order('name')
  if (error) throw error
  return data
}

// ─── USERS ────────────────────────────────────────────────────────────────────
export async function getUsers() {
  const { data, error } = await db
    .from('users')
    .select('id, name, initials, role, crew_type, is_contractor, is_active, language, email, manager_id, restricted_to_inventory, staff_scope')
    .eq('is_active', true)
    .order('name')
  if (error) throw error
  return data
}

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
// One session per (user, day, TASK). This is load-bearing for backlog #2:
// under the is_closed model a crew member legitimately works several open
// tasks in the same day, and submissions link to a task only through their
// session's task_id. If sessions were one-per-day (the old model) a second
// task's submit would (a) overwrite the shared session's task_id and (b)
// have handleSubmit's session-scoped cleanup delete the first task's
// pending submission. Per-task sessions keep each task's passdown isolated.
export async function startSession(userId, taskId) {
  const today = new Date().toISOString().split('T')[0]
  const { data, error } = await db
    .from('work_sessions')
    .upsert({ user_id: userId, task_id: taskId, session_date: today, status: 'started' },
      { onConflict: 'user_id,session_date,task_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getTodaySessions() {
  try {
    const { data, error } = await db.from('crew_activity_today').select('*')
    if (error) throw error
    return data || []
  } catch {
    return []
  }
}

// ─── ENTRIES ──────────────────────────────────────────────────────────────────
// Save a log entry + its parts atomically via the public.save_log_entry RPC.
// Previously the parts insert ran after the parent had already committed,
// so a failure there left an orphan log_entries row with no parts and no
// signal to the user.
export async function saveEntry(sessionId, userId, taskId, entry) {
  const partRows = (entry.parts || [])
    .filter(p => p.id && p.qty > 0)
    .map(p => ({
      part_id: p.id,
      quantity: p.qty,
      is_extra: p.isExtra || false,
    }))

  const { data, error } = await db.rpc('save_log_entry', {
    p_session_id: sessionId,
    p_user_id: userId,
    p_task_id: taskId,
    p_entry_type: entry.type,
    p_assembly_id: entry.assemblyKey || null,
    p_assembly_qty: entry.qty || 1,
    p_footage_amt: entry.footage || null,
    p_note_text: entry.notes || null,
    p_parts: partRows,
  })
  if (error) throw error
  return data
}

// ─── SUBMISSIONS ──────────────────────────────────────────────────────────────
export async function getPendingSubmissions() {
  const { data, error } = await db
    .from('submissions')
    .select(`*, users!submissions_user_id_fkey(name, initials, crew_type)`)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

// Approve a submission: increments phase actuals, marks the submission
// approved, and flips the task to approved — atomically, in one transaction.
//
// Backed by the public.approve_submission RPC. Idempotency is enforced at
// the DB layer via submissions.actuals_applied_at, so a double-click or a
// retry can't double-count phase totals. The caller's identity is taken
// from the JWT (auth.uid()) inside the RPC, so we don't pass managerId.
export async function approveSubmission(id, note) {
  const { error } = await db.rpc('approve_submission', {
    p_submission_id: id,
    p_note: note || null,
  })
  if (error) throw error
}

// Crew-side read-only inspection of a submitted task: latest submission +
// its parts + status. Used by TaskSummaryView so the crew can tap a
// pending / approved / done task in their sidebar and see what was
// submitted without entering the editable TaskWorkspace.
//
// Returns null if no submission exists (a task can be marked 'done' or
// 'approved' without ever having had a submission in weird edge cases).
//
// We look up by task_id rather than session_id — a session can span
// multiple tasks, and we want the latest submission whose work_sessions
// row points at THIS task.
export async function getTaskSummary(taskId) {
  // Latest submission for the task. We sort by created_at DESC; on
  // re-submit (manager flagged → crew fixed → resubmitted) handleSubmit
  // deletes prior pending/flagged rows, so usually there's just one
  // current row plus historical approved ones.
  const { data: subs, error: sErr } = await db
    .from('submissions')
    .select(`
      id, status, created_at, reviewed_at, hours_worked,
      flag_reason, manager_notes, session_id, user_id,
      total_strand_ft, total_fiber_ft, total_conduit_ft,
      total_mst_hst, total_splice_cases, total_handholes,
      total_vaults, total_poles,
      users!submissions_user_id_fkey ( name, initials ),
      reviewer:users!submissions_reviewed_by_fkey ( name, initials ),
      work_sessions!submissions_session_id_fkey ( task_id )
    `)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(20)
  if (sErr) throw sErr

  // Filter client-side — PostgREST can't filter on a joined column directly
  // without a !inner. We want all submissions whose session points at our
  // task. Keep the first (most recent) match.
  const match = (subs || []).find(s => s.work_sessions?.task_id === taskId)
  if (!match) return null

  // Aggregate parts for the submission's session, scoped to this task.
  // (One session can have entries for multiple tasks; le.task_id keeps
  // them straight.)
  const { data: entries, error: eErr } = await db
    .from('log_entries')
    .select('id, task_id, footage_amt, note_text, entry_type')
    .eq('session_id', match.session_id)
  if (eErr) throw eErr

  const taskEntries = (entries || []).filter(e => !e.task_id || e.task_id === taskId)
  if (taskEntries.length === 0) {
    return { submission: match, parts: [], notes: [] }
  }

  const { data: parts, error: pErr } = await db
    .from('entry_parts')
    .select('quantity, part_id, parts_catalog ( id, name, unit )')
    .in('entry_id', taskEntries.map(e => e.id))
  if (pErr) throw pErr

  const totals = {}
  ;(parts || []).forEach(p => {
    const id = p.parts_catalog?.id || p.part_id
    if (!id) return
    if (!totals[id]) {
      totals[id] = {
        partId: id,
        name: p.parts_catalog?.name || id,
        unit: p.parts_catalog?.unit || 'ea',
        qty: 0,
      }
    }
    totals[id].qty += p.quantity || 0
  })
  const aggregatedParts = Object.values(totals)
    .filter(p => p.qty > 0)
    .sort((a, b) => b.qty - a.qty)

  const notes = taskEntries
    .map(e => e.note_text)
    .filter(Boolean)

  return { submission: match, parts: aggregatedParts, notes }
}

// ─── REALTIME ─────────────────────────────────────────────────────────────────
// Channel-name uniqueness: Date.now() alone is not enough. AppContext and
// InfraCrewApp both call subscribeToAllTaskChanges from useEffects keyed on
// `currentUser?.id`, which fire in the same tick after login — same Date.now()
// value, same channel name. supabase-realtime then refuses the second .on()
// call ("cannot add postgres_changes callbacks after subscribe()") and the
// error bubbles up to React, blanking the page. The counter guarantees a
// unique suffix per call regardless of clock resolution.
let _realtimeChannelCounter = 0
// Exported so realtime subscribers in components (SubmissionsQueue, CrewStatus,
// etc.) can build unique channel names without each reinventing the wheel.
// Don't reuse a channel name across simultaneous .channel() calls — supabase
// realtime throws "cannot add postgres_changes callbacks after subscribe()"
// when two subscribers collide on the same name.
export function nextChannelSuffix() {
  _realtimeChannelCounter += 1
  return `${Date.now()}_${_realtimeChannelCounter}`
}

// subscribeToTasks listens for INSERT and/or UPDATE events on tasks scoped to a
// single phase_id. Accepts either a single function (legacy: handles INSERT only)
// or { onInsert, onUpdate } to subscribe to both. Auto-reconnects if the channel
// drops (network blip, token refresh, etc.).
//
// Returns an object with .unsubscribe() that cleans up the channel and any
// pending reconnect timers.
// subscribeToAllTaskChanges listens for INSERT, UPDATE, and DELETE events on
// the entire `tasks` table (no phase filter). Used by AppContext so the global
// project tree stays current regardless of which screen the user is on —
// without this, status changes (e.g. a manager flagging a submission, which
// reverts the task to 'open') only propagate while a per-phase TaskList is
// mounted. Mirrors subscribeToTasks's auto-reconnect + unique-channel-name
// pattern.
//
// handlers: { onInsert?, onUpdate?, onDelete? }
// Returns { unsubscribe() }.
export function subscribeToAllTaskChanges({ onInsert, onUpdate, onDelete } = {}) {
  let channel = null
  let reconnectTimer = null
  let cancelled = false
  const tag = '[Tasks/all]'

  const setup = () => {
    if (cancelled) return
    if (channel) { try { channel.unsubscribe() } catch {} }

    let ch = db.channel('tasks_all_' + nextChannelSuffix())

    if (onInsert) {
      ch = ch.on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tasks' },
        payload => {
          console.log(tag, 'INSERT', payload.new?.id)
          onInsert(payload.new)
        })
    }
    if (onUpdate) {
      ch = ch.on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tasks' },
        payload => {
          console.log(tag, 'UPDATE', payload.new?.id, 'status:', payload.new?.status)
          onUpdate(payload.new, payload.old)
        })
    }
    if (onDelete) {
      ch = ch.on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'tasks' },
        payload => {
          console.log(tag, 'DELETE', payload.old?.id)
          onDelete(payload.old)
        })
    }

    ch.subscribe(status => {
      console.log(tag, 'channel status:', status)
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(setup, 2000)
      }
    })
    channel = ch
  }

  setup()
  return {
    unsubscribe: () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (channel) { try { channel.unsubscribe() } catch {} }
    }
  }
}

export function subscribeToTasks(phaseId, handlers) {
  const onInsert = typeof handlers === 'function' ? handlers : handlers?.onInsert
  const onUpdate = typeof handlers === 'function' ? null : handlers?.onUpdate

  let channel = null
  let reconnectTimer = null
  let cancelled = false
  const tag = '[Tasks/' + String(phaseId).slice(0, 8) + ']'

  const setup = () => {
    if (cancelled) return
    if (channel) {
      try { channel.unsubscribe() } catch {}
    }

    // Unique channel name on each (re)connect so we don't collide with a stale
    // channel object that's still being torn down.
    let ch = db.channel('tasks_' + phaseId + '_' + nextChannelSuffix())

    if (onInsert) {
      ch = ch.on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tasks', filter: `phase_id=eq.${phaseId}` },
        payload => {
          console.log(tag, 'INSERT', payload.new?.id, payload.new?.name)
          onInsert(payload.new)
        }
      )
    }

    if (onUpdate) {
      ch = ch.on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tasks', filter: `phase_id=eq.${phaseId}` },
        payload => {
          console.log(tag, 'UPDATE', payload.new?.id, 'status:', payload.new?.status)
          onUpdate(payload.new, payload.old)
        }
      )
    }

    ch.subscribe(status => {
      console.log(tag, 'channel status:', status)
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(setup, 2000)
      }
    })

    channel = ch
  }

  setup()

  return {
    unsubscribe: () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (channel) {
        try { channel.unsubscribe() } catch {}
      }
    }
  }
}

