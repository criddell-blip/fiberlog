import { useState, useEffect, useMemo } from 'react'
import { db } from './supabase'
import { parseCsv, readFileAsText } from './csvImport'
import {
  getPendingSonarImports, getProcessedSonarImports, getPendingSonarImport,
  markSonarPendingImportApplied, discardSonarPendingImport,
  fetchAllRows,
} from './inventory'

// Shared plumbing hooks for the CSV importer sheets. Extracted July 2026
// from 5 near-identical copies across SonarImportSheet / FiberJobsImportSheet
// (and friends). Presentational + state plumbing ONLY — the per-sheet
// resolvers and apply loops stay in their sheets (different failure
// contracts against append-only money data).

// ─── useCsvFile ─────────────────────────────────────────────────────────
// File pick → read → parse → required-column validation → rows state.
//
// Config:
//   requiredCols        — headers that must be present, else error + no rows
//   missingColsMessage  — (missing[]) => string, per-sheet error wording
//   onLoaded            — ({ headers, rows }) called on successful load so the
//                         sheet can reset its per-import picks (each sheet
//                         resets a different set — deliberately not owned here)
//   onFilePicked        — called when a real file lands (after the null-check,
//                         before parsing) — e.g. to clear a webhook pending-id
export function useCsvFile({ requiredCols = [], missingColsMessage, onLoaded, onFilePicked } = {}) {
  const [fileName, setFileName] = useState('')
  const [csvRows, setCsvRows] = useState(null)      // null = nothing loaded yet
  const [csvHeaders, setCsvHeaders] = useState([])
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)

  // Shared parse path — used by both manual upload and pending-import load.
  function loadCsvText(text) {
    const { headers, rows } = parseCsv(text)
    if (rows.length === 0) {
      setError('CSV had no data rows')
      setCsvRows([])
      return false
    }
    const missing = requiredCols.filter(c => !headers.includes(c))
    if (missing.length > 0) {
      setError(missingColsMessage
        ? missingColsMessage(missing)
        : `CSV missing required columns: ${missing.join(', ')}`)
      setCsvRows([])
      return false
    }
    setCsvHeaders(headers)
    setCsvRows(rows)
    onLoaded?.({ headers, rows })
    return true
  }

  async function handleFile(file) {
    if (!file) return
    onFilePicked?.(file)
    setError(''); setParsing(true)
    setFileName(file.name)
    try {
      const text = await readFileAsText(file)
      loadCsvText(text)
    } catch (e) {
      console.error('CSV parse failed:', e)
      setError(e.message || String(e))
      setCsvRows([])
    } finally {
      setParsing(false)
    }
  }

  // Drop the loaded CSV (post-apply / discard-of-active-pending).
  function clear() {
    setCsvRows(null)
    setCsvHeaders([])
    setFileName('')
  }

  return {
    fileName, setFileName,
    csvRows, setCsvRows,
    csvHeaders,
    error, setError,
    parsing, setParsing,
    handleFile, loadCsvText, clear,
  }
}

