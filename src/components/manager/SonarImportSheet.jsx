import { useState, useMemo, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import {
  recordMovementsBatch,
  getSonarCityMap, setSonarCityBucket,
  getSonarProjectMap, setSonarProjectBucket,
  setPartSonarRouting, SONAR_ROUTING_OPTIONS,
  getPendingSonarImports, getProcessedSonarImports, getPendingSonarImport,
  markSonarPendingImportApplied, discardSonarPendingImport,
} from '../../lib/inventory'
import { parseCsv, readFileAsText } from '../../lib/csvImport'

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
  const [persistedProjectMap, setPersistedProjectMap] = useState(() => new Map())  // project UPPER → bucket id

  // ── CSV state ───────────────────────────────────────────────────────────
  const [fileName, setFileName] = useState('')
  const [csvRows, setCsvRows] = useState(null)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)
  // When the CSV came from a pending webhook delivery, remember its id so
  // we can flip status='imported' on successful apply.
  const [activePendingId, setActivePendingId] = useState(null)

  // ── Pending webhook deliveries (Sonar's daily push) ─────────────────────
  const [pendingImports, setPendingImports] = useState([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const refreshPending = async () => {
    try {
      const rows = await getPendingSonarImports({ includeProcessed: false })
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
        const rows = await getProcessedSonarImports({ limit: 30 })
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
  const [pendingProjectMap, setPendingProjectMap] = useState({})  // project UPPER → bucket id (this session)
  const [pendingPartRouting, setPendingPartRouting] = useState({}) // part_id → policy
  const [rowDest, setRowDest] = useState({})          // row idx → bucket id (per-row override / ask-resolution)
  const [excluded, setExcluded] = useState(() => new Set())

  const [submitting, setSubmitting] = useState(false)

  // Fetch lookups on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [usersRes, trucksRes, partsRes, bucketsRes, cityMap, projectMap] = await Promise.all([
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
      } catch (e) {
        if (!cancelled) setError('Failed to load FiberLog lookups: ' + (e.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Unique values extracted from the CSV ────────────────────────────────
  const uniqueSonarLocs = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => r['Previous Inventory Location'] || '').filter(Boolean))]
  }, [csvRows])
  const uniqueSonarModels = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => r['Model | Display Name'] || '').filter(Boolean))]
  }, [csvRows])
  const uniqueCities = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(
      csvRows.map(r => parseCityFromFullAddress(r['Address | Full Address'] || '')).filter(Boolean)
    )]
  }, [csvRows])
  const uniqueProjects = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => (r['Project'] || '').trim()).filter(Boolean))]
  }, [csvRows])

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

  // Auto-seed Sonar project → bucket when names match. Most Sonar project
  // names are sub-areas (Center Creek, Snyderville) that won't match
  // FiberLog's regional buckets directly, but a few will (West Mountain
  // Fiber → West Mountain, etc) — catch those automatically.
  useEffect(() => {
    if (!csvRows || buckets.length === 0) return
    const auto = {}
    for (const proj of uniqueProjects) {
      const up = proj.toUpperCase()
      if (persistedProjectMap.has(up) || pendingProjectMap[up]) continue
      // Exact match first
      let match = buckets.find(b => (b.name || '').toUpperCase() === up)
      // Then contains-either-way (handles "West Mountain Fiber" ↔ "West Mountain")
      if (!match) match = buckets.find(b => {
        const bn = (b.name || '').toUpperCase()
        return bn && (bn.includes(up) || up.includes(bn))
      })
      if (match) auto[up] = match.id
    }
    if (Object.keys(auto).length > 0) {
      setPendingProjectMap(prev => ({ ...auto, ...prev }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueProjects, buckets, persistedProjectMap])

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

  async function handleProjectBucketChange(project, bucketId) {
    const up = project.toUpperCase()
    setPendingProjectMap(prev => ({ ...prev, [up]: bucketId }))
    if (!bucketId) return
    try {
      await setSonarProjectBucket(project, bucketId)
      setPersistedProjectMap(prev => {
        const next = new Map(prev)
        next.set(up, bucketId)
        return next
      })
    } catch (e) {
      setError(`Failed to save project mapping for ${project}: ${e.message}`)
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

  function getPartRouting(partId) {
    if (pendingPartRouting[partId]) return pendingPartRouting[partId]
    const p = parts.find(p => p.id === partId)
    return p?.sonar_routing || 'ask'
  }

  const resolved = useMemo(() => {
    if (!csvRows) return []
    return csvRows.map((row, idx) => {
      const sonarLoc = row['Previous Inventory Location'] || ''
      const sonarModel = row['Model | Display Name'] || ''
      const fullAddress = row['Address | Full Address'] || ''
      const city = parseCityFromFullAddress(fullAddress)
      const sonarProject = (row['Project'] || '').trim()
      const userId = crewMap[sonarLoc] || null
      const truckId = userId ? trucksByUser[userId] : null
      const partId = partMap[sonarModel] || null
      const userName = userId ? crewUsers.find(u => u.id === userId)?.name || '' : ''
      const partName = partId ? parts.find(p => p.id === partId)?.name || '' : ''
      const routing = partId ? getPartRouting(partId) : null
      // Item ID for the dedup marker: first numeric value from the
      // pipe-separated Value List, falling back to Account|ID + Date.
      const itemFromValueList = extractItemIdFromValueList(row['Model Field Data | Value List'] || '')
      const accountId = (row['Account | ID'] || '').trim()
      const sonarItemId = itemFromValueList || (accountId && row['Date Time'] ? `${accountId}-${row['Date Time']}` : '')

      // Determine destination
      let destId = null
      let destReason = null  // human-readable explanation
      let status = 'ready'

      // Per-row override always wins
      if (rowDest[idx]) {
        destId = rowDest[idx]
        destReason = 'manual pick'
      } else if (!userId) {
        status = 'no-crew'
      } else if (!truckId) {
        status = 'no-truck'
      } else if (!partId) {
        status = 'no-part'
      } else if (sonarProject) {
        // Sonar tagged the project — that's authoritative. Skip part-level
        // routing entirely. Only fall through to part routing if the
        // project name is unmapped (manager needs to set it once).
        const projBucketId = effectiveProjectMap.get(sonarProject.toUpperCase())
        if (projBucketId) {
          destId = projBucketId
          destReason = `Sonar project: ${sonarProject}`
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
      return {
        idx,
        date: row['Date Time'] || '',
        customer: row['Current Assignee'] || '',
        city,
        sonarProject,
        sonarLoc, sonarModel,
        sonarItemId,
        userId, truckId, userName,
        partId, partName,
        routing,
        destId,
        destName: destBucket?.name || null,
        destReason,
        status,
      }
    })
  }, [csvRows, crewMap, partMap, trucksByUser, crewUsers, parts, buckets, effectiveCityMap, effectiveProjectMap, rowDest, pendingPartRouting])

  const stats = useMemo(() => {
    if (resolved.length === 0) return null
    let ready = 0, blocked = 0, excludedCount = 0
    const blockReasons = {}
    for (const r of resolved) {
      if (excluded.has(r.idx)) { excludedCount++; continue }
      if (r.status === 'ready') ready++
      else {
        blocked++
        blockReasons[r.status] = (blockReasons[r.status] || 0) + 1
      }
    }
    return { total: resolved.length, ready, blocked, blockReasons, excludedCount }
  }, [resolved, excluded])

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
        .filter(r => !excluded.has(r.idx) && r.status === 'ready' && r.destId && r.truckId)
        .map(r => {
          const dateStr = String(r.date).slice(0, 16)
          const noteParts = [
            'Sonar install',
            dateStr,
            r.customer,
            r.city,
            r.destReason,
            r.sonarItemId && `[sonar:${r.sonarItemId}]`,
          ].filter(Boolean)
          return {
            movement_type: 'transfer',
            part_id: r.partId,
            quantity: 1,
            unit: 'ea',
            from_location_id: r.truckId,
            to_location_id: r.destId,
            notes: noteParts.join(' · '),
            created_by: currentUser?.id,
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
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 1000, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>⚡ Sonar daily install import</div>
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
                      padding: '5px 8px', fontSize: 11,
                      background: 'transparent',
                      color: isActive ? 'rgba(255,255,255,0.8)' : 'var(--muted)',
                      border: 'none', cursor: 'pointer',
                    }}
                    title="Discard this delivery"
                    disabled={parsing || submitting}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
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
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 12,
                padding: '4px 0', textDecoration: 'underline',
              }}
            >
              {showProcessed ? '▾ Hide' : '▸ Show'} recent webhook deliveries (audit)
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
                            style={{ flexShrink: 0 }}
                          >
                            {isImported ? '✓ imported' : isAutoDiscard ? '⚠ auto-discarded' : 'discarded'}
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
            <Section title="Crew mappings" accent="var(--teal)"
              subtitle="One pick per Sonar source. Auto-matched by the name in parens; override if wrong.">
              {uniqueSonarLocs.map(loc => {
                const userId = crewMap[loc]
                const hasTruck = userId ? !!trucksByUser[userId] : false
                const status = !userId ? { tag: 'unmatched', color: 'var(--amber)' }
                  : !hasTruck ? { tag: 'no truck', color: 'var(--red)' }
                  : { tag: 'matched', color: 'var(--teal-dk)' }
                const n = resolved.filter(r => r.sonarLoc === loc).length
                return (
                  <MappingRow key={loc}
                    primary={loc}
                    secondary={`${n} row${n === 1 ? '' : 's'}`}
                    status={status}
                  >
                    <select
                      value={userId || ''}
                      onChange={e => setCrewMap(prev => ({ ...prev, [loc]: e.target.value }))}
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

          {/* Part mappings — with routing policy picker per part */}
          {uniqueSonarModels.length > 0 && (
            <Section title="Part mappings + routing" accent="var(--orange)"
              subtitle="Pick the FiberLog SKU AND a routing policy per Sonar model. Policy is saved per part and used on every future import.">
              {uniqueSonarModels.map(model => {
                const partId = partMap[model]
                const routing = partId ? getPartRouting(partId) : null
                const n = resolved.filter(r => r.sonarModel === model).length
                const status = !partId ? { tag: 'unmatched', color: 'var(--amber)' }
                  : routing === 'ask' ? { tag: 'asks per row', color: 'var(--amber)' }
                  : { tag: routing, color: 'var(--orange-dk)' }
                return (
                  <div key={model} style={{
                    display: 'grid', gridTemplateColumns: '2fr 2fr 2fr auto', gap: 6,
                    marginBottom: 4, padding: '4px 6px',
                    background: 'var(--surface2)', borderRadius: 6, alignItems: 'center',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{model}</div>
                      <div style={{ fontSize: 10, color: 'var(--hint)' }}>{n} row{n === 1 ? '' : 's'}</div>
                    </div>
                    <select
                      value={partId || ''}
                      onChange={e => setPartMap(prev => ({ ...prev, [model]: e.target.value }))}
                      style={selectStyle()}
                    >
                      <option value="">— pick part —</option>
                      {parts.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
                      ))}
                    </select>
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
                )
              })}
            </Section>
          )}

          {/* Project mappings — Sonar's Project column → FiberLog bucket.
              When set, this overrides part-level routing. Mappings persist
              to sonar_project_bucket_map for future imports. */}
          {projectsNeedingMap.length > 0 && (
            <Section title="Sonar project mappings" accent="var(--purple)"
              subtitle="Sonar tagged each row with a project — pick the FiberLog bucket once per project. Saved to sonar_project_bucket_map and used on every future import.">
              {projectsNeedingMap.map(project => {
                const up = project.toUpperCase()
                const picked = effectiveProjectMap.get(up) || ''
                const status = picked
                  ? { tag: 'mapped', color: 'var(--purple)' }
                  : { tag: 'needs mapping', color: 'var(--amber)' }
                const n = resolved.filter(r => r.sonarProject.toUpperCase() === up).length
                return (
                  <MappingRow key={project} primary={project} secondary={`${n} row${n === 1 ? '' : 's'}`} status={status}>
                    <select
                      value={picked}
                      onChange={e => handleProjectBucketChange(project, e.target.value)}
                      style={selectStyle()}
                    >
                      <option value="">— pick bucket —</option>
                      {buckets.map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
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
                    {stats.ready} ready · {stats.blocked} blocked · {stats.excludedCount} excluded
                  </span>
                )}
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: 'var(--surface2)' }}>
                    <tr>
                      <th style={thStyle({ width: 32 })}>✓</th>
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
                            <div style={{ fontWeight: 600 }}>{r.customer}</div>
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
                            <div style={{ fontWeight: 600 }}>{r.userName || <em style={{ color: 'var(--amber)' }}>{r.sonarLoc}</em>}</div>
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
