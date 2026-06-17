import { useEffect, useState, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { getLocations, getStockByLocation, getAllStockGrouped, recordCrewMovement, getMyAllowedLoadDestinations } from '../../lib/inventory'

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

  // Load-only: destination picker. Defaults to the user's own truck.
  // Owner grants additional destinations per-user via Admin → Users.
  // When the list contains only the user's truck (zero whitelist rows
  // OR the user has none), the picker is hidden and Load behaves
  // exactly as before.
  const [allowedDestinations, setAllowedDestinations] = useState([])
  const [destinationLocationId, setDestinationLocationId] = useState('')

  // Load mode supports two views: by-location (pick warehouse/bin, see parts
  // there) and by-part (search a part, see all locations stocking it). Part
  // is the default — task-driven loadouts are the common case. Return mode
  // skips the toggle (destination is always a warehouse/bin, not stock).
  const [viewMode, setViewMode] = useState(isLoad ? 'by-part' : 'by-location')
  // Stock grouped by part across all source-eligible locations. Loaded once
  // when by-part view is first opened; filtered client-side via partSearch.
  const [partGroups, setPartGroups] = useState(null)
  const [loadingPartGroups, setLoadingPartGroups] = useState(false)

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

  // Load-only: fetch the caller's allowed destinations (own truck +
  // owner-granted whitelist). Default selection = own truck. When the
  // result has only the truck, the picker is hidden and Load behaves
  // exactly as before.
  useEffect(() => {
    if (!isLoad) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await getMyAllowedLoadDestinations()
        if (cancelled) return
        setAllowedDestinations(list)
        // Default to the own-truck entry (always first when present).
        const truck = list.find(d => d.isOwnTruck)
        setDestinationLocationId(truck?.id || (list[0]?.id || ''))
      } catch (e) {
        if (!cancelled) console.warn('Load destinations load failed:', e)
      }
    })()
    return () => { cancelled = true }
  }, [isLoad])

  // Lazily fetch the all-stock-grouped index when the user first opens
  // by-part view. Cached for the sheet's lifetime — search filters happen
  // client-side. Excludes the caller's truck so they don't see it as a
  // possible source.
  //
  // Important: always clear loadingPartGroups in finally REGARDLESS of
  // cancelled. If the effect re-runs while the query is in flight (e.g.
  // myTruck?.id resolves from undefined → defined), the cleanup sets
  // cancelled=true; gating the finally on !cancelled would leave the
  // loading flag stuck true forever. Cancelled only matters for the
  // setPartGroups/setError state updates so a stale response doesn't
  // overwrite a fresher one — not for cosmetics like the spinner.
  useEffect(() => {
    if (!isLoad || viewMode !== 'by-part') return
    if (partGroups !== null) return
    let cancelled = false
    setLoadingPartGroups(true)
    ;(async () => {
      try {
        const groups = await getAllStockGrouped({ excludeLocationId: myTruck?.id })
        if (!cancelled) setPartGroups(groups)
      } catch (e) {
        if (!cancelled) {
          console.error('Stock index load failed:', e)
          setError('Could not load stock: ' + e.message)
        }
      } finally {
        setLoadingPartGroups(false)
      }
    })()
    return () => { cancelled = true }
  }, [isLoad, viewMode, partGroups, myTruck?.id])

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

  // Filter partGroups by the same search input as the by-location flow.
  // Matches name, nickname, SKU, material group, department, and ANY
  // string value in the open attributes JSON — so adding a new attribute
  // ("supplier_code": "...") makes it instantly searchable without
  // touching this function.
  const filteredGroups = useMemo(() => {
    if (!partGroups) return []
    const q = partSearch.trim().toLowerCase()
    if (!q) return partGroups
    return partGroups.filter(p => {
      if ((p.name || '').toLowerCase().includes(q)) return true
      if ((p.nickname || '').toLowerCase().includes(q)) return true
      if ((p.partId || '').toLowerCase().includes(q)) return true
      if ((p.material_group || '').toLowerCase().includes(q)) return true
      if ((p.department || '').toLowerCase().includes(q)) return true
      // Search across attribute values (string-typed only — numbers/booleans skipped)
      if (p.attributes && typeof p.attributes === 'object') {
        for (const v of Object.values(p.attributes)) {
          if (typeof v === 'string' && v.toLowerCase().includes(q)) return true
        }
      }
      return false
    })
  }, [partGroups, partSearch])

  // Tap a (part, location) row in by-part view: set both states at once.
  // Pre-seeds otherStock with the single row so availableQty resolves
  // immediately — the otherLocationId effect then refreshes otherStock
  // with the full location list in the background (no flicker since the
  // selected part is already present in the pre-seed).
  function pickPartAtLocation(group, loc) {
    setOtherLocationId(loc.locationId)
    setSelectedPartId(group.partId)
    setOtherStock([{
      quantity: loc.qty,
      parts_catalog: {
        id: group.partId,
        name: group.name,
        unit: group.unit,
        category: group.category,
        material_group: group.material_group,
      },
    }])
  }

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
      // For Load: pass the picked destination through to the RPC. NULL
      // / own-truck both default to the existing "load → truck" path
      // server-side. Non-truck destinations are gated by the RPC's
      // crew_load_destinations check.
      const destForLoad = isLoad
        ? (destinationLocationId && destinationLocationId !== myTruck?.id
            ? destinationLocationId : null)
        : null
      await recordCrewMovement({
        operation: mode,
        partId: selectedPartId,
        quantity: Number(quantity),
        otherLocationId,
        unit: selectedPart?.parts_catalog?.unit || null,
        notes: notes.trim() || null,
        destinationLocationId: destForLoad,
      })
      const partName = selectedPart?.parts_catalog?.name || selectedPartId
      // Toast tells the user where it went if not the default truck.
      let target = ''
      if (isLoad && destForLoad) {
        const d = allowedDestinations.find(x => x.id === destForLoad)
        if (d) {
          target = ' to ' + (d.parentName ? `${d.parentName} · ${d.name}` : d.name)
        }
      }
      showToast(`${isLoad ? 'Loaded' : 'Returned'} ${quantity} × ${partName}${target}`)
      onComplete()
    } catch (e) {
      console.error('Movement failed:', e)
      setError(e.message || 'Movement failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
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

        {/* Mode toggle — Load only. Return mode always picks a warehouse first. */}
        {isLoad && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setViewMode('by-part')}
              style={modeBtnStyle(viewMode === 'by-part')}
            >
              🔍 Find a part
            </button>
            <button
              type="button"
              onClick={() => setViewMode('by-location')}
              style={modeBtnStyle(viewMode === 'by-location')}
            >
              📍 Pick a location
            </button>
          </div>
        )}

        {/* ── By-part view (Load only) ──────────────────────────────────── */}
        {isLoad && viewMode === 'by-part' && (
          <div style={{ marginBottom: 14 }}>
            <input
              type="text"
              placeholder="Search parts by name, SKU, group, department…"
              value={partSearch}
              onChange={e => setPartSearch(e.target.value)}
              autoFocus
              autoComplete="off"
              name="crew-movement-part-search"
              style={{
                width: '100%', padding: '8px 12px',
                border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
                background: 'var(--bg)', fontSize: 14, marginBottom: 6,
              }}
            />
            {loadingPartGroups && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                Loading stock index…
              </div>
            )}
            {!loadingPartGroups && partGroups && filteredGroups.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
                {partSearch
                  ? `No parts matching "${partSearch}"`
                  : 'No stock in the system. Receive a PO or import inventory first.'}
              </div>
            )}
            <div style={{
              maxHeight: 320, overflowY: 'auto',
              border: filteredGroups.length > 0 ? '1px solid var(--border)' : 'none',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
            }}>
              {filteredGroups.map(group => (
                <div key={group.partId} style={{ borderBottom: '1px solid var(--border)' }}>
                  {/* Part header */}
                  <div style={{
                    padding: '6px 12px', background: 'var(--surface2)',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {group.name}
                      {group.nickname && (
                        <span style={{ fontWeight: 400, color: 'var(--orange)', marginLeft: 6, fontStyle: 'italic' }}>
                          aka {group.nickname}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
                      {group.partId} · {group.totalQty.toLocaleString()} {group.unit || 'ea'} across {group.locations.length} location{group.locations.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  {/* Per-location rows */}
                  {group.locations.map(loc => {
                    const isSel = group.partId === selectedPartId && loc.locationId === otherLocationId
                    return (
                      <div
                        key={loc.locationId}
                        onClick={() => pickPartAtLocation(group, loc)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 12px',
                          background: isSel ? 'var(--orange-lt)' : 'transparent',
                          borderLeft: isSel ? '3px solid var(--orange)' : '3px solid transparent',
                          cursor: 'pointer',
                          fontSize: 12,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {locationIcon(loc.type, loc.hasOwner)} {loc.displayLabel}
                        </div>
                        <div style={{ flexShrink: 0, fontWeight: 700 }}>
                          {loc.qty.toLocaleString()} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{group.unit || 'ea'}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── By-location view (Load + Return) ──────────────────────────── */}
        {viewMode === 'by-location' && (
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
        )}

        {/* Step 2 (by-location only): pick part. by-part already set the part on tap. */}
        {viewMode === 'by-location' && otherLocationId && (
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
              name="crew-movement-part-search-by-loc"
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

        {/* Load-only: destination picker. Hidden when the user has only
            their own truck (no whitelist) — Load behaves exactly as before. */}
        {isLoad && allowedDestinations.length > 1 && (
          <div className="field">
            <label>Load to</label>
            <select
              value={destinationLocationId}
              onChange={e => setDestinationLocationId(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              name="crew-movement-destination"
            >
              {allowedDestinations.map(d => (
                <option key={d.id} value={d.id}>
                  {d.isOwnTruck
                    ? `🚚 My truck (${d.name})`
                    : `${locationIcon(d.type, false)} ${d.parentName ? `${d.parentName} · ${d.name}` : d.name}`}
                </option>
              ))}
            </select>
            {destinationLocationId && destinationLocationId !== myTruck?.id && (
              <div style={{
                marginTop: 6, padding: '6px 10px',
                background: 'var(--amber-lt)', color: 'var(--amber)',
                borderRadius: 'var(--r-sm)', fontSize: 11, fontWeight: 600,
              }}>
                Loading directly to this location records a transfer — the
                material counts as moved, not staged on your truck.
              </div>
            )}
          </div>
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
            {submitting
              ? 'Saving…'
              : (isLoad
                  ? (destinationLocationId && destinationLocationId !== myTruck?.id
                      ? 'Load to picked location'
                      : 'Load to my truck')
                  : 'Return to warehouse')}
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

function modeBtnStyle(isActive) {
  return {
    flex: 1, padding: '8px 10px', fontSize: 13,
    border: `1.5px solid ${isActive ? 'var(--orange)' : 'var(--border2)'}`,
    borderRadius: 'var(--r-sm)',
    background: isActive ? 'var(--orange-lt)' : 'var(--surface)',
    color: isActive ? 'var(--orange-dk)' : 'var(--text)',
    fontWeight: isActive ? 700 : 500,
    cursor: 'pointer',
  }
}
