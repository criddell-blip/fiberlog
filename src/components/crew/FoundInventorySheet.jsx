import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { searchParts } from '../../lib/supabase'
import { getLocations, createIntakeRequest } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Crew "Report found inventory" (backlog #19). The crew member is physically
// holding a part the system doesn't show. They search the catalog (or add a new
// part inline), pick a destination warehouse + qty + reason, and submit a
// PENDING request — NOTHING moves until a manager approves. No source location,
// no qty cap (found stock has no on-hand to bound it), and the draft fields are
// carried on the request (the part is created by the approval RPC, not here —
// crew can't write parts_catalog).
export default function FoundInventorySheet({ onClose, onComplete }) {
  const { currentUser, showToast } = useApp()

  // Part selection: either an existing catalog part, or a new draft.
  const [partSel, setPartSel] = useState(null)      // { id, name, unit } | null
  const [showDraft, setShowDraft] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftUnit, setDraftUnit] = useState('ea')
  const [draftDept, setDraftDept] = useState('')

  // Catalog search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Destination warehouse
  const [warehouses, setWarehouses] = useState([])
  const [locId, setLocId] = useState('')

  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const dirty = !!partSel || showDraft || !!draftName.trim() || !!qty.trim() || !!reason.trim()
  useBackClose(1, onClose, {
    confirm: () => !dirty || window.confirm('Discard this report?'),
  })

  // Load warehouses once; auto-select if there's only one.
  useEffect(() => {
    let cancelled = false
    getLocations()
      .then(list => {
        if (cancelled) return
        const whs = (list || []).filter(l => l.type === 'warehouse')
        setWarehouses(whs)
        if (whs.length === 1) setLocId(whs[0].id)
      })
      .catch(e => console.warn('Load warehouses failed:', e))
    return () => { cancelled = true }
  }, [])

  async function handleSearch(q) {
    setQuery(q)
    if (q.trim().length < 2) { setResults([]); return }
    setSearching(true)
    try {
      setResults(await searchParts(q.trim()))
    } catch (e) {
      console.warn('Part search failed:', e)
    } finally {
      setSearching(false)
    }
  }

  function pickExisting(p) {
    setPartSel({ id: p.id, name: p.name, unit: p.unit || 'ea' })
    setShowDraft(false)
    setError('')
  }

  function clearPart() {
    setPartSel(null)
    setShowDraft(false)
    setQuery('')
    setResults([])
  }

  function startDraft() {
    setShowDraft(true)
    setPartSel(null)
    setDraftName(query.trim())   // seed from whatever they searched
    setError('')
  }

  async function handleSubmit() {
    setError('')
    if (!partSel && !showDraft) { setError('Pick a part or add a new one'); return }
    if (showDraft && !draftName.trim()) { setError('New part needs a name'); return }
    if (!locId) { setError('Pick a destination warehouse'); return }
    const q = Number(qty)
    if (!q || q <= 0) { setError('Enter a quantity greater than 0'); return }

    setSubmitting(true)
    try {
      await createIntakeRequest({
        partId: partSel?.id || null,
        isDraft: showDraft,
        draftName: showDraft ? draftName : null,
        draftUnit: showDraft ? draftUnit : null,
        draftDepartment: showDraft ? draftDept : null,
        quantity: q,
        targetLocationId: locId,
        reason,
        requestedBy: currentUser?.id,
      })
      showToast('Sent for manager approval')
      onComplete ? onComplete() : onClose()
    } catch (e) {
      setError(e.message || 'Could not submit')
      setSubmitting(false)
    }
  }

  const unitLabel = partSel?.unit || (showDraft ? (draftUnit || 'ea') : 'ea')

  return (
    // Backdrop tap does NOT dismiss (mirrors CrewMovementSheet) — avoids losing
    // a half-filled report. Cancel is in the footer; Back uses the confirm.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 480, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14, flexShrink: 0 }}>
          <Icon name="box" size={19} />
          <div style={{ fontWeight: 800, fontSize: 17 }}>Report found inventory</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* ── Part ─────────────────────────────────────────────────────── */}
          {partSel ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
              background: 'var(--orange-lt)', border: '1.5px solid var(--orange)',
              borderRadius: 'var(--r-sm)', marginBottom: 14,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{partSel.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>{partSel.id}</div>
              </div>
              <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={clearPart}>Change</button>
            </div>
          ) : showDraft ? (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>New part (manager will review)</div>
                <button
                  onClick={() => { setShowDraft(false); setDraftName('') }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--teal-mid)', fontSize: 12, fontWeight: 600 }}
                >Search existing instead</button>
              </div>
              <div className="field">
                <label>Part name *</label>
                <input type="text" value={draftName} onChange={e => { setDraftName(e.target.value); setError('') }} placeholder="e.g. Fiber drop clamp" autoFocus />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>Unit</label>
                  <input type="text" value={draftUnit} onChange={e => setDraftUnit(e.target.value)} placeholder="ea" />
                </div>
                <div className="field" style={{ flex: 2 }}>
                  <label>Department (optional)</label>
                  <input type="text" value={draftDept} onChange={e => setDraftDept(e.target.value)} placeholder="e.g. Fiber" />
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <div className="field">
                <label>Which part?</label>
                <input
                  type="text" value={query}
                  onChange={e => handleSearch(e.target.value)}
                  placeholder="Search by name or SKU…"
                  autoComplete="off" autoCorrect="off" spellCheck="false"
                  autoFocus
                />
              </div>
              {searching && <div style={{ textAlign: 'center', padding: 12, color: 'var(--muted)', fontSize: 13 }}>Searching…</div>}
              {!searching && results.map(p => (
                <div
                  key={p.id}
                  onClick={() => pickExisting(p)}
                  style={{
                    padding: '11px 13px', background: 'var(--bg)', borderRadius: 'var(--r-sm)',
                    marginBottom: 6, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--hint)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{p.id}</div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--gray-lt)', padding: '3px 8px', borderRadius: 20, flexShrink: 0 }}>
                    {p.material_group || p.category || '—'}
                  </div>
                </div>
              ))}
              <button
                className="btn btn-ghost"
                style={{ width: '100%', marginTop: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                onClick={startDraft}
              >
                <Icon name="plus" size={15} /> Can't find it — add as new part
              </button>
            </div>
          )}

          {/* ── Destination warehouse ────────────────────────────────────── */}
          <div className="field">
            <label>Book into which warehouse? *</label>
            {warehouses.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--hint)', padding: '8px 0' }}>Loading warehouses…</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {warehouses.map(w => {
                  const sel = locId === w.id
                  return (
                    <button
                      key={w.id}
                      onClick={() => { setLocId(w.id); setError('') }}
                      style={{
                        textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
                        background: sel ? 'var(--orange-lt)' : 'var(--bg)',
                        border: `1.5px solid ${sel ? 'var(--orange)' : 'var(--border2)'}`,
                        borderRadius: 'var(--r-sm)', fontWeight: sel ? 700 : 500, fontSize: 14,
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                      }}
                    >
                      <span aria-hidden>🏭</span>{w.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── Quantity + reason ────────────────────────────────────────── */}
          <div className="field">
            <label>How many? *</label>
            <input
              type="number" inputMode="decimal" min="0" step="any"
              value={qty}
              onChange={e => { setQty(e.target.value); setError('') }}
              placeholder="0"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>{unitLabel}</div>
          </div>

          <div className="field">
            <label>Where / why did you find it?</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Found a box of these in the back of the truck — not on my stock"
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 8, fontWeight: 600 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 12 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Sending…' : 'Send for approval'}
          </button>
        </div>
      </div>
    </div>
  )
}
