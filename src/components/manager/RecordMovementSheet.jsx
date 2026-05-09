import { useState, useEffect, useRef } from 'react'
import { recordMovement, searchInventoryParts, getBinsForWarehouse } from '../../lib/inventory'

const TYPES = [
  { id: 'receive',  label: 'Receive',  icon: '⬇',  hint: 'New stock from a vendor' },
  { id: 'transfer', label: 'Transfer', icon: '↔',  hint: 'Warehouse → truck or vice versa' },
  { id: 'return',   label: 'Return',   icon: '↩',  hint: 'Truck → warehouse' },
  { id: 'issue',    label: 'Issue',    icon: '⬆',  hint: 'Used in field' },
  { id: 'scrap',    label: 'Scrap',    icon: '✕',  hint: 'Damaged or written off' },
  { id: 'adjust',   label: 'Adjust',   icon: '±',  hint: 'Count correction' },
]

const ENDPOINTS = {
  receive:  { from: false, to: true,  vendor: true  },
  transfer: { from: true,  to: true                  },
  return:   { from: true,  to: true                  },
  issue:    { from: true,  to: false                 },
  scrap:    { from: true,  to: false                 },
  adjust:   { adjustDir: true                        },
}

export default function RecordMovementSheet({ locations, currentUser, onClose, onRecorded }) {
  const [type, setType] = useState('receive')
  const [partQuery, setPartQuery] = useState('')
  const [partResults, setPartResults] = useState([])
  const [selectedPart, setSelectedPart] = useState(null)
  const [quantity, setQuantity] = useState('')

  // Endpoints split into top-level + bin so a warehouse + bin combo can be
  // picked. The effective movement endpoint is bin if set, else top-level.
  const [fromTopId, setFromTopId] = useState('')
  const [fromBinId, setFromBinId] = useState('')
  const [toTopId,   setToTopId]   = useState('')
  const [toBinId,   setToBinId]   = useState('')

  // Cache bins per warehouse id so we don't refetch on every render
  const [binsByWarehouse, setBinsByWarehouse] = useState({})

  const [adjustDir, setAdjustDir] = useState('add')
  const [vendorInvoice, setVendorInvoice] = useState('')
  const [unitCost, setUnitCost] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const searchTimerRef = useRef(null)

  // Reset endpoints when type changes
  useEffect(() => {
    setFromTopId(''); setFromBinId('')
    setToTopId('');   setToBinId('')
    setError(null)
  }, [type])

  // When a top-level location is selected (from or to), fetch its bins if it
  // happens to be a warehouse. Cached to avoid re-fetching on re-renders.
  useEffect(() => { ensureBinsLoaded(fromTopId) }, [fromTopId])
  useEffect(() => { ensureBinsLoaded(toTopId)   }, [toTopId])
  async function ensureBinsLoaded(locId) {
    if (!locId) return
    const loc = locations.find(l => l.id === locId)
    if (loc?.type !== 'warehouse') return
    if (binsByWarehouse[locId] !== undefined) return  // already cached (even if [])
    try {
      const bins = await getBinsForWarehouse(locId)
      setBinsByWarehouse(prev => ({ ...prev, [locId]: bins }))
    } catch (e) {
      console.warn(`Failed to load bins for ${loc.name}:`, e)
      setBinsByWarehouse(prev => ({ ...prev, [locId]: [] }))
    }
  }
  // Clear stale bin selection when top-level changes
  useEffect(() => { setFromBinId('') }, [fromTopId])
  useEffect(() => { setToBinId('')   }, [toTopId])

  // Debounced part search
  useEffect(() => {
    if (!partQuery || partQuery.length < 2) {
      setPartResults([])
      return
    }
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
    setSelectedPart(p)
    setPartQuery('')
    setPartResults([])
  }

  // Effective endpoint ids — bin if a bin was picked, else the top-level
  const effectiveFromId = fromBinId || fromTopId
  const effectiveToId   = toBinId   || toTopId

  function validate() {
    if (!selectedPart) return 'Pick a part'
    const q = Number(quantity)
    if (!q || q <= 0) return 'Quantity must be greater than zero'

    const ep = ENDPOINTS[type]
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
      const payload = {
        movement_type: type,
        part_id: selectedPart.id,
        quantity: Number(quantity),
        unit: selectedPart.unit || 'ea',
        notes: notes.trim() || null,
        created_by: currentUser?.id,
      }
      if (type === 'adjust') {
        if (adjustDir === 'add') payload.to_location_id = effectiveToId
        else                     payload.from_location_id = effectiveFromId
      } else {
        const ep = ENDPOINTS[type]
        if (ep.from) payload.from_location_id = effectiveFromId
        if (ep.to)   payload.to_location_id   = effectiveToId
        if (ep.vendor) {
          payload.vendor_invoice = vendorInvoice.trim() || null
          payload.unit_cost = unitCost === '' ? null : Number(unitCost)
        }
      }
      await recordMovement(payload)
      onRecorded()
    } catch (e) {
      console.error('Record movement failed:', e)
      setError(e.message || 'Failed to record movement')
    } finally {
      setSubmitting(false)
    }
  }

  const ep = ENDPOINTS[type]
  const showFrom = type === 'adjust' ? adjustDir === 'remove' : !!ep.from
  const showTo   = type === 'adjust' ? adjustDir === 'add'    : !!ep.to

  // Filter locations sensibly per type
  const fromOptions = locations.filter(l => l.type !== 'vendor')
  const toOptions   = locations.filter(l => l.type !== 'scrap')

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 520 }}>
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
                <div style={{ fontSize: 16, marginBottom: 2 }}>{t.icon}</div>
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

        {/* Part picker */}
        <div className="field">
          <label>Part</label>
          {selectedPart ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 12px', background: 'var(--orange-lt)',
              border: '1.5px solid var(--orange)', borderRadius: 'var(--r-sm)'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {selectedPart.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{selectedPart.id}</div>
              </div>
              <button
                onClick={() => setSelectedPart(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--orange)', fontWeight: 700 }}
              >Change</button>
            </div>
          ) : (
            <>
              <input
                type="text"
                placeholder="Search by name or SKU…"
                value={partQuery}
                onChange={e => setPartQuery(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck="false"
                name="movement-part-search"
              />
              {partResults.length > 0 && (
                <div style={{ marginTop: 4, maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                  {partResults.map(p => (
                    <div key={p.id} onClick={() => pickPart(p)} style={{
                      padding: '8px 12px', cursor: 'pointer',
                      borderBottom: '1px solid var(--border)', background: 'var(--surface)'
                    }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--hint)' }}>{p.id}{p.category ? ` · ${p.category}` : ''}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Quantity */}
        <div className="field">
          <label>Quantity{selectedPart ? ` (${selectedPart.unit || 'ea'})` : ''}</label>
          <input
            type="number"
            min="0"
            step="any"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            placeholder="0"
          />
        </div>

        {/* From location (with optional bin sub-picker) */}
        {showFrom && (
          <div className="field">
            <label>From</label>
            <LocationWithBinPicker
              topLevelId={fromTopId} setTopLevelId={setFromTopId}
              binId={fromBinId}        setBinId={setFromBinId}
              options={fromOptions}
              binsByWarehouse={binsByWarehouse}
              locations={locations}
            />
          </div>
        )}

        {/* To location (with optional bin sub-picker) */}
        {showTo && (
          <div className="field">
            <label>To</label>
            <LocationWithBinPicker
              topLevelId={toTopId} setTopLevelId={setToTopId}
              binId={toBinId}        setBinId={setToBinId}
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
              <label>Unit cost (optional)</label>
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
          <label>Notes (optional)</label>
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
            disabled={submitting}
          >{submitting ? 'Saving…' : 'Record'}</button>
        </div>
      </div>
    </div>
  )
}

// Cascading location picker: top-level location first, then optional bin
// when the top-level is a warehouse. The "effective" id is the bin if one
// is picked, otherwise the top-level (which means "warehouse-level / unbinned").
function LocationWithBinPicker({
  topLevelId, setTopLevelId, binId, setBinId,
  options, binsByWarehouse, locations,
}) {
  const selectedTop = locations.find(l => l.id === topLevelId)
  const isWarehouse = selectedTop?.type === 'warehouse'
  const bins = isWarehouse ? (binsByWarehouse[topLevelId] || []) : []

  return (
    <div>
      <select
        value={topLevelId}
        onChange={e => setTopLevelId(e.target.value)}
        style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
      >
        <option value="">— Pick a location —</option>
        {options.map(loc => (
          <option key={loc.id} value={loc.id}>
            {loc.assigned_user?.name || loc.name} ({loc.type})
          </option>
        ))}
      </select>

      {isWarehouse && bins.length > 0 && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>↳ Bin:</span>
          <select
            value={binId}
            onChange={e => setBinId(e.target.value)}
            style={{ flex: 1, padding: '7px 10px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 13, background: 'var(--bg)' }}
          >
            <option value="">(unbinned — warehouse level)</option>
            {bins.map(b => (
              <option key={b.id} value={b.id}>📥 {b.name}</option>
            ))}
          </select>
        </div>
      )}
      {isWarehouse && bins.length === 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--hint)' }}>
          No bins under this warehouse — stock goes to the warehouse level.
        </div>
      )}
    </div>
  )
}

function dirBtn(selected) {
  return {
    flex: 1, padding: '8px 12px', borderRadius: 'var(--r-sm)',
    border: `1.5px solid ${selected ? 'var(--orange)' : 'var(--border2)'}`,
    background: selected ? 'var(--orange-lt)' : 'var(--bg)',
    color: selected ? 'var(--orange)' : 'var(--muted)',
    fontSize: 13, fontWeight: 700, cursor: 'pointer'
  }
}
