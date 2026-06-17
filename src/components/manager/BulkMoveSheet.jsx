import { useState, useMemo, useEffect } from 'react'
import { recordMovementsBatch, getBinsForWarehouse } from '../../lib/inventory'

const CHUNK_SIZE = 100

const TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

export default function BulkMoveSheet({
  sourceLocation, selectedRows, locations, currentUser,
  onClose, onComplete,
}) {
  // Destination split into top-level + bin so a warehouse + bin combo can
  // be picked. Effective id is bin if set, else top-level.
  const [destTopId, setDestTopId] = useState('')
  const [destBinId, setDestBinId] = useState('')
  const [binsByWarehouse, setBinsByWarehouse] = useState({})

  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [rowState, setRowState] = useState(() => {
    const m = {}
    for (const r of selectedRows) m[r.part_id] = { qty: String(r.quantity), removed: false }
    return m
  })

  function setRowQty(partId, val) {
    setRowState(s => ({ ...s, [partId]: { ...s[partId], qty: val } }))
  }
  function toggleRowRemoved(partId) {
    setRowState(s => ({ ...s, [partId]: { ...s[partId], removed: !s[partId].removed } }))
  }

  // Source's parent warehouse, if the source is a bin — used to exclude it
  // from destination options (you can't move a bin to its own warehouse's
  // bin-tree without picking a different bin).
  const sourceParentId = sourceLocation?.type === 'bin' ? sourceLocation.parent_location_id : null

  // Filter destination top-level options:
  //   - Hide vendors (you don't transfer TO a vendor)
  //   - Hide the source itself
  //   - Hide the source's parent warehouse if source is a bin (otherwise
  //     "warehouse → its own bin" works fine via the bin sub-picker)
  const destOptions = useMemo(
    () => locations.filter(l => l.type !== 'vendor' && l.id !== sourceLocation?.id),
    [locations, sourceLocation]
  )

  // Load bins for the selected warehouse destination
  useEffect(() => {
    if (!destTopId) return
    const loc = locations.find(l => l.id === destTopId)
    if (loc?.type !== 'warehouse') return
    if (binsByWarehouse[destTopId] !== undefined) return
    getBinsForWarehouse(destTopId)
      .then(bins => setBinsByWarehouse(prev => ({ ...prev, [destTopId]: bins })))
      .catch(e => {
        console.warn(`Failed to load bins for ${loc.name}:`, e)
        setBinsByWarehouse(prev => ({ ...prev, [destTopId]: [] }))
      })
  }, [destTopId, locations, binsByWarehouse])

  // Reset bin selection when top-level dest changes
  useEffect(() => { setDestBinId('') }, [destTopId])

  const effectiveDestId = destBinId || destTopId

  // If destination is the same as source after combining bin, that's invalid.
  // (e.g., source is bin X under warehouse W, dest top is W with bin X picked)
  const destEqualsSource = effectiveDestId === sourceLocation?.id

  const activeRows = selectedRows.filter(r => !rowState[r.part_id]?.removed)
  const validMovements = activeRows
    .map(r => ({
      part_id: r.part_id,
      name: r.name,
      unit: r.unit,
      available: Number(r.quantity),
      qty: Number(rowState[r.part_id]?.qty || 0),
    }))
    .filter(r => r.qty > 0)

  const overdrawCount = validMovements.filter(r => r.qty > r.available).length

  function validate() {
    if (!effectiveDestId) return 'Pick a destination location'
    if (destEqualsSource) return 'Destination must be different from source'
    if (validMovements.length === 0) return 'No rows have a quantity > 0'
    return null
  }

  async function handleSubmit() {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setSubmitting(true)

    const movements = validMovements.map(r => ({
      movement_type: 'transfer',
      part_id: r.part_id,
      quantity: r.qty,
      unit: r.unit || 'ea',
      from_location_id: sourceLocation.id,
      to_location_id: effectiveDestId,
      notes: notes.trim() || null,
      created_by: currentUser?.id,
    }))

    let created = 0
    const errors = []
    try {
      for (let i = 0; i < movements.length; i += CHUNK_SIZE) {
        const chunk = movements.slice(i, i + CHUNK_SIZE)
        try {
          const inserted = await recordMovementsBatch(chunk)
          created += inserted.length
        } catch (e) {
          for (const m of chunk) {
            try {
              await recordMovementsBatch([m])
              created++
            } catch (rowErr) {
              errors.push({ part_id: m.part_id, message: rowErr.message })
            }
          }
        }
      }
      onComplete({ created, errors })
    } catch (e) {
      setError(e.message || 'Bulk move failed')
    } finally {
      setSubmitting(false)
    }
  }

  // Display name for source — if it's a bin, prepend the parent warehouse name
  const sourceDisplayName = useMemo(() => {
    if (!sourceLocation) return ''
    if (sourceLocation.type === 'bin') {
      const parent = locations.find(l => l.id === sourceLocation.parent_location_id)
      return parent ? `${parent.name} / ${sourceLocation.name}` : sourceLocation.name
    }
    return sourceLocation.assigned_user?.name || sourceLocation.name
  }, [sourceLocation, locations])

  // Display name for destination
  const destDisplayName = useMemo(() => {
    if (!effectiveDestId) return ''
    const top = locations.find(l => l.id === destTopId)
    if (!top) return ''
    if (destBinId) {
      const bins = binsByWarehouse[destTopId] || []
      const bin = bins.find(b => b.id === destBinId)
      return bin ? `${top.name} / ${bin.name}` : top.name
    }
    return top.assigned_user?.name || top.name
  }, [effectiveDestId, destTopId, destBinId, locations, binsByWarehouse])

  const destTop = locations.find(l => l.id === destTopId)
  const destIsWarehouse = destTop?.type === 'warehouse'
  const destBins = destIsWarehouse ? (binsByWarehouse[destTopId] || []) : []

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Bulk move stock</div>
          {!submitting && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, flexShrink: 0 }}>
          From <strong>{TYPE_ICONS[sourceLocation?.type] || '📦'} {sourceDisplayName}</strong>
          {' '}· One transfer movement created per part
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Destination with bin sub-picker */}
          <div className="field">
            <label>Destination</label>
            <select
              value={destTopId}
              onChange={e => setDestTopId(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 14, background: 'var(--bg)' }}
            >
              <option value="">— Pick a destination —</option>
              {destOptions.map(l => (
                <option key={l.id} value={l.id}>
                  {TYPE_ICONS[l.type] || '📦'} {l.assigned_user?.name || l.name} ({l.type})
                </option>
              ))}
            </select>

            {destIsWarehouse && destBins.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>↳ Bin:</span>
                <select
                  value={destBinId}
                  onChange={e => setDestBinId(e.target.value)}
                  style={{ flex: 1, padding: '7px 10px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 13, background: 'var(--bg)' }}
                >
                  <option value="">(unbinned — warehouse level)</option>
                  {destBins
                    .filter(b => b.id !== sourceLocation?.id)   // can't move a bin to itself
                    .map(b => (
                      <option key={b.id} value={b.id}>📥 {b.name}</option>
                    ))}
                </select>
              </div>
            )}
            {destIsWarehouse && destBins.length === 0 && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--hint)' }}>
                No bins under this warehouse — stock goes to the warehouse level.
              </div>
            )}
          </div>

          {/* Per-row qty editor */}
          <div style={{ marginBottom: 6 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 6, gap: 8,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--hint)' }}>
                Parts to move ({validMovements.length} of {selectedRows.length})
              </div>
              {overdrawCount > 0 && (
                <div style={{ fontSize: 11, color: 'var(--amber)', fontWeight: 700 }}>
                  ⚠ {overdrawCount} row{overdrawCount === 1 ? '' : 's'} over available
                </div>
              )}
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
              {selectedRows.map((r, i) => {
                const state = rowState[r.part_id] || { qty: '0', removed: false }
                const qty = Number(state.qty)
                const isOver = qty > Number(r.quantity)
                return (
                  <div key={r.part_id} style={{
                    display: 'flex', alignItems: 'center', padding: '8px 12px', gap: 10,
                    borderBottom: i < selectedRows.length - 1 ? '1px solid var(--border)' : 'none',
                    opacity: state.removed ? 0.4 : 1,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {r.name}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                        Available: {Number(r.quantity).toLocaleString()} {r.unit || 'ea'}
                      </div>
                    </div>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={state.qty}
                      disabled={state.removed}
                      onChange={e => setRowQty(r.part_id, e.target.value)}
                      style={{
                        width: 90, padding: '6px 8px',
                        borderRadius: 'var(--r-sm)',
                        border: `1.5px solid ${isOver ? 'var(--amber)' : 'var(--border2)'}`,
                        background: 'var(--bg)', fontSize: 13, textAlign: 'right',
                      }}
                    />
                    <span style={{ fontSize: 10, color: 'var(--muted)', minWidth: 20 }}>{r.unit || 'ea'}</span>
                    <button
                      onClick={() => toggleRowRemoved(r.part_id)}
                      title={state.removed ? 'Include this row' : 'Skip this row'}
                      style={{
                        padding: '4px 8px', borderRadius: 'var(--r-sm)',
                        border: '1.5px solid var(--border2)', background: 'var(--bg)',
                        color: 'var(--muted)', fontSize: 10, fontWeight: 700, cursor: 'pointer',
                      }}
                    >{state.removed ? 'Include' : 'Skip'}</button>
                  </div>
                )
              })}
            </div>
            {overdrawCount > 0 && (
              <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 4, fontStyle: 'italic' }}>
                Quantities over available will create negative stock at the source.
                That's allowed (you can correct later via adjust), but worth a sanity-check.
              </div>
            )}
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <label>Notes (optional, applied to all movements)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. Reload for Tuesday installs"
              style={{ minHeight: 56 }}
            />
          </div>

          {error && (
            <div style={{
              padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)',
              borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 10
            }}>{error}</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={submitting || !effectiveDestId || destEqualsSource || validMovements.length === 0}
          >
            {submitting
              ? 'Moving…'
              : effectiveDestId
                ? `Move ${validMovements.length} part${validMovements.length === 1 ? '' : 's'} → ${destDisplayName}`
                : `Move ${validMovements.length} parts`}
          </button>
        </div>
      </div>
    </div>
  )
}
