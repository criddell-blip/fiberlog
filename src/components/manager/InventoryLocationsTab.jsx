import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import {
  createLocation, updateLocation, deactivateLocation, getBinsForWarehouse,
  getStockCountsByLocation,
} from '../../lib/inventory'

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

export default function InventoryLocationsTab({ locations, loading, onChanged, onJumpToStock, refreshKey }) {
  const { users, showToast, currentUser } = useApp()
  // Retire (deactivate) is owner-only. Managers can do everything else
  // — edit attrs, add bins, jump to stock — but retiring a location is
  // a destructive-by-default action since it removes the location from
  // every UI filter and pulldown system-wide. UI gate only; if you want
  // server-side enforcement later, add an RLS policy on
  // inventory_locations.is_active that requires is_staff() AND owner role.
  const isOwner = currentUser?.role === 'owner'
  const [editing, setEditing] = useState(null)        // location being edited (or 'new')
  const [addingBinFor, setAddingBinFor] = useState(null)  // warehouse object when adding a bin
  const [saving, setSaving] = useState(false)

  // Bins per warehouse — fetched separately since bins aren't included in
  // the top-level locations prop. Keyed by warehouse id.
  const [binsByWarehouse, setBinsByWarehouse] = useState({})
  const [loadingBins, setLoadingBins] = useState(false)

  // Stock summary counts per location id. Refreshed alongside locations
  // and after any movement (refreshKey bumps).
  const [stockCounts, setStockCounts] = useState(() => new Map())

  useEffect(() => {
    let cancelled = false
    getStockCountsByLocation()
      .then(m => { if (!cancelled) setStockCounts(m) })
      .catch(e => console.warn('Stock counts failed:', e))
    return () => { cancelled = true }
  }, [locations, refreshKey])

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

  async function handleDeactivate(loc) {
    if (!window.confirm(`Deactivate "${loc.name}"? Stock and movement history are preserved, but it won't show up for new movements.`)) return
    try {
      await deactivateLocation(loc.id)
      showToast('Deactivated')
      if (loc.type === 'bin' && loc.parent_location_id) {
        // Refetch the parent warehouse's bins so the deactivated bin disappears
        const updated = await getBinsForWarehouse(loc.parent_location_id)
        setBinsByWarehouse(prev => ({ ...prev, [loc.parent_location_id]: updated }))
      } else {
        onChanged()
      }
    } catch (e) {
      showToast('Deactivate failed: ' + e.message)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading locations…</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={() => setEditing('new')} style={{ padding: '6px 14px', fontSize: 13 }}>
          ＋ Add location
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
            return (
              <div key={type} style={{ marginBottom: 16 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '.06em', color: 'var(--hint)', marginBottom: 6
                }}>
                  {TYPE_LABELS[type]}{list.length > 1 ? 's' : ''} ({list.length})
                </div>
                {list.map(loc => {
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
                  return (
                    <div key={loc.id} style={{ marginBottom: 6 }}>
                      {/* Warehouse / location header row */}
                      <div style={{
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: bins.length > 0 ? 'var(--r-sm) var(--r-sm) 0 0' : 'var(--r-sm)',
                        padding: '10px 14px',
                        display: 'flex', alignItems: 'center', gap: 12,
                        borderBottom: bins.length > 0 ? '1px solid var(--border)' : '1px solid var(--border)',
                      }}>
                        <span style={{ fontSize: 20 }}>{TYPE_ICONS[type]}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {loc.name}
                            {type === 'warehouse' && bins.length > 0 && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
                                background: 'var(--teal-lt)', color: 'var(--teal)',
                                marginLeft: 8, verticalAlign: 'middle',
                              }}>{bins.length} bin{bins.length === 1 ? '' : 's'}</span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                            <span>
                              {loc.assigned_user ? `Assigned to ${loc.assigned_user.name}` : (loc.notes || '—')}
                            </span>
                            {rollup && rollup.distinctParts > 0 && (
                              <>
                                <span style={{ color: 'var(--hint)' }}>·</span>
                                <span title="Distinct parts in stock">
                                  <strong style={{ color: 'var(--text)' }}>{rollup.distinctParts.toLocaleString()}</strong> part{rollup.distinctParts === 1 ? '' : 's'}
                                </span>
                                <span style={{ color: 'var(--hint)' }}>·</span>
                                <span title="Total units across all parts">
                                  <strong style={{ color: 'var(--text)' }}>{rollup.totalUnits.toLocaleString()}</strong> unit{rollup.totalUnits === 1 ? '' : 's'}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {onJumpToStock && rollup && rollup.distinctParts > 0 && (
                          <button
                            onClick={() => onJumpToStock(loc.id)}
                            title="View stock at this location"
                            style={{
                              fontSize: 11, color: 'var(--orange)', background: 'var(--orange-lt)',
                              border: '1px solid var(--orange-dk)', borderRadius: 14, padding: '3px 10px',
                              cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
                            }}
                          >📦 Stock →</button>
                        )}
                        {type === 'warehouse' && (
                          <button
                            onClick={() => setAddingBinFor(loc)}
                            style={{
                              fontSize: 11, color: 'var(--teal)', background: 'var(--teal-lt)',
                              border: '1px solid var(--teal)', borderRadius: 14, padding: '3px 10px',
                              cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
                            }}
                          >＋ Bin</button>
                        )}
                        <button
                          onClick={() => setEditing(loc)}
                          style={{ fontSize: 12, color: 'var(--teal)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                        >Edit</button>
                        {isOwner && (
                          <button
                            onClick={() => handleDeactivate(loc)}
                            style={{ fontSize: 12, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                          >Retire</button>
                        )}
                      </div>

                      {/* Bins under this warehouse — indented sub-rows */}
                      {bins.length > 0 && (
                        <div style={{
                          background: 'var(--surface2)',
                          borderRadius: '0 0 var(--r-sm) var(--r-sm)',
                          border: '1px solid var(--border)',
                          borderTop: 'none',
                          padding: '4px 0',
                        }}>
                          {bins.map((bin, i) => {
                            const binCounts = stockCounts.get(bin.id)
                            return (
                              <div key={bin.id} style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '8px 14px 8px 36px',
                                borderBottom: i < bins.length - 1 ? '1px solid var(--border)' : 'none',
                              }}>
                                <span style={{ fontSize: 14, color: 'var(--hint)' }}>↳</span>
                                <span style={{ fontSize: 13 }}>📥</span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 600, fontSize: 12 }}>{bin.name}</div>
                                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
                                    {bin.notes && <span>{bin.notes}</span>}
                                    {binCounts && binCounts.distinctParts > 0 && (
                                      <>
                                        {bin.notes && <span style={{ color: 'var(--hint)' }}>·</span>}
                                        <span><strong style={{ color: 'var(--text)' }}>{binCounts.distinctParts.toLocaleString()}</strong> part{binCounts.distinctParts === 1 ? '' : 's'}</span>
                                        <span style={{ color: 'var(--hint)' }}>·</span>
                                        <span><strong style={{ color: 'var(--text)' }}>{binCounts.totalUnits.toLocaleString()}</strong> unit{binCounts.totalUnits === 1 ? '' : 's'}</span>
                                      </>
                                    )}
                                  </div>
                                </div>
                                {onJumpToStock && binCounts && binCounts.distinctParts > 0 && (
                                  <button
                                    onClick={() => onJumpToStock(bin.id)}
                                    title="View stock in this bin"
                                    style={{
                                      fontSize: 10, color: 'var(--orange)', background: 'var(--orange-lt)',
                                      border: '1px solid var(--orange-dk)', borderRadius: 12, padding: '2px 8px',
                                      cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap',
                                    }}
                                  >📦 Stock →</button>
                                )}
                                <button
                                  onClick={() => setEditing(bin)}
                                  style={{ fontSize: 11, color: 'var(--teal)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                                >Edit</button>
                                {isOwner && (
                                  <button
                                    onClick={() => handleDeactivate(bin)}
                                    style={{ fontSize: 11, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
                                  >Retire</button>
                                )}
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
          saving={saving}
          onCancel={() => setAddingBinFor(null)}
          onSave={(formData) => handleSaveBin(formData, addingBinFor)}
        />
      )}
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

function BinFormSheet({ bin, parentWarehouse, saving, onCancel, onSave }) {
  const isEdit = !!bin
  const [name, setName] = useState(bin?.name || '')
  const [notes, setNotes] = useState(bin?.notes || '')

  function handleSubmit() {
    if (!name.trim()) return
    onSave({ name: name.trim(), notes: notes.trim() || null })
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

        <div className="field">
          <label>Bin name</label>
          <input
            type="text"
            value={name}
            placeholder="e.g. Bay 12, Shelf A, Aisle 3-B"
            onChange={e => setName(e.target.value)}
            autoFocus
          />
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
            Use whatever convention helps you find the spot in the warehouse.
          </div>
        </div>

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
            disabled={saving || !name.trim()}
          >{saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create bin')}</button>
        </div>
      </div>
    </div>
  )
}
