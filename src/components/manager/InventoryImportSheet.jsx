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
} from '../../lib/inventory'

const STAGES = {
  pick:      'pick',
  mapping:   'mapping',
  importing: 'importing',
  done:      'done',
}

const CHUNK_SIZE = 100

// Tag every console log so it's easy to spot in DevTools
const LOG_PREFIX = '[InventoryImport]'

export default function InventoryImportSheet({ locations, currentUser, onClose, onComplete }) {
  const { showToast } = useApp()
  const [stage, setStage] = useState(STAGES.pick)
  const [parseError, setParseError] = useState(null)

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
        const result = await createDraftParts(drafts)
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

    let created = 0
    const errors = []
    for (let i = 0; i < movementsToInsert.length; i += CHUNK_SIZE) {
      const chunk = movementsToInsert.slice(i, i + CHUNK_SIZE)
      try {
        const inserted = await recordMovementsBatch(chunk)
        created += inserted.length
      } catch (e) {
        for (const m of chunk) {
          try {
            await recordMovementsBatch([m])
            created++
          } catch (rowErr) {
            errors.push({ part_id: m.part_id, qty: m.quantity, message: rowErr.message })
          }
        }
      }
      setProgress(p => ({
        ...p,
        done: Math.min(i + chunk.length, movementsToInsert.length),
        errors,
      }))
    }

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
    setStage(STAGES.done)
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Import inventory CSV</div>
          {stage !== STAGES.importing && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
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
          {stage === STAGES.done && (
            <DoneStage
              results={results}
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
                  }}
                >＋ New</button>
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
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--amber)' }}>
              ⚠ {unmatchedSkus.length} SKUs not in parts catalog
            </div>
            <button
              onClick={downloadUnmatchedCsv}
              style={{
                padding: '5px 10px', borderRadius: 'var(--r-sm)',
                border: '1.5px solid var(--amber)', background: 'var(--amber-lt)',
                color: 'var(--amber)', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}
            >⬇ Download CSV</button>
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
          <div style={{ fontSize: 11, marginTop: 4, color: draftErrCount > 0 ? 'var(--amber)' : 'var(--teal)' }}>
            {draftErrCount === 0
              ? `✓ ${progress.draftsCreated || 0} draft parts created`
              : `⚠ ${progress.draftsCreated || 0} of ${draftsAttempted} drafts created (${draftErrCount} failed)`}
          </div>
        )}
        {progress.draftFatalError && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
            ⚠ Draft creation hit a fatal error — see final report
          </div>
        )}
      </div>
      <div style={{ height: 8, background: 'var(--border2)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--orange)', transition: 'width .2s' }} />
      </div>
    </div>
  )
}

function DoneStage({ results, unmatchedSkus, downloadUnmatchedCsv }) {
  if (!results) return null
  const draftErrCount = (results.draftErrors || []).length
  const hasProblem = results.errorCount > 0 || draftErrCount > 0 || results.draftFatalError || results.movementsSkippedDueToMissingParts > 0
  return (
    <div style={{ padding: '12px 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 36, marginBottom: 4 }}>{hasProblem ? '⚠' : '✅'}</div>
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

      {results.draftFatalError && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--red-lt)', border: '1px solid var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--red)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>⚠ Draft creation hit a fatal error</div>
          <div style={{ fontFamily: 'monospace', fontSize: 11 }}>{results.draftFatalError}</div>
        </div>
      )}

      {draftErrCount > 0 && (
        <div style={{
          marginBottom: 12, padding: '10px 14px',
          background: 'var(--amber-lt)', border: '1px solid var(--amber)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--amber)',
        }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            ⚠ {draftErrCount} draft part{draftErrCount === 1 ? '' : 's'} failed to create
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
            }}
          >⬇ Download unmatched-SKUs CSV</button>
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
