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
  for (const key of ['name', 'initials', 'role', 'crew_type', 'language', 'is_active']) {
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
