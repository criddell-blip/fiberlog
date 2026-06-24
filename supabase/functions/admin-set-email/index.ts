// Edge Function: admin-set-email
//
// Lets owners/managers change another user's login email (the Supabase Auth
// identity) AND mirror it into public.users so the login picker + resilient
// matching stay in sync. Used to migrate accounts off the old synthetic
// `*.fiberlog.utahbroadband.com` addresses onto real company mailboxes so
// password reset emails actually deliver.
//
// The service_role key never leaves the server.
//
// Deploy with:
//   npx supabase functions deploy admin-set-email
//
// Required env vars (auto-set by Supabase):
//   - SUPABASE_URL
//   - SUPABASE_ANON_KEY
//   - SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Verify caller has a valid Supabase session
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: caller }, error: authErr } = await userClient.auth.getUser()
    if (authErr || !caller) {
      return json({ error: 'Unauthorized' }, 401)
    }

    // 2. Verify caller is owner or manager in public.users
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

    // 3. Validate request body
    const body = await req.json().catch(() => null)
    const userId = body?.userId
    const newEmail = String(body?.newEmail || '').trim().toLowerCase()

    if (!userId || typeof userId !== 'string') {
      return json({ error: 'userId required' }, 400)
    }
    // Basic shape check — we don't over-validate the domain because the
    // caller is a trusted admin and contractors may sit on other domains.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) {
      return json({ error: 'A valid email address is required' }, 400)
    }

    // 4. Reject if another user already has that email
    const { data: clash } = await userClient
      .from('users')
      .select('id')
      .eq('email', newEmail)
      .neq('id', userId)
      .maybeSingle()
    if (clash) {
      return json({ error: 'That email is already in use by another user' }, 409)
    }

    // 5. Use service_role to update the auth identity + profile mirror
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    // email_confirm:true so the new address is immediately usable without a
    // confirmation round-trip (these are trusted, admin-set addresses).
    const { error: authUpdateErr } = await admin.auth.admin.updateUserById(userId, {
      email: newEmail,
      email_confirm: true,
    })
    if (authUpdateErr) {
      return json({ error: authUpdateErr.message }, 500)
    }

    // Mirror into public.users — the login picker + Login.jsx matching read
    // this, not auth.users. If this fails the two are briefly out of sync;
    // surface it so the admin can retry rather than silently swallow.
    const { error: mirrorErr } = await admin
      .from('users')
      .update({ email: newEmail })
      .eq('id', userId)
    if (mirrorErr) {
      return json({ error: 'Auth email changed but profile mirror failed: ' + mirrorErr.message }, 500)
    }

    return json({ ok: true, email: newEmail })
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
