import { useEffect, useState } from 'react'
import { getCompletedCountRuns } from '../../lib/cycleCount'
import CountRunReviewSheet from './CountRunReviewSheet'
import Icon from '../shared/Icon'

// Read-only history of closed + discarded count runs. Lets a manager
// review what was counted, when, and (for closed runs) drill into the
// run detail via the review sheet to see what got reconciled vs.
// approved vs. discarded.
//
// Opens from CountTab's empty state via a "View past runs" link.
export default function CountRunHistorySheet({ onClose }) {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [reviewRunId, setReviewRunId] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await getCompletedCountRuns({ limit: 50 })
        if (!cancelled) setRuns(data)
      } catch (e) {
        console.error('History load failed:', e)
        if (!cancelled) setError(e.message || 'Could not load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <>
      <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="overlay-sheet" style={{ maxWidth: 640 }}>
          <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
            Past count runs
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            Most recent 50 closed or discarded runs. Tap a closed run to view its
            resolutions and auto-reconciled transfers.
          </div>

          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
              Loading…
            </div>
          )}

          {error && (
            <div className="banner banner-danger" style={{
              borderRadius: 'var(--r-sm)', borderBottom: 'none',
              border: '1px solid var(--danger-border)',
            }}>
              <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name="alert" size={16} /></span>
              <div className="banner-body">{error}</div>
            </div>
          )}

          {!loading && !error && runs.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)', fontSize: 14 }}>
              No runs yet. Start one to begin the cycle.
            </div>
          )}

          {!loading && !error && runs.length > 0 && (
            <div style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: 14 }}>
              {runs.map(run => {
                const isDiscarded = run.status === 'discarded'
                return (
                  <button
                    key={run.id}
                    onClick={() => !isDiscarded && setReviewRunId(run.id)}
                    disabled={isDiscarded}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderLeft: `3px solid ${isDiscarded ? 'var(--muted)' : 'var(--success-fg)'}`,
                      borderRadius: 'var(--r-sm)',
                      padding: '10px 14px',
                      marginBottom: 6,
                      cursor: isDiscarded ? 'default' : 'pointer',
                      opacity: isDiscarded ? 0.6 : 1,
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`pill pill-sm ${isDiscarded ? 'pill-muted' : 'pill-success'}`}>
                        {isDiscarded ? 'discarded' : 'closed'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-base)' }}>
                          {run.counter?.name || 'Unknown'}
                          {run.scope_warehouse?.name && (
                            <span style={{ fontWeight: 'var(--fw-medium)', color: 'var(--muted)' }}>
                              {' '}· {run.scope_warehouse.name}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 2 }}>
                          {fmtAbs(run.completed_at || run.started_at)}
                        </div>
                      </div>
                      {!isDiscarded && <span style={{ fontSize: 16, color: 'var(--hint)' }}>›</span>}
                    </div>
                    {run.notes && (
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 4, fontStyle: 'italic' }}>
                        “{run.notes}”
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <button className="btn btn-primary" style={{ width: '100%' }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {reviewRunId && (
        <CountRunReviewSheet
          runId={reviewRunId}
          onClose={() => setReviewRunId(null)}
        />
      )}
    </>
  )
}

function fmtAbs(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}
