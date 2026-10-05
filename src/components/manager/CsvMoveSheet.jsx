import { useState, useEffect, useMemo } from 'react'
import {
  getLocations, getPartsCatalogIndex, getStockForLocations,
  recordMovementsBatch, confirmNegativeStock,
} from '../../lib/inventory'
import { downloadTextAsFile } from '../../lib/csvImport'
import { useCsvFile } from '../../lib/useCsvImport'
import {
  findMoveColumns, buildLocationIndex, buildPartFinder, locationLabel,
  parseMoveRows, applyStock, buildCsvMovePayloads, buildMoveTemplateCsv,
} from '../../lib/csvMove'
import { useBackClose } from '../../lib/backStack'
import { StatusBadge, selectStyle } from './importShared'
import { chipStyle } from './chrome'
import LocationWithBinPicker from './LocationWithBinPicker'
import Icon from '../shared/Icon'

// Move from CSV — a spreadsheet of SKU / Qty / From / To rows becomes one
// transfer per row. Main use: binning. Download the template for a location
// (every part on hand there, Qty + To blank), fill in the To column with bin
// names ("Aisle 4, shelf a2" or just "4-a2"), upload, review, apply.
// Matching rules + tests live in lib/csvMove.js.

const STATUS_MAP = {
  ready: { label: 'Ready',   color: 'var(--success-fg)', bg: 'var(--success-bg)' },
  warn:  { label: 'Check',   color: 'var(--warning-fg)', bg: 'var(--warning-bg)' },
  error: { label: 'Error',   color: 'var(--danger-fg)',  bg: 'var(--danger-bg)' },
  skip:  { label: 'Skipped', color: 'var(--muted)',      bg: 'var(--surface2)' },
}
const statusKey = s => (s === 'ok' ? 'ready' : s)

