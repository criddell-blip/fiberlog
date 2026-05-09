import { useState, useMemo, useEffect } from 'react'
import { calcUndergroundParts, mergeParts } from '../../../lib/calculations'
import PartSearch from './PartSearch'
import PartsTally from './PartsTally'

const CONDUIT_TYPES = [
  { id: 'Conduit 2"', label: '2" Conduit', unit: 'ft' },
  { id: 'Conduit 3"', label: '3" Conduit', unit: 'ft' },
  { id: 'Conduit 1 1/4"', label: '1-1/4" Conduit', unit: 'ft' },
  { id: 'Conduit 1 1/2"', label: '1-1/2" Conduit', unit: 'ft' },
]

const STRUCTURE_TYPES = [
  { id: 'handhole_plastic', label: 'Handhole — Plastic 14"×19"', icon: '🔲' },
  { id: 'handhole_poly', label: 'Handhole — Poly Concrete 13×24', icon: '⬛' },
  { id: 'vault_large', label: 'Vault — Poly Concrete 17×30×18', icon: '🏗️' },
]

const PLACEMENT_METHODS = [
  { id: 'bore', label: 'Directional Bore', icon: '⚙️' },
  { id: 'plow', label: 'Plow / Direct Bury', icon: '🚜' },
  { id: 'trench', label: 'Trench', icon: '⛏️' },
]

export default function UndergroundWorkspace({ task, sessionId, userId, onPartsChange }) {
  // Bore entries [{method, footage, conduitId, conduitName}]
  const [entries, setEntries] = useState([])
  const [structures, setStructures] = useState({})
  const [extraParts, setExtraParts] = useState([])
  const [showPartSearch, setShowPartSearch] = useState(false)
  const [partOverrides, setPartOverrides] = useState({})

  // New entry form
  const [method, setMethod] = useState('bore')
  const [footage, setFootage] = useState('')
  const [conduitType, setConduitType] = useState(CONDUIT_TYPES[0])

  function addEntry() {
    if (!footage || parseFloat(footage) <= 0) return
    setEntries(prev => [...prev, {
      method,
      footage: parseFloat(footage),
      conduitId: conduitType.id,
      conduitName: conduitType.label,
    }])
    setFootage('')
  }

  function removeEntry(i) {
    setEntries(prev => prev.filter((_, idx) => idx !== i))
  }

  function adjustStructure(type, delta) {
    setStructures(prev => ({
      ...prev,
      [type]: Math.max(0, (prev[type] || 0) + delta)
    }))
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
    const boreEntries = entries.filter(e => e.method === 'bore')
    const placeEntries = entries.filter(e => e.method !== 'bore')
    const structureList = Object.entries(structures)
      .filter(([, count]) => count > 0)
      .map(([type, count]) => ({ type, count }))

    const ugParts = calcUndergroundParts(boreEntries, placeEntries, structureList)
    const merged = mergeParts([ugParts, extraParts])
    return merged.filter(p => partOverrides[p.id] !== -1).map(p => partOverrides[p.id] ? { ...p, qty: partOverrides[p.id] } : p)
  }, [entries, structures, extraParts, partOverrides])

  // Bubble calculated parts up to TaskWorkspace for submission
  useEffect(() => {
    onPartsChange && onPartsChange(calculatedParts)
  }, [calculatedParts])

  const totalFootage = entries.reduce((a, e) => a + e.footage, 0)

  return (
    <div>
      {/* ── Add footage entry ── */}
      <div className="sec-label">Underground Work</div>

      <div className="card" style={{ marginBottom: 12 }}>
        {/* Method */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>
            Placement method
          </div>
          <div className="select-row">
            {PLACEMENT_METHODS.map(m => (
              <button
                key={m.id}
                className={`select-chip${method === m.id ? ' active' : ''}`}
                onClick={() => setMethod(m.id)}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Conduit type */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>
            Conduit type
          </div>
          <div className="select-row">
            {CONDUIT_TYPES.map(c => (
              <button
                key={c.id}
                className={`select-chip${conduitType.id === c.id ? ' active' : ''}`}
                onClick={() => setConduitType(c)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Footage */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>
              Footage
            </div>
            <div className="footage-input-row">
              <input
                className="footage-input"
                type="number"
                placeholder="0"
                value={footage}
                onChange={e => setFootage(e.target.value)}
                style={{ fontSize: 20 }}
              />
              <span className="footage-unit">ft</span>
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={addEntry}
            disabled={!footage || parseFloat(footage) <= 0}
            style={{ padding: '11px 20px', flexShrink: 0 }}
          >
            Log it
          </button>
        </div>
      </div>

      {/* Logged entries */}
      {entries.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {entries.length} run{entries.length !== 1 ? 's' : ''} logged · {totalFootage.toLocaleString()} ft total
          </div>
          {entries.map((e, i) => (
            <div key={i} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', background: 'var(--teal-lt)', borderRadius: 'var(--r-sm)',
              marginBottom: 6
            }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--teal-dk)' }}>
                  {e.footage.toLocaleString()} ft — {e.conduitName}
                </div>
                <div style={{ fontSize: 11, color: 'var(--teal)' }}>
                  {PLACEMENT_METHODS.find(m => m.id === e.method)?.label}
                </div>
              </div>
              <button onClick={() => removeEntry(i)} style={{ color: 'var(--red)', fontSize: 18 }}>×</button>
            </div>
          ))}
        </>
      )}

      {/* ── Structures ── */}
      <div className="sec-label" style={{ marginTop: 20 }}>Structures Placed</div>

      {STRUCTURE_TYPES.map(st => {
        const qty = structures[st.id] || 0
        return (
          <div key={st.id} className="tally-row">
            <div>
              <div className="tally-label">{st.icon} {st.label}</div>
            </div>
            <div className="tally-controls">
              {qty > 0 && (
                <>
                  <button className="tally-btn tally-minus" onClick={() => adjustStructure(st.id, -1)}>−</button>
                  <div className="tally-count">{qty}</div>
                </>
              )}
              <button
                className={`tally-btn ${qty > 0 ? 'tally-plus' : 'tally-plus-big'}`}
                onClick={() => adjustStructure(st.id, 1)}
              >+</button>
            </div>
          </div>
        )
      })}

      {/* ── Parts Tally ── */}
      {calculatedParts.length > 0 && (
        <>
          <div className="sec-label" style={{ marginTop: 20 }}>Running parts tally</div>
          <PartsTally
            parts={calculatedParts}
            onUpdate={(id, qty) => setPartOverrides(prev => ({ ...prev, [id]: qty }))}
            onRemove={(id) => setPartOverrides(prev => ({ ...prev, [id]: -1 }))}
          />
        </>
      )}

      <button
        onClick={() => setShowPartSearch(true)}
        style={{
          width: '100%', padding: '13px', marginTop: 12,
          background: 'var(--gray-lt)', border: '1.5px dashed var(--border2)',
          borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 600,
          color: 'var(--muted)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8
        }}
      >
        <span style={{ fontSize: 18 }}>＋</span>
        Add part not listed
      </button>

      {showPartSearch && (
        <PartSearch
          onSelect={addExtraPart}
          onClose={() => setShowPartSearch(false)}
          filter="Underground"
        />
      )}
    </div>
  )
}
