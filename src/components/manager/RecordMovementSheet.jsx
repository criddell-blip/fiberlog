import { useState, useEffect, useMemo, useRef } from 'react'
import {
  recordMovementsBatch,
  searchInventoryParts,
  getBinsForWarehouse,
  getPartLocations,
  compareNamesNatural,
  confirmNegativeStock,
} from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'
import LocationWithBinPicker from './LocationWithBinPicker'

const TYPES = [
  { id: 'receive',  label: 'Receive',  iconName: 'download', hint: 'New stock from a vendor' },
  { id: 'transfer', label: 'Transfer', iconName: 'move',     hint: 'Warehouse → truck or vice versa' },
  { id: 'return',   label: 'Return',   iconName: 'rotate',   hint: 'Truck → warehouse' },
  { id: 'issue',    label: 'Issue',    iconName: 'upload',   hint: 'Used in field' },
  { id: 'scrap',    label: 'Scrap',    iconName: 'trash',    hint: 'Damaged or written off' },
  { id: 'adjust',   label: 'Adjust',   iconName: 'sliders',  hint: 'Count correction' },
]

const ENDPOINTS = {
  receive:  { from: false, to: true,  vendor: true  },
  transfer: { from: true,  to: true                  },
  return:   { from: true,  to: true                  },
  issue:    { from: true,  to: false                 },
  scrap:    { from: true,  to: false                 },
  adjust:   { adjustDir: true                        },
}

