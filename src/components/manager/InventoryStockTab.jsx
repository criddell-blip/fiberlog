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
import { chipStyle, cardSurface, CARD_SHADOW, EmptyState } from './chrome'
import Icon from '../shared/Icon'

const TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

// Console line-icon name per location type (used by the filter chips).
const TYPE_ICON_NAME = {
  warehouse: 'warehouse',
  truck:     'truck',
  job_site:  'pin',
  vendor:    'warehouse',
  scrap:     'x',
  bin:       'box',
}

// Console row status from the existing data. No reorder threshold exists in the
// schema yet, so "low" stands in for zero/negative (the actionable state);
// a real LOW threshold would refine this (flagged for a later data change).
function stockStatus(r) {
  if (r.is_active === false) return { label: 'DRAFT', cls: 'status-draft' }
  if (Number(r.total) <= 0)  return { label: 'LOW', cls: 'status-low' }
  return { label: 'IN STOCK', cls: 'status-instock' }
}

// Sub-modes when a warehouse is scoped:
//   'rollup'    → warehouse + every bin under it, summed per part (read-only for bulk)
//   'unbinned'  → only the warehouse-level stock (no bins)
//   <bin uuid>  → a specific bin
const SUBMODE_ROLLUP = 'rollup'
const SUBMODE_UNBINNED = 'unbinned'

