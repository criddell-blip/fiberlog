import { useState, useMemo, useEffect } from 'react'
import { calcStrandParts, calcLashingParts, calcStrandFootageParts, mergeParts } from '../../../lib/calculations'
import PartSearch from './PartSearch'
import PartsTally from './PartsTally'

const BOLT_SIZES = ['12', '14', '16']

const POLE_TYPES = [
  { id: 'intermediate', label: 'Intermediate Pole', icon: '🔩' },
  { id: 'terminal', label: 'Terminal Pole', icon: '🏁' },
  { id: 'downGuy', label: 'Down Guy', icon: '📐' },
  { id: 'poleRiser', label: 'Pole Riser', icon: '📦' },
  { id: 'snowshoe', label: 'Snowshoe', icon: '❄️' },
]

const FIBER_OPTIONS = [
  { id: '500-110071F', label: 'R-12-1F — 12ct SM' },
  { id: '500-110071G', label: 'R-12-1G — 12ct SM' },
  { id: '500-110071I', label: 'R-12-1I — 12ct SM' },
  { id: '500-110004F', label: 'R-72-1F — 72ct SM' },
  { id: '500-110004g', label: 'R-72-1G — 72ct SM' },
  { id: '072ZUC-T4F22D20(I)', label: 'R-72-1I — 72ct SM' },
  { id: '500-110092L', label: 'R-144-1L — 144ct SM' },
  { id: '500-10092M', label: 'R-144-1M — 144ct SM' },
  { id: '500-110059I', label: 'R-288-1I — 288ct SM' },
  { id: '500-110059C', label: 'R-288-1C — 288ct SM' },
]

const MST_OPTIONS = [
  { id: 'MST-2P-50', label: 'MST 2P 50ft' },
  { id: 'SKU-Q6XAQDCE', label: 'MST 2P 100ft' },
  { id: 'SKU-S3KZPLZL', label: 'MST 2P 300ft' },
  { id: 'SKU-66K8RIVJ', label: 'MST 2P 400ft' },
  { id: 'SKU-75M9UY9A', label: 'MST 2P 500ft' },
  { id: 'MST-2P-700', label: 'MST 2P 700ft' },
  { id: 'SKU-BDQ5WDMQ', label: 'MST 6P 100ft' },
  { id: 'SKU-U0VH16X7', label: 'MST 6P 300ft' },
  { id: 'SKU-EE3E8I9Q', label: 'MST 6P 500ft' },
  { id: '500-141782', label: 'HST 2P 50ft' },
  { id: 'HST-B2HNB0100NN000', label: 'HST 2P 100ft' },
  { id: '500-1411467', label: 'HST 6P 100ft' },
  { id: '500-141006-0700', label: 'HST 6P 700ft' },
]