export default function CsvMoveSheet({ locations, currentUser, onClose, onApplied }) {
  // Everything active incl. bins — the index resolves bin names, and the
  // picker below needs bins per warehouse without lazy loading.
  const [allLocs, setAllLocs] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    Promise.all([getLocations({ includeBins: true }), getPartsCatalogIndex()])
      .then(([locs, cat]) => { setAllLocs(locs); setCatalog(cat) })
      .catch(e => setLoadError(e.message || String(e)))
  }, [])

  const locationsById = useMemo(() => new Map((allLocs || []).map(l => [l.id, l])), [allLocs])
  const binsByWarehouse = useMemo(() => {
    const m = {}
    for (const l of allLocs || []) {
      if (l.type === 'bin') (m[l.parent_location_id] ||= []).push(l)
    }
    return m
  }, [allLocs])

  // Source = what the template lists AND the default From for blank cells.
  // Defaults to the first warehouse's unbinned level (the binning use case).
  const [srcTopId, setSrcTopId] = useState(() => locations.find(l => l.type === 'warehouse')?.id || '')
  const [srcBinId, setSrcBinId] = useState('')
  useEffect(() => { setSrcBinId('') }, [srcTopId])
  const sourceId = srcBinId || srcTopId
  const sourceOptions = useMemo(
    () => locations.filter(l => ['warehouse', 'truck', 'group'].includes(l.type)),
    [locations]
  )

  const [templateBusy, setTemplateBusy] = useState(false)
  async function downloadTemplate() {
    const src = locationsById.get(sourceId)
    if (!src || !catalog) return
    setTemplateBusy(true)
    try {
      const rows = (await getStockForLocations([sourceId]))
        .filter(r => Number(r.quantity) > 0)
        .map(r => ({ part: catalog.byId.get(r.part_id) || { id: r.part_id }, quantity: Number(r.quantity) }))
      const label = locationLabel(src, locationsById)
      const stamp = new Date().toISOString().slice(0, 10)
      const safe = label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')
      downloadTextAsFile(`move-template_${safe}_${stamp}.csv`, buildMoveTemplateCsv(rows, label))
    } catch (e) {
      setApplyError('Template failed: ' + (e.message || e))
    } finally {
      setTemplateBusy(false)
    }
  }

  // Per-text location overrides for names that didn't match ("4-z9" → a bin).
  const [overrides, setOverrides] = useState({})
  const csv = useCsvFile({
    requiredCols: [],
    onLoaded: () => { setOverrides({}); setFilter('all'); setNotesTouched(false) },
  })
  const cols = useMemo(() => findMoveColumns(csv.csvHeaders), [csv.csvHeaders])
  const missingCols = csv.csvRows?.length
    ? [!cols.sku && 'SKU', !cols.to && 'To'].filter(Boolean)
    : []

  // SKU (guarding against spreadsheet-stripped leading zeros), then part name.
  const findPart = useMemo(() => catalog ? buildPartFinder(catalog.all) : () => null, [catalog])

  const index = useMemo(() => allLocs ? buildLocationIndex(allLocs) : null, [allLocs])
  const parsed = useMemo(() => {
    if (!index || !csv.csvRows?.length || missingCols.length) return null
    const resolveLoc = text => {
      const o = overrides[text.trim()]
      if (o && locationsById.get(o)) return { location: locationsById.get(o) }
      return index.resolve(text)
    }
    return parseMoveRows({
      rows: csv.csvRows, cols, findPart, resolveLoc,
      defaultFromId: sourceId || null, locationsById,
    })
  }, [index, csv.csvRows, cols, findPart, overrides, sourceId, locationsById, missingCols.length])

  // Stock only for the From locations the sheet actually names.
  const fromIds = useMemo(() => {
    const s = new Set()
    for (const r of parsed || []) if (r.status === 'ok' && r.from) s.add(r.from.id)
    return [...s].sort()
  }, [parsed])
  const fromKey = fromIds.join(',')
  const [stock, setStock] = useState(null)   // { key, map } — key guards stale results
  useEffect(() => {
    if (!fromIds.length) { setStock({ key: fromKey, map: new Map() }); return }
    let live = true
    getStockForLocations(fromIds)
      .then(rows => {
        if (!live) return
        const map = new Map(rows.map(r => [`${r.part_id}|${r.location_id}`, Number(r.quantity)]))
        setStock({ key: fromKey, map })
      })
      .catch(e => live && setApplyError('Could not read stock: ' + (e.message || e)))
    return () => { live = false }
  }, [fromKey])
  const stockReady = stock && stock.key === fromKey
  const resolved = useMemo(() => {
    if (!parsed || !stockReady) return null
    return applyStock(parsed, (p, l) => stock.map.get(`${p}|${l}`) || 0)
  }, [parsed, stockReady, stock])

  const counts = useMemo(() => {
    const c = { ready: 0, warn: 0, error: 0, skip: 0 }
    for (const r of resolved || []) c[statusKey(r.status)]++
    return c
  }, [resolved])

  // Distinct names the index can't resolve on its own, each fixable once for
  // every row that uses it. Checked against the raw index (not the overrides)
  // so a fixed name keeps its picker visible and can be changed again.
  const unmatched = useMemo(() => {
    const m = new Map()
    for (const r of parsed || []) {
      if (r.status === 'skip') continue
      for (const text of [r.toText, r.fromText]) {
        if (text && index.resolve(text).error) m.set(text, (m.get(text) || 0) + 1)
      }
    }
    return [...m.entries()]
  }, [parsed, index])

  const [filter, setFilter] = useState('all')
  const shown = (resolved || []).filter(r =>
    filter === 'all' ? r.status !== 'skip' : statusKey(r.status) === filter)

  const [notes, setNotes] = useState('')
  const [notesTouched, setNotesTouched] = useState(false)
  const effectiveNotes = notesTouched ? notes : (csv.fileName ? `CSV move · ${csv.fileName}` : '')

  const [submitting, setSubmitting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [applyError, setApplyError] = useState('')
  const moveCount = counts.ready + counts.warn

  useBackClose(1, onClose, {
    confirm: () => !csv.csvRows?.length || window.confirm('Discard this CSV move?'),
  })

  async function handleApply() {
    if (!currentUser?.id) { setApplyError('Not signed in'); return }
    const payloads = buildCsvMovePayloads(resolved, { userId: currentUser.id, notes: effectiveNotes.trim() })
    if (!payloads.length) return
    if (counts.error > 0 && !window.confirm(
      `${counts.error} row${counts.error === 1 ? ' has' : 's have'} errors and will be left out. Move the other ${payloads.length}?`)) return
    if (!(await confirmNegativeStock(payloads))) return
    setApplyError(''); setSubmitting(true)
    try {
      // chunk:true — one bad row can't sink its neighbors; NOT atomic, so a
      // partial failure reports what didn't land instead of throwing.
      const { inserted, errors } = await recordMovementsBatch(payloads, {
        chunk: true, onProgress: p => setProgress(p),
      })
      if (errors.length) {
        console.error('CSV move row failures:', errors)
        const sample = errors.slice(0, 3).map(e => `${e.movement?.part_id}: ${e.message}`).join('; ')
        setApplyError(`${inserted.length} moved, ${errors.length} failed (${sample}${errors.length > 3 ? '…' : ''}). ` +
          `The moved rows are recorded — fix the failed ones and upload just those.`)
        csv.clear()
        onApplied?.(inserted.length, { keepOpen: true })
        return
      }
      onApplied?.(inserted.length)
    } catch (e) {
      setApplyError(e.message || 'Move failed')
    } finally {
      setSubmitting(false); setProgress(null)
    }
  }

  const loading = !allLocs || !catalog

  return (
    // Backdrop tap does NOT dismiss — a loaded sheet is easy to lose.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 760, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Move from CSV</div>
          {!submitting && (
            <button onClick={onClose} style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><Icon name="x" size={18} /></button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12, flexShrink: 0 }}>
          One transfer per row. Columns: <strong>SKU</strong>, <strong>To</strong>, and optionally <strong>Qty</strong> (blank = everything on hand) and <strong>From</strong> (blank = the location below).
          Bins can be written in full (<em>Aisle 4, shelf a2</em>) or short (<em>4-a2</em>). Rows with a blank To are skipped.
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loadError && <ErrorBox>{loadError}</ErrorBox>}
          {loading && !loadError && <div style={{ padding: 20, color: 'var(--muted)', textAlign: 'center' }}>Loading locations + parts…</div>}

          {!loading && (
            <>
              {/* Step 1 — source + template */}
              <div style={{ padding: 10, background: 'var(--surface2)', borderRadius: 'var(--r-sm)', marginBottom: 10 }}>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Moving from (template + default From)</label>
                  <LocationWithBinPicker
                    topLevelId={srcTopId} setTopLevelId={setSrcTopId}
                    binId={srcBinId} setBinId={setSrcBinId}
                    options={sourceOptions}
                    binsByWarehouse={binsByWarehouse}
                    locations={locations}
                  />
                </div>
                <button className="btn btn-ghost" onClick={downloadTemplate} disabled={!sourceId || templateBusy}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="download" size={14} />
                  {templateBusy ? 'Building…' : 'Download template (everything on hand here)'}
                </button>
              </div>

              {/* Step 2 — upload */}
              <div style={{ marginBottom: 10, padding: 10, background: 'var(--surface2)', borderRadius: 'var(--r-sm)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <label className="btn btn-primary" style={{ cursor: 'pointer', flexShrink: 0 }}>
                  {csv.csvRows ? 'Choose a different file' : 'Upload filled-in CSV'}
                  <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                    onChange={e => { csv.handleFile(e.target.files?.[0]); e.target.value = '' }} />
                </label>
                {csv.fileName && <div style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{csv.fileName}</div>}
              </div>

              {csv.parsing && <div style={{ padding: 12, color: 'var(--muted)' }}>Reading file…</div>}
              {csv.error && <ErrorBox>{csv.error}</ErrorBox>}
              {missingCols.length > 0 && (
                <ErrorBox>CSV needs a {missingCols.join(' and a ')} column. Found: {csv.csvHeaders.join(', ') || '(none)'}</ErrorBox>
              )}
              {parsed && !resolved && <div style={{ padding: 12, color: 'var(--muted)' }}>Checking stock…</div>}

              {resolved && (
                <>
                  {/* Summary chips double as the filter */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    {[['all', `All (${resolved.length - counts.skip})`], ['ready', `Ready ${counts.ready}`],
                      ['warn', `Check ${counts.warn}`], ['error', `Errors ${counts.error}`], ['skip', `Skipped ${counts.skip}`]]
                      .map(([id, label]) => (
                        <button key={id} onClick={() => setFilter(id)} style={chipStyle(filter === id)}>{label}</button>
                      ))}
                  </div>

                  {unmatched.length > 0 && (
                    <div style={{ padding: 10, marginBottom: 10, border: '1px solid var(--amber)', borderRadius: 'var(--r-sm)', background: 'var(--amber-lt)' }}>
                      <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Locations that didn't match — pick the right one</div>
                      {unmatched.map(([text, n]) => (
                        <div key={text} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                          <div style={{ flex: '1 1 160px', fontSize: 12, fontWeight: 700, minWidth: 0 }}>
                            "{text}" <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {n} row{n === 1 ? '' : 's'}</span>
                          </div>
                          <select style={{ ...selectStyle(), flex: '2 1 220px', width: 'auto' }}
                            value={overrides[text] || ''}
                            onChange={e => setOverrides(o => ({ ...o, [text]: e.target.value }))}>
                            <option value="">Pick a location…</option>
                            <LocationOptions allLocs={allLocs} locationsById={locationsById} />
                          </select>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                    {shown.length === 0 && <div style={{ padding: 16, fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>No rows here.</div>}
                    {shown.map((r, i) => (
                      <div key={r.rowNum} style={{
                        display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px',
                        borderBottom: i < shown.length - 1 ? '1px solid var(--border)' : 'none',
                      }}>
                        <div style={{ fontSize: 10, color: 'var(--hint)', width: 28, flexShrink: 0, paddingTop: 2 }}>#{r.rowNum}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.part ? r.part.name || r.part.id : r.skuText || '—'}
                            <span style={{ color: 'var(--hint)', fontWeight: 400 }}> · {r.part?.id || r.skuText}</span>
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {r.qty != null && <strong>{Number(r.qty).toLocaleString()} {r.part?.unit || 'ea'}{r.qtyFromStock ? ' (all)' : ''} · </strong>}
                            {r.from ? locationLabel(r.from, locationsById) : (r.fromText || '?')} → {r.to ? locationLabel(r.to, locationsById) : (r.toText || '?')}
                          </div>
                          {r.message && r.status !== 'ok' && (
                            <div style={{ fontSize: 11, color: r.status === 'error' ? 'var(--red)' : r.status === 'warn' ? 'var(--amber)' : 'var(--hint)', marginTop: 2 }}>{r.message}</div>
                          )}
                        </div>
                        <StatusBadge status={statusKey(r.status)} map={STATUS_MAP} />
                      </div>
                    ))}
                  </div>

                  <div className="field" style={{ marginTop: 12 }}>
                    <label>Note on every movement</label>
                    <input value={effectiveNotes} onChange={e => { setNotes(e.target.value); setNotesTouched(true) }}
                      autoComplete="off" name="csv-move-note" />
                  </div>
                </>
              )}

              {applyError && <ErrorBox>{applyError}</ErrorBox>}
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleApply}
            disabled={submitting || !resolved || moveCount === 0}>
            {submitting
              ? (progress ? `Moving… ${progress.done}/${progress.total}` : 'Moving…')
              : `Move ${moveCount} row${moveCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ErrorBox({ children }) {
  return (
    <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
      {children}
    </div>
  )
}

// Fix-up picker options: bins grouped under their warehouse, then the other
// movable top-level locations. Regions / vendors / scrap are left out — the
// resolver rejects them anyway.
function LocationOptions({ allLocs, locationsById }) {
  const warehouses = allLocs.filter(l => l.type === 'warehouse')
  const others = allLocs.filter(l => l.type === 'truck' || l.type === 'group')
  return (
    <>
      {warehouses.map(w => (
        <optgroup key={w.id} label={w.name}>
          <option value={w.id}>{w.name} (unbinned)</option>
          {allLocs.filter(b => b.type === 'bin' && b.parent_location_id === w.id).map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </optgroup>
      ))}
      {others.length > 0 && (
        <optgroup label="Trucks + groups">
          {others.map(l => <option key={l.id} value={l.id}>{locationLabel(l, locationsById)}</option>)}
        </optgroup>
      )}
    </>
  )
}
