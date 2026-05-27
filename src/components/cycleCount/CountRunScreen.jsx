import { useEffect, useState, useRef, useCallback } from 'react'
import { useApp } from '../../AppContext'
import ScanInput from '../shared/ScanInput'
import {
  isBinCode,
  parseBinCode,
  getBinById,
  getPartBySku,
  startOrResumeCountSession,
  recordCountLine,
  submitCountSession,
  endCountRunAndReconcile,
  getRunSessions,
  getSessionLines,
  discardCountRun,
} from '../../lib/cycleCount'
import { getBinsForWarehouse, getLocations } from '../../lib/inventory'
import { searchPartsCatalog } from '../../lib/supabase'

// The active count run screen. Built around a persistent scan input at top
// that handles both bin codes (BIN:<uuid>) and part SKUs. Scanning a bin
// loads/resumes its session. Scanning a part either increments its counted
// qty (if expected here) or adds it as a "found unexpected" line.
//
// Workflow:
//   • Scan/pick bin → session opens, expected parts list loads
//   • Scan/pick part → counted_qty increments by 1 (or starts at 1)
//   • Edit counted_qty directly in the input if you have a stack to enter
//   • Tap "Submit bin" when done with the bin — server rejects if any
//     expected line has no counted_qty entered
//   • Tap "End run" when you're done — runs auto-reconcile, shows result
export default function CountRunScreen({ run: initialRun, onExit }) {
  const { currentUser, showToast } = useApp()
  const [run, setRun] = useState(initialRun)
  const [sessions, setSessions] = useState([])
  const [activeSession, setActiveSession] = useState(null)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(false)
  const [showBinPicker, setShowBinPicker] = useState(false)
  const [showPartPicker, setShowPartPicker] = useState(false)
  const [showEndConfirm, setShowEndConfirm] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [endResult, setEndResult] = useState(null)
  const [busy, setBusy] = useState(false)

  // Track which line should pulse / scroll into view (most recent scan).
  const [highlightedLineKey, setHighlightedLineKey] = useState(null)
  const lineRefs = useRef({})

  const refreshSessions = useCallback(async () => {
    try {
      const s = await getRunSessions(run.id)
      setSessions(s)
    } catch (e) {
      console.error('Refresh sessions failed:', e)
    }
  }, [run.id])

  const refreshLines = useCallback(async (sessionId) => {
    try {
      const l = await getSessionLines(sessionId)
      setLines(l)
    } catch (e) {
      console.error('Refresh lines failed:', e)
    }
  }, [])

  useEffect(() => { refreshSessions() }, [refreshSessions])

  // ── Scan handler ─────────────────────────────────────────────────────
  async function handleScan(code) {
    if (busy) { showToast('Working — try again in a sec'); return }
    setBusy(true)
    try {
      if (isBinCode(code)) {
        await loadBin(parseBinCode(code))
      } else {
        await loadPart(code.trim())
      }
    } catch (e) {
      console.error('Scan failed:', e)
      showToast(e.message || 'Scan failed')
    } finally {
      setBusy(false)
    }
  }

  async function loadBin(binId) {
    const bin = await getBinById(binId)
    if (!bin) {
      showToast('Bin not found or inactive')
      return
    }
    const session = await startOrResumeCountSession({ runId: run.id, binId })
    setActiveSession({ ...session, location: bin })
    await refreshLines(session.id)
    await refreshSessions()
    showToast(`Counting ${bin.name}`)
  }

  async function loadPart(sku) {
    if (!activeSession) {
      showToast('Scan a bin first')
      return
    }
    const part = await getPartBySku(sku)
    if (!part) {
      showToast(`Unknown SKU: ${sku}`)
      return
    }
    // Find existing line — if found, increment counted_qty by 1.
    // If not found, add as new unexpected (expected=0, counted=1).
    const existing = lines.find(l => l.part_id === part.id)
    const newQty = existing ? (Number(existing.counted_qty) || 0) + 1 : 1
    const updated = await recordCountLine({
      sessionId: activeSession.id,
      partId: part.id,
      countedQty: newQty,
    })
    await refreshLines(activeSession.id)
    setHighlightedLineKey(part.id)
    // Scroll into view
    setTimeout(() => {
      const el = lineRefs.current[part.id]
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 50)
  }

  // Manual qty edit (when worker types a number directly instead of scanning)
  async function handleQtyChange(line, newVal) {
    const numeric = newVal === '' ? null : Number(newVal)
    if (numeric !== null && (isNaN(numeric) || numeric < 0)) return
    // Optimistic update
    setLines(prev => prev.map(l => l.id === line.id ? { ...l, counted_qty: numeric } : l))
    if (numeric === null) return  // don't save NULL — wait for actual entry
    try {
      await recordCountLine({
        sessionId: activeSession.id,
        partId: line.part_id,
        countedQty: numeric,
      })
    } catch (e) {
      console.error('Save qty failed:', e)
      showToast('Save failed: ' + e.message)
      await refreshLines(activeSession.id)
    }
  }

  async function handleSubmitBin() {
    if (!activeSession) return
    setBusy(true)
    try {
      await submitCountSession(activeSession.id)
      showToast(`Submitted ${activeSession.location.name}`)
      setActiveSession(null)
      setLines([])
      await refreshSessions()
    } catch (e) {
      console.error('Submit bin failed:', e)
      showToast(e.message || 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleEndRun() {
    setShowEndConfirm(false)
    setBusy(true)
    try {
      // If active session has uncounted lines or isn't submitted, prompt user
      if (activeSession) {
        const uncounted = lines.filter(l => l.counted_qty == null)
        if (uncounted.length > 0) {
          showToast(`Finish bin "${activeSession.location.name}" first — ${uncounted.length} uncounted lines`)
          setBusy(false)
          return
        }
        // Submit it
        await submitCountSession(activeSession.id)
        setActiveSession(null)
        setLines([])
        await refreshSessions()
      }
      const result = await endCountRunAndReconcile(run.id)
      setEndResult(result)
      setRun(result)
    } catch (e) {
      console.error('End run failed:', e)
      showToast(e.message || 'Could not end run')
    } finally {
      setBusy(false)
    }
  }

  async function handleDiscardRun() {
    setShowDiscardConfirm(false)
    setBusy(true)
    try {
      await discardCountRun({ runId: run.id, reason: 'Discarded by counter' })
      showToast('Run discarded')
      onExit()
    } catch (e) {
      console.error('Discard failed:', e)
      showToast(e.message || 'Discard failed')
      setBusy(false)
    }
  }

  // ── Bin picker (no-scanner fallback) ─────────────────────────────────
  async function openBinPicker() {
    setLoading(true)
    try {
      // If run is warehouse-scoped, only show bins under that warehouse.
      // Otherwise show all bins from all warehouses.
      if (run.scope_warehouse_id) {
        const bins = await getBinsForWarehouse(run.scope_warehouse_id)
        setShowBinPicker({ bins })
      } else {
        const all = await getLocations({ includeBins: true })
        const bins = all.filter(l => l.type === 'bin' && l.is_active)
        setShowBinPicker({ bins })
      }
    } catch (e) {
      console.error('Bin picker load failed:', e)
      showToast('Could not load bins')
    } finally {
      setLoading(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  if (endResult) {
    return <EndResultScreen run={endResult} onDone={onExit} />
  }

  const uncountedCount = lines.filter(l => l.counted_qty == null).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Top bar */}
      <div className="topbar" style={{ borderBottom: '1px solid var(--border)' }}>
        <button className="back-btn" onClick={onExit}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="topbar-title">Cycle count</div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {run.scope_warehouse?.name || 'Cross-warehouse'} ·
            {' '}{sessions.length} bin{sessions.length === 1 ? '' : 's'} counted
          </div>
        </div>
        <button
          onClick={() => setShowEndConfirm(true)}
          className="btn btn-primary"
          style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
          disabled={busy}
        >
          End run
        </button>
      </div>

      {/* Persistent scan input */}
      <div style={{
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', flexShrink: 0,
      }}>
        <ScanInput
          onScan={handleScan}
          placeholder={activeSession ? 'Scan a part SKU…' : 'Scan a bin (BIN:…) to start'}
          disabled={busy}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={openBinPicker} className="btn btn-ghost" style={{ flex: 1, padding: '6px 10px', fontSize: 'var(--fs-sm)' }}>
            🗂 Pick bin
          </button>
          <button
            onClick={() => setShowPartPicker(true)}
            className="btn btn-ghost"
            style={{ flex: 1, padding: '6px 10px', fontSize: 'var(--fs-sm)' }}
            disabled={!activeSession}
          >
            🔎 Pick part
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="scroll-body" style={{ padding: '14px 14px 40px' }}>
        {!activeSession && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--hint)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📦</div>
            <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)', color: 'var(--text)', marginBottom: 6 }}>
              Scan a bin to start
            </div>
            <div style={{ fontSize: 'var(--fs-sm)' }}>
              Point the scanner at a bin label, or tap "Pick bin" to choose from a list.
            </div>

            {sessions.length > 0 && (
              <>
                <div className="sec-label" style={{ marginTop: 28, marginBottom: 10, textAlign: 'left' }}>
                  Bins counted in this run
                </div>
                <div style={{ textAlign: 'left' }}>
                  {sessions.map(s => (
                    <div key={s.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', marginBottom: 6,
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)',
                    }}>
                      <span className={`pill pill-sm ${s.status === 'submitted' ? 'pill-success' : 'pill-warning'}`}>
                        {s.status === 'submitted' ? '✓' : '…'}
                      </span>
                      <div style={{ flex: 1, fontSize: 'var(--fs-base)' }}>{s.location?.name || s.location_id}</div>
                      {s.status === 'in_progress' && (
                        <button
                          onClick={() => loadBin(s.location_id)}
                          className="btn btn-ghost"
                          style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}
                        >
                          Resume
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {activeSession && (
          <>
            {/* Active bin header */}
            <div className="banner banner-accent" style={{
              borderRadius: 'var(--r-sm)', borderBottom: 'none',
              border: '1px solid var(--accent-border)', marginBottom: 14,
              padding: 'var(--space-3) var(--space-4)',
            }}>
              <div className="banner-body">
                <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>
                  {activeSession.location.name}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', marginTop: 2 }}>
                  {lines.length} part type{lines.length === 1 ? '' : 's'}
                  {uncountedCount > 0 && ` · ${uncountedCount} uncounted`}
                </div>
              </div>
              <button
                onClick={handleSubmitBin}
                className="btn btn-primary"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
                disabled={busy || uncountedCount > 0}
                title={uncountedCount > 0 ? `${uncountedCount} parts not yet counted` : 'Submit this bin'}
              >
                Submit bin
              </button>
            </div>

            {/* Lines */}
            {lines.length === 0 && (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--hint)', fontSize: 'var(--fs-sm)' }}>
                No expected stock at this bin. Scan parts as you find them.
              </div>
            )}
            {lines.map(line => {
              const part = line.part || {}
              const counted = line.counted_qty
              const expected = Number(line.expected_qty)
              const variance = (counted ?? 0) - expected
              const isUnexpected = expected === 0
              const isUncounted = counted == null
              const isHighlighted = highlightedLineKey === line.part_id
              return (
                <div
                  key={line.id}
                  ref={el => { lineRefs.current[line.part_id] = el }}
                  style={{
                    background: isUnexpected ? 'var(--accent-bg)' : 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderLeft: isHighlighted ? '3px solid var(--orange)'
                              : variance !== 0 && counted != null ? '3px solid var(--amber)'
                              : '3px solid transparent',
                    borderRadius: 'var(--r-sm)',
                    padding: '10px 14px',
                    marginBottom: 6,
                    display: 'flex', alignItems: 'center', gap: 10,
                    transition: 'border-color 0.3s',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {part.name || line.part_id}
                      {isUnexpected && <span className="pill pill-accent pill-sm" style={{ marginLeft: 6 }}>found</span>}
                    </div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: '"DM Mono", monospace', marginTop: 2 }}>
                      {line.part_id}
                      {!isUnexpected && <> · expected {expected}</>}
                    </div>
                  </div>
                  <input
                    type="number"
                    value={counted ?? ''}
                    placeholder={isUncounted ? '–' : '0'}
                    onChange={e => handleQtyChange(line, e.target.value)}
                    inputMode="numeric"
                    style={{
                      width: 72,
                      padding: '6px 8px',
                      border: `1.5px solid ${variance !== 0 && counted != null ? 'var(--amber)' : 'var(--border2)'}`,
                      borderRadius: 'var(--r-xs)',
                      fontSize: 18,
                      fontWeight: 'var(--fw-bold)',
                      textAlign: 'center',
                      background: 'var(--bg)',
                      color: variance > 0 ? 'var(--success-fg)' : variance < 0 ? 'var(--danger-fg)' : 'var(--text)',
                    }}
                  />
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', minWidth: 18 }}>
                    {part.unit || 'ea'}
                  </span>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* Discard button (subtle, at bottom) */}
      <div style={{
        padding: '10px 14px', borderTop: '1px solid var(--border)',
        flexShrink: 0, display: 'flex', justifyContent: 'center',
        background: 'var(--bg)',
      }}>
        <button
          onClick={() => setShowDiscardConfirm(true)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--muted)', fontSize: 'var(--fs-xs)',
            padding: 4,
          }}
        >
          Discard this run
        </button>
      </div>

      {/* Bin picker */}
      {showBinPicker && (
        <BinPickerSheet
          bins={showBinPicker.bins}
          onPick={async (b) => { setShowBinPicker(false); await loadBin(b.id) }}
          onClose={() => setShowBinPicker(false)}
        />
      )}

      {/* Part picker */}
      {showPartPicker && activeSession && (
        <PartPickerSheet
          onPick={async (p) => { setShowPartPicker(false); await loadPart(p.id) }}
          onClose={() => setShowPartPicker(false)}
        />
      )}

      {/* End run confirm */}
      {showEndConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowEndConfirm(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              End count run?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
              {sessions.filter(s => s.status === 'submitted').length} submitted bins will be auto-reconciled.
              Variances that don't cancel out within a warehouse will land in the manager review queue.
              {activeSession && uncountedCount > 0 && (
                <div style={{ color: 'var(--amber)', marginTop: 8, fontWeight: 'var(--fw-bold)' }}>
                  ⚠️ You still have an open bin with {uncountedCount} uncounted lines — finish it first.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowEndConfirm(false)}>
                Keep counting
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={handleEndRun}
                disabled={busy || (activeSession && uncountedCount > 0)}
              >
                End + reconcile
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discard confirm */}
      {showDiscardConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowDiscardConfirm(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Discard run?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
              All counted data in this run will be discarded. Counts can't be recovered.
              No inventory adjustments will be made.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowDiscardConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" style={{ flex: 2 }} onClick={handleDiscardRun} disabled={busy}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Bin picker ─────────────────────────────────────────────────────────
function BinPickerSheet({ bins, onPick, onClose }) {
  const [q, setQ] = useState('')
  const filtered = q.trim()
    ? bins.filter(b => b.name.toLowerCase().includes(q.trim().toLowerCase()))
    : bins
  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 10 }}>
          Pick a bin
        </div>
        <input
          type="text"
          placeholder="Search…"
          value={q}
          onChange={e => setQ(e.target.value)}
          autoFocus
          autoComplete="off"
          name="bin-search"
          style={{
            width: '100%', padding: '10px 12px',
            border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
            background: 'var(--surface2)', fontSize: 14, marginBottom: 10, color: 'var(--text)',
          }}
        />
        <div style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: 12 }}>
          {filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
              No matching bins
            </div>
          )}
          {filtered.map(b => (
            <button
              key={b.id}
              onClick={() => onPick(b)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 12px', marginBottom: 4,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', cursor: 'pointer',
                fontSize: 'var(--fs-base)', color: 'var(--text)',
              }}
            >
              {b.name}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Part picker ────────────────────────────────────────────────────────
function PartPickerSheet({ onPick, onClose }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!q || q.length < 2) { setResults([]); return }
    let cancelled = false
    setSearching(true)
    searchPartsCatalog(q, { limit: 12 })
      .then(r => { if (!cancelled) setResults(r || []) })
      .catch(e => console.warn('Part search:', e))
      .finally(() => { if (!cancelled) setSearching(false) })
    return () => { cancelled = true }
  }, [q])

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 10 }}>
          Find a part
        </div>
        <input
          type="text"
          placeholder="Search by SKU or name…"
          value={q}
          onChange={e => setQ(e.target.value)}
          autoFocus
          autoComplete="off"
          name="cycle-part-search"
          style={{
            width: '100%', padding: '10px 12px',
            border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
            background: 'var(--surface2)', fontSize: 14, marginBottom: 10, color: 'var(--text)',
          }}
        />
        <div style={{ maxHeight: '60vh', overflowY: 'auto', marginBottom: 12 }}>
          {searching && (
            <div style={{ padding: 14, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>Searching…</div>
          )}
          {!searching && q.length >= 2 && results.length === 0 && (
            <div style={{ padding: 14, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>No matches</div>
          )}
          {results.map(p => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '10px 12px', marginBottom: 4,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', cursor: 'pointer', color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>{p.name}</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: '"DM Mono", monospace', marginTop: 2 }}>
                {p.id}
              </div>
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

// ─── End-result screen ─────────────────────────────────────────────────
function EndResultScreen({ run, onDone }) {
  const isPending = run.status === 'pending_review'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 56, marginBottom: 12 }}>{isPending ? '⚠️' : '✅'}</div>
      <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
        {isPending ? 'Reconciled — review needed' : 'Reconciled cleanly'}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', maxWidth: 360, marginBottom: 24, lineHeight: 1.4 }}>
        {isPending
          ? 'Compensating variances within each warehouse were auto-reconciled as internal transfers. The leftovers need your review — open the Count Review queue.'
          : 'Every variance paired with an offsetting one within its warehouse. No manager review needed; all reconciliations are logged as internal transfers.'}
      </div>
      <button className="btn btn-primary" onClick={onDone}>Done</button>
    </div>
  )
}
