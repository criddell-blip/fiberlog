import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import { getAllParts, updatePart, updatePartsBatch, getStockTotalsByPart, SONAR_ROUTING_OPTIONS } from '../../lib/inventory'

const COMMON_UNITS = ['ea', 'ft', 'm', 'in', 'lb', 'kg', 'box', 'roll', 'spool', 'pair', 'pack', 'kit']

export default function InventoryPartsTab({ refreshKey, onChanged }) {
  const { showToast } = useApp()
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

  // Selection: a Set of part ids checked for bulk operations
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  // Anchor index for shift-click range select. Cleared when the filtered
  // list changes (so a stale anchor doesn't carry across filter/search changes).
  const lastClickedIndexRef = useRef(null)

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
  }), [parts])

  const filtered = useMemo(() => {
    let list = parts
    if (filter === 'active') list = list.filter(p => p.is_active)
    if (filter === 'draft')  list = list.filter(p => !p.is_active)

    if (search && search.trim().length >= 2) {
      const q = search.toLowerCase()
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.id   || '').toLowerCase().includes(q) ||
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

  async function handleSave(updates) {
    try {
      await updatePart(editing.id, updates)
      setEditing(null)
      await load()
      onChanged?.()
      showToast('Saved')
    } catch (e) {
      console.error('Save part failed:', e)
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
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading parts…</div>
  }

  const selectedCount = selectedIds.size

  return (
    <div style={{ position: 'relative', paddingBottom: selectedCount > 0 ? 76 : 0 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('all')} style={pillStyle(filter === 'all')}>
          All ({counts.all})
        </button>
        <button onClick={() => setFilter('active')} style={pillStyle(filter === 'active')}>
          Active ({counts.active})
        </button>
        <button onClick={() => setFilter('draft')} style={pillStyle(filter === 'draft', 'amber')}>
          ⚠ Drafts ({counts.draft})
        </button>
      </div>

      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search parts by name, SKU, or category…"
        style={{
          width: '100%', padding: '10px 12px',
          border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
          fontSize: 14, background: 'var(--bg)', marginBottom: 10
        }}
      />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          {filtered.length.toLocaleString()} of {parts.length.toLocaleString()} parts
          {filter === 'draft' && counts.draft > 0 && (
            <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
              · sorted by stock volume
            </span>
          )}
          <span style={{ color: 'var(--hint)', marginLeft: 6 }}>
            · tip: shift-click to select a range
          </span>
        </div>
        {filtered.length > 0 && (
          <button
            onClick={allVisibleSelected ? clearSelection : selectAllVisible}
            style={{
              fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--border2)', background: 'var(--bg)', color: 'var(--muted)', cursor: 'pointer',
            }}
          >
            {allVisibleSelected ? 'Deselect all' : `Select all ${filtered.length}`}
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
          {parts.length === 0 ? 'No parts yet' : 'No parts match your filters'}
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          {filtered.map((p, i) => {
            const stockQty = stockTotals.get(p.id) || 0
            const isSelected = selectedIds.has(p.id)
            return (
              <div key={p.id} style={{
                display: 'flex', alignItems: 'center', padding: '10px 14px', gap: 10,
                borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                background: isSelected ? 'var(--orange-lt)' : 'transparent',
              }}>
                {/*
                  Checkbox uses onClick (not onChange) so we can read
                  e.shiftKey for range selection. Empty onChange satisfies
                  React's controlled-input contract.
                */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}}
                  onClick={e => handleCheckboxClick(e, i)}
                  style={{ cursor: 'pointer', flexShrink: 0 }}
                />

                <div style={{
                  fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 6,
                  background: p.is_active ? 'var(--teal-lt)' : 'var(--amber-lt)',
                  color: p.is_active ? 'var(--teal)' : 'var(--amber)',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {p.is_active ? 'ACTIVE' : 'DRAFT'}
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                    {p.id} · {p.unit || 'ea'} · {p.category || 'Uncategorized'}
                  </div>
                </div>

                <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 60 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: stockQty > 0 ? 'var(--orange)' : 'var(--hint)' }}>
                    {stockQty.toLocaleString()}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted)', textTransform: 'uppercase' }}>in stock</div>
                </div>

                <div style={{ display: 'flex', gap: 4 }}>
                  {!p.is_active ? (
                    <button onClick={() => handleQuickActivate(p)} style={quickBtnStyle('teal')}>Activate</button>
                  ) : (
                    <button onClick={() => handleQuickDeactivate(p)} style={quickBtnStyle('amber')}>Retire</button>
                  )}
                  <button onClick={() => setEditing(p)} style={quickBtnStyle('default')}>Edit</button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedCount > 0 && (
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
          <button onClick={() => setBulkEditing(true)} style={bulkActionBtn('orange')}>✎ Bulk edit</button>
          <button onClick={handleBulkActivate} style={bulkActionBtn('teal')}>✓ Activate</button>
          <button onClick={handleBulkDeactivate} style={bulkActionBtn('amber')}>⊘ Deactivate</button>
          <button onClick={clearSelection} style={bulkActionBtn('ghost')}>Cancel</button>
        </div>
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
    </div>
  )
}

function pillStyle(selected, color = 'orange') {
  if (color === 'amber') {
    return {
      padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
      background: selected ? 'var(--amber)' : 'var(--gray-lt)',
      color: selected ? 'white' : 'var(--amber)',
      border: 'none', cursor: 'pointer',
    }
  }
  return {
    padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: selected ? 'var(--orange)' : 'var(--gray-lt)',
    color: selected ? 'white' : 'var(--muted)',
    border: 'none', cursor: 'pointer',
  }
}

function quickBtnStyle(variant) {
  const base = {
    padding: '5px 8px', borderRadius: 'var(--r-sm)',
    fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  }
  if (variant === 'teal')  return { ...base, border: '1.5px solid var(--teal)',  background: 'var(--teal-lt)',  color: 'var(--teal)' }
  if (variant === 'amber') return { ...base, border: '1.5px solid var(--amber)', background: 'var(--amber-lt)', color: 'var(--amber)' }
  return                       { ...base, border: '1.5px solid var(--border2)', background: 'var(--bg)',     color: 'var(--muted)' }
}

function bulkActionBtn(variant) {
  const base = {
    padding: '7px 12px', borderRadius: 'var(--r-sm)',
    fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
  }
  if (variant === 'orange') return { ...base, border: 'none', background: 'var(--orange)', color: 'white' }
  if (variant === 'teal')   return { ...base, border: '1.5px solid var(--teal)',  background: 'var(--teal-lt)',  color: 'var(--teal)' }
  if (variant === 'amber')  return { ...base, border: '1.5px solid var(--amber)', background: 'var(--amber-lt)', color: 'var(--amber)' }
  return                         { ...base, border: '1.5px solid var(--border2)', background: 'var(--bg)',     color: 'var(--muted)' }
}

// ─── Single-part edit sheet ─────────────────────────────────────────────────

function PartFormSheet({ part, distinctValues, onCancel, onSave }) {
  const [name, setName] = useState(part.name || '')

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
      await onSave({
        name: name.trim(),
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
