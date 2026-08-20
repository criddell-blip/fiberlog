import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import { getAllParts, updatePart, updatePartsBatch, getStockTotalsByPart, getPartLocations, deleteDraftPart, SONAR_ROUTING_OPTIONS } from '../../lib/inventory'
import { escapeCsvField, downloadTextAsFile } from '../../lib/csvImport'
import { isoLocalDate } from '../../lib/format'
import SkuLabelSheet from './SkuLabelSheet'
import BulkMoveSheet from './BulkMoveSheet'
import PurchaseRequestSheet from './PurchaseRequestSheet'
import PartHistoryPanel from './PartHistoryPanel'
import { recencyPillStyle, recencyOf } from '../../lib/recencyPill'
import { useBackClose } from '../../lib/backStack'
import { useIsWide } from '../../lib/useIsWide'
import { chipStyle, cardSurface, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

const COMMON_UNITS = ['ea', 'ft', 'm', 'in', 'lb', 'kg', 'box', 'roll', 'spool', 'pair', 'pack', 'kit']

export default function InventoryPartsTab({ refreshKey, onChanged, focusJump, onJumpToLocation, locations, currentUser, readOnly = false }) {
  const { showToast, isQtyPaused } = useApp()
  // Desktop = single horizontal row; phone = stacked card so the part name/SKU
  // get their own full-width line instead of being crushed to 0 by the action
  // buttons (mirrors InventoryStockTab's responsive split).
  const isWide = useIsWide()
  // Default to the active-parts view. Drafts (auto-created by CSV imports
  // for SKUs not yet in the catalog) used to be the default since cleanup
  // was the day-job — the active list is what the owner actually wants
  // to see first now that drafts are mostly handled.
  const [filter, setFilter] = useState('active')
  const [search, setSearch] = useState('')
  const [parts, setParts] = useState([])
  const [stockTotals, setStockTotals] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [bulkEditing, setBulkEditing] = useState(false)
  const [showLabelSheet, setShowLabelSheet] = useState(false)
  // PR composition sheet seeded with the bulk-selected parts
  const [showPrSheet, setShowPrSheet] = useState(false)
  // The part whose location-breakdown overlay is open. NULL = closed.
  const [viewingLocationsFor, setViewingLocationsFor] = useState(null)
  // The part whose movement-history overlay is open. NULL = closed.
  const [viewingHistoryFor, setViewingHistoryFor] = useState(null)

  // Back closes the edit-part form or the location-breakdown overlay. The label
  // / bulk-move / PR sheets self-register, so they're not listed here — and
  // neither is PartHistoryPanel, for the same reason (registering it here too
  // would take two Back presses to close it).
  useBackClose(editing ? 1 : 0, () => setEditing(null))
  useBackClose(viewingLocationsFor ? 1 : 0, () => setViewingLocationsFor(null))

  // Selection: a Set of part ids checked for bulk operations
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  // Anchor index for shift-click range select. Cleared when the filtered
  // list changes (so a stale anchor doesn't carry across filter/search changes).
  const lastClickedIndexRef = useRef(null)

  // Per-row refs + transient highlight for the launcher/cross-link focus
  // mechanism. focusJump arrives as { partId, n } — when n bumps, scroll
  // to that part's row and highlight it briefly.
  const partRowRefs = useRef({})
  const [highlightedPartId, setHighlightedPartId] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const [allParts, totals] = await Promise.all([
        getAllParts(),
        getStockTotalsByPart(),
      ])
      setParts(allParts)
      setStockTotals(totals)
    } catch (e) {
      console.error('Load parts failed:', e)
      showToast('Could not load parts: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [refreshKey])

  // Reset selection AND anchor whenever the visible list might shift around
  useEffect(() => {
    setSelectedIds(new Set())
    lastClickedIndexRef.current = null
  }, [filter, search])

  // Launcher / cross-link focus. When focusJump.n bumps, scroll to the
  // target part and highlight it for ~2 sec. Auto-relaxes the filter to
  // 'all' if the target part would otherwise be hidden by the current
  // active/draft toggle.
  //
  // Gates: we need parts to be loaded (the .find lookup needs data) AND
  // we use a processedJumpRef so re-runs from `parts` changing for
  // unrelated reasons (refresh, bulk-edit) don't re-trigger the focus.
  // Without these, the common case — switching tabs from Stock and
  // mounting Parts fresh — silently dropped the focus because `parts`
  // was still empty when the effect fired.
  const processedJumpRef = useRef(-1)
  useEffect(() => {
    if (!focusJump || !focusJump.partId) return
    if (parts.length === 0) return  // wait for the initial load
    if (focusJump.n === processedJumpRef.current) return  // already handled
    processedJumpRef.current = focusJump.n
    const target = parts.find(p => p.id === focusJump.partId)
    if (!target) return
    // Make sure the target is visible under the current filter.
    if (filter === 'active' && !target.is_active) setFilter('all')
    if (filter === 'draft'  &&  target.is_active) setFilter('all')
    // Clear any search that would hide the row.
    if (search && search.trim().length >= 2) {
      const q = search.toLowerCase()
      const matchesSearch = (target.name || '').toLowerCase().includes(q)
        || (target.id || '').toLowerCase().includes(q)
        || (target.sage_id || '').toLowerCase().includes(q)
        || (target.category || '').toLowerCase().includes(q)
      if (!matchesSearch) setSearch('')
    }
    // Defer scroll/highlight a tick so the filter change has rendered.
    const t = setTimeout(() => {
      const el = partRowRefs.current[focusJump.partId]
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setHighlightedPartId(focusJump.partId)
    }, 60)
    const clear = setTimeout(() => setHighlightedPartId(null), 2200)
    return () => { clearTimeout(t); clearTimeout(clear) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusJump?.n, parts.length])

  const distinctValues = useMemo(() => {
    const depts = new Set()
    const itemTypes = new Set()
    const matGroups = new Set()
    for (const p of parts) {
      if (p.department) depts.add(p.department)
      if (p.item_type) itemTypes.add(p.item_type)
      if (p.material_group) matGroups.add(p.material_group)
    }
    return {
      departments: [...depts].sort(),
      itemTypes: [...itemTypes].sort(),
      materialGroups: [...matGroups].sort(),
    }
  }, [parts])

  const counts = useMemo(() => ({
    all:    parts.length,
    active: parts.filter(p => p.is_active).length,
    draft:  parts.filter(p => !p.is_active).length,
    nosage: parts.filter(p => p.is_active && !p.sage_id).length,
  }), [parts])

  const filtered = useMemo(() => {
    let list = parts
    if (filter === 'active') list = list.filter(p => p.is_active)
    if (filter === 'draft')  list = list.filter(p => !p.is_active)
    // Active parts the Sage export still ships as a raw SKU — the work-down
    // list for whoever curates the Sage cross-reference.
    if (filter === 'nosage') list = list.filter(p => p.is_active && !p.sage_id)

    if (search && search.trim().length >= 2) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.id   || '').toLowerCase().includes(q) ||
        (p.sage_id || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
      )
    }

    if (filter === 'draft') {
      list = [...list].sort((a, b) => {
        const aQty = stockTotals.get(a.id) || 0
        const bQty = stockTotals.get(b.id) || 0
        if (bQty !== aQty) return bQty - aQty
        return (a.name || '').localeCompare(b.name || '')
      })
    } else {
      list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    }
    return list
  }, [parts, filter, search, stockTotals])

  // Selection logic. handleCheckboxClick receives the click event so we
  // can read e.shiftKey for range select.
  function handleCheckboxClick(e, index) {
    const partId = filtered[index].id
    const anchor = lastClickedIndexRef.current

    if (e.shiftKey && anchor !== null && anchor !== index) {
      // Range select: add every row from anchor to clicked (inclusive) to
      // the existing selection. Doesn't deselect anything.
      const from = Math.min(anchor, index)
      const to   = Math.max(anchor, index)
      setSelectedIds(prev => {
        const next = new Set(prev)
        for (let j = from; j <= to; j++) next.add(filtered[j].id)
        return next
      })
      // Update anchor to where they just clicked so the next shift-click
      // extends from this position
      lastClickedIndexRef.current = index
      return
    }

    // Normal click: toggle this row's selection and set new anchor
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId); else next.add(partId)
      return next
    })
    lastClickedIndexRef.current = index
  }

  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map(p => p.id)))
  }
  function clearSelection() {
    setSelectedIds(new Set())
    lastClickedIndexRef.current = null
  }
  const allVisibleSelected = filtered.length > 0 && filtered.every(p => selectedIds.has(p.id))

  // Plain parts-catalog export — what the current filter + search show, one
  // row per part. On Hand comes from the stockTotals map the tab already
  // loads, summed across every location (a parts list without on-hand is
  // half useless on a warehouse floor).
  function handleExportCsv() {
    const headers = [
      'SKU', 'Sage ID', 'Name', 'Nickname', 'Unit', 'Department', 'Item Type',
      'Material Group', 'Category', 'Status', 'Barcode', 'BoxHero ID', 'On Hand',
    ]
    const lines = [headers.map(escapeCsvField).join(',')]
    for (const p of filtered) {
      lines.push([
        p.id, p.sage_id || '', p.name || '', p.nickname || '', p.unit || 'ea',
        p.department || '', p.item_type || '', p.material_group || '',
        p.category || '', p.is_active ? 'active' : 'draft',
        p.barcode || '', p.boxhero_id || '',
        Number(stockTotals.get(p.id) || 0),
      ].map(escapeCsvField).join(','))
    }
    const stamp = isoLocalDate()
    // Filter in the filename: a "-draft-" file and an "-active-" file must
    // never be mistaken for one another once they're both on a clipboard.
    const scope = search.trim() ? `${filter}-search` : filter
    downloadTextAsFile(`fiberlog-parts-${scope}-${stamp}.csv`, lines.join('\n'))
    showToast(`Exported ${filtered.length} parts`)
  }

  async function handleSave(updates) {
    try {
      await updatePart(editing.id, updates)
      setEditing(null)
      await load()
      onChanged?.()
      showToast('Saved')
    } catch (e) {
      console.error('Save part failed:', e)
      // Partial unique index on sage_id: one Sage item ↔ one SKU. Keyed on
      // the index name (parts_catalog_sage_id_idx) appearing in the message —
      // renaming the index demotes this to the generic toast. Name the SKU
      // already holding it so the manager can go fix the right row.
      if (e?.code === '23505' && /sage_id/.test(e.message || '')) {
        const holder = parts.find(p => p.id !== editing.id && p.sage_id === updates.sage_id)
        showToast(`Sage ID ${updates.sage_id} is already on ${holder ? holder.id : 'another part'}`)
        return
      }
      showToast('Save failed: ' + e.message)
    }
  }

  async function handleQuickActivate(part) {
    if (!window.confirm(`Activate "${part.name}"?`)) return
    try {
      await updatePart(part.id, { is_active: true })
      await load()
      onChanged?.()
      showToast(`Activated ${part.name}`)
    } catch (e) {
      showToast('Activate failed: ' + e.message)
    }
  }

  // Hard-delete a mistake draft. The DB blocks it (FK) once anything
  // references the part — that error comes back as the friendly
  // "has history, retire instead" message from deleteDraftPart.
  async function handleDeleteDraft(part) {
    if (!window.confirm(`Permanently delete draft "${part.name}" (${part.id})?\n\nOnly possible while nothing references it. This cannot be undone.`)) return
    try {
      await deleteDraftPart(part.id)
      setSelectedIds(prev => { const n = new Set(prev); n.delete(part.id); return n })
      await load()
      onChanged?.()
      showToast(`Deleted draft ${part.id}`)
    } catch (e) {
      showToast(e.message || 'Delete failed')
    }
  }

  async function handleQuickDeactivate(part) {
    if (!window.confirm(`Deactivate "${part.name}"?`)) return
    try {
      await updatePart(part.id, { is_active: false })
      await load()
      onChanged?.()
      showToast(`Deactivated ${part.name}`)
    } catch (e) {
      showToast('Deactivate failed: ' + e.message)
    }
  }

  async function handleBulkActivate() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`Activate ${ids.length} part${ids.length === 1 ? '' : 's'}?`)) return
    try {
      const result = await updatePartsBatch(ids, { is_active: true })
      setSelectedIds(new Set())
      lastClickedIndexRef.current = null
      await load()
      onChanged?.()
      showToast(`Activated ${result.updated.length}${result.errors.length ? ` · ${result.errors.length} failed` : ''}`)
    } catch (e) {
      showToast('Bulk activate failed: ' + e.message)
    }
  }

  async function handleBulkDeactivate() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (!window.confirm(`Deactivate ${ids.length} part${ids.length === 1 ? '' : 's'}? Stock & history are preserved.`)) return
    try {
      const result = await updatePartsBatch(ids, { is_active: false })
      setSelectedIds(new Set())
      lastClickedIndexRef.current = null
      await load()
      onChanged?.()
      showToast(`Deactivated ${result.updated.length}${result.errors.length ? ` · ${result.errors.length} failed` : ''}`)
    } catch (e) {
      showToast('Bulk deactivate failed: ' + e.message)
    }
  }

  async function handleBulkEdit(updates) {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    try {
      const result = await updatePartsBatch(ids, updates)
      setBulkEditing(false)
      setSelectedIds(new Set())
      lastClickedIndexRef.current = null
      await load()
      onChanged?.()
      const errCount = result.errors?.length || 0
      showToast(`Updated ${result.updated.length}${errCount ? ` · ${errCount} failed` : ''}`)
      if (errCount > 0) console.warn('Bulk edit row failures:', result.errors)
    } catch (e) {
      showToast('Bulk edit failed: ' + e.message)
    }
  }

  if (loading) {
    return <LoadingBlock label="Loading parts…" />
  }

  const selectedCount = selectedIds.size

  return (
    <div style={{ position: 'relative', paddingBottom: selectedCount > 0 ? 76 : 0 }}>
      {/* Compact filter pills — 4 options, stay visible. Reduced
          padding from previous so they sit at ~28px row instead of 35px. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('all')} style={chipStyle(filter === 'all')}>
          All ({counts.all})
        </button>
        <button onClick={() => setFilter('active')} style={chipStyle(filter === 'active')}>
          Active ({counts.active})
        </button>
        <button onClick={() => setFilter('draft')} style={chipStyle(filter === 'draft', { color: 'amber' })}>
          <Icon name="alert" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Drafts ({counts.draft})
        </button>
        <button onClick={() => setFilter('nosage')} style={chipStyle(filter === 'nosage')} title="Active parts with no Sage Intacct item ID yet">
          No Sage ID ({counts.nosage})
        </button>
      </div>

      <div style={{ position: 'relative', marginBottom: 8 }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--hint)', display: 'flex', pointerEvents: 'none' }}>
          <Icon name="search" size={16} />
        </span>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search parts by name, SKU, or category…"
          style={{
            width: '100%', height: 38, padding: '0 12px 0 36px',
            border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)',
            fontSize: 14, background: 'var(--surface)',
          }}
        />
      </div>

      {/* Compressed stats row — single line, smaller font. Tip text moves
          to the select-all button's title attribute so it doesn't eat a row. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
        <div className="mono" style={{ fontSize: 12, color: 'var(--hint)' }}>
          {filtered.length.toLocaleString()} of {parts.length.toLocaleString()} parts
          {filter === 'draft' && counts.draft > 0 && (
            <span style={{ marginLeft: 6 }}>· sorted by stock</span>
          )}
        </div>
        {filtered.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {/* Exports exactly what the current filter + search show, so the
                file always matches the screen. The filter goes in the filename
                — two printed lists with identical names but different truth is
                how count sheets go wrong. */}
            <button
              onClick={handleExportCsv}
              title="Download the parts shown below as a CSV"
              style={chipStyle(false)}
            >
              <Icon name="download" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 5 }} />
              Export CSV
            </button>
            <button
              onClick={allVisibleSelected ? clearSelection : selectAllVisible}
              title="Tip: shift-click a part to select a range"
              style={chipStyle(false)}
            >
              {allVisibleSelected ? 'Deselect all' : `Select all ${filtered.length}`}
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState>
          {parts.length === 0 ? 'No parts yet' : 'No parts match your filters'}
        </EmptyState>
      ) : (
        <div style={{ ...cardSurface, overflow: 'hidden' }}>
          {filtered.map((p, i) => {
            const stockQty = stockTotals.get(p.id) || 0
            const isSelected = selectedIds.has(p.id)
            const isHighlighted = highlightedPartId === p.id
            // Shared pieces so desktop row + phone card stay in sync.
            const checkbox = (
              // onClick (not onChange) so we can read e.shiftKey for range select.
              <input type="checkbox" checked={isSelected} onChange={() => {}}
                onClick={e => handleCheckboxClick(e, i)}
                style={{ cursor: 'pointer', flexShrink: 0 }} />
            )
            const statusBadge = (
              <span className={`status ${p.is_active ? 'status-instock' : 'status-draft'}`} style={{ flexShrink: 0, width: 56 }}>
                {p.is_active ? 'ACTIVE' : 'DRAFT'}
              </span>
            )
            const nameBlock = (
              <>
                <div style={{ fontWeight: 600, fontSize: 13.5, ...(isWide ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}) }}>
                  {p.name}
                  {p.nickname && (
                    <span style={{ fontWeight: 400, color: 'var(--accent-dk)', marginLeft: 6, fontStyle: 'italic', fontSize: 12 }}>
                      aka {p.nickname}
                    </span>
                  )}
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--hint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.id}
                  {p.sage_id && <span style={{ color: 'var(--accent-dk)' }}> · Sage {p.sage_id}</span>}
                  {' · '}{p.unit || 'ea'} · {p.category || 'Uncategorized'}
                </div>
                {/* Draft provenance: which flow minted this draft, who, when.
                    attributes.created_via is stamped at every creation path
                    (imports, Receive PO, found-inventory, cycle count);
                    drafts that predate the stamp fall back to created_at. */}
                {!p.is_active && (
                  <div style={{ fontSize: 11, color: 'var(--amber)', ...(isWide ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : {}) }}>
                    {draftOriginLine(p)}
                  </div>
                )}
              </>
            )
            const stockBlock = (
              isQtyPaused ? (
                stockQty > 0 ? (
                  <span className="pill pill-success pill-sm">stocked</span>
                ) : (
                  <span style={{ fontSize: 10, color: 'var(--hint)' }}>—</span>
                )
              ) : (
                <>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: stockQty > 0 ? 'var(--text)' : 'var(--hint)' }}>
                    {stockQty.toLocaleString()}
                  </div>
                  <div className="eyebrow" style={{ fontSize: 9 }}>in stock</div>
                </>
              )
            )
            const actionButtons = (
              <>
                {!readOnly && (!p.is_active ? (
                  <>
                    <button onClick={() => handleQuickActivate(p)} style={quickBtnStyle('teal')}>Activate</button>
                    <button
                      onClick={() => handleDeleteDraft(p)}
                      style={quickBtnStyle('red')}
                      title="Permanently delete this draft (only possible while nothing references it)"
                    >Delete</button>
                  </>
                ) : (
                  <button onClick={() => handleQuickDeactivate(p)} style={quickBtnStyle('amber')}>Retire</button>
                ))}
                {/* Read-only info, so deliberately outside the !readOnly guard
                    like Locations — accounting scope is arguably the primary
                    audience for "what did we pay, to whom, when". */}
                <button
                  onClick={() => setViewingHistoryFor(p)}
                  style={{ ...quickBtnStyle('default'), display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  title="Receive and movement history for this part"
                >
                  <Icon name="activity" size={13} /> History
                </button>
                <button
                  onClick={() => setViewingLocationsFor(p)}
                  style={{ ...quickBtnStyle('default'), display: 'inline-flex', alignItems: 'center', gap: 5 }}
                  title="See which locations have logged stock of this part"
                >
                  <Icon name="pin" size={13} /> Locations
                </button>
                {!readOnly && <button onClick={() => setEditing(p)} style={quickBtnStyle('default')}>Edit</button>}
              </>
            )

            const rowBg = isHighlighted ? 'var(--accent-lt)' : isSelected ? 'var(--selected-row)' : 'transparent'
            const rowShadow = isHighlighted ? 'inset 0 0 0 2px var(--accent)' : 'none'

            if (isWide) {
              return (
                <div key={p.id} ref={el => { partRowRefs.current[p.id] = el }}
                  style={{
                    display: 'flex', alignItems: 'center', padding: '10px 14px', gap: 10,
                    borderBottom: i < filtered.length - 1 ? '1px solid var(--row-divider)' : 'none',
                    background: rowBg, boxShadow: rowShadow,
                    transition: 'background 0.25s, box-shadow 0.25s',
                  }}>
                  {checkbox}
                  {statusBadge}
                  <div style={{ flex: 1, minWidth: 0 }}>{nameBlock}</div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 60 }}>{stockBlock}</div>
                  <div style={{ display: 'flex', gap: 4 }}>{actionButtons}</div>
                </div>
              )
            }

            // Phone: stacked card — name/SKU on their own full-width line so the
            // action buttons can't squeeze them out; badge/stock/actions reflow below.
            return (
              <div key={p.id} ref={el => { partRowRefs.current[p.id] = el }}
                style={{
                  padding: '12px 14px',
                  borderBottom: i < filtered.length - 1 ? '1px solid var(--row-divider)' : 'none',
                  background: rowBg, boxShadow: rowShadow,
                  transition: 'background 0.25s, box-shadow 0.25s',
                }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  {checkbox}
                  <div style={{ flex: 1, minWidth: 0 }}>{nameBlock}</div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 52 }}>{stockBlock}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8, paddingLeft: 26 }}>
                  {statusBadge}
                  {actionButtons}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedCount > 0 && (
        <div style={{
          position: 'sticky', bottom: 0, marginTop: 10,
          background: 'var(--dark-bar)', borderRadius: 'var(--r)', padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          boxShadow: '0 -6px 20px rgba(15,23,42,0.20)',
        }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#fff', flex: 1 }}>
            {selectedCount} selected
          </div>
          {!readOnly && <button onClick={() => setBulkEditing(true)} style={bulkActionBtn('orange')}><Icon name="edit" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} /> Bulk edit</button>}
          <button onClick={() => setShowLabelSheet(true)} style={bulkActionBtn('purple')}><Icon name="tag" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Labels</button>
          {!readOnly && <button onClick={() => setShowPrSheet(true)} style={bulkActionBtn('orange')}><Icon name="clipboard" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Create PR</button>}
          {!readOnly && <button onClick={handleBulkActivate} style={bulkActionBtn('teal')}><Icon name="check" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Activate</button>}
          {!readOnly && <button onClick={handleBulkDeactivate} style={bulkActionBtn('amber')}>⊘ Deactivate</button>}
          <button onClick={clearSelection} style={bulkActionBtn('ghost')}>Cancel</button>
        </div>
      )}

      {showLabelSheet && (
        <SkuLabelSheet
          parts={filtered.filter(p => selectedIds.has(p.id))}
          title={`Print labels for ${selectedCount} selected part${selectedCount === 1 ? '' : 's'}`}
          onClose={() => setShowLabelSheet(false)}
        />
      )}

      {editing && (
        <PartFormSheet
          part={editing}
          distinctValues={distinctValues}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {bulkEditing && (
        <BulkEditSheet
          count={selectedCount}
          distinctValues={distinctValues}
          onCancel={() => setBulkEditing(false)}
          onSave={handleBulkEdit}
        />
      )}

      {viewingLocationsFor && (
        <PartLocationsPanel
          part={viewingLocationsFor}
          locations={locations}
          currentUser={currentUser}
          readOnly={readOnly}
          onClose={() => setViewingLocationsFor(null)}
          onJumpToLocation={(id) => { setViewingLocationsFor(null); onJumpToLocation?.(id) }}
          onMoved={() => { setViewingLocationsFor(null); onChanged?.() }}
        />
      )}

      {/* Read-only, and unmounted on close so reopening always refetches —
          hence no refreshKey thread and no onChanged callback. */}
      {viewingHistoryFor && (
        <PartHistoryPanel
          part={viewingHistoryFor}
          onClose={() => setViewingHistoryFor(null)}
        />
      )}

      {showPrSheet && (
        <PurchaseRequestSheet
          mode="new"
          initialParts={filtered
            .filter(p => selectedIds.has(p.id))
            .map(p => ({ id: p.id, name: p.name, unit: p.unit }))}
          locations={locations || []}
          onClose={() => setShowPrSheet(false)}
          onSaved={() => { setShowPrSheet(false); setSelectedIds(new Set()) }}
        />
      )}
    </div>
  )
}

