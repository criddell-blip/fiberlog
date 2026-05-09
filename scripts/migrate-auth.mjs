// scripts/migrate-auth.mjs
// One-time migration: create auth.users for existing FiberLog users,
// preserving their UUIDs so every FK in the database keeps working.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const EMAIL_DOMAIN = 'fiberlog.utahbroadband.com' // change if you want

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

function makeEmail(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '.')
    + '@' + EMAIL_DOMAIN
}

function tempPassword() {
  return 'TempPass-' + Math.random().toString(36).slice(2, 10)
}

async function main() {
  const { data: users, error } = await admin
    .from('users')
    .select('id, name, password, role, is_active')
    .eq('is_active', true)

  if (error) throw error
  console.log(`Found ${users.length} active users`)

  const tempPasswords = []

  for (const u of users) {
    const email = makeEmail(u.name)
    const passwordWasSet = !!u.password
    const password = u.password || tempPassword()

    console.log(`→ ${u.name.padEnd(20)} ${email}${passwordWasSet ? '' : '  (TEMP)'}`)

    const { error: createErr } = await admin.auth.admin.createUser({
      id: u.id,                  // preserve the UUID — this is the magic
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: u.name,
        fiberlog_role: u.role,
      },
    })

    if (createErr) {
      if (createErr.message?.toLowerCase().includes('already')) {
        console.log(`   already exists, skipping`)
      } else {
        console.error(`   FAILED: ${createErr.message}`)
        continue
      }
    }

    if (!passwordWasSet) {
      tempPasswords.push({ name: u.name, email, tempPassword: password })
    }

    // Store email on the users row so the login flow can look it up
    const { error: updateErr } = await admin
      .from('users')
      .update({ email })
      .eq('id', u.id)

    if (updateErr) console.error(`   email update failed: ${updateErr.message}`)
  }

  if (tempPasswords.length > 0) {
    console.log('\n=== TEMP PASSWORDS (communicate to crew, then they reset) ===')
    tempPasswords.forEach(t => console.log(`${t.name}: ${t.tempPassword}`))
  }

  console.log('\nDone.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})