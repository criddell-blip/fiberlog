import { useState, useEffect, useRef } from 'react'
import {
  recordMovementsBatch, getBinsForWarehouse,
  createPart, updatePart,
} from '../../lib/inventory'
import { searchPartsCatalog } from '../../lib/supabase'
import SkuLabelSheet from './SkuLabelSheet'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Receive PO / vendor delivery sheet (backlog #12 MVP).
//
// One sheet → many `receive` movements. All lines share a PO/invoice ref
// (saved into each row's vendor_invoice) and a single destination location.
// Vendor name (free text) is stored in the row's notes when provided —
// no vendor catalog yet, see backlog #12 for the bigger version.

const TYPE_ICON = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  scrap:     '🗑️',
  bin:       '📥',
}

let nextLineId = 1
const newLine = () => ({ tempId: nextLineId++, part: null, quantity: '', unit_cost: '' })

export default function ReceivePOSheet({ locations, currentUser, onClose, onRecorded }) {
  const [poRef, setPoRef]         = useState('')
  const [vendorName, setVendorName] = useState('')
  const [toTopId, setToTopId]     = useState('')
  const [toBinId, setToBinId]     = useState('')
  const [bins, setBins]           = useState([])
  const [lines, setLines]         = useState(() => [newLine()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError]         = useState('')
  // After a successful save we capture the received parts so a post-save
  // "print labels for these items" prompt can use them.
  const [justReceived, setJustReceived] = useState(null)  // null | array of parts
  const [showLabelSheet, setShowLabelSheet] = useState(false)

  // Back closes the sheet (mounted only when open). Confirm first if the user
  // has started a delivery (ref, vendor, or any line). The nested SkuLabelSheet
  // registers its own layer, so Back closes it first when it's up.
  useBackClose(1, onClose, {
    confirm: () =>
      !(poRef.trim() || vendorName.trim() ||
        lines.some(l => l.part || String(l.quantity).trim() || String(l.unit_cost).trim()))
      || window.confirm('Discard this delivery?'),
  })

  // Load bins when the destination is a warehouse
  useEffect(() => {
    setToBinId('')
    if (!toTopId) { setBins([]); return }
    const loc = locations.find(l => l.id === toTopId)
    if (loc?.type !== 'warehouse') { setBins([]); return }
    let cancelled = false
    getBinsForWarehouse(toTopId)
      .then(b => { if (!cancelled) setBins(b) })
      .catch(() => { if (!cancelled) setBins([]) })
    return () => { cancelled = true }
  }, [toTopId, locations])

  function updateLine(tempId, patch) {
    setLines(prev => prev.map(l => l.tempId === tempId ? { ...l, ...patch } : l))
  }
  function addLine()    { setLines(prev => [...prev, newLine()]) }
  function removeLine(tempId) { setLines(prev => prev.filter(l => l.tempId !== tempId)) }

  const validLines = lines.filter(l => l.part && Number(l.quantity) > 0)
  const dest = toBinId || toTopId
  const canSubmit = poRef.trim() && dest && validLines.length > 0 && !submitting

  async function handleSubmit() {
    setError('')
    if (!canSubmit) return
    setSubmitting(true)
    try {
      // Step 1: create any brand-new parts. If a SKU collides or fails,
      // we abort the whole submit so we don't end up with movements
      // referencing missing rows. Previously-created parts in the same
      // batch stay in the catalog (they're real parts the user typed in)
      // — they just won't have stock until the user retries.
      const newPartLines = validLines.filter(l => l.part?.isNew)
      for (const l of newPartLines) {
        try {
          await createPart({
            id: l.part.id,
            name: l.part.name,
            unit: l.part.unit,
            department: l.part.department,
            material_group: l.part.material_group,
            barcode: l.part.barcode,
            is_active: true,
          })
        } catch (e) {
          throw new Error(`Couldn't create part "${l.part.id}": ${e.message || e}`)
        }
      }

      // Step 2: apply pending attribute edits to existing parts. Same
      // failure semantics — abort if any edit fails.
      const editedLines = validLines.filter(l => !l.part?.isNew && l.pendingAttrs)
      for (const l of editedLines) {
        try {
          await updatePart(l.part.id, l.pendingAttrs)
        } catch (e) {
          throw new Error(`Couldn't update part "${l.part.id}": ${e.message || e}`)
        }
      }

      // Step 3: insert all the receive movements as a batch
      const noteFromVendor = vendorName.trim()
        ? `Vendor: ${vendorName.trim()}`
        : null
      const movements = validLines.map(l => ({
        movement_type: 'receive',
        part_id: l.part.id,
        quantity: Number(l.quantity),
        unit: l.part.unit || null,
        from_location_id: null,
        to_location_id: dest,
        vendor_invoice: poRef.trim(),
        unit_cost: l.unit_cost === '' ? null : Number(l.unit_cost),
        notes: noteFromVendor,
        created_by: currentUser?.id,
      }))
      await recordMovementsBatch(movements)
      // Stash the received parts for the post-save label prompt. Parent
      // gets notified now (toast + refresh) but the sheet stays open
      // showing the print-labels offer instead of closing.
      setJustReceived(validLines.map(l => ({
        id: l.part.id, name: l.part.name, unit: l.part.unit,
      })))
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  // Estimated total — handy reference but not stored anywhere
  const total = validLines.reduce((sum, l) => {
    const cost = Number(l.unit_cost)
    if (!Number.isFinite(cost)) return sum
    return sum + cost * Number(l.quantity)
  }, 0)

  // After save, show a "labels?" prompt instead of the form. Manager can
  // print labels for everything they just received, or just dismiss.
  // Either action notifies the parent and closes.
  if (justReceived) {
    const finish = () => { onRecorded(justReceived.length) }
    return (
      <>
        <div className="overlay open" onClick={e => e.target === e.currentTarget && finish()}>
          <div className="overlay-sheet" style={{ maxWidth: 480, textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--teal)' }}>
              <Icon name="check" size={48} />
            </div>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 6 }}>
              Received {justReceived.length} item{justReceived.length === 1 ? '' : 's'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
              Print labels for the items you just received so you can stick them on
              the boxes as you put them away. Optional — skip if you don't need them.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={finish}>
                Skip
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={() => setShowLabelSheet(true)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
              >
                <Icon name="tag" size={16} /> Print labels
              </button>
            </div>
          </div>
        </div>
        {showLabelSheet && (
          <SkuLabelSheet
            parts={justReceived}
            title={`Print labels for ${justReceived.length} received item${justReceived.length === 1 ? '' : 's'}`}
            onClose={() => { setShowLabelSheet(false); finish() }}
          />
        )}
      </>
    )
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 760, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <Icon name="download" size={18} />
          <span style={{ fontWeight: 800, fontSize: 17 }}>Receive PO / vendor delivery</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Each line becomes its own <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>receive</code> movement, all sharing the PO ref and destination.
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

          {/* PO ref + Vendor (optional free text) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>PO / invoice ref *</label>
              <input
                type="text" value={poRef}
                onChange={e => setPoRef(e.target.value)}
                placeholder="e.g. PO-12345"
                autoFocus
                autoComplete="off" name="po-ref"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Vendor (optional)</label>
              <input
                type="text" value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                placeholder="e.g. Acme Supply Co"
                autoComplete="off" name="po-vendor"
              />
            </div>
          </div>

          {/* Destination */}
          <div className="field">
            <label>Destination *</label>
            <select
              value={toTopId}
              onChange={e => setToTopId(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--bg)' }}
            >
              <option value="">— select location —</option>
              {locations
                .filter(l => l.type !== 'vendor' && l.is_active !== false)
                .map(l => (
                  <option key={l.id} value={l.id}>
                    {TYPE_ICON[l.type] || ''} {l.name}
                  </option>
                ))}
            </select>
          </div>

          {bins.length > 0 && (
            <div className="field">
              <label>Bin (optional)</label>
              <select
                value={toBinId}
                onChange={e => setToBinId(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--bg)' }}
              >
                <option value="">— warehouse-level (no specific bin) —</option>
                {bins.map(b => <option key={b.id} value={b.id}>📥 {b.name}</option>)}
              </select>
            </div>
          )}

          {/* Lines */}
          <div style={{
            fontSize: 12, fontWeight: 700, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '.04em',
            marginTop: 14, marginBottom: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Line items</span>
            <span style={{ color: 'var(--hint)', fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>
              {validLines.length} valid · {lines.length} total
            </span>
          </div>

          {lines.map(line => (
            <ReceiveLineRow
              key={line.tempId}
              line={line}
              onChange={patch => updateLine(line.tempId, patch)}
              onRemove={lines.length > 1 ? () => removeLine(line.tempId) : null}
            />
          ))}

          <button
            onClick={addLine}
            style={{
              width: '100%', padding: 8, marginTop: 4,
              border: '1.5px dashed var(--border2)', background: 'transparent',
              borderRadius: 'var(--r-sm)', cursor: 'pointer',
              fontSize: 12, fontWeight: 700, color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          ><Icon name="plus" size={14} /> Add line</button>

          {total > 0 && (
            <div style={{
              marginTop: 12, padding: '8px 12px',
              background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
              fontSize: 12, color: 'var(--muted)',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>Estimated total</span>
              <span style={{ fontWeight: 800, color: 'var(--text)' }}>
                ${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting
              ? 'Receiving…'
              : `Receive ${validLines.length} item${validLines.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── one row in the line items list ─────────────────────────────────────
// Three UI modes: 'idle' (search-or-show-picked), 'creating' (form for a
// brand-new part), 'editing' (form for tweaking the picked part's attrs).
// Editing fills `line.pendingAttrs`; creating sets `line.part.isNew=true`.
// The parent's handleSubmit reads both and does the catalog work before
// inserting the receive movements.

function ReceiveLineRow({ line, onChange, onRemove }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef(null)

  const [mode, setMode] = useState('idle')   // 'idle' | 'creating' | 'editing'
  const [fSku, setFSku]       = useState('')
  const [fName, setFName]     = useState('')
  const [fUnit, setFUnit]     = useState('ea')
  const [fDept, setFDept]     = useState('')
  const [fMatGrp, setFMatGrp] = useState('')

  // Search active only when no part picked AND we're not in a form mode
  useEffect(() => {
    if (line.part || mode !== 'idle') { setResults([]); return }
    if (!query || query.length < 2) { setResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await searchPartsCatalog(query, { limit: 8 })
        setResults(data)
      } catch (e) {
        console.warn('Part search failed:', e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, line.part, mode])

  function pickPart(p) {
    onChange({
      part: { id: p.id, name: p.name, unit: p.unit, isNew: false,
              department: p.department, material_group: p.material_group },
      pendingAttrs: null,
    })
    setQuery('')
    setResults([])
  }

  function startCreate() {
    setFSku('')
    setFName(query)        // pre-fill name from search query
    setFUnit('ea')
    setFDept('')
    setFMatGrp('')
    setMode('creating')
  }

  function startEdit() {
    if (!line.part) return
    const cur = line.pendingAttrs || {}
    setFUnit(cur.unit ?? line.part.unit ?? 'ea')
    setFDept(cur.department ?? line.part.department ?? '')
    setFMatGrp(cur.material_group ?? line.part.material_group ?? '')
    setMode('editing')
  }

  function saveCreate() {
    if (!fSku.trim() || !fName.trim()) return
    onChange({
      part: {
        id: fSku.trim(),
        name: fName.trim(),
        unit: fUnit.trim() || 'ea',
        department: fDept.trim() || null,
        material_group: fMatGrp.trim() || null,
        isNew: true,
      },
      pendingAttrs: null,
    })
    setMode('idle')
    setQuery('')
  }

  function saveEdit() {
    onChange({
      pendingAttrs: {
        unit: fUnit.trim() || 'ea',
        department: fDept.trim() || null,
        material_group: fMatGrp.trim() || null,
      },
    })
    setMode('idle')
  }

  function cancelForm() { setMode('idle') }

  // ── Form rendering shared between create + edit modes ──
  if (mode === 'creating' || mode === 'editing') {
    const isCreate = mode === 'creating'
    return (
      <div style={{
        marginBottom: 6, padding: 10,
        background: isCreate ? 'var(--teal-lt)' : 'var(--orange-lt)',
        border: `1.5px solid ${isCreate ? 'var(--teal)' : 'var(--orange)'}`,
        borderRadius: 'var(--r-sm)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: isCreate ? 'var(--teal-dk)' : 'var(--orange)', marginBottom: 8 }}>
          {isCreate
            ? <><Icon name="plus" size={13} /> Create new part</>
            : <><Icon name="edit" size={13} /> Edit attributes — {line.part?.name}</>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isCreate ? '1fr 2fr 80px' : '1fr 2fr 80px', gap: 6, marginBottom: 6 }}>
          {isCreate ? (
            <>
              <input
                type="text" value={fSku}
                onChange={e => setFSku(e.target.value)}
                placeholder="SKU * (e.g. ACM-1234)"
                autoComplete="off" name={`po-form-sku-${line.tempId}`}
                style={inputStyle()}
              />
              <input
                type="text" value={fName}
                onChange={e => setFName(e.target.value)}
                placeholder="Part name *"
                autoComplete="off" name={`po-form-name-${line.tempId}`}
                style={inputStyle()}
              />
            </>
          ) : (
            <>
              <div style={{ ...inputStyle(), background: 'var(--surface2)', color: 'var(--muted)' }}>{line.part?.id}</div>
              <div style={{ ...inputStyle(), background: 'var(--surface2)', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.part?.name}</div>
            </>
          )}
          <select
            value={fUnit}
            onChange={e => setFUnit(e.target.value)}
            style={inputStyle()}
          >
            <option value="ea">ea</option>
            <option value="ft">ft</option>
            <option value="in">in</option>
            <option value="m">m</option>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
            <option value="set">set</option>
            <option value="roll">roll</option>
            <option value="box">box</option>
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
          <input
            type="text" value={fDept}
            onChange={e => setFDept(e.target.value)}
            placeholder="Department (optional)"
            autoComplete="off" name={`po-form-dept-${line.tempId}`}
            style={inputStyle()}
            list={`po-form-dept-list-${line.tempId}`}
          />
          <input
            type="text" value={fMatGrp}
            onChange={e => setFMatGrp(e.target.value)}
            placeholder="Material group (optional)"
            autoComplete="off" name={`po-form-mat-${line.tempId}`}
            style={inputStyle()}
          />
          {/* Hint: matches the existing 5 departments, plus free text */}
          <datalist id={`po-form-dept-list-${line.tempId}`}>
            <option value="Fiber Construction" />
            <option value="Drop Installation" />
            <option value="Underground construction" />
            <option value="Splice" />
            <option value="Customer Installation" />
          </datalist>
        </div>

        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button onClick={cancelForm}
            style={{ fontSize: 11, color: 'var(--muted)', background: 'none', border: '1px solid var(--border2)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button
            onClick={isCreate ? saveCreate : saveEdit}
            disabled={isCreate && (!fSku.trim() || !fName.trim())}
            style={{
              fontSize: 11, color: 'white',
              background: isCreate ? 'var(--teal-dk)' : 'var(--orange)',
              border: 'none', borderRadius: 6, padding: '4px 12px',
              cursor: 'pointer', fontWeight: 700,
            }}
          >
            {isCreate ? 'Save part' : 'Save changes'}
          </button>
        </div>
      </div>
    )
  }

  // ── Default 'idle' mode: search OR picked-part chip + qty/cost ──
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6,
      padding: 8, background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
    }}>
      {/* Part picker / picked chip */}
      <div style={{ flex: 2, minWidth: 0, position: 'relative' }}>
        {line.part ? (
          <div style={{
            padding: '6px 10px', background: 'var(--surface)',
            border: `1px solid ${line.part.isNew ? 'var(--teal)' : 'var(--border)'}`,
            borderRadius: 6,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {line.part.name}
                {line.part.isNew && (
                  <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: 'var(--teal)', color: 'white' }}>NEW</span>
                )}
                {line.pendingAttrs && (
                  <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: 'var(--orange)', color: 'white' }}>EDITED</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--hint)' }}>{line.part.id}</div>
            </div>
            {!line.part.isNew && (
              <button
                onClick={startEdit}
                title="Edit unit / department / material group"
                style={{ fontSize: 10, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
              >edit attrs</button>
            )}
            <button
              onClick={() => onChange({ part: null, pendingAttrs: null })}
              style={{ fontSize: 10, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
            >change</button>
          </div>
        ) : (
          <>
            <input
              type="text" value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search part name or SKU…"
              autoComplete="off" name={`po-line-part-${line.tempId}`}
              style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--bg)' }}
            />
            {/* Results dropdown OR "no match → create new" prompt */}
            {(results.length > 0 || (query.length >= 2 && !searching)) && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 6, zIndex: 5, maxHeight: 240, overflowY: 'auto',
                boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
              }}>
                {results.map(p => (
                  <div
                    key={p.id} onClick={() => pickPart(p)}
                    style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--hint)' }}>{p.id}</div>
                  </div>
                ))}
                {/* "No match" / "Add new" affordance always visible at bottom
                    when we have a query, even if there are partial matches */}
                <div
                  onClick={startCreate}
                  style={{
                    padding: '8px 10px', cursor: 'pointer',
                    background: 'var(--teal-lt)', color: 'var(--teal-dk)',
                    fontWeight: 700, fontSize: 12,
                    borderTop: results.length > 0 ? '1px solid var(--border)' : 'none',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  <Icon name="plus" size={13} /> Create new part {query.trim() && <span style={{ fontWeight: 400 }}>— "{query.trim()}"</span>}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Quantity */}
      <div style={{ width: 80 }}>
        <input
          type="number" min="0" step="any"
          value={line.quantity}
          onChange={e => onChange({ quantity: e.target.value })}
          placeholder="Qty"
          autoComplete="off" name={`po-line-qty-${line.tempId}`}
          style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--bg)', textAlign: 'right' }}
        />
        {line.part && (
          <div style={{ fontSize: 9, color: 'var(--hint)', textAlign: 'right', marginTop: 2 }}>
            {line.pendingAttrs?.unit || line.part.unit || 'ea'}
          </div>
        )}
      </div>

      {/* Unit cost (optional) */}
      <div style={{ width: 90 }}>
        <input
          type="number" min="0" step="any"
          value={line.unit_cost}
          onChange={e => onChange({ unit_cost: e.target.value })}
          placeholder="$ each"
          autoComplete="off" name={`po-line-cost-${line.tempId}`}
          style={{ width: '100%', padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--bg)', textAlign: 'right' }}
        />
      </div>

      {onRemove ? (
        <button
          onClick={onRemove}
          title="Remove line"
          style={{ fontSize: 14, color: 'var(--red)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px' }}
        >×</button>
      ) : (
        <span style={{ width: 24 }} />
      )}
    </div>
  )
}

const inputStyle = () => ({
  padding: '6px 10px',
  fontSize: 12,
  border: '1px solid var(--border2)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--text)',
})
