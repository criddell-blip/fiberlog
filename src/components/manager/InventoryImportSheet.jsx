import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  parseCsv,
  readFileAsText,
  detectBoxHeroQtyColumns,
  summarizeBoxHeroColumns,
  classifyBoxHeroColumn,
  buildUnmatchedCsv,
  downloadTextAsFile,
} from '../../lib/csvImport'
import {
  getPartsCatalogIndex,
  recordMovementsBatch,
  createLocation,
  createDraftParts,
  getAllParts,
  getStockRowsForParts,
  updatePartsBatch,
} from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

const STAGES = {
  pick:      'pick',
  mapping:   'mapping',
  importing: 'importing',
  review:    'review',
  done:      'done',
}

// Location types whose stock we're allowed to auto-zero during the post-import
// sweep. Trucks hold a crew member's live on-truck count and job_site buckets
// are the Sage consumption ledger — zeroing either would corrupt real records,
// so orphan stock sitting there is deactivated-but-left-alone (see runSweep).
const ZEROABLE_LOCATION_TYPES = new Set(['warehouse', 'bin'])

// Tag every console log so it's easy to spot in DevTools
const LOG_PREFIX = '[InventoryImport]'

export default function InventoryImportSheet({ locations, currentUser, onClose, onComplete }) {
  const { showToast } = useApp()
  const [stage, setStage] = useState(STAGES.pick)
  const [parseError, setParseError] = useState(null)

  // Back closes the importer (mounted only when open). Confirm once past the
  // file-pick stage so a stray Back doesn't drop a loaded CSV / column mapping.
  useBackClose(1, onClose, {
    // Veto Back outright while the sweep is committing movements — closing
    // mid-flight would unmount the sheet and lose the result summary.
    confirm: () => {
      if (sweeping) return false
      return stage === STAGES.pick || window.confirm('Close the import? Unsaved mapping will be lost.')
    },
  })

  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [qtyColumns, setQtyColumns] = useState([])

  const [catalogIndex, setCatalogIndex] = useState(null)
  const [unmatchedSkus, setUnmatchedSkus] = useState([])

  const [autoCreateDrafts, setAutoCreateDrafts] = useState(true)
  const [columnMap, setColumnMap] = useState({})

  const [creatingLocFor, setCreatingLocFor] = useState(null)
  const [newLocName, setNewLocName] = useState('')
  const [newLocType, setNewLocType] = useState('warehouse')

  const [progress, setProgress] = useState({ done: 0, total: 0, errors: [], draftsCreated: 0 })
  const [results, setResults] = useState(null)

  // Post-import sweep: parts that are active in FiberLog but weren't in this
  // CSV (likely renamed/retired in accounting). orphanReview holds the
  // reviewable list; sweepResult holds the outcome after the user confirms.
  const [orphanReview, setOrphanReview] = useState(null)
  const [sweepSelected, setSweepSelected] = useState(() => new Set())
  const [sweeping, setSweeping] = useState(false)
  const [sweepResult, setSweepResult] = useState(null)

  function toggleSweep(partId) {
    setSweepSelected(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId); else next.add(partId)
      return next
    })
  }

  // ─── Stage 1: file pick + parse ───────────────────────────────────────────

  async function handleFilePicked(file) {
    if (!file) return
    setParseError(null)
    try {
      const text = await readFileAsText(file)
      const { headers, rows } = parseCsv(text)

      if (!headers.includes('SKU')) {
        throw new Error('CSV does not look like a BoxHero export — missing "SKU" column.')
      }
      const detected = detectBoxHeroQtyColumns(headers)
      if (detected.length === 0) {
        throw new Error('No Qty(...) location columns found.')
      }
      const summarized = summarizeBoxHeroColumns(rows, detected)
        .map(c => ({ ...c, category: classifyBoxHeroColumn(c.locationLabel) }))

      const initialMap = {}
      for (const col of summarized) {
        if (col.total === 0 || col.category === 'cycle_count') {
          initialMap[col.columnName] = 'skip'
          continue
        }
        const lbl = col.locationLabel.toLowerCase()
        const match = locations.find(l => l.name.toLowerCase() === lbl)
        if (match) { initialMap[col.columnName] = match.id; continue }
        if (col.category === 'warehouse') {
          const warehouses = locations.filter(l => l.type === 'warehouse')
          if (warehouses.length === 1) {
            initialMap[col.columnName] = warehouses[0].id
            continue
          }
        }
        initialMap[col.columnName] = 'skip'
      }

      const idx = await getPartsCatalogIndex()
      const unmatched = []
      const seen = new Set()
      for (const row of rows) {
        const sku = (row.SKU || '').trim()
        if (!sku || seen.has(sku)) continue
        seen.add(sku)
        if (!idx.byId.has(sku)) {
          let totalQty = 0
          for (const col of detected) {
            const v = Number(row[col.columnName])
            if (!Number.isNaN(v)) totalQty += v
          }
          unmatched.push({
            sku,
            name: (row.Name || '').trim(),
            totalQty,
            row,
          })
        }
      }
      unmatched.sort((a, b) => b.totalQty - a.totalQty)

      setHeaders(headers)
      setRows(rows)
      setQtyColumns(summarized)
      setColumnMap(initialMap)
      setCatalogIndex(idx)
      setUnmatchedSkus(unmatched)
      setStage(STAGES.mapping)
    } catch (e) {
      console.error(LOG_PREFIX, 'parse failed:', e)
      setParseError(e.message)
    }
  }

  // ─── Stage 2: mapping ───────────────────────────────────────────────────

  function pickMapping(columnName, value) {
    setColumnMap(m => ({ ...m, [columnName]: value }))
  }

  async function commitNewLocation(columnName) {
    if (!newLocName.trim()) return
    try {
      const created = await createLocation({ name: newLocName.trim(), type: newLocType })
      locations.push(created)
      pickMapping(columnName, created.id)
      setCreatingLocFor(null)
      setNewLocName('')
      setNewLocType('warehouse')
      showToast(`Created ${created.name}`)
    } catch (e) {
      showToast('Could not create location: ' + e.message)
    }
  }

  function downloadUnmatchedCsv() {
    if (unmatchedSkus.length === 0) return
    const csv = buildUnmatchedCsv(unmatchedSkus)
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    downloadTextAsFile(`fiberlog-unmatched-skus-${stamp}.csv`, csv)
    showToast(`Downloaded ${unmatchedSkus.length} unmatched SKUs`)
  }

  const plannedMovements = useMemo(() => {
    if (!catalogIndex) return []
    const out = []
    const unmatchedSet = new Set(unmatchedSkus.map(u => u.sku))
    for (const row of rows) {
      const sku = (row.SKU || '').trim()
      if (!sku) continue
      const isUnmatched = unmatchedSet.has(sku)
      if (isUnmatched && !autoCreateDrafts) continue

      const part = catalogIndex.byId.get(sku)
      const unit = part?.unit || 'ea'

      for (const col of qtyColumns) {
        const target = columnMap[col.columnName]
        if (!target || target === 'skip') continue
        const qty = Number(row[col.columnName])
        if (!qty || Number.isNaN(qty) || qty <= 0) continue
        const unitCost = Number(row['Unit Cost'])
        out.push({
          movement_type: 'receive',
          part_id: sku,
          quantity: qty,
          unit,
          to_location_id: target,
          unit_cost: !Number.isNaN(unitCost) && unitCost > 0 ? unitCost : null,
          notes: `BoxHero seed · ${col.locationLabel}`,
          created_by: currentUser?.id,
        })
      }
    }
    return out
  }, [rows, qtyColumns, columnMap, catalogIndex, unmatchedSkus, autoCreateDrafts, currentUser])

  const mappingSummary = useMemo(() => {
    const mapped = qtyColumns.filter(c => columnMap[c.columnName] && columnMap[c.columnName] !== 'skip').length
    const skipped = qtyColumns.length - mapped
    const draftsToCreate = autoCreateDrafts ? unmatchedSkus.length : 0
    return { mapped, skipped, totalMovements: plannedMovements.length, draftsToCreate }
  }, [qtyColumns, columnMap, plannedMovements, autoCreateDrafts, unmatchedSkus])

  // ─── Stage 3: import ────────────────────────────────────────────────────

  async function runImport() {
    if (plannedMovements.length === 0 && mappingSummary.draftsToCreate === 0) {
      showToast('Nothing to import — map at least one column')
      return
    }
    console.log(LOG_PREFIX, 'starting import:', {
      movements: plannedMovements.length,
      drafts: mappingSummary.draftsToCreate,
      autoCreateDrafts,
    })
    setStage(STAGES.importing)
    setProgress({
      done: 0,
      total: plannedMovements.length,
      errors: [],
      draftsCreated: 0,
      draftsAttempted: 0,
    })

    // Step 1: bulk-create draft parts
    let draftsCreated = 0
    let draftErrors = []
    let draftFatalError = null
    if (autoCreateDrafts && unmatchedSkus.length > 0) {
      const drafts = unmatchedSkus.map(u => {
        const r = u.row || {}
        return {
          id: u.sku,
          name: u.name || u.sku,
          unit: 'ea',
          barcode: r.Barcode || null,
          department: r.Department || null,
          item_type: r.Type || null,
          material_group: r['Material Group'] || null,
        }
      })
      try {
        const result = await createDraftParts(drafts, {
          created_via: {
            source: 'CSV import',
            detail: 'auto-created for a SKU not in the catalog',
            by: currentUser?.name || null,
          },
        })
        draftsCreated = result.created.length
        draftErrors = result.errors || []
        setProgress(p => ({
          ...p,
          draftsCreated,
          draftsAttempted: drafts.length,
          draftErrors,
        }))
      } catch (e) {
        console.error(LOG_PREFIX, 'draft creation hit fatal error:', e)
        draftFatalError = e.message || String(e)
        setProgress(p => ({ ...p, draftFatalError, draftsAttempted: drafts.length }))
      }
    }

    // Step 1.5: refetch the catalog from the DB. This is the source of truth
    // for which SKUs actually exist now — independent of what JS thinks.
    // We use it to filter movements so we never attempt FK-violating inserts.
    let validPartIds
    try {
      const refreshed = await getPartsCatalogIndex()
      validPartIds = refreshed.byId   // Map<sku, partRow>
      console.log(LOG_PREFIX, 'catalog after draft step:', validPartIds.size, 'parts')
    } catch (e) {
      console.error(LOG_PREFIX, 'catalog refetch failed:', e)
      // Fall back to original index — best effort
      validPartIds = catalogIndex.byId
    }

    // Step 2: filter movements to only those whose part_id exists in DB
    const movementsToInsert = plannedMovements.filter(m => validPartIds.has(m.part_id))
    const movementsSkipped = plannedMovements.length - movementsToInsert.length
    const skippedSkusSample = []
    if (movementsSkipped > 0) {
      const skippedSet = new Set()
      for (const m of plannedMovements) {
        if (!validPartIds.has(m.part_id)) skippedSet.add(m.part_id)
      }
      skippedSkusSample.push(...[...skippedSet].slice(0, 30))
      console.warn(LOG_PREFIX, movementsSkipped, 'movements skipped because parts missing:', skippedSkusSample)
    }

    // Chunked insert with single-row fallback lives inside
    // recordMovementsBatch now ({ chunk: true }); onProgress keeps the
    // progress bar + running error list live after each chunk.
    const mapErrors = errs => errs.map(e => ({ part_id: e.movement.part_id, qty: e.movement.quantity, message: e.message }))
    const res = await recordMovementsBatch(movementsToInsert, {
      chunk: true,
      onProgress: ({ done, errors: errs }) => {
        setProgress(p => ({ ...p, done, errors: mapErrors(errs) }))
      },
    })
    const created = res.inserted.length
    const errors = mapErrors(res.errors)

    setResults({
      created,
      skippedSkus: autoCreateDrafts ? 0 : unmatchedSkus.length,
      draftsCreated,
      draftsAttempted: autoCreateDrafts ? unmatchedSkus.length : 0,
      draftErrors,
      draftFatalError,
      errorCount: errors.length,
      errors: errors.slice(0, 20),
      hasUnmatched: unmatchedSkus.length > 0,
      movementsSkippedDueToMissingParts: movementsSkipped,
      skippedSkusSample,
    })

    // ─── Orphan sweep prep ───────────────────────────────────────────────
    // Find active parts whose SKU never appeared in this file — the leftovers
    // from accounting renaming SKUs. We surface them for review (opt-in
    // deactivate + zero). The import itself already succeeded, so any failure
    // here is non-fatal — we just skip straight to the done screen.
    try {
      const seenSkus = new Set()
      for (const row of rows) {
        const sku = (row.SKU || '').trim()
        if (sku) seenSkus.add(sku)
      }
      const allParts = await getAllParts()
      const orphanParts = allParts.filter(p => p.is_active && !seenSkus.has(p.id))
      if (orphanParts.length === 0) {
        setStage(STAGES.done)
        return
      }
      const stockRows = await getStockRowsForParts(orphanParts.map(p => p.id))
      const byPart = new Map()
      for (const p of orphanParts) {
        byPart.set(p.id, { part: p, totalQty: 0, zeroableQty: 0, otherQty: 0, locations: [] })
      }
      for (const r of stockRows) {
        const entry = byPart.get(r.part_id)
        if (!entry) continue
        const qty = Number(r.quantity) || 0
        const type = r.location?.type
        entry.totalQty += qty
        if (ZEROABLE_LOCATION_TYPES.has(type)) entry.zeroableQty += qty
        else entry.otherQty += qty
        entry.locations.push({
          locationId: r.location_id,
          name: r.location?.name || r.location_id,
          type,
          qty,
        })
      }
      const orphans = [...byPart.values()].sort((a, b) => b.totalQty - a.totalQty)
      setOrphanReview({ orphans })
      // Default-select only orphans whose stock is entirely warehouse/bin (or
      // none) — these zero cleanly. Parts holding truck / project-bucket stock
      // start UNchecked so the manager must consciously opt in (deactivating
      // them would strand that stock on an inactive part); this also blunts the
      // partial-file footgun of sweeping the whole catalog by default.
      setSweepSelected(new Set(orphans.filter(o => o.otherQty === 0).map(o => o.part.id)))
      setStage(STAGES.review)
    } catch (e) {
      console.error(LOG_PREFIX, 'orphan computation failed:', e)
      setStage(STAGES.done)
    }
  }

  // ─── Stage 3.5: sweep (deactivate + zero orphans) ────────────────────────

  // Given the set of orphan part ids the user confirmed, zero their
  // warehouse/bin stock (balancing `adjust` movements) and flip them to
  // is_active=false. Truck / job_site / vendor / scrap stock is deliberately
  // left untouched (see ZEROABLE_LOCATION_TYPES).
  //
  // Deactivation is gated PER PART on its zeroing movements succeeding: a part
  // is only flipped inactive once all of its adjust movements committed.
  // Otherwise a failed zero (RLS reject, constraint, network) would strand an
  // inactive part still holding warehouse stock — the exact corruption this
  // feature exists to prevent, and movements are append-only so it can't be
  // rolled back. `recordMovementsBatch` inserts atomically, so a per-part
  // batch is all-or-nothing — a clean success signal.
  async function runSweep(selectedIds) {
    if (!orphanReview || selectedIds.size === 0) return
    if (!currentUser?.id) { showToast('Cannot sweep — no signed-in user'); return }
    if (!window.confirm(
      `Deactivate ${selectedIds.size} part${selectedIds.size === 1 ? '' : 's'} and zero their warehouse stock?\n\n` +
      `This writes permanent adjustment movements and can't be undone.`
    )) return

    setSweeping(true)
    const stamp = new Date().toISOString().slice(0, 10)

    // Balancing adjusts are built from the review-time stock snapshot
    // (getStockRowsForParts), not re-read at commit. If warehouse stock changes
    // between review and confirm the zero won't land exactly — acceptable for a
    // single-operator admin flow run right after an import.

    let movementsCreated = 0
    let zeroedUnits = 0
    let leftAloneQty = 0
    const okToDeactivate = []        // part ids whose zeroing fully succeeded
    const moveErrors = []            // { part_id, message } for parts we skipped

    for (const o of orphanReview.orphans) {
      if (!selectedIds.has(o.part.id)) continue

      // Build this part's zeroing movements. Positive on-hand → negative adjust
      // (source only); negative on-hand → positive adjust (destination only);
      // quantity is always the positive magnitude. validateMovement enforces
      // the one-sidedness.
      const partMovements = []
      for (const loc of o.locations) {
        const qty = Number(loc.qty) || 0
        if (qty === 0) continue
        if (!ZEROABLE_LOCATION_TYPES.has(loc.type)) { leftAloneQty += Math.abs(qty); continue }
        partMovements.push(qty > 0
          ? { movement_type: 'adjust', part_id: o.part.id, from_location_id: loc.locationId, to_location_id: null, quantity: qty,          unit: o.part.unit || null, notes: `Zeroed — not in BoxHero import ${stamp}`, created_by: currentUser.id }
          : { movement_type: 'adjust', part_id: o.part.id, from_location_id: null, to_location_id: loc.locationId, quantity: Math.abs(qty), unit: o.part.unit || null, notes: `Zeroed — not in BoxHero import ${stamp}`, created_by: currentUser.id })
      }

      // Nothing to zero (part has no warehouse stock) → safe to deactivate.
      if (partMovements.length === 0) {
        okToDeactivate.push(o.part.id)
        continue
      }

      try {
        const inserted = await recordMovementsBatch(partMovements)
        movementsCreated += inserted.length
        for (const m of partMovements) zeroedUnits += Number(m.quantity) || 0
        okToDeactivate.push(o.part.id)
      } catch (e) {
        // This part's zeroing failed atomically — leave it ACTIVE with its
        // stock intact so it stays visible/manageable rather than stranded.
        moveErrors.push({ part_id: o.part.id, message: e.message })
      }
    }

    // Deactivate only the parts we successfully zeroed.
    let deactivated = 0
    const deactivateErrors = []
    if (okToDeactivate.length > 0) {
      try {
        const res = await updatePartsBatch(okToDeactivate, { is_active: false })
        deactivated = res.updated.length
        for (const err of res.errors || []) deactivateErrors.push(err)
      } catch (e) {
        console.error(LOG_PREFIX, 'bulk deactivate failed:', e)
        deactivateErrors.push({ id: '(batch)', message: e.message })
      }
    }

    setSweepResult({
      deactivated,
      movementsCreated,
      zeroedUnits,
      leftAloneQty,
      skippedParts: moveErrors.length,
      errors: [...moveErrors, ...deactivateErrors].slice(0, 20),
      errorCount: moveErrors.length + deactivateErrors.length,
    })
    setSweeping(false)
    setStage(STAGES.done)
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Import inventory CSV</div>
          {stage !== STAGES.importing && !sweeping && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}><Icon name="x" size={18} /></button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {stage === STAGES.pick && <PickStage parseError={parseError} onPick={handleFilePicked} />}
          {stage === STAGES.mapping && (
            <MappingStage
              qtyColumns={qtyColumns}
              columnMap={columnMap}
              pickMapping={pickMapping}
              locations={locations}
              creatingLocFor={creatingLocFor}
              setCreatingLocFor={setCreatingLocFor}
              newLocName={newLocName} setNewLocName={setNewLocName}
              newLocType={newLocType} setNewLocType={setNewLocType}
              commitNewLocation={commitNewLocation}
              unmatchedSkus={unmatchedSkus}
              autoCreateDrafts={autoCreateDrafts}
              setAutoCreateDrafts={setAutoCreateDrafts}
              downloadUnmatchedCsv={downloadUnmatchedCsv}
              summary={mappingSummary}
              totalRows={rows.length}
            />
          )}
          {stage === STAGES.importing && <ImportingStage progress={progress} />}
          {stage === STAGES.review && (
            <ReviewStage
              orphanReview={orphanReview}
              selected={sweepSelected}
              onToggle={toggleSweep}
              onSelectAll={() => setSweepSelected(new Set(orphanReview.orphans.map(o => o.part.id)))}
              onClearAll={() => setSweepSelected(new Set())}
            />
          )}
          {stage === STAGES.done && (
            <DoneStage
              results={results}
              sweepResult={sweepResult}
              unmatchedSkus={unmatchedSkus}
              downloadUnmatchedCsv={downloadUnmatchedCsv}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexShrink: 0 }}>
          {stage === STAGES.mapping && (
            <>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={runImport}
                disabled={mappingSummary.totalMovements === 0 && mappingSummary.draftsToCreate === 0}
              >
                Import {mappingSummary.totalMovements.toLocaleString()} movements
                {mappingSummary.draftsToCreate > 0 && ` + ${mappingSummary.draftsToCreate} draft parts`}
              </button>
            </>
          )}
          {stage === STAGES.review && (
            <>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setStage(STAGES.done)} disabled={sweeping}>
                Skip
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={() => runSweep(sweepSelected)}
                disabled={sweeping || sweepSelected.size === 0}
              >
                {sweeping ? 'Working…' : `Deactivate ${sweepSelected.size} part${sweepSelected.size === 1 ? '' : 's'}`}
              </button>
            </>
          )}
          {stage === STAGES.done && (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => { onComplete?.(); onClose() }}>Done</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Stages ─────────────────────────────────────────────────────────────────

function PickStage({ parseError, onPick }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
        Pick a CSV exported from BoxHero. The importer will detect each
        Qty(…) location column and let you map them to FiberLog locations.
      </div>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={e => onPick(e.target.files?.[0])}
        style={{
          width: '100%', padding: '14px 12px',
          border: '1.5px dashed var(--border2)', borderRadius: 'var(--r-sm)',
          background: 'var(--bg)', cursor: 'pointer', fontSize: 13,
        }}
      />
      {parseError && (
        <div style={{
          marginTop: 12, padding: '10px 12px',
          background: 'var(--red-lt)', color: 'var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 13,
        }}>{parseError}</div>
      )}
      <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 11, color: 'var(--muted)' }}>
        <strong style={{ color: 'var(--text)' }}>Build version marker:</strong> v3 (unique + draft + verify)
      </div>
    </div>
  )
}

