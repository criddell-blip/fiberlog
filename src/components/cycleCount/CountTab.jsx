import { useEffect, useState } from 'react'
import { useApp } from '../../AppContext'
import CountStartSheet from './CountStartSheet'
import CountRunScreen from './CountRunScreen'
import { getMyActiveRun } from '../../lib/cycleCount'

// Lives inside InventoryView's "Count" sub-tab. InventoryView passes
// `onExitTab` and suppresses its own chrome (action buttons + sub-tab
// pills) when this is rendered — counter UI gets the full panel so the
// vertical pixels aren't eaten by Inventory's header on mobile.
//
// Two states:
//   1. No active run → slim "← Inventory" header + empty-state CTA.
//   2. Active run → CountRunScreen takes over completely. Its own header
//      has the back arrow that ends/exits the run; from there we drop
//      back to state 1 (so the user can start another run or hit
//      "← Inventory" to leave).
//
// On mount, auto-resume an in-progress run started by the current user.
// Reopening the tab after closing the phone screen shouldn't make you
// go through the start sheet every time.
export default function CountTab({ onExitTab }) {
  const { currentUser } = useApp()
  const [activeRun, setActiveRun] = useState(null)
  const [showStart, setShowStart] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    if (!currentUser?.id) { setChecking(false); return }
    ;(async () => {
      try {
        const run = await getMyActiveRun(currentUser.id)
        if (!cancelled) setActiveRun(run)
      } catch (e) {
        console.warn('Could not check for active run:', e)
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => { cancelled = true }
  }, [currentUser?.id])

  if (activeRun) {
    return (
      <CountRunScreen
        run={activeRun}
        onExit={() => setActiveRun(null)}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <button className="back-btn" onClick={onExitTab} title="Back to Inventory">←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="topbar-title">Cycle count</div>
          <div className="topbar-sub">Inventory · scanner-driven count</div>
        </div>
      </div>

      <div className="scroll-body">
        {checking ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
            Loading…
          </div>
        ) : (
          <div style={{
            padding: '40px 20px', textAlign: 'center',
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r)',
            margin: '0 auto', maxWidth: 540,
          }}>
            <div style={{ fontSize: 48, marginBottom: 14 }}>🔢</div>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Cycle count
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', maxWidth: 460, margin: '0 auto 20px', lineHeight: 1.4 }}>
              Walk the warehouse with a USB scanner or phone camera. Scan bins, scan parts,
              enter counts. Variances that pair across bins auto-reconcile as internal
              transfers; unmatched variances land in the review queue.
            </div>
            <button
              className="btn btn-primary"
              onClick={() => setShowStart(true)}
              style={{ padding: '10px 20px' }}
            >
              ＋ Start cycle count
            </button>
          </div>
        )}
      </div>

      {showStart && (
        <CountStartSheet
          onClose={() => setShowStart(false)}
          onStarted={(run) => { setShowStart(false); setActiveRun(run) }}
        />
      )}
    </div>
  )
}
