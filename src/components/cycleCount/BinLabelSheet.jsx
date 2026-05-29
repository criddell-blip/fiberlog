import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { formatBinCode } from '../../lib/cycleCount'
import { getBinsForWarehouse } from '../../lib/inventory'

// Print bin labels for stuck-on-the-shelf scanning. Generates a QR code
// encoding `BIN:<uuid>` per bin, plus the bin name in large readable type
// and the parent warehouse name as a sub-line.
//
// Format picker mirrors SkuLabelSheet — two flavors:
//   • Labels (letter_4up / letter_8up) — bigger, stick-on-shelf labels.
//   • Scan sheets (scan_sheet_*) — dense reference page. Print one, clip
//     to a board, scan from there instead of walking the floor.
//
// BIN:<uuid> payload is ~40 chars so QR size lower-bound is ~0.7in for
// reliable camera scanning. Don't go below that without testing.
//
// Used from InventoryLocationsTab + LocationDetailPanel.
const FORMAT_PRESETS = {
  letter_4up: {
    label: 'Label — US Letter, 4 per page',
    description: 'Stick-on-shelf labels, ~3.5×4.5 in each. Readable from a few feet.',
    pageMargin: '0.4in',
    columns: 2,
    rows: 2,
    qrSize: '1.5in',
    nameFontPx: 18,
    subFontPx: 10,
    idFontPx: 8,
    minHeight: '4.5in',
    showSub: true,
  },
  letter_8up: {
    label: 'Label — US Letter, 8 per page',
    description: 'Denser stick-on labels, ~3.5×2.2 in each. Good for narrow shelves.',
    pageMargin: '0.4in',
    columns: 2,
    rows: 4,
    qrSize: '1.1in',
    nameFontPx: 13,
    subFontPx: 9,
    idFontPx: 6,
    minHeight: '2.2in',
    showSub: true,
  },
  scan_sheet_30: {
    label: 'Scan sheet — 30 per page',
    description: 'Reference sheet. Clip to a board, scan from anywhere. Bin name + warehouse.',
    pageMargin: '0.35in',
    columns: 5,
    rows: 6,
    qrSize: '1in',
    nameFontPx: 9,
    subFontPx: 7,
    idFontPx: 0,
    minHeight: '1.55in',
    showSub: true,
  },
  scan_sheet_60: {
    label: 'Scan sheet — 60 per page (densest)',
    description: 'Maximum bin density. Short bin name + QR only. Print 1-2 pages, every bin in your warehouse covered.',
    pageMargin: '0.25in',
    columns: 6,
    rows: 10,
    qrSize: '0.7in',
    nameFontPx: 7,
    subFontPx: 0,
    idFontPx: 0,
    // Tight: 10 rows × 0.85in = 8.5in. Leaves ~2in for browser headers
    // /footers, which Chrome adds by default and the user can't always
    // turn off without "More settings" → uncheck.
    minHeight: '0.85in',
    showSub: false,
  },
}

export default function BinLabelSheet({ warehouse, onClose }) {
  const [format, setFormat] = useState('letter_4up')
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

  const preset = FORMAT_PRESETS[format]
  const labelsToPrint = bins.filter(b => selected.has(b.id))

  return (
    <>
      {/* Print-only stylesheet. The print-labels element is rendered to
          body via Portal so it's a direct child of body. In print mode we
          hide every direct child of body EXCEPT the portal — that way the
          labels flow naturally across pages instead of getting clipped
          by position:absolute (the old approach broke pagination past
          the first page). */}
      <style>{`
        .print-labels-portal { display: none; }
        @media print {
          body > *:not(.print-labels-portal) { display: none !important; }
          .print-labels-portal { display: block !important; }
          @page { size: letter; margin: ${preset.pageMargin}; }
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
            Both USB scanners and the phone camera read these.
          </div>

          {/* Format picker — labels for stick-on, scan sheets for clipboard reference */}
          <div className="field">
            <label>Format</label>
            <select value={format} onChange={e => setFormat(e.target.value)} style={{ width: '100%' }}>
              {Object.entries(FORMAT_PRESETS).map(([key, p]) => (
                <option key={key} value={key}>{p.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', marginTop: 4 }}>
              {preset.description}
            </div>
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

      {/* Printable layout — rendered to body via Portal so it flows
          naturally across pages in print mode. Hidden on screen by the
          .print-labels-portal default; revealed in @media print. */}
      {labelsToPrint.length > 0 && createPortal(
        <div className="print-labels-portal">
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${preset.columns}, 1fr)`,
            gap: 0,
            width: '100%',
            color: 'black',
            background: 'white',
          }}>
            {labelsToPrint.map(bin => (
              <div key={bin.id} style={{
                border: '1px dashed #888',
                padding: format === 'scan_sheet_60' ? '0.04in' : '0.15in',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: preset.minHeight,
                textAlign: 'center',
                breakInside: 'avoid',
                pageBreakInside: 'avoid',
              }}>
                <div style={{
                  fontSize: preset.nameFontPx, fontWeight: 800,
                  lineHeight: 1.15,
                  marginBottom: 3,
                  wordBreak: 'break-word',
                  maxWidth: '100%',
                }}>
                  {bin.name}
                </div>
                {preset.showSub && preset.subFontPx > 0 && (
                  <div style={{ fontSize: preset.subFontPx, color: '#666', marginBottom: 5 }}>
                    {warehouse.name}
                  </div>
                )}
                {qrCache[bin.id] && (
                  <img
                    src={qrCache[bin.id]}
                    alt={`QR for ${bin.name}`}
                    style={{ width: preset.qrSize, height: preset.qrSize }}
                  />
                )}
                {preset.idFontPx > 0 && (
                  <div style={{
                    fontSize: preset.idFontPx, color: '#888',
                    fontFamily: 'monospace',
                    marginTop: 4,
                    wordBreak: 'break-all',
                    maxWidth: '100%',
                    lineHeight: 1.1,
                  }}>
                    BIN:{bin.id}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