const TYPE_LABEL = {
  warehouse: '🏭 Warehouse',
  truck:     '🚚 Truck',
  job_site:  '📍 Job site',
  vendor:    '🏢 Vendor',
  scrap:     '🗑️ Scrap',
}
const CAT_BADGE = {
  warehouse:    { color: 'var(--orange)',  text: 'WAREHOUSE' },
  crew:         { color: 'var(--teal)',    text: 'CREW POOL' },
  project:      { color: 'var(--blue)',    text: 'PROJECT' },
  region:       { color: 'var(--purple)',  text: 'REGION' },
  cycle_count:  { color: 'var(--hint)',    text: 'CYCLE COUNT' },
  other:        { color: 'var(--muted)',   text: 'OTHER' },
}

function MappingStage({
  qtyColumns, columnMap, pickMapping,
  locations, creatingLocFor, setCreatingLocFor,
  newLocName, setNewLocName, newLocType, setNewLocType,
  commitNewLocation,
  unmatchedSkus,
  autoCreateDrafts, setAutoCreateDrafts,
  downloadUnmatchedCsv,
  summary, totalRows,
}) {
  const visibleColumns = qtyColumns.filter(c => c.total !== 0)
  const emptyColumns = qtyColumns.length - visibleColumns.length

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <Stat label="Parts in CSV" value={totalRows.toLocaleString()} />
        <Stat label="Active columns" value={visibleColumns.length} />
        <Stat label="Movements" value={summary.totalMovements.toLocaleString()} accent />
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--hint)', marginBottom: 8 }}>
        Map each location column
      </div>

      {visibleColumns.map(col => {
        const cat = CAT_BADGE[col.category] || CAT_BADGE.other
        const mapping = columnMap[col.columnName] || 'skip'
        const isCreatingHere = creatingLocFor === col.columnName
        return (
          <div key={col.columnName} style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 6,
                background: 'var(--gray-lt)', color: cat.color, letterSpacing: '.04em',
              }}>{cat.text}</span>
              <div style={{ flex: 1, fontWeight: 700, fontSize: 13 }}>{col.locationLabel}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--orange)' }}>
                {col.total.toLocaleString()}
                <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}> across {col.nonZeroRowCount} parts</span>
              </div>
            </div>
            {!isCreatingHere ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={mapping}
                  onChange={e => pickMapping(col.columnName, e.target.value)}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 12, background: 'var(--bg)' }}
                >
                  <option value="skip">— Skip —</option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>
                      {l.assigned_user?.name || l.name} ({l.type})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    setCreatingLocFor(col.columnName)
                    setNewLocName(col.locationLabel)
                    setNewLocType(col.category === 'warehouse' ? 'warehouse'
                                : col.category === 'crew' ? 'truck'
                                : col.category === 'project' ? 'job_site'
                                : 'warehouse')
                  }}
                  style={{
                    padding: '6px 10px', borderRadius: 'var(--r-sm)',
                    border: '1.5px solid var(--teal)', background: 'var(--teal-lt)',
                    color: 'var(--teal)', fontSize: 11, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                  }}
                ><Icon name="plus" size={12} /> New</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={newLocType}
                  onChange={e => setNewLocType(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 12, background: 'var(--bg)' }}
                >
                  {['warehouse','truck','job_site','vendor','scrap'].map(t => (
                    <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                  ))}
                </select>
                <input
                  type="text"
                  value={newLocName}
                  onChange={e => setNewLocName(e.target.value)}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 12, background: 'var(--bg)' }}
                />
                <button
                  onClick={() => commitNewLocation(col.columnName)}
                  disabled={!newLocName.trim()}
                  style={{ padding: '6px 10px', borderRadius: 'var(--r-sm)', border: 'none', background: 'var(--orange)', color: 'white', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >Create</button>
                <button
                  onClick={() => setCreatingLocFor(null)}
                  style={{ padding: '6px 8px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 11 }}
                >Cancel</button>
              </div>
            )}
          </div>
        )
      })}

      {emptyColumns > 0 && (
        <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6, marginBottom: 14, fontStyle: 'italic' }}>
          {emptyColumns} column{emptyColumns === 1 ? '' : 's'} skipped automatically (zero quantity).
        </div>
      )}

      {unmatchedSkus.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8, gap: 8, flexWrap: 'wrap',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--amber)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="alert" size={13} /> {unmatchedSkus.length} SKUs not in parts catalog
            </div>
            <button
              onClick={downloadUnmatchedCsv}
              style={{
                padding: '5px 10px', borderRadius: 'var(--r-sm)',
                border: '1.5px solid var(--amber)', background: 'var(--amber-lt)',
                color: 'var(--amber)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            ><Icon name="download" size={12} /> Download CSV</button>
          </div>

          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10,
            padding: '10px 12px', borderRadius: 'var(--r-sm)',
            border: `1.5px solid ${autoCreateDrafts ? 'var(--teal)' : 'var(--border2)'}`,
            background: autoCreateDrafts ? 'var(--teal-lt)' : 'var(--surface)',
            cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={autoCreateDrafts}
              onChange={e => setAutoCreateDrafts(e.target.checked)}
              style={{ marginTop: 2, cursor: 'pointer' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: autoCreateDrafts ? 'var(--teal)' : 'var(--text)' }}>
                Auto-create as draft parts
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                Creates {unmatchedSkus.length} parts in the catalog with{' '}
                <strong>is_active = false</strong> so the import succeeds. You can review and fix
                metadata (unit, category, etc.) afterward.
              </div>
            </div>
          </label>

          <div style={{
            maxHeight: 160, overflowY: 'auto',
            background: 'var(--amber-lt)', border: '1px solid var(--amber)',
            borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 11,
          }}>
            {unmatchedSkus.slice(0, 50).map(u => (
              <div key={u.sku} style={{ marginBottom: 2, color: 'var(--amber)' }}>
                <strong>{u.sku}</strong> — {u.name || '(no name)'} ({u.totalQty.toLocaleString()} units)
              </div>
            ))}
            {unmatchedSkus.length > 50 && (
              <div style={{ marginTop: 4, color: 'var(--amber)', fontStyle: 'italic' }}>
                …and {unmatchedSkus.length - 50} more (download CSV for the full list).
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ImportingStage({ progress }) {
  const pct = progress.total > 0 ? Math.round(progress.done / progress.total * 100) : 0
  const draftsAttempted = progress.draftsAttempted || 0
  const draftErrCount = (progress.draftErrors || []).length
  return (
    <div style={{ padding: '20px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 32, marginBottom: 6 }}>⏳</div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Importing…</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          {progress.done.toLocaleString()} of {progress.total.toLocaleString()} movements ({pct}%)
        </div>
        {draftsAttempted > 0 && (
          <div style={{ fontSize: 11, marginTop: 4, color: draftErrCount > 0 ? 'var(--amber)' : 'var(--teal)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {draftErrCount === 0
              ? <><Icon name="check" size={11} /> {`${progress.draftsCreated || 0} draft parts created`}</>
              : <><Icon name="alert" size={11} /> {`${progress.draftsCreated || 0} of ${draftsAttempted} drafts created (${draftErrCount} failed)`}</>}
          </div>
        )}
        {progress.draftFatalError && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="alert" size={11} /> Draft creation hit a fatal error — see final report
          </div>
        )}
      </div>
      <div style={{ height: 8, background: 'var(--border2)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--orange)', transition: 'width .2s' }} />
      </div>
    </div>
  )
}

// ─── Stage 3.5: review orphans ───────────────────────────────────────────────

function ReviewStage({ orphanReview, selected, onToggle, onSelectAll, onClearAll }) {
  const orphans = orphanReview?.orphans || []
  const allSelected = orphans.length > 0 && orphans.every(o => selected.has(o.part.id))

  // Live totals for the summary line, computed over the selected orphans only.
  const { deactivateCount, zeroUnits, leftAloneUnits } = useMemo(() => {
    let z = 0, left = 0, n = 0
    for (const o of orphans) {
      if (!selected.has(o.part.id)) continue
      n++
      z += o.zeroableQty
      left += Math.abs(o.otherQty)
    }
    return { deactivateCount: n, zeroUnits: z, leftAloneUnits: left }
  }, [orphans, selected])

  return (
    <div>
      <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>
        {orphans.length} active part{orphans.length === 1 ? '' : 's'} weren't in this import
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        These are active in FiberLog but their SKU wasn't in the file — usually parts accounting
        renamed or retired. Selected parts get <strong>deactivated</strong>, and their warehouse
        stock is <strong>zeroed</strong>.
      </div>

      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
        padding: '10px 12px', borderRadius: 'var(--r-sm)',
        background: 'var(--amber-lt)', border: '1px solid var(--amber)',
        fontSize: 12, color: 'var(--amber)',
      }}>
        <Icon name="alert" size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          Only do this if this CSV is a <strong>complete</strong> catalog export. A partial file
          lists every real part as an orphan.
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--hint)' }}>
          {deactivateCount} selected
        </div>
        <button
          onClick={allSelected ? onClearAll : onSelectAll}
          style={{
            padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border2)',
          }}
        >
          {allSelected ? 'Deselect all' : `Select all ${orphans.length}`}
        </button>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', marginBottom: 12 }}>
        {orphans.map((o, i) => {
          const isSel = selected.has(o.part.id)
          const hasOther = o.otherQty !== 0
          return (
            <label key={o.part.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer',
              borderBottom: i < orphans.length - 1 ? '1px solid var(--row-divider)' : 'none',
              background: isSel ? 'var(--selected-row)' : 'transparent',
            }}>
              <input type="checkbox" checked={isSel} onChange={() => onToggle(o.part.id)} style={{ cursor: 'pointer', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.part.name}
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--hint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {o.part.id}{o.locations.length > 0 ? ` · ${o.locations.map(l => l.name).join(', ')}` : ' · no stock'}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: o.totalQty < 0 ? 'var(--red)' : 'var(--text)' }}>
                  {o.totalQty.toLocaleString()} <span style={{ fontSize: 10, color: 'var(--hint)', fontWeight: 500 }}>{o.part.unit || 'ea'}</span>
                </div>
                {hasOther && (
                  <div style={{
                    fontSize: 9.5, fontWeight: 700, color: 'var(--amber)',
                    display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 1,
                  }}>
                    <Icon name="alert" size={10} /> outside warehouse — won't zero
                  </div>
                )}
              </div>
            </label>
          )
        })}
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        Will deactivate <strong>{deactivateCount}</strong> part{deactivateCount === 1 ? '' : 's'} and
        zero <strong>{zeroUnits.toLocaleString()}</strong> units of warehouse stock.
        {leftAloneUnits > 0 && (
          <> <strong>{leftAloneUnits.toLocaleString()}</strong> units in trucks / project buckets stay as-is.</>
        )}
      </div>
    </div>
  )
}

