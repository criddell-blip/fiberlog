import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import ScanInput from '../shared/ScanInput'
import Icon from '../shared/Icon'
import { useBackClose } from '../../lib/backStack'
import { scanFeedback, unlockAudio } from '../../lib/scanFeedback'
import { getLocations, recordMovementsBatch, compareNamesNatural } from '../../lib/inventory'
import { getPartBySku, getBinById, isBinCode, parseBinCode } from '../../lib/cycleCount'

// Scan-to-move — the RC Willey RF-gun "scan stuff to relocate it" flow.
// Three stages: pick a FROM location → scan items onto a move list (camera-
// first, +1 per scan, inline qty steppers) → pick a TO location → commit as
// `transfer` movements (source → destination) in one batch.
//
// Camera-first: a single ScanInput stays mounted; the bottom "Scan" button
// opens its continuous camera. A scanned BIN:<uuid> sets the From/To location
// (in those stages); a scanned SKU adds a move line (in the items stage).
const TYPE_LABEL = { warehouse: 'Warehouse', truck: 'Truck', job_site: 'Project bucket', vendor: 'Vendor', scrap: 'Scrap', bin: 'Bin' }
const TYPE_ICON = { warehouse: 'warehouse', truck: 'truck', job_site: 'pin', vendor: 'warehouse', scrap: 'trash', bin: 'box' }