// ─── useSonarPendingQueue ───────────────────────────────────────────────
// The webhook pending/processed delivery queue (sonar_pending_imports),
// filtered to one reportType ('asset_consumption' | 'fiber_jobs').
// Pairs with PendingImportsPanel / ProcessedImportsPanel in
// components/manager/importShared.jsx.
//
//   csv           — the object returned by useCsvFile (loadCsvText etc.)
//   currentUserId — stamped on discard / mark-applied
//   showToast     — optional toast fn for the discard confirmation
//   discardPrompt — (pending) => string, per-sheet window.prompt wording
export function useSonarPendingQueue(reportType, { csv, currentUserId, showToast, discardPrompt } = {}) {
  const [pendingImports, setPendingImports] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  // When the loaded CSV came from a webhook delivery, remember its id so
  // apply can flip status='imported' and drop it out of the queue.
  const [activePendingId, setActivePendingId] = useState(null)

  // Processed (imported + discarded) — audit trail. Lazy-loaded on toggle
  // so we don't pay the query for managers who only care about pending.
  const [showProcessed, setShowProcessed] = useState(false)
  const [processedImports, setProcessedImports] = useState(null)  // null = not loaded yet
  const [processedLoading, setProcessedLoading] = useState(false)

  const refreshPending = async () => {
    try {
      const rows = await getPendingSonarImports({ includeProcessed: false, reportType })
      setPendingImports(rows)
    } catch (e) {
      console.warn(`Pending ${reportType} imports load failed:`, e)
    } finally {
      setPendingLoading(false)
    }
  }
  useEffect(() => { refreshPending() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleProcessed() {
    const next = !showProcessed
    setShowProcessed(next)
    if (next && processedImports === null) {
      setProcessedLoading(true)
      try {
        const rows = await getProcessedSonarImports({ limit: 30, reportType })
        setProcessedImports(rows)
      } catch (e) {
        console.warn(`Processed ${reportType} imports load failed:`, e)
        setProcessedImports([])
      } finally {
        setProcessedLoading(false)
      }
    }
  }

  // Load a pending webhook delivery into the CSV parse flow as if the
  // manager had just uploaded its file manually.
  async function loadPending(pending) {
    csv.setError(''); csv.setParsing(true)
    try {
      const full = await getPendingSonarImport(pending.id)
      setActivePendingId(pending.id)
      const label = full.filename || `pending ${new Date(full.received_at).toLocaleString()}`
      csv.setFileName(`[webhook] ${label}`)
      csv.loadCsvText(full.raw_csv || '')
    } catch (e) {
      console.error('Load pending import failed:', e)
      csv.setError(`Could not load pending import: ${e.message || e}`)
    } finally {
      csv.setParsing(false)
    }
  }

  async function discardPending(pending) {
    const reason = window.prompt(
      discardPrompt
        ? discardPrompt(pending)
        : `Discard this pending import (${pending.parsed_row_count} rows from ${new Date(pending.received_at).toLocaleString()})?`,
      'Test fire / duplicate / not needed'
    )
    if (reason === null) return  // cancelled
    try {
      await discardSonarPendingImport(pending.id, { reason: reason || 'Discarded', userId: currentUserId })
      // If we're currently editing this one, clear the working state.
      if (activePendingId === pending.id) {
        setActivePendingId(null)
        csv.clear()
      }
      await refreshPending()
      showToast?.('Pending import discarded')
    } catch (e) {
      console.error('Discard failed:', e)
      csv.setError(`Discard failed: ${e.message || e}`)
    }
  }

  // Flip the active delivery to imported after a successful apply.
  // Non-fatal if it fails (movements are already written) — just log so it
  // can be cleaned up manually.
  async function markApplied(movementCount) {
    if (!activePendingId) return
    try {
      await markSonarPendingImportApplied(activePendingId, { movementCount, userId: currentUserId })
    } catch (e) {
      console.warn('Mark pending imported failed (movements still applied):', e)
    }
  }

  return {
    pendingImports, pendingLoading,
    activePendingId,
    clearActive: () => setActivePendingId(null),
    refreshPending, loadPending, discardPending, markApplied,
    showProcessed, toggleProcessed, processedImports, processedLoading,
  }
}

// ─── useEffectiveMap ────────────────────────────────────────────────────
// The persisted-map + this-session-picks merge every mapping layer uses.
// `persisted` is a Map (from the DB), `pending` a plain object of session
// edits — a falsy pending value DELETES the key (an explicit "clear" pick
// beats the persisted row for this session).
export function useEffectiveMap(persisted, pending) {
  return useMemo(() => {
    const merged = new Map(persisted)
    for (const [k, v] of Object.entries(pending)) {
      if (v) merged.set(k, v)
      else merged.delete(k)
    }
    return merged
  }, [persisted, pending])
}

// ─── useAlreadyImportedMarkers ──────────────────────────────────────────
// Double-import guard: collect every `[<prefix>:<key>]` marker written into
// inventory_movements.notes in the last 90 days (generous re-import window —
// keeps the query cheap while covering any realistic rolling-report case).
//
//   prefix — 'sonar' (asset report, keys are Sonar item ids) or
//            'sonar_jobs' (fiber jobs, keys are <acct>_YYYY-MM-DD_<type>).
//            The ':' in the pattern keeps 'sonar' from matching
//            '[sonar_jobs:' rows.
//   rows   — the loaded/deduped CSV rows; used both as the refresh trigger
//            (new identity per CSV load → refetch) and the guard (empty →
//            clear the set without querying).
//
// Returns a Set of marker keys. On query failure the previous set is kept
// (warn-only), matching the originals.
export function useAlreadyImportedMarkers(prefix, rows) {
  const [keys, setKeys] = useState(() => new Set())
  useEffect(() => {
    if (!rows || rows.length === 0) {
      setKeys(new Set())
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString()
        // Paged (backlog #41): this guard FAILS OPEN — a marker row lost to
        // PostgREST's silent 1,000-row cap reads as "not yet imported" and a
        // re-delivered report double-books its transfers. The [sonar:] family
        // alone crossed 778 rows in the 90-day window (Aug 2026), so the cap
        // was weeks away. Stable (created_at, id) order per fetchAllRows'
        // contract — batch-inserted import rows share one created_at.
        const data = await fetchAllRows(() => db
          .from('inventory_movements')
          .select('notes')
          .like('notes', `%[${prefix}:%`)
          .gte('created_at', cutoff)
          .order('created_at').order('id'))
        if (cancelled) return
        setKeys(extractMarkerKeys(data, prefix))
      } catch (e) {
        console.warn(`Already-imported lookup failed (${prefix}):`, e)
      }
    })()
    return () => { cancelled = true }
  }, [prefix, rows])
  return keys
}

// Pure marker parser (exported for testability). Scans each row's `notes`
// for every `[<prefix>:<key>]` occurrence and returns the trimmed keys.
export function extractMarkerKeys(rowsWithNotes, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\[${escaped}:([^\\]]+)\\]`, 'g')
  const set = new Set()
  for (const m of rowsWithNotes) {
    let match
    while ((match = re.exec(m.notes || '')) !== null) {
      set.add(match[1].trim())
    }
  }
  return set
}
