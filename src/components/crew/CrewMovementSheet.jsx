import { useEffect, useState, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { getLocations, getStockByLocation, recordCrewMovement } from '../../lib/inventory'

// Unified sheet for crew-initiated movements. Modes covered today:
//   'load'    — warehouse/bucket → my truck     (pick source, then part)
//   'return'  — my truck → warehouse            (pick destination, then part)
//
// Other operations (issue / scrap / transfer) are queued for a follow-up;
// the underlying record_crew_movement RPC already supports them.
//
// Props:
//   mode       'load' | 'return'
//   myTruck    the caller's truck location row (id, name, ...)
//   myStock    array of {quantity, parts_catalog} rows at the truck (for return)
//   onClose()  user dismissed the sheet
//   onComplete() movement saved successfully — parent should refetch
export default function CrewMovementSheet({ mode, myTruck, myStock, onClose, onComplete }) {
  const { showToast } = useApp()

  // The "other" side of the move: source for load, destination for return.
  const [otherLocationId, setOtherLocationId] = useState('')
  const [otherLocations, setOtherLocations] = useState([])
  const [loadingLocations, setLoadingLocations] = useState(true)

  // Stock at the chosen "other" location (only meaningful for load).
  const [otherStock, setOtherStock] = useState([])
  const [loadingOtherStock, setLoadingOtherStock] = useState(false)

  // The part the crew is moving + how much.
  const [selectedPartId, setSelectedPartId] = useState(null)
  const [quantity, setQuantity] = useState('')
  const [notes, setNotes] = useState('')
  const [partSearch, setPartSearch] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const isLoad = mode === 'load'
  const isReturn = mode === 'return'

  // Pull the location list once. For 'load' we want anything that can hold
  // stock and isn't a crew truck — warehouses + bins under warehouses +
  // the legacy crew-type rollup buckets, which still hold most of the
  // imported stock. For 'return' we restrict to warehouses + their bins.
  // includeBins is required so binned stock is reachable; default
  // getLocations() excludes them.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingLocations(true)
      try {
        const all = await getLocations({ includeBins: true })
        if (cancelled) return
        const filtered = all.filter(l => {
          if (l.id === myTruck?.id) return false  // can't move to/from yourself
          if (isReturn) return l.type === 'warehouse' || l.type === 'bin'
          // Load: warehouses + bins + rollup buckets (truck without assigned_to)
          if (l.type === 'warehouse') return true
          if (l.type === 'bin') return true
          if (l.type === 'truck' && !l.assigned_to) return true
          return false
        })
        setOtherLocations(filtered)
      } catch (e) {
        if (!cancelled) {
          console.error('Locations load failed:', e)
          setError('Could not load locations: ' + e.message)
        }
      } finally {
        if (!cancelled) setLoadingLocations(false)
      }
    })()
    return () => { cancelled = true }
  }, [isReturn, myTruck?.id])

  // For 'load' mode, fetch stock at the picked source. For 'return',
  // the source is the truck and we already have myStock from the parent.
  useEffect(() => {
    if (!isLoad || !otherLocationId) {
      setOtherStock([])
      return
    }
    let cancelled = false
    ;(async () => {
      setLoadingOtherStock(true)
      try {
        const s = await getStockByLocation(otherLocationId)
        if (!cancelled) setOtherStock(s)
      } catch (e) {
        if (!cancelled) {
          console.error('Source stock load failed:', e)
          setError('Could not load source stock: ' + e.message)
        }
      } finally {
        if (!cancelled) setLoadingOtherStock(false)
      }
    })()
    return () => { cancelled = true }
  }, [isLoad, otherLocationId])

  // Reset part selection when the source/destination changes — what they
  // picked may not be available at the new location.
  useEffect(() => {
    setSelectedPartId(null)
    setQuantity('')
    setPartSearch('')
  }, [otherLocationId])

  // The list of parts the crew can pick from. For 'load' it's stock at
  // the source; for 'return' it's their own truck stock. Filtered by
  // the search input.
  const partList = useMemo(() => {
    const source = isLoad ? otherStock : (myStock || [])
    if (!partSearch.trim()) return source
    const q = partSearch.trim().toLowerCase()
    return source.filter(r => {
      const pc = r.parts_catalog
      return (pc?.name || '').toLowerCase().includes(q)
          || (pc?.id || '').toLowerCase().includes(q)
    })
  }, [isLoad, otherStock, myStock, partSearch])

  // Sort + label locations so bins cluster under their parent warehouse
  // alphabetically. Each bin's display label shows "Warehouse · Bin" so
  // the crew can tell which warehouse the bin belongs to without losing
  // selection accuracy.
  const sortedLocations = useMemo(() => {
    const byId = new Map(otherLocations.map(l => [l.id, l]))
    const groupName = l => {
      if (l.parent_location_id) {
        const parent = byId.get(l.parent_location_id)
        if (parent) return parent.name || l.name
      }
      return l.name || ''
    }
    return otherLocations.slice().sort((a, b) => {
      const gcmp = groupName(a).localeCompare(groupName(b))
      if (gcmp !== 0) return gcmp
      // Same group: parent first, then bins by name
      if ((a.parent_location_id || null) !== (b.parent_location_id || null)) {
        return a.parent_location_id ? 1 : -1
      }
      return (a.name || '').localeCompare(b.name || '')
    }).map(l => {
      const parent = l.parent_location_id ? byId.get(l.parent_location_id) : null
      return {
        ...l,
        displayLabel: parent ? `${parent.name} · ${l.name}` : l.name,
      }
    })
  }, [otherLocations])

  // Available quantity for the picked part (so we can show a max + validate).
  const selectedPart = useMemo(() => {
    if (!selectedPartId) return null
    const source = isLoad ? otherStock : (myStock || [])
    return source.find(r => r.parts_catalog?.id === selectedPartId) || null
  }, [selectedPartId, isLoad, otherStock, myStock])

  const availableQty = Number(selectedPart?.quantity || 0)

  function validate() {
    if (!otherLocationId) return isLoad ? 'Pick a source location' : 'Pick a destination warehouse'
    if (!selectedPartId) return 'Pick a part'
    const q = Number(quantity)
    if (!q || q <= 0) return 'Quantity must be greater than 0'
    if (q > availableQty) return `Only ${availableQty} available`
    return null
  }

  async function handleSubmit() {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setSubmitting(true)
    try {
      await recordCrewMovement({
        operation: mode,
        partId: selectedPartId,
        quantity: Number(quantity),
        otherLocationId,
        unit: selectedPart?.parts_catalog?.unit || null,
        notes: notes.trim() || null,
      })
      const partName = selectedPart?.parts_catalog?.name || selectedPartId
      showToast(`${isLoad ? 'Loaded' : 'Returned'} ${quantity} × ${partName}`)
      onComplete()
    } catch (e) {
      console.error('Movement failed:', e)
      setError(e.message || 'Movement failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        {/* Header */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 2 }}>
            {isLoad ? '⬇ Load from warehouse' : '↩ Return to warehouse'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {isLoad
              ? 'Pick where you\'re grabbing parts from, then what you\'re taking.'
              : 'Pick where you\'re dropping parts off, then what you\'re returning.'}
          </div>
        </div>

        {/* Step 1: pick location */}
        <div className="field">
          <label>{isLoad ? 'Source' : 'Destination'}</label>
          <select
            value={otherLocationId}
            onChange={e => setOtherLocationId(e.target.value)}
            disabled={loadingLocations}
            autoComplete="off"
            name="crew-movement-other-location"
          >
            <option value="">
              {loadingLocations
                ? 'Loading…'
                : (otherLocations.length === 0
                    ? `No ${isLoad ? 'sources' : 'warehouses'} available`
                    : `— pick ${isLoad ? 'source' : 'warehouse'} —`)}
            </option>
            {sortedLocations.map(l => (
              <option key={l.id} value={l.id}>
                {locationIcon(l.type, !!l.assigned_to)} {l.displayLabel}
              </option>
            ))}
          </select>
        </div>

        {/* Step 2: pick part (once location chosen) */}
        {otherLocationId && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 4 }}>
              Part
            </div>
            <input
              type="text"
              placeholder="Search parts…"
              value={partSearch}
              onChange={e => setPartSearch(e.target.value)}
              autoComplete="off"
              name="crew-movement-part-search"
              style={{
                width: '100%', padding: '8px 12px',
                border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
                background: 'var(--bg)', fontSize: 14, marginBottom: 6,
              }}
            />

            {(isLoad && loadingOtherStock) && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Loading stock…
              </div>
            )}

            {!loadingOtherStock && partList.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
                {isLoad ? 'No stock at this location' : 'Nothing on your truck yet'}
                {partSearch && ` matching "${partSearch}"`}
              </div>
            )}

            <div style={{
              maxHeight: 240, overflowY: 'auto',
              border: partList.length > 0 ? '1px solid var(--border)' : 'none',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
            }}>
              {partList.map((r, i) => {
                const pc = r.parts_catalog
                const qty = Number(r.quantity || 0)
                const isSel = pc?.id === selectedPartId
                return (
                  <div
                    key={pc?.id || i}
                    onClick={() => setSelectedPartId(pc?.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px',
                      borderBottom: i < partList.length - 1 ? '1px solid var(--border)' : 'none',
                      background: isSel ? 'var(--orange-lt)' : 'transparent',
                      borderLeft: isSel ? '3px solid var(--orange)' : '3px solid transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pc?.name || pc?.id}
                      </div>
                      <div className="part-id">{pc?.id}</div>
                    </div>
                    <div className="part-qty" style={{ flexShrink: 0 }}>
                      {qty.toLocaleString()} <span className="part-unit" style={{ fontWeight: 400 }}>{pc?.unit || 'ea'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Step 3: quantity (once part picked) */}
        {selectedPartId && (
          <>
            <div className="field">
              <label>
                Quantity
                {availableQty > 0 && (
                  <span style={{ marginLeft: 8, color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>
                    (max {availableQty.toLocaleString()})
                  </span>
                )}
              </label>
              <input
                type="number"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                min="0"
                max={availableQty || undefined}
                step="any"
                autoComplete="off"
                name="crew-movement-quantity"
                style={{ fontSize: 16 }}
              />
            </div>

            <div className="field">
              <label>Note (optional)</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Anything worth recording…"
                style={{ minHeight: 44 }}
                autoComplete="off"
                name="crew-movement-notes"
              />
            </div>
          </>
        )}

        {/* Error */}
        {error && (
          <div style={{
            padding: '8px 12px', marginBottom: 10,
            background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13, fontWeight: 600,
          }}>
            {error}
          </div>
        )}

        {/* Footer buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={submitting || !selectedPartId || !quantity}
          >
            {submitting ? 'Saving…' : (isLoad ? 'Load to my truck' : 'Return to warehouse')}
          </button>
        </div>
      </div>
    </div>
  )
}

function locationIcon(type, hasOwner) {
  if (type === 'warehouse') return '🏭'
  if (type === 'bin') return '🗂'
  if (type === 'truck' && !hasOwner) return '📦'  // rollup bucket
  if (type === 'truck') return '🚚'
  return ''
}
