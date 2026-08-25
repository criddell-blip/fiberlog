import { useState, useEffect, useRef } from 'react'
import {
  recordMovementsBatch, getBinsForWarehouse,
  createPart, updatePart, getPurchaseRequests,
  getRefurbTwin, createRefurbTwin,
  getDefaultReceivingLocation, RECEIVING_BIN_NAME, RETURNS_BIN_NAME,
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
//
// Receipt type (Aug 2026): the same sheet also books FIELD RETURNS — used
// units pulled from a customer/site. Those are `receive` rows too, but with
// receipt_kind='field_return' so Activity / reports / Sage can separate them
// from purchases, and each line is booked onto the part's REFURBISHED TWIN
// (`<sku>-R`, Sage `UB…_R`) so a used unit never re-enters stock as new.
// In that mode there is no PO, no vendor and no unit cost; the destination
// defaults to the "Returns – to test" quarantine bin. Purchases default to
// the Receiving dock (both bin names live in lib/inventory.js).

const TYPE_ICON = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  scrap:     '🗑️',
  bin:       '📥',
}

let nextLineId = 1
const newLine = () => ({ tempId: nextLineId++, part: null, quantity: '', unit_cost: '' })

export default function ReceivePOSheet({ locations, currentUser, onClose, onRecorded, onOpenPr, onCreatePo }) {
  // 'purchase' (PO / vendor delivery — the original sheet) | 'field_return'
  const [receiptKind, setReceiptKind] = useState('purchase')
  const isReturn = receiptKind === 'field_return'
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
  // Open POs (ordered/partial PRs) the delivery might belong to. Tapping one
  // hands off to the PR detail sheet's receive panel via onOpenPr — its lines
  // are already typed in, so nothing gets re-keyed at the dock. Fail-soft:
  // load errors just hide the section and leave the manual flow.
  const [openPos, setOpenPos] = useState([])

  useEffect(() => {
    if (!onOpenPr) return
    let cancelled = false
    getPurchaseRequests({ statuses: ['ordered', 'partial'], limit: 50 })
      .then(rows => { if (!cancelled) setOpenPos(rows || []) })
      .catch(() => { if (!cancelled) setOpenPos([]) })
    return () => { cancelled = true }
  }, [onOpenPr])

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
      .then(b => {
        if (cancelled) return
        setBins(b)
        // Default bin by receipt type (manager can still override):
        //   field return → the returns quarantine bin
        //   purchase     → the Receiving dock
        const wantName = receiptKind === 'field_return' ? RETURNS_BIN_NAME : RECEIVING_BIN_NAME
        const rb = (b || []).find(x => x.name === wantName)
        if (rb) setToBinId(rb.id)
      })
      .catch(() => { if (!cancelled) setBins([]) })
    return () => { cancelled = true }
  }, [toTopId, locations, receiptKind])

  // Purchase mode opens with the Receiving dock's warehouse pre-picked (the
  // bins effect above then lands on the dock). Once only, on mount — never
  // fights a later manual pick or clear.
  useEffect(() => {
    let cancelled = false
    getDefaultReceivingLocation().then(d => {
      if (cancelled || !d) return
      setToTopId(prev => prev || d.warehouseId)
    })
    return () => { cancelled = true }
  }, [])

  // Switching to field-return mode pre-picks a warehouse so the bins effect
  // above can land on the returns bin. `locations` excludes bins (the parent
  // loads getLocations() without includeBins), so the bin itself is found
  // there, not here — this only has to choose the warehouse.
  useEffect(() => {
    if (receiptKind !== 'field_return' || toTopId) return
    const wh = locations.find(l => l.type === 'warehouse' && l.is_active !== false)
    if (wh) setToTopId(wh.id)
  }, [receiptKind, toTopId, locations])

  // Changing the receipt type invalidates every picked line: the twin swap
  // happens at pick time, so lines keyed under Purchase would go out as
  // field returns on the PARENT part — the exact "used unit re-enters stock
  // as new" this mode exists to prevent. Clear them (confirm if any exist).
  function switchReceiptKind(k) {
    if (k === receiptKind) return
    const hasLines = lines.some(l => l.part || String(l.quantity).trim())
    if (hasLines && !window.confirm('Switching receipt type clears the line items (they must be re-picked so returns land on the refurbished part). Continue?')) return
    setLines([newLine()])
    setPoRef('')
    setVendorName('')
    setError('')
    setReceiptKind(k)
  }

  function updateLine(tempId, patch) {
    setLines(prev => prev.map(l => l.tempId === tempId ? { ...l, ...patch } : l))
  }
  function addLine()    { setLines(prev => [...prev, newLine()]) }
  function removeLine(tempId) { setLines(prev => prev.filter(l => l.tempId !== tempId)) }

  const validLines = lines.filter(l => l.part && Number(l.quantity) > 0)
  const dest = toBinId || toTopId
  // A PO ref is required for purchases (it's the AP tie-back); a field
  // return has no PO — the ref field becomes an optional ticket/RMA number.
  const canSubmit = (isReturn || poRef.trim()) && dest && validLines.length > 0 && !submitting

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
            sage_id: l.part.sage_id,
            is_depreciated: l.part.is_depreciated || false,
            is_active: true,
            created_via: {
              source: 'Receive PO',
              detail: vendorName.trim() ? `vendor ${vendorName.trim()}` : null,
              by: currentUser?.name || null,
            },
          })
        } catch (e) {
          // Duplicate SKU on a NEW line = this part was already created —
          // either by a prior failed submit's retry (backlog #49a: the old
          // hard-abort left the manager stuck re-picking every NEW part) or
          // by the manager typing an existing SKU. Either way the part
          // exists, which is all the movement insert needs — continue.
          // …EXCEPT a sage_id unique violation (same 23505 code, index name
          // parts_catalog_sage_id_idx in the message): then the part was NOT
          // created and the movement insert would die on an opaque FK error.
          const msg = e?.message || ''
          if (/sage_id/.test(msg)) {
            throw new Error(`Couldn't create part "${l.part.id}": Sage ID ${l.part.sage_id} is already on another part`)
          }
          const isDup = e?.code === '23505' || /duplicate key|already exists/i.test(msg)
          if (!isDup) throw new Error(`Couldn't create part "${l.part.id}": ${msg || e}`)
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
      // "Vendor: X" vs "Returned from: X" — resolveReceiveMeta keys on the
      // prefix, and a customer name must never be parsed as a vendor.
      const noteFromVendor = vendorName.trim()
        ? (isReturn ? `Returned from: ${vendorName.trim()}` : `Vendor: ${vendorName.trim()}`)
        : null
      const movements = validLines.map(l => ({
        movement_type: 'receive',
        receipt_kind: receiptKind,
        part_id: l.part.id,
        quantity: Number(l.quantity),
        // An attrs-edit changes the catalog unit above — the movement row
        // must record the same unit, not the pre-edit one (#49b).
        unit: l.pendingAttrs?.unit || l.part.unit || null,
        from_location_id: null,
        to_location_id: dest,
        vendor_invoice: poRef.trim() || null,
        // A returned unit's value is Sage's business (the _R item); no line cost.
        unit_cost: isReturn || l.unit_cost === '' ? null : Number(l.unit_cost),
        notes: noteFromVendor,
        created_by: currentUser?.id,
      }))
      await recordMovementsBatch(movements)
      // Stash the received parts for the post-save label prompt. Parent
      // gets notified now (toast + refresh) but the sheet stays open
      // showing the print-labels offer instead of closing.
      setJustReceived(validLines.map(l => ({
        id: l.part.id, name: l.part.name, unit: l.part.unit,
        refurb_of: l.part.refurb_of || null, sage_id: l.part.sage_id || null,
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
                onClick={() => setShowLabelSheet(true)}
                style={{ flex: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
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
          <Icon name={isReturn ? 'rotate' : 'download'} size={18} />
          <span style={{ fontWeight: 800, fontSize: 17 }}>{isReturn ? 'Receive returned equipment' : 'Receive PO / vendor delivery'}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
          {isReturn
            ? <>Used units pulled from a customer or site. Each line is booked onto the part's <strong>refurbished twin</strong> (Sage <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>UB…_R</code>) as a <em>field return</em> — kept separate from purchases everywhere.</>
            : <>Each line becomes its own <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>receive</code> movement, all sharing the PO ref and destination.</>}
        </div>

        {/* Receipt type. Same table, different receipt_kind — the owner's
            requirement is that a returned unit can never be mistaken for a
            new-purchase receipt in any report. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {[['purchase', 'download', 'Purchase order'], ['field_return', 'rotate', 'Returned from field']].map(([k, icon, label]) => {
            const on = receiptKind === k
            const accent = k === 'field_return' ? 'var(--amber)' : 'var(--dark-bar)'
            return (
              <button
                key={k}
                onClick={() => switchReceiptKind(k)}
                disabled={submitting}
                style={{
                  flex: 1, height: 34, borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  background: on ? accent : 'var(--surface)',
                  color: on ? '#fff' : 'var(--muted)',
                  border: `1px solid ${on ? accent : 'var(--border2)'}`,
                }}
              ><Icon name={icon} size={13} /> {label}</button>
            )
          })}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

          {/* Open POs — receiving against one reuses its typed-in lines via
              the PR sheet's receive panel instead of re-keying them here.
              This section is the PO front door: it also carries the
              "Create a PO" affordance so a delivery you're EXPECTING gets
              typed in ahead of time instead of re-keyed at the dock.
              Irrelevant to a field return — there is no PO. */}
          {!isReturn && (openPos.length > 0 || onCreatePo) && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, marginBottom: 6,
              }}>
                <span style={{
                  fontSize: 12, fontWeight: 700, color: 'var(--muted)',
                  textTransform: 'uppercase', letterSpacing: '.04em',
                }}>
                  Receiving against a PO?
                </span>
                {onCreatePo && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onCreatePo}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', fontSize: 12 }}
                  >
                    <Icon name="plus" size={13} /> Create a PO
                  </button>
                )}
              </div>
              {openPos.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--hint)', marginBottom: 4 }}>
                  No open POs. If this delivery was ordered in Sage, create the PO first so
                  its lines are typed in once and received against — now or when it arrives.
                </div>
              )}
              {openPos.length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                {openPos.slice(0, 5).map((pr, i) => (
                  <div
                    key={pr.id}
                    onClick={() => onOpenPr(pr.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                      borderBottom: i < Math.min(openPos.length, 5) - 1 ? '1px solid var(--row-divider)' : 'none',
                      background: 'var(--surface)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-dk)' }}>
                        {pr.po_number ? `PO ${pr.po_number}` : pr.pr_number}
                      </span>
                      {pr.vendors.length > 0 && (
                        <span style={{ marginLeft: 8, color: 'var(--muted)' }}>{pr.vendors.slice(0, 2).join(' · ')}</span>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                        {pr.outstandingLines} line{pr.outstandingLines === 1 ? '' : 's'} outstanding · ETA {pr.expected_at || '—'}
                      </div>
                    </div>
                    <span style={{
                      padding: '2px 9px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      textTransform: 'uppercase', whiteSpace: 'nowrap',
                      color: pr.status === 'partial' ? 'var(--blue)' : 'var(--accent-dk)',
                      background: pr.status === 'partial' ? 'var(--blue-lt)' : 'var(--accent-lt)',
                      border: `1px solid ${pr.status === 'partial' ? 'var(--blue)' : 'var(--accent)'}`,
                    }}>{pr.status}</span>
                    <Icon name="chevron-right" size={15} />
                  </div>
                ))}
              </div>
              )}
              {openPos.length > 5 && (
                <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                  …and {openPos.length - 5} more — see the Purchase Reqs tab.
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 8, textTransform: 'uppercase', fontWeight: 700, letterSpacing: '.04em' }}>
                — or record a manual delivery (no PO in FiberLog) —
              </div>
            </div>
          )}

          {/* PO ref + Vendor (optional free text) */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{isReturn ? 'Ticket / RMA ref (optional)' : 'PO / invoice ref *'}</label>
              <input
                type="text" value={poRef}
                onChange={e => setPoRef(e.target.value)}
                placeholder={isReturn ? 'e.g. Sonar ticket 48213' : 'e.g. PO-12345'}
                autoFocus
                autoComplete="off" name="po-ref"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{isReturn ? 'Returned from (customer / site / tech)' : 'Vendor (optional)'}</label>
              <input
                type="text" value={vendorName}
                onChange={e => setVendorName(e.target.value)}
                placeholder={isReturn ? 'e.g. 123 Main St, Heber — J. Smith' : 'e.g. Acme Supply Co'}
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
              {/* Receivable destinations only (#51): job_site buckets are the
                  consumption ledger and scrap is terminal — receiving new
                  stock into either is almost certainly a mis-tap. Bins are
                  reached via the bin dropdown after picking a warehouse. */}
              {locations
                .filter(l => ['warehouse', 'truck', 'group'].includes(l.type) && l.is_active !== false)
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
              isReturn={isReturn}
              currentUser={currentUser}
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

          {!isReturn && total > 0 && (
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

function ReceiveLineRow({ line, onChange, onRemove, isReturn = false, currentUser = null }) {
  const [query, setQuery] = useState('')
  const [twinBusy, setTwinBusy] = useState(false)
  const pickSeq = useRef(0)   // guards the async twin lookup against a faster second pick
  const [twinError, setTwinError] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef(null)

  const [mode, setMode] = useState('idle')   // 'idle' | 'creating' | 'editing'
  const [fSku, setFSku]       = useState('')
  const [fName, setFName]     = useState('')
  const [fUnit, setFUnit]     = useState('ea')
  const [fDept, setFDept]     = useState('')
  const [fMatGrp, setFMatGrp] = useState('')
  const [fSageId, setFSageId] = useState('')   // create-only: Sage Intacct item, if accounting already minted one
  const [fDepreciated, setFDepreciated] = useState(false)  // create-only: no-value flag (backlog #37)

  // Search active only when no part picked AND we're not in a form mode
  useEffect(() => {
    if (line.part || mode !== 'idle') { setResults([]); return }
    if (!query || query.length < 2) { setResults([]); return }
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearching(true)
    searchTimer.current = setTimeout(async () => {
      try {
        // Full attrs so a field return can mint the refurb twin from the
        // picked parent without a second round-trip.
        const data = await searchPartsCatalog(query, { limit: 8, cols: 'id, name, nickname, unit, department, material_group, sage_id, refurb_of, is_depreciated, is_active' })
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

  const asLinePart = p => ({
    id: p.id, name: p.name, unit: p.unit, isNew: false,
    department: p.department, material_group: p.material_group,
    sage_id: p.sage_id || null, refurb_of: p.refurb_of || null,
    is_depreciated: !!p.is_depreciated,  // no-value flag drives the unit-cost hint (backlog #37)
  })

  async function pickPart(p) {
    setQuery('')
    setResults([])
    setTwinError('')
    if (!isReturn || p.refurb_of) {
      // Purchase, or the manager picked the twin directly.
      onChange({ part: asLinePart(p), pendingAttrs: null })
      return
    }
    // Field return: book onto the refurbished twin. Put the parent on the
    // line immediately (flagged "resolving") so the row never looks empty,
    // then upgrade to the twin when the lookup lands — unless a later pick
    // superseded this one (seq guard), in which case the stale result is
    // dropped instead of overwriting the newer choice.
    const seq = ++pickSeq.current
    onChange({ part: { ...asLinePart(p), resolvingTwin: true, parentFull: p }, pendingAttrs: null })
    let twin = null
    try { twin = await getRefurbTwin(p.id) } catch { /* fall through to the no-twin path */ }
    if (seq !== pickSeq.current) return
    if (twin) {
      onChange({ part: { ...asLinePart(twin), swappedFrom: { id: p.id, name: p.name } }, pendingAttrs: null })
    } else {
      onChange({ part: { ...asLinePart(p), noTwin: true, parentFull: p }, pendingAttrs: null })
    }
  }

  async function mintTwin() {
    const parent = line.part?.parentFull
    if (!parent) return
    setTwinBusy(true)
    setTwinError('')
    try {
      const twin = await createRefurbTwin(parent, {
        created_via: { source: 'Receive PO (field return)', by: currentUser?.name || null },
      })
      onChange({ part: { ...asLinePart(twin), swappedFrom: { id: parent.id, name: parent.name } }, pendingAttrs: null })
    } catch (e) {
      setTwinError(e?.message || String(e))
    } finally {
      setTwinBusy(false)
    }
  }

  function startCreate() {
    setFSku('')
    setFName(query)        // pre-fill name from search query
    setFUnit('ea')
    setFDept('')
    setFMatGrp('')
    setFSageId('')
    setFDepreciated(false)
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
        sage_id: fSageId.trim().toUpperCase() || null,
        is_depreciated: fDepreciated,
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
        {isCreate && (
          <input
            type="text" value={fSageId}
            onChange={e => setFSageId(e.target.value)}
            placeholder="Sage ID (optional, e.g. UB000011)"
            autoComplete="off" name={`po-form-sage-${line.tempId}`}
            style={{ ...inputStyle(), marginBottom: 8, fontFamily: 'monospace' }}
          />
        )}
        {isCreate && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--muted)', marginBottom: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={fDepreciated}
              onChange={e => setFDepreciated(e.target.checked)}
              style={{ margin: 0 }}
            />
            Depreciated (no value) — used/recovered gear; Sage export marks its lines [no-value]
          </label>
        )}

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
                {line.part.refurb_of && (
                  <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 6, background: 'var(--amber)', color: 'white' }}>REFURB</span>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                {line.part.id}
                {line.part.sage_id && <span> · Sage {line.part.sage_id}</span>}
                {line.part.is_depreciated && <span style={{ color: 'var(--amber)', fontWeight: 700 }}> · no-value</span>}
                {line.part.swappedFrom && <span> · picked as {line.part.swappedFrom.name}</span>}
              </div>
              {/* Warn-not-block (#37): pricing a no-value part is usually a
                  mistake — its Sage lines carry [no-value] and accounting
                  won't book the cost. A deliberate cost still goes through. */}
              {line.part.is_depreciated && String(line.unit_cost).trim() !== '' && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Icon name="alert" size={11} /> Depreciated (no-value) part with a unit cost — Sage lines will still say [no-value].
                </div>
              )}
              {/* Field return onto a part with no refurbished twin: the
                  honest booking is the _R item, so offer to mint it here
                  rather than silently receiving a used unit as new. */}
              {isReturn && line.part.resolvingTwin && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--hint)' }}>Looking up refurbished twin…</div>
              )}
              {isReturn && line.part.noTwin && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Icon name="alert" size={11} /> No refurbished twin — will receive as the original part.
                  <button
                    onClick={mintTwin} disabled={twinBusy}
                    style={{ fontSize: 10, color: 'var(--amber)', background: 'none', border: '1px solid var(--amber)', borderRadius: 6, padding: '1px 7px', cursor: 'pointer', fontWeight: 700 }}
                  >{twinBusy ? 'Creating…' : `Create ${line.part.id}-R`}</button>
                  {twinError && <span style={{ color: 'var(--red)' }}>{twinError}</span>}
                </div>
              )}
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
                    when we have a query, even if there are partial matches.
                    Not for field returns: returned gear is by definition an
                    existing catalog part, and a part minted here would have
                    no refurb twin to land on. */}
                {isReturn ? (
                  results.length === 0 && (
                    <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--hint)' }}>
                      No match. Returned equipment must already be a catalog part — receive it as a purchase first if it's genuinely new.
                    </div>
                  )
                ) : (
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
                )}
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

      {/* Unit cost (optional) — not for field returns; a returned unit's
          value lives on Sage's _R item, not on this line. */}
      {!isReturn && (
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
      )}

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
