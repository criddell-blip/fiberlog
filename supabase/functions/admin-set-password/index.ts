// Edge Function: admin-set-password
//
// Lets owners/managers reset another user's password.
// The service_role key never leaves the server.
//
// Deploy with:
//   npx supabase functions deploy admin-set-password
//
// Required env vars (set in Supabase dashboard → Functions → Secrets):
//   - SUPABASE_URL                 (auto-set by Supabase)
//   - SUPABASE_ANON_KEY            (auto-set by Supabase)
//   - SUPABASE_SERVICE_ROLE_KEY    (auto-set by Supabase)

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
    const newPassword = body?.newPassword

    if (!userId || typeof userId !== 'string') {
      return json({ error: 'userId required' }, 400)
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return json({ error: 'Password must be at least 6 characters' }, 400)
    }

    // 4. Use service_role to update the password
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
      password: newPassword,
    })

    if (updateErr) {
      return json({ error: updateErr.message }, 500)
    }

    return json({ ok: true })
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
