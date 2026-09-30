import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import {
  getPartForRefurb, getRefurbTwin, createRefurbTwin, getPartLocations,
  recordMovementsBatch, locationTypeLabel,
} from '../../lib/inventory'
import { buildRefurbConversionPayloads } from '../../lib/refurbConvert'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// ─── Convert new stock → refurbished twin ────────────────────────────────────
//
// Used units sitting under the NEW SKU (returned before twins existed, or
// bench-tested and found used) get moved onto the part's `-R` twin at the
// same location. Books a linked adjust pair — see lib/refurbConvert.js for
// why adjusts (internal only, never exported to Sage).
//
// Opened from the Parts tab row, the per-part Locations panel (location
// pre-picked) and a location's stock list (location pre-picked). Mints the
// twin inline when the part doesn't have one yet, same convention as
// Receive PO's field-return path.
export default function ConvertToRefurbSheet({ partId, initialLocationId = null, onClose, onDone }) {
  const { currentUser, showToast, isQtyPaused } = useApp()
  const [parent, setParent] = useState(null)
  const [twin, setTwin] = useState(null)
  const [locs, setLocs] = useState([])
  const [twinQtyByLoc, setTwinQtyByLoc] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [locationId, setLocationId] = useState(initialLocationId || '')
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [minting, setMinting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const dirty = qty !== '' || reason.trim() !== ''
  const confirmDiscard = () => !dirty || window.confirm('Discard this conversion?')
  useBackClose(1, onClose, { confirm: confirmDiscard })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [p, t, where] = await Promise.all([
          getPartForRefurb(partId), getRefurbTwin(partId), getPartLocations(partId),
        ])
        if (cancelled) return
        setParent(p)
        setTwin(t)
        // Only real shelf/truck stock can be converted — a Region's qty is
        // consumed material, and vendor/scrap aren't holding locations.
        const usable = where.locations.filter(l => l.qty > 0 && l.isActive && !l.isConsumed && !['vendor', 'scrap'].includes(l.type))
        setLocs(usable)
        if (initialLocationId && !usable.some(l => l.locationId === initialLocationId)) {
          // Stock at the tapped row drained (or it's retired) since it was drawn.
          setLocationId('')
          setError('That location no longer has any of this part on hand — pick another.')
        } else if (!initialLocationId && usable.length === 1) setLocationId(usable[0].locationId)
        if (t) await loadTwinQty(t.id, () => cancelled)
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [partId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function loadTwinQty(twinId, isCancelled = () => false) {
    // includeNegative: a twin already below zero here must preview its real "before".
    const r = await getPartLocations(twinId, { includeNegative: true })
    if (!isCancelled()) setTwinQtyByLoc(new Map(r.locations.map(l => [l.locationId, l.qty])))
  }

  async function handleMintTwin() {
    setError('')
    setMinting(true)
    try {
      const t = await createRefurbTwin(parent, {
        created_via: { source: 'Convert to refurbished', by: currentUser?.name || null },
      })
      if (!t) throw new Error('Twin created but not returned — close and reopen this sheet')
      setTwin(t)
      setTwinQtyByLoc(new Map())
      showToast(`Created ${t.id}`)
    } catch (e) {
      setError(e?.code === '23505'
        ? `${parent.id}-R already exists — link it via Parts → Edit → "Refurbished twin of"`
        : (e.message || String(e)))
    } finally {
      setMinting(false)
    }
  }

  const loc = locs.find(l => l.locationId === locationId) || null
  const onHand = loc?.qty ?? 0
  const n = Number(qty) || 0
  const unit = parent?.unit || 'ea'

  async function handleSubmit() {
    setError('')
    setSubmitting(true)
    try {
      // Re-read on-hand right before booking: the number the sheet opened
      // with can be stale (a crew load since), and the stock trigger lets a
      // location go negative, so the DB won't catch an overdraw. A small
      // race window remains — closing it fully would need a SECURITY DEFINER
      // RPC that locks the stock row; not worth it for a manager-only tool.
      const fresh = await getPartLocations(parent.id)
      const freshOnHand = fresh.locations.find(l => l.locationId === locationId)?.qty ?? 0
      let payloads
      try {
        payloads = buildRefurbConversionPayloads({
          parent, twin, locationId, quantity: qty, onHand: freshOnHand, reason,
          pairId: crypto.randomUUID(), createdBy: currentUser?.id,
        })
      } catch (e) {
        // Don't echo the count while quantities are paused.
        setError(isQtyPaused && /^Only /.test(e.message) ? 'Not that many on hand here' : e.message)
        return
      }
      // One insert → both halves land or neither does.
      await recordMovementsBatch(payloads)
      showToast(`Converted ${n} × ${parent.id} → ${twin.id} at ${loc.displayLabel}`)
      onDone?.()
      onClose()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && confirmDiscard() && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 520 }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Convert to refurbished</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.45 }}>
          Used units that are sitting under the <b>new</b> part move onto its refurbished twin, at the same location.
          Nothing physically moves.
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>
        ) : !parent ? (
          <div className="banner banner-error" style={{ marginBottom: 10, fontSize: 12 }}>{error || `Part ${partId} not found`}</div>
        ) : parent.is_active === false ? (
          <div className="banner banner-warning" style={{ marginBottom: 10, fontSize: 12 }}>
            {parent.id} is a draft (inactive) part — activate it in the Parts tab first.
          </div>
        ) : parent.refurb_of ? (
          <div className="banner banner-warning" style={{ marginBottom: 10, fontSize: 12 }}>
            {parent.id} is already the refurbished twin of {parent.refurb_of}.
          </div>
        ) : (
          <>
            {/* From → To */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <PartChip label="New" id={parent.id} name={parent.name} />
              <Icon name="arrow" size={16} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              {twin
                ? <PartChip label="Refurbished" id={twin.id} name={twin.name} refurb />
                : (
                  <div style={{ flex: 1, minWidth: 180, fontSize: 12, padding: '8px 10px', border: '1px dashed var(--amber)', borderRadius: 'var(--r-sm)', background: 'var(--amber-lt)' }}>
                    <div style={{ marginBottom: 6 }}>No refurbished twin yet.</div>
                    <button className="btn btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={handleMintTwin} disabled={minting}>
                      {minting ? 'Creating…' : <>Create <span className="mono">{parent.id}-R</span>{parent.sage_id ? <> (Sage <span className="mono">{parent.sage_id}_R</span>)</> : null}</>}
                    </button>
                  </div>
                )}
            </div>

            {locs.length === 0 ? (
              <div className="banner banner-warning" style={{ marginBottom: 10, fontSize: 12 }}>
                No {parent.id} on hand anywhere to convert.
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Location</label>
                  <select value={locationId} onChange={e => { setLocationId(e.target.value); setQty('') }}>
                    <option value="">— where are the units? —</option>
                    {locs.map(l => (
                      <option key={l.locationId} value={l.locationId}>
                        {l.displayLabel} · {locationTypeLabel(l.type)}{isQtyPaused ? '' : ` · ${l.qty.toLocaleString()} ${unit}`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Quantity to convert{loc && !isQtyPaused ? ` (max ${onHand.toLocaleString()})` : ''}</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="number" min="1" max={isQtyPaused ? undefined : (onHand || undefined)} step={unit === 'ea' ? 1 : 'any'}
                      value={qty} onChange={e => setQty(e.target.value)}
                      disabled={!loc} autoComplete="off" name="refurb-convert-qty"
                      style={{ flex: 1 }}
                    />
                    {loc && !isQtyPaused && (
                      <button type="button" className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setQty(String(onHand))}>
                        All {onHand.toLocaleString()}
                      </button>
                    )}
                  </div>
                </div>
                <div className="field">
                  <label>Reason <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— optional</span></label>
                  <input
                    type="text" placeholder="e.g. Bench-tested — used, returned before twins existed"
                    value={reason} onChange={e => setReason(e.target.value)}
                    autoComplete="off" name="refurb-convert-reason"
                  />
                </div>

                {loc && twin && n > 0 && n <= onHand && !isQtyPaused && (
                  <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', marginBottom: 10, lineHeight: 1.6 }}>
                    <div>At <b>{loc.displayLabel}</b>:</div>
                    <div><span className="mono">{parent.id}</span> {onHand.toLocaleString()} → <b>{(onHand - n).toLocaleString()}</b></div>
                    <div><span className="mono">{twin.id}</span> {(twinQtyByLoc.get(loc.locationId) || 0).toLocaleString()} → <b>{((twinQtyByLoc.get(loc.locationId) || 0) + n).toLocaleString()}</b></div>
                    <div style={{ color: 'var(--hint)', marginTop: 2 }}>Internal only — booked as a linked adjust pair, not sent to Sage.</div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {error && parent && <div className="banner banner-error" style={{ marginBottom: 10, fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => confirmDiscard() && onClose()} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit}
            disabled={submitting || loading || !twin || !loc || parent?.is_active === false || !!parent?.refurb_of || !(n > 0) || n > onHand}
          >
            {submitting ? 'Converting…' : `Convert${n > 0 ? ` ${n.toLocaleString()}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function PartChip({ label, id, name, refurb = false }) {
  return (
    <div style={{
      flex: 1, minWidth: 140, padding: '8px 10px', borderRadius: 'var(--r-sm)',
      border: `1px solid ${refurb ? 'var(--amber)' : 'var(--border)'}`,
      background: refurb ? 'var(--amber-lt)' : 'var(--surface2)',
    }}>
      <div className="eyebrow" style={{ fontSize: 9, color: refurb ? 'var(--amber)' : 'var(--muted)' }}>{label}</div>
      <div className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{id}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
    </div>
  )
}
