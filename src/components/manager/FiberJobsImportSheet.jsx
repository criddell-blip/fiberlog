import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import {
  recordMovementsBatch,
  getSonarProjectMap, setSonarProjectPhase, getPhasesWithBuckets,
  getPendingSonarImports, getProcessedSonarImports, getPendingSonarImport,
  markSonarPendingImportApplied, discardSonarPendingImport,
  getFiberValueMap, setFiberValueMap, FIBER_QTY_MODE_OPTIONS,
  parseFiberRow, isFiberValueIgnored, FIBER_NON_MATERIAL_COLUMNS,
} from '../../lib/inventory'
import { parseCsv, readFileAsText } from '../../lib/csvImport'

// Importer for Sonar's "All fiber all jobs" report — the companion to
// SonarImportSheet which handles asset-tagged consumption.
//
// Differences from the asset report:
//   • One CSV row → 0–N inventory_movements (one per non-NA material
//     column, parsed via sonar_fiber_value_map)
//   • Crew comes from "User | Username" directly (no name-in-parens parsing)
//   • Project comes from the Project column (same path as asset report)
//   • Dedup key: Account|ID + Date + Job Type → [sonar_jobs:<acct>_<date>_<jobtype>]
//
// First import experience:
//   1. "Value mappings needed" section lists every unique (column, value)
//      combo that doesn't yet have a row in sonar_fiber_value_map
//   2. Manager picks SKU + qty mode once per combo → persists
//   3. Subsequent imports auto-resolve 95% of values; only new combos
//      and explicit-manual rows need attention

const REQUIRED_COLS = [
  'Job | Address on Completion',
  'Job Type | Name',
  'Account | ID',
  'User | Username',
  'Job | Completion Date time',
]

