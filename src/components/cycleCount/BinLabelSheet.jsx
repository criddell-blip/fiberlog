import { useEffect, useState, useRef } from 'react'
import QRCode from 'qrcode'
import { formatBinCode } from '../../lib/cycleCount'
import { getBinsForWarehouse } from '../../lib/inventory'

// Print bin labels for stuck-on-the-shelf scanning. Generates a QR code
// encoding `BIN:<uuid>` per bin, plus the bin name in large readable type
// and the parent warehouse name as a sub-line. Tiled 4-per-page on US
// letter (good size for shelves; readable from a few feet away).
//
// Print mode hides the rest of the app and laser-prints just the labels.
// Worker cuts on the dashed borders and sticks them on.
//
// Used from InventoryLocationsTab — "Print labels" button on the bins
// section of each warehouse expansion.
export default function BinLabelSheet({ warehouse, onClose }) {
  const [bins, setBins] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [qrCache, setQrCache] = useState({})  // binId → data URL

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const b = await getBinsForWarehouse(warehouse.id)
        if (cancelled) return
        setBins(b)
        // Default selection: all bins
        setSelected(new Set(b.map(x => x.id)))
        // Pre-generate QR codes
        const cache = {}
        for (const bin of b) {
          cache[bin.id] = await QRCode.toDataURL(formatBinCode(bin.id), {
            errorCorrectionLevel: 'M',
            margin: 1,
            scale: 8,
          })
        }
        if (!cancelled) setQrCache(cache)
      } catch (e) {
        console.error('Bin load failed:', e)
        if (!cancelled) setError(e.message || 'Could not load bins')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [warehouse.id])

  function toggle(binId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(binId)) next.delete(binId)
      else next.add(binId)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(bins.map(b => b.id)))
  }
  function selectNone() {
    setSelected(new Set())
  }

  function handlePrint() {
    window.print()
  }

  const labelsToPrint = bins.filter(b => selected.has(b.id))

  return (
    <>
      {/* Print-only stylesheet — hides everything except .print-labels when printing */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .print-labels, .print-labels * { visibility: visible !important; }
          .print-labels {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
          }
          .no-print { display: none !important; }
          @page { margin: 0.4in; }
        }
      `}</style>

      <div
        className="overlay open no-print"
        onClick={e => e.target === e.currentTarget && onClose()}
      >
        <div className="overlay-sheet" style={{ maxWidth: 720 }}>
          <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
            Print bin labels
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            Each label has a QR encoding <code style={{ fontFamily: '"DM Mono", monospace', fontSize: 'var(--fs-xs)' }}>BIN:&lt;uuid&gt;</code>.
            Cut on the dashed borders, stick on shelves. Both USB scanners and
            the phone camera read these.
          </div>

          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
              Loading bins + generating QR codes…
            </div>
          )}

          {error && (
            <div className="banner banner-danger" style={{
              borderRadius: 'var(--r-sm)', borderBottom: 'none',
              border: '1px solid var(--danger-border)', marginBottom: 14,
            }}>
              <span className="banner-icon">⚠️</span>
              <div className="banner-body">{error}</div>
            </div>
          )}

          {!loading && !error && bins.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)' }}>
              No bins in <strong>{warehouse.name}</strong> yet. Add some in the Locations tab first.
            </div>
          )}

          {!loading && !error && bins.length > 0 && (
            <>
              {/* Selection controls */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 0', marginBottom: 8,
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {selected.size} of {bins.length} selected
                </div>
                <button onClick={selectAll} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  All
                </button>
                <button onClick={selectNone} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  None
                </button>
              </div>

              {/* Bin checklist */}
              <div style={{ maxHeight: 240, overflowY: 'auto', marginBottom: 14 }}>
                {bins.map(bin => (
                  <label key={bin.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 4px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <input
                      type="checkbox"
                      checked={selected.has(bin.id)}
                      onChange={() => toggle(bin.id)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ flex: 1, fontSize: 'var(--fs-base)' }}>{bin.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
                      {bin.id.slice(0, 8)}…
                    </span>
                  </label>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
                <button
                  className="btn btn-primary"
                  style={{ flex: 2 }}
                  onClick={handlePrint}
                  disabled={labelsToPrint.length === 0}
                >
                  🖨 Print {labelsToPrint.length} label{labelsToPrint.length === 1 ? '' : 's'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Printable layout — visible only when window.print() fires */}
      <div className="print-labels" style={{ display: labelsToPrint.length === 0 ? 'none' : 'block' }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
          width: '100%',
          color: 'black',
          background: 'white',
        }}>
          {labelsToPrint.map(bin => (
            <div key={bin.id} style={{
              border: '1px dashed #888',
              padding: '0.3in',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '2.4in',
              textAlign: 'center',
              breakInside: 'avoid',
              pageBreakInside: 'avoid',
            }}>
              <div style={{
                fontSize: 18, fontWeight: 800,
                marginBottom: 4,
                wordBreak: 'break-word',
              }}>
                {bin.name}
              </div>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 8 }}>
                {warehouse.name}
              </div>
              {qrCache[bin.id] && (
                <img
                  src={qrCache[bin.id]}
                  alt={`QR for ${bin.name}`}
                  style={{ width: '1.5in', height: '1.5in' }}
                />
              )}
              <div style={{
                fontSize: 8, color: '#888',
                fontFamily: 'monospace',
                marginTop: 6,
                wordBreak: 'break-all',
              }}>
                BIN:{bin.id}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