// Manager's free-form movement entry sheet. Multi-part: pick a movement
// type and From/To, then add as many (part, qty) lines as needed —
// submit fans out to N inventory_movements rows in one batch.
//
// "Smart From" filter: once any parts are added, the From picker shows
// only locations where at least one of the picked parts has logged
// stock, with an N/M badge per row. Override toggle restores the
// "show every location" picker for edge cases (adjust movements that
// genuinely create stock somewhere FiberLog hasn't seen the part at).
export default function RecordMovementSheet({ locations, currentUser, onClose, onRecorded }) {
  const [type, setType] = useState('receive')

  // Part search + multi-line state. Each line = one movement at submit.
  const [partQuery, setPartQuery] = useState('')
  const [partResults, setPartResults] = useState([])
  // IDs ticked in the current search-results dropdown. Reset on every
  // new query so a stale selection from a previous search can't leak in.
  const [selectedSearchIds, setSelectedSearchIds] = useState(() => new Set())
  const [lines, setLines] = useState([])  // [{ part_id, name, unit, qty: '1' }]

  // Back closes the sheet (mounted only when open). Confirm first if any
  // movement lines have been staged.
  useBackClose(1, onClose, {
    confirm: () => lines.length === 0 || window.confirm('Discard this movement entry?'),
  })
  // Logged locations per part, keyed by part_id. Fetched on add-to-lines;
  // used by the smart From-picker to compute "N of M parts here" badges.
  const [partLocationsByPart, setPartLocationsByPart] = useState({})

  // Smart-vs-show-all From picker mode. When "show all" is true we drop
  // the part-filter and let the manager pick any non-vendor location
  // (with the standard warehouse → bin cascade).
  const [showAllFromLocations, setShowAllFromLocations] = useState(false)

  // From picker state. In smart mode `fromLocationId` is set directly
  // from the flat list. In show-all mode it's derived from the
  // cascading picker (fromTopId + fromBinId).
  const [fromLocationId, setFromLocationId] = useState('')
  const [fromTopId, setFromTopId] = useState('')
  const [fromBinId, setFromBinId] = useState('')

  // To picker stays cascading regardless (no filter applied).
  const [toTopId, setToTopId] = useState('')
  const [toBinId, setToBinId] = useState('')

  // Cache bins per warehouse id so we don't refetch on every render.
  const [binsByWarehouse, setBinsByWarehouse] = useState({})

  const [adjustDir, setAdjustDir] = useState('add')
  const [vendorInvoice, setVendorInvoice] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const searchTimerRef = useRef(null)

  // Reset endpoints + clear errors when type changes.
  useEffect(() => {
    setFromLocationId('')
    setFromTopId(''); setFromBinId('')
    setToTopId(''); setToBinId('')
    setError(null)
  }, [type])

  // When a top-level location is selected for the To picker (or for
  // show-all From), fetch its bins if it's a warehouse. Cached.
  useEffect(() => { ensureBinsLoaded(fromTopId) }, [fromTopId])
  useEffect(() => { ensureBinsLoaded(toTopId) }, [toTopId])
  async function ensureBinsLoaded(locId) {
    if (!locId) return
    const loc = locations.find(l => l.id === locId)
    if (loc?.type !== 'warehouse') return
    if (binsByWarehouse[locId] !== undefined) return
    try {
      const bins = await getBinsForWarehouse(locId)
      setBinsByWarehouse(prev => ({ ...prev, [locId]: bins }))
    } catch (e) {
      console.warn(`Failed to load bins for ${loc.name}:`, e)
      setBinsByWarehouse(prev => ({ ...prev, [locId]: [] }))
    }
  }
  // Clear stale bin selection when top-level changes.
  useEffect(() => { setFromBinId('') }, [fromTopId])
  useEffect(() => { setToBinId('') }, [toTopId])

  // Debounced part search.
  useEffect(() => {
    if (!partQuery || partQuery.length < 2) {
      setPartResults([])
      setSelectedSearchIds(new Set())
      return
    }
    // Clear stale selection whenever the query changes — a tick they
    // made for one search shouldn't bleed into the next set of results.
    setSelectedSearchIds(new Set())
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const data = await searchInventoryParts(partQuery)
        setPartResults(data)
      } catch (e) {
        console.warn('Part search failed:', e)
      }
    }, 200)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [partQuery])

  function pickPart(p) {
    setPartQuery('')
    setPartResults([])
    setSelectedSearchIds(new Set())
    // Don't add duplicates — if it's already in the list, do nothing.
    if (lines.some(l => l.part_id === p.id)) return
    setLines(prev => [...prev, {
      part_id: p.id,
      name: p.name,
      unit: p.unit || 'ea',
      qty: '1',
    }])
    // Fire the per-part location lookup in the background. Stored even
    // if it resolves zero locations — keeps the smart-from filter aware
    // that we tried.
    getPartLocations(p.id)
      .then(r => setPartLocationsByPart(prev => ({ ...prev, [p.id]: r })))
      .catch(e => console.warn(`getPartLocations(${p.id}) failed:`, e))
  }

  // Toggle a part's selection in the search-results dropdown without
  // adding it to lines yet. Used when the user wants to multi-select
  // several results and add them all in one go.
  function toggleSearchSelect(partId) {
    setSelectedSearchIds(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId)
      else next.add(partId)
      return next
    })
  }

  // Batch-add every checked search result to lines. Skips duplicates +
  // fires the per-part location lookup for each new line. Clears the
  // search after so the user can keep typing.
  function addSelectedSearchResults() {
    const toAdd = partResults.filter(p =>
      selectedSearchIds.has(p.id) && !lines.some(l => l.part_id === p.id)
    )
    if (toAdd.length === 0) {
      setSelectedSearchIds(new Set())
      return
    }
    setLines(prev => [
      ...prev,
      ...toAdd.map(p => ({
        part_id: p.id,
        name: p.name,
        unit: p.unit || 'ea',
        qty: '1',
      })),
    ])
    for (const p of toAdd) {
      getPartLocations(p.id)
        .then(r => setPartLocationsByPart(prev => ({ ...prev, [p.id]: r })))
        .catch(e => console.warn(`getPartLocations(${p.id}) failed:`, e))
    }
    setPartQuery('')
    setPartResults([])
    setSelectedSearchIds(new Set())
  }

  function removeLine(partId) {
    setLines(prev => prev.filter(l => l.part_id !== partId))
    // Don't drop partLocationsByPart — cheap to keep, useful if the user
    // re-adds the part during the same session.
  }

  function setLineQty(partId, qty) {
    setLines(prev => prev.map(l => l.part_id === partId ? { ...l, qty } : l))
  }

  // Show/hide which fields based on movement type + adjust direction.
  const ep = ENDPOINTS[type]
  const showFrom = type === 'adjust' ? adjustDir === 'remove' : !!ep.from
  const showTo = type === 'adjust' ? adjustDir === 'add' : !!ep.to

  // Smart From options: union of locations where any picked part has
  // logged stock, sorted by "most parts here" desc. Each entry carries
  // a partsHere count for the N/M badge. Falls through to "all non-vendor
  // locations" when the toggle is off OR no parts are picked yet.
  const smartFromOptions = useMemo(() => {
    if (lines.length === 0) return []
    const counter = new Map()  // locationId → count of parts present
    const labelById = new Map()  // locationId → displayLabel from getPartLocations
    for (const line of lines) {
      const pl = partLocationsByPart[line.part_id]
      if (!pl || !pl.locations) continue
      for (const loc of pl.locations) {
        // Project (job_site) buckets are accumulate-only; only the owner can
        // pull from one (to correct a mis-routed consumption).
        if (loc.type === 'job_site' && currentUser?.role !== 'owner') continue
        counter.set(loc.locationId, (counter.get(loc.locationId) || 0) + 1)
        labelById.set(loc.locationId, loc)
      }
    }
    const opts = []
    for (const [locId, count] of counter.entries()) {
      const locInfo = labelById.get(locId)
      // Make sure this location is still in the top-level locations list
      // OR is a bin under one (bins aren't in the top-level list).
      const isKnown = locations.some(l => l.id === locId) || locInfo?.type === 'bin'
      if (!isKnown) continue
      opts.push({
        id: locId,
        displayLabel: locInfo?.displayLabel || locInfo?.name || locId,
        type: locInfo?.type || 'unknown',
        partsHere: count,
      })
    }
    return opts.sort((a, b) => b.partsHere - a.partsHere || compareNamesNatural(a.displayLabel, b.displayLabel))
  }, [lines, partLocationsByPart, locations, currentUser?.role])

  const useSmartFromPicker = showFrom && !showAllFromLocations && lines.length > 0

  // Effective from-location id depending on which picker is showing.
  const effectiveFromId = useSmartFromPicker
    ? fromLocationId
    : (fromBinId || fromTopId)
  const effectiveToId = toBinId || toTopId

  // Per-line "no logged stock at the picked From" warning. Renders only
  // when From is set AND we have the part's location data loaded.
  function lineHasStockAtFrom(line) {
    if (!showFrom || !effectiveFromId) return true
    const pl = partLocationsByPart[line.part_id]
    if (!pl || !pl.locations) return true  // unknown yet — don't false-warn
    return pl.locations.some(l => l.locationId === effectiveFromId)
  }

  // To options — same flavor as before: hide scrap from destinations
  // (scrap movements use the 'scrap' type, not destination=scrap).
  const toOptions = useMemo(() => locations.filter(l => l.type !== 'scrap'), [locations])
  // Show-all From options — hide vendors (you don't transfer FROM a vendor;
  // that's `receive`). Project (job_site) buckets are accumulate-only and only
  // pullable by the owner (mis-routed-consumption correction).
  const allFromOptions = useMemo(
    () => locations.filter(l => l.type !== 'vendor' && (currentUser?.role === 'owner' || l.type !== 'job_site')),
    [locations, currentUser?.role]
  )

  function validate() {
    if (lines.length === 0) return 'Add at least one part'
    for (const l of lines) {
      const q = Number(l.qty)
      if (!q || q <= 0) return `${l.name}: quantity must be greater than zero`
    }
    if (type === 'adjust') {
      if (adjustDir === 'add' && !effectiveToId) return 'Pick a location to add to'
      if (adjustDir === 'remove' && !effectiveFromId) return 'Pick a location to remove from'
    } else {
      if (ep.from && !effectiveFromId) return 'Pick a "from" location'
      if (ep.to && !effectiveToId) return 'Pick a "to" location'
      if (ep.from && ep.to && effectiveFromId === effectiveToId) {
        return '"From" and "to" must be different locations'
      }
    }
    return null
  }

  async function handleSubmit() {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setSubmitting(true)
    try {
      // Build one movement payload per line. Shared from/to/type/notes.
      const payloads = lines.map(line => {
        const base = {
          movement_type: type,
          part_id: line.part_id,
          quantity: Number(line.qty),
          unit: line.unit || 'ea',
          notes: notes.trim() || null,
          created_by: currentUser?.id,
        }
        if (type === 'adjust') {
          if (adjustDir === 'add') base.to_location_id = effectiveToId
          else                     base.from_location_id = effectiveFromId
        } else {
          if (ep.from) base.from_location_id = effectiveFromId
          if (ep.to)   base.to_location_id = effectiveToId
          if (ep.vendor) {
            base.vendor_invoice = vendorInvoice.trim() || null
            base.unit_cost = unitCost === '' ? null : Number(unitCost)
          }
        }
        return base
      })
      // Free-form entry — any type, any direction, so it can take a location
      // negative in a single click. Warn, don't block: a real correction
      // sometimes has to pass through zero.
      if (!(await confirmNegativeStock(payloads))) { setSubmitting(false); return }
      await recordMovementsBatch(payloads)
      onRecorded(payloads.length)
    } catch (e) {
      console.error('Record movements failed:', e)
      setError(e.message || 'Failed to record movements')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Backdrop tap does NOT dismiss — prevents data loss when the user
    // misses the input/button they were aiming for. Use Cancel button.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 560 }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Record movement</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          {currentUser?.name} · {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
        </div>

        {/* Type picker */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>Movement type</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {TYPES.map(t => (
              <button key={t.id} onClick={() => setType(t.id)} style={{
                padding: '8px 6px', borderRadius: 'var(--r-sm)',
                border: `1.5px solid ${type === t.id ? 'var(--orange)' : 'var(--border2)'}`,
                background: type === t.id ? 'var(--orange-lt)' : 'var(--bg)',
                color: type === t.id ? 'var(--orange)' : 'var(--muted)',
                cursor: 'pointer', textAlign: 'center'
              }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 3 }}><Icon name={t.iconName} size={17} /></div>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{t.label}</div>
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6 }}>
            {TYPES.find(t => t.id === type)?.hint}
          </div>
        </div>

        {/* Adjust direction */}
        {type === 'adjust' && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>Direction</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setAdjustDir('add')} style={dirBtn(adjustDir === 'add')}>＋ Found extra</button>
              <button onClick={() => setAdjustDir('remove')} style={dirBtn(adjustDir === 'remove')}>− Found missing</button>
            </div>
          </div>
        )}

        {/* Parts (multi-line) */}
        <div className="field">
          <label>Parts {lines.length > 0 && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({lines.length})</span>}</label>

          {/* Existing line rows */}
          {lines.length > 0 && (
            <div style={{ marginBottom: 8, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
              {lines.map((l, i) => {
                const warn = !lineHasStockAtFrom(l)
                return (
                  <div
                    key={l.part_id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 10px',
                      background: warn ? 'var(--amber-lt)' : 'var(--surface)',
                      borderBottom: i < lines.length - 1 ? '1px solid var(--border)' : 'none',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {l.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--hint)' }}>{l.part_id}</div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={l.qty}
                      onChange={e => setLineQty(l.part_id, e.target.value)}
                      style={{
                        width: 70, padding: '5px 8px', fontSize: 13,
                        textAlign: 'right',
                        border: '1.5px solid var(--border2)', borderRadius: 'var(--r-xs)',
                        background: 'var(--bg)', color: 'var(--text)',
                      }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 22 }}>{l.unit}</span>
                    {warn && (
                      <span title="No logged stock at the picked From location" style={{
                        color: 'var(--amber)', display: 'inline-flex',
                      }}>
                        <Icon name="alert" size={14} />
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeLine(l.part_id)}
                      title="Remove"
                      style={{
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        color: 'var(--muted)', fontSize: 16, padding: '0 4px',
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Part search input */}
          <input
            type="text"
            placeholder={lines.length === 0 ? 'Search by name or SKU…' : 'Add another part…'}
            value={partQuery}
            onChange={e => setPartQuery(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            name="movement-part-search"
          />
          {partResults.length > 0 && (
            <div style={{
              marginTop: 4, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
              overflow: 'hidden', width: '100%',
              // Containment isolates the dropdown's layout from any global
              // .field cascade that might collapse flex children's widths.
              contain: 'layout',
            }}>
              {/* Results — clicking a row toggles its tick. Already-added
                  parts can't be re-ticked. Bottom bar adds everything ticked
                  in one go. Compact rows so multiple matches fit on a phone.
                  Uses CSS Grid (NOT flex) for the row so the text column is
                  guaranteed `1fr` and can't collapse to zero width — earlier
                  flex layout was being eaten by .field cascade. */}
              <div style={{ maxHeight: 200, overflowY: 'auto', overflowX: 'hidden', width: '100%' }}>
                {partResults.map(p => {
                  const alreadyAdded = lines.some(l => l.part_id === p.id)
                  const isSelected = selectedSearchIds.has(p.id)
                  return (
                    <div
                      key={p.id}
                      onClick={() => !alreadyAdded && toggleSearchSelect(p.id)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '20px 1fr',
                        alignItems: 'center', gap: 10,
                        padding: '6px 10px', minHeight: 36,
                        width: '100%', maxWidth: '100%', boxSizing: 'border-box',
                        cursor: alreadyAdded ? 'not-allowed' : 'pointer',
                        borderBottom: '1px solid var(--border)',
                        background: alreadyAdded
                          ? 'var(--surface2)'
                          : isSelected
                            ? 'var(--orange-lt)'
                            : 'var(--surface)',
                        opacity: alreadyAdded ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected && !alreadyAdded}
                        disabled={alreadyAdded}
                        onChange={() => {}}  // div handles click; satisfies controlled-input contract
                        onClick={e => e.stopPropagation()}
                        style={{ cursor: alreadyAdded ? 'not-allowed' : 'pointer', margin: 0, width: 16, height: 16 }}
                      />
                      <div style={{ minWidth: 0, overflow: 'hidden' }}>
                        <div style={{
                          fontWeight: 600, fontSize: 13,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          lineHeight: 1.25,
                          color: 'var(--text)',
                        }}>
                          {p.name}{alreadyAdded && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · added</span>}
                        </div>
                        <div style={{
                          fontSize: 11, color: 'var(--hint)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          lineHeight: 1.25,
                        }}>
                          {p.id}{p.category ? ` · ${p.category}` : ''}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* Sticky add-bar: only shows when at least one item is ticked.
                  Hidden otherwise so single-click feel is preserved when the
                  manager hasn't engaged multi-select. */}
              {selectedSearchIds.size > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px',
                  borderTop: '1px solid var(--orange)',
                  background: 'var(--orange-lt)',
                }}>
                  <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: 'var(--orange)' }}>
                    {selectedSearchIds.size} selected
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedSearchIds(new Set())}
                    style={{
                      padding: '5px 10px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                      background: 'transparent', color: 'var(--muted)',
                      border: '1px solid var(--border)', cursor: 'pointer',
                    }}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={addSelectedSearchResults}
                    style={{
                      padding: '5px 12px', borderRadius: 4, fontSize: 12, fontWeight: 700,
                      background: 'var(--orange)', color: 'white',
                      border: 'none', cursor: 'pointer',
                    }}
                  >
                    ＋ Add {selectedSearchIds.size}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* From location */}
        {showFrom && (
          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <label style={{ margin: 0 }}>From</label>
              {lines.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAllFromLocations(v => !v)
                    setFromLocationId('')
                    setFromTopId('')
                    setFromBinId('')
                  }}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontSize: 11, color: 'var(--orange)', fontWeight: 600,
                    textDecoration: 'underline',
                  }}
                >
                  {showAllFromLocations ? 'Filter to part locations' : 'Show all locations'}
                </button>
              )}
            </div>
            {useSmartFromPicker ? (
              <SmartFromPicker
                options={smartFromOptions}
                totalLines={lines.length}
                value={fromLocationId}
                onChange={setFromLocationId}
              />
            ) : (
              <LocationWithBinPicker
                topLevelId={fromTopId} setTopLevelId={setFromTopId}
                binId={fromBinId} setBinId={setFromBinId}
                options={allFromOptions}
                binsByWarehouse={binsByWarehouse}
                locations={locations}
              />
            )}
          </div>
        )}

        {/* To location (cascading; not filtered) */}
        {showTo && (
          <div className="field">
            <label>To</label>
            <LocationWithBinPicker
              topLevelId={toTopId} setTopLevelId={setToTopId}
              binId={toBinId} setBinId={setToBinId}
              options={toOptions}
              binsByWarehouse={binsByWarehouse}
              locations={locations}
            />
          </div>
        )}

        {/* Vendor metadata (receive only) */}
        {ep.vendor && (
          <>
            <div className="field">
              <label>Vendor invoice # (optional)</label>
              <input
                type="text"
                value={vendorInvoice}
                onChange={e => setVendorInvoice(e.target.value)}
                placeholder="INV-12345"
              />
            </div>
            <div className="field">
              <label>Unit cost (optional, applies to all parts)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={unitCost}
                onChange={e => setUnitCost(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </>
        )}

        {/* Notes */}
        <div className="field">
          <label>Notes (optional, applies to all parts)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ minHeight: 56 }} />
        </div>

        {error && (
          <div style={{
            padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 10
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={submitting || lines.length === 0}
          >
            {submitting
              ? 'Saving…'
              : `Record ${lines.length || ''} movement${lines.length === 1 ? '' : 's'}`.trim()}
          </button>
        </div>
      </div>
    </div>
  )
}

// Smart From picker: flat list of logged locations with N/M badge per row.
// Shown when at least one part is added and the user hasn't toggled
// "show all locations." Each option is a specific location id (could be
// a bin or a warehouse-level row).
function SmartFromPicker({ options, totalLines, value, onChange }) {
  if (options.length === 0) {
    return (
      <div style={{
        padding: '10px 12px', background: 'var(--amber-lt)',
        border: '1px solid var(--amber)', borderRadius: 'var(--r-sm)',
        fontSize: 12, color: 'var(--amber)',
      }}>
        No logged stock for these parts at any location. Tap "Show all locations" above to pick any source.
      </div>
    )
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', maxHeight: 280, overflowY: 'auto' }}>
      {options.map((opt, i) => {
        const isSelected = value === opt.id
        const isFull = opt.partsHere === totalLines
        return (
          <div
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px',
              borderBottom: i < options.length - 1 ? '1px solid var(--border)' : 'none',
              background: isSelected ? 'var(--orange-lt)' : 'transparent',
              cursor: 'pointer',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontWeight: isSelected ? 700 : 600, fontSize: 13,
                color: isSelected ? 'var(--orange)' : 'var(--text)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {opt.displayLabel}
              </div>
              <div style={{ fontSize: 10, color: 'var(--hint)', textTransform: 'uppercase' }}>
                {opt.type}
              </div>
            </div>
            <span style={{
              fontSize: 10, fontWeight: 700,
              padding: '2px 8px', borderRadius: 10,
              background: isFull ? 'var(--teal-lt)' : 'var(--surface2)',
              color: isFull ? 'var(--teal-dk)' : 'var(--muted)',
              border: `1px solid ${isFull ? 'var(--teal)' : 'var(--border)'}`,
              whiteSpace: 'nowrap',
            }}>
              {opt.partsHere}/{totalLines} parts{isFull ? ' ✓' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// Cascading location picker: top-level location first, then optional bin
// when the top-level is a warehouse. The "effective" id is the bin if one
// is picked, otherwise the top-level (which means "warehouse-level / unbinned").
function dirBtn(selected) {
  return {
    flex: 1, padding: '8px 12px', borderRadius: 'var(--r-sm)',
    border: `1.5px solid ${selected ? 'var(--orange)' : 'var(--border2)'}`,
    background: selected ? 'var(--orange-lt)' : 'var(--bg)',
    color: selected ? 'var(--orange)' : 'var(--muted)',
    fontSize: 13, fontWeight: 700, cursor: 'pointer'
  }
}
