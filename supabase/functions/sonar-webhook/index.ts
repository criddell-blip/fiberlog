// Edge Function: sonar-webhook
//
// Receives Sonar's scheduled "Schedule Delivery" webhook (Destination =
// Webhook, Format = CSV zip file). Sonar offers no native signing — auth
// is a long random key passed in the query string, compared against the
// SONAR_WEBHOOK_KEY env var (set in Supabase dashboard → Functions →
// Secrets). Rotate by updating that secret + the URL in Sonar.
//
// On a valid POST:
//   1. Reject if ?key query param doesn't match SONAR_WEBHOOK_KEY
//      (constant-time compare so timing doesn't leak the secret)
//   2. Read the request body as bytes
//   3. Unzip; take the first .csv entry
//   4. Decode as UTF-8 text, count data rows (header + content)
//   5. Insert into sonar_pending_imports (status='pending')
//   6. Return 200 with the row id
//
// Insertion uses service_role to bypass RLS (the table doesn't grant
// INSERT to authenticated). Errors are logged to console + returned as
// 4xx/5xx so Sonar's retry behavior surfaces real failures, not
// silently-dropped deliveries.
//
// Deploy with:
//   npx supabase functions deploy sonar-webhook --no-verify-jwt
//
// IMPORTANT: --no-verify-jwt is required because Sonar can't send a
// Supabase JWT. The query-string key is the auth boundary.
//
// Required env vars:
//   - SUPABASE_URL                 (auto-set by Supabase)
//   - SUPABASE_SERVICE_ROLE_KEY    (auto-set by Supabase)
//   - SONAR_WEBHOOK_KEY            (manually set — see deploy notes)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  BlobReader,
  ZipReader,
  TextWriter,
} from 'https://deno.land/x/zipjs@v2.7.45/index.js'

Deno.serve(async (req) => {
  // Sonar will only POST. Reject anything else to keep accidental browser
  // hits from filling the table.
  if (req.method !== 'POST') {
    return text('Method Not Allowed', 405)
  }

  try {
    // 1. Verify the URL key
    const url = new URL(req.url)
    const providedKey = url.searchParams.get('key') || ''
    const expectedKey = Deno.env.get('SONAR_WEBHOOK_KEY') || ''
    if (!expectedKey) {
      console.error('SONAR_WEBHOOK_KEY env var not set')
      return text('Server misconfigured', 500)
    }
    if (!constantTimeEqual(providedKey, expectedKey)) {
      console.warn('Sonar webhook: invalid key from', req.headers.get('x-forwarded-for') || 'unknown')
      return text('Unauthorized', 401)
    }

    // 2. Read body as bytes
    const bodyBuf = await req.arrayBuffer()
    if (bodyBuf.byteLength === 0) {
      return text('Empty body', 400)
    }
    const bodyBlob = new Blob([bodyBuf])

    // 3. Unzip + find CSV entry
    let csvText = ''
    let csvFilename: string | null = null
    let unzipError: string | null = null
    try {
      const reader = new ZipReader(new BlobReader(bodyBlob))
      const entries = await reader.getEntries()
      const csvEntry = entries.find(e =>
        !e.directory && e.filename.toLowerCase().endsWith('.csv')
      )
      if (!csvEntry) {
        unzipError = `Zip contained no CSV file. Entries: ${entries.map(e => e.filename).join(', ') || '(none)'}`
      } else {
        csvFilename = csvEntry.filename
        // @ts-ignore — getData is on the entry at runtime
        csvText = await csvEntry.getData(new TextWriter('utf-8'))
      }
      await reader.close()
    } catch (e) {
      unzipError = `Unzip failed: ${e instanceof Error ? e.message : String(e)}`
    }

    // 4. Count data rows (header + lines; subtract 1 for the header).
    //    Cheap newline count — the UI re-parses anyway for the real list.
    let parsedRowCount = 0
    if (csvText) {
      // Trim trailing newline so we don't over-count
      const trimmed = csvText.replace(/\r?\n$/, '')
      if (trimmed.length > 0) {
        const lineCount = (trimmed.match(/\r?\n/g) || []).length + 1
        parsedRowCount = Math.max(0, lineCount - 1)  // minus header
      }
    }

    // 5. Insert (always insert, even on unzip failure — we want a record
    //    of every delivery so the manager can see "Sonar sent something
    //    weird at 06:00" and triage)
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    const insertPayload: Record<string, unknown> = {
      source: 'webhook',
      filename: csvFilename,
      raw_csv: csvText || '',
      parsed_row_count: parsedRowCount,
      status: unzipError ? 'discarded' : 'pending',
      error_message: unzipError,
    }
    if (unzipError) {
      insertPayload.discarded_at = new Date().toISOString()
      insertPayload.discard_reason = 'Auto-discarded: unzip/parse error'
    }

    const { data, error: dbErr } = await admin
      .from('sonar_pending_imports')
      .insert(insertPayload)
      .select('id')
      .single()

    if (dbErr) {
      console.error('DB insert failed:', dbErr)
      return text(`DB insert failed: ${dbErr.message}`, 500)
    }

    if (unzipError) {
      console.warn('Sonar webhook: stored as discarded —', unzipError)
      return json({ ok: true, id: data.id, status: 'discarded', error: unzipError }, 200)
    }

    console.log(`Sonar webhook: stored pending import ${data.id} (${parsedRowCount} rows)`)
    return json({ ok: true, id: data.id, row_count: parsedRowCount }, 200)
  } catch (err) {
    console.error('Sonar webhook unexpected error:', err)
    return text(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
})

// Constant-time string compare. Returns false fast if lengths differ
// (so length itself isn't a side channel after the first comparison),
// then xors char codes for equal-length inputs.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })
}
