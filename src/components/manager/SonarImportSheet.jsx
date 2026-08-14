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
  confirmNegativeStock,
} from '../../lib/inventory'
import {
  useCsvFile, useSonarPendingQueue, useEffectiveMap, useAlreadyImportedMarkers,
} from '../../lib/useCsvImport'
import {
  Section, MappingRow, StatusTag, StatusBadge, selectStyle,
  SourceLocationSelect, PendingImportsPanel, ProcessedImportsPanel,
} from './importShared'
import { applyAccountInheritance, groupRowsByAccount } from '../../lib/accountInheritance'
import PartSearch from '../crew/workspace/PartSearch'
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
  const [sourceLocations, setSourceLocations] = useState([])  // any active location (warehouse/bin/truck/group) eligible as a Sonar source override

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
  const [pickingModel, setPickingModel] = useState(null)  // model whose SKU is being picked via PartSearch
  const [pendingPartRouting, setPendingPartRouting] = useState({}) // part_id → policy
  const [rowDest, setRowDest] = useState({})          // row idx → bucket id (per-row override / ask-resolution)
  const [rowSource, setRowSource] = useState({})      // row idx → source location id (per-row source override when the completer isn't the carrier)
  const [excluded, setExcluded] = useState(() => new Set())

  const [submitting, setSubmitting] = useState(false)
  const [showBulkProjects, setShowBulkProjects] = useState(false)

  // ── CSV state + webhook queue (shared plumbing) ─────────────────────────
  const csv = useCsvFile({
    requiredCols: REQUIRED_COLS,
    missingColsMessage: missing => `CSV is missing required Sonar columns: ${missing.join(', ')}`,
    // Successful load resets the per-import picks (persisted maps + routing
    // picks survive across files by design — only per-file state resets).
    onLoaded: () => {
      setExcluded(new Set())
      setCrewMap({})
      setPartMap({})
      setPendingCityMap({})
      setRowDest({})
      // Index-keyed like rowDest — a source picked for delivery A's row N
      // must not silently re-source whatever sits at index N of delivery B.
      setRowSource({})
    },
  })
  const { fileName, csvRows, error, setError, parsing, handleFile } = csv

  const queue = useSonarPendingQueue('asset_consumption', {
    csv,
    currentUserId: currentUser?.id,
    showToast,
    discardPrompt: p =>
      `Discard this pending Sonar import (${p.parsed_row_count} rows from ${new Date(p.received_at).toLocaleString()})? It will stay in the audit log but not be importable.`,
  })

  // Back closes the importer (mounted only when open). Confirm once a CSV is
  // loaded so a stray Back doesn't throw away mapping work. The nested
  // BulkSonarProjectsSheet registers its own layer and is closed first.
  useBackClose(1, onClose, {
    confirm: () => csvRows == null || window.confirm('Close the Sonar import? Unsaved mapping will be lost.'),
  })

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
        // Eligible source-override targets: any active location the stock
        // could have come off — warehouses + bins, crew trucks, and shared
        // group trailers (Contractor-RNS, Drop Trailer, etc.). Used when the
        // person who completed the job in Sonar isn't the one carrying the
        // inventory. (job_site project buckets + scrap excluded — they're
        // destinations, not sources.)
        setSourceLocations(
          (allLocations || []).filter(l =>
            l.is_active !== false &&
            ['warehouse', 'bin', 'truck', 'group'].includes(l.type)
          )
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

  // Sonar item IDs already imported in past movements (90-day marker scan) —
  // used to skip re-imports. Covers the "Looker daily report uses a rolling
  // window" case. Refetches whenever a new CSV is loaded.
  const alreadyImportedItemIds = useAlreadyImportedMarkers('sonar', dedupedRows)

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

  // ── Per-row resolution ──────────────────────────────────────────────────
  // Merged maps: persisted (DB) + this-session pending picks
  const effectiveCityMap = useEffectiveMap(persistedCityMap, pendingCityMap)
  const effectiveProjectMap = useEffectiveMap(persistedProjectMap, pendingProjectMap)
  // Sonar source string → FiberLog location id (warehouse/bin). When a
  // source has a mapping here, the resolver uses that location as the
  // from_location_id and skips the crew/truck lookup entirely.
  const effectiveSourceMap = useEffectiveMap(persistedSourceMap, pendingSourceMap)

  function getPartRouting(partId) {
    if (pendingPartRouting[partId]) return pendingPartRouting[partId]
    const p = parts.find(p => p.id === partId)
    return p?.sonar_routing || 'ask'
  }

  const resolved = useMemo(() => {
    if (!dedupedRows) return []
    const rows = dedupedRows.map((entry, idx) => {
      const row = entry.row
      const sonarLoc = row['Previous Inventory Location'] || ''
      const sonarModel = row['Model | Display Name'] || ''
      const fullAddress = row['Address | Full Address'] || ''
      const city = parseCityFromFullAddress(fullAddress)
      const sonarProject = (row['Project'] || '').trim()
      // Resolve the source. Priority 1: per-row override (manager picked the
      // source for this specific row). Priority 2: persisted source map
      // (sonar_source → location, e.g. a dispatcher who never carries stock).
      // Priority 3: crew → truck. When a mapped/overridden location wins,
      // userId stays null (consumed_by_user_id becomes NULL — we don't know
      // which crew physically did the pull, only where it came from).
      const sourceLocationId = rowSource[idx] || effectiveSourceMap.get(sonarLoc.toUpperCase()) || null
      const sourceIsWarehouse = !!sourceLocationId   // a mapped/overridden location source (any type), not a crew truck
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
      // Set when the wireless part policy trumped a tagged Sonar project —
      // suppresses the fiber phase tag so Sage cost-centers stay clean.
      let policyOverrodeProject = false

      // Already imported in a prior delivery — skip.
      if (isAlreadyImported) {
        status = 'already-imported'
      }
      // Source/part problems are checked BEFORE the per-row destination
      // override: a manual dest pick must not hold a row at 'ready' after
      // its source later evaporates (e.g. the source's crew re-picked to a
      // user with no truck) — that row would count in "Apply N transfers"
      // but be silently dropped by the apply filter.
      else if (!fromLocationId) {
        // No source identified — either an unmatched crew name OR an
        // unfamiliar non-crew source string (e.g. "Receiving") that
        // hasn't been mapped to a warehouse yet.
        status = sourceIsWarehouse ? 'no-source-location' : 'no-crew'
      } else if (!sourceIsWarehouse && !truckId) {
        // Crew was matched but they have no truck assigned.
        status = 'no-truck'
      } else if (!partId) {
        status = 'no-part'
      }
      // Per-row destination override wins over routing/project resolution.
      else if (rowDest[idx]) {
        destId = rowDest[idx]
        destReason = 'manual pick'
      }
      // An explicit wireless part policy (gigwave / fixed-wireless) beats the
      // Sonar project tag: a CBRS radio or Wave unit is wireless consumption
      // no matter which project dispatch put on the ticket. Without this,
      // "West Mountain Fiber"-tagged wireless installs were landing in the
      // fiber BEAD consumption ledger (reclassed Aug 2026).
      else if (routing === 'gigwave' || routing === 'none') {
        const bucketName = routing === 'gigwave' ? 'Gigwave' : 'Fixed Wireless'
        const b = buckets.find(b => b.name === bucketName)
        if (b) {
          destId = b.id
          destReason = `policy: ${bucketName.toLowerCase()}` +
            (sonarProject ? ` (overrides Sonar project: ${sonarProject})` : '')
          if (sonarProject) policyOverrodeProject = true
        } else {
          status = routing === 'gigwave' ? 'no-gigwave-bucket' : 'no-fixed-wireless-bucket'
        }
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
        // gigwave/none are handled above (they outrank the project tag);
        // only region/ask reach this switch. Legacy token 'none' means
        // "Fixed Wireless catch-all" — the standalone "None" bucket was
        // retired and Fixed Wireless took over everything it routed. (Token
        // kept to avoid a sonar_routing CHECK migration; see
        // SONAR_ROUTING_OPTIONS in lib/inventory.js.)
        switch (routing) {
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
      // manual override picked, or NULL. Skipped when the wireless part
      // policy overrode the project tag — a movement into the Gigwave /
      // Fixed Wireless bucket must not roll up under a fiber phase in Sage.
      let phaseTagId = null
      if (sonarProject && !policyOverrodeProject) {
        phaseTagId = effectiveProjectMap.get(sonarProject.toUpperCase()) || null
      }
      return {
        idx,
        accountId,
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
    // Second pass: 'ask' rows (GigaSpire adapters etc.) adopt the
    // destination their same-account siblings resolved to — see
    // lib/accountInheritance.js for the rules.
    return applyAccountInheritance(rows)
  }, [dedupedRows, crewMap, partMap, trucksByUser, crewUsers, parts, buckets, phases, effectiveCityMap, effectiveProjectMap, effectiveSourceMap, rowDest, rowSource, pendingPartRouting, alreadyImportedItemIds])

  // Preview-table order only — apply/stats keep working off `resolved`.
  const displayRows = useMemo(() => groupRowsByAccount(resolved), [resolved])

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

  // Per-row source override: pick the location the stock actually came off
  // for this one row (when the Sonar completer isn't the inventory carrier).
  function setRowSourceLocation(idx, locationId) {
    setRowSource(prev => ({ ...prev, [idx]: locationId || null }))
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
          // Real work date (job completion) so reports/Sage date by when the
          // install happened, not when we imported the CSV. See occurred_at.
          const occ = r.date ? new Date(r.date) : null
          return {
            movement_type: 'transfer',
            part_id: r.partId,
            quantity: 1,
            unit: 'ea',
            from_location_id: r.fromLocationId,
            to_location_id: r.destId,
            notes: noteParts.join(' · '),
            created_by: currentUser?.id,
            occurred_at: (occ && !isNaN(occ.getTime())) ? occ.toISOString() : null,
            phase_id: r.phaseTagId || null,
            // NULL for warehouse-source rows — no crew to attribute the pull to.
            consumed_by_user_id: r.userId || null,
          }
        })
      if (movements.length === 0) {
        setError('Nothing ready to apply')
        return
      }
      // DELIBERATELY atomic (default mode, NOT chunk:true): this writes the
      // consumption ledger, and the [sonar:] marker dedup can't see rows
      // written earlier in the SAME session (the marker set only refreshes
      // when the CSV changes) — a partial write followed by an in-session
      // re-apply would double-book transfers. All-or-nothing means a
      // failure writes nothing and re-apply is always safe. Daily
      // deliveries are far below any payload limit.
      //
      // Warn first: these deduct from crew trucks, and a truck that never got
      // its load recorded goes straight negative on import.
      if (!(await confirmNegativeStock(movements))) return
      await recordMovementsBatch(movements)
      // If this CSV came from a webhook delivery, mark it imported so it
      // drops out of the pending queue. Non-fatal if it fails (movements
      // are already written) — just log so we can clean up manually.
      await queue.markApplied(movements.length)
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
        <PendingImportsPanel queue={queue} disabled={parsing || submitting} />

        {/* Processed deliveries (imported + discarded) — audit panel. */}
        <ProcessedImportsPanel queue={queue} label="webhook" />

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
              subtitle="One pick per Sonar source. Crews auto-match by name in parens. When the completer isn't the carrier (a dispatcher / office person), map the source to the location the stock actually came off — any warehouse, shared trailer, or crew truck. That pick persists across imports.">
              {uniqueSonarLocs.map(loc => {
                const sourceLocId = effectiveSourceMap.get(loc.toUpperCase())
                const sourceLocName = sourceLocId
                  ? (sourceLocations.find(l => l.id === sourceLocId)?.name || null)
                  : null
                const userId = sourceLocId ? null : crewMap[loc]
                const hasTruck = userId ? !!trucksByUser[userId] : false
                const status = sourceLocId
                  ? { tag: `source${sourceLocName ? `: ${sourceLocName}` : ''}`, color: 'var(--teal-dk)' }
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
                      <SourceLocationSelect
                        locations={sourceLocations}
                        value={sourceLocId}
                        onChange={v => handleSourceLocationChange(loc, v || null)}
                        placeholder="…or map to a location (persists)"
                        style={{ ...selectStyle(), fontSize: 11, color: 'var(--muted)' }}
                      />
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
                        <button
                          type="button"
                          onClick={() => setPickingModel(model)}
                          title="Search the catalog for a part to map this Sonar model to"
                          style={{ ...selectStyle(), textAlign: 'left', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: partId ? 'var(--text)' : 'var(--muted)' }}
                        >
                          {pickedPart ? `${pickedPart.name} (${pickedPart.id})${isDraft ? ' — draft' : ''}` : '🔍 pick part…'}
                        </button>
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
                      <StatusTag tag={status.tag} color={status.color} />
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

          {/* Searchable part picker for the model→SKU mapping above. Active
              parts only (drafts are curated separately; use "+ Create draft"). */}
          {pickingModel && (
            <PartSearch
              activeOnly
              onSelect={p => { setPartMap(prev => ({ ...prev, [pickingModel]: p.id })); setPickingModel(null) }}
              onClose={() => setPickingModel(null)}
            />
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
                    {displayRows.map((r, di) => {
                      const isExcluded = excluded.has(r.idx)
                      const isReady = r.status === 'ready'
                      // Inherited rows keep the picker as an escape hatch —
                      // a rowDest pick outranks inheritance on recompute.
                      const needsPicker = r.status === 'ask' || r.status === 'city-unmapped' || r.status === 'project-unmapped' || r.status === 'unresolved' || r.inheritedFromAccount
                      // Divider where the account group changes, so an
                      // account's items read as one cluster.
                      const prev = displayRows[di - 1]
                      const newGroup = di > 0 && (r.accountId || `row-${r.idx}`) !== (prev.accountId || `row-${prev.idx}`)
                      return (
                        <tr key={r.idx} style={{
                          background: isExcluded
                            ? 'var(--gray-lt)'
                            : isReady ? 'transparent' : 'var(--amber-lt)',
                          opacity: isExcluded ? 0.45 : 1,
                          borderTop: newGroup ? '2px solid var(--border2)' : undefined,
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
                                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--teal-mid)' }}><Icon name="box" size={13} /> {sourceLocations.find(l => l.id === r.sourceLocationId)?.name || r.sonarLoc}</span>
                                : (r.userName || <em style={{ color: 'var(--amber)' }}>{r.sonarLoc}</em>)
                              }
                            </div>
                            {/* Per-row source override — pick where the stock
                                actually came off when the completer isn't the
                                carrier. Resolves no-crew / no-truck rows. */}
                            <SourceLocationSelect
                              locations={sourceLocations}
                              value={rowSource[r.idx]}
                              onChange={v => setRowSourceLocation(r.idx, v)}
                              placeholder={r.fromLocationId ? 'override source…' : '— pick source —'}
                              style={{ ...selectStyle(), fontSize: 11, marginTop: 4, color: 'var(--muted)', minWidth: 150 }}
                            />
                          </td>
                          <td style={tdStyle()}>
                            {needsPicker ? (
                              <>
                                <select
                                  value={rowDest[r.idx] || (r.inheritedFromAccount ? r.destId : '') || ''}
                                  onChange={e => setRowDestination(r.idx, e.target.value)}
                                  style={{ ...selectStyle(), minWidth: 140 }}
                                >
                                  <option value="">— pick bucket —</option>
                                  {buckets.map(b => (
                                    <option key={b.id} value={b.id}>{b.name}</option>
                                  ))}
                                </select>
                                {r.inheritedFromAccount && !rowDest[r.idx] && (
                                  <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 2 }}>{r.destReason}</div>
                                )}
                              </>
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
                            <StatusBadge status={r.status} map={SONAR_STATUS_MAP} />
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
// Section / MappingRow / StatusTag / StatusBadge / selectStyle /
// SourceLocationSelect + the webhook panels live in ./importShared (shared
// with FiberJobsImportSheet). Only the sheet-specific bits stay here.

// Status vocabulary for the transactions table — this sheet's resolver
// failure modes. Rendered by the shared StatusBadge.
const SONAR_STATUS_MAP = {
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
  'no-fixed-wireless-bucket': { label: 'no Fixed Wireless bucket', color: 'var(--red)', bg: 'var(--red-lt)' },
  'unresolved':     { label: 'unresolved',      color: 'var(--amber)',    bg: 'var(--amber-lt)' },
}

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
  const { currentUser } = useApp()
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
        created_via: {
          source: 'Sonar import',
          detail: `unmapped Sonar model "${sonarModel}"`,
          by: currentUser?.name || null,
        },
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
