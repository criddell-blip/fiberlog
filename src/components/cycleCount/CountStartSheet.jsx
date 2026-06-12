import { useEffect, useState } from 'react'
import { useApp } from '../../AppContext'
import {
  getMyActiveRun,
  getWarehousesForCount,
  startCountRun,
} from '../../lib/cycleCount'

// Entry to the counter flow. Two paths:
//   1. If the caller has an in-progress run, offer "Resume" (keeps notes,
//      keeps any already-counted bins). Most common case for someone who
//      stepped away and came back.
//   2. Otherwise, pick a warehouse (or leave NULL for cross-warehouse) +
//      add optional notes, then start a fresh run.
//
// On confirm, hands the run back to the parent via onStarted(run).
export default function CountStartSheet({ onClose, onStarted }) {
  const { currentUser } = useApp()
  const [loading, setLoading] = useState(true)
  const [warehouses, setWarehouses] = useState([])
  const [activeRun, setActiveRun] = useState(null)
  const [warehouseId, setWarehouseId] = useState('')
  const [notes, setNotes] = useState('')
  // Bin-distribution mode (DB flag `is_first_binning`): counts at each
  // bin become transfer movements (warehouse → bin) instead of variances.
  // No reconciliation, no manager review queue — just a clean move.
  // Despite the flag name, this is freely re-runnable: use any time new
  // warehouse-level stock arrives that needs to be distributed into bins.
  const [isFirstBinning, setIsFirstBinning] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [active, whs] = await Promise.all([
          currentUser?.id ? getMyActiveRun(currentUser.id) : Promise.resolve(null),
          getWarehousesForCount(),
        ])
        if (cancelled) return
        setActiveRun(active)
        setWarehouses(whs)
        // If the active run is warehouse-scoped, prefill the picker so the
        // "start fresh" flow defaults to the same warehouse.
        if (active?.scope_warehouse_id) setWarehouseId(active.scope_warehouse_id)
      } catch (e) {
        console.error('CountStartSheet load failed:', e)
        if (!cancelled) setError(e.message || 'Could not load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [currentUser?.id])

  async function handleStart() {
    setSubmitting(true)
    setError(null)
    try {
      const run = await startCountRun({
        warehouseId: warehouseId || null,
        notes: notes.trim() || null,
        isFirstBinning,
      })
      onStarted(run)
    } catch (e) {
      console.error('Start run failed:', e)
      setError(e.message || 'Could not start run')
      setSubmitting(false)
    }
  }

  function handleResume() {
    onStarted(activeRun)
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
          Cycle count
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
          Walk the warehouse, scan bins + parts. Variances auto-reconcile across bins;
          unmatched ones land in the review queue.
        </div>

        {loading && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            Loading…
          </div>
        )}

        {!loading && activeRun && (
          <div className="banner banner-success" style={{
            borderRadius: 'var(--r-sm)', borderBottom: 'none',
            border: '1px solid var(--success-border)', marginBottom: 14,
            padding: 'var(--space-3) var(--space-4)',
          }}>
            <span className="banner-icon">↻</span>
            <div className="banner-body">
              <div style={{ fontWeight: 'var(--fw-bold)' }}>You have a run in progress</div>
              <div style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
                Started {fmtRel(activeRun.started_at)}
                {activeRun.scope_warehouse?.name && <> · {activeRun.scope_warehouse.name}</>}
              </div>
            </div>
            <button
              onClick={handleResume}
              className="btn btn-primary"
              style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
            >
              Resume
            </button>
          </div>
        )}

        {!loading && (
          <>
            <div style={{
              fontSize: 'var(--fs-xs)', color: 'var(--hint)',
              fontWeight: 'var(--fw-bold)', textTransform: 'uppercase',
              letterSpacing: '.04em', marginBottom: 8,
              marginTop: activeRun ? 16 : 0,
            }}>
              {activeRun ? 'Or start fresh' : 'Start a new run'}
            </div>

            <div className="field">
              <label>Warehouse scope{isFirstBinning && <span style={{ color: 'var(--orange)' }}> *</span>}</label>
              <select
                value={warehouseId}
                onChange={e => setWarehouseId(e.target.value)}
                disabled={submitting}
              >
                <option value="">— {isFirstBinning ? 'Pick a warehouse (required)' : 'Any warehouse (cross-warehouse)'} —</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', marginTop: 4 }}>
                {isFirstBinning
                  ? 'Bin distribution needs a source warehouse — its stock moves to the bins as you count.'
                  : 'Auto-reconcile only pairs variances within the same warehouse. Pick one if you\'re focused on one location today.'}
              </div>
            </div>

            {/* Bin-distribution toggle (DB flag is_first_binning). Counts
                become transfer movements (warehouse → bin) instead of
                variances. Freely re-runnable. Distinct visual treatment so it
                doesn't get toggled by accident. */}
            <div style={{
              padding: '10px 12px',
              background: isFirstBinning ? 'var(--orange-lt)' : 'var(--surface2)',
              border: `1.5px solid ${isFirstBinning ? 'var(--orange)' : 'var(--border)'}`,
              borderRadius: 'var(--r-sm)',
              marginBottom: 'var(--space-4)',
            }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isFirstBinning}
                  onChange={e => setIsFirstBinning(e.target.checked)}
                  disabled={submitting}
                  style={{ marginTop: 2, cursor: 'pointer' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-sm)', color: isFirstBinning ? 'var(--orange)' : 'var(--text)' }}>
                    📦 Bin distribution mode
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
                    Counts at each bin become <strong>transfer movements</strong>
                    from warehouse-level stock to the bin, not variances. Total
                    stock is preserved; no manager review queue. Use this for
                    the initial warehouse&nbsp;→&nbsp;bin distribution and re-run
                    any time new shipments arrive that need to be distributed.
                  </div>
                </div>
              </label>
            </div>

            <div className="field">
              <label>Notes (optional)</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Monthly cycle — Aisle B"
                style={{ minHeight: 56 }}
                disabled={submitting}
              />
            </div>

            {error && (
              <div style={{
                background: 'var(--danger-bg)', color: 'var(--danger-fg)',
                borderRadius: 'var(--r-sm)', padding: '8px 12px',
                fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)',
                marginBottom: 10,
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={handleStart}
                disabled={submitting}
              >
                {submitting ? 'Starting…' : 'Start count'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function fmtRel(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}
