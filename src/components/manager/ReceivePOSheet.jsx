import { useState, useEffect, useRef } from 'react'
import { recordMovementsBatch, getBinsForWarehouse } from '../../lib/inventory'
import { searchPartsCatalog } from '../../lib/supabase'

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
      onRecorded(validLines.length)
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

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 760, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>📥 Receive PO / vendor delivery</div>
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
            }}
          >＋ Add line</button>

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

function ReceiveLineRow({ line, onChange, onRemove }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const searchTimer = useRef(null)

  // Debounced part search (only while no part is picked)
  useEffect(() => {
    if (line.part) { setResults([]); return }
    if (!query || query.length < 2) { setResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      try {
        const data = await searchPartsCatalog(query, { limit: 8 })
        setResults(data)
      } catch (e) {
        console.warn('Part search failed:', e)
        setResults([])
      }
    }, 200)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [query, line.part])

  function pickPart(p) {
    onChange({ part: p })
    setQuery('')
    setResults([])
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6,
      padding: 8, background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
    }}>
      {/* Part picker */}
      <div style={{ flex: 2, minWidth: 0, position: 'relative' }}>
        {line.part ? (
          <div style={{
            padding: '6px 10px', background: 'var(--surface)',
            border: '1px solid var(--border)', borderRadius: 6,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line.part.name}</div>
              <div style={{ fontSize: 10, color: 'var(--hint)' }}>{line.part.id}</div>
            </div>
            <button
              onClick={() => onChange({ part: null })}
              style={{ fontSize: 10, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
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
            {results.length > 0 && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 6, zIndex: 5, maxHeight: 220, overflowY: 'auto',
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
          <div style={{ fontSize: 9, color: 'var(--hint)', textAlign: 'right', marginTop: 2 }}>{line.part.unit || 'ea'}</div>
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
