import { useState, useEffect, useMemo, useRef } from 'react'
import { useApp } from '../../AppContext'
import {
  createPurchaseRequest, getPurchaseRequest,
  updatePurchaseRequest, replacePurchaseRequestLines, deletePurchaseRequest,
  markPurchaseRequestReceived,
  getLastUnitCost, getRecentVendors,
  buildPurchaseRequestCsv, buildPurchaseRequestEmail,
} from '../../lib/inventory'
import { searchPartsCatalog } from '../../lib/supabase'
import { downloadTextAsFile } from '../../lib/csvImport'

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

  async function changeStatus(nextStatus) {
    setSubmitting(true)
    setError(null)
    try {
      if (nextStatus === 'received') {
        // Mark Received also fans out receive movements so the goods
        // actually book into stock. Confirm first because this writes
        // to the inventory ledger.
        const lineCount = (pr?.lines || []).length
        const freeformCount = (pr?.lines || []).filter(l => !l.part_id).length
        const catalogCount = lineCount - freeformCount
        const msg = [
          `Mark ${pr?.pr_number} received?`,
          '',
          `This writes ${catalogCount} receive movement${catalogCount === 1 ? '' : 's'} into ${pr?.target_location?.name || 'the target location'}, increasing stock there.`,
          freeformCount > 0
            ? `\n${freeformCount} freeform line${freeformCount === 1 ? '' : 's'} (no catalog SKU) will be SKIPPED — add the SKU via Parts admin if you need it booked.`
            : '',
        ].filter(Boolean).join('\n')
        if (!window.confirm(msg)) {
          setSubmitting(false)
          return
        }
        const { movementsWritten, skippedFreeformLines } =
          await markPurchaseRequestReceived(prId, { createdBy: currentUser?.id })
        const reloaded = await getPurchaseRequest(prId)
        setPr(reloaded)
        onSaved?.(reloaded)
        if (skippedFreeformLines.length > 0) {
          showToast(`Received ${movementsWritten} line${movementsWritten === 1 ? '' : 's'} · ${skippedFreeformLines.length} freeform skipped`)
        } else {
          showToast(`Received ${movementsWritten} line${movementsWritten === 1 ? '' : 's'} into ${reloaded?.target_location?.name || 'stock'}`)
        }
        return
      }
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
          <div style={{ fontWeight: 800, fontSize: 18 }}>
            📋 Purchase Request
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
                      width: 24, height: 24, padding: 0,
                      background: 'transparent', color: 'var(--muted)',
                      border: '1px solid var(--border)', borderRadius: 4,
                      cursor: 'pointer', fontSize: 14,
                    }}
                  >×</button>
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
                style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
              >
                ＋ Freeform row
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
                  style={{ padding: '8px 14px', fontSize: 13 }}
                  onClick={() => changeStatus('ordered')}
                  disabled={submitting}
                >
                  ✓ Mark ordered
                </button>
              </div>
            )}
            {status === 'ordered' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, fontSize: 12 }}>
                  <div><strong>PO #:</strong> {pr?.po_number || '—'}</div>
                  <div><strong>ETA:</strong> {pr?.expected_at || '—'}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: '8px 14px', fontSize: 13 }}
                  onClick={() => changeStatus('received')}
                  disabled={submitting}
                >
                  📦 Mark received
                </button>
              </div>
            )}
            {(status === 'pending' || status === 'ordered') && (
              <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => changeStatus('cancelled')}
                  disabled={submitting}
                  className="btn btn-ghost"
                  style={{ padding: '6px 10px', fontSize: 11, color: 'var(--red)' }}
                >
                  ⊗ Cancel PR
                </button>
                {isOwner && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={submitting}
                    className="btn btn-ghost"
                    style={{ padding: '6px 10px', fontSize: 11, color: 'var(--red)' }}
                  >
                    🗑 Delete (owner only)
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          {!isLocked && (
            <>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={() => saveAndDo()}
                disabled={submitting || lines.length === 0}
              >
                {submitting ? 'Saving…' : (mode === 'new' ? '💾 Save draft' : '💾 Save changes')}
              </button>
              <button
                className="btn btn-ghost"
                style={{ flex: 1.2 }}
                onClick={() => saveAndDo(exportCsv)}
                disabled={submitting || lines.length === 0}
              >
                ⬇ Save & CSV
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1.4 }}
                onClick={() => saveAndDo(copyEmail)}
                disabled={submitting || lines.length === 0}
              >
                ✉ Save & copy email
              </button>
            </>
          )}
          {isLocked && (
            <>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={async () => {
                  const fresh = await getPurchaseRequest(prId)
                  if (fresh) exportCsv(fresh)
                }}
                disabled={submitting}
              >
                ⬇ Download CSV
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={async () => {
                  const fresh = await getPurchaseRequest(prId)
                  if (fresh) await copyEmail(fresh)
                }}
                disabled={submitting}
              >
                ✉ Copy email
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
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