// Where-is-this-part overlay. Lists every location with logged stock
// of the chosen part, qty-desc, with the same "Warehouse · Bin" label
// format used elsewhere. Re-fetches on every open so the data is fresh.
//
// Disclaimer reminds the user this is FiberLog's logged view, not
// authoritative — Sage owns the verified counts (per the transactional-
// only positioning).
function PartLocationsPanel({ part, locations, currentUser, readOnly = false, onClose, onJumpToLocation, onMoved }) {
  const { isQtyPaused } = useApp()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [data, setData] = useState({ totalQty: 0, locations: [] })
  // When the user clicks "Move from here" on a location row, hold the
  // pre-built sourceLocation + selectedRows so BulkMoveSheet can open
  // with the part + source already populated. NULL = closed.
  const [moveContext, setMoveContext] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    getPartLocations(part.id)
      .then(r => { if (!cancelled) setData(r) })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [part.id])

  function handleMoveFromHere(l) {
    const sourceLocation = {
      id: l.locationId,
      name: l.name,
      type: l.type,
      parent_location_id: l.parentLocationId || null,
    }
    const selectedRows = [{
      part_id: part.id,
      name: part.name,
      unit: part.unit || 'ea',
      quantity: l.qty,  // pre-fill move qty with current logged qty; user can lower
    }]
    setMoveContext({ sourceLocation, selectedRows })
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 560 }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 2 }}>
          {part.name}
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          {part.id}{part.unit ? ` · ${part.unit}` : ''}
        </div>

        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
            Loading locations…
          </div>
        )}
        {err && (
          <div style={{
            padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
          }}>
            {err}
          </div>
        )}
        {!loading && !err && (
          <>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 8 }}>
              Logged at <strong>{data.locations.length}</strong> location{data.locations.length === 1 ? '' : 's'}
              {!isQtyPaused && (
                <> · <strong>{data.totalQty.toLocaleString()}</strong> {part.unit || 'ea'} total</>
              )}
            </div>

            {data.locations.length === 0 && (
              <div style={{
                padding: 20, textAlign: 'center', color: 'var(--hint)',
                fontSize: 'var(--fs-sm)',
                border: '1px dashed var(--border)', borderRadius: 'var(--r-sm)',
                marginBottom: 12,
              }}>
                No logged stock at any location for this part.
              </div>
            )}

            {data.locations.length > 0 && (
              <div style={{
                maxHeight: '50vh', overflowY: 'auto',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                marginBottom: 12,
              }}>
                {data.locations.map(l => (
                  <div key={l.locationId} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 'var(--fs-sm)',
                  }}>
                    <div style={{
                      fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-bold)',
                      color: 'var(--muted)', minWidth: 56,
                      padding: '2px 6px', borderRadius: 6,
                      background: 'var(--surface2)',
                      textTransform: 'uppercase',
                    }}>
                      {l.type === 'bin' ? 'bin' : l.type}
                    </div>
                    <div style={{ flex: 1, fontWeight: 'var(--fw-semibold)', minWidth: 0 }}>
                      {l.displayLabel}
                    </div>
                    {isQtyPaused ? (
                      <span style={recencyPillStyle(l.lastMovementAt)}>
                        {recencyOf(l.lastMovementAt).label}
                      </span>
                    ) : (
                      <div style={{
                        minWidth: 50, textAlign: 'right',
                        fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)',
                        color: 'var(--orange)',
                      }}>
                        {l.qty.toLocaleString()}
                      </div>
                    )}
                    {/* Cross-link: jump to this location in the Locations tab */}
                    {onJumpToLocation && (
                      <button
                        type="button"
                        onClick={() => onJumpToLocation(l.locationId)}
                        title="Open this location in the Locations tab"
                        style={{
                          fontSize: 10, padding: '3px 8px',
                          background: 'transparent', color: 'var(--muted)',
                          border: '1px solid var(--border)', borderRadius: 'var(--r-xs)',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        → Location
                      </button>
                    )}
                    {/* Move stock from here → opens BulkMoveSheet pre-filled.
                        Project (job_site) buckets are accumulate-only ledgers —
                        you can SEE a part sitting in one, but not pull it back
                        out from here. (vendor/scrap likewise aren't pull sources.) */}
                    {!readOnly && l.qty > 0 && !['job_site', 'vendor', 'scrap'].includes(l.type) && (
                      <button
                        type="button"
                        onClick={() => handleMoveFromHere(l)}
                        title={`Move some of this part out of ${l.displayLabel}`}
                        style={{
                          fontSize: 10, padding: '3px 8px',
                          background: 'var(--orange-lt)', color: 'var(--orange)',
                          border: '1px solid var(--orange)', borderRadius: 'var(--r-xs)',
                          cursor: 'pointer', whiteSpace: 'nowrap',
                          fontWeight: 700,
                        }}
                      >
                        Move from here
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={{
              fontSize: 'var(--fs-xs)', color: 'var(--hint)',
              fontStyle: 'italic', marginBottom: 12, lineHeight: 1.4,
            }}>
              Based on logged movements in FiberLog. Sage is authoritative for physical counts —
              these numbers may drift from reality until reconciled there.
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {moveContext && (
        <BulkMoveSheet
          sourceLocation={moveContext.sourceLocation}
          selectedRows={moveContext.selectedRows}
          locations={locations || []}
          currentUser={currentUser}
          onClose={() => setMoveContext(null)}
          onComplete={() => { setMoveContext(null); onMoved?.() }}
        />
      )}
    </div>
  )
}

// Small per-row action button (outline chip).
// One-line provenance for a draft row: source flow + detail + who + when.
// Falls back to the DB created_at for drafts minted before stamping existed.
function draftOriginLine(p) {
  const cv = p.attributes?.created_via
  const when = p.created_at
    ? new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null
  if (!cv) return `Draft · origin unknown${when ? ` · created ${when}` : ''}`
  const bits = [cv.source]
  if (cv.detail) bits.push(cv.detail)
  if (cv.by) bits.push(`by ${cv.by}`)
  if (when) bits.push(when)
  return `Draft · ${bits.join(' · ')}`
}

function quickBtnStyle(variant) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '5px 9px', borderRadius: 8, fontSize: 11, fontWeight: 600,
    cursor: 'pointer', whiteSpace: 'nowrap', background: 'var(--surface)',
    border: '1px solid var(--border2)',
  }
  if (variant === 'teal')  return { ...base, color: 'var(--accent-dk)', borderColor: 'var(--accent)' }
  if (variant === 'amber') return { ...base, color: 'var(--amber)', borderColor: 'var(--amber)' }
  if (variant === 'red')   return { ...base, color: 'var(--red)', borderColor: 'var(--red)' }
  return { ...base, color: 'var(--muted)' }
}

// Buttons inside the dark bulk-select bar: emerald primary, ghost cancel, or
// outlined-on-dark for the rest.
function bulkActionBtn(variant) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 13px', borderRadius: 8, fontSize: 13, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap',
  }
  if (variant === 'orange') return { ...base, border: 'none', background: 'var(--accent)', color: '#fff' }
  if (variant === 'ghost')  return { ...base, border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }
  return { ...base, border: '1px solid rgba(255,255,255,0.3)', background: 'transparent', color: '#fff' }
}

