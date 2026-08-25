import { useEffect, useState, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { getLocations, getStockByLocation, getAllStockGrouped, recordCrewMovement, getMyAllowedLoadDestinations, groupLocationsByAisle } from '../../lib/inventory'
import { getCrewTypePartRestrictions } from '../../lib/admin'
import { useBackClose } from '../../lib/backStack'
import { matchesAllTokens } from '../../lib/shared'
import { t } from '../../lib/i18n'
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
//   prefillPartId  return: a truck part tapped from My Stock — pre-selects
//                  it + defaults qty to the full on-truck amount, so the crew
//                  skips the part picker and just confirms where it goes.
//                  load: a Common-items part (installers' My Stock) — seeds
//                  the by-part search with the SKU and auto-picks it when
//                  it's stocked at a single loadable source.
export default function CrewMovementSheet({ mode, myTruck, myStock, onClose, onComplete, prefillPartId = null }) {
  const { showToast, lang, currentUser } = useApp()

  // The "other" side of the move: source for load, destination for return.
  const [otherLocationId, setOtherLocationId] = useState('')
  const [otherLocations, setOtherLocations] = useState([])
  const [loadingLocations, setLoadingLocations] = useState(true)

  // Stock at the chosen "other" location (only meaningful for load).
  const [otherStock, setOtherStock] = useState([])
  const [loadingOtherStock, setLoadingOtherStock] = useState(false)

  // The part the crew is moving + how much.
  // RETURN prefill selects the part outright (source = the truck, known).
  // LOAD prefill can't — a load needs a source location too — so it seeds
  // the by-part search with the SKU instead and auto-picks below once the
  // stock index resolves (see the prefill effect after partGroups loads).
  const [selectedPartId, setSelectedPartId] = useState(mode === 'return' && prefillPartId ? prefillPartId : null)
  // Prefill the qty to the full on-truck amount — "I'm done with this, send it
  // all back" is the common case; the crew can still edit it down.
  const [quantity, setQuantity] = useState(() => {
    if (mode !== 'return' || !prefillPartId) return ''
    const row = (myStock || []).find(r => r.parts_catalog?.id === prefillPartId)
    return row ? String(row.quantity) : ''
  })
  const [notes, setNotes] = useState('')
  const [partSearch, setPartSearch] = useState(mode === 'load' && prefillPartId ? prefillPartId : '')
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
  // Multi-select in by-part view (backlog #40): tick several (part, location)
  // rows across searches, then "＋ Add N" pushes them all into the cart at
  // qty 1 (edited inline there). Ticks deliberately SURVIVE search changes —
  // that's what kills the serial search→pick→qty→Add loop for big loadouts;
  // the sticky add-bar keeps the pending count visible so nothing is hidden.
  // Keyed `${partId}|${locationId}` → { group, loc } snapshot.
  const [ticked, setTicked] = useState(() => new Map())

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

  // crew_type × department whitelist — a client mirror of the check inside
  // record_crew_movement, so restricted parts are visibly badged in the
  // pickers instead of burning a commit-time 403 (July 2026 audit: crews
  // wasted searches on parts they could never load). null = unrestricted
  // (owner, no crew_type, no rows for this crew_type, or lookup failed —
  // fail open: the RPC stays the real enforcement).
  const [allowedDepts, setAllowedDepts] = useState(null)
  useEffect(() => {
    const ct = currentUser?.crew_type
    if (!ct || currentUser?.role === 'owner') return
    getCrewTypePartRestrictions()
      .then(rows => {
        const mine = rows.filter(r => r.crew_type === ct).map(r => r.department)
        setAllowedDepts(mine.length > 0 ? new Set(mine) : null)
      })
      .catch(e => console.warn('Whitelist load failed (badges off):', e))
  }, [currentUser?.id, currentUser?.crew_type])
  // Parts with a NULL department bypass the whitelist (matches the RPC).
  const isRestrictedDept = dept => !!(allowedDepts && dept && !allowedDepts.has(dept))

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
      const dirty = !!selectedPartId || quantity.trim() !== '' || notes.trim() !== '' || lines.length > 0 || ticked.size > 0
      return !dirty || window.confirm(t('discardEntry', lang))
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
          // Load: warehouses + bins + shared buckets — group locations and the
          // legacy rollup trucks (truck without an assigned owner).
          if (l.type === 'warehouse') return true
          if (l.type === 'bin') return true
          if (l.type === 'group') return true
          if (l.type === 'truck' && !l.assigned_to) return true
          return false
        })
        setOtherLocations(filtered)
      } catch (e) {
        if (!cancelled) {
          console.error('Locations load failed:', e)
          setError(t('errLoadLocations', lang) + e.message)
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
        // Crew can't pull from project (job_site) buckets, vendors, or scrap —
        // those are destinations/terminal, not loadable sources.
        const groups = await getAllStockGrouped({ excludeLocationId: myTruck?.id, excludeTypes: ['job_site', 'vendor', 'scrap'] })
        if (!cancelled) setPartGroups(groups)
      } catch (e) {
        if (!cancelled) {
          console.error('Stock index load failed:', e)
          setError(t('errLoadStock', lang) + e.message)
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
          setError(t('errLoadSourceStock', lang) + e.message)
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
    return source.filter(r => {
      const pc = r.parts_catalog
      return matchesAllTokens(partSearch, [pc?.name, pc?.id])
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
    if (!partSearch.trim()) return partGroups
    return partGroups.filter(p => {
      const fields = [p.name, p.nickname, p.partId, p.material_group, p.department]
      // Search across attribute values (string-typed only — numbers/booleans skipped)
      if (p.attributes && typeof p.attributes === 'object') {
        for (const v of Object.values(p.attributes)) {
          if (typeof v === 'string') fields.push(v)
        }
      }
      return matchesAllTokens(partSearch, fields)
    })
  }, [partGroups, partSearch])

  // Tap a (part, location) row in by-part view: set both states at once.
  // Pre-seeds otherStock with the single row so availableQty resolves
  // immediately — the otherLocationId effect then refreshes otherStock
  // with the full location list in the background (no flicker since the
  // selected part is already present in the pre-seed).
  function pickPartAtLocation(group, loc) {
    // Selecting a row supersedes its tick — otherwise "＋ Add" (qty 1) plus
    // the in-progress selection would MERGE at submit and double-count.
    setTicked(prev => {
      const key = `${group.partId}|${loc.locationId}`
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
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
        department: group.department,
      },
    }])
  }

  // LOAD prefill (Common items strip on My Stock): once the stock index is
  // in, auto-pick the part when it's stocked at exactly ONE loadable source
  // — the crew then only types a qty. With several sources the seeded
  // search already narrows the list to that part's location rows, so the
  // crew taps the right one; with none, the "no parts matching" empty state
  // shows the SKU (no dead end). Runs once per sheet mount.
  const [prefillApplied, setPrefillApplied] = useState(false)
  useEffect(() => {
    if (!isLoad || !prefillPartId || prefillApplied || !partGroups) return
    setPrefillApplied(true)
    const group = partGroups.find(g => g.partId === prefillPartId)
    if (!group || isRestrictedDept(group.department)) return
    if (group.locations.length === 1) pickPartAtLocation(group, group.locations[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoad, prefillPartId, prefillApplied, partGroups])

  // Available quantity for the picked part (so we can show a max + validate).
  const selectedPart = useMemo(() => {
    if (!selectedPartId) return null
    const source = isLoad ? otherStock : (myStock || [])
    return source.find(r => r.parts_catalog?.id === selectedPartId) || null
  }, [selectedPartId, isLoad, otherStock, myStock])

  const availableQty = Number(selectedPart?.quantity || 0)

  // "Parts in {dept} aren't on your crew's allowed list" — word order
  // differs between languages, so compose from pre/post keys.
  const restrictedDeptMsg = dept =>
    `${t('restrictedDeptPre', lang)} ${dept} ${t('restrictedDeptPost', lang)}`

  function validate() {
    if (!otherLocationId) return isLoad ? t('pickSource', lang) : t('pickDestWarehouse', lang)
    if (!selectedPartId) return t('pickPart', lang)
    // Whitelist re-check: covers the prefill-return path (pickers bypassed,
    // so the badge gate never ran) and the race where a part was picked
    // before the async whitelist fetch resolved. The RPC would 403 anyway —
    // this just says so before commit instead of after.
    const dept = selectedPart?.parts_catalog?.department
    if (isRestrictedDept(dept)) {
      return restrictedDeptMsg(dept)
    }
    const q = Number(quantity)
    if (!q || q <= 0) return t('qtyGtZero', lang)
    return null
  }

  // Over-draw = asking for more than the source shows on hand. Policy
  // (July 2026, backlog #17): warn loudly but ALLOW — transition-period
  // counts aren't fully trusted, the DB tolerates negative stock, and
  // negative on-hand renders red in MyStockView. The review step is
  // forced for any over-draw (see handlePrimary) so it can't slip
  // through the single-part fast path unseen. The RPC never enforced
  // availability, so this is purely a client-side policy choice.
  const curQty = Number(quantity) || 0
  const curOverDraw = !!selectedPartId && curQty > availableQty

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
      overDraw: q > availableQty,
    }
  }

  // Merge a line into a list by (part, location): sum qty. No cap —
  // over-draw is allowed (warn-but-allow, #17); recompute the flag so a
  // merged line that crosses on-hand still warns in the cart + review.
  function mergeLine(list, line) {
    const idx = list.findIndex(l => lineKey(l) === lineKey(line))
    if (idx < 0) return [...list, line]
    const next = [...list]
    const sum = next[idx].qty + line.qty
    const avail = next[idx].availableQty != null ? next[idx].availableQty : Infinity
    next[idx] = { ...next[idx], qty: sum, overDraw: sum > avail }
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

  // Inline cart-qty edit (#40 — a typo used to mean × remove + full redo).
  // Over-draw recomputes live so the amber flag + forced review stay honest.
  function setCartLineQty(i, v) {
    setLines(prev => prev.map((l, idx) => {
      if (idx !== i) return l
      const q = Number(v)
      const qty = isNaN(q) || q < 0 ? 0 : q
      const avail = l.availableQty != null ? l.availableQty : Infinity
      return { ...l, qty, overDraw: qty > avail }
    }))
  }

  // ── Multi-select (by-part view, #40) ──────────────────────────────────────
  function toggleTick(group, loc) {
    const key = `${group.partId}|${loc.locationId}`
    // Mirror of pickPartAtLocation's guard: ticking the row that's actively
    // selected hands it over to the tick (clears the selection) so the two
    // states can never both hold the same (part, location) and double-count.
    if (group.partId === selectedPartId && loc.locationId === otherLocationId && !ticked.has(key)) {
      setSelectedPartId(null)
      setQuantity('')
    }
    setTicked(prev => {
      const next = new Map(prev)
      if (next.has(key)) next.delete(key)
      else next.set(key, { group, loc })
      return next
    })
  }

  // Push every ticked (part, location) into the cart at qty 1; quantities are
  // edited inline in the cart. Merges with existing lines by (part, location).
  function addTickedToCart() {
    setLines(prev => {
      let next = prev
      for (const { group, loc } of ticked.values()) {
        next = mergeLine(next, {
          partId: group.partId,
          partName: group.name || group.partId,
          unit: group.unit || null,
          qty: 1,
          otherLocationId: loc.locationId,
          otherLabel: loc.displayLabel || loc.name || '',
          availableQty: Number(loc.qty) || 0,
          overDraw: 1 > (Number(loc.qty) || 0),
        })
      }
      return next
    })
    setTicked(new Map())
    setPartSearch('')
    setError(null)
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
    // Ticked-but-not-Added rows must never be silently dropped by a submit —
    // the crew believes they're coming. Block rather than auto-fold: their
    // quantities were never set (Add defaults them to 1 for editing).
    if (ticked.size > 0) {
      setError(`${ticked.size} ${ticked.size === 1 ? t('partOne', lang) : t('partMany', lang)} ${t('tickedPendingPost', lang)}`)
      return
    }
    const all = buildEffectiveLines()
    if (all.length === 0) { setError(isLoad ? t('addPartToLoad', lang) : t('addPartToReturn', lang)); return }
    // Inline cart edits can zero a line — never let a 0-qty movement submit.
    if (all.some(l => !l.qty || l.qty <= 0)) { setError(t('qtyGtZero', lang)); return }
    // Confirm everything except the safe fast path (single part → own
    // truck) — and ALWAYS confirm over-draw, so going negative is a
    // reviewed decision, never a fat-finger.
    const anyOverDraw = all.some(l => l.overDraw)
    const needsConfirm = isReturn || all.length > 1 || (isLoad && !!destForLoad) || anyOverDraw
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
          // Each line goes exactly where it was snapshotted — load: its source
          // (cross-bin carts are fine, every line carries its own); return:
          // the destination chosen when it was added — the shared destination
          // picker is locked once the return cart is non-empty (by-location
          // "Change" guard) so every line's snapshot matches the screen.
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
        if (d) target = ` ${t('toWord', lang)} ` + d.name
      }
      // Singular gets its own key (Spanish verb agreement: "Se cargó 1
      // parte" vs "Se cargaron 3 partes"); plural composes pre + count.
      const msg = okCount === 1
        ? t(isLoad ? 'toastLoadedOne' : 'toastReturnedOne', lang)
        : `${t(isLoad ? 'toastLoadedPre' : 'toastReturnedPre', lang)} ${okCount} ${t('partMany', lang)}`
      showToast(msg + target)
      onComplete()
    } else {
      // Drop back to editing with only the failed lines for retry.
      setLines(failed.map(f => f.line))
      setSelectedPartId(null)
      setQuantity('')
      setConfirming(false)
      setError(`${okCount} ${t('ofWord', lang)} ${all.length} ${t('doneFailedPrefix', lang)} ` +
        failed.map(f => `${f.line.partName} (${f.msg})`).join('; '))
    }
  }

  // Human phrase for where the move is going (review screen + nowhere else).
  function destinationPhrase() {
    // Fallbacks matter: a missing label would otherwise leave a dangling
    // preposition in the review heading ("Move 2 parts to").
    if (isReturn) return `${t('toWord', lang)} ${confirmLines[0]?.otherLabel || t('theWarehouseWord', lang)}`
    if (destForLoad) {
      const d = allowedDestinations.find(x => x.id === destForLoad)
      return `${t('toWord', lang)} ${d?.name || t('theDestinationWord', lang)}`
    }
    return t('ontoYourTruck', lang)
  }

  // Current-selection validity (string error | null) — reused by the Add
  // button so validate() isn't re-run several times per render.
  const curError = validate()
  // When the qty field is already showing its own red message, the Add-
  // button hint and footer hint suppress theirs — one message, one place
  // (three stacked copies of "Quantity must be greater than 0" on a phone
  // was the reviewer's fair complaint).
  const qtyErrorShown = quantity !== '' && curQty <= 0
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
              ? (isLoad ? t('confirmLoad', lang) : t('confirmReturn', lang))
              : (isLoad ? t('loadFromWarehouse', lang) : t('returnToWarehouse', lang))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {confirming
              ? t('confirmSub', lang)
              : (isLoad ? t('loadSub', lang) : t('returnSub', lang))}
          </div>
        </div>

        {/* ── Review step ──────────────────────────────────────────────────── */}
        {confirming && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>
              {t('moveWord', lang)} {confirmLines.length} {confirmLines.length === 1 ? t('partOne', lang) : t('partMany', lang)} {destinationPhrase()}
            </div>

            {isLoad && destForLoad && (
              <div style={{
                marginBottom: 10, padding: '8px 10px',
                background: 'var(--amber-lt)', color: 'var(--amber)',
                borderRadius: 'var(--r-sm)', fontSize: 11, fontWeight: 600,
              }}>
                {t('transferNotice', lang)}
              </div>
            )}

            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface)' }}>
              {confirmLines.map((l, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px',
                  borderBottom: i < confirmLines.length - 1 ? '1px solid var(--border)' : 'none',
                  background: l.overDraw ? 'var(--amber-lt)' : 'transparent',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.partName}</div>
                    {isLoad && l.otherLabel && (
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('fromWord', lang)} {l.otherLabel}</div>
                    )}
                    {l.overDraw && (
                      <div style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 700 }}>
                        {t('onlyWord', lang)} {Number(l.availableQty || 0).toLocaleString()} {t('onHandGoNegative', lang)}
                      </div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, fontWeight: 700, fontSize: 14, color: l.overDraw ? 'var(--amber)' : 'inherit' }}>
                    <span className="mono">{l.qty.toLocaleString()}</span>{' '}
                    <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12 }}>{l.unit || 'ea'}</span>
                  </div>
                </div>
              ))}
            </div>

            {notes.trim() && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                {t('notePrefix', lang)} {notes.trim()}
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
              <Icon name="search" size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> {t('findAPart', lang)}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('by-location')}
              style={modeBtnStyle(viewMode === 'by-location')}
            >
              <Icon name="pin" size={14} style={{ verticalAlign: 'middle', marginRight: 5 }} /> {t('pickALocation', lang)}
            </button>
          </div>
        )}

        {/* ── By-part view (Load only) ──────────────────────────────────── */}
        {isLoad && viewMode === 'by-part' && (
          <div style={{ marginBottom: 14 }}>
            <input
              type="text"
              placeholder={t('partSearchLong', lang)}
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
                {t('loadingStockIndex', lang)}
              </div>
            )}
            {!loadingPartGroups && partGroups && filteredGroups.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
                {partSearch
                  ? `${t('noPartsMatching', lang)} "${partSearch}"`
                  : t('noStockInSystem', lang)}
              </div>
            )}
            <div style={{
              maxHeight: 320, overflowY: 'auto',
              border: filteredGroups.length > 0 ? '1px solid var(--border)' : 'none',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface)',
            }}>
              {filteredGroups.map(group => {
                // Restricted = the crew_type whitelist would 403 this part at
                // commit. Keep it visible (so parts don't mysteriously vanish
                // from search) but greyed, badged, and unpickable.
                const restricted = isRestrictedDept(group.department)
                const singleLoc = group.locations.length === 1
                return (
                <div key={group.partId} style={{ borderBottom: '1px solid var(--border)', opacity: restricted ? 0.55 : 1 }}>
                  {/* Part header. Single-location parts pick on header tap
                      (#40) — no bin decision when there's nothing to decide;
                      the location row below stays tappable as the override. */}
                  <div
                    onClick={() => { if (!restricted && singleLoc) pickPartAtLocation(group, group.locations[0]) }}
                    title={!restricted && singleLoc ? t('tapToPickSingle', lang) : undefined}
                    style={{
                      padding: '6px 12px', background: 'var(--surface2)',
                      borderBottom: '1px solid var(--border)',
                      cursor: !restricted && singleLoc ? 'pointer' : 'default',
                    }}>
                    <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {group.name}
                      {group.nickname && (
                        <span style={{ fontWeight: 400, color: 'var(--orange)', marginLeft: 6, fontStyle: 'italic' }}>
                          {t('akaWord', lang)} {group.nickname}
                        </span>
                      )}
                      {/* Refurbished twin — so a crew loading "Wave LR" can tell the used ones from new. */}
                      {group.refurb_of && (
                        <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, background: 'var(--amber-lt)', color: 'var(--amber)', verticalAlign: '1px' }}>REFURB</span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>
                      {group.partId} · {group.totalQty.toLocaleString()} {group.unit || 'ea'} {t('acrossWord', lang)} {group.locations.length} {group.locations.length === 1 ? t('locationOne', lang) : t('locationMany', lang)}
                      {/* Badge lives on the SKU line, not the nowrap name line —
                          long part names would ellipsize it out of view at 390px. */}
                      {restricted && (
                        <span style={{
                          marginLeft: 6, fontSize: 10, fontWeight: 700, fontFamily: 'inherit',
                          padding: '1px 7px', borderRadius: 999,
                          background: 'var(--gray-lt)', color: 'var(--muted)',
                        }}>
                          {t('notLoadableForCrew', lang)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Per-location rows. Row tap = the classic single-pick
                      (fast path untouched); the checkbox queues the row for
                      a multi-add instead (#40) — tick across searches, then
                      "＋ Add N" below pushes them all into the cart. */}
                  {group.locations.map(loc => {
                    const isSel = group.partId === selectedPartId && loc.locationId === otherLocationId
                    const isTicked = ticked.has(`${group.partId}|${loc.locationId}`)
                    return (
                      <div
                        key={loc.locationId}
                        onClick={() => { if (!restricted) pickPartAtLocation(group, loc) }}
                        title={restricted ? restrictedDeptMsg(group.department) : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 12px',
                          background: isSel || isTicked ? 'var(--orange-lt)' : 'transparent',
                          borderLeft: isSel ? '3px solid var(--orange)' : '3px solid transparent',
                          cursor: restricted ? 'not-allowed' : 'pointer',
                          fontSize: 12,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isTicked}
                          disabled={restricted}
                          onChange={() => {}}
                          onClick={e => { e.stopPropagation(); if (!restricted) toggleTick(group, loc) }}
                          style={{ margin: 0, width: 18, height: 18, flexShrink: 0, cursor: restricted ? 'not-allowed' : 'pointer' }}
                        />
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
                )
              })}
            </div>
            {/* Sticky add-bar — appears once anything is ticked. Quantities
                default to 1 and are edited inline in the cart below. */}
            {ticked.size > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px', marginTop: 6,
                background: 'var(--orange-lt)', border: '1px solid var(--orange)',
                borderRadius: 'var(--r-sm)',
              }}>
                <div style={{ flex: 1, fontSize: 12, fontWeight: 700, color: 'var(--orange-dk)' }}>
                  {ticked.size} {ticked.size === 1 ? t('partOne', lang) : t('partMany', lang)}
                </div>
                <button
                  type="button"
                  onClick={() => setTicked(new Map())}
                  style={{ padding: '6px 10px', borderRadius: 'var(--r-xs)', fontSize: 11, fontWeight: 600, background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)', cursor: 'pointer' }}
                >
                  {t('clearSelection', lang)}
                </button>
                <button
                  type="button"
                  onClick={addTickedToCart}
                  style={{ padding: '6px 14px', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, background: 'var(--orange)', color: 'white', border: 'none', cursor: 'pointer' }}
                >
                  ＋ {t('addWord', lang)} {ticked.size}
                </button>
              </div>
            )}
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
                <span className="mono">{availableQty.toLocaleString()}</span> {t('onYourTruckPick', lang)}
              </div>
              {/* Prefill bypasses the pickers, so the whitelist badge has to
                  live here too — otherwise this path 403s blind at commit.
                  validate() blocks the submit; this explains why. */}
              {isRestrictedDept(selectedPart.parts_catalog?.department) && (
                <div style={{
                  marginTop: 4, display: 'inline-block',
                  fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                  background: 'var(--gray-lt)', color: 'var(--muted)',
                }}>
                  {t('notLoadableForCrew', lang)}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── By-location view (Load + Return): searchable, aisle-grouped ──── */}
        {viewMode === 'by-location' && (
          <div className="field">
            <label>{isLoad ? t('sourceLabel', lang) : t('destinationLabel', lang)}</label>
            {otherLocationId ? (() => {
              // Selected — compact chip + Change (reopens the picker).
              const sel = sortedLocations.find(l => l.id === otherLocationId)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1.5px solid var(--orange)', borderRadius: 'var(--r-sm)', background: 'var(--orange-lt)' }}>
                  <span style={{ display: 'inline-flex' }}>{locationIcon(sel?.type, !!sel?.assigned_to)}</span>
                  <span style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--orange-dk)' }}>
                    {sel?.name || '—'}
                  </span>
                  {/* Cross-bin carts are allowed for LOAD (#40): each cart line
                      snapshots its own source, so changing the shared picker
                      can't misroute queued lines. RETURN keeps the lock — its
                      lines snapshot the shared DESTINATION, and changing it
                      mid-cart would silently split the return across two
                      warehouses. */}
                  {(() => {
                    const locked = isReturn && lines.length > 0
                    return (
                      <button type="button"
                        onClick={() => { if (!locked) { setOtherLocationId(''); setLocSearch('') } }}
                        disabled={locked}
                        title={locked ? t('changeLockedTitle', lang) : ''}
                        style={{ background: 'none', border: 'none', color: 'var(--orange-dk)', fontWeight: 700, fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.45 : 1, flexShrink: 0 }}>
                        {t('change', lang)}
                      </button>
                    )
                  })()}
                </div>
              )
            })() : loadingLocations ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{t('loading', lang)}</div>
            ) : otherLocations.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>{isLoad ? t('noSourcesAvail', lang) : t('noWarehousesAvail', lang)}</div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder={isLoad ? t('searchSourcesPh', lang) : t('searchWarehousesPh', lang)}
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
                    return <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>{t('noMatchingLocations', lang)}</div>
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
              {t('partLabel', lang)}
            </div>
            <input
              type="text"
              placeholder={t('searchPartsShort', lang)}
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
                {t('loadingStockShort', lang)}
              </div>
            )}
            {!loadingOtherStock && partList.length === 0 && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
                {isLoad ? t('noStockAtLocation', lang) : t('nothingOnTruck', lang)}
                {partSearch && ` ${t('matchingWord', lang)} "${partSearch}"`}
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
                // Same whitelist badge as find-a-part mode. Applies to
                // Return too — the RPC checks the whitelist on every crew
                // operation, so a restricted part on the truck can't be
                // returned either; we mirror rather than diverge.
                const restricted = isRestrictedDept(pc?.department)
                return (
                  <div
                    key={pc?.id || i}
                    onClick={() => { if (!restricted) setSelectedPartId(pc?.id) }}
                    title={restricted ? restrictedDeptMsg(pc?.department) : undefined}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px',
                      borderBottom: i < partList.length - 1 ? '1px solid var(--border)' : 'none',
                      background: isSel ? 'var(--orange-lt)' : 'transparent',
                      borderLeft: isSel ? '3px solid var(--orange)' : '3px solid transparent',
                      cursor: restricted ? 'not-allowed' : 'pointer',
                      opacity: restricted ? 0.55 : 1,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pc?.name || pc?.id}
                      </div>
                      <div className="part-id">
                        {pc?.id}
                        {restricted && (
                          <span style={{
                            marginLeft: 6, fontSize: 10, fontWeight: 700,
                            padding: '1px 7px', borderRadius: 999,
                            background: 'var(--gray-lt)', color: 'var(--muted)',
                          }}>
                            {t('notLoadableForCrew', lang)}
                          </span>
                        )}
                      </div>
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
              {t('quantityLabel', lang)}
              <span style={{ marginLeft: 8, color: 'var(--muted)', fontWeight: 400, fontSize: 11 }}>
                {/* Negative on-hand is an expected state under warn-but-allow —
                    show the real number, not "none". */}
                {availableQty !== 0
                  ? `(${availableQty.toLocaleString()} ${t('onHandWord', lang)})`
                  : t('noneOnHand', lang)}
              </span>
            </label>
            <input
              type="number"
              value={quantity}
              onChange={e => setQuantity(e.target.value)}
              min="0"
              step="any"
              autoComplete="off"
              name="crew-movement-quantity"
              style={{
                fontSize: 16,
                borderColor: curOverDraw ? 'var(--amber)' : undefined,
              }}
            />
            {/* Live validation — never a silently-dead button. Zero/invalid
                qty is an error (blocks); over-draw is a WARNING (allowed,
                #17 warn-but-allow — review step still forces a look). */}
            {quantity !== '' && curQty <= 0 && (
              <div style={{ marginTop: 4, fontSize: 11, fontWeight: 600, color: 'var(--red)' }}>
                {t('qtyGtZero', lang)}
              </div>
            )}
            {curOverDraw && curQty > 0 && (
              <div style={{
                marginTop: 6, padding: '8px 10px',
                background: 'var(--amber-lt)', color: 'var(--amber)',
                borderRadius: 'var(--r-sm)', fontSize: 11, fontWeight: 700,
              }}>
                {/* mid/post key halves carry their own spacing/punctuation —
                    the two languages phrase the numbers differently. */}
                {isLoad
                  ? `${t('loadingVerb', lang)} ${curQty.toLocaleString()}${t('odLoadMid', lang)}${availableQty.toLocaleString()}${t('odLoadPost', lang)}`
                  : `${t('returningVerb', lang)} ${curQty.toLocaleString()}${t('odReturnMid', lang)}${availableQty.toLocaleString()}${t('odReturnPost', lang)}`}
              </div>
            )}
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
            <Icon name="plus" size={14} /> {t('addAnotherPart', lang)}
          </button>
        )}
        {/* Why Add is disabled — validation should never be a silent dead
            button (July 2026 audit). Suppressed while the qty field shows
            the same message. */}
        {selectedPartId && curError && !qtyErrorShown && (
          <div style={{ marginTop: -8, marginBottom: 12, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
            {curError}
          </div>
        )}

        {/* Cart — the parts queued for this submit. */}
        {lines.length > 0 && (
          <div className="field">
            <label>{isLoad ? t('loadingVerb', lang) : t('returningVerb', lang)} · {lines.length} {lines.length === 1 ? t('partOne', lang) : t('partMany', lang)}</label>
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden', background: 'var(--surface)' }}>
              {lines.map((l, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderBottom: i < lines.length - 1 ? '1px solid var(--border)' : 'none',
                  background: l.overDraw ? 'var(--amber-lt)' : 'transparent',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.partName}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {isLoad && l.otherLabel ? `${t('fromWord', lang)} ${l.otherLabel}` : ''}
                    </div>
                    {/* Same warn-but-allow language as the review step (#17) —
                        an inline edit that crosses on-hand must warn HERE too. */}
                    {l.overDraw && (
                      <div style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 700 }}>
                        {t('onlyWord', lang)} {Number(l.availableQty || 0).toLocaleString()} {t('onHandGoNegative', lang)}
                      </div>
                    )}
                    {(!l.qty || l.qty <= 0) && (
                      <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 600 }}>
                        {t('qtyGtZero', lang)}
                      </div>
                    )}
                  </div>
                  {/* Inline qty (#40) — a typo no longer means remove + redo. */}
                  <input
                    type="number"
                    value={l.qty === 0 ? '' : l.qty}
                    onChange={e => setCartLineQty(i, e.target.value)}
                    min="0"
                    step="any"
                    autoComplete="off"
                    name={`crew-cart-qty-${i}`}
                    style={{
                      width: 74, padding: '6px 8px', fontSize: 14, textAlign: 'right',
                      border: `1.5px solid ${l.overDraw ? 'var(--amber)' : 'var(--border2)'}`,
                      borderRadius: 'var(--r-xs)', background: 'var(--bg)', color: 'var(--text)',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0, minWidth: 20 }}>{l.unit || 'ea'}</span>
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
            <label>{t('noteOptional', lang)}</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t('movementNotePh', lang)}
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
            <label>{t('loadTo', lang)}</label>
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
                    ? `🚚 ${t('myTruckWord', lang)} (${d.name})`
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
                {t('destTransferNotice', lang)}
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
              ← {t('back', lang)}
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={() => runMovements(confirmLines)}
              disabled={submitting}
            >
              {submitting
                ? t('saving', lang)
                : `${t(isLoad ? 'confirmVerbLoad' : 'confirmVerbReturn', lang)} ${confirmLines.length} ${confirmLines.length === 1 ? t('partOne', lang) : t('partMany', lang)}`}
            </button>
          </div>
        ) : (
          <>
            {/* Why the primary button is disabled — a dead button with no
                explanation was the audit's top crew-flow complaint.
                Suppressed while the qty field shows the same message. */}
            {effectiveCount === 0 && !submitting && !qtyErrorShown && (
              <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--hint)', textAlign: 'center' }}>
                {curError && selectedPartId
                  ? curError
                  : t('pickPartQtyHint', lang)}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
                {t('cancel', lang)}
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={handlePrimary}
                disabled={submitting || effectiveCount === 0}
              >
                {submitting
                  ? t('saving', lang)
                  : effectiveCount === 0
                    ? (isLoad ? t('loadBtn', lang) : t('returnBtn', lang))
                    : `${isLoad ? t('loadBtn', lang) : t('returnBtn', lang)} ${effectiveCount} ${effectiveCount === 1 ? t('partOne', lang) : t('partMany', lang)}`}
              </button>
            </div>
          </>
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