function DoneStage({ results, sweepResult, unmatchedSkus, downloadUnmatchedCsv }) {
  if (!results) return null
  const draftErrCount = (results.draftErrors || []).length
  const hasProblem = results.errorCount > 0 || draftErrCount > 0 || results.draftFatalError || results.movementsSkippedDueToMissingParts > 0 || (sweepResult?.errorCount || 0) > 0
  return (
    <div style={{ padding: '12px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4, color: hasProblem ? 'var(--amber)' : 'var(--teal)' }}>
          <Icon name={hasProblem ? 'alert' : 'check'} size={36} />
        </div>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Import complete</div>
        <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 2, fontFamily: 'monospace' }}>build v3</div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <Stat label="Movements" value={results.created.toLocaleString()} accent />
        {results.draftsAttempted > 0 && (
          <Stat
            label="Drafts created"
            value={`${results.draftsCreated.toLocaleString()} / ${results.draftsAttempted.toLocaleString()}`}
          />
        )}
        {results.skippedSkus > 0 && (
          <Stat label="SKUs skipped" value={results.skippedSkus.toLocaleString()} />
        )}
        {results.errorCount > 0 && (
          <Stat label="Movement errors" value={results.errorCount.toLocaleString()} />
        )}
      </div>

      {sweepResult && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: sweepResult.errorCount > 0 ? 'var(--amber-lt)' : 'var(--teal-lt)',
          border: `1px solid ${sweepResult.errorCount > 0 ? 'var(--amber)' : 'var(--teal)'}`,
          borderRadius: 'var(--r-sm)', fontSize: 12,
          color: sweepResult.errorCount > 0 ? 'var(--amber)' : 'var(--teal)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="check" size={13} /> Swept {sweepResult.deactivated} orphan part{sweepResult.deactivated === 1 ? '' : 's'}
          </div>
          <div style={{ color: 'var(--muted)' }}>
            Deactivated {sweepResult.deactivated} · zeroed {sweepResult.zeroedUnits.toLocaleString()} units
            across {sweepResult.movementsCreated} warehouse movement{sweepResult.movementsCreated === 1 ? '' : 's'}.
            {sweepResult.leftAloneQty > 0 && (
              <> {sweepResult.leftAloneQty.toLocaleString()} units in trucks / project buckets were left as-is.</>
            )}
            {sweepResult.skippedParts > 0 && (
              <> <strong>{sweepResult.skippedParts}</strong> part{sweepResult.skippedParts === 1 ? '' : 's'} skipped — zeroing failed, left active (see below).</>
            )}
          </div>
          {sweepResult.errorCount > 0 && (
            <div style={{
              marginTop: 6, maxHeight: 140, overflowY: 'auto',
              fontSize: 11, fontFamily: 'monospace',
              background: 'rgba(0,0,0,0.04)', borderRadius: 'var(--r-sm)', padding: '8px',
            }}>
              {sweepResult.errors.map((e, i) => (
                <div key={i} style={{ marginBottom: 3 }}>
                  <strong>{e.part_id || e.id}</strong>: {e.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {results.draftFatalError && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--red-lt)', border: '1px solid var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--red)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="alert" size={13} /> Draft creation hit a fatal error</div>
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>{results.draftFatalError}</div>
        </div>
      )}

      {draftErrCount > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--amber-lt)', border: '1px solid var(--amber)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--amber)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 6, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="alert" size={13} /> {draftErrCount} draft part{draftErrCount === 1 ? '' : 's'} failed to create
          </div>
          <div style={{
            maxHeight: 160, overflowY: 'auto',
            fontSize: 11, fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.04)', borderRadius: 'var(--r-sm)', padding: '8px',
          }}>
            {(results.draftErrors || []).slice(0, 50).map((d, i) => (
              <div key={i} style={{ marginBottom: 3 }}>
                <strong>{d.id}</strong>: {d.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {results.movementsSkippedDueToMissingParts > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--amber-lt)', border: '1px solid var(--amber)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--amber)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>
            {results.movementsSkippedDueToMissingParts} movements skipped — parts not found in catalog after draft step
          </div>
          <div>
            These SKUs aren't in <code>parts_catalog</code>. If "auto-create drafts" was on, the draft creation step didn't actually persist them — check the draft errors block above.
          </div>
          {results.skippedSkusSample && results.skippedSkusSample.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, fontFamily: 'monospace' }}>
              Affected SKUs (sample): {results.skippedSkusSample.join(', ')}
              {results.movementsSkippedDueToMissingParts > results.skippedSkusSample.length && '…'}
            </div>
          )}
        </div>
      )}

      {results.draftsCreated > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--teal-lt)', border: '1px solid var(--teal)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--teal)',
        }}>
          <strong>{results.draftsCreated} parts</strong> were auto-created with <code>is_active = false</code>.
          Review and update their metadata (unit, category, etc.) — they'll still appear in stock totals.
        </div>
      )}

      {results.hasUnmatched && (
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={downloadUnmatchedCsv}
            style={{
              padding: '6px 12px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--amber)', background: 'var(--amber-lt)',
              color: 'var(--amber)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          ><Icon name="download" size={13} /> Download unmatched-SKUs CSV</button>
        </div>
      )}

      {results.errorCount > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>
            Failed movement rows (first 20):
          </div>
          <div style={{
            maxHeight: 200, overflowY: 'auto',
            background: 'var(--red-lt)', border: '1px solid var(--red)',
            borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 11,
          }}>
            {results.errors.map((e, i) => (
              <div key={i} style={{ marginBottom: 4, color: 'var(--red)' }}>
                <strong>{e.part_id}</strong> qty={e.qty}: {e.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, accent }) {
  return (
    <div style={{
      flex: 1, background: accent ? 'var(--orange-lt)' : 'var(--surface)',
      border: `1px solid ${accent ? 'var(--orange)' : 'var(--border)'}`,
      borderRadius: 'var(--r-sm)', padding: '8px 10px', textAlign: 'center',
    }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: accent ? 'var(--orange)' : 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 2 }}>{label}</div>
    </div>
  )
}
