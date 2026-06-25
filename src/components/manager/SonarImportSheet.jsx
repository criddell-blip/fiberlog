import { useState, useMemo, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import { crewTypeLabel } from '../../lib/crewTypes'
import {
  recordMovementsBatch,
  getSonarCityMap, setSonarCityBucket,
  getSonarProjectMap, setSonarProjectPhase, getPhasesWithBuckets,
  getSonarSourceLocationMap, setSonarSourceLocation,
  getLocations,
  setPartSonarRouting, SONAR_ROUTING_OPTIONS,
  createPart,
  getPendingSonarImports, getProcessedSonarImports, getPendingSonarImport,
  markSonarPendingImportApplied, discardSonarPendingImport,
} from '../../lib/inventory'
import { parseCsv, readFileAsText } from '../../lib/csvImport'
import BulkSonarProjectsSheet from './BulkSonarProjectsSheet'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Sonar daily-install-report importer (backlog #3).
//
// Each CSV row becomes one `transfer` movement: crew's truck → destination
// "bucket" (project-tied region OR Gigwave/None for wireless). Buckets
// accumulate over time and are cleared on Sage export.
//
// Three mapping layers, each persisted across imports:
//   1. Crew (Sonar source → FiberLog user) — picked per import, not persisted
//   2. Part (Sonar model → FiberLog SKU) + per-part routing policy
//      ('region' | 'gigwave' | 'none' | 'ask'). Routing is saved to
//      parts_catalog.sonar_routing on pick — persists forever.
//   3. City (customer city → bucket location) for `region`-routed parts.
//      Saved to sonar_city_bucket_map on pick — persists forever.
//
// Rows with policy='ask' OR routing='region' but city not yet mapped
// fall to per-row picker in the transactions table.

// Sonar's "Field tech asset Consumption" report (the daily install report
// they wired to the webhook). Newer schema than the old manual export —
// `Address | Full Address` instead of `Address | City`, and a new
// `Project` column tagged at job-creation time. The `Inventory Item ID`
// column is gone; we pull a stable item key out of `Model Field Data |
// Value List` instead.
const REQUIRED_COLS = [
  'Previous Inventory Location',
  'Model | Display Name',
  'Date Time',
  'Current Assignee',
  'Address | Full Address',
  'Account | ID',
]

function extractFirstName(sonarLoc) {
  const m = /\(([^)]+)\)/.exec(sonarLoc || '')
  return m ? m[1].trim() : null
}

// Parse city from a Sonar full-address string. Sonar's format is:
//   "STREET, CITY, STATE ZIP"
//   "STREET, (apt), CITY, STATE ZIP"
// We find the trailing "STATE ZIP" segment (2 letters + 5 digits) and
// take the comma-separated segment immediately before it.
function parseCityFromFullAddress(full) {
  if (!full || typeof full !== 'string') return ''
  const parts = full.split(',').map(s => s.trim()).filter(Boolean)
  // Find the segment matching "XX 12345" (state + zip)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(parts[i])) {
      // The city is the segment immediately before
      if (i > 0) return parts[i - 1]
    }
  }
  // Fallback: second-to-last segment
  if (parts.length >= 2) return parts[parts.length - 2]
  return ''
}

// Extract a stable item identifier from `Model Field Data | Value List`.
// Values are pipe-separated and often duplicated. We take the first
// numeric-looking value (which Sonar uses as the inventory item ID).
// Falls back to an empty string if nothing usable is present.
function extractItemIdFromValueList(valueList) {
  if (!valueList || typeof valueList !== 'string') return ''
  const tokens = valueList.split('|').map(s => s.trim()).filter(Boolean)
  for (const t of tokens) {
    if (/^\d{3,}$/.test(t)) return t  // 3+ digit number = item ID
  }
  return tokens[0] || ''
}

