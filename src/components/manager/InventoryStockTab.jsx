import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import {
  getStockByLocation, getStockSummary, getStockForWarehouseTree,
  getBinsForWarehouse,
} from '../../lib/inventory'
import BulkMoveSheet from './BulkMoveSheet'
import SkuLabelSheet from './SkuLabelSheet'
import PurchaseRequestSheet from './PurchaseRequestSheet'
import { useIsWide } from '../../lib/useIsWide'
import { recencyPillStyle, recencyOf } from '../../lib/recencyPill'

const TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

// Sub-modes when a warehouse is scoped:
//   'rollup'    → warehouse + every bin under it, summed per part (read-only for bulk)
//   'unbinned'  → only the warehouse-level stock (no bins)
//   <bin uuid>  → a specific bin
const SUBMODE_ROLLUP = 'rollup'
const SUBMODE_UNBINNED = 'unbinned'

export default function InventoryStockTab({ locations, locationsLoading, refreshKey, jumpToScope, onJumpToPart, onJumpToLocation }) {
  const { showToast, currentUser, isQtyPaused } = useApp()
  // Initialize scope from jumpToScope so the very first load fires with
  // the right scope — avoids the race where the parent flipped tabs +
  // signaled a jump, but useState ran first with 'all', kicking off a
  // getStockSummary() request that could resolve AFTER the
  // setScope(jumpToScope.locationId) load and overwrite its rows.
  const [scope, setScope] = useState(() => jumpToScope?.locationId || 'all')

  // Handles the in-place jump case (StockTab already mounted, parent
  // signals a new jump). The `n` counter ensures repeat jumps to the
  // same location still re-fire the effect. Note: setSearch + the
  // highlight effect live further down, after their state is declared
  // (would otherwise be a temporal-dead-zone error).
  useEffect(() => {
    if (jumpToScope?.locationId) setScope(jumpToScope.locationId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToScope?.n])

  const [binScope, setBinScope] = useState(SUBMODE_ROLLUP)
  const [bins, setBins] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [showBulkMove, setShowBulkMove] = useState(false)
  const [showLabelSheet, setShowLabelSheet] = useState(false)
  // Purchase-request composition sheet seeded with the bulk-selected parts.
  const [showPrSheet, setShowPrSheet] = useState(false)

  // Two-tier location filter:
  //   typeFilter — top ribbon: 'all' | 'warehouse' | 'truck' | 'job_site'
  //                drives which secondary pills are visible
  //   scope (above) — the actual selected location (or 'all')
  // The old single-row pill wall scaled badly past ~10 locations; with
  // 40+ pills it ate ~25% of vertical space. The ribbon collapses it.
  // 'all' as type keeps everything visible — same as before — but is
  // no longer the only way to find a location.
  const [typeFilter, setTypeFilter] = useState('all')

  const lastClickedIndexRef = useRef(null)
  const [internalRefresh, setInternalRefresh] = useState(0)

  // Launcher / cross-link focus: when jumpToScope carries a partId, scroll
  // to + highlight that part's row inside the loaded scope. Refs map by
  // part_id; only the row matching the focused part lights up briefly.
  const stockRowRefs = useRef({})
  const [highlightedPartId, setHighlightedPartId] = useState(null)

  // Clear search on a part-jump so the focused row isn't filtered out
  // by a stale search term. Has to live here (not in the early
  // jumpToScope effect above) because `setSearch` is declared between
  // those two — moving this up would TDZ-error.
  useEffect(() => {
    if (jumpToScope?.partId) setSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToScope?.n])

  // Highlight the focused part row once rows are loaded. Deferred via
  // setTimeout so layout has settled before scrollIntoView fires.
  useEffect(() => {
    if (!jumpToScope?.partId || loading) return
    const t = setTimeout(() => {
      const el = stockRowRefs.current[jumpToScope.partId]
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedPartId(jumpToScope.partId)
    }, 60)
    const clear = setTimeout(() => setHighlightedPartId(null), 2200)
    return () => { clearTimeout(t); clearTimeout(clear) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToScope?.n, loading, rows.length])

  // Load bins whenever the warehouse scope changes. Resets binScope to
  // rollup so we always start at the highest-level view when changing
  // warehouses.
  useEffect(() => {
    if (scope === 'all') {
      setBins([])
      setBinScope(SUBMODE_ROLLUP)
      return
    }
    const loc = locations.find(l => l.id === scope)
    if (loc?.type === 'warehouse') {
      getBinsForWarehouse(scope).then(setBins).catch(e => {
        console.warn('Failed to load bins for warehouse:', e)
        setBins([])
      })
      setBinScope(SUBMODE_ROLLUP)
    } else {
      setBins([])
      setBinScope(SUBMODE_ROLLUP)
    }
  }, [scope, locations])

  // Inline-as-effect with a cancelled flag so a stale fetch never
  // overwrites a fresher one. Earlier this was a separate load() function
  // called from useEffect, which raced when scope changed mid-flight.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        let nextRows
        if (scope === 'all') {
          nextRows = await getStockSummary()
        } else {
          const loc = locations.find(l => l.id === scope)
          const isWarehouse = loc?.type === 'warehouse'

          if (isWarehouse && binScope === SUBMODE_ROLLUP) {
            const tree = await getStockForWarehouseTree(scope)
            const byPart = new Map()
            for (const r of tree) {
              const qty = Number(r.quantity) || 0
              if (qty === 0) continue
              const pc = r.parts_catalog
              const partId = pc?.id || r.location_id
              const existing = byPart.get(partId)
              if (existing) {
                existing.total += qty
                existing.locationCount++
              } else {
                byPart.set(partId, {
                  part_id: partId,
                  name: pc?.name || partId,
                  unit: pc?.unit || 'ea',
                  category: pc?.category || null,
                  is_active: pc?.is_active !== false,
                  total: qty,
                  locationCount: 1,
                })
              }
            }
            nextRows = [...byPart.values()].sort((a, b) => a.name.localeCompare(b.name))
          } else if (isWarehouse && binScope === SUBMODE_UNBINNED) {
            nextRows = toRowShape(await getStockByLocation(scope))
          } else if (isWarehouse) {
            nextRows = toRowShape(await getStockByLocation(binScope))
          } else {
            nextRows = toRowShape(await getStockByLocation(scope))
          }
        }
        if (cancelled) return
        setRows(nextRows)
      } catch (e) {
        if (cancelled) return
        console.error('Load stock failed:', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // locations intentionally omitted — its reference changes on every
    // parent refresh; we only want to re-fetch when scope/binScope or
    // an explicit refresh signal changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, binScope, refreshKey, internalRefresh])

  useEffect(() => {
    setSelectedIds(new Set())
    lastClickedIndexRef.current = null
  }, [scope, binScope, search, refreshKey])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.toLowerCase()
    return rows.filter(r =>
      (r.name || '').toLowerCase().includes(q) ||
      (r.part_id || '').toLowerCase().includes(q) ||
      (r.category || '').toLowerCase().includes(q)
    )
  }, [rows, search])

  const totalLines = rows.length
  const totalUnits = rows.reduce((a, r) => a + (Number(r.total) || 0), 0)

  const scopedLoc = scope !== 'all' ? locations.find(l => l.id === scope) : null
  const isWarehouseScope = scopedLoc?.type === 'warehouse'
  const inRollupMode = isWarehouseScope && binScope === SUBMODE_ROLLUP
  const canBulkSelect = scope !== 'all' && !inRollupMode

  // The location to use as the source for bulk-move
  const bulkSourceLocation = useMemo(() => {
    if (!canBulkSelect) return null
    if (isWarehouseScope) {
      if (binScope === SUBMODE_UNBINNED) return scopedLoc
      return bins.find(b => b.id === binScope) || null
    }
    return scopedLoc
  }, [canBulkSelect, isWarehouseScope, scopedLoc, binScope, bins])

  function handleCheckboxClick(e, index) {
    const row = filtered[index]
    if (!row) return
    if (Number(row.total) <= 0) return

    const partId = row.part_id
    const anchor = lastClickedIndexRef.current

    if (e.shiftKey && anchor !== null && anchor !== index) {
      const from = Math.min(anchor, index)
      const to   = Math.max(anchor, index)
      setSelectedIds(prev => {
        const next = new Set(prev)
        for (let j = from; j <= to; j++) {
          const r = filtered[j]
          if (r && Number(r.total) > 0) next.add(r.part_id)
        }
        return next
      })
      lastClickedIndexRef.current = index
      return
    }

    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId); else next.add(partId)
      return next
    })
    lastClickedIndexRef.current = index
  }

  function selectAllVisible() {
    setSelectedIds(new Set(filtered.filter(r => Number(r.total) > 0).map(r => r.part_id)))
  }
  function clearSelection() {
    setSelectedIds(new Set())
    lastClickedIndexRef.current = null
  }
  const allVisibleSelected = filtered.length > 0
    && filtered.filter(r => Number(r.total) > 0).every(r => selectedIds.has(r.part_id))

  const selectedRowsForMove = useMemo(() => {
    if (!canBulkSelect) return []
    return rows
      .filter(r => selectedIds.has(r.part_id) && Number(r.total) > 0)
      .map(r => ({
        part_id: r.part_id,
        name: r.name,
        unit: r.unit,
        quantity: Number(r.total),
      }))
  }, [rows, selectedIds, canBulkSelect])

  function handleBulkMoveComplete({ created, errors }) {
    setShowBulkMove(false)
    setSelectedIds(new Set())
    lastClickedIndexRef.current = null
    setInternalRefresh(k => k + 1)
    if (errors.length > 0) {
      showToast(`Moved ${created} · ${errors.length} failed (see console)`)
      console.warn('Bulk move row failures:', errors)
    } else {
      showToast(`Moved ${created} part${created === 1 ? '' : 's'}`)
    }
  }

  const selectedCount = selectedIds.size

  const scopeLabel = useMemo(() => {
    if (scope === 'all' || !scopedLoc || !isWarehouseScope) return null
    const baseName = scopedLoc.assigned_user?.name || scopedLoc.name
    if (binScope === SUBMODE_ROLLUP)   return `📦 All ${baseName} (rolled up across warehouse + bins)`
    if (binScope === SUBMODE_UNBINNED) return `🏭 ${baseName} — unbinned only`
    const bin = bins.find(b => b.id === binScope)
    return bin ? `📥 ${baseName} / ${bin.name}` : null
  }, [scope, scopedLoc, isWarehouseScope, binScope, bins])

  // Collapsed scope summary for the slim header — shown when filters are hidden
  // so the user knows what's filtered without expanding the panel. Mirrors the
  // pattern from ReportsView + the Cycle Count tab fix.
  const isWide = useIsWide()
  const [showFilters, setShowFilters] = useState(() => isWide)
  const slimScopeText = useMemo(() => {
    if (scope === 'all') return typeFilter === 'all' ? 'All locations' : `${typeFilter} locations`
    if (!scopedLoc) return 'All locations'
    const baseName = scopedLoc.assigned_user?.name || scopedLoc.name
    const icon = TYPE_ICONS[scopedLoc.type] || '📦'
    if (!isWarehouseScope) return `${icon} ${baseName}`
    if (binScope === SUBMODE_ROLLUP) return `${icon} ${baseName} (rollup)`
    if (binScope === SUBMODE_UNBINNED) return `${icon} ${baseName} — unbinned`
    const bin = bins.find(b => b.id === binScope)
    return bin ? `${icon} ${baseName} / 📥 ${bin.name}` : `${icon} ${baseName}`
  }, [scope, scopedLoc, isWarehouseScope, binScope, bins, typeFilter])

  return (
    <div style={{ position: 'relative', paddingBottom: selectedCount > 0 ? 76 : 0 }}>
      {/* Slim filter toggle — always visible. Shows current scope as plain
          text when collapsed so the user knows what's filtered without
          expanding. Mobile-default-collapsed; desktop-default-open. The
          full type+location+bin chrome lives in the expanded panel below. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        marginBottom: showFilters ? 10 : 8,
      }}>
        <button
          onClick={() => setShowFilters(v => !v)}
          className="btn btn-ghost"
          style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600 }}
          title={showFilters ? 'Hide location filters' : 'Show location + bin filters'}
        >
          {showFilters ? '▴ Hide filters' : '▾ Filters'}
        </button>
        {!showFilters && (
          <div style={{
            fontSize: 12, color: 'var(--muted)', fontWeight: 600,
            flex: 1, minWidth: 0, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {slimScopeText}
          </div>
        )}
      </div>

      {showFilters && (() => {
        const counts = locations.reduce((acc, l) => {
          acc[l.type] = (acc[l.type] || 0) + 1
          return acc
        }, {})
        const typeOptions = [
          { id: 'all',       label: 'All',             icon: null,  count: locations.length },
          { id: 'warehouse', label: 'Warehouses',      icon: '🏭', count: counts.warehouse || 0 },
          { id: 'truck',     label: 'Trucks',          icon: '🚚', count: counts.truck     || 0 },
          { id: 'job_site',  label: 'Project buckets', icon: '📍', count: counts.job_site  || 0 },
        ].filter(t => t.id === 'all' || t.count > 0)
        return (
          <>
            {/* Type filter — was a row of 4 pills, now a single dropdown to
                save a row inside the (already-collapsible) filter panel. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Type
              </div>
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value)}
                style={{
                  padding: '5px 10px', fontSize: 12, fontWeight: 700,
                  border: '1.5px solid var(--border2)', borderRadius: 'var(--r-xs)',
                  background: 'var(--surface2)', color: 'var(--text)',
                }}
              >
                {typeOptions.map(t => (
                  <option key={t.id} value={t.id}>
                    {t.icon || '📦'} {t.label} ({t.count})
                  </option>
                ))}
              </select>
            </div>

            {/* Secondary location pills — filtered by the selected type. */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              <button onClick={() => setScope('all')} style={pillStyle(scope === 'all')}>All locations</button>
              {locations
                .filter(loc => typeFilter === 'all' || loc.type === typeFilter)
                .map(loc => (
                  <button key={loc.id} onClick={() => setScope(loc.id)} style={pillStyle(scope === loc.id)}>
                    {TYPE_ICONS[loc.type] || '📦'} {loc.assigned_user?.name || loc.name}
                  </button>
                ))}
            </div>

            {/* Bin sub-pills (only when a warehouse is scoped) */}
            {isWarehouseScope && (
              <div style={{
                display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap',
                paddingLeft: 16, borderLeft: '2px solid var(--orange)',
              }}>
                <button onClick={() => setBinScope(SUBMODE_ROLLUP)} style={subPillStyle(binScope === SUBMODE_ROLLUP)}>
                  📦 All (rollup)
                </button>
                <button onClick={() => setBinScope(SUBMODE_UNBINNED)} style={subPillStyle(binScope === SUBMODE_UNBINNED)}>
                  🏭 Unbinned
                </button>
                {bins.map(b => (
                  <button key={b.id} onClick={() => setBinScope(b.id)} style={subPillStyle(binScope === b.id)}>
                    📥 {b.name}
                  </button>
                ))}
                {bins.length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--hint)', alignSelf: 'center' }}>
                    No bins yet. Add some on the Locations tab.
                  </span>
                )}
              </div>
            )}

            {scopeLabel && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8, fontWeight: 600 }}>
                {scopeLabel}
              </div>
            )}
          </>
        )
      })()}

      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search parts by name, SKU, or category…"
        autoComplete="off"
        spellCheck="false"
        name="stock-search"
        style={{
          width: '100%', padding: '10px 12px',
          border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
          fontSize: 14, background: 'var(--bg)', marginBottom: 10
        }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {loading ? 'Loading…' : `${filtered.length} of ${totalLines} part types · ${totalUnits.toLocaleString()} total units`}
          {canBulkSelect && filtered.length > 0 && (
            <span style={{ color: 'var(--hint)', marginLeft: 6 }}>· tip: shift-click for range</span>
          )}
          {inRollupMode && filtered.length > 0 && (
            <span style={{ color: 'var(--hint)', marginLeft: 6 }}>· drill into a bin to bulk-move</span>
          )}
        </div>
        {!loading && filtered.length > 0 && (
          <button
            onClick={() => setShowLabelSheet(true)}
            title="Print SKU labels for the parts shown above"
            style={{
              fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--purple)', background: 'var(--purple-lt)', color: 'var(--purple)', cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            🏷 Labels
          </button>
        )}
        {canBulkSelect && filtered.length > 0 && (
          <button
            onClick={allVisibleSelected ? clearSelection : selectAllVisible}
            style={{
              fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--border2)', background: 'var(--bg)', color: 'var(--muted)', cursor: 'pointer',
            }}
          >
            {allVisibleSelected ? 'Deselect all' : `Select all`}
          </button>
        )}
      </div>

      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
          {totalLines === 0
            ? 'No stock here yet — record a receive movement to get started.'
            : 'No parts match your search.'}
        </div>
      )}

      {filtered.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          {filtered.map((r, i) => {
            const isSelected = selectedIds.has(r.part_id)
            const isHighlighted = highlightedPartId === r.part_id
            const total = Number(r.total)
            const canSelect = canBulkSelect && total > 0
            return (
              <div
                key={r.part_id}
                ref={el => { stockRowRefs.current[r.part_id] = el }}
                style={{
                  display: 'flex', alignItems: 'center', padding: '10px 14px',
                  borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                  gap: 8,
                  background: isHighlighted ? 'var(--teal-lt)'
                    : isSelected ? 'var(--orange-lt)'
                    : 'transparent',
                  boxShadow: isHighlighted ? 'inset 0 0 0 2px var(--teal)' : 'none',
                  transition: 'background 0.3s, box-shadow 0.3s',
                }}
              >
                {canBulkSelect && (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={!canSelect}
                    onChange={() => {}}
                    onClick={e => canSelect && handleCheckboxClick(e, i)}
                    title={!canSelect ? 'Cannot move negative or zero stock' : ''}
                    style={{ cursor: canSelect ? 'pointer' : 'not-allowed', flexShrink: 0 }}
                  />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {/* Name clickable → jump to that part on the Parts tab.
                        Cross-link affordance; no behavior change if onJumpToPart
                        wasn't passed in. */}
                    {onJumpToPart ? (
                      <button
                        type="button"
                        onClick={() => onJumpToPart(r.part_id)}
                        title="View this part in the Parts tab"
                        style={{
                          background: 'transparent', border: 'none', padding: 0,
                          color: 'inherit', font: 'inherit', cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {r.name}
                      </button>
                    ) : r.name}
                    {r.is_active === false && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                        background: 'var(--amber-lt)', color: 'var(--amber)',
                        marginLeft: 6, verticalAlign: 'middle',
                      }}>DRAFT</span>
                    )}
                    {inRollupMode && r.locationCount > 1 && (
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                        background: 'var(--teal-lt)', color: 'var(--teal)',
                        marginLeft: 6, verticalAlign: 'middle',
                      }}>{r.locationCount} spots</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                    {r.part_id}{r.category ? ` · ${r.category}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {isQtyPaused ? (
                    // Paused mode: hide qty, show last-seen recency.
                    // Negative-flag treatment also disappears (it's
                    // meaningless once we stop authoritative tracking).
                    <span style={recencyPillStyle(r.last_movement_at)}>
                      {recencyOf(r.last_movement_at).label}
                    </span>
                  ) : (
                    <>
                      <div style={{ fontSize: 16, fontWeight: 800, color: total < 0 ? 'var(--red)' : 'var(--orange)' }}>
                        {total.toLocaleString()}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--muted)' }}>{r.unit}</div>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedCount > 0 && canBulkSelect && (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 10,
          background: 'var(--surface)', border: '1.5px solid var(--orange)',
          borderRadius: 'var(--r-sm)', padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          boxShadow: '0 -4px 12px rgba(0,0,0,0.1)',
        }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--orange)', flex: 1 }}>
            {selectedCount} selected
          </div>
          <button
            onClick={() => setShowBulkMove(true)}
            style={{
              padding: '7px 14px', borderRadius: 'var(--r-sm)',
              border: 'none', background: 'var(--orange)', color: 'white',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >↔ Bulk move</button>
          <button
            onClick={() => setShowPrSheet(true)}
            title="Create a purchase request seeded with the selected parts"
            style={{
              padding: '7px 14px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--orange)', background: 'var(--bg)',
              color: 'var(--orange)',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >📋 Create PR</button>
          <button onClick={clearSelection} style={{
            padding: '7px 12px', borderRadius: 'var(--r-sm)',
            border: '1.5px solid var(--border2)', background: 'var(--bg)',
            color: 'var(--muted)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
          }}>Cancel</button>
        </div>
      )}

      {showBulkMove && bulkSourceLocation && (
        <BulkMoveSheet
          sourceLocation={bulkSourceLocation}
          selectedRows={selectedRowsForMove}
          locations={locations}
          currentUser={currentUser}
          onClose={() => setShowBulkMove(false)}
          onComplete={handleBulkMoveComplete}
        />
      )}

      {showPrSheet && (
        <PurchaseRequestSheet
          mode="new"
          initialParts={filtered
            .filter(r => selectedIds.has(r.part_id))
            .map(r => ({ id: r.part_id, name: r.name, unit: r.unit }))}
          locations={locations}
          onClose={() => setShowPrSheet(false)}
          onSaved={() => { setShowPrSheet(false); setSelectedIds(new Set()) }}
        />
      )}

      {showLabelSheet && (
        <SkuLabelSheet
          parts={filtered.map(r => ({
            id: r.parts_catalog?.id || r.part_id,
            name: r.parts_catalog?.name || r.part_id,
            unit: r.parts_catalog?.unit || 'ea',
          })).filter(p => p.id)}
          title={`Print labels for ${filtered.length} part${filtered.length === 1 ? '' : 's'} at this location`}
          onClose={() => setShowLabelSheet(false)}
        />
      )}
    </div>
  )
}

function toRowShape(data) {
  return (data || []).map(r => ({
    part_id: r.parts_catalog?.id,
    name: r.parts_catalog?.name || r.part_id,
    unit: r.parts_catalog?.unit || 'ea',
    category: r.parts_catalog?.category || null,
    is_active: r.parts_catalog?.is_active !== false,
    total: Number(r.quantity),
    last_movement_at: r.last_movement_at,
  }))
}

function pillStyle(selected) {
  return {
    padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: selected ? 'var(--teal)' : 'var(--gray-lt)',
    color: selected ? 'white' : 'var(--muted)',
    border: 'none', cursor: 'pointer',
  }
}

function subPillStyle(selected) {
  return {
    padding: '4px 10px', borderRadius: 16, fontSize: 11, fontWeight: 600,
    background: selected ? 'var(--orange)' : 'var(--surface2)',
    color: selected ? 'white' : 'var(--muted)',
    border: `1.5px solid ${selected ? 'var(--orange)' : 'var(--border2)'}`,
    cursor: 'pointer',
  }
}