// ─── Single-part edit sheet ─────────────────────────────────────────────────

function PartFormSheet({ part, distinctValues, onCancel, onSave }) {
  const [name, setName] = useState(part.name || '')
  const [nickname, setNickname] = useState(part.nickname || '')
  // Sage Intacct Item ID — a cross-reference that rides next to the SKU; the
  // SKU itself is the immutable key and is not editable here.
  const [sageId, setSageId] = useState(part.sage_id || '')

  // Open-ended attribute bag. Stored as an array of {key, value} for
  // stable rendering during editing; serialized to a plain object on
  // submit. New keys added at the bottom; deleting clears the row.
  const [attrRows, setAttrRows] = useState(() => {
    const obj = part.attributes && typeof part.attributes === 'object' ? part.attributes : {}
    return Object.entries(obj).map(([key, value]) => ({
      key,
      value: value == null ? '' : String(value),
    }))
  })
  function addAttrRow() {
    setAttrRows(prev => [...prev, { key: '', value: '' }])
  }
  function setAttrRow(idx, patch) {
    setAttrRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r))
  }
  function removeAttrRow(idx) {
    setAttrRows(prev => prev.filter((_, i) => i !== idx))
  }

  const [unit, setUnit] = useState(part.unit || 'ea')
  const [unitCustom, setUnitCustom] = useState(!COMMON_UNITS.includes(part.unit || 'ea'))

  const [department, setDepartment] = useState(part.department || '')
  const [departmentCustom, setDepartmentCustom] = useState(
    !!part.department && !distinctValues.departments.includes(part.department)
  )

  const [itemType, setItemType] = useState(part.item_type || '')
  const [itemTypeCustom, setItemTypeCustom] = useState(
    !!part.item_type && !distinctValues.itemTypes.includes(part.item_type)
  )

  const [materialGroup, setMaterialGroup] = useState(part.material_group || '')
  const [materialGroupCustom, setMaterialGroupCustom] = useState(
    !!part.material_group && !distinctValues.materialGroups.includes(part.material_group)
  )

  const [isActive, setIsActive] = useState(part.is_active !== false)
  const [sonarRouting, setSonarRouting] = useState(part.sonar_routing || 'ask')
  const [saving, setSaving] = useState(false)

  const previewCategory = useMemo(() => {
    const d = (department || '').trim()
    const m = (materialGroup || '').trim()
    if (d && m) return `${d} / ${m}`
    if (d) return d
    if (m) return m
    return 'Uncategorized'
  }, [department, materialGroup])

  async function handleSubmit() {
    if (!name.trim()) return
    setSaving(true)
    try {
      // Collapse attribute rows back to a plain object. Skip empty keys;
      // dedupe by key (last write wins for a given key).
      const attributes = {}
      for (const r of attrRows) {
        const k = (r.key || '').trim()
        if (!k) continue
        attributes[k] = (r.value || '').trim()
      }
      await onSave({
        name: name.trim(),
        nickname: nickname.trim() || null,
        sage_id: sageId.trim().toUpperCase() || null,   // Sage IDs are uppercase; the unique index is case-sensitive
        attributes,
        unit: unit.trim() || 'ea',
        department: department.trim() || null,
        item_type: itemType.trim() || null,
        material_group: materialGroup.trim() || null,
        is_active: isActive,
        sonar_routing: sonarRouting,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Edit part</div>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2, fontFamily: 'monospace', wordBreak: 'break-all' }}>{part.id}</div>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)', flexShrink: 0 }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div className="field">
            <label>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>

          <div className="field">
            <label>Nickname <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— crew-facing alias</span></label>
            <input
              type="text"
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder='e.g. "house box" for a Calix NID'
              autoComplete="off"
              name="part-nickname"
            />
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              Searched alongside name and SKU. Shows up next to the part name as <em>aka nickname</em>.
            </div>
          </div>

          <div className="field">
            <label>Sage ID <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— Sage Intacct item (SKU stays as-is)</span></label>
            <input
              type="text"
              value={sageId}
              onChange={e => setSageId(e.target.value)}
              placeholder="e.g. UB000011"
              autoComplete="off"
              name="part-sage-id"
              style={{ fontFamily: 'monospace' }}
            />
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              Written as ITEMID in the Sage export (the SKU is used when this is blank). One Sage ID per part.
            </div>
          </div>

          <FieldWithCustom label="Unit" value={unit} onChange={setUnit}
            custom={unitCustom} setCustom={setUnitCustom}
            options={COMMON_UNITS} placeholder="custom unit" allowEmpty={false} />

          <FieldWithCustom label="Department" value={department} onChange={setDepartment}
            custom={departmentCustom} setCustom={setDepartmentCustom}
            options={distinctValues.departments} placeholder="custom department" allowEmpty />

          <FieldWithCustom label="Material group" value={materialGroup} onChange={setMaterialGroup}
            custom={materialGroupCustom} setCustom={setMaterialGroupCustom}
            options={distinctValues.materialGroups} placeholder="custom material group" allowEmpty />

          <FieldWithCustom label="Item type" value={itemType} onChange={setItemType}
            custom={itemTypeCustom} setCustom={setItemTypeCustom}
            options={distinctValues.itemTypes} placeholder="custom item type" allowEmpty />

          <div className="field">
            <label>Category (auto)</label>
            <div style={{
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--border2)', background: 'var(--surface2)',
              fontSize: 13, color: 'var(--muted)',
            }}>
              {previewCategory}
              <span style={{ fontSize: 10, color: 'var(--hint)', marginLeft: 6 }}>
                (built from Department + Material group)
              </span>
            </div>
          </div>

          {/* Sonar routing policy — determines where Sonar imports send this
              part. Set once per SKU; persists across imports. */}
          <div className="field">
            <label>Sonar import routing</label>
            <select
              value={sonarRouting}
              onChange={e => setSonarRouting(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--bg)', color: 'var(--text)' }}
            >
              {SONAR_ROUTING_OPTIONS.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              {SONAR_ROUTING_OPTIONS.find(o => o.id === sonarRouting)?.desc}
            </div>
          </div>

          {/* Open-ended attributes — extensible without migrations. Anything
              you add here gets searched alongside the named fields in the
              crew Find-a-part view. */}
          <div className="field">
            <label>Custom attributes <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— optional</span></label>
            {attrRows.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 6 }}>
                No custom attributes yet. Add things like supplier code, alternate SKU, color — any key/value.
              </div>
            )}
            {attrRows.map((row, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  type="text"
                  value={row.key}
                  onChange={e => setAttrRow(idx, { key: e.target.value })}
                  placeholder="key (e.g. supplier_code)"
                  autoComplete="off"
                  name={`attr-key-${idx}`}
                  style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                />
                <input
                  type="text"
                  value={row.value}
                  onChange={e => setAttrRow(idx, { value: e.target.value })}
                  placeholder="value"
                  autoComplete="off"
                  name={`attr-val-${idx}`}
                  style={{ flex: 2, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                />
                <button
                  type="button"
                  onClick={() => removeAttrRow(idx)}
                  style={{ padding: '4px 10px', fontSize: 12, background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--r-xs)', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex', alignItems: 'center' }}
                  title="Remove this attribute"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addAttrRow}
              className="add-dashed"
              style={{ padding: '8px', fontSize: 12 }}
            >
              + Add attribute
            </button>
          </div>

          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, marginBottom: 6,
            padding: '10px 12px', borderRadius: 'var(--r-sm)',
            border: `1.5px solid ${isActive ? 'var(--teal)' : 'var(--amber)'}`,
            background: isActive ? 'var(--teal-lt)' : 'var(--amber-lt)',
            cursor: 'pointer',
          }}>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ marginTop: 2, cursor: 'pointer' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: isActive ? 'var(--teal)' : 'var(--amber)' }}>
                {isActive ? 'Active' : 'Draft (inactive)'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {isActive
                  ? 'Visible in all pickers and stock views'
                  : 'Stock is tracked but the part is hidden from regular pickers until activated'}
              </div>
            </div>
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Bulk-edit sheet ────────────────────────────────────────────────────────

function BulkEditSheet({ count, distinctValues, onCancel, onSave }) {
  const [editUnit, setEditUnit] = useState(false)
  const [unit, setUnit] = useState('ea')
  const [unitCustom, setUnitCustom] = useState(false)

  const [editDept, setEditDept] = useState(false)
  const [department, setDepartment] = useState('')
  const [deptCustom, setDeptCustom] = useState(false)

  const [editMatGrp, setEditMatGrp] = useState(false)
  const [materialGroup, setMaterialGroup] = useState('')
  const [matGrpCustom, setMatGrpCustom] = useState(false)

  const [editItemType, setEditItemType] = useState(false)
  const [itemType, setItemType] = useState('')
  const [itemTypeCustom, setItemTypeCustom] = useState(false)

  const [editSonarRouting, setEditSonarRouting] = useState(false)
  const [sonarRouting, setSonarRouting] = useState('ask')

  const [activeMode, setActiveMode] = useState('unchanged')

  const [saving, setSaving] = useState(false)

  const anyFieldChecked = editUnit || editDept || editMatGrp || editItemType || editSonarRouting || activeMode !== 'unchanged'

  async function handleSubmit() {
    if (!anyFieldChecked) return
    const updates = {}
    if (editUnit) updates.unit = unit.trim() || 'ea'
    if (editDept) updates.department = department.trim() || null
    if (editMatGrp) updates.material_group = materialGroup.trim() || null
    if (editItemType) updates.item_type = itemType.trim() || null
    if (editSonarRouting) updates.sonar_routing = sonarRouting
    if (activeMode === 'active') updates.is_active = true
    if (activeMode === 'draft')  updates.is_active = false

    setSaving(true)
    try {
      await onSave(updates)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Bulk edit {count} parts</div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, flexShrink: 0 }}>
          Toggle a field to update it across all selected parts. Untouched fields stay as-is.
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <BulkField label="Unit" checked={editUnit} onToggle={setEditUnit}>
            <FieldWithCustom value={unit} onChange={setUnit}
              custom={unitCustom} setCustom={setUnitCustom}
              options={COMMON_UNITS} placeholder="custom unit" allowEmpty={false} />
          </BulkField>

          <BulkField label="Department" checked={editDept} onToggle={setEditDept}>
            <FieldWithCustom value={department} onChange={setDepartment}
              custom={deptCustom} setCustom={setDeptCustom}
              options={distinctValues.departments} placeholder="custom department" allowEmpty />
          </BulkField>

          <BulkField label="Material group" checked={editMatGrp} onToggle={setEditMatGrp}>
            <FieldWithCustom value={materialGroup} onChange={setMaterialGroup}
              custom={matGrpCustom} setCustom={setMatGrpCustom}
              options={distinctValues.materialGroups} placeholder="custom material group" allowEmpty />
          </BulkField>

          <BulkField label="Item type" checked={editItemType} onToggle={setEditItemType}>
            <FieldWithCustom value={itemType} onChange={setItemType}
              custom={itemTypeCustom} setCustom={setItemTypeCustom}
              options={distinctValues.itemTypes} placeholder="custom item type" allowEmpty />
          </BulkField>

          <BulkField label="Sonar import routing" checked={editSonarRouting} onToggle={setEditSonarRouting}>
            <select
              value={sonarRouting}
              onChange={e => setSonarRouting(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--bg)', color: 'var(--text)' }}
            >
              {SONAR_ROUTING_OPTIONS.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              {SONAR_ROUTING_OPTIONS.find(o => o.id === sonarRouting)?.desc}
            </div>
          </BulkField>

          <div style={{
            border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
            padding: '10px 12px', marginBottom: 10,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Active state</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { id: 'unchanged', label: 'Leave unchanged', color: 'gray' },
                { id: 'active',    label: 'Activate',         color: 'teal' },
                { id: 'draft',     label: 'Deactivate',       color: 'amber' },
              ].map(opt => (
                <button key={opt.id} onClick={() => setActiveMode(opt.id)} style={{
                  padding: '6px 12px', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  border: `1.5px solid ${activeMode === opt.id ? 'var(--' + opt.color + ')' : 'var(--border2)'}`,
                  background: activeMode === opt.id
                    ? (opt.color === 'gray' ? 'var(--surface2)' : `var(--${opt.color}-lt)`)
                    : 'var(--bg)',
                  color: activeMode === opt.id
                    ? (opt.color === 'gray' ? 'var(--text)' : `var(--${opt.color})`)
                    : 'var(--muted)',
                }}>{opt.label}</button>
              ))}
            </div>
          </div>

          {!anyFieldChecked && (
            <div style={{ fontSize: 12, color: 'var(--hint)', textAlign: 'center', padding: 14, fontStyle: 'italic' }}>
              Toggle at least one field above to update.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={saving || !anyFieldChecked}
          >
            {saving ? 'Saving…' : `Apply to ${count} part${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function BulkField({ label, checked, onToggle, children }) {
  return (
    <div style={{
      border: `1.5px solid ${checked ? 'var(--orange)' : 'var(--border2)'}`,
      borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 8,
      background: checked ? 'var(--orange-lt)' : 'transparent',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: checked ? 8 : 0, cursor: 'pointer' }}>
        <input type="checkbox" checked={checked} onChange={e => onToggle(e.target.checked)} style={{ cursor: 'pointer' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: checked ? 'var(--orange)' : 'var(--text)' }}>
          Update {label.toLowerCase()}
        </span>
      </label>
      {checked && children}
    </div>
  )
}

function FieldWithCustom({ label, value, onChange, custom, setCustom, options, placeholder, allowEmpty }) {
  const inner = custom ? (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        type="text" value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ flex: 1 }}
      />
      <button onClick={() => setCustom(false)} style={smallBtn}>Use list</button>
    </div>
  ) : (
    <div style={{ display: 'flex', gap: 6 }}>
      <select
        value={options.includes(value) || (allowEmpty && !value) ? value : ''}
        onChange={e => onChange(e.target.value)}
        style={{ flex: 1, padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
      >
        {allowEmpty && <option value="">— None —</option>}
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <button onClick={() => setCustom(true)} style={smallBtn}>Custom…</button>
    </div>
  )

  if (!label) return inner
  return (
    <div className="field">
      <label>{label}</label>
      {inner}
    </div>
  )
}

const smallBtn = {
  padding: '8px 10px', borderRadius: 'var(--r-sm)',
  border: '1.5px solid var(--border2)', background: 'var(--bg)',
  color: 'var(--muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
}
