import { useState, useMemo, useEffect } from 'react'
import { calcSpliceParts, mergeParts } from '../../../lib/calculations'
import PartSearch from './PartSearch'
import PartsTally from './PartsTally'

const CLOSURE_TYPES = [
  { id: 'A4', label: 'A4 Closure', icon: '🔴', sub: 'OFDC-A4 Splice/Patch' },
  { id: 'C6', label: 'C6 Closure', icon: '🟡', sub: 'FOSC450-C6-6-NT' },
  { id: 'D6', label: 'D6 Closure', icon: '🔵', sub: 'FOSC450-D6, No Tray' },
]

const TRAY_COUNTS = { A4: 0, C6: 4, D6: 0 } // defaults

const SPLITTER_TYPES = [
  { id: '1x2', label: '1×2 Splitter' },
  { id: '1x4', label: '1×4 Splitter' },
  { id: '1x8', label: '1×8 Splitter' },
]

export default function SpliceWorkspace({ task, sessionId, userId, onPartsChange }) {
  const [closures, setClosures] = useState([])
  // closures: [{type, count, trays}]
  const [splitters, setSplitters] = useState([])
  const [extraParts, setExtraParts] = useState([])
  const [showPartSearch, setShowPartSearch] = useState(false)
  const [partOverrides, setPartOverrides] = useState({}) // id -> qty override, -1 = removed

  function getClosureEntry(type) {
    return closures.find(c => c.type === type) || { type, count: 0, trays: TRAY_COUNTS[type] }
  }

  function adjustClosure(type, delta) {
    setClosures(prev => {
      const existing = prev.find(c => c.type === type)
      if (existing) {
        const newCount = Math.max(0, existing.count + delta)
        return newCount === 0
          ? prev.filter(c => c.type !== type)
          : prev.map(c => c.type === type ? { ...c, count: newCount } : c)
      }
      return delta > 0 ? [...prev, { type, count: 1, trays: TRAY_COUNTS[type] }] : prev
    })
  }

  function setTrays(type, trays) {
    setClosures(prev => {
      const existing = prev.find(c => c.type === type)
      if (existing) return prev.map(c => c.type === type ? { ...c, trays: parseInt(trays) || 0 } : c)
      return prev
    })
  }

  function adjustSplitter(type, delta) {
    setSplitters(prev => {
      const existing = prev.find(s => s.type === type)
      if (existing) {
        const newCount = Math.max(0, existing.count + delta)
        return newCount === 0
          ? prev.filter(s => s.type !== type)
          : prev.map(s => s.type === type ? { ...s, count: newCount } : s)
      }
      return delta > 0 ? [...prev, { type, count: 1 }] : prev
    })
  }

  function addExtraPart(part) {
    setExtraParts(prev => {
      const existing = prev.find(p => p.id === part.id)
      if (existing) return prev.map(p => p.id === part.id ? { ...p, qty: p.qty + 1 } : p)
      return [...prev, { ...part, qty: 1 }]
    })
    setShowPartSearch(false)
  }

  const calculatedParts = useMemo(() => {
    const spliceParts = calcSpliceParts(closures, splitters)
    const merged = mergeParts([spliceParts, extraParts])
    // Apply overrides — remove or adjust quantities
    return merged
      .filter(p => partOverrides[p.id] !== -1)
      .map(p => partOverrides[p.id] ? { ...p, qty: partOverrides[p.id] } : p)
  }, [closures, splitters, extraParts, partOverrides])

  // Bubble calculated parts up to TaskWorkspace for submission
  useEffect(() => {
    onPartsChange && onPartsChange(calculatedParts)
  }, [calculatedParts])

  const totalCases = closures.reduce((a, c) => a + c.count, 0)

  return (
    <div>
      {/* ── Closures ── */}
      <div className="sec-label">Splice Closures</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
        Log each closure type and number of trays used
      </div>

      {CLOSURE_TYPES.map(ct => {
        const entry = getClosureEntry(ct.id)
        const active = entry.count > 0
        return (
          <div key={ct.id} className="card" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{ct.icon}</span>
                  <div>
                    <div className="tally-label">{ct.label}</div>
                    <div className="tally-sub">{ct.sub}</div>
                  </div>
                </div>
              </div>
              <div className="tally-controls">
                {active && (
                  <>
                    <button className="tally-btn tally-minus" onClick={() => adjustClosure(ct.id, -1)}>−</button>
                    <div className="tally-count">{entry.count}</div>
                  </>
                )}
                <button
                  className={`tally-btn ${active ? 'tally-plus' : 'tally-plus-big'}`}
                  onClick={() => adjustClosure(ct.id, 1)}
                >+</button>
              </div>
            </div>

            {/* Tray count — only show when closure is active */}
            {active && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>
                  Trays per closure
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[0, 1, 2, 3, 4, 5, 6].map(n => (
                    <button
                      key={n}
                      className={`select-chip${entry.trays === n ? ' active' : ''}`}
                      onClick={() => setTrays(ct.id, n)}
                      style={{ minWidth: 36 }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                  Total trays: {entry.trays * entry.count}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* ── Splitters ── */}
      <div className="sec-label" style={{ marginTop: 20 }}>Splitters</div>

      {SPLITTER_TYPES.map(st => {
        const entry = splitters.find(s => s.type === st.id)
        const qty = entry?.count || 0
        return (
          <div key={st.id} className="tally-row">
            <div className="tally-label">{st.label}</div>
            <div className="tally-controls">
              {qty > 0 && (
                <>
                  <button className="tally-btn tally-minus" onClick={() => adjustSplitter(st.id, -1)}>−</button>
                  <div className="tally-count">{qty}</div>
                </>
              )}
              <button
                className={`tally-btn ${qty > 0 ? 'tally-plus' : 'tally-plus-big'}`}
                onClick={() => adjustSplitter(st.id, 1)}
              >+</button>
            </div>
          </div>
        )
      })}

      {/* ── Parts Tally ── */}
      {calculatedParts.length > 0 && (
        <>
          <div className="sec-label" style={{ marginTop: 20 }}>Parts for today</div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {totalCases} closure{totalCases !== 1 ? 's' : ''} · auto-calculated
          </div>
          <PartsTally
            parts={calculatedParts}
            onUpdate={(id, qty) => setPartOverrides(prev => ({ ...prev, [id]: qty }))}
            onRemove={(id) => setPartOverrides(prev => ({ ...prev, [id]: -1 }))}
          />
        </>
      )}

      {/* ── Extra Parts ── */}
      <button onClick={() => setShowPartSearch(true)} className="add-dashed" style={{ marginTop: 12 }}>
        <span style={{ fontSize: 18 }}>＋</span>
        Add splice part not listed
      </button>

      {showPartSearch && (
        <PartSearch
          onSelect={addExtraPart}
          onClose={() => setShowPartSearch(false)}
          filter="Splice"
        />
      )}
    </div>
  )
}