export default function AerialWorkspace({ task, sessionId, userId, onPartsChange }) {
  // Pole batches: [{id, type, label, icon, count, boltSize}]
  const [poleBatches, setPoleBatches] = useState([])
  const [showAddPole, setShowAddPole] = useState(false)

  // Add pole batch form
  const [batchType, setBatchType] = useState('intermediate')
  const [batchBoltSize, setBatchBoltSize] = useState('14')
  const [batchCount, setBatchCount] = useState('')

  // Strand footage
  const [strandFt, setStrandFt] = useState('')

  // Lashing
  const [lashFt, setLashFt] = useState('')
  const [lashType, setLashType] = useState('intermediate')
  const [fiberPartId, setFiberPartId] = useState('')

  // MSTs/HSTs
  const [mstItems, setMstItems] = useState([])

  // Extra parts
  const [extraParts, setExtraParts] = useState([])
  const [partOverrides, setPartOverrides] = useState({})

  const [showPartSearch, setShowPartSearch] = useState(false)
  const [showMstPicker, setShowMstPicker] = useState(false)

  function addBatch() {
    if (!batchCount || parseInt(batchCount) <= 0) return
    const poleType = POLE_TYPES.find(p => p.id === batchType)
    const needsBolt = ['intermediate', 'terminal'].includes(batchType)
    setPoleBatches(prev => [...prev, {
      id: Date.now(),
      type: batchType,
      label: poleType.label,
      icon: poleType.icon,
      count: parseInt(batchCount),
      boltSize: needsBolt ? batchBoltSize : null,
    }])
    setBatchCount('')
    setShowAddPole(false)
  }

  function removeBatch(id) {
    setPoleBatches(prev => prev.filter(b => b.id !== id))
  }

  function adjustMst(mst, delta) {
    setMstItems(prev => {
      const existing = prev.find(m => m.id === mst.id)
      if (existing) {
        const newQty = Math.max(0, existing.qty + delta)
        return newQty === 0 ? prev.filter(m => m.id !== mst.id) : prev.map(m => m.id === mst.id ? { ...m, qty: newQty } : m)
      }
      return delta > 0 ? [...prev, { ...mst, qty: 1 }] : prev
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
    const poleEntries = poleBatches.map(b => ({
      type: b.type,
      count: b.count,
      boltOverride: b.boltSize || '14',
    }))

    const strandParts = calcStrandParts(poleEntries)
    const strandFootage = calcStrandFootageParts(parseFloat(strandFt) || 0)
    const lashParts = lashFt ? calcLashingParts(parseFloat(lashFt), lashType, fiberPartId) : []
    const mstParts = mstItems.map(m => ({ id: m.id, name: m.label, unit: 'ea', qty: m.qty }))
    const merged = mergeParts([strandParts, strandFootage, lashParts, mstParts, extraParts])
    return merged
      .filter(p => partOverrides[p.id] !== -1)
      .map(p => partOverrides[p.id] ? { ...p, qty: partOverrides[p.id] } : p)
  }, [poleBatches, strandFt, lashFt, lashType, fiberPartId, mstItems, extraParts, partOverrides])

  useEffect(() => {
    onPartsChange && onPartsChange(calculatedParts)
  }, [calculatedParts])

  // Summary of batches by type
  const batchSummary = poleBatches.reduce((acc, b) => {
    const key = b.type + (b.boltSize || '')
    if (!acc[key]) acc[key] = { ...b, count: 0 }
    acc[key].count += b.count
    return acc
  }, {})

  return (
    <div>
      {/* Strand footage */}
      <div className="sec-label">Strand & Hardware</div>
      <div className="footage-block">
        <div className="footage-label">📏 Strand footage hung</div>
        <div className="footage-input-row">
          <input className="footage-input" type="number" placeholder="0"
            value={strandFt} onChange={e => setStrandFt(e.target.value)} />
          <span className="footage-unit">ft</span>
        </div>
      </div>

      {/* Pole batches logged */}
      {poleBatches.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {poleBatches.map(b => (
            <div key={b.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 14px', background: 'var(--teal-lt)',
              borderRadius: 'var(--r-sm)', marginBottom: 6
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--teal-dk)' }}>
                  {b.icon} {b.count} × {b.label}
                </div>
                {b.boltSize && (
                  <div style={{ fontSize: 11, color: 'var(--teal)' }}>
                    5/8" × {b.boltSize}" bolts
                  </div>
                )}
              </div>
              <button onClick={() => removeBatch(b.id)}
                style={{ color: 'var(--red)', fontSize: 20, background: 'none', border: 'none', cursor: 'pointer' }}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add poles button */}
      <button
        onClick={() => setShowAddPole(true)}
        style={{
          width: '100%', padding: '13px', marginBottom: 16,
          background: 'var(--surface)', border: '1.5px dashed var(--teal)',
          borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 700,
          color: 'var(--teal)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', gap: 8
        }}
      >
        <span style={{ fontSize: 20 }}>＋</span> Add poles
      </button>

      {/* Fiber Lashing */}
      <div className="sec-label">Fiber Lashing</div>
      <div className="footage-block">
        <div className="footage-label">📏 Footage lashed</div>
        <div className="footage-input-row">
          <input className="footage-input" type="number" placeholder="0"
            value={lashFt} onChange={e => setLashFt(e.target.value)} />
          <span className="footage-unit">ft</span>
        </div>
      </div>

      {lashFt && parseFloat(lashFt) > 0 && (
        <>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>Lashing type</div>
            <div className="select-row">
              {['intermediate', 'terminal'].map(t => (
                <button key={t} className={`select-chip${lashType === t ? ' active' : ''}`}
                  onClick={() => setLashType(t)}>
                  {t === 'intermediate' ? 'Intermediate' : 'Terminal'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Fiber part number (reel)</label>
            <select value={fiberPartId} onChange={e => setFiberPartId(e.target.value)}>
              <option value="">— select fiber reel —</option>
              {FIBER_OPTIONS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </div>
        </>
      )}

      {/* MSTs / HSTs */}
      <div className="sec-label" style={{ marginTop: 20 }}>MSTs & HSTs</div>
      {mstItems.map(item => (
        <div key={item.id} className="tally-row">
          <div className="tally-label">{item.label}</div>
          <div className="tally-controls">
            <button className="tally-btn tally-minus" onClick={() => adjustMst(item, -1)}>−</button>
            <div className="tally-count">{item.qty}</div>
            <button className="tally-btn tally-plus" onClick={() => adjustMst(item, 1)}>+</button>
          </div>
        </div>
      ))}
      {!showMstPicker ? (
        <button onClick={() => setShowMstPicker(true)} style={{
          width: '100%', padding: '11px', marginTop: 4,
          background: 'var(--gray-lt)', border: '1.5px dashed var(--border2)',
          borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 600,
          color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
        }}>
          <span style={{ fontSize: 18 }}>＋</span> Add MST or HST
        </button>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 12, marginTop: 4 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Select type</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {MST_OPTIONS.map(mst => (
              <button key={mst.id} className="select-chip"
                onClick={() => { adjustMst(mst, 1); setShowMstPicker(false) }}>
                {mst.label}
              </button>
            ))}
          </div>
          <button style={{ fontSize: 13, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
            onClick={() => setShowMstPicker(false)}>Cancel</button>
        </div>
      )}

      {/* Parts tally */}
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

      <button onClick={() => setShowPartSearch(true)} style={{
        width: '100%', padding: '13px', marginTop: 12,
        background: 'var(--gray-lt)', border: '1.5px dashed var(--border2)',
        borderRadius: 'var(--r-sm)', fontSize: 14, fontWeight: 600,
        color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8
      }}>
        <span style={{ fontSize: 18 }}>＋</span> Add part not listed above
      </button>

      {showPartSearch && <PartSearch onSelect={addExtraPart} onClose={() => setShowPartSearch(false)} />}

      {/* Add poles sheet */}
      {showAddPole && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowAddPole(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 16 }}>Add pole batch</div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Pole type</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {POLE_TYPES.map(pt => (
                  <button key={pt.id}
                    className={`select-chip${batchType === pt.id ? ' active' : ''}`}
                    onClick={() => setBatchType(pt.id)}>
                    {pt.icon} {pt.label}
                  </button>
                ))}
              </div>
            </div>

            {['intermediate', 'terminal'].includes(batchType) && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Bolt size</div>
                <div className="select-row">
                  {BOLT_SIZES.map(s => (
                    <button key={s}
                      className={`select-chip${batchBoltSize === s ? ' active' : ''}`}
                      onClick={() => setBatchBoltSize(s)}>
                      5/8" × {s}"
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="field">
              <label>How many poles?</label>
              <input type="number" placeholder="0" value={batchCount}
                onChange={e => setBatchCount(e.target.value)}
                style={{ fontSize: 28, fontWeight: 800, textAlign: 'center' }}
                autoFocus />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddPole(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2 }}
                onClick={addBatch}
                disabled={!batchCount || parseInt(batchCount) <= 0}>
                Log {batchCount || 0} poles
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