export default function MoveStockSheet({ onClose, onDone }) {
  const { currentUser, showToast } = useApp()
  const [stage, setStage] = useState('source')   // 'source' | 'items' | 'dest'
  const [locations, setLocations] = useState([])
  const [source, setSource] = useState(null)
  const [dest, setDest] = useState(null)
  const [lines, setLines] = useState([])          // [{ part, qty }]
  const [cameraSignal, setCameraSignal] = useState(0)
  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)

  // Back steps stage → stage, then closes (mirrors the on-screen flow).
  useBackClose(1, () => {
    if (stage === 'dest') setStage('items')
    else if (stage === 'items') setStage('source')
    else onClose()
  })

  useEffect(() => {
    getLocations({ includeBins: true })
      .then(ls => setLocations((ls || []).filter(l => l.is_active !== false)))
      .catch(e => showToast('Could not load locations: ' + e.message))
  }, [])

  function openCamera() { unlockAudio(); setCameraSignal(n => n + 1) }

  async function handleScan(code) {
    try {
      if (isBinCode(code)) {
        const bin = await getBinById(parseBinCode(code))
        if (!bin) { scanFeedback('error'); showToast('Bin not found or inactive'); return }
        if (stage === 'source') { setSource(bin); setStage('items'); setQ(''); scanFeedback('ok'); showToast(`From ${bin.name}`) }
        else if (stage === 'dest') {
          if (bin.id === source?.id) { scanFeedback('error'); showToast('Destination must differ from source'); return }
          setDest(bin); scanFeedback('ok'); showToast(`To ${bin.name}`)
        } else { scanFeedback('error'); showToast('Scan a part here (or a bin in the From/To step)') }
        return
      }
      // Plain SKU — only meaningful in the items stage.
      if (stage !== 'items') { scanFeedback('error'); showToast('Pick or scan a location first'); return }
      const part = await getPartBySku(code.trim())
      if (!part) { scanFeedback('error'); showToast(`Unknown SKU: ${code}`); return }
      setLines(prev => {
        const ex = prev.find(l => l.part.id === part.id)
        if (ex) return prev.map(l => l.part.id === part.id ? { ...l, qty: l.qty + 1 } : l)
        return [...prev, { part, qty: 1 }]
      })
      scanFeedback('ok')
    } catch (e) {
      console.error('Move scan failed:', e)
      scanFeedback('error')
      showToast(e.message || 'Scan failed')
    }
  }

  function setQty(partId, qty) {
    const n = Math.max(0, Number(qty) || 0)
    if (n === 0) { setLines(prev => prev.filter(l => l.part.id !== partId)); return }
    setLines(prev => prev.map(l => l.part.id === partId ? { ...l, qty: n } : l))
  }

  async function commit() {
    if (!source || !dest || lines.length === 0) return
    setSaving(true)
    try {
      await recordMovementsBatch(lines.map(l => ({
        movement_type: 'transfer',
        part_id: l.part.id,
        quantity: l.qty,
        unit: l.part.unit || null,
        from_location_id: source.id,
        to_location_id: dest.id,
        notes: 'Scan-to-move',
        created_by: currentUser?.id,
      })))
      onDone?.(lines.length)
    } catch (e) {
      console.error('Move commit failed:', e)
      showToast(e.message || 'Move failed')
      setSaving(false)
    }
  }

  const totalUnits = lines.reduce((a, l) => a + l.qty, 0)

  // Location list for the source/dest pickers — searchable, type-labeled.
  const locList = (onPick, excludeId, extraFilter = null) => {
    const query = q.trim().toLowerCase()
    const filtered = locations
      .filter(l => l.id !== excludeId)
      .filter(l => !extraFilter || extraFilter(l))
      .filter(l => !query || (l.name || '').toLowerCase().includes(query))
      .sort((a, b) => compareNamesNatural(a.name, b.name))
    return (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>No matching locations</div>
        )}
        {filtered.map(l => (
          <button key={l.id} onClick={() => onPick(l)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', cursor: 'pointer', color: 'var(--text)' }}>
            <span style={{ display: 'inline-flex', color: 'var(--accent-dk)' }}><Icon name={TYPE_ICON[l.type] || 'box'} size={16} /></span>
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>{TYPE_LABEL[l.type] || l.type}</span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="overlay open">
      <div className="overlay-sheet" style={{ maxWidth: 520, height: '88vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header + stage trail */}
        <div style={{ flexShrink: 0, marginBottom: 10 }}>
          <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="move" size={18} /> Move stock
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
            <span style={{ fontWeight: stage === 'source' ? 800 : 400, color: source ? 'var(--accent-dk)' : 'var(--muted)' }}>
              {source ? source.name : 'From…'}
            </span>
            <Icon name="arrow" size={12} />
            <span style={{ fontWeight: stage === 'items' ? 800 : 400 }}>{lines.length || ''} {lines.length ? 'items' : 'items'}</span>
            <Icon name="arrow" size={12} />
            <span style={{ fontWeight: stage === 'dest' ? 800 : 400, color: dest ? 'var(--accent-dk)' : 'var(--muted)' }}>
              {dest ? dest.name : 'To…'}
            </span>
          </div>
        </div>

        {/* Always-mounted scan input (HID + continuous camera via signal) */}
        <div style={{ flexShrink: 0, marginBottom: 10 }}>
          <ScanInput
            onScan={handleScan}
            continuous
            cameraOpenSignal={cameraSignal}
            showCameraButton={false}
            placeholder={stage === 'items' ? 'Scan a part SKU…' : 'Scan a bin (BIN:…) or pick below'}
          />
        </div>

        {/* Stage body */}
        {stage === 'source' && (
          <>
            <input type="text" placeholder="Search locations…" value={q} onChange={e => setQ(e.target.value)} autoFocus autoComplete="off" name="move-src-search"
              style={{ flexShrink: 0, width: '100%', padding: '10px 12px', border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--surface2)', fontSize: 14, marginBottom: 8, color: 'var(--text)' }} />
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', fontWeight: 700, marginBottom: 6, flexShrink: 0 }}>MOVE FROM</div>
            {/* Project (job_site) buckets are accumulate-only — not a valid source. */}
            {locList(l => { setSource(l); setStage('items'); setQ('') }, undefined, l => l.type !== 'job_site')}
          </>
        )}

        {stage === 'items' && (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {lines.length === 0 && (
              <div style={{ textAlign: 'center', padding: 30, color: 'var(--hint)', fontSize: 'var(--fs-sm)' }}>
                Scan the parts you're moving from <strong>{source?.name}</strong>. Each scan adds one.
              </div>
            )}
            {lines.map(l => (
              <div key={l.part.id} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.part.name || l.part.id}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>{l.part.id}</div>
                </div>
                <button onClick={() => setQty(l.part.id, l.qty - 1)} className="btn btn-ghost" style={{ width: 34, height: 34, padding: 0, fontSize: 18, flexShrink: 0 }}>−</button>
                <span className="mono" style={{ minWidth: 34, textAlign: 'center', fontSize: 17, fontWeight: 800 }}>{l.qty}</span>
                <button onClick={() => setQty(l.part.id, l.qty + 1)} className="btn btn-ghost" style={{ width: 34, height: 34, padding: 0, fontSize: 18, flexShrink: 0 }}>+</button>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', minWidth: 18 }}>{l.part.unit || 'ea'}</span>
              </div>
            ))}
          </div>
        )}

        {stage === 'dest' && (
          <>
            <input type="text" placeholder="Search locations…" value={q} onChange={e => setQ(e.target.value)} autoFocus autoComplete="off" name="move-dst-search"
              style={{ flexShrink: 0, width: '100%', padding: '10px 12px', border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--surface2)', fontSize: 14, marginBottom: 8, color: 'var(--text)' }} />
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', fontWeight: 700, marginBottom: 6, flexShrink: 0 }}>MOVE {totalUnits} UNIT{totalUnits === 1 ? '' : 'S'} TO</div>
            {locList(l => setDest(l), source?.id)}
          </>
        )}

        {/* Footer action bar */}
        <div style={{ flexShrink: 0, display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border)', marginTop: 10 }}>
          <button onClick={openCamera} className="btn btn-primary" style={{ flex: 1, padding: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <Icon name="camera" size={18} /> Scan
          </button>
          {stage === 'source' && (
            <button onClick={onClose} className="btn btn-ghost" style={{ flex: 1, padding: '12px' }}>Cancel</button>
          )}
          {stage === 'items' && (
            <button onClick={() => { setStage('dest'); setQ('') }} className="btn btn-primary" style={{ flex: 2, padding: '12px' }} disabled={lines.length === 0}>
              Choose destination →
            </button>
          )}
          {stage === 'dest' && (
            <button onClick={commit} className="btn btn-primary" style={{ flex: 2, padding: '12px' }} disabled={!dest || saving}>
              {saving ? 'Moving…' : `Move ${lines.length} item${lines.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
