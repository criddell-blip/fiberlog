import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'

// Printable labels for parts. Each label = name + SKU + QR encoding the SKU
// directly. Stick on product packaging when received; scan during cycle
// counting to confirm "yes this is Part X" without typing.
//
// Used from:
//   - Parts tab: select N parts → "🏷 Print labels"
//   - Receive PO sheet: post-save offer for just-received items
//   - Stock tab: print labels for parts at a chosen location
//
// Format picker has three presets — choose at print time:
//   - US Letter 4-up: plain paper, 4 per page, generous size
//   - Avery 5163 (10/page, 2×4 in): standard pre-cut adhesive labels
//   - Avery 5160 (30/page, 1×2 5/8 in): smaller labels for tiny parts
//
// Same print-CSS trick as BinLabelSheet: @media print hides everything
// except .print-labels, page margins via @page.
// Two flavors of preset:
//   • Labels (letter_4up / avery_*) — peel-and-stick or hand-cut, stuck on
//     parts. Bigger QR, more whitespace.
//   • Scan sheets (scan_sheet_*) — reference page for the warehouse; clip
//     to a board and scan from there instead of walking to each part.
//     Denser, smaller QR. Tested down to ~0.55in (camera scanning is
//     comfortable to ~0.5in with errorCorrectionLevel='M').
const FORMAT_PRESETS = {
  letter_4up: {
    label: 'Label — US Letter, 4 per page',
    description: 'Plain paper, ~3.5×5 in per label, generous size.',
    pageMargin: '0.4in',
    columns: 2,
    rows: 2,
    qrSize: '1.5in',
    nameFontPx: 16,
    skuFontPx: 9,
    minHeight: '4.5in',
    showName: true,
  },
  avery_5163: {
    label: 'Label — Avery 5163, 10 per page (2×4 in)',
    description: 'Pre-cut adhesive labels, peel-and-stick.',
    pageMargin: '0.5in 0.155in',  // top/bottom 0.5in, left/right 0.155in
    columns: 2,
    rows: 5,
    qrSize: '0.95in',
    nameFontPx: 11,
    skuFontPx: 7,
    minHeight: '2in',
    showName: true,
  },
  avery_5160: {
    label: 'Label — Avery 5160, 30 per page (1×2 5/8 in)',
    description: 'Small address-label sized; tight fit, for small parts.',
    pageMargin: '0.5in 0.19in',
    columns: 3,
    rows: 10,
    qrSize: '0.7in',
    nameFontPx: 8,
    skuFontPx: 6,
    minHeight: '1in',
    showName: true,
  },
  scan_sheet_60: {
    label: 'Scan sheet — 60 per page',
    description: 'Reference sheet for the warehouse. Clip to a board, scan from anywhere. Name + SKU shown.',
    pageMargin: '0.25in',
    columns: 6,
    rows: 10,
    qrSize: '0.78in',
    nameFontPx: 7,
    skuFontPx: 6,
    minHeight: '0.85in',
    showName: true,
  },
  scan_sheet_120: {
    label: 'Scan sheet — 120 per page (densest)',
    description: 'Maximum density. SKU + QR only, no part name. For when you want every SKU on one sheet.',
    pageMargin: '0.2in',
    columns: 8,
    rows: 15,
    qrSize: '0.55in',
    nameFontPx: 0,
    skuFontPx: 5,
    minHeight: '0.6in',
    showName: false,
  },
}

export default function SkuLabelSheet({ parts, title = 'Print SKU labels', onClose }) {
  // parts is an array of { id, name, unit?, ... } objects
  const [format, setFormat] = useState('letter_4up')
  const [selected, setSelected] = useState(() => new Set((parts || []).map(p => p.id)))
  const [qrCache, setQrCache] = useState({})  // partId → data URL
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const cache = {}
      for (const p of (parts || [])) {
        if (!p?.id) continue
        cache[p.id] = await QRCode.toDataURL(p.id, {
          errorCorrectionLevel: 'M',
          margin: 1,
          scale: 6,
        })
      }
      if (!cancelled) {
        setQrCache(cache)
        setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [parts])

  function toggle(partId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(partId)) next.delete(partId)
      else next.add(partId)
      return next
    })
  }

  function selectAll()  { setSelected(new Set((parts || []).map(p => p.id))) }
  function selectNone() { setSelected(new Set()) }

  function handlePrint() { window.print() }

  const preset = FORMAT_PRESETS[format]
  const labelsToPrint = (parts || []).filter(p => selected.has(p.id))

  return (
    <>
      {/* Print-labels rendered to body via Portal so multi-page output
          flows naturally instead of getting clipped by position:absolute. */}
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
            {title}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            Each label has the part name, SKU, and a QR code encoding the SKU.
            Stick on product packaging; scan during cycle counts to confirm parts.
          </div>

          {/* Format picker */}
          <div className="field">
            <label>Label format</label>
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
              Generating QR codes…
            </div>
          )}

          {!loading && (parts || []).length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)' }}>
              No parts to label.
            </div>
          )}

          {!loading && (parts || []).length > 0 && (
            <>
              {/* Selection controls */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 0', marginBottom: 8,
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {selected.size} of {(parts || []).length} selected
                </div>
                <button onClick={selectAll} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  All
                </button>
                <button onClick={selectNone} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  None
                </button>
              </div>

              {/* Part checklist */}
              <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 14 }}>
                {(parts || []).map(p => (
                  <label key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 4px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ flex: 1, fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.name || p.id}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
                      {p.id}
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

      {/* Printable layout — rendered to body via Portal so multi-page
          output flows naturally instead of getting clipped. */}
      {labelsToPrint.length > 0 && createPortal(
        <div className="print-labels-portal">
          {/* Flex-wrap instead of CSS grid — Chrome's print engine
              doesn't paginate display:grid past one page. Flex-wrap
              with explicit cell widths flows naturally. */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            width: '100%',
            color: 'black',
            background: 'white',
          }}>
            {labelsToPrint.map(p => (
              <div key={p.id} style={{
                flex: `0 0 calc(100% / ${preset.columns})`,
                maxWidth: `calc(100% / ${preset.columns})`,
                border: '1px dashed #999',
                padding: format === 'avery_5160' || format === 'scan_sheet_120' ? '0.04in' : '0.1in',
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
                {preset.showName && (
                  <div style={{
                    fontSize: preset.nameFontPx,
                    fontWeight: 700,
                    lineHeight: 1.15,
                    marginBottom: 3,
                    wordBreak: 'break-word',
                    maxWidth: '100%',
                  }}>
                    {p.name || p.id}
                  </div>
                )}
                {qrCache[p.id] && (
                  <img
                    src={qrCache[p.id]}
                    alt={`QR for ${p.id}`}
                    style={{ width: preset.qrSize, height: preset.qrSize }}
                  />
                )}
                <div style={{
                  fontSize: preset.skuFontPx,
                  color: '#444',
                  fontFamily: 'monospace',
                  marginTop: 3,
                  wordBreak: 'break-all',
                  maxWidth: '100%',
                  lineHeight: 1.1,
                }}>
                  {p.id}
                </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
