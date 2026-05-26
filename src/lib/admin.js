// Admin operations on the users table. Most of these go through the
// authenticated client + RLS; the create operation has to go through an
// Edge Function because creating a row in auth.users requires
// service_role.

import { db } from './supabase'

const EMAIL_DOMAIN = '@fiberlog.utahbroadband.com'

// Build the synthetic email from a username. Mirrors the logic in the
// Login component and the Edge Function so previews match exactly.
export function buildEmailFromUsername(username) {
  const cleaned = String(username || '').trim().toLowerCase()
  if (!cleaned) return ''
  if (cleaned.includes('@')) return cleaned
  return cleaned + EMAIL_DOMAIN
}

// Auto-generate initials from a full name, e.g. "Francisco Molina" → "FM"
export function generateInitials(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0]?.toUpperCase() || '')
    .slice(0, 3)
    .join('')
}

// Create a new user. Goes through the admin-create-user Edge Function
// because creating a row in auth.users requires the service_role key
// which can't ship to the browser.
export async function createUser({
  name, username, role, crew_type, password,
  initials, language, is_active,
}) {
  const { data: { session } } = await db.auth.getSession()
  if (!session) throw new Error('Not signed in')

  const res = await fetch(
    `${db.supabaseUrl}/functions/v1/admin-create-user`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        name, username, role, crew_type, password,
        initials, language, is_active,
      }),
    }
  )
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`)
  return result
}

// Update user metadata (name, role, crew_type, language, is_active, initials).
// Email/username can't be changed once set — they're tied to the auth.users
// row. Password resets go through the existing admin-set-password function.
export async function updateUserMetadata(userId, updates) {
  const allowed = {}
  for (const key of ['name', 'initials', 'role', 'crew_type', 'language', 'is_active', 'manager_id']) {
    if (key in updates) allowed[key] = updates[key]
  }
  const { data, error } = await db
    .from('users')
    .update(allowed)
    .eq('id', userId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

// Convenience wrappers
export function deactivateUser(userId) {
  return updateUserMetadata(userId, { is_active: false })
}
export function reactivateUser(userId) {
  return updateUserMetadata(userId, { is_active: true })
}

// Reset a user's password. Reuses the existing admin-set-password function
// so we don't duplicate that logic.
export async function resetUserPassword(userId, newPassword) {
  const { data: { session } } = await db.auth.getSession()
  if (!session) throw new Error('Not signed in')
  const res = await fetch(
    `${db.supabaseUrl}/functions/v1/admin-set-password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ userId, newPassword }),
    }
  )
  const result = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`)
  return result
}

// Pull the latest list of users (including inactive) for the admin view.
// The default getUsers() in supabase.js may filter by is_active=true so
// we make our own that returns everyone.
export async function getAllUsers() {
  const { data, error } = await db
    .from('users')
    .select('*')
    .order('is_active', { ascending: false })   // active first
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

// ─── CREW OPERATION PERMISSIONS ──────────────────────────────────────────────

// All operations a manager can override per-user. Order matters for UI display.
export const CREW_OPERATIONS = ['load', 'return', 'issue', 'scrap', 'transfer']

// All crew_type values supported by the schema (matches users.crew_type CHECK
// and CREW_TYPE_OPTIONS in AdminUsersView). Used by the
// CrewTypePermissionsView matrix to render rows.
export const CREW_TYPES = [
  'aerial', 'underground', 'splice', 'drop',
  'locator', 'install', 'infrastructure', 'contractor',
]

// Fetch all permission rows for a single user. Empty array = default-allow
// for every operation. A row with allowed=false denies that operation.
export async function getUserPermissions(userId) {
  if (!userId) return []
  const { data, error } = await db
    .from('crew_operation_permissions')
    .select('*')
    .eq('user_id', userId)
  if (error) throw error
  return data || []
}

// Upsert a single per-user operation permission. Pass allowed=false to
// deny; pass allowed=true to document the explicit allowance (functionally
// equivalent to deleting the row but kept for audit trail). The
// updated_at column is bumped by a DB trigger so we don't need to set it.
//
// Don't chain .single() here — the supabase-js `.upsert(...).select().single()`
// combo can return "Cannot coerce the result to a single JSON object" in
// some on-conflict update paths even when exactly one row landed. Plain
// .select() + index 0 is more robust.
export async function setUserOperationPermission(userId, operation, allowed, reason = null) {
  if (!userId || !operation) throw new Error('userId and operation required')
  const { data, error } = await db
    .from('crew_operation_permissions')
    .upsert(
      { user_id: userId, operation, allowed, reason: reason || null },
      { onConflict: 'user_id,operation' }
    )
    .select()
  if (error) throw error
  return Array.isArray(data) && data.length > 0 ? data[0] : null
}

// Remove the explicit row for (user, operation) — reverts to default-allow.
export async function clearUserOperationPermission(userId, operation) {
  if (!userId || !operation) throw new Error('userId and operation required')
  const { error } = await db
    .from('crew_operation_permissions')
    .delete()
    .eq('user_id', userId)
    .eq('operation', operation)
  if (error) throw error
}

// ─── CREW TYPE × DEPARTMENT WHITELIST ────────────────────────────────────────

// Fetch every allow row. Each row = (crew_type, department) the crew_type
// is allowed to move. A crew_type with zero rows = no restriction (allow
// all). Parts with department=NULL pass regardless (per Phase 3 spec).
export async function getCrewTypePartRestrictions() {
  const { data, error } = await db
    .from('crew_type_part_restrictions')
    .select('crew_type, department')
  if (error) throw error
  return data || []
}

// Allow `crew_type` to move parts from `department`. INSERT, idempotent
// via ON CONFLICT DO NOTHING semantics (we use upsert with ignoreDuplicates).
export async function addCrewTypePartRestriction(crewType, department) {
  if (!crewType || !department) throw new Error('crewType and department required')
  const { error } = await db
    .from('crew_type_part_restrictions')
    .upsert({ crew_type: crewType, department }, {
      onConflict: 'crew_type,department',
      ignoreDuplicates: true,
    })
  if (error) throw error
}

// Revoke the allowance.
export async function removeCrewTypePartRestriction(crewType, department) {
  if (!crewType || !department) throw new Error('crewType and department required')
  const { error } = await db
    .from('crew_type_part_restrictions')
    .delete()
    .eq('crew_type', crewType)
    .eq('department', department)
  if (error) throw error
}

// Distinct, non-null department names from the active parts catalog.
// Used by CrewTypePermissionsView to render columns. Sorted by part count
// descending so the most-used departments lead.
export async function getActivePartDepartments() {
  const { data, error } = await db
    .from('parts_catalog')
    .select('department')
    .eq('is_active', true)
    .not('department', 'is', null)
  if (error) throw error
  // Tally + sort client-side. parts_catalog isn't huge (~600 rows).
  const counts = new Map()
  for (const row of data || []) {
    const d = (row.department || '').trim()
    if (!d) continue
    counts.set(d, (counts.get(d) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([department, count]) => ({ department, count }))
}