export default function InventoryStockTab({ locations, locationsLoading, refreshKey, jumpToScope, onJumpToPart, onJumpToLocation, readOnly = false }) {
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
    // Tokenized: split on whitespace; EVERY token must match name, SKU, or
    // category (case-insensitive). AND-across-tokens makes multi-word
    // queries like "lag bolt box" narrow the list instead of requiring the
    // whole phrase to appear verbatim (July 2026 audit, backlog #29).
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return rows
    return rows.filter(r => {
      const hay = `${r.name || ''} ${r.part_id || ''} ${r.category || ''}`.toLowerCase()
      return tokens.every(t => hay.includes(t))
    })
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
          style={chipStyle(showFilters)}
          title={showFilters ? 'Hide location filters' : 'Show location + bin filters'}
        >
          <Icon name="filter" size={14} /> {showFilters ? 'Hide filters' : 'Filters'}
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
              <button onClick={() => setScope('all')} style={chipStyle(scope === 'all')}>All locations</button>
              {locations
                .filter(loc => typeFilter === 'all' || loc.type === typeFilter)
                .map(loc => (
                  <button key={loc.id} onClick={() => setScope(loc.id)} style={chipStyle(scope === loc.id)}>
                    <Icon name={TYPE_ICON_NAME[loc.type] || 'box'} size={14} />
                    {loc.assigned_user?.name || loc.name}
                  </button>
                ))}
            </div>

            {/* Bin sub-pills (only when a warehouse is scoped) */}
            {isWarehouseScope && (
              <div style={{
                display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap',
                paddingLeft: 16, borderLeft: '2px solid var(--accent)',
              }}>
                <button onClick={() => setBinScope(SUBMODE_ROLLUP)} style={subPillStyle(binScope === SUBMODE_ROLLUP)}>
                  <Icon name="layers" size={13} /> All (rollup)
                </button>
                <button onClick={() => setBinScope(SUBMODE_UNBINNED)} style={subPillStyle(binScope === SUBMODE_UNBINNED)}>
                  <Icon name="warehouse" size={13} /> Unbinned
                </button>
                {bins.map(b => (
                  <button key={b.id} onClick={() => setBinScope(b.id)} style={subPillStyle(binScope === b.id)}>
                    <Icon name="box" size={13} /> {b.name}
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

      <div style={{ position: 'relative', marginBottom: 10 }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--hint)', display: 'flex', pointerEvents: 'none' }}>
          <Icon name="search" size={16} />
        </span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search parts by name, SKU, or category…"
          autoComplete="off"
          spellCheck="false"
          name="stock-search"
          style={{
            width: '100%', height: 38, padding: '0 12px 0 36px',
            border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)',
            fontSize: 14, background: 'var(--surface)',
          }}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--hint)' }}>
          {loading ? 'Loading…' : `${filtered.length} of ${totalLines} parts · ${totalUnits.toLocaleString()} units`}
          {canBulkSelect && filtered.length > 0 && (
            <span style={{ marginLeft: 6 }}>· shift-click for range</span>
          )}
          {inRollupMode && filtered.length > 0 && (
            <span style={{ marginLeft: 6 }}>· drill into a bin to bulk-move</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!loading && filtered.length > 0 && (
            <button onClick={() => setShowLabelSheet(true)} title="Print SKU labels for the parts shown above" style={chipStyle(false)}>
              <Icon name="tag" size={14} /> Labels
            </button>
          )}
          {canBulkSelect && filtered.length > 0 && (
            <button onClick={allVisibleSelected ? clearSelection : selectAllVisible} style={chipStyle(false)}>
              {allVisibleSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>
      </div>

      {!loading && filtered.length === 0 && (
        <EmptyState>
          {totalLines === 0
            ? 'No stock here yet — record a receive movement to get started.'
            : 'No parts match your search.'}
        </EmptyState>
      )}

      {/* Desktop: Console data table */}
      {filtered.length > 0 && isWide && (() => {
        const gridCols = canBulkSelect
          ? '28px minmax(0,1fr) 132px 130px 104px 92px'
          : 'minmax(0,1fr) 132px 130px 104px 92px'
        return (
          <div style={{ ...cardSurface, overflow: 'hidden' }}>
            {/* Header row */}
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'center', height: 38, padding: '0 16px', background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
              {canBulkSelect && (
                <input type="checkbox" checked={allVisibleSelected} onChange={allVisibleSelected ? clearSelection : selectAllVisible} title="Select all" style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
              )}
              <span className="eyebrow">Part</span>
              <span className="eyebrow">SKU</span>
              <span className="eyebrow">Category</span>
              <span className="eyebrow" style={{ textAlign: 'right' }}>On hand</span>
              <span className="eyebrow" style={{ textAlign: 'right' }}>Status</span>
            </div>
            {filtered.map((r, i) => {
              const isSelected = selectedIds.has(r.part_id)
              const isHighlighted = highlightedPartId === r.part_id
              const total = Number(r.total)
              const canSelect = canBulkSelect && total > 0
              const isDraft = r.is_active === false
              const st = stockStatus(r)
              return (
                <div key={r.part_id} ref={el => { stockRowRefs.current[r.part_id] = el }}
                  style={{
                    display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'center', minHeight: 44, padding: '6px 16px',
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--row-divider)' : 'none',
                    background: isHighlighted ? 'var(--accent-lt)' : isSelected ? 'var(--selected-row)' : 'transparent',
                    boxShadow: isHighlighted ? 'inset 0 0 0 2px var(--accent)' : 'none',
                    transition: 'background .25s', opacity: isDraft ? 0.6 : 1,
                  }}>
                  {canBulkSelect && (
                    <input type="checkbox" checked={isSelected} disabled={!canSelect} onChange={() => {}}
                      onClick={e => canSelect && handleCheckboxClick(e, i)}
                      title={!canSelect ? 'Cannot move negative or zero stock' : ''}
                      style={{ accentColor: 'var(--accent)', cursor: canSelect ? 'pointer' : 'not-allowed' }} />
                  )}
                  <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {onJumpToPart ? (
                        <button type="button" onClick={() => onJumpToPart(r.part_id)} title="View this part in the Parts tab"
                          style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>{r.name}</button>
                      ) : r.name}
                    </span>
                    {inRollupMode && r.locationCount > 1 && (
                      <span className="pill pill-muted pill-sm" style={{ flexShrink: 0 }}>{r.locationCount} spots</span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--hint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.part_id}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.category || '—'}</div>
                  <div style={{ textAlign: 'right' }}>
                    {isQtyPaused ? (
                      <span style={recencyPillStyle(r.last_movement_at)}>{recencyOf(r.last_movement_at).label}</span>
                    ) : (
                      <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: total < 0 ? 'var(--red)' : total <= 0 ? 'var(--amber)' : 'var(--text)' }}>
                        {total.toLocaleString()}<span style={{ color: 'var(--hint)', fontWeight: 500, marginLeft: 3 }}>{r.unit}</span>
                      </span>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {!isQtyPaused && <span className={`status ${st.cls}`} style={{ justifyContent: 'flex-end' }}>{st.label}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Phone: cards */}
      {filtered.length > 0 && !isWide && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((r, i) => {
            const isSelected = selectedIds.has(r.part_id)
            const isHighlighted = highlightedPartId === r.part_id
            const total = Number(r.total)
            const canSelect = canBulkSelect && total > 0
            const isDraft = r.is_active === false
            const st = stockStatus(r)
            return (
              <div key={r.part_id} ref={el => { stockRowRefs.current[r.part_id] = el }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                  background: isHighlighted ? 'var(--accent-lt)' : isSelected ? 'var(--selected-row)' : 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 'var(--r)',
                  boxShadow: isHighlighted ? 'inset 0 0 0 2px var(--accent)' : CARD_SHADOW,
                  transition: 'background .25s', opacity: isDraft ? 0.6 : 1,
                }}>
                {canBulkSelect && (
                  <input type="checkbox" checked={isSelected} disabled={!canSelect} onChange={() => {}}
                    onClick={e => canSelect && handleCheckboxClick(e, i)}
                    style={{ accentColor: 'var(--accent)', cursor: canSelect ? 'pointer' : 'not-allowed', flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {onJumpToPart ? (
                      <button type="button" onClick={() => onJumpToPart(r.part_id)} style={{ background: 'transparent', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>{r.name}</button>
                    ) : r.name}
                    {inRollupMode && r.locationCount > 1 && <span className="pill pill-muted pill-sm" style={{ marginLeft: 6 }}>{r.locationCount} spots</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--hint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>
                    {r.part_id}{r.category ? ` · ${r.category}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  {isQtyPaused ? (
                    <span style={recencyPillStyle(r.last_movement_at)}>{recencyOf(r.last_movement_at).label}</span>
                  ) : (
                    <>
                      <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: total < 0 ? 'var(--red)' : total <= 0 ? 'var(--amber)' : 'var(--text)' }}>
                        {total.toLocaleString()}<span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 500, marginLeft: 3 }}>{r.unit}</span>
                      </div>
                      <span className={`status ${st.cls}`} style={{ justifyContent: 'flex-end', marginTop: 2 }}>{st.label}</span>
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
          background: 'var(--dark-bar)', borderRadius: 'var(--r)', padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          boxShadow: '0 -6px 20px rgba(15,23,42,0.20)',
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', flex: 1 }}>
            {selectedCount} selected
          </div>
          {!readOnly && (
            <button
              onClick={() => setShowBulkMove(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '8px 14px', borderRadius: 8, border: 'none',
                background: 'var(--accent)', color: '#fff',
                fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            ><Icon name="move" size={15} /> Bulk move</button>
          )}
          <button
            onClick={() => setShowPrSheet(true)}
            title="Create a purchase request seeded with the selected parts"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.3)', background: 'transparent', color: '#fff',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          ><Icon name="clipboard" size={15} /> Create PR</button>
          <button onClick={clearSelection} style={{
            padding: '8px 12px', borderRadius: 8, border: 'none', background: 'transparent',
            color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>Clear</button>
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

// Deliberately smaller accent sub-pill (bin drill-in) — NOT a drifted copy of
// the shared 30px chipStyle in ./chrome.jsx; stays local on purpose.
function subPillStyle(selected) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 28, padding: '0 11px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
    whiteSpace: 'nowrap', cursor: 'pointer',
    background: selected ? 'var(--accent-lt)' : 'var(--surface)',
    color: selected ? 'var(--accent-dk)' : 'var(--muted)',
    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border2)'}`,
  }
}
