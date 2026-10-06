import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../AppContext'
import {
  getCountRunDetail,
  approveCountResolution,
  discardCountResolution,
  discardCountRun,
  resolveCountResolution,
  recountCountLocation,
  getStockQtyAt,
  previewResolution,
} from '../../lib/cycleCount'
import { getLocations } from '../../lib/inventory'
import { splitStatus } from '../../lib/varianceSplit'
import VarianceSplitPanel from '../shared/VarianceSplitPanel'
import { fmtWhen } from '../../lib/format'
import { fmtSigned } from '../../lib/adjustmentsSummary'
import { useBackClose } from '../../lib/backStack'
import { escapeCsvField, downloadTextAsFile } from '../../lib/csvImport'
import Icon from '../shared/Icon'

// Places stock can physically move to/from when a variance is booked as a
// transfer — mirrors count_counter_location_ok() in the DB.
const COUNTER_LOCATION_TYPES = ['warehouse', 'bin', 'truck', 'group']

// Overlay sheet that opens when a manager taps a pending count run in the
// CountTab queue. Lets them review per-line variances and either approve
// (writes the adjust movement) or discard (no movement, just marks resolved).
// Auto-reconciled internal transfers are shown for audit but require no
// action — they were already committed by end_count_run_and_reconcile.
//
// When the last pending resolution is resolved, the server-side RPC flips
// the run's status to 'closed'. We refetch detail after each action and
// auto-close the sheet once nothing is pending.
//
// Oct 2026: approve-or-discard wasn't enough during the warehouse + truck
// count — a miscount became an adjust, then a second adjust when someone
// noticed. Each variance now has "Recount / move…": go look, enter what's
// really there (compared against the books NOW, so a match posts nothing),
// and/or book the difference as a transfer from/to where the stock really is.
// The panel shows the part's other locations and recent adjustments so a −40
// here can be matched to last week's +40 on the next shelf. Auto-reconciled
// transfers and already-approved lines get a plain "Recount" for the same
// reason (recount_count_location). Works on closed runs too, from history.
export default function CountRunReviewSheet({ runId, onClose, onChanged }) {
  const { showToast } = useApp()
  const [detail, setDetail] = useState(null)
  const [counterLocations, setCounterLocations] = useState([])
  const [fixingId, setFixingId] = useState(null)       // resolution id with the Recount/move panel open
  const [recountKey, setRecountKey] = useState(null)   // `${partId}|${locationId}` with the plain recount open

  // Mounted only while open. Veto (which re-arms the history entry) rather
  // than silently ignoring Back: never close under an in-flight RPC, and ask
  // before throwing away a half-typed recount.
  useBackClose(1, onClose, {
    confirm: () => !busy && ((fixingId == null && recountKey == null) || window.confirm('Discard this recount?')),
  })

  useEffect(() => {
    getLocations({ includeBins: true })
      .then(locs => setCounterLocations(locs.filter(l => COUNTER_LOCATION_TYPES.includes(l.type))))
      .catch(e => console.warn('Counter locations load failed:', e))
  }, [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showAutoTransfers, setShowAutoTransfers] = useState(false)
  const [discardConfirm, setDiscardConfirm] = useState(null)
  // { resolution: {...}, reason: '' } when discarding a single resolution
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [runDiscardConfirm, setRunDiscardConfirm] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const d = await getCountRunDetail(runId)
      setDetail(d)
    } catch (e) {
      console.error('Run detail load failed:', e)
      setError(e.message || 'Could not load run')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [runId])

  async function handleApprove(resolution) {
    setBusy(true)
    try {
      await approveCountResolution({ resolutionId: resolution.id, note: null })
      await load()
      onChanged?.()
    } catch (e) {
      console.error('Approve failed:', e)
      showToast(e.message || 'Approve failed')
    } finally {
      setBusy(false)
    }
  }

  // Both return true on success. On failure the panel stays open and refetches
  // the books — the common failure is "Books changed since you opened this",
  // raised when stock at the bin moved between the preview and the click.
  async function handleResolve(resolution, { countedNow, splits, note, expectedSystem }) {
    setBusy(true)
    try {
      const res = await resolveCountResolution({ resolutionId: resolution.id, countedNow, splits, note, expectedSystem })
      showToast(res.status === 'discarded' ? 'Recount matches the books — no adjustment' : 'Variance settled')
      setFixingId(null)
      await load()
      onChanged?.()
      return true
    } catch (e) {
      console.error('Resolve failed:', e)
      showToast(e.message || 'Could not settle the variance')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleRecount({ partId, locationId, countedNow, note, expectedSystem }) {
    setBusy(true)
    try {
      const res = await recountCountLocation({ runId, partId, locationId, countedNow, note, expectedSystem })
      const diff = Number(res?.diff || 0)
      showToast(diff === 0 ? 'Matches the books — nothing posted' : `Posted ${fmtSigned(diff)} adjustment`)
      setRecountKey(null)
      await load()
      onChanged?.()
      return true
    } catch (e) {
      console.error('Recount failed:', e)
      showToast(e.message || 'Recount failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleDiscardOne() {
    const { resolution, reason } = discardConfirm
    if (!reason.trim()) return
    setBusy(true)
    setDiscardConfirm(null)
    try {
      await discardCountResolution({ resolutionId: resolution.id, reason: reason.trim() })
      await load()
      onChanged?.()
    } catch (e) {
      console.error('Discard failed:', e)
      showToast(e.message || 'Discard failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleBulkApprove() {
    setBulkConfirm(false)
    if (!detail) return
    const pending = detail.resolutions.filter(r => r.status === 'pending')
    if (pending.length === 0) return
    setBusy(true)
    try {
      // Approve sequentially. Could parallelize but sequential keeps the
      // run-close check deterministic and the toast feedback ordered.
      for (const r of pending) {
        await approveCountResolution({ resolutionId: r.id, note: null })
      }
      showToast(`Approved ${pending.length} variance${pending.length === 1 ? '' : 's'}`)
      onChanged?.()
      onClose()  // run is now closed
    } catch (e) {
      console.error('Bulk approve failed:', e)
      showToast(e.message || 'Bulk approve partially failed — refresh to check')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function handleRunDiscard() {
    setRunDiscardConfirm(false)
    setBusy(true)
    try {
      await discardCountRun({ runId, reason: 'Discarded by reviewer' })
      showToast('Run discarded')
      onChanged?.()
      onClose()
    } catch (e) {
      console.error('Run discard failed:', e)
      showToast(e.message || 'Discard failed')
      setBusy(false)
    }
  }

  // "What went missing" export — every net_loss resolution for this run
  // (stock that was expected somewhere in scope and not found anywhere). This
  // is the count's shrinkage/missing record the owner wanted to pull.
  //
  // A review recount can shrink, cancel or even flip a variance, so "Qty
  // short" is what was actually POSTED (settledNet), with the original count
  // and the recount beside it. A gain that a recount turned into a loss is
  // included too — it went missing just the same.
  function downloadMissing(missing, run) {
    const header = ['SKU', 'Part', 'Bin', 'Counted variance', 'Recounted', 'Books at recount', 'Qty short (posted)', 'Status', 'Reviewed at', 'Notes']
    const rows = missing.map(r => {
      const net = settledNet(r)
      return [
        r.part_id, r.part?.name || '', resolutionLocation(r)?.name || '',
        (r.resolution_type === 'net_gain' ? 1 : -1) * Number(r.quantity),
        r.recount_qty ?? '', r.recount_system_qty ?? '',
        r.status === 'pending' ? Number(r.quantity) : Math.max(0, -net),
        r.status,
        r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : '',
        r.manager_notes || '',
      ]
    })
    const csv = [header, ...rows].map(row => row.map(escapeCsvField).join(',')).join('\r\n')
    const stamp = run.completed_at || run.started_at
    downloadTextAsFile(
      `count-missing-${(run.scope_warehouse?.name || 'all').replace(/\s+/g, '-')}-${stamp ? new Date(stamp).toISOString().slice(0, 10) : 'run'}.csv`,
      csv,
    )
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 640 }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
            Loading run…
          </div>
        )}

        {error && (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <div className="banner banner-danger" style={{
              borderRadius: 'var(--r-sm)', borderBottom: 'none',
              border: '1px solid var(--danger-border)',
            }}>
              <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name="alert" size={16} /></span>
              <div className="banner-body">{error}</div>
            </div>
            <button className="btn btn-ghost" onClick={onClose} style={{ marginTop: 16 }}>Close</button>
          </div>
        )}

        {!loading && !error && detail && (() => {
          const { run, sessions, resolutions, recounts = [] } = detail
          const pending = resolutions.filter(r => r.status === 'pending')
          const transfers = resolutions.filter(r => r.resolution_type === 'internal_transfer')
          const approved = resolutions.filter(r => r.status === 'approved')
          const discarded = resolutions.filter(r => r.status === 'discarded')
          const missing = resolutions.filter(r => r.resolution_type === 'net_loss'
            || (r.recount_qty != null && settledNet(r) < 0))
          const submittedBins = sessions.filter(s => s.status === 'submitted').length

          return (
            <>
              {/* Header */}
              <div style={{ marginBottom: 14, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
                    Cycle count review
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                    {run.counter?.name || 'Unknown counter'} · {fmtWhen(run.started_at)}
                    {run.scope_warehouse?.name && <> · {run.scope_warehouse.name}</>}
                  </div>
                </div>
                {missing.length > 0 && (
                  <button
                    onClick={() => downloadMissing(missing, run)}
                    className="btn btn-ghost"
                    title="Download what went missing on this count (CSV)"
                    style={{ flexShrink: 0, padding: '8px 12px', fontSize: 'var(--fs-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Icon name="download" size={14} /> Missing report
                  </button>
                )}
              </div>
              <div style={{ marginBottom: 14 }}>
                {run.notes && (
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', marginTop: 6, fontStyle: 'italic' }}>
                    “{run.notes}”
                  </div>
                )}
              </div>

              {/* Summary banner */}
              <div className={`banner ${pending.length > 0 ? 'banner-warning' : 'banner-success'}`} style={{
                borderRadius: 'var(--r-sm)', borderBottom: 'none',
                border: `1px solid ${pending.length > 0 ? 'var(--warning-fg)' : 'var(--success-border)'}`,
                marginBottom: 14, padding: 'var(--space-3) var(--space-4)',
              }}>
                <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name={pending.length > 0 ? 'alert' : 'check'} size={16} /></span>
                <div className="banner-body" style={{ fontSize: 'var(--fs-sm)' }}>
                  <div style={{ fontWeight: 'var(--fw-bold)' }}>
                    {submittedBins} bin{submittedBins === 1 ? '' : 's'} counted ·{' '}
                    {transfers.length} auto-reconciled ·{' '}
                    {pending.length} need review
                    {approved.length > 0 && ` · ${approved.length} approved`}
                    {discarded.length > 0 && ` · ${discarded.length} discarded`}
                  </div>
                  {missing.length > 0 && (
                    <div style={{ marginTop: 4, color: 'var(--danger-fg)', fontWeight: 'var(--fw-semibold)' }}>
                      {missing.length} item{missing.length === 1 ? '' : 's'} went missing — use “Missing report” to export
                    </div>
                  )}
                </div>
              </div>

              {/* Auto-reconciled transfers (collapsed by default) */}
              {transfers.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <button
                    onClick={() => setShowAutoTransfers(v => !v)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px',
                      background: 'var(--gray-lt)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)',
                      cursor: 'pointer', textAlign: 'left',
                      fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)',
                      color: 'var(--muted)',
                    }}
                  >
                    <span>↻ Auto-reconciled transfers ({transfers.length}) — audit only</span>
                    <span style={{ transform: showAutoTransfers ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                  </button>
                  {showAutoTransfers && (
                    <div style={{
                      padding: '8px 14px', background: 'var(--surface)',
                      border: '1px solid var(--border)', borderTop: 'none',
                      borderRadius: '0 0 var(--r-sm) var(--r-sm)',
                    }}>
                      {transfers.map(t => {
                        const ends = [t.from_session?.location, t.to_session?.location].filter(Boolean)
                        const openLoc = ends.find(l => recountKey === `${t.part_id}|${l.id}`)
                        return (
                          <div key={t.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 'var(--fw-bold)', color: 'var(--success-fg)' }}>
                                {Number(t.quantity).toLocaleString()}
                              </span>
                              <span style={{ flex: 1, minWidth: 120 }}>{t.part?.name || t.part_id}</span>
                              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                                {t.from_session?.location?.name || '?'} → {t.to_session?.location?.name || '?'}
                              </span>
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                              {ends.map(l => pendingAt(pending, t.part_id, l.id) ? (
                                // A partially-paired line leaves its remainder
                                // pending at the same bin; the RPC refuses a
                                // second correction there, so point at it.
                                <span key={l.id} style={{ fontSize: 11, color: 'var(--hint)', alignSelf: 'center' }}>
                                  {l.name}: use its variance below
                                </span>
                              ) : (
                                <button key={l.id} disabled={busy}
                                  onClick={() => setRecountKey(k => k === `${t.part_id}|${l.id}` ? null : `${t.part_id}|${l.id}`)}
                                  style={miniBtn(recountKey === `${t.part_id}|${l.id}`)}>
                                  Recount {l.name}
                                </button>
                              ))}
                            </div>
                            {openLoc && (
                              <LocationRecount
                                partId={t.part_id} unit={t.part?.unit} location={openLoc} busy={busy}
                                onCancel={() => setRecountKey(null)}
                                onSubmit={(countedNow, note, expectedSystem) => handleRecount({ partId: t.part_id, locationId: openLoc.id, countedNow, note, expectedSystem })}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Variances needing review */}
              {pending.length > 0 && (
                <>
                  <div className="sec-label" style={{ marginTop: 0, marginBottom: 8 }}>
                    Variances needing review
                  </div>
                  {pending.length > 1 && (
                    <button
                      onClick={() => setBulkConfirm(true)}
                      className="btn btn-ghost"
                      style={{ width: '100%', padding: '8px 12px', fontSize: 'var(--fs-sm)', marginBottom: 8 }}
                      disabled={busy}
                    >
                      <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Approve all {pending.length}
                    </button>
                  )}
                  {pending.map(r => (
                    <ResolutionRow
                      key={r.id}
                      resolution={r}
                      busy={busy}
                      fixing={fixingId === r.id}
                      counterLocations={counterLocations}
                      onApprove={() => handleApprove(r)}
                      onFix={() => setFixingId(id => id === r.id ? null : r.id)}
                      onResolve={(opts) => handleResolve(r, opts)}
                      onDiscard={() => setDiscardConfirm({ resolution: r, reason: '' })}
                    />
                  ))}
                </>
              )}

              {/* Already-actioned (approved or discarded) */}
              {(approved.length > 0 || discarded.length > 0 || recounts.length > 0) && (
                // Open by default once nothing is pending (a closed run opened
                // from history) — this list IS the run's outcome then.
                <details style={{ marginTop: 16 }} open={pending.length === 0}>
                  <summary style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', cursor: 'pointer', padding: '6px 0' }}>
                    Already actioned ({approved.length + discarded.length + recounts.length})
                  </summary>
                  {[...approved, ...discarded].map(r => {
                    const loc = resolutionLocation(r)
                    const key = loc ? `${r.part_id}|${loc.id}` : null
                    const net = settledNet(r)
                    return (
                      <div key={r.id} style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                          <span className={`pill pill-sm ${r.status === 'approved' ? 'pill-success' : 'pill-muted'}`} style={{ display: 'inline-flex' }}>
                            <Icon name={r.status === 'approved' ? 'check' : 'x'} size={11} />
                          </span>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-xs)' }}>
                            {r.part?.name || r.part_id}
                            {loc && <> at {loc.name}</>}
                            {' '}— counted {r.resolution_type === 'net_gain' ? '+' : '−'}{Number(r.quantity)}
                            {r.recount_qty != null && (
                              <span style={{ color: 'var(--text)' }}>
                                {' '}· recounted {Number(r.recount_qty)} (books had {Number(r.recount_system_qty)})
                              </span>
                            )}
                            {' '}→ <b style={{ color: net > 0 ? 'var(--success-fg)' : net < 0 ? 'var(--danger-fg)' : 'var(--muted)' }}>
                              {net === 0 ? 'no change' : `${fmtSigned(net)} posted`}
                            </b>
                          </span>
                          {key && (
                            <button disabled={busy} onClick={() => setRecountKey(k => k === key ? null : key)} style={miniBtn(recountKey === key)}>
                              Recount
                            </button>
                          )}
                        </div>
                        {r.manager_notes && (
                          <div style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted)', marginLeft: 30 }}>{r.manager_notes}</div>
                        )}
                        {key && recountKey === key && (
                          <LocationRecount
                            partId={r.part_id} unit={r.part?.unit} location={loc} busy={busy}
                            onCancel={() => setRecountKey(null)}
                            onSubmit={(countedNow, note, expectedSystem) => handleRecount({ partId: r.part_id, locationId: loc.id, countedNow, note, expectedSystem })}
                          />
                        )}
                      </div>
                    )
                  })}
                  {recounts.map(m => {
                    const up = !!m.to_location_id
                    return (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', fontSize: 'var(--fs-xs)', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
                        <span className="pill pill-sm pill-muted" style={{ display: 'inline-flex' }}><Icon name="refresh" size={11} /></span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          {m.part?.name || '?'} — <b style={{ color: up ? 'var(--success-fg)' : 'var(--danger-fg)' }}>{up ? '+' : '−'}{Number(m.quantity)}</b> at {(up ? m.to_location : m.from_location)?.name || '?'}
                          <span style={{ fontStyle: 'italic' }}> · {m.notes}</span>
                        </span>
                      </div>
                    )
                  })}
                </details>
              )}

              {/* Footer */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <button
                  onClick={() => setRunDiscardConfirm(true)}
                  className="btn btn-danger"
                  style={{ flex: 1 }}
                  disabled={busy}
                  title="Discard this run — any pending resolutions are marked discarded. Already-committed auto-reconciled transfers cannot be unwound."
                >
                  Discard run
                </button>
                <button onClick={onClose} className="btn btn-primary" style={{ flex: 2 }} disabled={busy}>
                  Close
                </button>
              </div>
            </>
          )
        })()}
      </div>

      {/* Discard-one confirm */}
      {discardConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setDiscardConfirm(null)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Discard variance?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 12 }}>
              No inventory adjustment will be made. The discarded line stays in the record
              with your reason for audit.
            </div>
            <div className="field">
              <label>Reason</label>
              <input
                type="text"
                value={discardConfirm.reason}
                onChange={e => setDiscardConfirm({ ...discardConfirm, reason: e.target.value })}
                autoFocus
                placeholder="e.g. Likely scan error — bin still feels right"
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setDiscardConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                style={{ flex: 2 }}
                onClick={handleDiscardOne}
                disabled={!discardConfirm.reason.trim() || busy}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk approve confirm */}
      {bulkConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setBulkConfirm(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Approve all variances?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
              Each pending variance will create a stock-adjustment movement. This action
              closes the run.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setBulkConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleBulkApprove} disabled={busy}>
                Approve all
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Run-discard confirm */}
      {runDiscardConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setRunDiscardConfirm(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Discard this run?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
              All pending variances will be marked discarded. Any auto-reconciled internal
              transfers that were already committed when the run ended will stay — those
              reflect real stock moves that can't be unwound here.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setRunDiscardConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" style={{ flex: 2 }} onClick={handleRunDiscard} disabled={busy}>
                Discard run
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ResolutionRow({ resolution, onApprove, onDiscard, onFix, onResolve, fixing, counterLocations, busy }) {
  const isGain = resolution.resolution_type === 'net_gain'
  const sign = isGain ? '+' : '−'
  const session = isGain ? resolution.to_session : resolution.from_session
  const binName = session?.location?.name || '(bin)'
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${isGain ? 'var(--success-fg)' : 'var(--danger-fg)'}`,
      borderRadius: 'var(--r-sm)',
      padding: '10px 14px',
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>
            {resolution.part?.name || resolution.part_id}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
            {resolution.part_id} · at {binName}
          </div>
        </div>
        <span className={`pill ${isGain ? 'pill-success' : 'pill-danger'}`} style={{ flexShrink: 0 }}>
          {sign}{Number(resolution.quantity).toLocaleString()} {resolution.part?.unit || 'ea'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onApprove}
          disabled={busy}
          className="btn btn-primary"
          style={{ flex: 2, padding: '6px 10px', fontSize: 'var(--fs-sm)' }}
        >
          <Icon name="check" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Approve {isGain ? 'gain' : 'loss'}
        </button>
        <button
          onClick={onFix}
          disabled={busy}
          className="btn btn-ghost"
          style={{ flex: 2, padding: '6px 10px', fontSize: 'var(--fs-sm)', ...(fixing ? { borderColor: 'var(--text)' } : null) }}
        >
          <Icon name="edit" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 5 }} />Recount / move…
        </button>
        <button
          onClick={onDiscard}
          disabled={busy}
          className="btn btn-ghost"
          style={{ flex: 1, padding: '6px 10px', fontSize: 'var(--fs-sm)' }}
        >
          Discard
        </button>
      </div>
      {fixing && session?.location && (
        <FixPanel
          resolution={resolution}
          location={session.location}
          counterLocations={counterLocations}
          busy={busy}
          onSubmit={onResolve}
        />
      )}
    </div>
  )
}

// ─── Recount / move panel (pending variance) ────────────────────────────────
// Recount is optional; so are the counter-locations. Neither = plain approve,
// which the main button already does, so the submit stays disabled until one
// of them is set.
//
// The difference can be SPREAD over several locations (Oct 2026): a −16 that
// was really 3 on Jaco's truck and 1 on Taryn's books as two transfers, and
// the 12 nobody can account for posts as the usual adjustment.
function FixPanel({ resolution, location, counterLocations, busy, onSubmit }) {
  const partId = resolution.part_id
  const unit = resolution.part?.unit || 'ea'
  const [countedNow, setCountedNow] = useState('')
  const [splits, setSplits] = useState([])  // [{ key, locationId, qty }] — qty kept as the input string
  const [note, setNote] = useState('')
  const [systemNow, setSystemNow] = useState(null)
  const [booksTick, setBooksTick] = useState(0)  // bump → refetch after a failed submit

  useEffect(() => {
    let cancelled = false
    setSystemNow(null)
    getStockQtyAt(partId, location.id)
      .then(qty => { if (!cancelled) setSystemNow(qty) })
      // Books unknown → a recount can't be previewed, so its submit stays
      // disabled; a move to other locations still works.
      .catch(e => console.warn('Fix panel books load failed:', e))
    return () => { cancelled = true }
  }, [partId, location.id, booksTick])

  const options = useMemo(
    () => counterLocations.map(l => ({
      id: l.id,
      label: counterLocationLabel(l, counterLocations, { withType: false }) + (l.type === 'warehouse' ? ' (unbinned)' : ''),
    })),
    [counterLocations]
  )

  const recounted = countedNow !== ''
  const countedNum = recounted ? Number(countedNow) : null
  const validCount = !recounted || (Number.isFinite(countedNum) && countedNum >= 0)

  const base = validCount ? previewResolution({
    resolutionType: resolution.resolution_type, quantity: resolution.quantity,
    countedNow: countedNum, systemNow,
  }) : null
  // Half-filled lines block the submit rather than being silently dropped.
  const st = splitStatus(base ? base.diff : null, splits)
  const goodSplits = st.good
  const preview = validCount ? previewResolution({
    resolutionType: resolution.resolution_type, quantity: resolution.quantity,
    countedNow: countedNum, systemNow, splits: goodSplits,
  }) : null
  const nameOf = id => options.find(o => o.id === id)?.label || '?'
  const canSubmit = !busy && preview && (recounted || splits.length > 0) && !st.incomplete && !preview.over

  let label = 'Enter a recount or add where it went'
  if (st.incomplete) label = 'Pick a location and quantity on every line'
  else if (preview?.over) label = preview.qty === 0
    ? 'Matches the books — remove the location lines to close with no adjustment'
    : `The split adds up to more than the ${preview.qty} ${unit} difference`
  else if (preview && (recounted || splits.length > 0)) {
    if (preview.action === 'none') label = 'Matches the books — close with no adjustment'
    else if (preview.action === 'split') {
      const one = goodSplits.length === 1 && preview.remainder === 0
      if (one) label = preview.direction === 'from_counter'
        ? `Move ${preview.qty} ${unit} from ${nameOf(goodSplits[0].locationId)} → ${location.name}`
        : `Move ${preview.qty} ${unit} from ${location.name} → ${nameOf(goodSplits[0].locationId)}`
      else {
        label = `Move ${preview.splitTotal} ${unit} ${preview.direction === 'from_counter' ? 'from' : 'to'} ${goodSplits.length} location${goodSplits.length === 1 ? '' : 's'}`
        if (preview.remainder > 0) label += ` + post ${fmtSigned(preview.diff > 0 ? preview.remainder : -preview.remainder)} ${unit} adjustment`
      }
    }
    else label = `Post ${fmtSigned(preview.diff)} ${unit} adjustment at ${location.name}`
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border2)' }}>
      {/* 1. Recount */}
      <div className="field" style={{ marginBottom: 8 }}>
        <label>Recount — how many are in {location.name} right now? <span style={{ fontWeight: 400, color: 'var(--hint)' }}>(optional)</span></label>
        <input
          type="number" inputMode="decimal" min="0" value={countedNow}
          onChange={e => setCountedNow(e.target.value)}
          placeholder={systemNow == null ? 'Loading books…' : `Books say ${systemNow.toLocaleString()} ${unit}`}
          autoComplete="off" name="count-recount"
        />
        <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 3 }}>
          Compared against what the books say is there <b>now</b> ({systemNow == null ? '…' : `${systemNow.toLocaleString()} ${unit}`}),
          so anything moved since the count isn't double-booked.
        </div>
      </div>

      {/* 2. Where it really came from / went + context (shared panel) */}
      <VarianceSplitPanel
        partId={partId} unit={unit} location={location}
        diff={base ? base.diff : null} gain={isGainOf(base, resolution)}
        lines={splits} onLinesChange={setSplits}
        options={options} reloadKey={booksTick} nameBase="count-split"
      />

      <div className="field" style={{ marginBottom: 8 }}>
        <label>Note <span style={{ fontWeight: 400, color: 'var(--hint)' }}>(optional)</span></label>
        <input type="text" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. Recounted — 4 were behind the pallet" autoComplete="off" name="count-fix-note" />
      </div>

      <button
        className="btn btn-primary"
        disabled={!canSubmit}
        style={{ width: '100%', padding: '8px 10px', fontSize: 'var(--fs-sm)' }}
        onClick={async () => {
          const ok = await onSubmit({ countedNow: countedNum, splits: goodSplits, note: note.trim() || null, expectedSystem: systemNow })
          if (!ok) setBooksTick(t => t + 1)
        }}
      >
        {label}
      </button>
    </div>
  )
}

// Bins are named per aisle and can repeat across warehouses, so prefix the
// parent: "Main Warehouse › Aisle 1, shelf c1".
function counterLocationLabel(l, all, { withType = true } = {}) {
  const parent = l.parent_location_id ? all.find(p => p.id === l.parent_location_id)?.name : null
  const name = parent ? `${parent} › ${l.name}` : l.name
  return withType && !parent ? `${name} (${l.type})` : name
}

// The bin a gain/loss resolution sits at.
function resolutionLocation(r) {
  return (r.resolution_type === 'net_gain' ? r.to_session : r.from_session)?.location || null
}

function pendingAt(pending, partId, locationId) {
  return pending.some(p => p.part_id === partId && resolutionLocation(p)?.id === locationId)
}

// What a settled resolution actually did to the bin: recount − books when it
// was recounted (can flip the sign of the original variance), 0 for a
// discard, else the original ± quantity.
function settledNet(r) {
  if (r.recount_qty != null) return Number(r.recount_qty) - Number(r.recount_system_qty)
  if (r.status === 'discarded') return 0
  return r.resolution_type === 'net_gain' ? Number(r.quantity) : -Number(r.quantity)
}

// Which way does the variance point once a recount is factored in? Drives the
// "came from / went to" wording.
function isGainOf(preview, resolution) {
  if (preview && preview.diff !== 0) return preview.diff > 0
  return resolution.resolution_type === 'net_gain'
}

// ─── Plain recount (auto-reconciled / already-approved lines) ───────────────
function LocationRecount({ partId, unit = 'ea', location, busy, onSubmit, onCancel }) {
  const [countedNow, setCountedNow] = useState('')
  const [note, setNote] = useState('')
  const [systemNow, setSystemNow] = useState(null)
  const [booksTick, setBooksTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setSystemNow(null)
    getStockQtyAt(partId, location.id)
      .then(q => { if (!cancelled) setSystemNow(q) })
      .catch(e => console.warn('Stock lookup failed:', e))
    return () => { cancelled = true }
  }, [partId, location.id, booksTick])

  const n = countedNow === '' ? null : Number(countedNow)
  const valid = n != null && Number.isFinite(n) && n >= 0 && systemNow != null
  const diff = valid ? n - systemNow : null

  return (
    <div style={{ marginTop: 6, padding: 8, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--r-xs)' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
        On hand in <b>{location.name}</b> now — books say {systemNow == null ? '…' : `${systemNow.toLocaleString()} ${unit}`}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input type="number" inputMode="decimal" min="0" value={countedNow} onChange={e => setCountedNow(e.target.value)}
          placeholder="Counted" autoComplete="off" name="count-location-recount"
          style={{ width: 100, height: 32, padding: '0 8px', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', fontSize: 13, background: 'var(--surface)' }} />
        <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)"
          autoComplete="off" name="count-location-recount-note"
          style={{ flex: '1 1 120px', minWidth: 0, height: 32, padding: '0 8px', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', fontSize: 13, background: 'var(--surface)' }} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button className="btn btn-ghost" style={{ flex: 1, padding: '6px 10px', fontSize: 'var(--fs-sm)' }} onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" style={{ flex: 2, padding: '6px 10px', fontSize: 'var(--fs-sm)' }}
          disabled={!valid || busy} onClick={async () => {
            const ok = await onSubmit(n, note.trim() || null, systemNow)
            if (!ok) setBooksTick(t => t + 1)
          }}>
          {!valid ? 'Enter the count' : diff === 0 ? 'Matches — nothing to post' : `Post ${fmtSigned(diff)} ${unit} adjustment`}
        </button>
      </div>
    </div>
  )
}

function miniBtn(active) {
  return {
    height: 26, padding: '0 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer',
    background: active ? 'var(--dark-bar)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--dark-bar)' : 'var(--border2)'}`,
  }
}
