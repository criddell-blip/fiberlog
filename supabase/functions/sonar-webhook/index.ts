// Edge Function: sonar-webhook
//
// Receives Sonar's scheduled "Schedule Delivery" webhook. Sonar's UI
// labels Format=CSV-zip, but the actual delivery shape varies (some
// tenants get raw zip body, others get multipart/form-data with the
// zip as a file part, others get a JSON wrapper with a download URL).
// The function tries each shape in turn and, if none match, stores
// diagnostic info in notes so we can see what Sonar actually sent.
//
// Auth is a URL secret (?key=...) compared constant-time against the
// SONAR_WEBHOOK_KEY env var. Sonar offers no native HMAC/signing.
//
// On a valid POST:
//   1. Reject if ?key doesn't match SONAR_WEBHOOK_KEY
//   2. Read body as bytes
//   3. Try format detection: zip → multipart → JSON → raw CSV
//   4. Insert into sonar_pending_imports (status=pending|discarded)
//   5. Return 200 with the row id (always 200 on row-stored, so Sonar
//      doesn't retry — diagnosis happens in the audit panel)
//
// Required env vars:
//   - SUPABASE_URL                 (auto-set)
//   - SUPABASE_SERVICE_ROLE_KEY    (auto-set)
//   - SONAR_WEBHOOK_KEY            (set manually before going live)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  BlobReader,
  ZipReader,
  TextWriter,
} from 'https://deno.land/x/zipjs@v2.7.45/index.js'

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return text('Method Not Allowed', 405)
  }

  try {
    // 1. Verify URL key
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

    // 2. Capture headers + read body
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => { headers[k] = v })
    const contentType = (req.headers.get('content-type') || '').toLowerCase()

    const bodyBuf = await req.arrayBuffer()
    if (bodyBuf.byteLength === 0) {
      return text('Empty body', 400)
    }
    const bodyBytes = new Uint8Array(bodyBuf)

    // 3. Detect format + extract CSV
    const detection = await detectAndExtract(bodyBytes, contentType, req)

    // 4. Build insert payload
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    )

    const parsedRowCount = detection.csvText ? countDataRows(detection.csvText) : 0
    const ok = !detection.error && parsedRowCount >= 0 && detection.csvText.length > 0

    // Diagnostic note — included on every delivery, especially helpful
    // for format mismatches. Captures the first 256 bytes as hex so the
    // raw shape is visible without exposing the secret.
    const diag = {
      detected_format: detection.format,
      content_type: contentType || null,
      content_length: bodyBuf.byteLength,
      header_keys: Object.keys(headers),
      body_head_hex: bytesToHex(bodyBytes.slice(0, 64)),
      body_head_ascii: bytesToPrintable(bodyBytes.slice(0, 128)),
    }

    const insertPayload: Record<string, unknown> = {
      source: 'webhook',
      filename: detection.filename,
      raw_csv: detection.csvText || '',
      parsed_row_count: parsedRowCount,
      status: ok ? 'pending' : 'discarded',
      error_message: detection.error,
      notes: JSON.stringify(diag),
    }
    if (!ok) {
      insertPayload.discarded_at = new Date().toISOString()
      insertPayload.discard_reason = 'Auto-discarded: ' + (detection.error || 'format not recognized')
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

    if (!ok) {
      console.warn(`Sonar webhook: stored as discarded — ${detection.error}`)
      return json({ ok: true, id: data.id, status: 'discarded', error: detection.error, detected_format: detection.format }, 200)
    }

    console.log(`Sonar webhook: stored pending import ${data.id} (${parsedRowCount} rows, format=${detection.format})`)
    return json({ ok: true, id: data.id, row_count: parsedRowCount, format: detection.format }, 200)
  } catch (err) {
    console.error('Sonar webhook unexpected error:', err)
    return text(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, 500)
  }
})

// ─── Format detection ──────────────────────────────────────────────────
// Sonar's "Format=CSV zip file" is what the UI shows; the wire shape
// depends on their tenant. We try every reasonable shape.

