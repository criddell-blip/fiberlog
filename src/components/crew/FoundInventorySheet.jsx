import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import { searchParts } from '../../lib/supabase'
import { getLocations, createIntakeRequest, getRefurbTwin } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import { t } from '../../lib/i18n'
import Icon from '../shared/Icon'

// Crew "Report found inventory" (backlog #19). The crew member is physically
// holding a part the system doesn't show. They search the catalog (or add a new
// part inline), pick a destination warehouse + qty + reason, and submit a
// PENDING request — NOTHING moves until a manager approves. No source location,
// no qty cap (found stock has no on-hand to bound it), and the draft fields are
// carried on the request (the part is created by the approval RPC, not here —
// crew can't write parts_catalog).
//
// mode='field_return' (Aug 2026) reuses the same request pipeline for a used
// unit PULLED FROM A CUSTOMER / SITE: intake_kind='field_return', destination
// is the "Returns – to test" quarantine bin, no new-part drafts (returned
// gear is by definition a catalog part), and on approval the RPC books the
// part's REFURBISHED TWIN (<sku>-R, Sage UB…_R) so a used unit never re-enters
// stock as new. The sheet previews that twin so the crew sees what will land.
const RETURNS_BIN_NAME = 'Returns – to test'

export default function FoundInventorySheet({ onClose, onComplete, mode = 'found' }) {
  const { currentUser, showToast, lang } = useApp()
  const isReturn = mode === 'field_return'

  // Part selection: either an existing catalog part, or a new draft.
  const [partSel, setPartSel] = useState(null)      // { id, name, unit } | null
  const [twin, setTwin] = useState(undefined)       // field_return: undefined = looking, null = none, obj = twin
  const twinSeq = useRef(0)
  const [returnsBin, setReturnsBin] = useState(null) // field_return: { id, name, parentName } when the bin exists
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
    confirm: () => !dirty || window.confirm(t('discardReport', lang)),
  })

  // Load warehouses once; auto-select if there's only one.
  useEffect(() => {
    let cancelled = false
    getLocations({ includeBins: isReturn })
      .then(list => {
        if (cancelled) return
        const whs = (list || []).filter(l => l.type === 'warehouse')
        setWarehouses(whs)
        // Field returns quarantine: land in the returns bin when it exists
        // and skip the picker. Falls back to the warehouse list otherwise.
        if (isReturn) {
          const rb = (list || []).find(l => l.type === 'bin' && l.name === RETURNS_BIN_NAME && l.is_active !== false)
          if (rb) {
            const parent = whs.find(w => w.id === rb.parent_location_id)
            setReturnsBin({ id: rb.id, name: rb.name, parentName: parent?.name || '' })
            setLocId(rb.id)
            return
          }
        }
        if (whs.length === 1) setLocId(whs[0].id)
      })
      .catch(e => console.warn('Load warehouses failed:', e))
    return () => { cancelled = true }
  }, [isReturn])

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
    setPartSel({ id: p.id, name: p.name, unit: p.unit || 'ea', refurb_of: p.refurb_of || null })
    setShowDraft(false)
    setError('')
    if (isReturn) {
      // Preview what approval will book. Picking the twin itself = no swap.
      // Seq-guarded: a faster second pick must not be overwritten by the
      // first pick's late result (display only — the RPC does the real swap).
      if (p.refurb_of) { setTwin(null); return }
      setTwin(undefined)
      const seq = ++twinSeq.current
      getRefurbTwin(p.id)
        .then(t => { if (seq === twinSeq.current) setTwin(t) })
        .catch(() => { if (seq === twinSeq.current) setTwin(null) })
    }
  }

  function clearPart() {
    setPartSel(null)
    setTwin(undefined)
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
    // Error state holds an i18n key (or a raw server message) — t()
    // passes unknown strings through, so rendering t(error, lang) covers both.
    setError('')
    if (!partSel && !showDraft) { setError('pickPartOrAdd'); return }
    if (showDraft && !draftName.trim()) { setError('newPartNeedsName'); return }
    if (!locId) { setError('pickDestWarehouse'); return }
    const q = Number(qty)
    if (!q || q <= 0) { setError('enterQtyGtZero'); return }

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
        intakeKind: isReturn ? 'field_return' : 'found',
      })
      showToast(t('sentForApproval', lang))
      onComplete ? onComplete() : onClose()
    } catch (e) {
      setError(e.message || 'couldNotSubmit')
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
          <Icon name={isReturn ? 'rotate' : 'box'} size={19} />
          <div style={{ fontWeight: 800, fontSize: 17 }}>{t(isReturn ? 'pulledFromCustomer' : 'reportFoundInventory', lang)}</div>
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
                {/* Field return: what approval will actually book. */}
                {isReturn && !partSel.refurb_of && twin !== undefined && (
                  twin
                    ? <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text)' }}>
                        <Icon name="rotate" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 4 }} />
                        {t('bookedAsRefurb', lang)} <strong>{twin.name}</strong>
                        <span style={{ color: 'var(--muted)', fontFamily: 'var(--font-mono)', marginLeft: 4 }}>{twin.id}</span>
                      </div>
                    : <div style={{ fontSize: 11, marginTop: 6, color: 'var(--amber)' }}>{t('noRefurbTwin', lang)}</div>
                )}
              </div>
              <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12 }} onClick={clearPart}>{t('change', lang)}</button>
            </div>
          ) : showDraft ? (
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{t('newPartManagerReview', lang)}</div>
                <button
                  onClick={() => { setShowDraft(false); setDraftName('') }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--teal-mid)', fontSize: 12, fontWeight: 600 }}
                >{t('searchExistingInstead', lang)}</button>
              </div>
              <div className="field">
                <label>{t('partNameReq', lang)}</label>
                <input type="text" value={draftName} onChange={e => { setDraftName(e.target.value); setError('') }} placeholder={t('draftNamePh', lang)} autoFocus />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>{t('unitLabel', lang)}</label>
                  <input type="text" value={draftUnit} onChange={e => setDraftUnit(e.target.value)} placeholder="ea" />
                </div>
                <div className="field" style={{ flex: 2 }}>
                  <label>{t('departmentOptional', lang)}</label>
                  <input type="text" value={draftDept} onChange={e => setDraftDept(e.target.value)} placeholder={t('deptPh', lang)} />
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <div className="field">
                <label>{t('whichPart', lang)}</label>
                <input
                  type="text" value={query}
                  onChange={e => handleSearch(e.target.value)}
                  placeholder={t('foundSearchPh', lang)}
                  autoComplete="off" autoCorrect="off" spellCheck="false"
                  autoFocus
                />
              </div>
              {searching && <div style={{ textAlign: 'center', padding: 12, color: 'var(--muted)', fontSize: 13 }}>{t('searching', lang)}</div>}
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
              {/* Returned equipment is always an existing catalog part — no
                  drafts in field-return mode. */}
              {isReturn ? (
                query.trim().length >= 2 && !searching && results.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--hint)', padding: '8px 0' }}>{t('pulledOnlyCatalog', lang)}</div>
                )
              ) : (
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%', marginTop: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={startDraft}
                >
                  <Icon name="plus" size={15} /> {t('cantFindAddNew', lang)}
                </button>
              )}
            </div>
          )}

          {/* ── Destination warehouse ────────────────────────────────────── */}
          {returnsBin ? (
            <div className="field">
              <label>{t('booksInto', lang)}</label>
              <div style={{ padding: '10px 12px', background: 'var(--bg)', border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, width: '100%' }}>
                <span aria-hidden>📥</span>{returnsBin.name}
                {returnsBin.parentName && <span style={{ color: 'var(--hint)', fontWeight: 400, fontSize: 12 }}>· {returnsBin.parentName}</span>}
              </div>
            </div>
          ) : (
          <div className="field">
            <label>{t('bookIntoWarehouse', lang)}</label>
            {warehouses.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--hint)', padding: '8px 0' }}>{t('loadingWarehouses', lang)}</div>
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
          )}

          {/* ── Quantity + reason ────────────────────────────────────────── */}
          <div className="field">
            <label>{t('howMany', lang)}</label>
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
            <label>{t(isReturn ? 'pulledWhereWhy' : 'whereWhyFound', lang)}</label>
            <textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder={t(isReturn ? 'pulledReasonPh' : 'foundReasonPh', lang)}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          {error && (
            <div style={{ padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 8, fontWeight: 600 }}>
              {t(error, lang)}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0, marginTop: 12 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>{t('cancel', lang)}</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('sending', lang) : t('sendForApproval', lang)}
          </button>
        </div>
      </div>
    </div>
  )
}