export default function SonarImportSheet({ onClose, onApplied }) {
  const { showToast, currentUser } = useApp()

  // ── Lookups ─────────────────────────────────────────────────────────────
  const [crewUsers, setCrewUsers] = useState([])
  const [trucksByUser, setTrucksByUser] = useState({})
  const [parts, setParts] = useState([])              // [{id, name, unit, sonar_routing}]
  const [buckets, setBuckets] = useState([])          // job_site locations (regions + Gigwave/None)
  const [persistedCityMap, setPersistedCityMap] = useState(() => new Map())  // city UPPER → bucket id
  const [persistedProjectMap, setPersistedProjectMap] = useState(() => new Map())  // project UPPER → phase id
  const [persistedSourceMap, setPersistedSourceMap] = useState(() => new Map())  // sonar_source UPPER → location id (warehouse-type sources only)
  const [phases, setPhases] = useState([])  // [{id, name, project_id, project_name, bucket_id}] — picker source
  const [warehouses, setWarehouses] = useState([])  // warehouse + bin locations for the "map source to warehouse" picker

  // ── CSV state ───────────────────────────────────────────────────────────
  const [fileName, setFileName] = useState('')
  const [csvRows, setCsvRows] = useState(null)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)

  // Back closes the importer (mounted only when open). Confirm once a CSV is
  // loaded so a stray Back doesn't throw away mapping work. The nested
  // BulkSonarProjectsSheet registers its own layer and is closed first.
  useBackClose(1, onClose, {
    confirm: () => csvRows == null || window.confirm('Close the Sonar import? Unsaved mapping will be lost.'),
  })
  // When the CSV came from a pending webhook delivery, remember its id so
  // we can flip status='imported' on successful apply.
  const [activePendingId, setActivePendingId] = useState(null)

  // ── Pending webhook deliveries (Sonar's daily push) ─────────────────────
  const [pendingImports, setPendingImports] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const refreshPending = async () => {
    try {
      const rows = await getPendingSonarImports({ includeProcessed: false, reportType: 'asset_consumption' })
      setPendingImports(rows)
    } catch (e) {
      console.warn('Pending Sonar imports load failed:', e)
    } finally {
      setPendingLoading(false)
    }
  }
  useEffect(() => { refreshPending() }, [])

  // Processed (imported + discarded) — audit trail. Lazy-loaded on toggle
  // so we don't pay the query for managers who only care about pending.
  const [showProcessed, setShowProcessed] = useState(false)
  const [processedImports, setProcessedImports] = useState(null)  // null = not loaded yet
  const [processedLoading, setProcessedLoading] = useState(false)
  async function toggleProcessed() {
    const next = !showProcessed
    setShowProcessed(next)
    if (next && processedImports === null) {
      setProcessedLoading(true)
      try {
        const rows = await getProcessedSonarImports({ limit: 30, reportType: 'asset_consumption' })
        setProcessedImports(rows)
      } catch (e) {
        console.warn('Processed Sonar imports load failed:', e)
        setProcessedImports([])
      } finally {
        setProcessedLoading(false)
      }
    }
  }

  // ── Per-import picks ────────────────────────────────────────────────────
  const [crewMap, setCrewMap] = useState({})          // sonarLoc → user_id
  const [partMap, setPartMap] = useState({})          // sonarModel → part_id
  const [pendingCityMap, setPendingCityMap] = useState({})  // city UPPER → bucket id (manager picks this session)
  const [pendingProjectMap, setPendingProjectMap] = useState({})  // project UPPER → phase id (this session)
  const [pendingSourceMap, setPendingSourceMap] = useState({})    // sonar_source UPPER → location id (this session, mirrors persistedSourceMap)
  // When set, the Part mappings row for this Sonar model renders the
  // inline "create draft" form instead of (well, alongside) the SKU
  // picker. One row at a time — null means none open.
  const [creatingForModel, setCreatingForModel] = useState(null)
  const [pendingPartRouting, setPendingPartRouting] = useState({}) // part_id → policy
  const [rowDest, setRowDest] = useState({})          // row idx → bucket id (per-row override / ask-resolution)
  const [excluded, setExcluded] = useState(() => new Set())

  const [submitting, setSubmitting] = useState(false)
  const [showBulkProjects, setShowBulkProjects] = useState(false)
  // Set of sonar item IDs already imported in past movements — populated
  // by a query when the CSV loads, used to skip re-imports. Covers the
  // "Looker daily report uses a rolling window" case.
  const [alreadyImportedItemIds, setAlreadyImportedItemIds] = useState(() => new Set())

  // Fetch lookups on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [usersRes, trucksRes, partsRes, bucketsRes, cityMap, projectMap, phasesData, sourceMap, allLocations] = await Promise.all([
          db.from('users')
            .select('id, name, role, crew_type')
            .eq('is_active', true)
            .in('role', ['crew', 'contractor'])
            .order('name'),
          db.from('inventory_locations')
            .select('id, assigned_to')
            .eq('type', 'truck')
            .eq('is_active', true)
            .not('assigned_to', 'is', null),
          db.from('parts_catalog')
            .select('id, name, unit, sonar_routing')
            .eq('is_active', true)
            .order('name'),
          db.from('inventory_locations')
            .select('id, name, project_id')
            .eq('type', 'job_site')
            .eq('is_active', true)
            .order('name'),
          getSonarCityMap(),
          getSonarProjectMap(),
          getPhasesWithBuckets(),
          getSonarSourceLocationMap(),
          getLocations({ includeBins: true }),
        ])
        if (cancelled) return
        if (usersRes.error)   throw usersRes.error
        if (trucksRes.error)  throw trucksRes.error
        if (partsRes.error)   throw partsRes.error
        if (bucketsRes.error) throw bucketsRes.error
        setCrewUsers(usersRes.data || [])
        const tbu = {}
        for (const t of trucksRes.data || []) tbu[t.assigned_to] = t.id
        setTrucksByUser(tbu)
        setParts(partsRes.data || [])
        setBuckets(bucketsRes.data || [])
        setPersistedCityMap(cityMap)
        setPersistedProjectMap(projectMap)
        setPhases(phasesData || [])
        setPersistedSourceMap(sourceMap)
        // Warehouses + bins are the eligible targets for source-mapping a
        // non-crew Sonar source. Trucks/job_sites/scrap are excluded —
        // they're handled by other flows (crew picker, project bucket).
        setWarehouses(
          (allLocations || []).filter(l => l.type === 'warehouse' || l.type === 'bin')
        )
      } catch (e) {
        if (!cancelled) setError('Failed to load FiberLog lookups: ' + (e.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Intra-delivery dedup ────────────────────────────────────────────────
  // Looker reports often emit the same install at multiple aggregation
  // levels — same item ID, address, customer, model, time; the only
  // difference is the count of duplicates in the Value List column.
  // Group by sonar item ID and pick the canonical row:
  //   • Prefer non-Warehouse Previous Location (truck → install is the
  //     real consumption event; Warehouse → install is internal stock
  //     movement Looker is just echoing)
  //   • Among same-source-type rows, prefer the longest Value List
  //     (most complete data)
  // Composite key when no item ID is available.
  const dedupedRows = useMemo(() => {
    if (!csvRows) return null
    const groups = new Map()
    csvRows.forEach((row, originalIdx) => {
      const itemId = extractItemIdFromValueList(row['Model Field Data | Value List'] || '')
      const key = itemId
        ? `item:${itemId}`
        : `composite:${row['Account | ID'] || ''}|${row['Date Time'] || ''}|${row['Model | Display Name'] || ''}|${row['Address | Full Address'] || ''}`
      const valueListLen = (row['Model Field Data | Value List'] || '').length
      const prevLoc = (row['Previous Inventory Location'] || '').toUpperCase()
      const isWarehouse = prevLoc === 'WAREHOUSE'
      const entry = { row, originalIdx, valueListLen, isWarehouse, sonarItemId: itemId }
      const existing = groups.get(key)
      if (!existing) {
        groups.set(key, { canonical: entry, dupCount: 1 })
      } else {
        existing.dupCount += 1
        // Replace canonical if this row is "more authoritative":
        //   - non-warehouse beats warehouse (real consumption event)
        //   - longer value list beats shorter (more complete record)
        const isBetter = (!entry.isWarehouse && existing.canonical.isWarehouse) ||
                         (entry.isWarehouse === existing.canonical.isWarehouse && entry.valueListLen > existing.canonical.valueListLen)
        if (isBetter) existing.canonical = entry
      }
    })
    return Array.from(groups.values()).map(g => ({
      row: g.canonical.row,
      originalIdx: g.canonical.originalIdx,
      sonarItemId: g.canonical.sonarItemId,
      dupCount: g.dupCount,
    }))
  }, [csvRows])

  // Query past movements for already-imported sonar item IDs whenever
  // CSV rows change. Last 90 days is a generous re-import window — keeps
  // the query cheap while covering any realistic rolling-report scenario.
  useEffect(() => {
    if (!dedupedRows || dedupedRows.length === 0) {
      setAlreadyImportedItemIds(new Set())
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString()
        const { data, error } = await db
          .from('inventory_movements')
          .select('notes')
          .like('notes', '%[sonar:%')
          .gte('created_at', cutoff)
        if (error) throw error
        if (cancelled) return
        const set = new Set()
        const re = /\[sonar:([^\]]+)\]/g
        for (const m of data || []) {
          let match
          while ((match = re.exec(m.notes || '')) !== null) {
            set.add(match[1].trim())
          }
        }
        setAlreadyImportedItemIds(set)
      } catch (e) {
        console.warn('Sonar already-imported lookup failed:', e)
      }
    })()
    return () => { cancelled = true }
  }, [dedupedRows])

  // ── Unique values extracted from the CSV (over deduped rows) ───────────
  const uniqueSonarLocs = useMemo(() => {
    if (!dedupedRows) return []
    return [...new Set(dedupedRows.map(d => d.row['Previous Inventory Location'] || '').filter(Boolean))]
  }, [dedupedRows])
  const uniqueSonarModels = useMemo(() => {
    if (!dedupedRows) return []
    return [...new Set(dedupedRows.map(d => d.row['Model | Display Name'] || '').filter(Boolean))]
  }, [dedupedRows])
  const uniqueCities = useMemo(() => {
    if (!dedupedRows) return []
    return [...new Set(
      dedupedRows.map(d => parseCityFromFullAddress(d.row['Address | Full Address'] || '')).filter(Boolean)
    )]
  }, [dedupedRows])
  const uniqueProjects = useMemo(() => {
    if (!dedupedRows) return []
    return [...new Set(dedupedRows.map(d => (d.row['Project'] || '').trim()).filter(Boolean))]
  }, [dedupedRows])

  // ── Auto-match crew + part on CSV load ──────────────────────────────────
  useEffect(() => {
    if (!csvRows || crewUsers.length === 0) return
    const auto = {}
    for (const loc of uniqueSonarLocs) {
      const first = extractFirstName(loc)?.toLowerCase()
      if (!first) continue
      const u = crewUsers.find(u => u.name.toLowerCase().split(' ')[0] === first)
      if (u) auto[loc] = u.id
    }
    setCrewMap(prev => ({ ...auto, ...prev }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueSonarLocs, crewUsers])

  useEffect(() => {
    if (!csvRows || parts.length === 0) return
    const auto = {}
    for (const model of uniqueSonarModels) {
      const ml = model.toLowerCase().trim()
      if (!ml) continue
      const exact = parts.find(p => (p.name || '').toLowerCase() === ml)
      if (exact) { auto[model] = exact.id; continue }
      const sub = parts.find(p => {
        const pn = (p.name || '').toLowerCase()
        return pn.includes(ml) || ml.includes(pn)
      })
      if (sub) auto[model] = sub.id
    }
    setPartMap(prev => ({ ...auto, ...prev }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueSonarModels, parts])

  // Auto-seed city → bucket when city name matches a region/project bucket name
  useEffect(() => {
    if (!csvRows || buckets.length === 0) return
    const auto = {}
    for (const city of uniqueCities) {
      const uc = city.toUpperCase()
      if (persistedCityMap.has(uc) || pendingCityMap[uc]) continue
      const match = buckets.find(b => (b.name || '').toUpperCase() === uc)
      if (match) auto[uc] = match.id
    }
    if (Object.keys(auto).length > 0) {
      setPendingCityMap(prev => ({ ...auto, ...prev }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueCities, buckets, persistedCityMap])

  // Auto-seed Sonar project → phase when names match. After you add
  // Center Creek / Cold Springs / etc as phases under Heber / Park City,
  // their names will match the Sonar Project values directly — this
  // catches them on first import so the manager only confirms.
  useEffect(() => {
    if (!csvRows || phases.length === 0) return
    const auto = {}
    for (const proj of uniqueProjects) {
      const up = proj.toUpperCase()
      if (persistedProjectMap.has(up) || pendingProjectMap[up]) continue
      // Exact match on phase name first
      let match = phases.find(p => (p.name || '').toUpperCase() === up)
      // Then contains-either-way (handles "West Mountain Fiber" ↔ "West Mountain")
      if (!match) match = phases.find(p => {
        const pn = (p.name || '').toUpperCase()
        return pn && (pn.includes(up) || up.includes(pn))
      })
      if (match) auto[up] = match.id
    }
    if (Object.keys(auto).length > 0) {
      setPendingProjectMap(prev => ({ ...auto, ...prev }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueProjects, phases, persistedProjectMap])

  // ── Handlers for picker changes (some live-save to DB) ──────────────────
  async function handlePartRoutingChange(partId, newPolicy) {
    if (!partId) return
    setPendingPartRouting(prev => ({ ...prev, [partId]: newPolicy }))
    try {
      await setPartSonarRouting(partId, newPolicy)
      // Also update local parts list so the picker reflects the new value
      setParts(prev => prev.map(p => p.id === partId ? { ...p, sonar_routing: newPolicy } : p))
    } catch (e) {
      setError(`Failed to save routing for ${partId}: ${e.message}`)
    }
  }

  async function handleProjectPhaseChange(project, phaseId) {
    const up = project.toUpperCase()
    setPendingProjectMap(prev => ({ ...prev, [up]: phaseId }))
    if (!phaseId) return
    try {
      await setSonarProjectPhase(project, phaseId)
      setPersistedProjectMap(prev => {
        const next = new Map(prev)
        next.set(up, phaseId)
        return next
      })
    } catch (e) {
      setError(`Failed to save project mapping for ${project}: ${e.message}`)
    }
  }

  // When the manager picks a warehouse for a non-crew Sonar source string
  // ("Warehouse" → Main Warehouse), persist the mapping AND clear the crew
  // pick for that source — the row's source is no longer a person, so we
  // shouldn't try to look up a truck for it.
  async function handleSourceLocationChange(sonarSource, locationId) {
    const up = sonarSource.toUpperCase()
    setPendingSourceMap(prev => ({ ...prev, [up]: locationId }))
    // Clear the crew pick for this source so the resolver doesn't see a
    // ghost user mapping fighting the warehouse one.
    setCrewMap(prev => {
      const next = { ...prev }
      delete next[sonarSource]
      return next
    })
    if (!locationId) return
    try {
      await setSonarSourceLocation(sonarSource, locationId)
      setPersistedSourceMap(prev => {
        const next = new Map(prev)
        next.set(up, locationId)
        return next
      })
    } catch (e) {
      setError(`Failed to save source mapping for ${sonarSource}: ${e.message}`)
    }
  }

  async function handleCityBucketChange(city, bucketId) {
    const uc = city.toUpperCase()
    setPendingCityMap(prev => ({ ...prev, [uc]: bucketId }))
    if (!bucketId) return  // empty = clear (not persisted to DB; if you want to clear use clearSonarCityBucket)
    try {
      await setSonarCityBucket(city, bucketId)
      setPersistedCityMap(prev => {
        const next = new Map(prev)
        next.set(uc, bucketId)
        return next
      })
    } catch (e) {
      setError(`Failed to save city mapping for ${city}: ${e.message}`)
    }
  }

  // ── File upload + parse ─────────────────────────────────────────────────
  async function handleFile(file) {
    if (!file) return
    setError(''); setParsing(true)
    setFileName(file.name)
    setActivePendingId(null)  // manual upload wipes any prior pending-id linkage
    try {
      const text = await readFileAsText(file)
      loadCsvText(text)
    } catch (e) {
      console.error('Sonar parse failed:', e)
      setError(e.message || String(e))
      setCsvRows([])
    } finally {
      setParsing(false)
    }
  }

  // Shared parse path — used by both file upload and pending-import load.
  // Validates required columns + resets per-import picks.
  function loadCsvText(text) {
    const { headers, rows } = parseCsv(text)
    if (rows.length === 0) {
      setError('CSV had no data rows')
      setCsvRows([])
      return
    }
    const missing = REQUIRED_COLS.filter(c => !headers.includes(c))
    if (missing.length > 0) {
      setError(`CSV is missing required Sonar columns: ${missing.join(', ')}`)
      setCsvRows([])
      return
    }
    setCsvRows(rows)
    setExcluded(new Set())
    setCrewMap({})
    setPartMap({})
    setPendingCityMap({})
    setRowDest({})
  }

  // Load a pending webhook delivery into the existing parse flow as if
  // the manager had just uploaded its CSV manually. The activePendingId
  // is held until apply (or until the user uploads a different file or
  // discards the pending row).
  async function loadPending(pending) {
    setError(''); setParsing(true)
    try {
      const full = await getPendingSonarImport(pending.id)
      setActivePendingId(pending.id)
      const label = full.filename || `pending ${new Date(full.received_at).toLocaleString()}`
      setFileName(`[webhook] ${label}`)
      loadCsvText(full.raw_csv || '')
    } catch (e) {
      console.error('Load pending Sonar import failed:', e)
      setError(`Could not load pending import: ${e.message || e}`)
    } finally {
      setParsing(false)
    }
  }

  async function handleDiscardPending(pending) {
    const reason = window.prompt(
      `Discard this pending Sonar import (${pending.parsed_row_count} rows from ${new Date(pending.received_at).toLocaleString()})? It will stay in the audit log but not be importable.`,
      'Test fire / duplicate / not needed'
    )
    if (reason === null) return  // cancelled
    try {
      await discardSonarPendingImport(pending.id, { reason: reason || 'Discarded', userId: currentUser?.id })
      // If we're currently editing this one, clear the working state
      if (activePendingId === pending.id) {
        setActivePendingId(null)
        setCsvRows(null)
        setFileName('')
      }
      await refreshPending()
      showToast('Pending import discarded')
    } catch (e) {
      console.error('Discard failed:', e)
      setError(`Discard failed: ${e.message || e}`)
    }
  }

  // ── Per-row resolution ──────────────────────────────────────────────────
  // The merged city map: persisted + this-session pending picks
  const effectiveCityMap = useMemo(() => {
    const merged = new Map(persistedCityMap)
    for (const [k, v] of Object.entries(pendingCityMap)) {
      if (v) merged.set(k, v)
      else merged.delete(k)
    }
    return merged
  }, [persistedCityMap, pendingCityMap])

  const effectiveProjectMap = useMemo(() => {
    const merged = new Map(persistedProjectMap)
    for (const [k, v] of Object.entries(pendingProjectMap)) {
      if (v) merged.set(k, v)
      else merged.delete(k)
    }
    return merged
  }, [persistedProjectMap, pendingProjectMap])

  // Sonar source string → FiberLog location id (warehouse/bin). When a
  // source has a mapping here, the resolver uses that location as the
  // from_location_id and skips the crew/truck lookup entirely.
  const effectiveSourceMap = useMemo(() => {
    const merged = new Map(persistedSourceMap)
    for (const [k, v] of Object.entries(pendingSourceMap)) {
      if (v) merged.set(k, v)
      else merged.delete(k)
    }
    return merged
  }, [persistedSourceMap, pendingSourceMap])

  function getPartRouting(partId) {
    if (pendingPartRouting[partId]) return pendingPartRouting[partId]
    const p = parts.find(p => p.id === partId)
    return p?.sonar_routing || 'ask'
  }

  const resolved = useMemo(() => {
    if (!dedupedRows) return []
    return dedupedRows.map((entry, idx) => {
      const row = entry.row
      const sonarLoc = row['Previous Inventory Location'] || ''
      const sonarModel = row['Model | Display Name'] || ''
      const fullAddress = row['Address | Full Address'] || ''
      const city = parseCityFromFullAddress(fullAddress)
      const sonarProject = (row['Project'] || '').trim()
      // Resolve the source. Priority 1: warehouse-source map (covers
      // "Warehouse" and friends). Priority 2: crew → truck. When the
      // warehouse path wins, userId stays null (consumed_by_user_id
      // becomes NULL on the resulting movement — accurate "we don't
      // know which crew did the pull").
      const sourceLocationId = effectiveSourceMap.get(sonarLoc.toUpperCase()) || null
      const sourceIsWarehouse = !!sourceLocationId
      const userId = sourceIsWarehouse ? null : (crewMap[sonarLoc] || null)
      const truckId = userId ? trucksByUser[userId] : null
      const fromLocationId = sourceLocationId || truckId || null
      const partId = partMap[sonarModel] || null
      const userName = userId ? crewUsers.find(u => u.id === userId)?.name || '' : ''
      const partName = partId ? parts.find(p => p.id === partId)?.name || '' : ''
      const routing = partId ? getPartRouting(partId) : null
      // Item ID for the dedup marker: first numeric value from the
      // pipe-separated Value List, falling back to Account|ID + Date.
      const itemFromValueList = entry.sonarItemId  // already extracted during dedup
      const accountId = (row['Account | ID'] || '').trim()
      const sonarItemId = itemFromValueList || (accountId && row['Date Time'] ? `${accountId}-${row['Date Time']}` : '')
      const isAlreadyImported = itemFromValueList && alreadyImportedItemIds.has(itemFromValueList)

      // Determine destination
      let destId = null
      let destReason = null  // human-readable explanation
      let status = 'ready'

      // Already imported in a prior delivery — skip by default. Manager
      // can still re-include via the per-row pick if there's a reason
      // (e.g., the prior import was for a different reason).
      if (isAlreadyImported) {
        status = 'already-imported'
      }
      // Per-row override always wins
      else if (rowDest[idx]) {
        destId = rowDest[idx]
        destReason = 'manual pick'
      } else if (!fromLocationId) {
        // No source identified — either an unmatched crew name OR an
        // unfamiliar non-crew source string (e.g. "Receiving") that
        // hasn't been mapped to a warehouse yet.
        status = sourceIsWarehouse ? 'no-source-location' : 'no-crew'
      } else if (!sourceIsWarehouse && !truckId) {
        // Crew was matched but they have no truck assigned.
        status = 'no-truck'
      } else if (!partId) {
        status = 'no-part'
      } else if (sonarProject) {
        // Sonar tagged the project → look up phase. Authoritative when
        // mapped. Bucket is derived from the phase's parent project
        // (so materials still land in the regional bucket, but each
        // movement is tagged with phase_id for Sage cost-center rollups).
        const phaseId = effectiveProjectMap.get(sonarProject.toUpperCase())
        const phase = phaseId ? phases.find(p => p.id === phaseId) : null
        if (phase && phase.bucket_id) {
          destId = phase.bucket_id
          destReason = `Sonar project: ${sonarProject} → ${phase.project_name} / ${phase.name}`
        } else if (phase && !phase.bucket_id) {
          status = 'no-project-bucket'  // phase's project has no job_site bucket yet
        } else {
          status = 'project-unmapped'
        }
      } else {
        switch (routing) {
          case 'gigwave': {
            const b = buckets.find(b => b.name === 'Gigwave')
            if (b) { destId = b.id; destReason = 'policy: gigwave' }
            else status = 'no-gigwave-bucket'
            break
          }
          case 'none': {
            const b = buckets.find(b => b.name === 'None')
            if (b) { destId = b.id; destReason = 'policy: none' }
            else status = 'no-none-bucket'
            break
          }
          case 'region': {
            if (!city) status = 'no-city'
            else {
              const bucketId = effectiveCityMap.get(city.toUpperCase())
              if (bucketId) { destId = bucketId; destReason = `city: ${city}` }
              else status = 'city-unmapped'
            }
            break
          }
          case 'ask':
          default:
            status = 'ask'
            break
        }
      }
      if (status === 'ready' && !destId) status = 'unresolved'

      const destBucket = destId ? buckets.find(b => b.id === destId) : null
      // Phase tag follows the resolved phase (when project-routing path
      // was taken); falls back to the phase mapped to the project the
      // manual override picked, or NULL.
      let phaseTagId = null
      if (sonarProject) {
        phaseTagId = effectiveProjectMap.get(sonarProject.toUpperCase()) || null
      }
      return {
        idx,
        date: row['Date Time'] || '',
        customer: row['Current Assignee'] || '',
        city,
        sonarProject,
        sonarLoc, sonarModel,
        sonarItemId,
        userId, truckId, userName,
        sourceLocationId,
        sourceIsWarehouse,
        fromLocationId,
        partId, partName,
        routing,
        destId,
        destName: destBucket?.name || null,
        destReason,
        phaseTagId,
        dupCount: entry.dupCount,
        isAlreadyImported,
        status,
      }
    })
  }, [dedupedRows, crewMap, partMap, trucksByUser, crewUsers, parts, buckets, phases, effectiveCityMap, effectiveProjectMap, effectiveSourceMap, rowDest, pendingPartRouting, alreadyImportedItemIds])

  const stats = useMemo(() => {
    if (resolved.length === 0) return null
    let ready = 0, blocked = 0, excludedCount = 0, alreadyImported = 0
    const blockReasons = {}
    for (const r of resolved) {
      if (excluded.has(r.idx)) { excludedCount++; continue }
      if (r.status === 'already-imported') { alreadyImported++; continue }
      if (r.status === 'ready') ready++
      else {
        blocked++
        blockReasons[r.status] = (blockReasons[r.status] || 0) + 1
      }
    }
    const csvRowCount = csvRows?.length || 0
    const dedupCollapsed = csvRowCount - resolved.length
    return { total: resolved.length, ready, blocked, blockReasons, excludedCount, alreadyImported, csvRowCount, dedupCollapsed }
  }, [resolved, excluded, csvRows])

  // Which cities surface in the City mapping section: any city that:
  //   - is referenced by a row whose part routes 'region', AND
  //   - isn't yet in the effective city map
  const citiesNeedingMap = useMemo(() => {
    if (!csvRows) return []
    const seen = new Set()
    const result = []
    for (const r of resolved) {
      if (r.status !== 'city-unmapped') continue
      const uc = r.city.toUpperCase()
      if (seen.has(uc)) continue
      seen.add(uc)
      result.push(r.city)
    }
    return result
  }, [resolved, csvRows])

  // Mirror for unmapped Sonar projects — manager picks bucket per project,
  // mapping persists for future imports.
  const projectsNeedingMap = useMemo(() => {
    if (!csvRows) return []
    const seen = new Set()
    const result = []
    for (const r of resolved) {
      if (r.status !== 'project-unmapped') continue
      const up = r.sonarProject.toUpperCase()
      if (seen.has(up)) continue
      seen.add(up)
      result.push(r.sonarProject)
    }
    return result
  }, [resolved, csvRows])

  // Region-eligible buckets for city picker (project-tied job_sites)
  const regionBuckets = useMemo(() => buckets.filter(b => b.project_id != null), [buckets])

  function toggleExclude(idx) {
    setExcluded(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  function setRowDestination(idx, bucketId) {
    setRowDest(prev => ({ ...prev, [idx]: bucketId || null }))
  }

  async function handleApply() {
    setError('')
    setSubmitting(true)
    try {
      const movements = resolved
        .filter(r => !excluded.has(r.idx) && r.status === 'ready' && r.destId && r.fromLocationId)
        .map(r => {
          const dateStr = String(r.date).slice(0, 16)
          const noteParts = [
            'Sonar install',
            dateStr,
            r.customer,
            r.city,
            r.sourceIsWarehouse && `source: ${r.sonarLoc}`,
            r.destReason,
            r.sonarItemId && `[sonar:${r.sonarItemId}]`,
          ].filter(Boolean)
          return {
            movement_type: 'transfer',
            part_id: r.partId,
            quantity: 1,
            unit: 'ea',
            from_location_id: r.fromLocationId,
            to_location_id: r.destId,
            notes: noteParts.join(' · '),
            created_by: currentUser?.id,
            phase_id: r.phaseTagId || null,
            // NULL for warehouse-source rows — no crew to attribute the pull to.
            consumed_by_user_id: r.userId || null,
          }
        })
      if (movements.length === 0) {
        setError('Nothing ready to apply')
        return
      }
      await recordMovementsBatch(movements)
      // If this CSV came from a webhook delivery, mark it imported so it
      // drops out of the pending queue. Non-fatal if it fails (movements
      // are already written) — just log so we can clean up manually.
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
      onApplied(movements.length)
    } catch (e) {
      console.error('Sonar apply failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 1000, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 17, marginBottom: 2 }}>
          <Icon name="zap" size={18} /> Sonar daily install import
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Each install row becomes one <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>transfer</code> movement from the crew's truck → a FiberLog bucket. Routing priority: <strong>Sonar Project column</strong> (when set, authoritative) → part-level policy (region/gigwave/none). Buckets accumulate until Sage export drains them.
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
            {csvRows ? 'Choose a different file' : 'Choose Sonar CSV'}
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
          {!fileName && <div style={{ flex: 1 }} />}
          <button
            onClick={() => setShowBulkProjects(true)}
            className="btn btn-ghost"
            style={{ padding: '6px 12px', fontSize: 12, flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title="Bulk-add Sonar projects as phases under FiberLog regions"
          >
            <Icon name="box" size={14} /> Bulk-add projects
          </button>
        </div>

        {/* Pending webhook deliveries — Sonar's daily push lands here */}
        {!pendingLoading && pendingImports.length > 0 && (
          <div style={{
            marginBottom: 12, padding: 10,
            border: '1px solid var(--accent-border)',
            background: 'var(--accent-bg)',
            borderRadius: 'var(--r-sm)',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12, fontWeight: 800, color: 'var(--accent-fg)',
              textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
            }}>
              <Icon name="download" size={14} /> Auto-delivered from Sonar ({pendingImports.length})
            </div>
            {/* Scroll the list itself, not the whole sheet — a long backlog
                otherwise buries the part-mapping section below the fold. */}
            <div style={{ maxHeight: 240, overflowY: 'auto', paddingRight: 2 }}>
            {pendingImports.map(p => {
              const isActive = activePendingId === p.id
              return (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 8px', marginBottom: 4,
                  background: isActive ? 'var(--orange)' : 'var(--surface)',
                  color: isActive ? '#fff' : 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
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
                      display: 'inline-flex', alignItems: 'center',
                      padding: '5px 8px', fontSize: 11,
                      background: 'transparent',
                      color: isActive ? 'rgba(255,255,255,0.8)' : 'var(--muted)',
                      border: 'none', cursor: 'pointer',
                    }}
                    title="Discard this delivery"
                    disabled={parsing || submitting}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
              )
            })}
            </div>
          </div>
        )}

        {/* Processed deliveries (imported + discarded) — audit panel.
            Always-available toggle so the manager can audit even when
            nothing's pending. */}
        {!pendingLoading && (
          <div style={{ marginBottom: 12 }}>
            <button
              onClick={toggleProcessed}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 12,
                padding: '4px 0', textDecoration: 'underline',
              }}
            >
              <Icon name={showProcessed ? 'chevron-down' : 'chevron-right'} size={13} />
              {showProcessed ? 'Hide' : 'Show'} recent webhook deliveries (audit)
            </button>
            {showProcessed && (
              <div style={{
                marginTop: 6, padding: 8,
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
              }}>
                {processedLoading && (
                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                    Loading…
                  </div>
                )}
                {!processedLoading && processedImports && processedImports.length === 0 && (
                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--hint)', fontSize: 12 }}>
                    No processed deliveries yet. Once you import or discard a Sonar webhook delivery, it'll show up here.
                  </div>
                )}
                {!processedLoading && processedImports && processedImports.length > 0 && (
                  <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {processedImports.map(p => {
                      const isImported = p.status === 'imported'
                      const isAutoDiscard = p.discard_reason?.startsWith('Auto-discarded')
                      return (
                        <div key={p.id} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '5px 6px', marginBottom: 2,
                          fontSize: 11,
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <span
                            className={isImported ? 'pill pill-success pill-sm' : isAutoDiscard ? 'pill pill-danger pill-sm' : 'pill pill-muted pill-sm'}
                            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                          >
                            {isImported
                              ? <><Icon name="check" size={12} /> imported</>
                              : isAutoDiscard
                                ? <><Icon name="alert" size={12} /> auto-discarded</>
                                : 'discarded'}
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
                                ? `applied ${p.applied_movement_count || 0} movement${p.applied_movement_count === 1 ? '' : 's'}${p.applied_at ? ` at ${new Date(p.applied_at).toLocaleString()}` : ''}`
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
          </div>
        )}

        {parsing && <div style={{ padding: 16, color: 'var(--muted)', textAlign: 'center' }}>Parsing…</div>}

        {error && (
          <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

          {/* Crew mappings */}
          {uniqueSonarLocs.length > 0 && (
            <Section title="Source mappings" accent="var(--teal)"
              subtitle="One pick per Sonar source. Crews auto-match by name in parens. Non-crew sources (e.g. 'Warehouse') map to a FiberLog warehouse — that pick persists across imports.">
              {uniqueSonarLocs.map(loc => {
                const sourceLocId = effectiveSourceMap.get(loc.toUpperCase())
                const sourceLocName = sourceLocId
                  ? (warehouses.find(w => w.id === sourceLocId)?.name || null)
                  : null
                const userId = sourceLocId ? null : crewMap[loc]
                const hasTruck = userId ? !!trucksByUser[userId] : false
                const status = sourceLocId
                  ? { tag: `warehouse${sourceLocName ? `: ${sourceLocName}` : ''}`, color: 'var(--teal-dk)' }
                  : !userId ? { tag: 'unmatched', color: 'var(--amber)' }
                  : !hasTruck ? { tag: 'no truck', color: 'var(--red)' }
                  : { tag: 'matched', color: 'var(--teal-dk)' }
                const n = resolved.filter(r => r.sonarLoc === loc).length
                return (
                  <MappingRow key={loc}
                    primary={loc}
                    secondary={`${n} row${n === 1 ? '' : 's'}`}
                    status={status}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <select
                        value={userId || ''}
                        onChange={e => {
                          // Crew pick clears the warehouse mapping for this
                          // source (mutually exclusive — a source is EITHER
                          // a crew OR a warehouse, not both).
                          const v = e.target.value
                          setCrewMap(prev => ({ ...prev, [loc]: v }))
                          if (v) handleSourceLocationChange(loc, null)
                        }}
                        style={selectStyle()}
                        disabled={!!sourceLocId}
                      >
                        <option value="">— pick crew —</option>
                        {crewUsers.map(u => (
                          <option key={u.id} value={u.id}>
                            {u.name}{u.crew_type ? ` (${crewTypeLabel(u.crew_type)})` : ''}{trucksByUser[u.id] ? '' : ' — no truck!'}
                          </option>
                        ))}
                      </select>
                      <select
                        value={sourceLocId || ''}
                        onChange={e => handleSourceLocationChange(loc, e.target.value || null)}
                        style={{ ...selectStyle(), fontSize: 11, color: 'var(--muted)' }}
                      >
                        <option value="">…or map to a warehouse (persists)</option>
                        {warehouses.map(w => (
                          <option key={w.id} value={w.id}>
                            🏭 {w.name}{w.type === 'bin' ? ' (bin)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </MappingRow>
                )
              })}
            </Section>
          )}

          {/* Part mappings — with routing policy picker per part */}
          {uniqueSonarModels.length > 0 && (
            <Section title="Part mappings + routing" accent="var(--orange)"
              subtitle="Pick the FiberLog SKU AND a routing policy per Sonar model. No matching SKU? Create a draft inline — manager polishes metadata later.">
              {uniqueSonarModels.map(model => {
                const partId = partMap[model]
                const routing = partId ? getPartRouting(partId) : null
                const n = resolved.filter(r => r.sonarModel === model).length
                // When the mapped SKU is a draft (is_active=false), surface
                // it on the status pill so the manager remembers to clean
                // up metadata in Parts admin afterward.
                const pickedPart = partId ? parts.find(p => p.id === partId) : null
                const isDraft = pickedPart && pickedPart.is_active === false
                const status = !partId ? { tag: 'unmatched', color: 'var(--amber)' }
                  : routing === 'ask' ? { tag: `asks per row${isDraft ? ' (draft)' : ''}`, color: 'var(--amber)' }
                  : { tag: `${routing}${isDraft ? ' (draft)' : ''}`, color: 'var(--orange-dk)' }
                const isOpen = creatingForModel === model
                return (
                  <div key={model} style={{
                    marginBottom: 4, padding: '4px 6px',
                    background: 'var(--surface2)', borderRadius: 6,
                  }}>
                    <div style={{
                      display: 'grid', gridTemplateColumns: '2fr 2fr 2fr auto', gap: 6,
                      alignItems: 'center',
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model}</div>
                        <div style={{ fontSize: 10, color: 'var(--hint)' }}>{n} row{n === 1 ? '' : 's'}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <select
                          value={partId || ''}
                          onChange={e => setPartMap(prev => ({ ...prev, [model]: e.target.value }))}
                          style={selectStyle()}
                        >
                          <option value="">— pick part —</option>
                          {parts.map(p => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.id}){p.is_active === false ? ' — draft' : ''}
                            </option>
                          ))}
                        </select>
                        {!partId && !isOpen && (
                          <button
                            type="button"
                            onClick={() => setCreatingForModel(model)}
                            style={{
                              fontSize: 10, padding: '2px 6px', background: 'transparent',
                              color: 'var(--orange)', border: '1px dashed var(--orange-dk)',
                              borderRadius: 4, cursor: 'pointer', alignSelf: 'flex-start',
                            }}
                            title="Create a draft FiberLog SKU for this Sonar model. Manager cleans up metadata in Parts admin afterward."
                          >
                            + Create draft
                          </button>
                        )}
                      </div>
                      <select
                        value={routing || ''}
                        onChange={e => handlePartRoutingChange(partId, e.target.value)}
                        disabled={!partId}
                        title={partId ? 'Routing policy for this part (saved to parts_catalog)' : 'Pick a part first'}
                        style={selectStyle()}
                      >
                        <option value="">— policy —</option>
                        {SONAR_ROUTING_OPTIONS.map(o => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                      <div style={statusBadgeStyle(status.color)}>{status.tag}</div>
                    </div>
                    {isOpen && (
                      <CreatePartPanel
                        sonarModel={model}
                        onCancel={() => setCreatingForModel(null)}
                        onCreated={(newPart) => {
                          // Append + auto-pick. Local-only; the next sheet
                          // open will fetch fresh from the catalog.
                          setParts(prev => [...prev, newPart].sort((a, b) =>
                            (a.name || '').localeCompare(b.name || '')))
                          setPartMap(prev => ({ ...prev, [model]: newPart.id }))
                          setCreatingForModel(null)
                          showToast(`Draft part created: ${newPart.name} (${newPart.id})`)
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </Section>
          )}

          {/* Project mappings — Sonar's Project column → FiberLog phase.
              The phase determines both the destination bucket (via its
              parent project) AND the phase_id tag stamped on the movement
              for Sage cost-center grouping. Mappings persist to
              sonar_project_phase_map for future imports. */}
          {projectsNeedingMap.length > 0 && (
            <Section title="Sonar project mappings" accent="var(--purple)"
              subtitle="Pick a phase under the appropriate region once per Sonar project. The phase determines both the destination bucket AND the cost-center tag for Sage export. Saved for every future import.">
              {projectsNeedingMap.map(project => {
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
                          {p.project_name} / {p.name}
                          {!p.bucket_id ? ' (no bucket)' : ''}
                        </option>
                      ))}
                    </select>
                  </MappingRow>
                )
              })}
            </Section>
          )}

          {/* City mappings — only shown if any 'region'-routed rows have unmapped cities */}
          {citiesNeedingMap.length > 0 && (
            <Section title="City mappings" accent="var(--blue)"
              subtitle="Some rows route by city. Pick a region bucket per city — saved to sonar_city_bucket_map for future imports.">
              {citiesNeedingMap.map(city => {
                const uc = city.toUpperCase()
                const picked = effectiveCityMap.get(uc) || ''
                const status = picked
                  ? { tag: 'mapped', color: 'var(--blue)' }
                  : { tag: 'needs mapping', color: 'var(--amber)' }
                return (
                  <MappingRow key={city} primary={city} secondary={resolved.filter(r => r.city.toUpperCase() === uc).length + ' rows'} status={status}>
                    <select
                      value={picked}
                      onChange={e => handleCityBucketChange(city, e.target.value)}
                      style={selectStyle()}
                    >
                      <option value="">— pick region —</option>
                      {regionBuckets.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </MappingRow>
                )
              })}
            </Section>
          )}

          {/* Transactions preview */}
          {resolved.length > 0 && (
            <>
              <div style={{
                fontSize: 12, fontWeight: 700, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '.04em',
                marginTop: 16, marginBottom: 6,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>Transactions</span>
                {stats && (
                  <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--hint)' }}>
                    {stats.dedupCollapsed > 0 && (
                      <>{stats.csvRowCount} CSV rows → {stats.total} unique installs · </>
                    )}
                    {stats.ready} ready · {stats.blocked} blocked
                    {stats.alreadyImported > 0 && <> · {stats.alreadyImported} already imported</>}
                    {stats.excludedCount > 0 && <> · {stats.excludedCount} excluded</>}
                  </span>
                )}
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: 'var(--surface2)' }}>
                    <tr>
                      <th style={thStyle({ width: 32 })}>
                        <span style={{ display: 'inline-flex' }}><Icon name="check" size={13} /></span>
                      </th>
                      <th style={thStyle({ textAlign: 'left' })}>Date</th>
                      <th style={thStyle({ textAlign: 'left' })}>Customer / City</th>
                      <th style={thStyle({ textAlign: 'left' })}>Part</th>
                      <th style={thStyle({ textAlign: 'left' })}>Crew</th>
                      <th style={thStyle({ textAlign: 'left' })}>Destination</th>
                      <th style={thStyle({ textAlign: 'left' })}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.map(r => {
                      const isExcluded = excluded.has(r.idx)
                      const isReady = r.status === 'ready'
                      const needsPicker = r.status === 'ask' || r.status === 'city-unmapped' || r.status === 'project-unmapped' || r.status === 'unresolved'
                      return (
                        <tr key={r.idx} style={{
                          background: isExcluded
                            ? 'var(--gray-lt)'
                            : isReady ? 'transparent' : 'var(--amber-lt)',
                          opacity: isExcluded ? 0.45 : 1,
                        }}>
                          <td style={tdStyle({ textAlign: 'center' })}>
                            {isReady && (
                              <input
                                type="checkbox"
                                checked={!isExcluded}
                                onChange={() => toggleExclude(r.idx)}
                              />
                            )}
                          </td>
                          <td style={tdStyle()}>{String(r.date).slice(0, 16)}</td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>
                              {r.customer}
                              {r.dupCount > 1 && (
                                <span style={{
                                  marginLeft: 6, fontSize: 10, color: 'var(--muted)',
                                  background: 'var(--gray-lt)', padding: '1px 5px',
                                  borderRadius: 'var(--r-xs)', fontWeight: 'var(--fw-semibold)',
                                }} title={`Collapsed ${r.dupCount} duplicate rows`}>
                                  × {r.dupCount}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--hint)' }}>{r.city}</div>
                          </td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>{r.partName || <em style={{ color: 'var(--amber)' }}>{r.sonarModel}</em>}</div>
                            {r.partId && (
                              <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                                {r.partId}{r.routing ? ` · ${r.routing}` : ''}
                              </div>
                            )}
                          </td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>
                              {r.sourceIsWarehouse
                                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--teal-mid)' }}><Icon name="warehouse" size={13} /> {r.sonarLoc}</span>
                                : (r.userName || <em style={{ color: 'var(--amber)' }}>{r.sonarLoc}</em>)
                              }
                            </div>
                          </td>
                          <td style={tdStyle()}>
                            {needsPicker ? (
                              <select
                                value={rowDest[r.idx] || ''}
                                onChange={e => setRowDestination(r.idx, e.target.value)}
                                style={{ ...selectStyle(), minWidth: 140 }}
                              >
                                <option value="">— pick bucket —</option>
                                {buckets.map(b => (
                                  <option key={b.id} value={b.id}>{b.name}</option>
                                ))}
                              </select>
                            ) : r.destName ? (
                              <div>
                                <div style={{ fontWeight: 600 }}>{r.destName}</div>
                                {r.destReason && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{r.destReason}</div>}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--hint)' }}>—</span>
                            )}
                          </td>
                          <td style={tdStyle()}>
                            <StatusBadge status={r.status} />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
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
            disabled={submitting || !stats || stats.ready === 0}
          >
            {submitting
              ? 'Applying…'
              : stats && stats.ready > 0
                ? `Apply ${stats.ready} transfer${stats.ready === 1 ? '' : 's'}`
                : 'Nothing to apply'}
          </button>
        </div>
      </div>

      {showBulkProjects && (
        <BulkSonarProjectsSheet
          onClose={() => setShowBulkProjects(false)}
          onDone={async () => {
            // Refresh phases + project map after bulk-create so the rest
            // of this sheet's project mapping section picks them up.
            try {
              const [phasesData, projectMap] = await Promise.all([
                getPhasesWithBuckets(),
                getSonarProjectMap(),
              ])
              setPhases(phasesData || [])
              setPersistedProjectMap(projectMap)
            } catch (e) {
              console.warn('Refresh after bulk-add failed:', e)
            }
          }}
        />
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
      <div style={{
        fontSize: 12, fontWeight: 800, color: accent,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2,
      }}>{title}</div>
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

function StatusBadge({ status }) {
  const map = {
    ready:            { label: 'ready',           color: 'var(--teal-dk)',  bg: 'var(--teal-lt)' },
    'no-crew':        { label: 'no crew',         color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'no-truck':       { label: 'no truck',        color: 'var(--red)',      bg: 'var(--red-lt)' },
    'no-part':        { label: 'no part',         color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'ask':            { label: 'ask: pick dest',  color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'no-city':        { label: 'no city',         color: 'var(--red)',      bg: 'var(--red-lt)' },
    'city-unmapped':  { label: 'city unmapped',   color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'project-unmapped': { label: 'project unmapped', color: 'var(--amber)', bg: 'var(--amber-lt)' },
    'no-project-bucket': { label: 'phase has no bucket', color: 'var(--red)', bg: 'var(--red-lt)' },
    'no-source-location': { label: 'no source location', color: 'var(--amber)', bg: 'var(--amber-lt)' },
    'already-imported': { label: 'already imported', color: 'var(--muted)', bg: 'var(--gray-lt)' },
    'no-gigwave-bucket': { label: 'no Gigwave bucket', color: 'var(--red)', bg: 'var(--red-lt)' },
    'no-none-bucket':    { label: 'no None bucket',    color: 'var(--red)', bg: 'var(--red-lt)' },
    'unresolved':     { label: 'unresolved',      color: 'var(--amber)',    bg: 'var(--amber-lt)' },
  }
  const m = map[status] || map.ready
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px',
      borderRadius: 8, background: m.bg, color: m.color,
    }}>{m.label}</span>
  )
}

const selectStyle = () => ({
  width: '100%',
  padding: '4px 6px',
  fontSize: 11,
  border: '1px solid var(--border2)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
})

const statusBadgeStyle = (color) => ({
  flexShrink: 0, fontSize: 10, fontWeight: 700,
  padding: '2px 8px', borderRadius: 10,
  background: 'var(--bg)', color,
  border: `1px solid ${color}`,
})

const thStyle = (extra = {}) => ({
  padding: '6px 8px', fontSize: 11, fontWeight: 700,
  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  ...extra,
})

const tdStyle = (extra = {}) => ({
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  ...extra,
})

// Inline form rendered inside a Part mappings row when the manager clicks
// "+ Create draft" for an unmapped Sonar model. Form state lives here
// (not in the parent) so reopening for a different model gets a fresh
// pre-fill without leaking the previous attempt.
//
// SKU + name pre-fill with the Sonar model string verbatim — manager can
// override SKU if there's a real internal SKU known, or just accept it
// and clean up later in Parts admin (same workflow as BoxHero drafts).
function CreatePartPanel({ sonarModel, onCancel, onCreated }) {
  const [sku, setSku] = useState(sonarModel)
  const [name, setName] = useState(sonarModel)
  const [unit, setUnit] = useState('ea')
  const [department, setDepartment] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function handleSave() {
    const trimmedSku = sku.trim()
    const trimmedName = name.trim()
    if (!trimmedSku) { setErr('SKU is required'); return }
    if (!trimmedName) { setErr('Name is required'); return }
    setSaving(true)
    setErr(null)
    try {
      const newPart = await createPart({
        id: trimmedSku,
        name: trimmedName,
        unit: unit.trim() || 'ea',
        department: department.trim() || null,
        is_active: false,
      })
      if (!newPart) {
        // Insert returned no data — shouldn't normally happen.
        setErr('Could not create. Try again, or pick an existing SKU from the dropdown.')
        return
      }
      onCreated(newPart)
    } catch (e) {
      // PK violation on parts_catalog.id (23505) means the SKU already
      // exists in the catalog. Common when the manager types a real SKU
      // that's hidden as a draft (BoxHero imports auto-create drafts).
      if (e?.code === '23505' || /duplicate key|already exists/i.test(e?.message || '')) {
        setErr(`SKU "${sku.trim()}" already exists in the catalog. Pick it from the dropdown — it may be marked as a draft.`)
      } else {
        setErr(e.message || String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      marginTop: 6, padding: '8px 10px',
      background: 'var(--bg)',
      border: '1px dashed var(--orange-dk)',
      borderRadius: 6,
    }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
        Creating a draft for Sonar model <strong style={{ color: 'var(--orange)' }}>{sonarModel}</strong>.
        The draft is hidden from regular pickers (<code>is_active=false</code>) until you activate it in Parts admin.
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6,
      }}>
        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          SKU *
          <input
            type="text"
            value={sku}
            onChange={e => setSku(e.target.value)}
            placeholder="e.g. U6.3 or your internal code"
            autoComplete="off"
            name="draft-sku"
            style={{ ...selectStyle(), marginTop: 2 }}
          />
        </label>
        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          Name *
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Display name"
            autoComplete="off"
            name="draft-name"
            style={{ ...selectStyle(), marginTop: 2 }}
          />
        </label>
        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          Unit
          <input
            type="text"
            value={unit}
            onChange={e => setUnit(e.target.value)}
            placeholder="ea"
            autoComplete="off"
            name="draft-unit"
            style={{ ...selectStyle(), marginTop: 2 }}
          />
        </label>
        <label style={{ fontSize: 10, color: 'var(--muted)' }}>
          Department (optional)
          <input
            type="text"
            value={department}
            onChange={e => setDepartment(e.target.value)}
            placeholder="e.g. Customer Premises Equipment"
            autoComplete="off"
            name="draft-department"
            style={{ ...selectStyle(), marginTop: 2 }}
          />
        </label>
      </div>
      {err && (
        <div style={{
          fontSize: 10, color: 'var(--red)',
          background: 'var(--red-lt)',
          padding: '4px 6px', borderRadius: 4, marginBottom: 6,
        }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            fontSize: 11, padding: '4px 10px',
            background: 'transparent', color: 'var(--muted)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            fontSize: 11, padding: '4px 10px',
            background: 'var(--orange)', color: 'white',
            border: '1px solid var(--orange-dk)', borderRadius: 4, cursor: 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Creating…' : 'Create draft'}
        </button>
      </div>
    </div>
  )
}