type Detection = {
  format: string
  csvText: string
  filename: string | null
  error: string | null
}

async function detectAndExtract(
  bodyBytes: Uint8Array,
  contentType: string,
  req: Request,
): Promise<Detection> {
  // 3a. PKZIP magic? (PK\x03\x04 = local file header, PK\x05\x06 = empty)
  if (bodyBytes.length >= 4 && bodyBytes[0] === 0x50 && bodyBytes[1] === 0x4b) {
    return await extractZip(bodyBytes, 'zip')
  }

  // 3b. multipart/form-data? The zip might be one of the parts.
  if (contentType.startsWith('multipart/form-data')) {
    try {
      // Re-construct a Request so .formData() can parse properly.
      // (We've already consumed the body; rebuild from bytes.)
      const fakeReq = new Request('https://x/x', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: bodyBytes,
      })
      const form = await fakeReq.formData()
      for (const [, value] of form.entries()) {
        if (value instanceof File) {
          const ab = await value.arrayBuffer()
          const partBytes = new Uint8Array(ab)
          // Is the part itself a zip?
          if (partBytes.length >= 4 && partBytes[0] === 0x50 && partBytes[1] === 0x4b) {
            const z = await extractZip(partBytes, 'multipart→zip')
            if (z.csvText) return { ...z, filename: value.name || z.filename }
            return z
          }
          // Or is it the CSV directly?
          if (value.name?.toLowerCase().endsWith('.csv')) {
            return {
              format: 'multipart→csv',
              csvText: new TextDecoder('utf-8').decode(partBytes),
              filename: value.name,
              error: null,
            }
          }
        }
      }
      return { format: 'multipart', csvText: '', filename: null, error: 'multipart had no file parts we recognize' }
    } catch (e) {
      return {
        format: 'multipart',
        csvText: '',
        filename: null,
        error: `multipart parse failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  // 3c. JSON wrapper? Sonar's Webhook destination is Looker-powered —
  // the payload follows Looker's "ScheduledPlan" webhook shape:
  //   { type, scheduled_plan, attachment: { mimetype, extension, data }, ... }
  // where attachment.data is base64-encoded (zip or csv, depending on
  // the Schedule's Format setting).
  if (contentType.includes('application/json') || (bodyBytes.length > 0 && bodyBytes[0] === 0x7b /* { */)) {
    try {
      const text = new TextDecoder('utf-8').decode(bodyBytes)
      const obj = JSON.parse(text)

      // Looker attachment is an object — drill into .data for the base64
      let fileB64: string | null = null
      let extHint: string | null = null
      let mimeHint: string | null = null
      if (obj.attachment && typeof obj.attachment === 'object') {
        fileB64 = obj.attachment.data || null
        extHint = obj.attachment.extension || null
        mimeHint = obj.attachment.mimetype || null
      }
      // Fallbacks: some webhook providers put the base64 at top level
      if (!fileB64 && typeof obj.file === 'string') fileB64 = obj.file
      if (!fileB64 && typeof obj.attachment === 'string') fileB64 = obj.attachment
      if (!fileB64 && typeof obj.data === 'string') fileB64 = obj.data
      if (!fileB64 && typeof obj.content === 'string') fileB64 = obj.content
      if (!fileB64 && typeof obj.body === 'string') fileB64 = obj.body

      if (typeof fileB64 === 'string' && fileB64.length > 0) {
        const decoded = base64ToBytes(fileB64)
        // Zip extension OR PKZIP magic bytes
        if (extHint === 'zip' || (decoded.length >= 4 && decoded[0] === 0x50 && decoded[1] === 0x4b)) {
          const z = await extractZip(decoded, 'looker→json→zip')
          return z
        }
        // Looker delivered CSV directly (Format=CSV instead of CSV zip)
        if (extHint === 'csv' || mimeHint?.startsWith('text/csv')) {
          return {
            format: 'looker→json→csv',
            csvText: new TextDecoder('utf-8').decode(decoded),
            filename: obj.scheduled_plan?.title ? `${obj.scheduled_plan.title}.csv` : null,
            error: null,
          }
        }
        // Best-effort: try as CSV if it looks textual
        const csvCandidate = new TextDecoder('utf-8').decode(decoded)
        if (csvCandidate.includes(',') && csvCandidate.includes('\n')) {
          return { format: 'json→base64→csv', csvText: csvCandidate, filename: obj.filename || null, error: null }
        }
      }
      // Maybe a download URL we need to fetch
      const downloadUrl = obj.url || obj.download_url || obj.attachment_url || obj.href
      if (typeof downloadUrl === 'string' && downloadUrl.startsWith('https://')) {
        try {
          const resp = await fetch(downloadUrl)
          if (!resp.ok) {
            return { format: 'json→url', csvText: '', filename: null, error: `download failed: HTTP ${resp.status}` }
          }
          const ab = await resp.arrayBuffer()
          const fetchedBytes = new Uint8Array(ab)
          if (fetchedBytes.length >= 4 && fetchedBytes[0] === 0x50 && fetchedBytes[1] === 0x4b) {
            const z = await extractZip(fetchedBytes, 'json→url→zip')
            return z
          }
          return {
            format: 'json→url→csv',
            csvText: new TextDecoder('utf-8').decode(fetchedBytes),
            filename: null, error: null,
          }
        } catch (e) {
          return { format: 'json→url', csvText: '', filename: null, error: `download error: ${e instanceof Error ? e.message : String(e)}` }
        }
      }
      return {
        format: 'json',
        csvText: '',
        filename: null,
        error: `JSON body but no recognized data field. Keys: ${Object.keys(obj).join(', ')}`,
      }
    } catch (e) {
      // fall through to raw-text attempt
    }
  }

  // 3d. Raw text — probably CSV?
  const txt = new TextDecoder('utf-8').decode(bodyBytes)
  if (txt.includes(',') && (txt.includes('\n') || txt.length > 20)) {
    return { format: 'raw-csv', csvText: txt, filename: null, error: null }
  }

  return {
    format: 'unknown',
    csvText: '',
    filename: null,
    error: `Unrecognized format. content-type=${contentType || '(none)'}, first-bytes-hex=${bytesToHex(bodyBytes.slice(0, 16))}`,
  }
}

async function extractZip(zipBytes: Uint8Array, formatLabel: string): Promise<Detection> {
  try {
    const blob = new Blob([zipBytes])
    const reader = new ZipReader(new BlobReader(blob))
    const entries = await reader.getEntries()
    const csvEntry = entries.find(e => !e.directory && e.filename.toLowerCase().endsWith('.csv'))
    if (!csvEntry) {
      await reader.close()
      return {
        format: formatLabel,
        csvText: '',
        filename: null,
        error: `Zip had no CSV. Entries: ${entries.map(e => e.filename).join(', ') || '(none)'}`,
      }
    }
    // @ts-ignore — getData exists at runtime
    const csvText: string = await csvEntry.getData(new TextWriter('utf-8'))
    await reader.close()
    return { format: formatLabel, csvText, filename: csvEntry.filename, error: null }
  } catch (e) {
    return {
      format: formatLabel,
      csvText: '',
      filename: null,
      error: `Unzip failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

// Count data rows (lines minus header) — cheap newline scan
function countDataRows(csvText: string): number {
  const trimmed = csvText.replace(/\r?\n$/, '')
  if (trimmed.length === 0) return 0
  const lineCount = (trimmed.match(/\r?\n/g) || []).length + 1
  return Math.max(0, lineCount - 1)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

function bytesToPrintable(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) {
    s += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.'
  }
  return s
}

function base64ToBytes(s: string): Uint8Array {
  // Tolerate URL-safe base64 + missing padding
  let normalized = s.replace(/-/g, '+').replace(/_/g, '/')
  while (normalized.length % 4 !== 0) normalized += '='
  try {
    const bin = atob(normalized)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function text(body: string, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })
}
