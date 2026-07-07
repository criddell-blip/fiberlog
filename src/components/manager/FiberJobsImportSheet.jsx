import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import { crewTypeLabel } from '../../lib/crewTypes'
import {
  recordMovementsBatch,
  getSonarProjectMap, setSonarProjectPhase, getPhasesWithBuckets,
  getSonarSourceLocationMap, setSonarSourceLocation, getLocations,
  getFiberValueMap, setFiberValueMap, FIBER_QTY_MODE_OPTIONS,
  parseFiberRow, isFiberValueIgnored, FIBER_NON_MATERIAL_COLUMNS,
} from '../../lib/inventory'
import {
  useCsvFile, useSonarPendingQueue, useEffectiveMap, useAlreadyImportedMarkers,
} from '../../lib/useCsvImport'
import {
  Section, MappingRow, StatusBadge, selectStyle,
  SourceLocationSelect, PendingImportsPanel, ProcessedImportsPanel,
} from './importShared'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

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
  // Source-location support (parity with SonarImportSheet):
  const [sourceLocations, setSourceLocations] = useState([])   // active warehouse/bin/truck/group, eligible source targets
  const [pullByUser, setPullByUser] = useState({})             // userId → default_pull_location_id
  const [activeLocIds, setActiveLocIds] = useState(() => new Set())  // ids of active locations (validate pull targets)
  const [persistedSourceMap, setPersistedSourceMap] = useState(() => new Map())  // sonar_source(username) UPPER → location id
  const [pendingSourceMap, setPendingSourceMap] = useState({})  // session edits, mirrors persistedSourceMap

  // Per-import picks
  const [crewMap, setCrewMap] = useState({})            // username → user_id
  const [pendingProjectMap, setPendingProjectMap] = useState({})  // project UPPER → phase id
  const [excluded, setExcluded] = useState(() => new Set())
  // Per-row, per-column manual overrides for materials that came back
  // unmapped/manual. Keyed by `${rowIdx}::${columnName}`.
  const [rowMaterialOverride, setRowMaterialOverride] = useState({})
  const [rowSource, setRowSource] = useState({})        // row idx → source location id (per-row override)
  const [rowExtraMaterials, setRowExtraMaterials] = useState({})  // job idx → [{sku, qty}] materials added by hand (Sonar job had none/missing)
  const [submitting, setSubmitting] = useState(false)

  // CSV state + webhook queue (shared plumbing)
  const csv = useCsvFile({
    requiredCols: REQUIRED_COLS,
    missingColsMessage: missing => `CSV missing required columns: ${missing.join(', ')}`,
    // Successful load resets the per-import picks (persisted maps survive).
    onLoaded: () => {
      setCrewMap({})
      setPendingProjectMap({})
      setExcluded(new Set())
      setRowMaterialOverride({})
    },
  })
  const { fileName, csvHeaders, csvRows, error, setError, parsing, handleFile } = csv

  const queue = useSonarPendingQueue('fiber_jobs', {
    csv,
    currentUserId: currentUser?.id,
    showToast,
    discardPrompt: p =>
      `Discard this pending fiber-jobs import (${p.parsed_row_count} rows from ${new Date(p.received_at).toLocaleString()})?`,
  })

  // Back closes the importer (mounted only when open). Confirm once a CSV is
  // loaded so mapping work isn't lost to a stray Back.
  useBackClose(1, onClose, {
    confirm: () => csvRows == null || window.confirm('Close the fiber-jobs import? Unsaved mapping will be lost.'),
  })

  // Fetch lookups on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [usersRes, trucksRes, partsRes, phasesData, projectMap, valMap, sourceMap, allLocations] = await Promise.all([
          db.from('users')
            .select('id, name, email, role, crew_type, default_pull_location_id')
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
          getSonarSourceLocationMap(),
          getLocations({ includeBins: true }),
        ])
        if (cancelled) return
        // Surface each individual error so a single broken query
        // doesn't silently kill the whole load.
        if (usersRes.error) throw new Error('users query: ' + usersRes.error.message)
        if (trucksRes.error) throw new Error('trucks query: ' + trucksRes.error.message)
        if (partsRes.error) throw new Error('parts query: ' + partsRes.error.message)
        setCrewUsers(usersRes.data || [])
        const tbu = {}
        for (const t of trucksRes.data || []) tbu[t.assigned_to] = t.id
        setTrucksByUser(tbu)
        // userId → default_pull_location_id (shared group/trailer assignment)
        const pbu = {}
        for (const u of usersRes.data || []) if (u.default_pull_location_id) pbu[u.id] = u.default_pull_location_id
        setPullByUser(pbu)
        setParts(partsRes.data || [])
        setPhases(phasesData || [])
        setPersistedProjectMap(projectMap)
        setValueMap(valMap)
        setPersistedSourceMap(sourceMap)
        // Eligible source-override targets + the active-location set used to
        // validate a user's pull location.
        const locs = (allLocations || []).filter(l => l.is_active !== false)
        setActiveLocIds(new Set(locs.map(l => l.id)))
        setSourceLocations(locs.filter(l => ['warehouse', 'bin', 'truck', 'group'].includes(l.type)))
      } catch (e) {
        if (!cancelled) setError('Failed to load lookups: ' + (e.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

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

  // Auto-match crew by username. Sonar's "User | Username" is the email's
  // local part (e.g. "jespinoza" matches "jespinoza@fiberlog....").
  useEffect(() => {
    if (!csvRows || crewUsers.length === 0) return
    const auto = {}
    for (const uname of uniqueUsernames) {
      const target = uname.toLowerCase()
      const u = crewUsers.find(u => (u.email || '').toLowerCase().startsWith(target + '@'))
      if (u) auto[uname] = u.id
    }
    setCrewMap(prev => ({ ...auto, ...prev }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueUsernames, crewUsers])

  // Auto-seed project → phase via existing map
  const effectiveProjectMap = useEffectiveMap(persistedProjectMap, pendingProjectMap)

  // Sonar username → mapped source location (persisted + session edits).
  const effectiveSourceMap = useEffectiveMap(persistedSourceMap, pendingSourceMap)

  // A crew member's own home location: their shared pull location (group/
  // trailer) when active, else their personal truck. Mirrors getMyTruck so
  // group members (deactivated personal truck) resolve correctly.
  function homeLocFor(userId) {
    if (!userId) return null
    const pull = pullByUser[userId]
    if (pull && activeLocIds.has(pull)) return pull
    return trucksByUser[userId] || null
  }

  // Persist a username → source-location mapping (for completers who aren't
  // the carrier). Reuses sonar_source_location_map; keyed on the username.
  async function handleSourceLocationChange(username, locationId) {
    const up = username.toUpperCase()
    setPendingSourceMap(prev => ({ ...prev, [up]: locationId }))
    if (!locationId) return
    try {
      await setSonarSourceLocation(username, locationId)
      setPersistedSourceMap(prev => { const next = new Map(prev); next.set(up, locationId); return next })
    } catch (e) {
      setError('Failed to save source mapping: ' + (e.message || e))
    }
  }

  // Per-row source override (one-off).
  function setRowSourceLocation(idx, locationId) {
    setRowSource(prev => ({ ...prev, [idx]: locationId || null }))
  }

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

  // Already-imported [sonar_jobs:<acct>_YYYY-MM-DD_<type>] markers from past
  // movements (90-day window) — refreshed whenever a new CSV is loaded.
  const alreadyImportedKeys = useAlreadyImportedMarkers('sonar_jobs', csvRows)

  // Per-row parsed material lines
  const resolved = useMemo(() => {
    if (!csvRows) return []
    return csvRows.map((row, idx) => {
      const username = (row['User | Username'] || '').trim()
      const userId = crewMap[username] || null
      const userName = userId ? crewUsers.find(u => u.id === userId)?.name || username : username
      // Source resolution: per-row override → saved per-username map (for
      // non-carrier completers like cparisi) → the crew member's own home
      // location (pull group/trailer when active, else personal truck).
      const sourceIsMapped = !!(rowSource[idx] || effectiveSourceMap.get(username.toUpperCase()))
      const sourceLocId = rowSource[idx] || effectiveSourceMap.get(username.toUpperCase()) || homeLocFor(userId)
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
      const overridden = lines.map(line => {
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
      // Manually-added materials (for jobs Sonar left without materials).
      const extras = (rowExtraMaterials[idx] || []).map((m, i) => {
        const q = Number(m.qty) || 0
        return {
          columnName: '+ added', valueText: 'manual', sku: m.sku || '', qty: q,
          status: (m.sku && q > 0) ? 'ready' : 'manual',
          _manual: true, _manualIndex: i,
        }
      })
      const finalLines = [...overridden, ...extras]

      // Top-level row status
      let rowStatus = 'ready'
      if (isAlreadyImported) rowStatus = 'already-imported'
      else if (!userId && !sourceIsMapped) rowStatus = 'no-crew'
      else if (!sourceLocId) rowStatus = 'no-truck'
      else if (!sonarProject) rowStatus = 'no-project'
      else if (!projPhaseId) rowStatus = 'project-unmapped'
      else if (!destBucketId) rowStatus = 'no-project-bucket'
      else if (finalLines.filter(l => l.status === 'ready').length === 0) rowStatus = 'no-materials'

      return {
        idx,
        address: row['Job | Address on Completion'] || '',
        date: dateStr,
        username, userId, userName,
        sourceLocId, sourceIsMapped,
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
  }, [csvRows, crewMap, trucksByUser, pullByUser, activeLocIds, effectiveSourceMap, rowSource, crewUsers, materialColumns, valueMap, effectiveProjectMap, phases, rowMaterialOverride, rowExtraMaterials, alreadyImportedKeys])

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

  // Manually-added materials for a job that came in with none/missing (common
  // for contractor jobs + drop fixes). Per-import only — not persisted.
  function addRowMaterial(rowIdx) {
    setRowExtraMaterials(prev => ({ ...prev, [rowIdx]: [...(prev[rowIdx] || []), { sku: '', qty: 1 }] }))
  }
  function setRowMaterial(rowIdx, i, patch) {
    setRowExtraMaterials(prev => {
      const list = [...(prev[rowIdx] || [])]
      list[i] = { ...list[i], ...patch }
      return { ...prev, [rowIdx]: list }
    })
  }
  function removeRowMaterial(rowIdx, i) {
    setRowExtraMaterials(prev => ({ ...prev, [rowIdx]: (prev[rowIdx] || []).filter((_, j) => j !== i) }))
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
          // Real job date (completion) so reports/Sage date by when the work
          // happened, not the import day. r.date is 'YYYY-MM-DD'. See occurred_at.
          const occ = r.date ? new Date(r.date + 'T00:00:00') : null
          movements.push({
            movement_type: 'transfer',
            part_id: line.sku,
            quantity: line.qty,
            unit: (parts.find(p => p.id === line.sku)?.unit) || 'ea',
            from_location_id: r.sourceLocId,
            to_location_id: r.destBucketId,
            notes: notePieces.join(' · '),
            created_by: currentUser?.id,
            occurred_at: (occ && !isNaN(occ.getTime())) ? occ.toISOString() : null,
            phase_id: r.phaseId || null,
            // A mapped/overridden source means the completer wasn't the
            // carrier — don't attribute consumption to them.
            consumed_by_user_id: r.sourceIsMapped ? null : (r.userId || null),
          })
        }
      }
      if (movements.length === 0) {
        setError('Nothing ready to apply'); setSubmitting(false); return
      }
      // DELIBERATELY atomic (default mode, NOT chunk:true): this writes the
      // consumption ledger, and the [sonar_jobs:] markers are per-JOB while
      // one job expands to N movement lines — a partial write would leave a
      // job's marker present with some lines missing, so a later retry
      // would skip the whole job and silently under-count materials. The
      // in-session marker set also never refreshes mid-CSV, so partial +
      // re-apply could equally double-book. All-or-nothing sidesteps both:
      // failure writes nothing, re-apply is always safe.
      await recordMovementsBatch(movements)
      await queue.markApplied(movements.length)
      // Clear local state so the apply button can't re-fire against the
      // same dataset even if the parent's close callback misbehaves.
      csv.clear()
      queue.clearActive()
      setCrewMap({})
      setPendingProjectMap({})
      setExcluded(new Set())
      setRowMaterialOverride({})
      if (onApplied) onApplied(movements.length)
    } catch (e) {
      console.error('Apply failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 1080, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="download" size={19} /> Sonar fiber jobs import
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
              onChange={e => {
                const f = e.target.files?.[0]
                if (!f) return
                queue.clearActive()  // manual upload wipes any prior pending-id linkage
                handleFile(f)
              }}
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
        <PendingImportsPanel queue={queue} disabled={parsing || submitting} />

        {/* Processed audit */}
        <ProcessedImportsPanel queue={queue} label="fiber-jobs" />

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
              subtitle="Auto-matched by exact username. When the completer isn't the carrier (e.g. cparisi entering contractor jobs), map them to the location the stock came off — any warehouse, shared trailer, or truck. That pick persists.">
              {uniqueUsernames.map(uname => {
                const uid = crewMap[uname]
                const mappedLocId = effectiveSourceMap.get(uname.toUpperCase())
                const mappedLocName = mappedLocId ? (sourceLocations.find(l => l.id === mappedLocId)?.name || null) : null
                const homeLoc = uid ? homeLocFor(uid) : null
                const status = mappedLocId
                  ? { tag: `source${mappedLocName ? `: ${mappedLocName}` : ''}`, color: 'var(--teal-dk)' }
                  : !uid ? { tag: 'unmatched', color: 'var(--amber)' }
                  : !homeLoc ? { tag: 'no truck', color: 'var(--red)' }
                  : { tag: 'matched', color: 'var(--teal-dk)' }
                const n = resolved.filter(r => r.username === uname).length
                return (
                  <MappingRow key={uname} primary={uname} secondary={`${n} row${n === 1 ? '' : 's'}`} status={status}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <select
                        value={uid || ''}
                        onChange={e => setCrewMap(prev => ({ ...prev, [uname]: e.target.value }))}
                        style={selectStyle()}
                      >
                        <option value="">— pick crew —</option>
                        {crewUsers.map(u => (
                          <option key={u.id} value={u.id}>
                            {u.name}{u.crew_type ? ` (${crewTypeLabel(u.crew_type)})` : ''}{(trucksByUser[u.id] || homeLocFor(u.id)) ? '' : ' — no truck!'}
                          </option>
                        ))}
                      </select>
                      <SourceLocationSelect
                        locations={sourceLocations}
                        value={mappedLocId}
                        onChange={v => handleSourceLocationChange(uname, v || null)}
                        placeholder="…or pull from a location (persists)"
                        style={{ ...selectStyle(), fontSize: 11, color: 'var(--muted)' }}
                      />
                    </div>
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
                    sourceLocations={sourceLocations}
                    rowSourceId={rowSource[r.idx] || ''}
                    onSetSource={locId => setRowSourceLocation(r.idx, locId)}
                    onAddMaterial={() => addRowMaterial(r.idx)}
                    onSetMaterial={(i, patch) => setRowMaterial(r.idx, i, patch)}
                    onRemoveMaterial={i => removeRowMaterial(r.idx, i)}
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
function JobRow({ job, parts, isExcluded, onToggleExclude, onSetOverride, sourceLocations = [], rowSourceId = '', onSetSource, onAddMaterial, onSetMaterial, onRemoveMaterial }) {
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
          {/* Per-row source override — set where the stock came off when the
              completer isn't the carrier; resolves no-crew / no-truck rows. */}
          {!isAlreadyImported && (
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: 'var(--hint)' }}>source:</span>
              <SourceLocationSelect
                locations={sourceLocations}
                value={rowSourceId}
                onChange={v => onSetSource(v)}
                placeholder={job.sourceLocId
                  ? (sourceLocations.find(l => l.id === job.sourceLocId)?.name || 'override source…')
                  : '— pick source —'}
                style={{ ...selectStyle(), fontSize: 11, minWidth: 150, color: 'var(--muted)' }}
              />
            </div>
          )}
        </div>
        <StatusBadge status={job.rowStatus} map={JOB_STATUS_MAP} />
      </div>
      {/* Material lines — always shown for a non-imported job so a job that
          came in with NO materials (contractor jobs / drop fixes) can still
          have one added by hand. */}
      {!isAlreadyImported && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginLeft: 26 }}>
          {job.lines.filter(l => l.status !== 'ignore').map(line => (
            <div key={line._manual ? `manual-${line._manualIndex}` : line.columnName} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 11,
            }}>
              <span style={{ minWidth: 110, color: 'var(--hint)', fontStyle: 'italic' }}>{line.columnName}</span>
              {!line._manual && <span style={{ flex: 1 }}>{line.valueText}</span>}
              {/* Manual line: own SKU + qty + remove, edits rowExtraMaterials. */}
              {line._manual ? (
                <>
                  <select
                    value={line.sku || ''}
                    onChange={e => onSetMaterial(line._manualIndex, { sku: e.target.value })}
                    style={{ ...selectStyle(), flex: 1, maxWidth: 260 }}
                  >
                    <option value="">— pick SKU —</option>
                    {parts.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    type="number" min="0" value={line.qty || ''} placeholder="qty"
                    onChange={e => onSetMaterial(line._manualIndex, { qty: e.target.value })}
                    style={{ width: 60, padding: '3px 6px', fontSize: 11, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                  />
                  <button type="button" onClick={() => onRemoveMaterial(line._manualIndex)} title="Remove this added material"
                    style={{ width: 24, height: 24, padding: 0, background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 'var(--r-xs)', cursor: 'pointer', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="x" size={12} />
                  </button>
                </>
              ) : (line.status === 'unmapped' || line.status === 'manual') ? (
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
              ) : line.status === 'ready' ? (
                <span style={{ fontWeight: 600, color: 'var(--success-fg)' }}>
                  {line.qty} × {parts.find(p => p.id === line.sku)?.name || line.sku}
                </span>
              ) : line.status === 'pair-missing' ? (
                <span style={{ color: 'var(--amber)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="alert" size={12} /> {line.reason}</span>
              ) : null}
            </div>
          ))}
          <button type="button" onClick={onAddMaterial}
            style={{ alignSelf: 'flex-start', marginTop: 2, fontSize: 11, fontWeight: 600, color: 'var(--accent-dk)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 0', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="plus" size={12} /> Add material
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────
// Section / MappingRow / StatusBadge / selectStyle / SourceLocationSelect
// + the webhook panels live in ./importShared (shared with
// SonarImportSheet). Only the sheet-specific bits stay here.

// Status vocabulary for the job rows — this sheet's resolver failure
// modes. Rendered by the shared StatusBadge.
const JOB_STATUS_MAP = {
  ready:             { label: 'ready',           color: 'var(--teal-dk)',  bg: 'var(--teal-lt)' },
  'no-crew':         { label: 'no crew',         color: 'var(--amber)',    bg: 'var(--amber-lt)' },
  'no-truck':        { label: 'no truck',        color: 'var(--red)',      bg: 'var(--red-lt)' },
  'no-project':      { label: 'no project',      color: 'var(--amber)',    bg: 'var(--amber-lt)' },
  'project-unmapped':{ label: 'project unmapped',color: 'var(--amber)',    bg: 'var(--amber-lt)' },
  'no-project-bucket':{label: 'no bucket',       color: 'var(--red)',      bg: 'var(--red-lt)' },
  'no-materials':    { label: 'no materials',    color: 'var(--hint)',     bg: 'var(--gray-lt)' },
  'already-imported':{ label: 'already imported',color: 'var(--muted)',    bg: 'var(--gray-lt)' },
}
