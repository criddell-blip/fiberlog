import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../../AppContext'
import {
  createPurchaseRequest, getPurchaseRequest,
  updatePurchaseRequest, replacePurchaseRequestLines, deletePurchaseRequest,
  markPurchaseRequestReceived, receivePurchaseRequestLine, createPart,
  getLastUnitCost, getRecentVendors,
  buildPurchaseRequestCsv, buildPurchaseRequestEmail,
} from '../../lib/inventory'
import { searchPartsCatalog } from '../../lib/supabase'
import { downloadTextAsFile } from '../../lib/csvImport'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Purchase Request composition + detail/edit sheet.
//
// Modes:
//  • 'new'      — fresh PR. Pre-populated parts come from props.initialParts
//                 (e.g. bulk-select from Stock/Parts tabs).
//  • 'detail'   — loads an existing PR by id and lets the manager edit
//                 lines (only while pending) and transition status.
//
// Per-line vendor matches the Utah Broadband PR spreadsheet column order
// (Vendor · Qty · Item # · Description · Project/Reason · Unit Price ·
// Line Total). Vendor + Project/Reason are autocomplete fields backed by
// movement history and the active projects list respectively.
export default function PurchaseRequestSheet({
  mode = 'new',
  prId = null,
  initialParts = [],
  locations = [],
  onClose,
  onSaved,
  onChanged,
}) {
  const { currentUser, showToast, projects } = useApp()
  const isOwner = currentUser?.role === 'owner'

  // ── Header state ────────────────────────────────────────────────────
  const [pr, setPr] = useState(null)  // detail mode: loaded PR object
  const [loading, setLoading] = useState(mode === 'detail')
  const [dateRequested, setDateRequested] = useState(() => new Date().toISOString().slice(0, 10))
  const [targetLocationId, setTargetLocationId] = useState('')
  const [notes, setNotes] = useState('')

  // ── Status action fields (detail mode) ──────────────────────────────
  const [poNumber, setPoNumber] = useState('')
  const [expectedAt, setExpectedAt] = useState('')

  // ── Lines ───────────────────────────────────────────────────────────
  // Each line: { tempId, part_id, item_number, description, vendor, qty,
  //              project_reason, unit_cost }
  const [lines, setLines] = useState([])

  // Back closes the sheet (mounted only when open). Confirm if composing a new
  // PR with content, or if a note was typed (detail mode loads an existing PR,
  // so don't nag on a plain view-and-close).
  useBackClose(1, onClose, {
    confirm: () => {
      const dirty = notes.trim() !== '' || (mode === 'new' && lines.length > 0)
      return !dirty || window.confirm('Discard this purchase request?')
    },
  })

  // ── Suggestions ─────────────────────────────────────────────────────
  const [vendorSuggestions, setVendorSuggestions] = useState([])
  // Active project names for Project/Reason autocomplete
  const projectOptions = useMemo(() => {
    return (projects || [])
      .map(p => p.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  }, [projects])

  // ── Search-to-add-part ──────────────────────────────────────────────
  const [partQuery, setPartQuery] = useState('')
  const [partResults, setPartResults] = useState([])
  const searchTimerRef = useRef(null)

  // ── Submit state ────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // When set, the printable PR view renders via Portal + we trigger
  // window.print(). Cleared on the browser's afterprint event so the
  // hidden portal doesn't linger in the DOM after the dialog closes.
  const [printablePr, setPrintablePr] = useState(null)
  useEffect(() => {
    if (!printablePr) return
    const handler = () => setPrintablePr(null)
    window.addEventListener('afterprint', handler)
    return () => window.removeEventListener('afterprint', handler)
  }, [printablePr])

  // Load recent vendors once on mount.
  useEffect(() => {
    let cancelled = false
    getRecentVendors({ limit: 25 })
      .then(v => { if (!cancelled) setVendorSuggestions(v) })
      .catch(e => console.warn('getRecentVendors:', e))
    return () => { cancelled = true }
  }, [])

  // Detail mode: load the PR + map its lines into local state.
  useEffect(() => {
    if (mode !== 'detail' || !prId) return
    let cancelled = false
    setLoading(true)
    getPurchaseRequest(prId)
      .then(loaded => {
        if (cancelled || !loaded) return
        setPr(loaded)
        setDateRequested(loaded.date_requested || new Date().toISOString().slice(0, 10))
        setTargetLocationId(loaded.target_location_id || '')
        setNotes(loaded.notes || '')
        setPoNumber(loaded.po_number || '')
        setExpectedAt(loaded.expected_at || '')
        setLines((loaded.lines || []).map((l, i) => ({
          tempId: l.id || `loaded-${i}`,
          part_id: l.part_id || null,
          item_number: l.item_number || '',
          description: l.description || '',
          vendor: l.vendor || '',
          quantity: l.quantity != null ? String(l.quantity) : '',
          project_reason: l.project_reason || '',
          unit_cost: l.unit_cost != null ? String(l.unit_cost) : '',
        })))
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load PR') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [mode, prId])

  // 'new' mode: seed lines from initialParts (bulk-select pass-through).
  useEffect(() => {
    if (mode !== 'new' || initialParts.length === 0) return
    let cancelled = false
    ;(async () => {
      // Fetch last-known unit cost for each part in parallel.
      const seeded = await Promise.all(
        initialParts.map(async (p, i) => {
          const cost = await getLastUnitCost(p.id).catch(() => null)
          return {
            tempId: `seed-${i}`,
            part_id: p.id,
            item_number: p.id,
            description: p.name || p.id,
            vendor: '',
            quantity: '1',
            project_reason: '',
            unit_cost: cost != null ? String(cost) : '',
          }
        })
      )
      if (!cancelled) setLines(seeded)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced part search (for "Add another part" picker).
  useEffect(() => {
    if (!partQuery || partQuery.length < 2) { setPartResults([]); return }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const r = await searchPartsCatalog(partQuery, { limit: 12 })
        setPartResults(r || [])
      } catch (e) {
        console.warn('part search:', e)
      }
    }, 200)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [partQuery])

  // ── Line ops ────────────────────────────────────────────────────────
  function addCatalogPart(p) {
    setPartQuery('')
    setPartResults([])
    // Avoid duplicates: if the part is already in lines, just bump its qty.
    const existing = lines.find(l => l.part_id === p.id)
    if (existing) {
      setLines(prev => prev.map(l =>
        l.part_id === p.id
          ? { ...l, quantity: String((Number(l.quantity) || 0) + 1) }
          : l
      ))
      return
    }
    // Otherwise: new line with the catalog data, fetch last cost in bg.
    const tempId = `t-${Date.now()}`
    const newLine = {
      tempId,
      part_id: p.id,
      item_number: p.id,
      description: p.name || p.id,
      vendor: '',
      quantity: '1',
      project_reason: '',
      unit_cost: '',
    }
    setLines(prev => [...prev, newLine])
    getLastUnitCost(p.id).then(c => {
      if (c == null) return
      setLines(prev => prev.map(l =>
        l.tempId === tempId ? { ...l, unit_cost: String(c) } : l
      ))
    }).catch(() => {})
  }

  function addFreeformRow() {
    setLines(prev => [...prev, {
      tempId: `t-${Date.now()}`,
      part_id: null,
      item_number: '',
      description: '',
      vendor: '',
      quantity: '1',
      project_reason: '',
      unit_cost: '',
    }])
  }

  function removeLine(tempId) {
    setLines(prev => prev.filter(l => l.tempId !== tempId))
  }

  function updateLine(tempId, patch) {
    setLines(prev => prev.map(l => l.tempId === tempId ? { ...l, ...patch } : l))
  }

  // ── Totals ──────────────────────────────────────────────────────────
  const subtotal = useMemo(() => {
    let sum = 0
    for (const l of lines) {
      const q = Number(l.quantity || 0)
      const c = l.unit_cost === '' || l.unit_cost == null ? null : Number(l.unit_cost)
      if (!Number.isNaN(q) && c != null && !Number.isNaN(c)) sum += q * c
    }
    return sum
  }, [lines])

  // ── Status semantics ────────────────────────────────────────────────
  const isPending = mode === 'new' || (pr?.status || 'pending') === 'pending'
  const isLocked = mode === 'detail' && !isPending
  const status = pr?.status || 'pending'

  // ── Validation ──────────────────────────────────────────────────────
  function validate() {
    if (lines.length === 0) return 'Add at least one line'
    for (const l of lines) {
      if (!l.description || !l.description.trim()) {
        return 'Every line needs a description'
      }
      const q = Number(l.quantity)
      if (!q || q <= 0) return `${l.description}: quantity must be > 0`
    }
    return null
  }

  // ── Save handlers ───────────────────────────────────────────────────
  async function saveAndDo(after) {
    const v = validate()
    if (v) { setError(v); return }
    setError(null)
    setSubmitting(true)
    try {
      let saved
      if (mode === 'new') {
        saved = await createPurchaseRequest({
          dateRequested,
          targetLocationId: targetLocationId || null,
          notes: notes || null,
          lines,
          createdBy: currentUser?.id,
        })
      } else {
        // Detail-edit: persist line changes (only while pending) + header.
        if (isPending) {
          await replacePurchaseRequestLines(prId, lines)
        }
        await updatePurchaseRequest(prId, {
          date_requested: dateRequested,
          target_location_id: targetLocationId || null,
          notes: notes || null,
        })
        saved = await getPurchaseRequest(prId)
      }
      after?.(saved)
      onSaved?.(saved)
    } catch (e) {
      console.error('PR save failed:', e)
      setError(e.message || 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  function exportCsv(saved) {
    const csv = buildPurchaseRequestCsv(saved)
    const safe = (saved.pr_number || 'PR').replace(/[^a-z0-9-]/gi, '_')
    downloadTextAsFile(`fiberlog-${safe}-${saved.date_requested || ''}.csv`, csv)
    showToast(`Exported ${saved.pr_number}`)
  }

  async function copyEmail(saved) {
    try {
      const txt = buildPurchaseRequestEmail(saved)
      await navigator.clipboard.writeText(txt)
      showToast(`Copied ${saved.pr_number} to clipboard`)
    } catch (e) {
      showToast('Could not access clipboard — open the PR detail to copy manually')
    }
  }

  // PDF export = render a print-styled layout via Portal + trigger
  // window.print(). The browser print dialog has "Save as PDF" as a
  // destination so the manager gets a real PDF without us bundling a
  // PDF library. Pattern matches BinLabelSheet / SkuLabelSheet.
  function printPdf(saved) {
    setPrintablePr(saved)
    // Defer the print() so the portal renders first
    setTimeout(() => window.print(), 80)
  }

  // Receiving (full or partial) is handled per-line by ReceivePanel; this
  // only drives the pending→ordered and *→cancelled transitions.
  async function changeStatus(nextStatus) {
    setSubmitting(true)
    setError(null)
    try {
      const patch = { status: nextStatus }
      if (nextStatus === 'ordered') {
        if (poNumber) patch.po_number = poNumber
        if (expectedAt) patch.expected_at = expectedAt
        patch.approved_by = currentUser?.id || null
      }
      await updatePurchaseRequest(prId, patch)
      const reloaded = await getPurchaseRequest(prId)
      setPr(reloaded)
      onSaved?.(reloaded)
      showToast(`PR marked ${nextStatus}`)
    } catch (e) {
      setError(e.message || 'Status update failed')
    } finally {
      setSubmitting(false)
    }
  }

  // ReceivePanel hands back the reloaded PR after a line (or all lines) is
  // received. Update local state but DON'T call onSaved — that closes the
  // sheet, and partial receiving needs the sheet to stay open across lines.
  // onChanged refreshes the parent list in the background instead.
  function handleReceived(fresh) {
    if (!fresh) return
    setPr(fresh)
    onChanged?.(fresh)
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${pr?.pr_number}? This cannot be undone.`)) return
    setSubmitting(true)
    try {
      await deletePurchaseRequest(prId)
      showToast(`${pr?.pr_number} deleted`)
      onSaved?.(null)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Delete failed')
      setSubmitting(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  const locationOptions = useMemo(() =>
    locations.filter(l => l.type === 'warehouse' || l.type === 'truck' || l.type === 'job_site'),
    [locations])

  if (loading) {
    return (
      <div className="overlay open">
        <div className="overlay-sheet" style={{ maxWidth: 1100 }}>
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading PR…</div>
        </div>
      </div>
    )
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 1100, maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 18 }}>
            <Icon name="clipboard" size={18} /> Purchase Request
            {pr?.pr_number && <span style={{ marginLeft: 8, color: 'var(--orange)' }}>{pr.pr_number}</span>}
          </div>
          {mode === 'detail' && (
            <span style={statusPill(status)}>{status}</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          {mode === 'new'
            ? `New request · ${currentUser?.name}`
            : `Created by ${pr?.created_by_user?.name || 'Unknown'} · ${pr?.created_at ? new Date(pr.created_at).toLocaleDateString() : ''}`}
        </div>

        {/* Top fields: Date + Deliver to + Notes */}
        <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, marginBottom: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Date requested</label>
            <input
              type="date"
              value={dateRequested}
              onChange={e => setDateRequested(e.target.value)}
              disabled={submitting || isLocked}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Deliver to</label>
            <select
              value={targetLocationId}
              onChange={e => setTargetLocationId(e.target.value)}
              disabled={submitting || isLocked}
            >
              <option value="">— pick a location —</option>
              {locationOptions.map(l => (
                <option key={l.id} value={l.id}>{l.name} ({l.type})</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={submitting || isLocked}
            style={{ minHeight: 50 }}
            placeholder="Reason, urgency, special instructions…"
          />
        </div>

        {/* Lines table */}
        <div style={{ marginTop: 8, marginBottom: 8, fontWeight: 600, fontSize: 12, color: 'var(--muted)' }}>
          Lines ({lines.length})
        </div>
        <div style={{
          flex: 1, overflowY: 'auto', minHeight: 200, marginBottom: 8,
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
        }}>
          {/* Column header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '140px 60px 110px 1.6fr 1fr 90px 90px 32px',
            gap: 6, padding: '6px 10px',
            background: 'var(--surface2)', fontSize: 10, fontWeight: 700,
            color: 'var(--muted)', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border)',
            position: 'sticky', top: 0,
          }}>
            <div>Vendor</div>
            <div>Qty</div>
            <div>Item #</div>
            <div>Description</div>
            <div>Project / Reason</div>
            <div style={{ textAlign: 'right' }}>Unit $</div>
            <div style={{ textAlign: 'right' }}>Total</div>
            <div></div>
          </div>

          {/* Line rows */}
          {lines.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
              No lines yet. Search a catalog part below, or add a freeform row.
            </div>
          )}
          {lines.map((l) => {
            const qty = Number(l.quantity || 0)
            const uc = l.unit_cost === '' || l.unit_cost == null ? null : Number(l.unit_cost)
            const total = uc == null ? null : qty * uc
            return (
              <div
                key={l.tempId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 60px 110px 1.6fr 1fr 90px 90px 32px',
                  gap: 6, padding: '6px 10px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                }}
              >
                <input
                  list="pr-vendor-list"
                  type="text"
                  value={l.vendor}
                  onChange={e => updateLine(l.tempId, { vendor: e.target.value })}
                  disabled={submitting || isLocked}
                  placeholder="vendor"
                  style={lineInputStyle()}
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={l.quantity}
                  onChange={e => updateLine(l.tempId, { quantity: e.target.value })}
                  disabled={submitting || isLocked}
                  style={{ ...lineInputStyle(), textAlign: 'right' }}
                />
                <input
                  type="text"
                  value={l.item_number}
                  onChange={e => updateLine(l.tempId, { item_number: e.target.value })}
                  disabled={submitting || isLocked}
                  placeholder="SKU / item #"
                  style={lineInputStyle()}
                />
                <input
                  type="text"
                  value={l.description}
                  onChange={e => updateLine(l.tempId, { description: e.target.value })}
                  disabled={submitting || isLocked}
                  placeholder="description"
                  style={lineInputStyle()}
                />
                <input
                  list="pr-project-list"
                  type="text"
                  value={l.project_reason}
                  onChange={e => updateLine(l.tempId, { project_reason: e.target.value })}
                  disabled={submitting || isLocked}
                  placeholder="project / reason"
                  style={lineInputStyle()}
                />
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={l.unit_cost}
                  onChange={e => updateLine(l.tempId, { unit_cost: e.target.value })}
                  disabled={submitting || isLocked}
                  placeholder="—"
                  style={{ ...lineInputStyle(), textAlign: 'right' }}
                />
                <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 600, color: total != null ? 'var(--text)' : 'var(--hint)' }}>
                  {total != null ? `$${total.toFixed(2)}` : '—'}
                </div>
                {!isLocked && (
                  <button
                    type="button"
                    onClick={() => removeLine(l.tempId)}
                    disabled={submitting}
                    title="Remove"
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 24, height: 24, padding: 0,
                      background: 'transparent', color: 'var(--muted)',
                      border: '1px solid var(--border)', borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  ><Icon name="x" size={14} /></button>
                )}
              </div>
            )
          })}
        </div>

        {/* Vendor + Project datalists */}
        <datalist id="pr-vendor-list">
          {vendorSuggestions.map(v => <option key={v} value={v} />)}
        </datalist>
        <datalist id="pr-project-list">
          {projectOptions.map(p => <option key={p} value={p} />)}
        </datalist>

        {/* Add-line affordances */}
        {!isLocked && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
              <input
                type="text"
                value={partQuery}
                onChange={e => setPartQuery(e.target.value)}
                placeholder="🔍 Search a catalog part to add…"
                disabled={submitting}
                style={{ flex: 1 }}
                autoComplete="off"
                name="pr-part-search"
              />
              <button
                type="button"
                onClick={addFreeformRow}
                className="btn btn-ghost"
                disabled={submitting}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
              >
                <Icon name="plus" size={13} /> Freeform row
              </button>
            </div>
            {partResults.length > 0 && (
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                {partResults.map(p => (
                  <div
                    key={p.id}
                    onClick={() => addCatalogPart(p)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--hint)' }}>{p.id}{p.category ? ` · ${p.category}` : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Totals */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginBottom: 12, fontSize: 13 }}>
          <div style={{ color: 'var(--muted)' }}>Subtotal:</div>
          <div style={{ fontWeight: 700, minWidth: 90, textAlign: 'right' }}>${subtotal.toFixed(2)}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 20, marginBottom: 14, fontSize: 14 }}>
          <div style={{ fontWeight: 700 }}>Total:</div>
          <div style={{ fontWeight: 800, minWidth: 90, textAlign: 'right', color: 'var(--orange)' }}>${subtotal.toFixed(2)}</div>
        </div>

        {/* Status-action zone (detail mode) */}
        {mode === 'detail' && (
          <div style={{
            padding: '10px 14px', marginBottom: 12,
            background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
            border: '1px solid var(--border)',
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 8 }}>
              Status: {status}
            </div>
            {status === 'pending' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Supplier PO #</label>
                  <input value={poNumber} onChange={e => setPoNumber(e.target.value)} placeholder="e.g. 12345-A" disabled={submitting} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>Expected arrival</label>
                  <input type="date" value={expectedAt} onChange={e => setExpectedAt(e.target.value)} disabled={submitting} />
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 14px', fontSize: 13 }}
                  onClick={() => changeStatus('ordered')}
                  disabled={submitting}
                >
                  <Icon name="check" size={14} /> Mark ordered
                </button>
              </div>
            )}
            {(status === 'ordered' || status === 'partial') && (
              <>
                <div style={{ fontSize: 12, marginBottom: 10 }}>
                  <span style={{ marginRight: 16 }}><strong>PO #:</strong> {pr?.po_number || '—'}</span>
                  <span><strong>ETA:</strong> {pr?.expected_at || '—'}</span>
                </div>
                <ReceivePanel
                  pr={pr}
                  onReceived={handleReceived}
                  onError={setError}
                />
              </>
            )}
            {(status === 'pending' || status === 'ordered' || status === 'partial') && (
              <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => changeStatus('cancelled')}
                  disabled={submitting}
                  className="btn btn-ghost"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 11, color: 'var(--red)' }}
                >
                  <Icon name="x" size={12} /> Cancel PR
                </button>
                {isOwner && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={submitting}
                    className="btn btn-ghost"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 10px', fontSize: 11, color: 'var(--red)' }}
                  >
                    <Icon name="trash" size={12} /> Delete (owner only)
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 12px', marginBottom: 10,
            background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {/* Footer buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" style={{ flex: '1 1 80px' }} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          {!isLocked && (
            <>
              <button
                className="btn btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 110px' }}
                onClick={() => saveAndDo()}
                disabled={submitting || lines.length === 0}
              >
                {submitting
                  ? 'Saving…'
                  : <><Icon name="download" size={14} /> {mode === 'new' ? 'Save draft' : 'Save changes'}</>}
              </button>
              <button
                className="btn btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 110px' }}
                onClick={() => saveAndDo(exportCsv)}
                disabled={submitting || lines.length === 0}
              >
                <Icon name="download" size={14} /> Save & CSV
              </button>
              <button
                className="btn btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 110px' }}
                onClick={() => saveAndDo(printPdf)}
                disabled={submitting || lines.length === 0}
              >
                <Icon name="clipboard" size={14} /> Save & PDF
              </button>
              <button
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 150px' }}
                onClick={() => saveAndDo(copyEmail)}
                disabled={submitting || lines.length === 0}
              >
                <Icon name="mail" size={14} /> Save & copy email
              </button>
            </>
          )}
          {isLocked && (
            <>
              <button
                className="btn btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 130px' }}
                onClick={async () => {
                  const fresh = await getPurchaseRequest(prId)
                  if (fresh) exportCsv(fresh)
                }}
                disabled={submitting}
              >
                <Icon name="download" size={14} /> Download CSV
              </button>
              <button
                className="btn btn-ghost"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 130px' }}
                onClick={async () => {
                  const fresh = await getPurchaseRequest(prId)
                  if (fresh) printPdf(fresh)
                }}
                disabled={submitting}
              >
                <Icon name="clipboard" size={14} /> Print PDF
              </button>
              <button
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, flex: '1 1 130px' }}
                onClick={async () => {
                  const fresh = await getPurchaseRequest(prId)
                  if (fresh) await copyEmail(fresh)
                }}
                disabled={submitting}
              >
                <Icon name="mail" size={14} /> Copy email
              </button>
            </>
          )}
        </div>
      </div>

      {/* Print-only stylesheet + portal. When printablePr is set, the
          screen overlay hides and the portal renders the printable PR
          via createPortal so it's a direct child of body. window.print()
          fires from printPdf(); afterprint clears the state. Pattern
          matches BinLabelSheet. */}
      {printablePr && (
        <>
          <style>{`
            .pr-print-portal { display: none; }
            @media print {
              /* global.css locks html/body/#root to 100% height — undo so
                 the document can be multi-page. */
              html, body, #root { height: auto !important; overflow: visible !important; }
              body > *:not(.pr-print-portal) { display: none !important; }
              .pr-print-portal { display: block !important; }
              @page { size: letter; margin: 0.5in; }
            }
          `}</style>
          {createPortal(
            <div className="pr-print-portal">
              <PrintablePR pr={printablePr} />
            </div>,
            document.body
          )}
        </>
      )}
    </div>
  )
}

// Printable layout for a PR. Mirrors the Utah Broadband purchase-request
// spreadsheet structure (header + Vendor / Qty / Item # / Description /
// Project-Reason / Unit Price / Line Total table + subtotal/total) so
// purchasing recognizes it at a glance. Black-on-white inline styles
// because @media print zaps the app's dark theme.
function PrintablePR({ pr }) {
  const lines = pr.lines || []
  let subtotal = 0
  let anyUnknownCost = false
  const computed = lines.map(l => {
    const qty = Number(l.quantity || 0)
    const uc = l.unit_cost == null ? null : Number(l.unit_cost)
    const total = uc == null ? null : qty * uc
    if (uc == null) anyUnknownCost = true
    else subtotal += total
    return { l, qty, uc, total }
  })
  const fmt$ = n => n == null ? '—' : '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const cell = { border: '1px solid #ccc', padding: '6px 8px', fontSize: 11, verticalAlign: 'top' }
  const headerCell = { ...cell, background: '#f2f2f2', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10, color: '#333' }

  return (
    <div style={{
      color: '#000', background: '#fff',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      padding: 0, fontSize: 12, lineHeight: 1.4,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', borderBottom: '2px solid #f59342', paddingBottom: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 20, color: '#f59342', letterSpacing: 1 }}>UTAH BROADBAND</div>
          <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>FiberLog Purchase Request</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 0.5 }}>Purchase Request</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#f59342', marginTop: 2 }}>{pr.pr_number}</div>
        </div>
      </div>

      {/* Meta box */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14, fontSize: 11 }}>
        <tbody>
          <tr>
            <td style={{ ...cell, width: '20%', fontWeight: 700 }}>Date Requested</td>
            <td style={cell}>{pr.date_requested || '—'}</td>
            <td style={{ ...cell, width: '20%', fontWeight: 700 }}>Deliver To</td>
            <td style={cell}>{pr.target_location?.name || '—'}</td>
          </tr>
          <tr>
            <td style={{ ...cell, fontWeight: 700 }}>Requested By</td>
            <td style={cell}>{pr.created_by_user?.name || '—'}</td>
            <td style={{ ...cell, fontWeight: 700 }}>Status</td>
            <td style={{ ...cell, textTransform: 'uppercase', fontWeight: 700 }}>{pr.status || 'pending'}</td>
          </tr>
          {pr.notes && (
            <tr>
              <td style={{ ...cell, fontWeight: 700 }}>Notes</td>
              <td style={cell} colSpan={3}>{pr.notes}</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Lines table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 14 }}>
        <thead>
          <tr>
            <th style={headerCell}>Vendor</th>
            <th style={{ ...headerCell, textAlign: 'right', width: 50 }}>Qty</th>
            <th style={{ ...headerCell, width: 110 }}>Item #</th>
            <th style={headerCell}>Description</th>
            <th style={{ ...headerCell, width: 110 }}>Project / Reason</th>
            <th style={{ ...headerCell, textAlign: 'right', width: 80 }}>Unit Price</th>
            <th style={{ ...headerCell, textAlign: 'right', width: 90 }}>Line Total</th>
          </tr>
        </thead>
        <tbody>
          {computed.length === 0 && (
            <tr>
              <td style={cell} colSpan={7}>(no lines)</td>
            </tr>
          )}
          {computed.map(({ l, qty, uc, total }, i) => (
            <tr key={l.id || i} style={i % 2 === 1 ? { background: '#fafafa' } : undefined}>
              <td style={cell}>{l.vendor || ''}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{qty}</td>
              <td style={cell}>{l.item_number || l.part_id || ''}</td>
              <td style={cell}>{l.description || ''}</td>
              <td style={cell}>{l.project_reason || ''}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{fmt$(uc)}</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 600 }}>{fmt$(total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <table style={{ width: 300, marginLeft: 'auto', borderCollapse: 'collapse', marginBottom: 18 }}>
        <tbody>
          <tr>
            <td style={{ padding: '4px 8px', textAlign: 'right', fontSize: 11, color: '#666' }}>Subtotal</td>
            <td style={{ padding: '4px 8px', textAlign: 'right', width: 110, fontWeight: 700, borderTop: '1px solid #ccc' }}>{fmt$(subtotal)}</td>
          </tr>
          <tr>
            <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 13, fontWeight: 700 }}>TOTAL</td>
            <td style={{ padding: '6px 8px', textAlign: 'right', fontSize: 14, fontWeight: 800, borderTop: '2px solid #000', color: '#f59342' }}>{fmt$(subtotal)}</td>
          </tr>
        </tbody>
      </table>

      {anyUnknownCost && (
        <div style={{ fontSize: 10, fontStyle: 'italic', color: '#666', marginBottom: 12 }}>
          Note: One or more lines have no unit price; fill in before sending to procurement.
        </div>
      )}

      {pr.po_number && (
        <div style={{ marginBottom: 4, fontSize: 11 }}>
          <strong>Supplier PO #:</strong> {pr.po_number}
        </div>
      )}
      {pr.expected_at && (
        <div style={{ marginBottom: 4, fontSize: 11 }}>
          <strong>Expected arrival:</strong> {pr.expected_at}
        </div>
      )}

      {/* Footer signature */}
      <div style={{ marginTop: 30, borderTop: '1px solid #ccc', paddingTop: 12, fontSize: 10, color: '#666' }}>
        Generated by FiberLog · {new Date().toLocaleString()}
      </div>
    </div>
  )
}

// ─── RECEIVE PANEL ─────────────────────────────────────────────────────────
// Per-line receiving for an ordered/partial PR. Each line can be received in
// full or in part; freeform lines (no catalog SKU) first resolve a part by
// linking an existing one or creating a new one. "Receive all remaining"
// books every outstanding catalog line at once (freeform skipped).
function ReceivePanel({ pr, onReceived, onError }) {
  const { currentUser, showToast } = useApp()
  const [busy, setBusy] = useState(false)
  const lines = pr?.lines || []

  const remainingOf = l => Number(l.quantity || 0) - Number(l.received_qty || 0)
  const catalogRemaining = lines.filter(l => l.part_id && remainingOf(l) > 0)
  const freeformRemaining = lines.filter(l => !l.part_id && remainingOf(l) > 0)
  const allDone = lines.length > 0 && lines.every(l => remainingOf(l) <= 0)

  async function receiveAll() {
    if (catalogRemaining.length === 0) return
    const msg = `Receive all ${catalogRemaining.length} remaining catalog line${catalogRemaining.length === 1 ? '' : 's'} into ${pr?.target_location?.name || 'the target location'}?`
      + (freeformRemaining.length > 0
        ? `\n\n${freeformRemaining.length} freeform line${freeformRemaining.length === 1 ? '' : 's'} will be skipped — link or create a part to receive ${freeformRemaining.length === 1 ? 'it' : 'them'}.`
        : '')
    if (!window.confirm(msg)) return
    setBusy(true)
    onError?.(null)
    try {
      const { linesReceived, skippedFreeform } = await markPurchaseRequestReceived(pr.id, { createdBy: currentUser?.id })
      const fresh = await getPurchaseRequest(pr.id)
      onReceived?.(fresh)
      showToast(skippedFreeform.length > 0
        ? `Received ${linesReceived} line${linesReceived === 1 ? '' : 's'} · ${skippedFreeform.length} freeform skipped`
        : `Received ${linesReceived} line${linesReceived === 1 ? '' : 's'} into ${fresh?.target_location?.name || 'stock'}`)
    } catch (e) {
      onError?.(e.message || 'Receive failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Receive items</div>
        {catalogRemaining.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 12 }}
            onClick={receiveAll}
            disabled={busy}
          >
            <Icon name="box" size={13} /> Receive all remaining
          </button>
        )}
      </div>
      {allDone && (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 0' }}>All lines received.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {lines.map(l => (
          <ReceiveLineRow
            key={l.id}
            line={l}
            pr={pr}
            disabled={busy}
            onReceived={onReceived}
            onError={onError}
          />
        ))}
      </div>
      {freeformRemaining.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 8 }}>
          Freeform lines (no SKU) are received individually — link an existing part or create one.
        </div>
      )}
    </div>
  )
}

// One receivable PR line. Collapsed = progress + a Receive button. Expanded =
// a qty field (defaults to the remaining amount, capped at it) and, for
// freeform lines, a resolve-part step (link existing via catalog search, or
// create a new part inline) before the qty field appears.
function ReceiveLineRow({ line, disabled, onReceived, onError }) {
  const { currentUser, showToast } = useApp()
  const received = Number(line.received_qty || 0)
  const total = Number(line.quantity || 0)
  const remaining = total - received
  const done = remaining <= 0
  const isFreeform = !line.part_id

  const [open, setOpen] = useState(false)
  const [qty, setQty] = useState(String(remaining > 0 ? remaining : ''))
  const [busy, setBusy] = useState(false)

  // Freeform part resolution
  const [resolvedPart, setResolvedPart] = useState(null)   // { id, name }
  const [resolveMode, setResolveMode] = useState('link')   // 'link' | 'create'
  const [search, setSearch] = useState('')
  const [results, setResults] = useState([])
  const searchTimer = useRef(null)
  const [newSku, setNewSku] = useState('')
  const [newName, setNewName] = useState(line.description || '')
  const [newUnit, setNewUnit] = useState('ea')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (resolveMode !== 'link' || !search || search.length < 2) { setResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(async () => {
      try { setResults(await searchPartsCatalog(search, { limit: 10 }) || []) }
      catch (e) { console.warn('part search:', e) }
    }, 200)
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
  }, [search, resolveMode])

  function startReceive() {
    setQty(String(remaining))
    setResolvedPart(null)
    setOpen(true)
  }

  async function createAndUse() {
    if (!newSku.trim() || !newName.trim()) { onError?.('SKU and name are required to create a part'); return }
    setCreating(true)
    onError?.(null)
    try {
      const p = await createPart({
        id: newSku.trim(), name: newName.trim(), unit: newUnit.trim() || 'ea', is_active: true,
        created_via: { source: 'Purchase request', by: currentUser?.name || null },
      })
      setResolvedPart({ id: p?.id || newSku.trim(), name: p?.name || newName.trim() })
    } catch (e) {
      onError?.(e.message || 'Could not create part')
    } finally {
      setCreating(false)
    }
  }

  async function confirmReceive() {
    const q = Number(qty)
    if (!q || q <= 0) { onError?.('Enter a quantity greater than 0'); return }
    if (q - remaining > 1e-9) { onError?.(`Can only receive up to ${remaining} more on this line`); return }
    const partId = isFreeform ? resolvedPart?.id : line.part_id
    if (!partId) { onError?.('Resolve a catalog part first'); return }
    setBusy(true)
    onError?.(null)
    try {
      const fresh = await receivePurchaseRequestLine({ lineId: line.id, partId, quantity: q, createdBy: currentUser?.id })
      onReceived?.(fresh)
      showToast(`Received ${q}${line.part?.unit ? ' ' + line.part.unit : ''} · ${line.description || partId}`)
      setOpen(false)
    } catch (e) {
      onError?.(e.message || 'Receive failed')
    } finally {
      setBusy(false)
    }
  }

  const label = line.description || line.item_number || line.part_id || '(line)'
  const skuLabel = line.part_id || line.item_number

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', padding: '8px 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {label}
            {isFreeform && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: 'var(--amber)', textTransform: 'uppercase' }}>freeform</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--hint)' }}>
            {skuLabel ? `${skuLabel} · ` : ''}{received} / {total} received
          </div>
        </div>
        {done ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
            <Icon name="check" size={14} /> Received
          </span>
        ) : !open ? (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', fontSize: 12 }}
            onClick={startReceive}
            disabled={disabled}
          >
            <Icon name="box" size={13} /> Receive
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '5px 10px', fontSize: 12 }}
            onClick={() => setOpen(false)}
            disabled={busy || creating}
          >
            Cancel
          </button>
        )}
      </div>

      {open && !done && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {isFreeform && !resolvedPart && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                No catalog SKU on this line. Link an existing part or create a new one.
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <button type="button" onClick={() => setResolveMode('link')} style={miniToggle(resolveMode === 'link')}>Link existing</button>
                <button type="button" onClick={() => setResolveMode('create')} style={miniToggle(resolveMode === 'create')}>Create new</button>
              </div>
              {resolveMode === 'link' ? (
                <div>
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="🔍 Search the catalog…"
                    autoComplete="off"
                    name="pr-resolve-search"
                    style={{ width: '100%' }}
                  />
                  {results.length > 0 && (
                    <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginTop: 4 }}>
                      {results.map(p => (
                        <div
                          key={p.id}
                          onClick={() => setResolvedPart({ id: p.id, name: p.name })}
                          style={{ padding: '6px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}
                        >
                          <div style={{ fontWeight: 600 }}>{p.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--hint)' }}>{p.id}{p.category ? ` · ${p.category}` : ''}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 70px auto', gap: 6, alignItems: 'end' }}>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>SKU</label>
                    <input value={newSku} onChange={e => setNewSku(e.target.value)} placeholder="SKU" autoComplete="off" name="pr-new-sku" />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Name</label>
                    <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Part name" autoComplete="off" name="pr-new-name" />
                  </div>
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>Unit</label>
                    <input value={newUnit} onChange={e => setNewUnit(e.target.value)} placeholder="ea" autoComplete="off" name="pr-new-unit" />
                  </div>
                  <button type="button" className="btn btn-ghost" style={{ padding: '7px 12px', fontSize: 12 }} onClick={createAndUse} disabled={creating}>
                    {creating ? 'Creating…' : 'Create'}
                  </button>
                </div>
              )}
            </div>
          )}

          {(!isFreeform || resolvedPart) && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
              {resolvedPart && (
                <div style={{ flex: '1 1 160px', fontSize: 12, color: 'var(--muted)' }}>
                  → <strong style={{ color: 'var(--text)' }}>{resolvedPart.name}</strong> <span style={{ color: 'var(--hint)' }}>({resolvedPart.id})</span>
                  <button type="button" onClick={() => setResolvedPart(null)} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontSize: 11 }}>change</button>
                </div>
              )}
              <div className="field" style={{ marginBottom: 0, width: 120 }}>
                <label>Qty (max {remaining})</label>
                <input
                  type="number" min="0" step="any"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  style={{ textAlign: 'right' }}
                />
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', fontSize: 13 }}
                onClick={confirmReceive}
                disabled={busy}
              >
                <Icon name="check" size={14} /> {busy ? 'Receiving…' : 'Receive'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function miniToggle(active) {
  return {
    padding: '5px 10px', fontSize: 11, fontWeight: 600, borderRadius: 999, cursor: 'pointer',
    background: active ? 'var(--dark-bar)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--dark-bar)' : 'var(--border2)'}`,
  }
}

function lineInputStyle() {
  return {
    width: '100%', padding: '4px 6px', fontSize: 12,
    border: '1px solid var(--border2)', borderRadius: 4,
    background: 'var(--bg)', color: 'var(--text)',
  }
}

function statusPill(status) {
  const colors = {
    pending: { fg: 'var(--amber)', bg: 'var(--amber-lt)', border: 'var(--amber)' },
    ordered: { fg: 'var(--teal-dk)', bg: 'var(--teal-lt)', border: 'var(--teal)' },
    partial: { fg: 'var(--blue)', bg: 'var(--blue-lt)', border: 'var(--blue)' },
    received: { fg: 'var(--muted)', bg: 'var(--gray-lt)', border: 'var(--border)' },
    cancelled: { fg: 'var(--red)', bg: 'var(--red-lt)', border: 'var(--red)' },
  }
  const c = colors[status] || colors.pending
  return {
    padding: '3px 10px', borderRadius: 999,
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    color: c.fg, background: c.bg, border: `1px solid ${c.border}`,
    whiteSpace: 'nowrap',
  }
}
