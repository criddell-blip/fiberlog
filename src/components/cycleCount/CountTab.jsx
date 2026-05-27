import { useEffect, useState, useCallback } from 'react'
import { useApp } from '../../AppContext'
import CountStartSheet from './CountStartSheet'
import CountRunScreen from './CountRunScreen'
import CountRunReviewSheet from './CountRunReviewSheet'
import CountRunHistorySheet from './CountRunHistorySheet'
import { getMyActiveRun, getPendingCountRuns } from '../../lib/cycleCount'

// Lives inside InventoryView's "Count" sub-tab. InventoryView passes
// `onExitTab` and suppresses its own chrome (action buttons + sub-tab
// pills) when this is rendered — counter UI gets the full panel so the
// vertical pixels aren't eaten by Inventory's header on mobile.
//
// Three states:
//   1. Active run → CountRunScreen takes over completely.
//   2. No active run, but pending-review runs exist → empty state + a
//      queue list above the Start CTA. Tap one to review.
//   3. No active run, no pending reviews → just the empty-state CTA.
export default function CountTab({ onExitTab }) {
  const { currentUser } = useApp()
  const [activeRun, setActiveRun] = useState(null)
  const [pendingRuns, setPendingRuns] = useState([])
  const [showStart, setShowStart] = useState(false)
  const [reviewRunId, setReviewRunId] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async () => {
    if (!currentUser?.id) { setLoading(false); return }
    setLoading(true)
    try {
      const [run, queue] = await Promise.all([
        getMyActiveRun(currentUser.id),
        getPendingCountRuns(),
      ])
      setActiveRun(run)
      setPendingRuns(queue)
    } catch (e) {
      console.warn('CountTab load failed:', e)
    } finally {
      setLoading(false)
    }
  }, [currentUser?.id])

  useEffect(() => { loadAll() }, [loadAll])

  if (activeRun) {
    return (
      <CountRunScreen
        run={activeRun}
        onExit={async () => { setActiveRun(null); await loadAll() }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <button className="back-btn" onClick={onExitTab} title="Back to Inventory">←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="topbar-title">Cycle count</div>
          <div className="topbar-sub">
            {pendingRuns.length > 0
              ? `${pendingRuns.length} run${pendingRuns.length === 1 ? '' : 's'} awaiting review`
              : 'Inventory · scanner-driven count'}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowStart(true)}
          style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
        >
          ＋ Start
        </button>
      </div>

      <div className="scroll-body" style={{ padding: 16 }}>
        {loading && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
            Loading…
          </div>
        )}

        {!loading && (
          <>
            {/* Pending-review queue */}
            {pendingRuns.length > 0 && (
              <>
                <div className="sec-label" style={{ marginTop: 0, marginBottom: 8 }}>
                  Pending review
                </div>
                {pendingRuns.map(run => (
                  <button
                    key={run.id}
                    onClick={() => setReviewRunId(run.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      background: 'var(--warning-bg)',
                      border: '1px solid var(--warning-fg)',
                      borderRadius: 'var(--r-sm)',
                      padding: '12px 14px',
                      marginBottom: 8,
                      cursor: 'pointer',
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 18 }}>⚠️</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-base)' }}>
                          {run.counter?.name || 'Unknown counter'}
                          {run.scope_warehouse?.name && (
                            <span style={{ fontWeight: 'var(--fw-medium)', color: 'var(--muted)' }}>
                              {' '}· {run.scope_warehouse.name}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 2 }}>
                          Ended {fmtRel(run.completed_at)}
                        </div>
                      </div>
                      <span style={{ fontSize: 18, color: 'var(--warning-fg)' }}>›</span>
                    </div>
                  </button>
                ))}
              </>
            )}

            {/* Start CTA — always visible (empty state or alongside queue) */}
            <div style={{
              padding: '32px 20px', textAlign: 'center',
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
              margin: pendingRuns.length > 0 ? '16px auto 0' : '0 auto',
              maxWidth: 540,
            }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔢</div>
              <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-md)', marginBottom: 6 }}>
                {pendingRuns.length > 0 ? 'Start another count' : 'Cycle count'}
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', maxWidth: 460, margin: '0 auto 16px', lineHeight: 1.4 }}>
                Walk the warehouse with a scanner or phone camera. Scan bins + parts, enter counts.
                Variances that pair across bins auto-reconcile as internal transfers; unmatched ones
                land here for review.
              </div>
              <button
                className="btn btn-primary"
                onClick={() => setShowStart(true)}
                style={{ padding: '10px 20px' }}
              >
                ＋ Start cycle count
              </button>
              <div style={{ marginTop: 16 }}>
                <button
                  onClick={() => setShowHistory(true)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--muted)', fontSize: 'var(--fs-sm)',
                    textDecoration: 'underline', padding: 4,
                  }}
                >
                  View past runs
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {showStart && (
        <CountStartSheet
          onClose={() => setShowStart(false)}
          onStarted={(run) => { setShowStart(false); setActiveRun(run) }}
        />
      )}

      {reviewRunId && (
        <CountRunReviewSheet
          runId={reviewRunId}
          onClose={() => setReviewRunId(null)}
          onChanged={loadAll}
        />
      )}

      {showHistory && (
        <CountRunHistorySheet onClose={() => setShowHistory(false)} />
      )}
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
