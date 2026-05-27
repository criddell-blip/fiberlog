import { useEffect, useState } from 'react'
import { useApp } from '../../AppContext'
import CountStartSheet from './CountStartSheet'
import CountRunScreen from './CountRunScreen'
import { getMyActiveRun } from '../../lib/cycleCount'

// Wrapper component that lives inside InventoryView's "Count" sub-tab.
// Two states:
//   1. No active run → show an empty-state CTA. Tap "Start cycle count"
//      → opens CountStartSheet → starts/resumes a run → flip to state 2.
//   2. Active run → render CountRunScreen, which owns its own header /
//      scan input / submit / end flows. On exit, flip back to state 1.
//
// On mount, auto-check for an in-progress run started by the current user
// and jump straight to the counter screen if one exists (so reopening the
// tab after a phone-screen-off doesn't make you go through the start sheet
// every time).
export default function CountTab() {
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

  if (checking) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  if (activeRun) {
    return (
      <CountRunScreen
        run={activeRun}
        onExit={() => setActiveRun(null)}
      />
    )
  }

  return (
    <>
      <div style={{
        padding: '40px 20px', textAlign: 'center',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
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

      {showStart && (
        <CountStartSheet
          onClose={() => setShowStart(false)}
          onStarted={(run) => { setShowStart(false); setActiveRun(run) }}
        />
      )}
    </>
  )
}
