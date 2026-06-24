import { useEffect, useState, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { getLocations, getStockByLocation, getAllStockGrouped, recordCrewMovement, getMyAllowedLoadDestinations, groupLocationsByAisle } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

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
//   prefillPartId  (return only) a truck part tapped from My Stock — pre-selects
//                  it + defaults qty to the full on-truck amount, so the crew
//                  skips the part picker and just confirms where it goes.
export default function CrewMovementSheet({ mode, myTruck, myStock, onClose, onComplete, prefillPartId = null }) {
  const { showToast } = useApp()

  // The "other" side of the move: source for load, destination for return.
  const [otherLocationId, setOtherLocationId] = useState('')
  const [otherLocations, setOtherLocations] = useState([])
  const [loadingLocations, setLoadingLocations] = useState(true)

  // Stock at the chosen "other" location (only meaningful for load).
  const [otherStock, setOtherStock] = useState([])
  const [loadingOtherStock, setLoadingOtherStock] = useState(false)

  // The part the crew is moving + how much.
  const [selectedPartId, setSelectedPartId] = useState(prefillPartId || null)
  // Prefill the qty to the full on-truck amount — "I'm done with this, send it
  // all back" is the common case; the crew can still edit it down.
  const [quantity, setQuantity] = useState(() => {
    if (!prefillPartId) return ''
    const row = (myStock || []).find(r => r.parts_catalog?.id === prefillPartId)
    return row ? String(row.quantity) : ''
  })
  const [notes, setNotes] = useState('')
  const [partSearch, setPartSearch] = useState('')
  // Multi-part cart. Each line snapshots one recordCrewMovement call so the
  // picker can move on without the queued lines drifting. For LOAD,
  // otherLocationId is the per-line source; for RETURN it's the shared
  // destination warehouse (re-derived from current state at submit time).
  // The part being actively configured (selectedPartId + quantity) is NOT in
  // here yet — it's folded in at Add or at Submit, so a one-part move never
  // requires an explicit Add tap.
  const [lines, setLines] = useState([])
  // By-location picker (searchable + aisle-grouped). locSearch filters; expanded
  // tracks which aisle groups are open.
  const [locSearch, setLocSearch] = useState('')
  const [expandedAisles, setExpandedAisles] = useState(() => new Set())

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  // Review-and-confirm step. confirmLines is a frozen snapshot of the effective
  // lines so the review screen + the commit use the exact same set. Shown for
  // everything except the safe fast path (single part → own truck). NOTE: the
  // shared `notes` is read live (not snapshotted) at commit — safe only because
  // its textarea lives inside the {!confirming} body and can't change while the
  // review is up. If a field is ever made editable during confirm, snapshot it.
  const [confirming, setConfirming] = useState(false)
  const [confirmLines, setConfirmLines] = useState([])

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

  // Back button: this sheet is mounted only while open (depth 1). Backdrop-tap
  // is already disabled to avoid losing input, so Back gets the same guard —
  // confirm before discarding a part/qty/notes the user has started entering.
  // Two-level back: when the review step is open, Back returns to editing
  // (no discard prompt); otherwise Back closes the sheet (with the dirty guard).
  useBackClose(confirming ? 2 : 1, () => {
    if (confirming) setConfirming(false)
    else onClose()
  }, {
    confirm: () => {
      if (confirming) return true   // stepping back out of the review — never prompt
      const dirty = !!selectedPartId || quantity.trim() !== '' || notes.trim() !== '' || lines.length > 0
      return !dirty || window.confirm('Discard this entry?')
    },
  })

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

  // Reset the picked part when the SOURCE changes — only in by-LOCATION load
  // mode, where the source is chosen independently and the old part may not
  // exist at the new location. Skip it for:
  //   • by-PART mode — pickPartAtLocation() sets the location AND the part in
  //     one tap; resetting here would race-clobber that selection (and clearing
  //     partSearch snaps the list back to the top). This was the "first tap
  //     doesn't stick / list jumps up" bug.
  //   • return mode — source is the fixed truck; changing the destination must
  //     not clear the part (also lets a prefilled My-Stock return survive).
  useEffect(() => {
    if (!isLoad || viewMode === 'by-part') return
    setSelectedPartId(null)
    setQuantity('')
    setPartSearch('')
  }, [otherLocationId, isLoad, viewMode])

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
  // Locations for the by-location picker. Label is the bare name (no warehouse
  // prefix); grouping + ordering is handled by groupLocationsByAisle in the
  // picker render below.
  const sortedLocations = useMemo(
    () => otherLocations.map(l => ({ ...l, displayLabel: l.name })),
    [otherLocations]
  )

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

  // ── Multi-part cart helpers ────────────────────────────────────────────────
  const lineKey = l => `${l.partId}|${l.otherLocationId || ''}`

  // Snapshot the part currently being configured as a cart line. Null if the
  // current selection isn't a complete, valid line.
  function currentLine() {
    if (!selectedPartId) return null
    const q = Number(quantity)
    if (!q || q <= 0) return null
    const pc = selectedPart?.parts_catalog
    return {
      partId: selectedPartId,
      partName: pc?.name || selectedPartId,
      unit: pc?.unit || null,
      qty: q,
      otherLocationId,                                   // load: source; return: shared dest
      otherLabel: otherLocations.find(l => l.id === otherLocationId)?.name || '',
      availableQty,
    }
  }

  // Merge a line into a list by (part, location): sum qty, cap at availableQty.
  function mergeLine(list, line) {
    const idx = list.findIndex(l => lineKey(l) === lineKey(line))
    if (idx < 0) return [...list, line]
    const next = [...list]
    const sum = next[idx].qty + line.qty
    const cap = next[idx].availableQty != null ? next[idx].availableQty : sum
    next[idx] = { ...next[idx], qty: Math.min(sum, cap) }
    return next
  }

  // "+ Add another": validate the current pick, push it onto the cart, reset
  // the picker for the next part.
  function handleAddLine() {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setLines(prev => mergeLine(prev, currentLine()))
    setSelectedPartId(null)
    setQuantity('')
    setPartSearch('')
    // by-part load picks a fresh source per part; by-location/return keep the
    // shared source/destination so the next part lands in the same place.
    if (isLoad && viewMode === 'by-part') setOtherLocationId('')
  }

  function removeLine(i) {
    setLines(prev => prev.filter((_, idx) => idx !== i))
  }

  // Cart + the in-progress selection (if valid), merged. This is what Submit
  // sends — so a single-part move never needs an explicit Add tap.
  function buildEffectiveLines() {
    const cur = validate() ? null : currentLine()
    return cur ? mergeLine(lines, cur) : [...lines]
  }

  // Load destination shared across all lines. NULL / own-truck = the default
  // "load → truck" path server-side; non-truck dests are gated by the RPC.
  const destForLoad = isLoad
    ? (destinationLocationId && destinationLocationId !== myTruck?.id ? destinationLocationId : null)
    : null

  // Primary action. Decides whether the move needs the review step first.
  function handlePrimary() {
    const all = buildEffectiveLines()
    if (all.length === 0) { setError(isLoad ? 'Add a part to load' : 'Add a part to return'); return }
    // Confirm everything except the safe fast path (single part → own truck).
    const needsConfirm = isReturn || all.length > 1 || (isLoad && !!destForLoad)
    if (needsConfirm && !confirming) {
      setConfirmLines(all)
      setError(null)
      setConfirming(true)
      return
    }
    runMovements(all)
  }

  async function runMovements(all) {
    setError(null)
    setSubmitting(true)

    // No crew-side batch RPC exists (record_crew_movement is per-part +
    // permission-checked), so loop. Each call commits independently — on a
    // partial failure we keep the failed lines so the crew can retry just those.
    const failed = []
    for (const line of all) {
      try {
        await recordCrewMovement({
          operation: mode,
          partId: line.partId,
          quantity: line.qty,
          // Each line goes exactly where it was snapshotted — load: its source;
          // return: the destination chosen when it was added. The shared
          // source/destination picker is locked once the cart is non-empty
          // (see the by-location "Change" guard), so every line's snapshot
          // matches what's on screen — no silent misroute.
          otherLocationId: line.otherLocationId,
          unit: line.unit || null,
          notes: notes.trim() || null,
          destinationLocationId: destForLoad,
        })
      } catch (e) {
        console.error('Movement failed:', line.partId, e)
        failed.push({ line, msg: e.message || 'failed' })
      }
    }

    setSubmitting(false)
    const okCount = all.length - failed.length

    if (failed.length === 0) {
      let target = ''
      if (isLoad && destForLoad) {
        const d = allowedDestinations.find(x => x.id === destForLoad)
        if (d) target = ' to ' + d.name
      }
      showToast(`${isLoad ? 'Loaded' : 'Returned'} ${okCount} part${okCount === 1 ? '' : 's'}${target}`)
      onComplete()
    } else {
      // Drop back to editing with only the failed lines for retry.
      setLines(failed.map(f => f.line))
      setSelectedPartId(null)
      setQuantity('')
      setConfirming(false)
      setError(`${okCount} of ${all.length} done. Failed: ` +
        failed.map(f => `${f.line.partName} (${f.msg})`).join('; '))
    }
  }

  // Human phrase for where the move is going (review screen + nowhere else).
  function destinationPhrase() {
    if (isReturn) return `to ${confirmLines[0]?.otherLabel || 'the warehouse'}`
    if (destForLoad) {
      const d = allowedDestinations.find(x => x.id === destForLoad)
      return `to ${d?.name || 'the destination'}`
    }
    return 'onto your truck'
  }

  // Current-selection validity (string error | null) — reused by the Add
  // button so validate() isn't re-run several times per render.
  const curError = validate()
  // What Submit will send: queued lines + the in-progress part (if valid).
  const effectiveCount = buildEffectiveLines().length

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        {/* Header */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name={confirming ? 'check' : (isLoad ? 'download' : 'upload')} size={18} />
            {confirming
              ? (isLoad ? 'Confirm load' : 'Confirm return')
              : (isLoad ? 'Load from warehouse' : 'Return to warehouse')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {confirming
              ? 'Double-check what you\'re moving, then confirm.'
              : (isLoad
                  ? 'Pick where you\'re grabbing parts from, then what you\'re taking.'
                  : 'Pick where you\'re dropping parts off, then what you\'re returning.')}
          </div>
        </div>

        {/* ── Review step ──────────────────────────────────────────────────── */}
        {confirming && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>
              Move {confirmLines.length} part{confirmLines.length === 1 ? '' : 's'} {destinationPhrase()}
            </div>

            {isLoad && destForLoad && (
              <div style={{
                marginBottom: 10, padding: '8px 10px',
                background: 'var(--amber-lt)', color: 'var(--amber)',
                borderRadius: 'var(--r-sm)', fontSize: 11, fontWeight: 600,
              }}>
                This records a transfer — the material counts as moved, not staged on your truck.
              </div>
            )}

            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface)' }}>
              {confirmLines.map((l, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                  borderBottom: i < confirmLines.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.partName}</div>
                    {isLoad && l.otherLabel && (
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>from {l.otherLabel}</div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, fontWeight: 700, fontSize: 14 }}>
                    <span className="mono">{l.qty.toLocaleString()}</span>{' '}
                    <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>{l.unit || 'ea'}</span>
                  </div>
                </div>
              ))}
            </div>

            {notes.trim() && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                Note: {notes.trim()}
              </div>
            )}
          </div>
        )}

        {!confirming && (<>
        {/* Mode toggle — Load only. Return mode always picks a warehouse first. */}
        {isLoad && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setViewMode('by-part')}
              style={modeBtnStyle(viewMode === 'by-part')}
            >
              <Icon name="search" size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Find a part
            </button>
            <button
              type="button"
              onClick={() => setViewMode('by-location')}
              style={modeBtnStyle(viewMode === 'by-location')}
            >
              <Icon name="pin" size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> Pick a location
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
                    <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>
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

        {/* Prefilled return — the part was tapped from My Stock, so show it up
            front; the crew just picks where it goes + confirms qty. */}
        {isReturn && prefillPartId && selectedPart && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14,
            padding: '10px 12px', background: 'var(--accent-bg)',
            border: '1px solid var(--accent-border)', borderRadius: 'var(--r-sm)',
          }}>
            <Icon name="box" size={16} color="var(--accent-dk)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {selectedPart.parts_catalog?.name || prefillPartId}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                <span className="mono">{availableQty.toLocaleString()}</span> on your truck · pick where it goes
              </div>
            </div>
          </div>
        )}

        {/* ── By-location view (Load + Return): searchable, aisle-grouped ──── */}
        {viewMode === 'by-location' && (
          <div className="field">
            <label>{isLoad ? 'Source' : 'Destination'}</label>
            {otherLocationId ? (() => {
              // Selected — compact chip + Change (reopens the picker).
              const sel = sortedLocations.find(l => l.id === otherLocationId)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1.5px solid var(--orange)', borderRadius: 'var(--r-sm)', background: 'var(--orange-lt)' }}>
                  <span style={{ display: 'inline-flex' }}>{locationIcon(sel?.type, !!sel?.assigned_to)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--orange-dk)' }}>
                    {sel?.name || '—'}
                  </span>
                  <button type="button"
                    onClick={() => { if (lines.length === 0) { setOtherLocationId(''); setLocSearch('') } }}
                    disabled={lines.length > 0}
                    title={lines.length > 0 ? 'Finish or clear the list to change' : ''}
                    style={{ background: 'none', border: 'none', color: 'var(--orange-dk)', fontWeight: 700, fontSize: 12, cursor: lines.length > 0 ? 'not-allowed' : 'pointer', opacity: lines.length > 0 ? 0.45 : 1, flexShrink: 0 }}>
                    Change
                  </button>
                </div>
              )
            })() : loadingLocations ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
            ) : otherLocations.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>No {isLoad ? 'sources' : 'warehouses'} available</div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder={`Search ${isLoad ? 'sources' : 'warehouses'}…`}
                  value={locSearch}
                  onChange={e => setLocSearch(e.target.value)}
                  autoComplete="off"
                  name="crew-movement-loc-search"
                  style={{ width: '100%', padding: '8px 12px', border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--bg)', fontSize: 14, marginBottom: 8 }}
                />
                {(() => {
                  const q = locSearch.trim().toLowerCase()
                  const filtered = q ? sortedLocations.filter(l => (l.name || '').toLowerCase().includes(q)) : sortedLocations
                  const groups = groupLocationsByAisle(filtered)
                  const searching = !!q
                  if (groups.length === 0) {
                    return <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>No matching locations</div>
                  }
                  return (
                    <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                      {groups.map(g => {
                        const open = searching || groups.length === 1 || expandedAisles.has(g.key)
                        return (
                          <div key={g.key}>
                            <button type="button"
                              onClick={() => setExpandedAisles(prev => { const n = new Set(prev); n.has(g.key) ? n.delete(g.key) : n.add(g.key); return n })}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', background: 'var(--surface2)', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                              <span style={{ display: 'inline-flex', color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><Icon name="chevron-right" size={14} /></span>
                              <span style={{ flex: 1, fontWeight: 700, fontSize: 13 }}>{g.label}</span>
                              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{g.items.length}</span>
                            </button>
                            {open && g.items.map(l => (
                              <button key={l.id} type="button"
                                onClick={() => setOtherLocationId(l.id)}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 12px 9px 22px', background: 'var(--surface)', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, color: 'var(--text)' }}>
                                <span style={{ display: 'inline-flex' }}>{locationIcon(l.type, !!l.assigned_to)}</span>
                                <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.shelfLabel}</span>
                              </button>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </>
            )}
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
        )}

        {/* + Add another — fold the current part into the cart and keep picking.
            Submitting also includes the in-progress part, so this is optional. */}
        {selectedPartId && (
          <button
            type="button"
            onClick={handleAddLine}
            disabled={!!curError}
            style={{
              width: '100%', marginBottom: 12, padding: '9px 12px',
              background: 'var(--surface2)', color: 'var(--text)',
              border: '1px dashed var(--border2)', borderRadius: 'var(--r-sm)',
              fontSize: 13, fontWeight: 600,
              cursor: curError ? 'not-allowed' : 'pointer',
              opacity: curError ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            }}
          >
            <Icon name="plus" size={14} /> Add another part
          </button>
        )}

        {/* Cart — the parts queued for this submit. */}
        {lines.length > 0 && (
          <div className="field">
            <label>{isLoad ? 'Loading' : 'Returning'} · {lines.length} part{lines.length === 1 ? '' : 's'}</label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface)' }}>
              {lines.map((l, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderBottom: i < lines.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.partName}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      <span className="mono">{l.qty.toLocaleString()}</span> {l.unit || 'ea'}
                      {isLoad && l.otherLabel ? ` · from ${l.otherLabel}` : ''}
                    </div>
                  </div>
                  <button
                    type="button" onClick={() => removeLine(i)} aria-label="Remove"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 20, lineHeight: 1, padding: '0 4px', flexShrink: 0 }}
                  >×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Note — shared across every line in this submit. */}
        {(selectedPartId || lines.length > 0) && (
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
                    : `${locationIcon(d.type, false)} ${d.name}`}
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

        </>)}

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
        {confirming ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirming(false)} disabled={submitting}>
              ← Back
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={() => runMovements(confirmLines)}
              disabled={submitting}
            >
              {submitting
                ? 'Saving…'
                : `Confirm — ${isLoad ? 'load' : 'return'} ${confirmLines.length} part${confirmLines.length === 1 ? '' : 's'}`}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={handlePrimary}
              disabled={submitting || effectiveCount === 0}
            >
              {submitting
                ? 'Saving…'
                : effectiveCount === 0
                  ? (isLoad ? 'Load' : 'Return')
                  : `${isLoad ? 'Load' : 'Return'} ${effectiveCount} part${effectiveCount === 1 ? '' : 's'}`}
            </button>
          </div>
        )}
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
