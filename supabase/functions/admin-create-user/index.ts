// Edge Function: admin-create-user
//
// Lets owners/managers create new FiberLog users. Creates an auth.users
// row (requires service_role) plus a matching public.users row.
// Rolls back the auth user if the profile insert fails so we never end
// up with an orphan auth row that can't be fixed via the UI.
//
// Deploy with:
//   npx supabase functions deploy admin-create-user
//
// Permission rules:
//   - Caller must be owner or manager
//   - Only owners can create new owner accounts (managers can't promote
//     people to owner)
//
// Body shape:
//   {
//     name: "Francisco Molina",
//     username: "francisco.molina",   // domain auto-appended if missing "@"
//     role: "crew" | "manager" | "owner" | "contractor",
//     crew_type: "aerial" | ... | null,
//     password: "...",
//     initials?: "FM",                // auto-generated from name if omitted
//     language?: "en" | "es",
//     is_active?: boolean             // defaults to true
//   }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const EMAIL_DOMAIN = '@fiberlog.utahbroadband.com'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // ── 1. Verify caller's auth session ────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: caller }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !caller) return json({ error: 'Unauthorized' }, 401)

    // ── 2. Check caller is owner/manager ───────────────────────────────────
    const { data: callerProfile, error: profileErr } = await userClient
      .from('users')
      .select('role')
      .eq('id', caller.id)
      .single()

    if (profileErr || !callerProfile) {
      return json({ error: 'Profile not found' }, 403)
    }
    if (callerProfile.role !== 'owner' && callerProfile.role !== 'manager') {
      return json({ error: 'Forbidden — admin only' }, 403)
    }

    // ── 3. Validate body ───────────────────────────────────────────────────
    const body = await req.json().catch(() => null)
    if (!body) return json({ error: 'Invalid JSON body' }, 400)

    const name = String(body.name || '').trim()
    const usernameRaw = String(body.username || '').trim().toLowerCase()
    const role = String(body.role || '').trim()
    const password = String(body.password || '')
    const crew_type = body.crew_type ? String(body.crew_type).trim() : null
    const language = body.language ? String(body.language).trim() : 'en'
    const is_active = body.is_active !== false
    const initials = body.initials
      ? String(body.initials).trim().toUpperCase().slice(0, 4)
      : generateInitials(name)

    if (!name) return json({ error: 'name required' }, 400)
    if (!usernameRaw) return json({ error: 'username required' }, 400)
    if (!password || password.length < 6) {
      return json({ error: 'Password must be at least 6 characters' }, 400)
    }
    if (!['owner', 'manager', 'crew', 'contractor'].includes(role)) {
      return json({ error: 'Invalid role' }, 400)
    }

    // Only owners can create owners
    if (role === 'owner' && callerProfile.role !== 'owner') {
      return json({ error: 'Only owners can create owner accounts' }, 403)
    }

    // ── 4. Build the email ─────────────────────────────────────────────────
    const email = usernameRaw.includes('@')
      ? usernameRaw
      : usernameRaw + EMAIL_DOMAIN

    const localPart = email.split('@')[0]
    if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(localPart)) {
      return json({
        error: 'Username must be lowercase letters, numbers, dots, hyphens, or underscores',
      }, 400)
    }

    // ── 5. Check email isn't already taken ─────────────────────────────────
    const { data: existing } = await userClient
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle()
    if (existing) {
      return json({ error: 'A user with that username already exists' }, 409)
    }

    // ── 6. Create auth user (needs service_role) ───────────────────────────
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    const { data: authData, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })

    if (createErr || !authData?.user) {
      return json({ error: 'Auth creation failed: ' + (createErr?.message || 'unknown') }, 500)
    }

    const newUserId = authData.user.id

    // ── 7. Insert profile row with matching id ─────────────────────────────
    const { error: insertErr } = await admin
      .from('users')
      .insert({
        id: newUserId,
        email,
        name,
        initials,
        role,
        crew_type,
        language,
        is_active,
      })

    if (insertErr) {
      // Roll back the auth user since the profile insert failed
      await admin.auth.admin.deleteUser(newUserId).catch(() => {})
      return json({
        error: 'Profile creation failed: ' + insertErr.message,
      }, 500)
    }

    return json({
      ok: true,
      user_id: newUserId,
      email,
    })

  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function generateInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(p => p[0]?.toUpperCase() || '')
    .slice(0, 3)
    .join('')
}