export default function FiberJobsImportSheet({ onClose, onApplied }) {
  const { showToast, currentUser } = useApp()

  // Reference data
  const [crewUsers, setCrewUsers] = useState([])
  const [trucksByUser, setTrucksByUser] = useState({})
  const [parts, setParts] = useState([])
  const [phases, setPhases] = useState([])
  const [persistedProjectMap, setPersistedProjectMap] = useState(() => new Map())
  const [valueMap, setValueMap] = useState(() => new Map())

  // CSV state
  const [fileName, setFileName] = useState('')
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvRows, setCsvRows] = useState(null)
  const [activePendingId, setActivePendingId] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Pending deliveries (fiber_jobs only)
  const [pendingImports, setPendingImports] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const refreshPending = async () => {
    try {
      const rows = await getPendingSonarImports({ includeProcessed: false, reportType: 'fiber_jobs' })
      setPendingImports(rows)
    } catch (e) {
      console.warn('Pending fiber-jobs imports load failed:', e)
    } finally {
      setPendingLoading(false)
    }
  }
  useEffect(() => { refreshPending() }, [])

  // Processed (audit panel)
  const [showProcessed, setShowProcessed] = useState(false)
  const [processedImports, setProcessedImports] = useState(null)
  const [processedLoading, setProcessedLoading] = useState(false)
  async function toggleProcessed() {
    const next = !showProcessed
    setShowProcessed(next)
    if (next && processedImports === null) {
      setProcessedLoading(true)
      try {
        const rows = await getProcessedSonarImports({ limit: 30, reportType: 'fiber_jobs' })
        setProcessedImports(rows)
      } catch (e) {
        console.warn('Processed fiber-jobs load failed:', e)
        setProcessedImports([])
      } finally {
        setProcessedLoading(false)
      }
    }
  }

  // Per-import picks
  const [crewMap, setCrewMap] = useState({})            // username → user_id
  const [pendingProjectMap, setPendingProjectMap] = useState({})  // project UPPER → phase id
  const [excluded, setExcluded] = useState(() => new Set())
  // Per-row, per-column manual overrides for materials that came back
  // unmapped/manual. Keyed by `${rowIdx}::${columnName}`.
  const [rowMaterialOverride, setRowMaterialOverride] = useState({})
  // Already-imported [sonar_jobs:...] markers from past movements (90d window).
  const [alreadyImportedKeys, setAlreadyImportedKeys] = useState(() => new Set())

  // Fetch lookups on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [usersRes, trucksRes, partsRes, phasesData, projectMap, valMap] = await Promise.all([
          db.from('users')
            .select('id, name, username, role, crew_type')
            .eq('is_active', true)
            .order('name'),
          db.from('inventory_locations')
            .select('id, assigned_to')
            .eq('type', 'truck')
            .eq('is_active', true)
            .not('assigned_to', 'is', null),
          db.from('parts_catalog')
            .select('id, name, unit, department, material_group')
            .eq('is_active', true)
            .order('name'),
          getPhasesWithBuckets(),
          getSonarProjectMap(),
          getFiberValueMap(),
        ])
        if (cancelled) return
        if (usersRes.error) throw usersRes.error
        if (trucksRes.error) throw trucksRes.error
        if (partsRes.error) throw partsRes.error
        setCrewUsers(usersRes.data || [])
        const tbu = {}
        for (const t of trucksRes.data || []) tbu[t.assigned_to] = t.id
        setTrucksByUser(tbu)
        setParts(partsRes.data || [])
        setPhases(phasesData || [])
        setPersistedProjectMap(projectMap)
        setValueMap(valMap)
      } catch (e) {
        if (!cancelled) setError('Failed to load lookups: ' + (e.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // CSV load — shared by file upload + pending-import load
  function loadCsvText(text) {
    const { headers, rows } = parseCsv(text)
    if (rows.length === 0) {
      setError('CSV had no data rows'); setCsvRows([]); return
    }
    const missing = REQUIRED_COLS.filter(c => !headers.includes(c))
    if (missing.length > 0) {
      setError(`CSV missing required columns: ${missing.join(', ')}`); setCsvRows([])
      return
    }
    setCsvHeaders(headers)
    setCsvRows(rows)
    setCrewMap({})
    setPendingProjectMap({})
    setExcluded(new Set())
    setRowMaterialOverride({})
  }

  async function handleFile(file) {
    if (!file) return
    setError(''); setParsing(true)
    setFileName(file.name)
    setActivePendingId(null)
    try {
      const text = await readFileAsText(file)
      loadCsvText(text)
    } catch (e) {
      console.error('Parse failed:', e)
      setError(e.message || String(e)); setCsvRows([])
    } finally {
      setParsing(false)
    }
  }

  async function loadPending(pending) {
    setError(''); setParsing(true)
    try {
      const full = await getPendingSonarImport(pending.id)
      setActivePendingId(pending.id)
      const label = full.filename || `pending ${new Date(full.received_at).toLocaleString()}`
      setFileName(`[webhook] ${label}`)
      loadCsvText(full.raw_csv || '')
    } catch (e) {
      console.error('Load pending failed:', e)
      setError(`Could not load pending import: ${e.message || e}`)
    } finally {
      setParsing(false)
    }
  }

  async function handleDiscardPending(pending) {
    const reason = window.prompt(
      `Discard this pending fiber-jobs import (${pending.parsed_row_count} rows from ${new Date(pending.received_at).toLocaleString()})?`,
      'Test fire / duplicate / not needed'
    )
    if (reason === null) return
    try {
      await discardSonarPendingImport(pending.id, { reason: reason || 'Discarded', userId: currentUser?.id })
      if (activePendingId === pending.id) {
        setActivePendingId(null); setCsvRows(null); setFileName('')
      }
      await refreshPending()
      showToast('Pending import discarded')
    } catch (e) {
      setError(`Discard failed: ${e.message || e}`)
    }
  }

  // Material columns = headers minus required + non-material columns
  const materialColumns = useMemo(() => {
    return csvHeaders.filter(h => !FIBER_NON_MATERIAL_COLUMNS.has(h))
  }, [csvHeaders])

  // Unique usernames
  const uniqueUsernames = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => (r['User | Username'] || '').trim()).filter(Boolean))]
  }, [csvRows])

  // Unique projects
  const uniqueProjects = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => (r['Project'] || '').trim()).filter(Boolean))]
  }, [csvRows])

  // Auto-match crew by username
  useEffect(() => {
    if (!csvRows || crewUsers.length === 0) return
    const auto = {}
    for (const uname of uniqueUsernames) {
      const u = crewUsers.find(u => (u.username || '').toLowerCase() === uname.toLowerCase())
        || crewUsers.find(u => (u.email || '').toLowerCase().startsWith(uname.toLowerCase() + '@'))
      if (u) auto[uname] = u.id
    }
    setCrewMap(prev => ({ ...auto, ...prev }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueUsernames, crewUsers])

  // Auto-seed project → phase via existing map
  const effectiveProjectMap = useMemo(() => {
    const merged = new Map(persistedProjectMap)
    for (const [k, v] of Object.entries(pendingProjectMap)) {
      if (v) merged.set(k, v); else merged.delete(k)
    }
    return merged
  }, [persistedProjectMap, pendingProjectMap])

  // Unique (column, value) combos that need a map entry
  const valueMappingsNeeded = useMemo(() => {
    if (!csvRows) return []
    const seen = new Set()
    const out = []
    for (const row of csvRows) {
      for (const col of materialColumns) {
        const raw = (row[col] || '').trim()
        if (!raw || isFiberValueIgnored(raw)) continue
        const key = `${col}::${raw.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        const existing = valueMap.get(key)
        if (!existing) out.push({ columnName: col, valueText: raw })
      }
    }
    return out
  }, [csvRows, materialColumns, valueMap])

  // Per-row parsed material lines
  const resolved = useMemo(() => {
    if (!csvRows) return []
    return csvRows.map((row, idx) => {
      const username = (row['User | Username'] || '').trim()
      const userId = crewMap[username] || null
      const truckId = userId ? trucksByUser[userId] : null
      const userName = userId ? crewUsers.find(u => u.id === userId)?.name || username : username
      const sonarProject = (row['Project'] || '').trim()
      const projPhaseId = sonarProject ? effectiveProjectMap.get(sonarProject.toUpperCase()) : null
      const phase = projPhaseId ? phases.find(p => p.id === projPhaseId) : null
      const destBucketId = phase?.bucket_id || null
      const account = (row['Account | ID'] || '').trim()
      const dateStr = (row['Job | Completion Date time'] || '').slice(0, 10)
      const jobType = (row['Job Type | Name'] || '').trim().toLowerCase().replace(/\s+/g, '_')
      const dedupKey = `${account}_${dateStr}_${jobType}`
      const isAlreadyImported = dedupKey && alreadyImportedKeys.has(dedupKey)

      // Materials parsed from value map (consider only material columns)
      const lines = parseFiberRow(row, valueMap, materialColumns)
      // Apply per-row overrides
      const finalLines = lines.map(line => {
        const overrideKey = `${idx}::${line.columnName}`
        const ov = rowMaterialOverride[overrideKey]
        if (ov) {
          return {
            ...line,
            sku: ov.sku !== undefined ? ov.sku : line.sku,
            qty: ov.qty !== undefined ? Number(ov.qty) : line.qty,
            status: ov.exclude ? 'excluded' : (ov.sku && Number(ov.qty) > 0 ? 'ready' : line.status),
          }
        }
        return line
      })

      // Top-level row status
      let rowStatus = 'ready'
      if (isAlreadyImported) rowStatus = 'already-imported'
      else if (!userId) rowStatus = 'no-crew'
      else if (!truckId) rowStatus = 'no-truck'
      else if (!sonarProject) rowStatus = 'no-project'
      else if (!projPhaseId) rowStatus = 'project-unmapped'
      else if (!destBucketId) rowStatus = 'no-project-bucket'
      else if (finalLines.filter(l => l.status === 'ready').length === 0) rowStatus = 'no-materials'

      return {
        idx,
        address: row['Job | Address on Completion'] || '',
        date: dateStr,
        username, userId, truckId, userName,
        sonarProject,
        phaseId: projPhaseId, phaseName: phase?.name || '', phaseProjectName: phase?.project_name || '',
        destBucketId,
        account, jobType, jobTypeRaw: row['Job Type | Name'] || '',
        notes: row['Job | Completion Notes'] || '',
        dedupKey,
        isAlreadyImported,
        lines: finalLines,
        rowStatus,
      }
    })
  }, [csvRows, crewMap, trucksByUser, crewUsers, materialColumns, valueMap, effectiveProjectMap, phases, rowMaterialOverride, alreadyImportedKeys])

  // Already-imported lookup vs past movements (90-day window)
  useEffect(() => {
    if (!resolved || resolved.length === 0) {
      setAlreadyImportedKeys(new Set()); return
    }
    let cancelled = false
    ;(async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString()
        const { data, error } = await db
          .from('inventory_movements')
          .select('notes')
          .like('notes', '%[sonar_jobs:%')
          .gte('created_at', cutoff)
        if (error) throw error
        if (cancelled) return
        const set = new Set()
        const re = /\[sonar_jobs:([^\]]+)\]/g
        for (const m of data || []) {
          let match
          while ((match = re.exec(m.notes || '')) !== null) set.add(match[1].trim())
        }
        setAlreadyImportedKeys(set)
      } catch (e) {
        console.warn('Already-imported lookup failed:', e)
      }
    })()
    return () => { cancelled = true }
    // resolved depends on many things; we just want to refresh once when csvRows is set
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [csvRows])

  // Handlers for value-map picker
  async function handleValueMapChange(columnName, valueText, fields) {
    try {
      await setFiberValueMap({
        columnName, valueText,
        sku: fields.sku || null,
        qtyMode: fields.qtyMode,
        pairColumn: fields.pairColumn || null,
        defaultQty: fields.defaultQty || 1,
      })
      // Optimistically refresh in-memory map
      const key = `${columnName}::${valueText.toLowerCase()}`
      const newMap = new Map(valueMap)
      newMap.set(key, {
        column_name: columnName, value_text: valueText,
        sku: fields.sku || null, qty_mode: fields.qtyMode,
        pair_column: fields.pairColumn || null,
        default_qty: fields.defaultQty || 1,
      })
      setValueMap(newMap)
    } catch (e) {
      setError(`Save mapping failed: ${e.message || e}`)
    }
  }

  // Handlers for project/crew pickers
  async function handleProjectPhaseChange(project, phaseId) {
    const up = project.toUpperCase()
    setPendingProjectMap(prev => ({ ...prev, [up]: phaseId }))
    if (!phaseId) return
    try {
      await setSonarProjectPhase(project, phaseId)
      setPersistedProjectMap(prev => { const next = new Map(prev); next.set(up, phaseId); return next })
    } catch (e) {
      setError(`Save project mapping failed: ${e.message || e}`)
    }
  }

  function setRowOverride(rowIdx, columnName, patch) {
    const key = `${rowIdx}::${columnName}`
    setRowMaterialOverride(prev => ({ ...prev, [key]: { ...(prev[key] || {}), ...patch } }))
  }

  function toggleExclude(idx) {
    setExcluded(prev => {
      const n = new Set(prev)
      if (n.has(idx)) n.delete(idx); else n.add(idx)
      return n
    })
  }

  // Stats
  const stats = useMemo(() => {
    if (resolved.length === 0) return null
    let ready = 0, blocked = 0, alreadyImported = 0, excludedCount = 0
    let totalReadyMovements = 0
    for (const r of resolved) {
      if (excluded.has(r.idx)) { excludedCount++; continue }
      if (r.rowStatus === 'already-imported') { alreadyImported++; continue }
      if (r.rowStatus === 'ready') {
        const lineCount = r.lines.filter(l => l.status === 'ready' && l.sku && l.qty > 0).length
        if (lineCount > 0) { ready++; totalReadyMovements += lineCount }
        else blocked++
      } else {
        blocked++
      }
    }
    return { total: resolved.length, ready, blocked, excludedCount, alreadyImported, totalReadyMovements }
  }, [resolved, excluded])

  async function handleApply() {
    setError('')
    setSubmitting(true)
    try {
      const movements = []
      for (const r of resolved) {
        if (excluded.has(r.idx)) continue
        if (r.rowStatus !== 'ready') continue
        for (const line of r.lines) {
          if (line.status !== 'ready' || !line.sku || line.qty <= 0) continue
          const notePieces = [
            `Sonar fiber-jobs: ${r.jobTypeRaw}`,
            r.address,
            line.columnName + ': ' + line.valueText,
            `[sonar_jobs:${r.dedupKey}]`,
          ].filter(Boolean)
          movements.push({
            movement_type: 'transfer',
            part_id: line.sku,
            quantity: line.qty,
            unit: (parts.find(p => p.id === line.sku)?.unit) || 'ea',
            from_location_id: r.truckId,
            to_location_id: r.destBucketId,
            notes: notePieces.join(' · '),
            created_by: currentUser?.id,
            phase_id: r.phaseId || null,
            consumed_by_user_id: r.userId || null,
          })
        }
      }
      if (movements.length === 0) {
        setError('Nothing ready to apply'); setSubmitting(false); return
      }
      await recordMovementsBatch(movements)
      if (activePendingId) {
        try {
          await markSonarPendingImportApplied(activePendingId, {
            movementCount: movements.length,
            userId: currentUser?.id,
          })
        } catch (e) {
          console.warn('Mark pending imported failed (movements still applied):', e)
        }
      }
      if (onApplied) onApplied(movements.length)
      showToast(`Applied ${movements.length} fiber-job movement${movements.length === 1 ? '' : 's'}`)
    } catch (e) {
      console.error('Apply failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 1080, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
          🧵 Sonar fiber jobs import
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
          Each row is a fiber install / drop / fix. Materials are parsed from the descriptive
          columns via the persistent value map; one row produces 0–N movements.
        </div>

        {/* File picker */}
        <div style={{
          marginBottom: 12, padding: 10,
          background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <label style={{
            display: 'inline-block', padding: '6px 12px',
            background: 'var(--orange)', color: 'white',
            borderRadius: 'var(--r-sm)', cursor: 'pointer',
            fontSize: 13, fontWeight: 700, flexShrink: 0,
          }}>
            {csvRows ? 'Choose a different file' : 'Choose fiber jobs CSV'}
            <input
              type="file" accept=".csv,text/csv"
              onChange={e => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
          </label>
          {fileName && (
            <div style={{ fontSize: 12, color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fileName}
            </div>
          )}
        </div>

        {/* Pending deliveries (fiber_jobs only) */}
        {!pendingLoading && pendingImports.length > 0 && (
          <div style={{
            marginBottom: 12, padding: 10,
            border: '1px solid var(--accent-border)',
            background: 'var(--accent-bg)',
            borderRadius: 'var(--r-sm)',
          }}>
            <div style={{
              fontSize: 12, fontWeight: 800, color: 'var(--accent-fg)',
              textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
            }}>
              📥 Auto-delivered from Sonar ({pendingImports.length})
            </div>
            {pendingImports.map(p => {
              const isActive = activePendingId === p.id
              return (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', marginBottom: 4,
                  background: isActive ? 'var(--orange)' : 'var(--surface)',
                  color: isActive ? '#fff' : 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 13 }}>
                      {new Date(p.received_at).toLocaleString()}
                    </div>
                    <div style={{ fontSize: 11, color: isActive ? 'rgba(255,255,255,0.85)' : 'var(--hint)' }}>
                      {p.parsed_row_count} row{p.parsed_row_count === 1 ? '' : 's'}
                      {p.filename ? ` · ${p.filename}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => loadPending(p)}
                    className="btn"
                    style={{
                      padding: '5px 10px', fontSize: 12,
                      background: isActive ? '#fff' : 'var(--orange)',
                      color: isActive ? 'var(--orange)' : '#fff',
                      border: 'none', borderRadius: 'var(--r-xs)',
                      fontWeight: 'var(--fw-semibold)', cursor: 'pointer',
                    }}
                    disabled={parsing || submitting}
                  >
                    {isActive ? 'Loaded' : 'Review'}
                  </button>
                  <button
                    onClick={() => handleDiscardPending(p)}
                    style={{
                      padding: '5px 8px', fontSize: 11,
                      background: 'transparent',
                      color: isActive ? 'rgba(255,255,255,0.8)' : 'var(--muted)',
                      border: 'none', cursor: 'pointer',
                    }}
                    title="Discard"
                    disabled={parsing || submitting}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Processed audit */}
        {!pendingLoading && (
          <div style={{ marginBottom: 12 }}>
            <button
              onClick={toggleProcessed}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 12,
                padding: '4px 0', textDecoration: 'underline',
              }}
            >
              {showProcessed ? '▾ Hide' : '▸ Show'} recent fiber-jobs deliveries (audit)
            </button>
            {showProcessed && processedImports && (
              <div style={{
                marginTop: 6, padding: 8,
                background: 'var(--surface2)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
              }}>
                {processedLoading && <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>Loading…</div>}
                {!processedLoading && processedImports.length === 0 && (
                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--hint)', fontSize: 12 }}>
                    No processed deliveries yet.
                  </div>
                )}
                {!processedLoading && processedImports.map(p => {
                  const isImported = p.status === 'imported'
                  return (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '5px 6px', marginBottom: 2,
                      fontSize: 11, borderBottom: '1px solid var(--border)',
                    }}>
                      <span className={isImported ? 'pill pill-success pill-sm' : 'pill pill-muted pill-sm'} style={{ flexShrink: 0 }}>
                        {isImported ? '✓ imported' : 'discarded'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--fw-semibold)' }}>
                          {new Date(p.received_at).toLocaleString()}
                          <span style={{ color: 'var(--hint)', fontWeight: 'normal', marginLeft: 6 }}>
                            · {p.parsed_row_count} row{p.parsed_row_count === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div style={{ color: 'var(--hint)', fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {isImported
                            ? `applied ${p.applied_movement_count || 0} movement${p.applied_movement_count === 1 ? '' : 's'}`
                            : (p.error_message || p.discard_reason || 'no reason given')}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {parsing && <div style={{ padding: 16, color: 'var(--muted)', textAlign: 'center' }}>Parsing…</div>}

        {error && (
          <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--danger-bg)', color: 'var(--danger-fg)', borderRadius: 'var(--r-sm)', fontSize: 13, fontWeight: 600 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {/* Value mappings needed — first import sets these */}
          {valueMappingsNeeded.length > 0 && (
            <Section title={`Value mappings needed (${valueMappingsNeeded.length})`} accent="var(--purple)"
              subtitle="Each unique (column, value) combo needs a SKU + qty mode mapping. Saved once → auto-resolves every future import.">
              {valueMappingsNeeded.map(({ columnName, valueText }) => (
                <ValueMapRow
                  key={`${columnName}::${valueText}`}
                  columnName={columnName}
                  valueText={valueText}
                  parts={parts}
                  materialColumns={materialColumns}
                  rowCount={resolved.filter(r => r.lines.some(l => l.columnName === columnName && l.valueText === valueText)).length}
                  onSave={fields => handleValueMapChange(columnName, valueText, fields)}
                />
              ))}
            </Section>
          )}

          {/* Crew mappings */}
          {uniqueUsernames.length > 0 && (
            <Section title="Crew (User | Username → FiberLog user)" accent="var(--teal)"
              subtitle="Auto-matched by exact username. Override if wrong.">
              {uniqueUsernames.map(uname => {
                const uid = crewMap[uname]
                const hasTruck = uid ? !!trucksByUser[uid] : false
                const status = !uid ? { tag: 'unmatched', color: 'var(--amber)' }
                  : !hasTruck ? { tag: 'no truck', color: 'var(--red)' }
                  : { tag: 'matched', color: 'var(--teal-dk)' }
                const n = resolved.filter(r => r.username === uname).length
                return (
                  <MappingRow key={uname} primary={uname} secondary={`${n} row${n === 1 ? '' : 's'}`} status={status}>
                    <select
                      value={uid || ''}
                      onChange={e => setCrewMap(prev => ({ ...prev, [uname]: e.target.value }))}
                      style={selectStyle()}
                    >
                      <option value="">— pick crew —</option>
                      {crewUsers.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.name}{u.crew_type ? ` (${u.crew_type})` : ''}{trucksByUser[u.id] ? '' : ' — no truck!'}
                        </option>
                      ))}
                    </select>
                  </MappingRow>
                )
              })}
            </Section>
          )}

          {/* Project mappings (reuses sonar_project_phase_map) */}
          {uniqueProjects.length > 0 && (
            <Section title="Project mappings" accent="var(--purple)"
              subtitle="Reuses the same Project → phase map as the asset-consumption report.">
              {uniqueProjects.map(project => {
                const up = project.toUpperCase()
                const picked = effectiveProjectMap.get(up) || ''
                const pickedPhase = picked ? phases.find(p => p.id === picked) : null
                const status = picked
                  ? pickedPhase?.bucket_id
                    ? { tag: 'mapped', color: 'var(--purple)' }
                    : { tag: 'phase has no bucket', color: 'var(--red)' }
                  : { tag: 'needs mapping', color: 'var(--amber)' }
                const n = resolved.filter(r => r.sonarProject.toUpperCase() === up).length
                return (
                  <MappingRow key={project} primary={project} secondary={`${n} row${n === 1 ? '' : 's'}`} status={status}>
                    <select
                      value={picked}
                      onChange={e => handleProjectPhaseChange(project, e.target.value)}
                      style={selectStyle()}
                    >
                      <option value="">— pick phase —</option>
                      {phases.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.project_name} / {p.name}{!p.bucket_id ? ' (no bucket)' : ''}
                        </option>
                      ))}
                    </select>
                  </MappingRow>
                )
              })}
            </Section>
          )}

          {/* Jobs preview */}
          {resolved.length > 0 && (
            <>
              <div style={{
                fontSize: 12, fontWeight: 700, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '.04em',
                marginTop: 16, marginBottom: 6,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>Jobs</span>
                {stats && (
                  <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--hint)' }}>
                    {stats.ready} ready ({stats.totalReadyMovements} movements) · {stats.blocked} blocked
                    {stats.alreadyImported > 0 && <> · {stats.alreadyImported} already imported</>}
                    {stats.excludedCount > 0 && <> · {stats.excludedCount} excluded</>}
                  </span>
                )}
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                {resolved.map(r => (
                  <JobRow
                    key={r.idx} job={r} parts={parts}
                    isExcluded={excluded.has(r.idx)}
                    onToggleExclude={() => toggleExclude(r.idx)}
                    onSetOverride={(col, patch) => setRowOverride(r.idx, col, patch)}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            {csvRows ? 'Cancel' : 'Close'}
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleApply}
            disabled={submitting || !stats || stats.totalReadyMovements === 0}
          >
            {submitting
              ? 'Applying…'
              : stats && stats.totalReadyMovements > 0
                ? `Apply ${stats.totalReadyMovements} movement${stats.totalReadyMovements === 1 ? '' : 's'}`
                : 'Nothing to apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Value-map picker row ──────────────────────────────────────────────
function ValueMapRow({ columnName, valueText, parts, materialColumns, rowCount, onSave }) {
  const [sku, setSku] = useState('')
  const [qtyMode, setQtyMode] = useState('fixed_unit')
  const [pairColumn, setPairColumn] = useState('')
  const [saved, setSaved] = useState(false)

  async function save() {
    if (qtyMode !== 'ignore' && !sku) return
    if (qtyMode === 'pair_with_column' && !pairColumn) return
    await onSave({ sku, qtyMode, pairColumn })
    setSaved(true)
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '2fr 2fr 1.6fr 1.6fr auto',
      gap: 6, alignItems: 'center',
      padding: '6px 8px', marginBottom: 4,
      background: saved ? 'var(--success-bg)' : 'var(--surface2)',
      borderRadius: 6,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--hint)' }}>{columnName}</div>
        <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{valueText}</div>
        <div style={{ fontSize: 10, color: 'var(--hint)' }}>{rowCount} row{rowCount === 1 ? '' : 's'}</div>
      </div>
      <select
        value={sku}
        onChange={e => { setSku(e.target.value); setSaved(false) }}
        disabled={qtyMode === 'ignore'}
        style={selectStyle()}
      >
        <option value="">— pick SKU —</option>
        {parts.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
      </select>
      <select
        value={qtyMode}
        onChange={e => { setQtyMode(e.target.value); setSaved(false) }}
        style={selectStyle()}
      >
        {FIBER_QTY_MODE_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {qtyMode === 'pair_with_column' ? (
        <select value={pairColumn} onChange={e => { setPairColumn(e.target.value); setSaved(false) }} style={selectStyle()}>
          <option value="">— pick paired col —</option>
          {materialColumns.filter(c => c !== columnName).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : <div />}
      <button
        onClick={save}
        disabled={(qtyMode !== 'ignore' && !sku) || (qtyMode === 'pair_with_column' && !pairColumn) || saved}
        className="btn btn-primary"
        style={{ padding: '4px 10px', fontSize: 11 }}
      >
        {saved ? 'Saved' : 'Save'}
      </button>
    </div>
  )
}

// ─── Job preview row ────────────────────────────────────────────────────
function JobRow({ job, parts, isExcluded, onToggleExclude, onSetOverride }) {
  const isReady = job.rowStatus === 'ready'
  const isAlreadyImported = job.rowStatus === 'already-imported'
  return (
    <div style={{
      padding: '8px 10px', borderBottom: '1px solid var(--border)',
      background: isExcluded ? 'var(--gray-lt)' : isAlreadyImported ? 'var(--gray-lt)' : isReady ? 'transparent' : 'var(--amber-lt)',
      opacity: isExcluded || isAlreadyImported ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        {!isAlreadyImported && (
          <input
            type="checkbox"
            checked={!isExcluded}
            onChange={onToggleExclude}
            style={{ marginTop: 1 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 12 }}>
            {job.jobTypeRaw} <span style={{ color: 'var(--hint)', fontWeight: 400 }}>· {job.address}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--hint)' }}>
            {job.date} · {job.userName || job.username} · {job.sonarProject} → {job.phaseProjectName} / {job.phaseName}
          </div>
        </div>
        <JobStatusBadge status={job.rowStatus} />
      </div>
      {/* Material lines */}
      {!isAlreadyImported && job.lines.filter(l => l.status !== 'ignore').length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginLeft: 26 }}>
          {job.lines.filter(l => l.status !== 'ignore').map(line => (
            <div key={line.columnName} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 11,
            }}>
              <span style={{ minWidth: 110, color: 'var(--hint)', fontStyle: 'italic' }}>{line.columnName}</span>
              <span style={{ flex: 1 }}>{line.valueText}</span>
              {(line.status === 'unmapped' || line.status === 'manual') && (
                <>
                  <select
                    value={line.sku || ''}
                    onChange={e => onSetOverride(line.columnName, { sku: e.target.value })}
                    style={{ ...selectStyle(), maxWidth: 200 }}
                  >
                    <option value="">— pick SKU —</option>
                    {parts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    type="number"
                    value={line.qty || ''}
                    placeholder="qty"
                    onChange={e => onSetOverride(line.columnName, { qty: e.target.value })}
                    style={{ width: 60, padding: '3px 6px', fontSize: 11, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                  />
                </>
              )}
              {line.status === 'ready' && (
                <span style={{ fontWeight: 600, color: 'var(--success-fg)' }}>
                  {line.qty} × {parts.find(p => p.id === line.sku)?.name || line.sku}
                </span>
              )}
              {line.status === 'pair-missing' && (
                <span style={{ color: 'var(--amber)' }}>⚠ {line.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────
function Section({ title, subtitle, accent, children }) {
  return (
    <div style={{
      marginBottom: 12, padding: 10,
      border: `1px solid ${accent}`, borderRadius: 'var(--r-sm)',
      background: 'var(--surface)',
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: accent, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>{subtitle}</div>
      {children}
    </div>
  )
}

function MappingRow({ primary, secondary, status, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
      padding: '4px 6px', background: 'var(--surface2)', borderRadius: 6,
    }}>
      <div style={{ flex: 2, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primary}</div>
        {secondary && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{secondary}</div>}
      </div>
      <div style={{ flex: 3, minWidth: 0 }}>{children}</div>
      {status && <div style={statusBadgeStyle(status.color)}>{status.tag}</div>}
    </div>
  )
}

function JobStatusBadge({ status }) {
  const map = {
    ready:             { label: 'ready',           color: 'var(--teal-dk)',  bg: 'var(--teal-lt)' },
    'no-crew':         { label: 'no crew',         color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'no-truck':        { label: 'no truck',        color: 'var(--red)',      bg: 'var(--red-lt)' },
    'no-project':      { label: 'no project',      color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'project-unmapped':{ label: 'project unmapped',color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'no-project-bucket':{label: 'no bucket',       color: 'var(--red)',      bg: 'var(--red-lt)' },
    'no-materials':    { label: 'no materials',    color: 'var(--hint)',     bg: 'var(--gray-lt)' },
    'already-imported':{ label: 'already imported',color: 'var(--muted)',    bg: 'var(--gray-lt)' },
  }
  const s = map[status] || map.ready
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999,
      background: s.bg, color: s.color,
      fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
      flexShrink: 0,
    }}>{s.label}</span>
  )
}

function selectStyle() {
  return {
    width: '100%', padding: '4px 6px',
    fontSize: 12, border: '1px solid var(--border2)',
    borderRadius: 'var(--r-xs)', background: 'var(--surface2)',
    color: 'var(--text)',
  }
}

function statusBadgeStyle(color) {
  return {
    padding: '2px 8px', borderRadius: 999,
    border: `1px solid ${color}`,
    color, fontSize: 10, fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '.04em',
    flexShrink: 0,
  }
}
