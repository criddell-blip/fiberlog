import { useState, useMemo, useEffect } from 'react'
import { recordMovementsBatch, getBinsForWarehouse, getStockRowsForParts, buildLocationQtyMaps, confirmNegativeStock } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import LocationWithBinPicker from './LocationWithBinPicker'
import Icon from '../shared/Icon'

const TYPE_ICON_NAMES = {
  warehouse: 'warehouse',
  truck:     'truck',
  job_site:  'pin',
  vendor:    'warehouse',
  scrap:     'trash',
  bin:       'download',
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
  const [progress, setProgress] = useState(null)   // { done, total } while a chunked insert runs
  const [error, setError] = useState(null)
  // Where the selected parts currently reside — feeds the destination
  // picker's "has this part" grouping. Progressive enhancement: the picker
  // renders immediately and annotates when this lands; a fetch failure
  // silently degrades to the plain flat picker.
  const [destStock, setDestStock] = useState(null)
  useEffect(() => {
    getStockRowsForParts(selectedRows.map(r => r.part_id))
      .then(rows => setDestStock(buildLocationQtyMaps(rows.map(r => ({
        locationId: r.location_id,
        parentLocationId: r.location?.parent_location_id || null,
        qty: r.quantity,
      })))))
      .catch(e => console.warn('Dest stock annotate failed:', e))
  }, [])  // selectedRows is fixed for the sheet's lifetime

  // Back closes the sheet (mounted only when open). Confirm if a note was typed
  // (qty/row edits can be re-selected; the free-text note is the losable bit).
  useBackClose(1, onClose, {
    confirm: () => notes.trim() === '' || window.confirm('Discard this bulk move?'),
  })

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

  // Filter destination top-level options:
  //   - Hide vendors (you don't transfer TO a vendor)
  //   - Hide the source itself — EXCEPT a warehouse source, which must stay
  //     pickable so its bins are reachable (moving unbinned stock into a bin
  //     is the main binning flow; with one active warehouse, dropping it left
  //     no warehouse/bin destination at all). Same-warehouse-unbinned is
  //     caught by the destEqualsSource validation instead.
  const destOptions = useMemo(
    () => locations.filter(l =>
      l.type !== 'vendor' &&
      (l.id !== sourceLocation?.id || l.type === 'warehouse')
    ),
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

    // Warn before the spinner goes up — a bulk move is the easiest way to
    // take more than a source holds across many parts at once.
    if (!(await confirmNegativeStock(movements))) return
    setSubmitting(true)

    try {
      // chunk:true = the chunked-insert-with-single-row-fallback loop that
      // used to live here — one bad row can't sink its neighbors; row-level
      // failures come back in `errors` instead of throwing.
      const { inserted, errors } = await recordMovementsBatch(movements, {
        chunk: true,
        onProgress: p => setProgress(p),
      })
      onComplete({
        created: inserted.length,
        // Preserve the sheet's historical error shape ({ part_id, message })
        // for the caller's toast + console report.
        errors: errors.map(e => ({ part_id: e.movement?.part_id, message: e.message })),
      })
    } catch (e) {
      setError(e.message || 'Bulk move failed')
    } finally {
      setSubmitting(false)
      setProgress(null)
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

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Bulk move stock</div>
          {!submitting && (
            <button onClick={onClose} style={{ display: 'inline-flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)' }}><Icon name="x" size={18} /></button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, flexShrink: 0 }}>
          From <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: 'middle' }}>
            <Icon name={TYPE_ICON_NAMES[sourceLocation?.type] || 'box'} size={14} />
            {sourceDisplayName}
          </strong>
          {' '}· One transfer movement created per part
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* Destination with bin sub-picker — shared two-step picker
              (excludeId keeps the source bin out of its own warehouse's
              bin list; bins lazy-load via the effect above). A warehouse
              source passes no excludeId — it must stay pickable so its
              bins are reachable, and none of its bins are the source. */}
          <div className="field">
            <label>Destination</label>
            <LocationWithBinPicker
              topLevelId={destTopId} setTopLevelId={setDestTopId}
              binId={destBinId} setBinId={setDestBinId}
              options={destOptions}
              binsByWarehouse={binsByWarehouse}
              locations={locations}
              excludeId={sourceLocation?.type === 'warehouse' ? null : sourceLocation?.id}
              stock={destStock || undefined}
              stockGroupLabel={selectedRows.length > 1 ? 'Has any of these parts' : 'Has this part'}
            />
            {destEqualsSource && (
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--amber)', fontWeight: 700 }}>
                That's where this stock already is — pick a bin below to bin it, or a different location.
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--amber)', fontWeight: 700 }}>
                  <Icon name="alert" size={13} /> {overdrawCount} row{overdrawCount === 1 ? '' : 's'} over available
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
              ? (progress ? `Moving… ${progress.done}/${progress.total}` : 'Moving…')
              : effectiveDestId
                ? `Move ${validMovements.length} part${validMovements.length === 1 ? '' : 's'} → ${destDisplayName}`
                : `Move ${validMovements.length} parts`}
          </button>
        </div>
      </div>
    </div>
  )
}
