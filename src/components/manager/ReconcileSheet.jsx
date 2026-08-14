import { useState, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import { recordMovementsBatch, fetchAllRows, confirmNegativeStock } from '../../lib/inventory'
import { parseCsv, readFileAsText } from '../../lib/csvImport'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Reconcile sheet (backlog #1).
//
// Round-trip with the Audit CSV: manager exports from the Audit tab,
// walks the warehouse/truck with it, fills in the "Actual Qty" column,
// uploads it back here. We compute the variance against CURRENT system
// stock (not the CSV's Expected Qty, which may have drifted since export)
// and propose one movement per row where actual ≠ current.
//
// Each variance can be booked two ways (batch default + per-row override):
//   - `adjust` (the original behavior) — conjure/remove stock one-sided.
//   - `transfer` with a counter-location — the honest booking when you KNOW
//     where the stock really came from / went (e.g. truck counted +48 that
//     was grabbed off the warehouse shelf: transfer warehouse → truck zeroes
//     the truck AND decrements the warehouse, instead of minting 48 from
//     thin air while the warehouse quietly stays overstated).
//
// Sage note (deliberate): transfer-booked variances flow into the Sage
// export exactly like the contemporaneous movement would have (a normal
// warehouse→truck load exports in default mode) — that's the point of the
// honest booking. Adjust-booked variances stay FiberLog-internal
// (isExportableMovement drops all adjusts; Sage runs its own physical
// reconciliation).
//
// Matching rules (mirror what the Audit export writes):
//   - Part: lookup by SKU (case-insensitive) against parts_catalog
//   - Location: by (Location + Bin) columns:
//       Bin set      → bin where parent.name = Location AND bin.name = Bin
//       Bin empty    → first match where loc.name = Location OR
//                     truck's assigned_user.name = Location (the audit
//                     export uses the user's name for trucks).
//
// Rows that can't match a part or location are surfaced as warnings;
// rows with no actual qty entered are skipped. The user can exclude
// individual rows before applying.

export default function ReconcileSheet({ onClose, onApplied }) {
  const { showToast, currentUser } = useApp()
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)
  const [resolved, setResolved] = useState(null)   // null = no file yet, else array
  const [locMeta, setLocMeta] = useState(null)     // { locations, stockByKey } from the resolver
  const [excluded, setExcluded] = useState(() => new Set())
  const [notes, setNotes] = useState({})           // idx → user-edited note
  // Booking mode: batch default + per-row override.
  //   batchMode 'adjust' | 'transfer'; batchCounterId = the shared counter-location.
  //   rowBooking[idx] = 'adjust' | <locationId> — explicit pick; absent = follow batch.
  const [batchMode, setBatchMode] = useState('adjust')
  const [batchCounterId, setBatchCounterId] = useState('')
  const [rowBooking, setRowBooking] = useState({})
  const [showNoChange, setShowNoChange] = useState(false)
  const [search, setSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Back closes the sheet (mounted only when open). Confirm once a CSV has been
  // resolved so the reconcile work isn't lost.
  useBackClose(1, onClose, {
    confirm: () => resolved == null || window.confirm('Discard this reconcile? Unsaved changes will be lost.'),
  })

  async function handleFile(file) {
    if (!file) return
    setError('')
    setLoading(true)
    setFileName(file.name)
    try {
      const text = await readFileAsText(file)
      const { headers, rows } = parseCsv(text)
      if (rows.length === 0) {
        setError('CSV had no data rows')
        setResolved([])
        return
      }
      // Validate the headers look like our Audit export
      const required = ['SKU', 'Location', 'Actual Qty']
      const missing = required.filter(h => !headers.includes(h))
      if (missing.length > 0) {
        setError(`CSV is missing required columns: ${missing.join(', ')}. Did you upload the Audit export?`)
        setResolved([])
        return
      }
      const { rows: enriched, locations, stockByKey } = await resolveAgainstLiveStock(rows)
      setResolved(enriched)
      setLocMeta({ locations, stockByKey })
      setExcluded(new Set())
      setNotes({})
      setRowBooking({})
    } catch (e) {
      console.error('Reconcile parse failed:', e)
      setError(e.message || String(e))
      setResolved([])
    } finally {
      setLoading(false)
    }
  }

  // Counter-location candidates for the transfer booking: warehouses, their
  // bins (labeled "Warehouse / Bin"), groups, trucks. Job-site buckets are
  // accumulate-only ledgers and vendor/scrap aren't reconcile counterparts.
  const counterOptions = useMemo(() => {
    if (!locMeta) return []
    const byId = new Map(locMeta.locations.map(l => [l.id, l]))
    const list = []
    for (const l of locMeta.locations) {
      if (l.type === 'warehouse')   list.push({ id: l.id, label: `${l.name} (unbinned)`,                                  sort: `0·${l.name}·0` })
      else if (l.type === 'bin')    list.push({ id: l.id, label: `${byId.get(l.parent_location_id)?.name || '?'} / ${l.name}`, sort: `0·${byId.get(l.parent_location_id)?.name || '?'}·1·${l.name}` })
      else if (l.type === 'group')  list.push({ id: l.id, label: l.name,                                                  sort: `1·${l.name}` })
      else if (l.type === 'truck')  list.push({ id: l.id, label: l.assigned_user?.name || l.name,                         sort: `2·${l.assigned_user?.name || l.name}` })
    }
    return list.sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }))
  }, [locMeta])
  const counterLabelById = useMemo(
    () => new Map(counterOptions.map(o => [o.id, o.label])),
    [counterOptions]
  )

  // Resolve how a variance row will actually be booked. A transfer needs a
  // counter-location different from the row's own location — otherwise the
  // row silently falls back to adjust (e.g. batch counter = the warehouse
  // while reconciling the warehouse itself).
  function effectiveBookingFor(row) {
    const ov = rowBooking[row.idx]
    const counter = ov === 'adjust' ? null
      : ov ? ov
      : (batchMode === 'transfer' ? batchCounterId : null)
    if (counter && counter !== row.locationId) return { kind: 'transfer', counterId: counter }
    return { kind: 'adjust', counterId: null }
  }

  // ── Summary stats over the resolved set ────────────────────────────────
  const stats = useMemo(() => {
    if (!resolved) return null
    let toAdd = 0, toRemove = 0, addCount = 0, removeCount = 0
    let noChange = 0, noActual = 0, noMatch = 0, badActual = 0
    let adjustCount = 0, transferCount = 0
    // Transfers PULL from their counter-location — tally the demand per
    // (part, counter) so we can warn when it exceeds that location's logged
    // stock (warn-but-allow, same posture as crew over-load).
    const pullDemand = new Map()
    for (const r of resolved) {
      if (excluded.has(r.idx)) continue
      switch (r.status) {
        case 'add':       toAdd    += r.willAdjust;          addCount++;    break
        case 'remove':    toRemove += Math.abs(r.willAdjust); removeCount++; break
        case 'no-change': noChange++; break
        case 'no-actual': noActual++; break
        case 'bad-actual':badActual++; break
        case 'no-match-part':
        case 'no-match-location': noMatch++; break
      }
      if (r.status === 'add' || r.status === 'remove') {
        const b = effectiveBookingFor(r)
        if (b.kind === 'transfer') {
          transferCount++
          if (r.willAdjust > 0) {
            const k = `${r.partId}|${b.counterId}`
            pullDemand.set(k, (pullDemand.get(k) || 0) + r.willAdjust)
          }
        } else {
          adjustCount++
        }
      }
    }
    let overdrawnPulls = 0
    if (locMeta) {
      for (const [k, demand] of pullDemand) {
        if (demand > (locMeta.stockByKey.get(k) || 0)) overdrawnPulls++
      }
    }
    return {
      total: resolved.length,
      toAdd, toRemove, addCount, removeCount,
      noChange, noActual, badActual, noMatch,
      adjustments: addCount + removeCount,
      adjustCount, transferCount, overdrawnPulls,
    }
  }, [resolved, excluded, locMeta, rowBooking, batchMode, batchCounterId])

  const filteredRows = useMemo(() => {
    if (!resolved) return []
    let list = resolved
    if (!showNoChange) list = list.filter(r => r.status !== 'no-change')
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(r =>
        (r.sku || '').toLowerCase().includes(q) ||
        (r.partName || '').toLowerCase().includes(q) ||
        (r.locName || '').toLowerCase().includes(q) ||
        (r.binName || '').toLowerCase().includes(q)
      )
    }
    // Sort: actionable rows first (add/remove), then warnings, then no-change
    const rank = { 'remove': 0, 'add': 1, 'bad-actual': 2, 'no-match-part': 3, 'no-match-location': 3, 'no-actual': 4, 'no-change': 5 }
    return [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
  }, [resolved, excluded, showNoChange, search])

  function toggleExclude(idx) {
    setExcluded(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  async function handleApply() {
    if (!stats || stats.adjustments === 0) return
    setError(''); setSubmitting(true)
    try {
      const movements = []
      const stamp = new Date().toISOString().slice(0, 10)
      for (const r of resolved) {
        if (excluded.has(r.idx)) continue
        if (r.status !== 'add' && r.status !== 'remove') continue
        const userNote = notes[r.idx] ?? r.csvNote
        // Self-documenting note: "counted N, system had M" turns a bare
        // "+48" true-up into something readable in the Activity list.
        const counted = `counted ${r.actualRaw}, system had ${r.currentSystem}`
        const noteText = `Reconcile ${stamp} — ${counted}${userNote ? ` — ${userNote}` : ''}`
        const qty = Math.abs(r.willAdjust)
        const booking = effectiveBookingFor(r)
        if (booking.kind === 'transfer') {
          movements.push({
            movement_type: 'transfer',
            part_id: r.partId,
            quantity: qty,
            unit: r.unit || null,
            // Counted MORE than system → the extra came FROM the counter.
            // Counted LESS → the missing stock went TO the counter.
            from_location_id: r.willAdjust > 0 ? booking.counterId : r.locationId,
            to_location_id:   r.willAdjust > 0 ? r.locationId : booking.counterId,
            notes: noteText,
            created_by: currentUser?.id,
          })
        } else {
          movements.push({
            movement_type: 'adjust',
            part_id: r.partId,
            quantity: qty,
            unit: r.unit || null,
            from_location_id: r.willAdjust < 0 ? r.locationId : null,
            to_location_id:   r.willAdjust > 0 ? r.locationId : null,
            notes: noteText,
            created_by: currentUser?.id,
          })
        }
      }
      if (movements.length === 0) {
        setError('Nothing to apply.')
        return
      }
      // Reconcile writes one-sided negative adjusts — warn if one dips below zero.
      if (!(await confirmNegativeStock(movements))) return
      await recordMovementsBatch(movements)
      const nXfer = movements.filter(m => m.movement_type === 'transfer').length
      showToast(nXfer > 0
        ? `Applied ${movements.length} movements (${nXfer} transfer${nXfer === 1 ? '' : 's'}, ${movements.length - nXfer} adjustment${movements.length - nXfer === 1 ? '' : 's'})`
        : `Applied ${movements.length} adjustments`)
      onApplied(movements.length)
    } catch (e) {
      console.error('Apply reconcile failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // Backdrop tap does NOT dismiss — prevents mid-edit data loss. Cancel button below.
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 920, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <Icon name="refresh" size={18} />
          <span style={{ fontWeight: 800, fontSize: 17 }}>Reconcile inventory</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Upload your filled-in Audit CSV. Each row with an Actual Qty becomes one movement to bring the system in line with what you counted — an <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>adjust</code>, or a <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>transfer</code> when you know where the stock really came from or went.
        </div>

        {/* File picker */}
        <div style={{
          marginBottom: 12, padding: 10,
          background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <label style={{
            display: 'inline-block', padding: '6px 12px',
            background: 'var(--orange)', color: 'white',
            borderRadius: 'var(--r-sm)', cursor: 'pointer',
            fontSize: 13, fontWeight: 700, flexShrink: 0,
          }}>
            {resolved ? 'Choose a different file' : 'Choose Audit CSV'}
            <input
              type="file" accept=".csv,text/csv"
              onChange={e => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
          </label>
          {fileName && (
            <div style={{ fontSize: 12, color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fileName}
            </div>
          )}
        </div>

        {loading && (
          <div style={{ padding: 20, color: 'var(--muted)', textAlign: 'center' }}>Parsing + matching against live stock…</div>
        )}

        {error && (
          <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Summary */}
        {stats && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 10,
          }}>
            <SummaryCell label="To apply" value={stats.adjustments} color="var(--orange)" />
            <SummaryCell label={`Adding (+)`} value={`${stats.addCount} parts · +${stats.toAdd.toLocaleString()}`} color="var(--teal-dk)" />
            <SummaryCell label="Removing (−)" value={`${stats.removeCount} parts · −${stats.toRemove.toLocaleString()}`} color="var(--red)" />
            <SummaryCell label="Warnings" value={stats.noMatch + stats.badActual} color={stats.noMatch + stats.badActual > 0 ? 'var(--amber)' : 'var(--hint)'} />
          </div>
        )}

        {/* Batch booking control: how variances get booked by default.
            Individual rows can override in the "Book as" column. */}
        {resolved && resolved.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            marginBottom: 8, padding: '8px 10px',
            background: 'var(--surface2)', borderRadius: 'var(--r-sm)', fontSize: 12,
          }}>
            <span style={{ fontWeight: 700, color: 'var(--muted)' }}>Book variances as:</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="radio" name="reconcile-batch-mode" checked={batchMode === 'adjust'} onChange={() => setBatchMode('adjust')} />
              Adjust
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="radio" name="reconcile-batch-mode" checked={batchMode === 'transfer'} onChange={() => setBatchMode('transfer')} />
              Transfer with counter-location
            </label>
            {batchMode === 'transfer' && (
              <select
                value={batchCounterId}
                onChange={e => setBatchCounterId(e.target.value)}
                style={{ padding: '4px 8px', fontSize: 12, border: `1px solid ${batchCounterId ? 'var(--border2)' : 'var(--amber)'}`, borderRadius: 6, background: 'var(--bg)', maxWidth: 260 }}
              >
                <option value="">— Pick counter-location —</option>
                {counterOptions.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            )}
            <span style={{ color: 'var(--hint)', fontSize: 11 }}>(rows can override below · transfers reach the Sage export like normal moves; adjusts stay internal)</span>
            {batchMode === 'transfer' && !batchCounterId && (
              <span style={{ color: 'var(--amber)', fontWeight: 700, fontSize: 11 }}>
                No counter-location picked — rows book as Adjust until you pick one
              </span>
            )}
            {stats?.overdrawnPulls > 0 && (
              <span style={{ color: 'var(--amber)', fontWeight: 700, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="alert" size={13} /> {stats.overdrawnPulls} part/location pull{stats.overdrawnPulls === 1 ? '' : 's'} will overdraw the counter-location (it'll go negative)
              </span>
            )}
          </div>
        )}

        {/* Filters + table */}
        {resolved && resolved.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <input
                type="text" value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search SKU, name, or location…"
                style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 6, background: 'var(--bg)' }}
                autoComplete="off" name="reconcile-search"
              />
              <label style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={showNoChange} onChange={e => setShowNoChange(e.target.checked)} />
                Show no-change rows
              </label>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', minHeight: 0, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: 'var(--surface2)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr>
                    <th style={thStyle({ width: 36 })}>
                      <span style={{ display: 'inline-flex', verticalAlign: 'middle' }}><Icon name="check" size={13} /></span>
                    </th>
                    <th style={thStyle({ textAlign: 'left' })}>Part</th>
                    <th style={thStyle({ textAlign: 'left' })}>Location</th>
                    <th style={thStyle({ textAlign: 'right' })}>Counted</th>
                    <th style={thStyle({ textAlign: 'right' })}>System now</th>
                    <th style={thStyle({ textAlign: 'right' })}>Δ to apply</th>
                    <th style={thStyle({ textAlign: 'left' })}>Book as</th>
                    <th style={thStyle({ textAlign: 'left' })}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map(r => (
                    <ReconcileRow
                      key={r.idx}
                      row={r}
                      excluded={excluded.has(r.idx)}
                      onToggle={() => toggleExclude(r.idx)}
                      note={notes[r.idx] ?? r.csvNote}
                      onNoteChange={v => setNotes(prev => ({ ...prev, [r.idx]: v }))}
                      booking={effectiveBookingFor(r)}
                      counterOptions={counterOptions}
                      counterLabelById={counterLabelById}
                      stockByKey={locMeta?.stockByKey}
                      onBookingChange={v => setRowBooking(prev => ({ ...prev, [r.idx]: v }))}
                    />
                  ))}
                  {filteredRows.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: 20, color: 'var(--hint)', textAlign: 'center' }}>No matching rows.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            {resolved ? 'Cancel' : 'Close'}
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleApply}
            disabled={submitting || !stats || stats.adjustments === 0}
          >
            {submitting
              ? 'Applying…'
              : stats && stats.adjustments > 0
                ? (stats.transferCount > 0
                    ? `Apply ${stats.adjustments} (${stats.transferCount} transfer${stats.transferCount === 1 ? '' : 's'} · ${stats.adjustCount} adjustment${stats.adjustCount === 1 ? '' : 's'})`
                    : `Apply ${stats.adjustments} adjustment${stats.adjustments === 1 ? '' : 's'}`)
                : 'No adjustments to apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────

function ReconcileRow({ row, excluded, onToggle, note, onNoteChange, booking, counterOptions, counterLabelById, stockByKey, onBookingChange }) {
  // Kept local on purpose (#36.4): this maps reconcile ROW states, not
  // submission/intake statuses. Shape note for the queues' future shared
  // STATUS_COLORS (backlog #22): `status → { bg, fg }` keyed by status id —
  // if SubmissionsQueue/IntakeRequestsQueue ever extract theirs into a shared
  // module, this map already matches that shape and could adopt it.
  const STATUS_COLORS = {
    add:               { bg: 'var(--teal-lt)',   fg: 'var(--teal-dk)' },
    remove:            { bg: 'var(--red-lt)',    fg: 'var(--red)' },
    'no-change':       { bg: 'transparent',      fg: 'var(--hint)' },
    'no-actual':       { bg: 'transparent',      fg: 'var(--hint)' },
    'bad-actual':      { bg: 'var(--amber-lt)',  fg: 'var(--amber)' },
    'no-match-part':   { bg: 'var(--amber-lt)',  fg: 'var(--amber)' },
    'no-match-location': { bg: 'var(--amber-lt)', fg: 'var(--amber)' },
  }
  const STATUS_LABELS = {
    'no-change':         'no change',
    'no-actual':         'no actual qty entered',
    'bad-actual':        'invalid actual qty',
    'no-match-part':     'SKU not in catalog',
    'no-match-location': 'location not found',
  }
  const c = STATUS_COLORS[row.status] || {}
  const actionable = row.status === 'add' || row.status === 'remove'
  return (
    <tr style={{ background: excluded ? 'var(--gray-lt)' : c.bg, opacity: excluded ? 0.45 : 1 }}>
      <td style={tdStyle({ textAlign: 'center' })}>
        {actionable
          ? <input type="checkbox" checked={!excluded} onChange={onToggle} />
          : null}
      </td>
      <td style={tdStyle()}>
        <div style={{ fontWeight: 600 }}>{row.partName || '—'}</div>
        <div style={{ fontSize: 10, color: 'var(--hint)' }}>{row.sku || '(no SKU)'}</div>
      </td>
      <td style={tdStyle()}>
        <div>{row.locName || '—'}</div>
        {row.binName && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{row.binName}</div>}
      </td>
      <td style={tdStyle({ textAlign: 'right' })}>
        {row.actualRaw === '' || row.actualRaw == null
          ? <span style={{ color: 'var(--hint)' }}>—</span>
          : row.actualRaw}
      </td>
      <td style={tdStyle({ textAlign: 'right' })}>
        {row.currentSystem == null
          ? <span style={{ color: 'var(--hint)' }}>—</span>
          : row.currentSystem.toLocaleString()}
      </td>
      <td style={tdStyle({ textAlign: 'right', fontWeight: 700, color: c.fg })}>
        {actionable
          ? (row.willAdjust > 0 ? `+${row.willAdjust}` : `${row.willAdjust}`)
          : <span style={{ fontWeight: 400, fontSize: 11 }}>{STATUS_LABELS[row.status] || ''}</span>}
      </td>
      <td style={tdStyle()}>
        {actionable && (
          <select
            value={booking.kind === 'transfer' ? booking.counterId : 'adjust'}
            onChange={e => onBookingChange(e.target.value)}
            title={booking.kind === 'transfer'
              ? (row.willAdjust > 0
                  ? `Transfer FROM ${counterLabelById.get(booking.counterId) || '?'} to here`
                  : `Transfer from here TO ${counterLabelById.get(booking.counterId) || '?'}`)
              : 'One-sided adjust movement'}
            style={{ width: '100%', maxWidth: 170, padding: '3px 6px', fontSize: 11, border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--bg)' }}
          >
            <option value="adjust">Adjust</option>
            {/* Part-aware split: locations actually holding THIS part come
                first (with on-hand qty) — for a counted-more row that's where
                the extra plausibly came from; for counted-less, where the
                missing stock most plausibly went back to. Everything else
                stays reachable under "Other locations". */}
            {(() => {
              const candidates = counterOptions.filter(o => o.id !== row.locationId)
              const qtyOf = o => Number(stockByKey?.get(`${row.partId}|${o.id}`) || 0)
              const withStock = candidates.filter(o => qtyOf(o) > 0)
              const others = candidates.filter(o => qtyOf(o) <= 0)
              const dir = row.willAdjust > 0 ? 'Move from' : 'Move to'
              return (
                <>
                  {withStock.length > 0 && (
                    <optgroup label={`${dir} — has this part`}>
                      {withStock
                        .sort((a, b) => qtyOf(b) - qtyOf(a))
                        .map(o => <option key={o.id} value={o.id}>{o.label} · {qtyOf(o).toLocaleString()} on hand</option>)}
                    </optgroup>
                  )}
                  <optgroup label={withStock.length > 0 ? `${dir} — other locations` : `${dir}…`}>
                    {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </optgroup>
                </>
              )
            })()}
          </select>
        )}
      </td>
      <td style={tdStyle()}>
        <input
          type="text" value={note || ''}
          onChange={e => onNoteChange(e.target.value)}
          placeholder="optional note"
          autoComplete="off" name={`reconcile-note-${row.idx}`}
          style={{ width: '100%', padding: '3px 6px', fontSize: 11, border: '1px solid var(--border2)', borderRadius: 4, background: 'var(--bg)' }}
        />
      </td>
    </tr>
  )
}

function SummaryCell({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm)', padding: 8, textAlign: 'center',
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

const thStyle = (extra = {}) => ({
  padding: '6px 8px', fontSize: 11, fontWeight: 700,
  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  ...extra,
})
const tdStyle = (extra = {}) => ({
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  ...extra,
})

// ─── CSV → live-stock resolver ──────────────────────────────────────────

async function resolveAgainstLiveStock(csvRows) {
  // Fetch current stock + all parts + all locations. Stock AND parts page
  // through fetchAllRows — PostgREST silently caps un-paginated reads at
  // 1,000 rows, and inventory_stock is past that (backlog #29). This
  // function feeds ADJUST MOVEMENTS: a truncated stock row would read as
  // "0 on hand" and post an inflated adjustment on the next reconcile.
  const [stockRows, partRows, locsRes] = await Promise.all([
    fetchAllRows(() => db
      .from('inventory_stock')
      .select('part_id, quantity, location_id')
      .order('part_id').order('location_id')),
    fetchAllRows(() => db
      .from('parts_catalog')
      .select('id, name, unit, is_active')
      .order('id')),
    db.from('inventory_locations')
      .select('id, name, type, parent_location_id, assigned_user:users!inventory_locations_assigned_to_fkey(id, name)')
      .eq('is_active', true),
  ])
  if (locsRes.error)  throw locsRes.error

  // (part_id, location_id) → quantity
  const stockMap = new Map()
  for (const s of stockRows) {
    stockMap.set(`${s.part_id}|${s.location_id}`, Number(s.quantity) || 0)
  }

  // SKU upper → part
  const partBySku = new Map()
  for (const p of partRows) {
    partBySku.set(String(p.id).toUpperCase(), p)
  }

  // Location lookups: bins keyed by "<warehouse_name>::<bin_name>",
  // non-bins keyed by their display name (truck = assigned_user.name,
  // others = location.name) AND also by raw location.name as a fallback
  // for cases where the audit export wrote the raw name.
  const locByName = new Map()
  const binByPath = new Map()
  const locsById  = new Map((locsRes.data || []).map(l => [l.id, l]))
  for (const l of locsRes.data || []) {
    if (l.type === 'bin') {
      const parent = locsById.get(l.parent_location_id)
      const key = `${parent?.name || ''}::${l.name}`.toUpperCase()
      binByPath.set(key, l)
    } else {
      const displayName = (l.type === 'truck' && l.assigned_user?.name)
        ? l.assigned_user.name
        : l.name
      const dk = String(displayName).toUpperCase()
      const rk = String(l.name).toUpperCase()
      if (!locByName.has(dk)) locByName.set(dk, l)
      if (!locByName.has(rk)) locByName.set(rk, l)
    }
  }

  const mapped = csvRows.map((row, idx) => {
    const sku     = (row['SKU'] || '').trim()
    const locName = (row['Location'] || '').trim()
    const binName = (row['Bin'] || '').trim()
    const actualRaw = String(row['Actual Qty'] ?? '').trim()
    const csvNote = (row['Notes'] || '').trim()
    const csvExpected = Number(row['Expected Qty']) || 0

    const part = partBySku.get(sku.toUpperCase()) || null
    let location = null
    if (binName) {
      location = binByPath.get(`${locName}::${binName}`.toUpperCase()) || null
    } else {
      location = locByName.get(locName.toUpperCase()) || null
    }

    let status = 'no-change'
    let willAdjust = 0
    let currentSystem = null

    if (!part) {
      status = 'no-match-part'
    } else if (!location) {
      status = 'no-match-location'
    } else {
      currentSystem = stockMap.get(`${part.id}|${location.id}`) || 0
      if (actualRaw === '') {
        status = 'no-actual'
      } else {
        const actualNum = Number(actualRaw)
        if (!Number.isFinite(actualNum)) {
          status = 'bad-actual'
        } else {
          willAdjust = actualNum - currentSystem
          if (willAdjust === 0) status = 'no-change'
          else if (willAdjust > 0) status = 'add'
          else status = 'remove'
        }
      }
    }

    return {
      idx,
      sku, locName, binName,
      partId: part?.id || null,
      partName: part?.name || row['Name'] || '',
      unit: part?.unit || row['Unit'] || 'ea',
      locationId: location?.id || null,
      csvExpected,
      currentSystem,
      actualRaw,
      willAdjust,
      status,
      csvNote,
    }
  })

  // Rows + the lookup data the sheet needs for transfer bookings: the
  // active-location list feeds the counter-location pickers, and the stock
  // map powers the "this will overdraw the counter-location" warning.
  return { rows: mapped, locations: locsRes.data || [], stockByKey: stockMap }
}
