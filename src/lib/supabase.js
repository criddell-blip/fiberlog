import { createClient } from '@supabase/supabase-js'

// Read from Vite env vars (.env / .env.local). Hardcoded fallbacks are kept
// so a build still works if .env goes missing — the anon key is public
// (RLS is the access boundary), so embedding it in the bundle is intended.
// To point local dev at a different Supabase project, drop overrides into
// .env.local (gitignored).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
  || 'https://attduslwidxecmjifsnl.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
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
export async function searchPartsCatalog(query, { cols = 'id, name, unit', limit = 20 } = {}) {
  const q = String(query ?? '').trim()
  if (!q) return []
  const pattern = `%${q}%`

  const [byName, byId] = await Promise.all([
    db.from('parts_catalog').select(cols).ilike('name', pattern).order('name').limit(limit),
    db.from('parts_catalog').select(cols).ilike('id',   pattern).order('id').limit(limit),
  ])
  if (byName.error) throw byName.error
  if (byId.error)   throw byId.error

  const seen = new Set()
  const out = []
  for (const r of [...(byName.data || []), ...(byId.data || [])]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
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
    cols: 'id, name, unit, category, department, material_group',
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
    .select('id, name, initials, role, crew_type, is_contractor, is_active, language, email')
    .eq('is_active', true)
    .order('name')
  if (error) throw error
  return data
}

// ─── SESSIONS ─────────────────────────────────────────────────────────────────
export async function startSession(userId, taskId) {
  const today = new Date().toISOString().split('T')[0]
  const { data, error } = await db
    .from('work_sessions')
    .upsert({ user_id: userId, task_id: taskId, session_date: today, status: 'started' },
      { onConflict: 'user_id,session_date' })
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

// ─── REALTIME ─────────────────────────────────────────────────────────────────
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

    let ch = db.channel('tasks_all_' + Date.now())

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
    let ch = db.channel('tasks_' + phaseId + '_' + Date.now())

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

