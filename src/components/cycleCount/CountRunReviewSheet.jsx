import { useEffect, useState } from 'react'
import { useApp } from '../../AppContext'
import {
  getCountRunDetail,
  approveCountResolution,
  discardCountResolution,
  discardCountRun,
} from '../../lib/cycleCount'

// Overlay sheet that opens when a manager taps a pending count run in the
// CountTab queue. Lets them review per-line variances and either approve
// (writes the adjust movement) or discard (no movement, just marks resolved).
// Auto-reconciled internal transfers are shown for audit but require no
// action — they were already committed by end_count_run_and_reconcile.
//
// When the last pending resolution is resolved, the server-side RPC flips
// the run's status to 'closed'. We refetch detail after each action and
// auto-close the sheet once nothing is pending.
export default function CountRunReviewSheet({ runId, onClose, onChanged }) {
  const { showToast } = useApp()
  const [detail, setDetail] = useState(null)
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
              <span className="banner-icon">⚠️</span>
              <div className="banner-body">{error}</div>
            </div>
            <button className="btn btn-ghost" onClick={onClose} style={{ marginTop: 16 }}>Close</button>
          </div>
        )}

        {!loading && !error && detail && (() => {
          const { run, sessions, resolutions } = detail
          const pending = resolutions.filter(r => r.status === 'pending')
          const transfers = resolutions.filter(r => r.resolution_type === 'internal_transfer')
          const approved = resolutions.filter(r => r.status === 'approved')
          const discarded = resolutions.filter(r => r.status === 'discarded')
          const submittedBins = sessions.filter(s => s.status === 'submitted').length

          return (
            <>
              {/* Header */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
                  Cycle count review
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                  {run.counter?.name || 'Unknown counter'} · {fmtWhen(run.started_at)}
                  {run.scope_warehouse?.name && <> · {run.scope_warehouse.name}</>}
                </div>
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
                <span className="banner-icon">{pending.length > 0 ? '⚠️' : '✓'}</span>
                <div className="banner-body" style={{ fontSize: 'var(--fs-sm)' }}>
                  <div style={{ fontWeight: 'var(--fw-bold)' }}>
                    {submittedBins} bin{submittedBins === 1 ? '' : 's'} counted ·{' '}
                    {transfers.length} auto-reconciled ·{' '}
                    {pending.length} need review
                    {approved.length > 0 && ` · ${approved.length} approved`}
                    {discarded.length > 0 && ` · ${discarded.length} discarded`}
                  </div>
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
                      {transfers.map(t => (
                        <div key={t.id} style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 0', fontSize: 'var(--fs-sm)',
                          borderBottom: '1px solid var(--border)',
                        }}>
                          <span style={{ fontWeight: 'var(--fw-bold)', color: 'var(--success-fg)' }}>
                            {Number(t.quantity).toLocaleString()}
                          </span>
                          <span style={{ flex: 1 }}>{t.part?.name || t.part_id}</span>
                          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                            {t.from_session?.location?.name || '?'} → {t.to_session?.location?.name || '?'}
                          </span>
                        </div>
                      ))}
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
                      ✓ Approve all {pending.length}
                    </button>
                  )}
                  {pending.map(r => (
                    <ResolutionRow
                      key={r.id}
                      resolution={r}
                      busy={busy}
                      onApprove={() => handleApprove(r)}
                      onDiscard={() => setDiscardConfirm({ resolution: r, reason: '' })}
                    />
                  ))}
                </>
              )}

              {/* Already-actioned (approved or discarded) */}
              {(approved.length > 0 || discarded.length > 0) && (
                <details style={{ marginTop: 16 }}>
                  <summary style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', cursor: 'pointer', padding: '6px 0' }}>
                    Already actioned ({approved.length + discarded.length})
                  </summary>
                  {[...approved, ...discarded].map(r => (
                    <div key={r.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 12px', fontSize: 'var(--fs-sm)',
                      color: 'var(--muted)', opacity: 0.7,
                    }}>
                      <span className={`pill pill-sm ${r.status === 'approved' ? 'pill-success' : 'pill-muted'}`}>
                        {r.status === 'approved' ? '✓' : '✗'}
                      </span>
                      <span style={{ flex: 1, fontSize: 'var(--fs-xs)' }}>
                        {r.part?.name || r.part_id} — {r.resolution_type === 'net_gain' ? '+' : '-'}{Number(r.quantity)}
                      </span>
                      {r.manager_notes && (
                        <span style={{ fontSize: 10, fontStyle: 'italic' }}>{r.manager_notes}</span>
                      )}
                    </div>
                  ))}
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

function ResolutionRow({ resolution, onApprove, onDiscard, busy }) {
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
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: '"DM Mono", monospace', marginTop: 2 }}>
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
          ✓ Approve {isGain ? 'gain' : 'loss'}
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
    </div>
  )
}

function fmtWhen(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
