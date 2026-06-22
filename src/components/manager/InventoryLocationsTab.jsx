import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import {
  createLocation, updateLocation, deactivateLocation, deactivateLocationWithRecovery,
  getBinsForWarehouse, getStockCountsByLocation, getStockByLocation,
} from '../../lib/inventory'
import BinLabelSheet from '../cycleCount/BinLabelSheet'
import AisleSignSheet from './AisleSignSheet'
import LocationDetailPanel from './LocationDetailPanel'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Console line-icon per location type (the header rows use this instead of emoji).
const TYPE_ICON_NAME = {
  warehouse: 'warehouse',
  truck:     'truck',
  job_site:  'pin',
  vendor:    'warehouse',
  scrap:     'x',
  bin:       'box',
}

// Unified Console action chip for the location row buttons.
function locActionChip() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, fontWeight: 600, color: 'var(--muted)',
    background: 'var(--surface)', border: '1px solid var(--border2)',
    borderRadius: 8, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
  }
}

const TYPE_LABELS = {
  warehouse: 'Warehouse',
  truck:     'Truck',
  job_site:  'Job site',
  vendor:    'Vendor',
  scrap:     'Scrap',
  bin:       'Bin',
}

const TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

export default function InventoryLocationsTab({ locations, loading, onChanged, onJumpToStock, onJumpToCount, onJumpToPart, focusJump, refreshKey }) {
  const { users, showToast, currentUser, isQtyPaused } = useApp()
  // Retire (deactivate) is owner-only. Managers can do everything else
  // — edit attrs, add bins, jump to stock — but retiring a location is
  // a destructive-by-default action since it removes the location from
  // every UI filter and pulldown system-wide. UI gate only; if you want
  // server-side enforcement later, add an RLS policy on
  // inventory_locations.is_active that requires is_staff() AND owner role.
  const isOwner = currentUser?.role === 'owner'
  const [editing, setEditing] = useState(null)        // location being edited (or 'new')
  const [addingBinFor, setAddingBinFor] = useState(null)  // warehouse object when adding a bin
  const [labelsFor, setLabelsFor] = useState(null)    // warehouse object when printing bin labels
  const [aisleSignsFor, setAisleSignsFor] = useState(null)  // warehouse object when printing aisle signage
  const [detailFor, setDetailFor] = useState(null)    // any location when opening the drill-in detail panel
  const [saving, setSaving] = useState(false)

  // Bins per warehouse — fetched separately since bins aren't included in
  // the top-level locations prop. Keyed by warehouse id.
  const [binsByWarehouse, setBinsByWarehouse] = useState({})
  const [loadingBins, setLoadingBins] = useState(false)

  // Stock summary counts per location id. Refreshed alongside locations
  // and after any movement (refreshKey bumps).
  const [stockCounts, setStockCounts] = useState(() => new Map())

  // Warehouse + aisle collapse state. With 165+ bins under Main Warehouse,
  // a flat expanded list is a scroll wall. Default: all warehouses and
  // aisles collapsed. User expands the warehouse → sees aisle headers
  // grouped by the "Aisle X" prefix on bin names → expands a specific
  // aisle to see its bins. "Other" group catches Bulk Pipe Storage,
  // Aisle 1 bay 12, anything that doesn't match the pattern.
  const [expandedWarehouses, setExpandedWarehouses] = useState(() => new Set())
  const [expandedAisles, setExpandedAisles] = useState(() => new Set())
  // Section-level collapse: each top-level type (warehouse/truck/job_site/
  // vendor/scrap) can be folded so the page isn't a 30-row wall. Default
  // all collapsed for consistency with the warehouse/aisle pattern — counts
  // in the header tell you what's there without expanding. User clicks
  // what they actually want to look at.
  const [expandedSections, setExpandedSections] = useState(() => new Set())
  function toggleSection(type) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type); else next.add(type)
      return next
    })
  }

  function toggleWarehouse(id) {
    setExpandedWarehouses(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleAisle(key) {
    setExpandedAisles(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  // Group bins by the "Aisle X" prefix on their name. Returns sorted
  // groups: numbered aisles ascending, then "Other" at the bottom.
  function groupBinsByAisle(bins) {
    const map = new Map()
    for (const bin of bins) {
      const m = (bin.name || '').match(/^Aisle\s+(\S+?)\s*[,/]/i)
      const key = m ? m[1] : 'other'
      const label = m ? `Aisle ${m[1]}` : 'Other'
      if (!map.has(key)) {
        map.set(key, { key, label, bins: [], sortKey: m ? (parseInt(m[1], 10) || 999) : 9999 })
      }
      map.get(key).bins.push(bin)
    }
    return Array.from(map.values()).sort((a, b) => a.sortKey - b.sortKey)
  }

  // Retire-with-recovery modal state. When `retiring` is set, we load the
  // location's current stock and offer per-part recovery into another
  // location. selectedParts shape mirrors ProjectManager's decommission
  // modal: { [partId]: { selected, qty, name, unit } }.
  const [retiring, setRetiring] = useState(null)
  const [retireStock, setRetireStock] = useState([])
  const [retireSelectedParts, setRetireSelectedParts] = useState({})
  const [retireDestinationId, setRetireDestinationId] = useState('')
  const [retireLoading, setRetireLoading] = useState(false)
  const [retireSaving, setRetireSaving] = useState(false)

  // Back closes whichever overlay is open (behaves like each one's Cancel).
  // detailFor / label / aisle-sign render self-registering sheets, so they're
  // not listed here.
  useBackClose(editing ? 1 : 0, () => setEditing(null))
  useBackClose(addingBinFor ? 1 : 0, () => setAddingBinFor(null))
  useBackClose(retiring ? 1 : 0, () => setRetiring(null))

  useEffect(() => {
    let cancelled = false
    getStockCountsByLocation()
      .then(m => { if (!cancelled) setStockCounts(m) })
      .catch(e => console.warn('Stock counts failed:', e))
    return () => { cancelled = true }
  }, [locations, refreshKey])

  // Launcher / cross-link focus. When the user picks a location in the
  // launcher, open its detail panel — that's the natural "look at this
  // location" view (parts inside, actions, etc.) and avoids the row-
  // scroll-in-hierarchy problem when bins are nested inside collapsed
  // aisle groups. Resolves bins via the per-warehouse bin map since
  // bins aren't in the top-level `locations` prop.
  //
  // Gates: wait for `locations` to be loaded + use a processedJumpRef to
  // avoid re-trigger when locations/binsByWarehouse change for unrelated
  // reasons (refresh after a CRUD action). Same pattern as InventoryPartsTab.
  const processedFocusRef = useRef(-1)
  useEffect(() => {
    if (!focusJump || !focusJump.locationId) return
    if (locations.length === 0) return  // wait for the initial load
    if (focusJump.n === processedFocusRef.current) return  // already handled
    const target = locations.find(l => l.id === focusJump.locationId)
      || Object.values(binsByWarehouse).flat().find(l => l.id === focusJump.locationId)
    if (!target) return  // bin not loaded yet — keep ref unmarked so we retry when bins arrive
    processedFocusRef.current = focusJump.n
    setDetailFor(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusJump?.n, locations.length, binsByWarehouse])

  // Refresh bin lists whenever the locations prop changes — covers both
  // warehouse adds/removes and our own bin operations
  useEffect(() => {
    refreshAllBins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locations])

  async function refreshAllBins() {
    const warehouses = locations.filter(l => l.type === 'warehouse' && l.is_active !== false)
    if (warehouses.length === 0) {
      setBinsByWarehouse({})
      return
    }
    setLoadingBins(true)
    try {
      const result = {}
      // Sequential to keep things simple — at typical warehouse counts (1-3) this is fine
      for (const w of warehouses) {
        try {
          result[w.id] = await getBinsForWarehouse(w.id)
        } catch (e) {
          console.warn(`Failed to load bins for warehouse ${w.name}:`, e)
          result[w.id] = []
        }
      }
      setBinsByWarehouse(result)
    } finally {
      setLoadingBins(false)
    }
  }

  // Group top-level locations by type for display
  const byType = locations.reduce((acc, loc) => {
    if (!acc[loc.type]) acc[loc.type] = []
    acc[loc.type].push(loc)
    return acc
  }, {})

  // Users who could be assigned a truck — exclude users who already have one
  const usersWithoutTruck = (users || []).filter(u => {
    if (!u.is_active) return false
    if (editing && editing.assigned_to === u.id) return true // keep current assignment in dropdown
    return !locations.some(l => l.type === 'truck' && l.is_active && l.assigned_to === u.id)
  })

  async function handleSave(formData) {
    setSaving(true)
    try {
      if (editing === 'new') {
        await createLocation(formData)
      } else {
        await updateLocation(editing.id, formData)
      }
      setEditing(null)
      onChanged()
    } catch (e) {
      console.error('Save location failed:', e)
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveBin(formData, parentWarehouse) {
    setSaving(true)
    try {
      await createLocation({
        ...formData,
        type: 'bin',
        parent_location_id: parentWarehouse.id,
      })
      setAddingBinFor(null)
      // Refetch bins for the warehouse we just added to
      const updated = await getBinsForWarehouse(parentWarehouse.id)
      setBinsByWarehouse(prev => ({ ...prev, [parentWarehouse.id]: updated }))
      showToast(`Bin added to ${parentWarehouse.name}`)
    } catch (e) {
      console.error('Save bin failed:', e)
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveBinEdit(formData, bin) {
    setSaving(true)
    try {
      await updateLocation(bin.id, {
        name: formData.name,
        notes: formData.notes,
      })
      setEditing(null)
      // Refetch the parent warehouse's bins
      const updated = await getBinsForWarehouse(bin.parent_location_id)
      setBinsByWarehouse(prev => ({ ...prev, [bin.parent_location_id]: updated }))
      showToast('Bin updated')
    } catch (e) {
      console.error('Update bin failed:', e)
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  // Click handler — opens the retire modal. The modal then loads stock
  // at the location + offers per-part recovery before flipping is_active.
  function handleDeactivate(loc) {
    setRetiring(loc)
  }

  // Load stock for the location being retired (so the owner sees what's
  // there before deciding what to recover). Cleared on close so the next
  // open starts fresh.
  useEffect(() => {
    if (!retiring) {
      setRetireStock([]); setRetireSelectedParts({}); setRetireDestinationId('')
      return
    }
    let cancelled = false
    setRetireLoading(true)
    getStockByLocation(retiring.id)
      .then(rows => {
        if (cancelled) return
        // Filter to positive stock — negative or zero rows aren't
        // physical inventory to recover, so don't surface them in the picker.
        const positive = rows.filter(r => Number(r.quantity) > 0)
        setRetireStock(positive)
        setRetireSelectedParts(Object.fromEntries(
          positive.map(r => [
            r.parts_catalog?.id,
            {
              selected: false,
              qty: Number(r.quantity),
              name: r.parts_catalog?.name || r.parts_catalog?.id,
              unit: r.parts_catalog?.unit || 'ea',
            },
          ])
        ))
      })
      .catch(e => {
        console.warn('Stock load for retire failed:', e)
        showToast('Could not load stock: ' + e.message)
      })
      .finally(() => { if (!cancelled) setRetireLoading(false) })
    return () => { cancelled = true }
  }, [retiring, showToast])

  function toggleRetirePart(partId) {
    setRetireSelectedParts(prev => ({
      ...prev,
      [partId]: { ...prev[partId], selected: !prev[partId]?.selected },
    }))
  }
  function setRetirePartQty(partId, qty) {
    const n = Math.max(0, Number(qty) || 0)
    setRetireSelectedParts(prev => ({
      ...prev,
      [partId]: { ...prev[partId], qty: n },
    }))
  }
  function selectAllRetireParts(select) {
    setRetireSelectedParts(prev => Object.fromEntries(
      Object.entries(prev).map(([id, v]) => [id, { ...v, selected: select }])
    ))
  }

  async function handleConfirmRetire() {
    if (!retiring) return
    const recoveryItems = Object.entries(retireSelectedParts)
      .filter(([, v]) => v.selected && v.qty > 0)
      .map(([partId, v]) => ({ partId, quantity: v.qty, unit: v.unit }))
    if (recoveryItems.length > 0 && !retireDestinationId) {
      showToast('Pick a destination for the parts you selected.')
      return
    }
    setRetireSaving(true)
    try {
      await deactivateLocationWithRecovery(
        retiring.id,
        recoveryItems,
        recoveryItems.length > 0 ? retireDestinationId : null,
      )
      const wasBin = retiring.type === 'bin'
      const parentId = retiring.parent_location_id
      showToast(recoveryItems.length > 0
        ? `Retired · ${recoveryItems.length} part${recoveryItems.length === 1 ? '' : 's'} recovered`
        : 'Retired')
      setRetiring(null)
      if (wasBin && parentId) {
        const updated = await getBinsForWarehouse(parentId)
        setBinsByWarehouse(prev => ({ ...prev, [parentId]: updated }))
      } else {
        onChanged()
      }
    } catch (e) {
      console.error('Retire failed:', e)
      showToast('Retire failed: ' + e.message)
    } finally {
      setRetireSaving(false)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading locations…</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={() => setEditing('new')} style={{ height: 34, padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <Icon name="plus" size={15} /> Add location
        </button>
      </div>

      {locations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🏭</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>No locations yet</div>
          <div style={{ fontSize: 13 }}>Start with your main warehouse, then add trucks for each crew member.</div>
        </div>
      ) : (
        <>
          {['warehouse', 'truck', 'job_site', 'vendor', 'scrap'].map(type => {
            const list = byType[type] || []
            if (list.length === 0) return null
            const isSectionExpanded = expandedSections.has(type)
            // Aggregate stock across the section so the header shows what's
            // inside without forcing the user to expand.
            const sectionRollup = list.reduce((acc, loc) => {
              const bins = type === 'warehouse' ? (binsByWarehouse[loc.id] || []) : []
              const own = stockCounts.get(loc.id)
              if (own) {
                acc.distinctParts += own.distinctParts
                acc.totalUnits += own.totalUnits
              }
              for (const b of bins) {
                const c = stockCounts.get(b.id)
                if (c) {
                  acc.distinctParts += c.distinctParts
                  acc.totalUnits += c.totalUnits
                }
              }
              return acc
            }, { distinctParts: 0, totalUnits: 0 })
            return (
              <div key={type} style={{ marginBottom: 12 }}>
                <div
                  onClick={() => toggleSection(type)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', marginBottom: 6,
                    background: isSectionExpanded ? 'var(--surface2)' : 'transparent',
                    borderRadius: 'var(--r-xs)',
                    cursor: 'pointer',
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                    letterSpacing: '.06em', color: 'var(--hint)',
                  }}>
                  <span style={{
                    fontSize: 13, color: 'var(--muted)', display: 'inline-block',
                    transform: isSectionExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform .15s', width: 10, textAlign: 'center',
                  }}>›</span>
                  <span>{TYPE_LABELS[type]}{list.length > 1 ? 's' : ''} ({list.length})</span>
                  {sectionRollup.distinctParts > 0 && (
                    <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: 'var(--muted)' }}>
                      {sectionRollup.distinctParts.toLocaleString()} part{sectionRollup.distinctParts === 1 ? '' : 's'}
                      {!isQtyPaused && (
                        <> · {sectionRollup.totalUnits.toLocaleString()} units</>
                      )}
                    </span>
                  )}
                </div>
                {isSectionExpanded && list.map(loc => {
                  const bins = type === 'warehouse' ? (binsByWarehouse[loc.id] || []) : []
                  const counts = stockCounts.get(loc.id)
                  // Warehouse rollup: own counts + sum of bin counts so the
                  // header reflects everything inside the warehouse tree.
                  const rollup = type === 'warehouse' && bins.length > 0
                    ? bins.reduce((acc, b) => {
                        const c = stockCounts.get(b.id)
                        if (c) {
                          acc.distinctParts += c.distinctParts
                          acc.totalUnits += c.totalUnits
                        }
                        return acc
                      }, { distinctParts: counts?.distinctParts || 0, totalUnits: counts?.totalUnits || 0 })
                    : counts
                  const isWhExpandable = type === 'warehouse' && bins.length > 0
                  const isWhExpanded = isWhExpandable && expandedWarehouses.has(loc.id)
                  const aisleGroups = isWhExpanded ? groupBinsByAisle(bins) : []
                  // Click-stopper for action buttons so they don't also
                  // toggle the warehouse expansion.
                  const stop = handler => e => { e.stopPropagation(); handler() }
                  return (
                    <div key={loc.id} style={{ marginBottom: 6 }}>
                      {/* Warehouse / location header row */}
                      <div
                        onClick={isWhExpandable ? () => toggleWarehouse(loc.id) : undefined}
                        style={{
                          background: 'var(--surface)', border: '1px solid var(--border)',
                          borderRadius: isWhExpanded ? 'var(--r) var(--r) 0 0' : 'var(--r)',
                          padding: '10px 14px',
                          display: 'flex', alignItems: 'center', gap: 8,
                          flexWrap: 'wrap',
                          cursor: isWhExpandable ? 'pointer' : 'default',
                          boxShadow: isWhExpanded ? 'none' : '0 1px 3px rgba(15,23,42,0.06)',
                        }}>
                        {isWhExpandable && (
                          <span style={{
                            color: 'var(--hint)', display: 'inline-flex',
                            transform: isWhExpanded ? 'rotate(90deg)' : 'none',
                            transition: 'transform .15s',
                          }}><Icon name="chevron-right" size={16} /></span>
                        )}
                        <span style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surface2)', color: 'var(--accent-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <Icon name={TYPE_ICON_NAME[type] || 'box'} size={18} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>
                            {loc.name}
                            {type === 'warehouse' && bins.length > 0 && (
                              <span style={{
                                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                                background: 'var(--teal-lt)', color: 'var(--teal)',
                                marginLeft: 8, verticalAlign: 'middle',
                              }}>{bins.length} bin{bins.length === 1 ? '' : 's'}</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                            {/* Truck assignment chip — clickable, jumps to
                                the Edit sheet so you don't have to hunt for
                                the Edit button. Amber for orphans (truck
                                exists but no crew member assigned) so they
                                stand out as needing attention. */}
                            {type === 'truck' ? (
                              <button
                                onClick={stop(() => setEditing(loc))}
                                title={loc.assigned_user ? `Click to change assignment` : `Click to assign a crew member`}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 4,
                                  padding: '2px 8px', borderRadius: 999,
                                  background: loc.assigned_user ? 'var(--teal-lt)' : 'var(--amber-lt)',
                                  color: loc.assigned_user ? 'var(--teal-mid)' : 'var(--amber)',
                                  border: `1px solid ${loc.assigned_user ? 'var(--teal)' : 'var(--amber)'}`,
                                  fontSize: 11, fontWeight: 700,
                                  cursor: 'pointer',
                                }}>
                                👤 {loc.assigned_user ? loc.assigned_user.name : 'Unassigned'}
                              </button>
                            ) : (
                              <span>
                                {loc.assigned_user ? `Assigned to ${loc.assigned_user.name}` : (loc.notes || '—')}
                              </span>
                            )}
                            {rollup && rollup.distinctParts > 0 && (
                              <>
                                <span style={{ color: 'var(--hint)' }}>·</span>
                                <span title="Distinct parts in stock">
                                  <strong style={{ color: 'var(--text)' }}>{rollup.distinctParts.toLocaleString()}</strong> part{rollup.distinctParts === 1 ? '' : 's'}
                                </span>
                                {!isQtyPaused && (
                                  <>
                                    <span style={{ color: 'var(--hint)' }}>·</span>
                                    <span title="Total units across all parts">
                                      <strong style={{ color: 'var(--text)' }}>{rollup.totalUnits.toLocaleString()}</strong> unit{rollup.totalUnits === 1 ? '' : 's'}
                                    </span>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        <button onClick={stop(() => setDetailFor(loc))} title="Open details panel — view stock, count, export, edit" style={locActionChip()}>
                          <Icon name="layout" size={14} /> Details
                        </button>
                        {onJumpToStock && rollup && rollup.distinctParts > 0 && (
                          <button onClick={stop(() => onJumpToStock(loc.id))} title="View stock at this location" style={locActionChip()}>
                            <Icon name="box" size={14} /> Stock
                          </button>
                        )}
                        {type === 'warehouse' && (
                          <button onClick={stop(() => setAddingBinFor(loc))} style={locActionChip()}>
                            <Icon name="plus" size={14} /> Bin
                          </button>
                        )}
                        {type === 'warehouse' && bins.length > 0 && (
                          <button
                            onClick={stop(() => setLabelsFor(loc))}
                            title="Print scannable BIN: QR labels for this warehouse"
                            style={locActionChip()}
                          >🏷 Bins</button>
                        )}
                        {type === 'warehouse' && bins.length > 0 && (
                          <button
                            onClick={stop(() => setAisleSignsFor(loc))}
                            title="Print full-page aisle signs for warehouse navigation"
                            style={locActionChip()}
                          >🏷 Aisles</button>
                        )}
                        <button
                          onClick={stop(() => setEditing(loc))}
                          style={{ fontSize: 13, color: 'var(--teal)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                        >Edit</button>
                        {isOwner && (
                          <button
                            onClick={stop(() => handleDeactivate(loc))}
                            style={{ fontSize: 13, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                          >Retire</button>
                        )}
                      </div>

                      {/* Bins under this warehouse — grouped by aisle,
                          each aisle independently collapsible. Only the
                          aisles the user opens render their bin rows,
                          which keeps a 165-bin warehouse navigable. */}
                      {isWhExpanded && (
                        <div style={{
                          background: 'var(--surface2)',
                          borderRadius: '0 0 var(--r-sm) var(--r-sm)',
                          border: '1px solid var(--border)',
                          borderTop: 'none',
                          padding: '4px 0',
                        }}>
                          {aisleGroups.map((group, gi) => {
                            const aisleKey = `${loc.id}:${group.key}`
                            const isAisleExpanded = expandedAisles.has(aisleKey)
                            // Stock rollup per aisle so the header shows
                            // how loaded each aisle is at a glance.
                            const aisleRollup = group.bins.reduce((acc, b) => {
                              const c = stockCounts.get(b.id)
                              if (c) { acc.distinctParts += c.distinctParts; acc.totalUnits += c.totalUnits }
                              return acc
                            }, { distinctParts: 0, totalUnits: 0 })
                            return (
                              <div key={group.key} style={{
                                borderBottom: gi < aisleGroups.length - 1 ? '1px solid var(--border)' : 'none',
                              }}>
                                <div
                                  onClick={() => toggleAisle(aisleKey)}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8,
                                    padding: '7px 14px 7px 20px',
                                    cursor: 'pointer',
                                    background: isAisleExpanded ? 'var(--surface)' : 'transparent',
                                  }}>
                                  <span style={{
                                    fontSize: 12, color: 'var(--muted)', display: 'inline-block',
                                    transform: isAisleExpanded ? 'rotate(90deg)' : 'none',
                                    transition: 'transform .15s', width: 10, textAlign: 'center',
                                  }}>›</span>
                                  <span style={{ fontSize: 14, fontWeight: 700 }}>{group.label}</span>
                                  <span style={{
                                    fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                                    background: 'var(--gray-lt)', color: 'var(--muted)',
                                  }}>{group.bins.length}</span>
                                  {aisleRollup.distinctParts > 0 && (
                                    <span style={{ fontSize: 12, color: 'var(--hint)', marginLeft: 'auto' }}>
                                      {aisleRollup.distinctParts.toLocaleString()} part{aisleRollup.distinctParts === 1 ? '' : 's'}
                                      {!isQtyPaused && (
                                        <> · {aisleRollup.totalUnits.toLocaleString()} units</>
                                      )}
                                    </span>
                                  )}
                                </div>
                                {isAisleExpanded && group.bins.map((bin, i) => {
                                  const binCounts = stockCounts.get(bin.id)
                                  return (
                                    <div key={bin.id} style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      flexWrap: 'wrap',
                                      padding: '6px 14px 6px 44px',
                                      borderTop: '1px solid var(--border)',
                                    }}>
                                      <span style={{ fontSize: 15 }}>📥</span>
                                      <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ fontWeight: 600, fontSize: 14 }}>{bin.name}</div>
                                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
                                          {bin.notes && <span>{bin.notes}</span>}
                                          {binCounts && binCounts.distinctParts > 0 && (
                                            <>
                                              {bin.notes && <span style={{ color: 'var(--hint)' }}>·</span>}
                                              <span><strong style={{ color: 'var(--text)' }}>{binCounts.distinctParts.toLocaleString()}</strong> part{binCounts.distinctParts === 1 ? '' : 's'}</span>
                                              {!isQtyPaused && (
                                                <>
                                                  <span style={{ color: 'var(--hint)' }}>·</span>
                                                  <span><strong style={{ color: 'var(--text)' }}>{binCounts.totalUnits.toLocaleString()}</strong> unit{binCounts.totalUnits === 1 ? '' : 's'}</span>
                                                </>
                                              )}
                                            </>
                                          )}
                                          <LastCountedPill ts={bin.last_counted_at} />
                                        </div>
                                      </div>
                                      <button
                                        onClick={() => setDetailFor(bin)}
                                        title="Open details — stock, count this bin, export"
                                        style={{
                                          fontSize: 12, color: 'var(--orange)', background: 'var(--orange-lt)',
                                          border: '1px solid var(--orange-dk)', borderRadius: 12, padding: '3px 10px',
                                          cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
                                        }}
                                      >📋 Details</button>
                                      <button
                                        onClick={() => setEditing(bin)}
                                        style={{ fontSize: 13, color: 'var(--teal)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                                      >Edit</button>
                                      {isOwner && (
                                        <button
                                          onClick={() => handleDeactivate(bin)}
                                          style={{ fontSize: 13, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                                        >Retire</button>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </>
      )}

      {/* Standard add/edit form for non-bin locations */}
      {editing && editing !== 'new' && editing.type === 'bin' ? (
        <BinFormSheet
          bin={editing}
          parentWarehouse={locations.find(l => l.id === editing.parent_location_id)}
          existingBins={binsByWarehouse[editing.parent_location_id] || []}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={(formData) => handleSaveBinEdit(formData, editing)}
        />
      ) : editing && (
        <LocationFormSheet
          location={editing === 'new' ? null : editing}
          usersWithoutTruck={usersWithoutTruck}
          saving={saving}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {/* Add bin form — only opens from a specific warehouse */}
      {addingBinFor && (
        <BinFormSheet
          bin={null}
          parentWarehouse={addingBinFor}
          existingBins={binsByWarehouse[addingBinFor.id] || []}
          saving={saving}
          onCancel={() => setAddingBinFor(null)}
          onSave={(formData) => handleSaveBin(formData, addingBinFor)}
        />
      )}

      {/* Bin label print sheet — generates QR labels for the warehouse's bins */}
      {labelsFor && (
        <BinLabelSheet
          warehouse={labelsFor}
          onClose={() => setLabelsFor(null)}
        />
      )}

      {/* Aisle signage print sheet — one full-page sign per aisle */}
      {aisleSignsFor && (
        <AisleSignSheet
          warehouse={aisleSignsFor}
          onClose={() => setAisleSignsFor(null)}
        />
      )}

      {/* Location detail drill-in — hub for view-stock / count / export /
          labels / edit / retire from a single panel. Opened via the
          "📋 Details" button on warehouse + bin rows. */}
      {detailFor && (
        <LocationDetailPanel
          location={detailFor}
          isOwner={isOwner}
          onClose={() => setDetailFor(null)}
          onJumpToStock={onJumpToStock}
          onJumpToCount={onJumpToCount}
          onJumpToPart={onJumpToPart}
          onEdit={(loc) => setEditing(loc)}
          onRetire={(loc) => handleDeactivate(loc)}
        />
      )}

      {retiring && (() => {
        const selectedItems = Object.values(retireSelectedParts).filter(v => v.selected && v.qty > 0)
        const recoveryCount = selectedItems.length
        const allSelected = retireStock.length > 0
          && retireStock.every(r => retireSelectedParts[r.parts_catalog?.id]?.selected)
        // Valid destinations: any other active non-bin location plus the
        // bins of warehouses we know about. Exclude the location being
        // retired. Warehouses are listed first (most common destination).
        const destOptions = []
        ;[...(locations || [])]
          .filter(l => l.id !== retiring.id && l.is_active !== false)
          .sort((a, b) => {
            // warehouses first, then job_sites, then trucks
            const order = { warehouse: 0, job_site: 1, truck: 2, scrap: 3, vendor: 4 }
            const o = (order[a.type] ?? 9) - (order[b.type] ?? 9)
            if (o !== 0) return o
            return (a.name || '').localeCompare(b.name || '')
          })
          .forEach(l => destOptions.push(l))
        return (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && !retireSaving && setRetiring(null)}>
          <div className="overlay-sheet" style={{ maxWidth: 600 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ fontSize: 22 }}>{TYPE_ICONS[retiring.type] || '📍'}</div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 17 }}>
                  Retire <strong>{retiring.name}</strong>?
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {TYPE_LABELS[retiring.type] || retiring.type} · {retireStock.length || 0} part type{retireStock.length === 1 ? '' : 's'} with stock
                </div>
              </div>
            </div>

            <div className="sec-label" style={{ marginTop: 16, marginBottom: 6 }}>
              Move stock to another location? <span style={{ color: 'var(--hint)', fontWeight: 600, marginLeft: 6 }}>(strongly recommended if there's stock here)</span>
            </div>

            {retireLoading && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: 13 }}>Loading stock…</div>
            )}

            {!retireLoading && retireStock.length === 0 && (
              <div style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', padding: 14, textAlign: 'center',
                color: 'var(--hint)', fontSize: 12, marginBottom: 12,
              }}>
                No stock at this location — safe to retire as-is.
              </div>
            )}

            {!retireLoading && retireStock.length > 0 && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button
                    onClick={() => selectAllRetireParts(!allSelected)}
                    style={{
                      fontSize: 11, fontWeight: 700, padding: '4px 10px',
                      background: 'var(--surface2)', color: 'var(--teal-mid)',
                      border: '1.5px solid var(--teal)', borderRadius: 999, cursor: 'pointer',
                    }}>
                    {allSelected ? '☐ Deselect all' : '☑ Select all'}
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--hint)', alignSelf: 'center' }}>
                    {recoveryCount} of {retireStock.length} selected
                  </span>
                </div>

                <div style={{
                  border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                  maxHeight: 280, overflowY: 'auto', marginBottom: 10,
                }}>
                  {retireStock.map((r, i) => {
                    const partId = r.parts_catalog?.id
                    const sel = retireSelectedParts[partId] || {}
                    const maxQty = Number(r.quantity)
                    return (
                      <div key={partId} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px',
                        borderBottom: i < retireStock.length - 1 ? '1px solid var(--border)' : 'none',
                        background: sel.selected ? 'var(--teal-lt)' : 'transparent',
                      }}>
                        <input
                          type="checkbox"
                          checked={sel.selected || false}
                          onChange={() => toggleRetirePart(partId)}
                          style={{ flexShrink: 0, cursor: 'pointer' }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {r.parts_catalog?.name || partId}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>
                            {partId} · on-hand {maxQty.toLocaleString()} {r.parts_catalog?.unit || 'ea'}
                          </div>
                        </div>
                        <input
                          type="number"
                          min={0}
                          max={maxQty}
                          value={sel.qty ?? maxQty}
                          disabled={!sel.selected}
                          onChange={e => setRetirePartQty(partId, e.target.value)}
                          style={{
                            width: 80, padding: '4px 8px', textAlign: 'right',
                            fontSize: 13, fontWeight: 700,
                            background: sel.selected ? 'var(--bg)' : 'var(--gray-lt)',
                            color: sel.selected ? 'var(--orange)' : 'var(--hint)',
                            border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
                          }}
                        />
                        <span style={{ fontSize: 11, color: 'var(--muted)', width: 28 }}>{r.parts_catalog?.unit || 'ea'}</span>
                      </div>
                    )
                  })}
                </div>

                <div className="field">
                  <label>Move selected parts to</label>
                  <select
                    value={retireDestinationId}
                    onChange={e => setRetireDestinationId(e.target.value)}
                    disabled={recoveryCount === 0}
                    style={{
                      width: '100%', padding: '8px 10px', fontSize: 13,
                      background: recoveryCount === 0 ? 'var(--gray-lt)' : 'var(--surface2)',
                      color: recoveryCount === 0 ? 'var(--hint)' : 'var(--text)',
                      border: '1.5px solid var(--border2)', borderRadius: 8,
                    }}>
                    <option value="">— Pick a location —</option>
                    {destOptions.map(d => (
                      <option key={d.id} value={d.id}>
                        {TYPE_ICONS[d.type] || ''} {d.name}{d.type !== 'warehouse' ? ` (${TYPE_LABELS[d.type]})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {!retireLoading && retireStock.length > 0 && recoveryCount === 0 && (
              <div style={{
                fontSize: 11, color: 'var(--amber)',
                background: 'var(--amber-lt)',
                borderRadius: 'var(--r-xs)', padding: '8px 10px',
                marginBottom: 14,
              }}>
                <Icon name="alert" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Retiring with stock still here leaves it orphaned. The location won't appear in the UI anymore but the inventory_stock rows remain pinned to it. Prefer to move stock out first.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }}
                onClick={() => setRetiring(null)} disabled={retireSaving}>Cancel</button>
              <button className="btn btn-danger" style={{ flex: 2 }}
                onClick={handleConfirmRetire}
                disabled={retireSaving || retireLoading || (recoveryCount > 0 && !retireDestinationId)}>
                {retireSaving
                  ? 'Working…'
                  : recoveryCount > 0
                    ? `Move ${recoveryCount} part${recoveryCount === 1 ? '' : 's'} + Retire`
                    : 'Retire only'}
              </button>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

// ─── Form sheet for adding/editing a top-level location ──────────────────────

function LocationFormSheet({ location, usersWithoutTruck, saving, onCancel, onSave }) {
  const isEdit = !!location
  const [name, setName] = useState(location?.name || '')
  const [type, setType] = useState(location?.type || 'warehouse')
  const [assignedTo, setAssignedTo] = useState(location?.assigned_to || '')
  const [notes, setNotes] = useState(location?.notes || '')

  const [nameTouched, setNameTouched] = useState(isEdit)

  function handleAssignChange(userId) {
    setAssignedTo(userId)
    if (type === 'truck' && !nameTouched && userId) {
      const u = usersWithoutTruck.find(x => x.id === userId)
      if (u) setName(`${u.name.split(' ')[0]}'s truck`)
    }
  }

  function handleTypeChange(newType) {
    setType(newType)
    if (newType !== 'truck') setAssignedTo('')
  }

  function handleSubmit() {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      type,
      assigned_to: type === 'truck' ? (assignedTo || null) : null,
      notes: notes.trim() || null,
    })
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet">
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 14 }}>
          {isEdit ? 'Edit location' : 'Add location'}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>Type</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {/* Bins are added via the per-warehouse "+ Bin" action, not here */}
            {['warehouse','truck','job_site','vendor','scrap'].map(t => (
              <button key={t} onClick={() => handleTypeChange(t)} style={{
                padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                border: `1.5px solid ${type === t ? 'var(--orange)' : 'var(--border2)'}`,
                background: type === t ? 'var(--orange-lt)' : 'var(--bg)',
                color: type === t ? 'var(--orange)' : 'var(--muted)',
              }}>
                {TYPE_ICONS[t]} {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6 }}>
            To add a bin under a warehouse, use the <strong>+ Bin</strong> button on the warehouse card.
          </div>
        </div>

        {type === 'truck' && (
          <div className="field">
            <label>Assigned to (crew member)</label>
            <select
              value={assignedTo}
              onChange={e => handleAssignChange(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
            >
              <option value="">— No one (yet) —</option>
              {usersWithoutTruck.map(u => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label>Name</label>
          <input
            type="text"
            value={name}
            placeholder={type === 'warehouse' ? 'Main Warehouse' : type === 'truck' ? "Edgar's truck" : 'Location name'}
            onChange={e => { setName(e.target.value); setNameTouched(true) }}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Notes (optional)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} style={{ minHeight: 56 }} />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
          >{saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create')}</button>
        </div>
      </div>
    </div>
  )
}

// ─── Form sheet for adding/editing a bin ─────────────────────────────────────

// Parse "Aisle <N>, <rest>" to pre-fill the picker when editing, OR to
// extract the list of distinct aisles already in use under the parent
// warehouse. Returns { aisle, rest } or null if the name doesn't fit
// the convention.
function parseBinName(name) {
  const m = (name || '').match(/^Aisle\s+(\d+)\s*[,:]?\s*(.*)$/i)
  if (!m) return null
  return { aisle: m[1], rest: m[2].trim() }
}

function BinFormSheet({ bin, parentWarehouse, existingBins = [], saving, onCancel, onSave }) {
  const isEdit = !!bin

  // Derive the list of existing aisles under this warehouse so the picker
  // shows real options. Sorted numerically (1, 2, 10, not 1, 10, 2).
  const existingAisles = useMemo(() => {
    const set = new Set()
    for (const b of existingBins) {
      const p = parseBinName(b.name)
      if (p) set.add(p.aisle)
    }
    return Array.from(set).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
  }, [existingBins])

  // If editing an existing bin, pre-fill aisle + rest from its name
  const initialParsed = parseBinName(bin?.name || '')
  const [aisle, setAisle] = useState(initialParsed?.aisle || '')
  const [aisleMode, setAisleMode] = useState(() => {
    if (initialParsed && existingAisles.includes(initialParsed.aisle)) return 'existing'
    if (initialParsed) return 'custom'
    return existingAisles.length > 0 ? 'existing' : 'custom'
  })
  const [customAisle, setCustomAisle] = useState(initialParsed?.aisle || '')
  const [shelf, setShelf] = useState(initialParsed?.rest || (bin && !initialParsed ? bin.name : ''))
  // Free-text fallback name when the user wants to skip the aisle convention
  // entirely — e.g. "Loading dock area" that doesn't fit Aisle X / Shelf Y.
  const [useFreeText, setUseFreeText] = useState(bin && !initialParsed)
  const [freeName, setFreeName] = useState(bin && !initialParsed ? bin.name : '')
  const [notes, setNotes] = useState(bin?.notes || '')

  // Compose the final name from the structured fields.
  const composedName = useFreeText
    ? freeName.trim()
    : (() => {
        const a = (aisleMode === 'existing' ? aisle : customAisle).trim()
        const s = shelf.trim()
        if (!a) return s  // no aisle → just the shelf text (will fall into "Other" group)
        if (!s) return `Aisle ${a}`
        return `Aisle ${a}, ${s}`
      })()

  function handleSubmit() {
    if (!composedName) return
    onSave({ name: composedName, notes: notes.trim() || null })
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet">
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>
          {isEdit ? 'Edit bin' : 'Add bin'}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          📥 Under <strong>{parentWarehouse?.name || 'warehouse'}</strong>
        </div>

        {!useFreeText ? (
          <>
            {/* Aisle picker — existing dropdown OR custom new number. Keeps
                bins grouped properly under the "Aisle N" headers in the tree. */}
            <div className="field">
              <label>Aisle</label>
              {existingAisles.length > 0 && aisleMode === 'existing' ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <select
                    value={aisle}
                    onChange={e => setAisle(e.target.value)}
                    style={{ flex: 1 }}
                  >
                    <option value="">— Pick an aisle —</option>
                    {existingAisles.map(a => (
                      <option key={a} value={a}>Aisle {a}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => { setAisleMode('custom'); setCustomAisle('') }}
                    className="btn btn-ghost"
                    style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                  >+ New aisle</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={customAisle}
                    placeholder="e.g. 3"
                    onChange={e => setCustomAisle(e.target.value.replace(/\D/g, ''))}
                    style={{ flex: 1 }}
                    inputMode="numeric"
                    autoFocus
                  />
                  {existingAisles.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setAisleMode('existing')}
                      className="btn btn-ghost"
                      style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                    >← Pick existing</button>
                  )}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                Number only (1, 2, 3…). Aisles group bins together under "Aisle N" headers.
              </div>
            </div>

            {/* Bay / shelf — free text inside the aisle */}
            <div className="field">
              <label>Bay / shelf <span style={{ color: 'var(--hint)', fontWeight: 400 }}>(optional)</span></label>
              <input
                type="text"
                value={shelf}
                placeholder="e.g. Bay A, Shelf 3, Bay 12"
                onChange={e => setShelf(e.target.value)}
              />
            </div>

            {/* Preview */}
            <div style={{
              marginBottom: 14, padding: '8px 12px',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              fontSize: 13,
            }}>
              <span style={{ color: 'var(--muted)' }}>Bin will be named: </span>
              <strong>{composedName || '—'}</strong>
            </div>

            <button
              type="button"
              onClick={() => { setUseFreeText(true); setFreeName(composedName) }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 11, textDecoration: 'underline',
                padding: 0, marginBottom: 12,
              }}
            >Use custom name instead</button>
          </>
        ) : (
          <>
            <div className="field">
              <label>Bin name</label>
              <input
                type="text"
                value={freeName}
                placeholder="e.g. Loading dock"
                onChange={e => setFreeName(e.target.value)}
                autoFocus
              />
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                <Icon name="alert" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Bins not starting with "Aisle N" will group under "Other" in the tree.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setUseFreeText(false)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--muted)', fontSize: 11, textDecoration: 'underline',
                padding: 0, marginBottom: 12,
              }}
            >← Back to aisle/shelf picker</button>
          </>
        )}

        <div className="field">
          <label>Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Top shelf only, near the loading dock"
            style={{ minHeight: 56 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={saving || !composedName}
          >{saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create bin')}</button>
        </div>
      </div>
    </div>
  )
}

// ─── LastCountedPill ────────────────────────────────────────────────────
// Compact age indicator surfaced on each bin row. Drives the "stale bins"
// signal — green for fresh, amber for aging, red for very stale, muted
// "never" for bins that haven't been cycle-counted yet.
function LastCountedPill({ ts }) {
  if (!ts) {
    return (
      <span style={{ color: 'var(--hint)' }} title="Bin has never been cycle-counted">
        · never counted
      </span>
    )
  }
  const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
  const label =
    days < 1  ? 'today'
    : days < 30 ? `${days}d ago`
    : days < 365 ? `${Math.floor(days / 30)}mo ago`
    : `${Math.floor(days / 365)}y ago`
  const cls =
    days < 7   ? 'pill-success'
    : days < 30 ? 'pill-warning'
    : 'pill-danger'
  return (
    <span style={{ color: 'var(--hint)' }}>
      ·{' '}
      <span className={`pill ${cls} pill-sm`} title={`Last counted ${new Date(ts).toLocaleString()}`}>
        counted {label}
      </span>
    </span>
  )
}
