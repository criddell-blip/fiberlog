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
  removeCountLine,
  submitCountSession,
  endCountRunAndReconcile,
  getRunSessions,
  getSessionLines,
  discardCountRun,
} from '../../lib/cycleCount'
import { getBinsForWarehouse, getLocations, createPart } from '../../lib/inventory'
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
export default function CountRunScreen({ run: initialRun, onExit, initialBinId = null }) {
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
  // Pre-submit confirm for a single bin. Opens a modal showing the
  // counted lines + variances so the counter has one last look before
  // locking the bin. Bin lock is non-trivial to reverse (manager has to
  // reopen the run), so the extra tap is worth it.
  const [confirmSubmitBin, setConfirmSubmitBin] = useState(false)
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

  // If parent passed initialBinId (e.g. from the LocationDetailPanel's
  // "Count this bin" jump), auto-open that bin's session on first render
  // so the user lands directly in the counter instead of the run's empty
  // state. Fires once per mount.
  useEffect(() => {
    if (!initialBinId) return
    loadBin(initialBinId).catch(e => console.warn('Auto-load initial bin failed:', e))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Remove an UNEXPECTED line (one added ad-hoc by scan/pick during
  // this count, identified by expected_qty === 0). Counter scanned the
  // wrong shelf / wrong barcode / wrong bin and wants to undo cleanly
  // — entering 0 isn't "undo," it's a real "I counted zero" data point
  // that decrements stock at end of run.
  //
  // Optimistic: drop locally first, RPC second. If the RPC errors,
  // refetch lines from the source of truth and toast the error.
  async function handleRemoveLine(line) {
    if (!line || Number(line.expected_qty) !== 0) return
    const snapshot = lines
    setLines(prev => prev.filter(l => l.id !== line.id))
    try {
      await removeCountLine(line.id)
      showToast(`Removed ${line.part?.name || line.part_id}`)
    } catch (e) {
      console.error('Remove line failed:', e)
      setLines(snapshot)
      showToast(e.message || 'Remove failed')
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
          <div className="topbar-title">
            {run.is_first_binning ? '🏗️ First-time binning' : 'Cycle count'}
          </div>
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

      {/* First-binning visible banner — orange to signal "different mode" */}
      {run.is_first_binning && (
        <div style={{
          padding: '8px 14px', flexShrink: 0,
          background: 'var(--orange-lt)',
          borderBottom: '1px solid var(--orange)',
          fontSize: 'var(--fs-xs)', color: 'var(--orange)', fontWeight: 'var(--fw-semibold)',
        }}>
          ⚠️ First-binning mode — counts at each bin will MOVE stock from{' '}
          <strong>{run.scope_warehouse?.name}</strong> to the bin.
          Not a discovery / variance.
        </div>
      )}

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
                onClick={() => setConfirmSubmitBin(true)}
                className="btn btn-primary"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
                disabled={busy || uncountedCount > 0}
                title={uncountedCount > 0 ? `${uncountedCount} parts not yet counted` : 'Review counts and submit'}
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
                  {/* Remove × — only for unexpected (ad-hoc) lines.
                      Expected lines must stay required-to-count so the
                      audit covers every system-known part. */}
                  {isUnexpected && (
                    <button
                      type="button"
                      onClick={() => handleRemoveLine(line)}
                      title="Remove — scanned this by mistake"
                      style={{
                        width: 28, height: 28, padding: 0,
                        background: 'transparent', color: 'var(--muted)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--r-xs)',
                        fontSize: 16, lineHeight: 1, cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.color = 'var(--amber)'
                        e.currentTarget.style.borderColor = 'var(--amber)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.color = 'var(--muted)'
                        e.currentTarget.style.borderColor = 'var(--border)'
                      }}
                    >
                      ×
                    </button>
                  )}
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

      {/* End run confirm — copy adapts for first-binning mode */}
      {showEndConfirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowEndConfirm(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 420 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              {run.is_first_binning ? 'Finish binning run?' : 'End count run?'}
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 16 }}>
              {run.is_first_binning ? (
                <>
                  {sessions.filter(s => s.status === 'submitted').length} submitted bins.
                  Each counted line becomes a <strong>transfer</strong> from{' '}
                  <strong>{run.scope_warehouse?.name}</strong> to its bin. No review queue.
                  This is a one-way operation — the movements are permanent.
                </>
              ) : (
                <>
                  {sessions.filter(s => s.status === 'submitted').length} submitted bins will be auto-reconciled.
                  Variances that don't cancel out within a warehouse will land in the manager review queue.
                </>
              )}
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
                {run.is_first_binning ? 'Finish + write transfers' : 'End + reconcile'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-submit bin confirm — one last look before locking the bin's
          counts. Lists every line with counted qty + variance pill so
          the counter can scan anomalies before commit. Variances first,
          matches last. The bin's submit is non-trivial to reverse (a
          manager has to reopen the run), so this extra tap is cheap
          insurance against a fat-finger. */}
      {confirmSubmitBin && activeSession && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirmSubmitBin(false)}>
          <div className="overlay-sheet" style={{ maxWidth: 520 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
              Submit bin "{activeSession.location?.name}"?
            </div>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 12 }}>
              You're locking in these counts. This bin can't be edited after submit unless the run is reopened.
              Variances reconcile at end-of-run — no stock changes happen yet.
            </div>

            {/* Counted lines list — variances first, matches last */}
            <div style={{
              maxHeight: '40vh', overflowY: 'auto',
              border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
              padding: '4px 0', marginBottom: 12,
            }}>
              {(() => {
                const enriched = lines.map(l => {
                  const counted = l.counted_qty ?? 0
                  const expected = Number(l.expected_qty)
                  return { line: l, counted, expected, variance: counted - expected }
                })
                // Variances first, sorted by |variance| desc; matches last.
                enriched.sort((a, b) => {
                  const am = Math.abs(a.variance), bm = Math.abs(b.variance)
                  if (am === 0 && bm === 0) return 0
                  if (am === 0) return 1
                  if (bm === 0) return -1
                  return bm - am
                })
                return enriched.map(({ line, counted, expected, variance }) => {
                  const part = line.part || {}
                  const isMatch = variance === 0
                  const pillColor = isMatch ? 'var(--muted)'
                    : variance > 0 ? 'var(--success-fg)'
                    : 'var(--danger-fg)'
                  const pillBg = isMatch ? 'var(--surface2)'
                    : variance > 0 ? 'var(--success-bg, var(--surface2))'
                    : 'var(--danger-bg, var(--surface2))'
                  const isUnexpected = expected === 0
                  return (
                    <div key={line.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '6px 10px',
                      borderBottom: '1px solid var(--border)',
                      fontSize: 'var(--fs-sm)',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontWeight: 'var(--fw-semibold)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {part.name || line.part_id}
                          {isUnexpected && <span style={{ marginLeft: 6, fontSize: 'var(--fs-xs)', color: 'var(--accent-fg, var(--muted))' }}>(found)</span>}
                        </div>
                      </div>
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', minWidth: 92, textAlign: 'right' }}>
                        counted {counted} {part.unit || 'ea'}
                      </div>
                      <div style={{
                        minWidth: 64, textAlign: 'center',
                        fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-bold)',
                        padding: '2px 8px', borderRadius: 10,
                        color: pillColor, background: pillBg,
                        border: `1px solid ${pillColor}`,
                      }}>
                        {isMatch ? 'match' : `${variance > 0 ? '+' : ''}${variance}`}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>

            {/* Footer summary */}
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginBottom: 12 }}>
              {lines.length} part{lines.length === 1 ? '' : 's'} · {lines.filter(l => (l.counted_qty ?? 0) - Number(l.expected_qty) !== 0).length} variance{lines.filter(l => (l.counted_qty ?? 0) - Number(l.expected_qty) !== 0).length === 1 ? '' : 's'}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmSubmitBin(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                disabled={busy}
                onClick={async () => {
                  try {
                    await handleSubmitBin()
                  } finally {
                    setConfirmSubmitBin(false)
                  }
                }}
              >
                Submit bin
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
// Includes inline "+ Create" affordance for when a counter hits an unknown
// SKU in the field. Counting will surface physical parts that never made it
// into parts_catalog — opening Parts admin / Receive PO to add them mid-count
// would mean exiting the run. Inline create keeps the counter on the bin.
function PartPickerSheet({ onPick, onClose }) {
  const { showToast } = useApp()
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [showCreate, setShowCreate] = useState(false)

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

  if (showCreate) {
    return (
      <CreatePartPanel
        initialQuery={q}
        onCreated={(newPart) => {
          showToast(`Created ${newPart.id}`)
          onPick(newPart)
        }}
        onCancel={() => setShowCreate(false)}
        onClose={onClose}
      />
    )
  }

  const canCreate = q.trim().length >= 2 && !searching

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
            <div style={{ padding: 14, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
              No matches
            </div>
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
          {canCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="add-dashed add-accent"
              style={{ width: '100%', marginTop: results.length > 0 ? 8 : 0 }}
            >
              + Create "{q.trim()}" as new part
            </button>
          )}
        </div>
        <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Inline create-part panel (opened from PartPickerSheet) ────────────
// Minimal form — SKU, name, unit, optional department. is_active=true so
// the part is immediately usable (not a draft). On success, the new part
// is added to the active session's count via onCreated → onPick.
function CreatePartPanel({ initialQuery, onCreated, onCancel, onClose }) {
  const { showToast } = useApp()
  const [sku, setSku] = useState(initialQuery.trim())
  const [name, setName] = useState(initialQuery.trim())
  const [unit, setUnit] = useState('ea')
  const [department, setDepartment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function handleCreate() {
    setError(null)
    if (!sku.trim()) { setError('SKU is required'); return }
    if (!name.trim()) { setError('Name is required'); return }
    setSubmitting(true)
    try {
      const newPart = await createPart({
        id: sku.trim(),
        name: name.trim(),
        unit: unit.trim() || 'ea',
        department: department.trim() || null,
        is_active: true,
      })
      if (!newPart) throw new Error('Create returned no row')
      onCreated(newPart)
    } catch (e) {
      console.error('Create part failed:', e)
      const msg = e.code === '23505'
        ? `SKU "${sku.trim()}" already exists — search for it instead`
        : (e.message || 'Could not create part')
      setError(msg)
      showToast(msg)
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 480 }}>
        <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
          Create new part
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
          Adds to the parts catalog and drops it straight into this bin's count.
        </div>

        <div className="field">
          <label>SKU *</label>
          <input
            type="text"
            value={sku}
            onChange={e => setSku(e.target.value)}
            disabled={submitting}
            autoComplete="off"
            name="new-part-sku"
            style={{ fontFamily: '"DM Mono", monospace' }}
          />
        </div>

        <div className="field">
          <label>Name *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={submitting}
            autoFocus
            autoComplete="off"
            name="new-part-name"
          />
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Unit</label>
            <select value={unit} onChange={e => setUnit(e.target.value)} disabled={submitting}>
              <option value="ea">ea</option>
              <option value="ft">ft</option>
              <option value="m">m</option>
              <option value="box">box</option>
              <option value="roll">roll</option>
              <option value="pair">pair</option>
              <option value="set">set</option>
            </select>
          </div>
          <div className="field" style={{ flex: 2 }}>
            <label>Department (optional)</label>
            <input
              type="text"
              value={department}
              onChange={e => setDepartment(e.target.value)}
              disabled={submitting}
              placeholder="e.g. Aerial"
              autoComplete="off"
              name="new-part-dept"
            />
          </div>
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
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>
            Back
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleCreate}
            disabled={submitting}
          >
            {submitting ? 'Creating…' : 'Create + add to bin'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── End-result screen ─────────────────────────────────────────────────
function EndResultScreen({ run, onDone }) {
  const isPending = run.status === 'pending_review'
  const isBinning = run.is_first_binning
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 56, marginBottom: 12 }}>
        {isBinning ? '🏗️' : (isPending ? '⚠️' : '✅')}
      </div>
      <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6 }}>
        {isBinning ? 'Binning complete' : (isPending ? 'Reconciled — review needed' : 'Reconciled cleanly')}
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', maxWidth: 360, marginBottom: 24, lineHeight: 1.4 }}>
        {isBinning
          ? <>Stock has been transferred from <strong>{run.scope_warehouse?.name}</strong> to each bin you counted. Check the Activity tab to see the transfers; the warehouse's leftover stock represents anything not yet binned.</>
          : isPending
          ? 'Compensating variances within each warehouse were auto-reconciled as internal transfers. The leftovers need your review — open the Count Review queue.'
          : 'Every variance paired with an offsetting one within its warehouse. No manager review needed; all reconciliations are logged as internal transfers.'}
      </div>
      <button className="btn btn-primary" onClick={onDone}>Done</button>
    </div>
  )
}
