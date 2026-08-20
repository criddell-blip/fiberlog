import QrLabelSheet from '../shared/QrLabelSheet'

// Printable labels for parts. Each label = name + SKU + QR encoding the SKU
// directly. Stick on product packaging when received; scan during cycle
// counting to confirm "yes this is Part X" without typing.
//
// Thin config wrapper around the shared QrLabelSheet chassis (which owns
// the print-portal technique + Chrome pagination workarounds).
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
// Two flavors of preset:
//   • Labels (letter_4up / avery_*) — peel-and-stick or hand-cut, stuck on
//     parts. Bigger QR, more whitespace.
//   • Scan sheets (scan_sheet_*) — reference page for the warehouse; clip
//     to a board and scan from there instead of walking to each part.
//     Denser, smaller QR. Tested down to ~0.55in (camera scanning is
//     comfortable to ~0.5in with errorCorrectionLevel='M').
//
// Bands (Aug 2026): a label prints a top stripe when the part is a
// REFURBISHED twin (`refurb_of` set — used unit, Sage UB…_R) or an EXPENSED
// non-inventory item (Sage id `UB_9…` — written off on receipt, not cycle
// counted). The owner wants both identifiable on the shelf; the band only
// renders when the caller passes `refurb_of` / `sage_id` on the item, so
// callers that pass the bare {id, name, unit} shape print exactly as before.
// The dense scan-sheet preset has no vertical room — it colors the cell
// border instead.

export function labelBand(p) {
  if (p?.refurb_of) return { text: 'REFURB', bg: '#b45309' }     // print-safe amber; no CSS vars on paper
  if (/^UB_9/i.test(p?.sage_id || '')) return { text: 'EXPENSED', bg: '#6b7280' }
  return null
}
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
  return (
    <QrLabelSheet
      title={title}
      subtitle={'Each label has the part name, SKU, and a QR code encoding the SKU. Stick on product packaging; scan during cycle counts to confirm parts.'}
      presets={FORMAT_PRESETS}
      defaultFormat="letter_4up"
      formatFieldLabel="Label format"
      items={parts}
      qrPayload={p => p.id}
      qrScale={6}
      loadingText="Generating QR codes…"
      emptyContent="No parts to label."
      checklistMaxHeight={280}
      renderChecklistRow={p => (
        <>
          <span style={{ flex: 1, fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.name || p.id}
          </span>
          <span style={{ fontSize: 10, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
            {p.id}
          </span>
        </>
      )}
      cellBorderColor="#999"
      cellPadding={format => format === 'avery_5160' || format === 'scan_sheet_120' ? '0.04in' : '0.1in'}
      renderLabel={(p, preset, qrDataUrl) => (
        <>
          {(() => {
            const band = labelBand(p)
            if (!band) return null
            // Scan sheets have no vertical room: a thin colored rule instead of a stripe.
            const thin = !preset.showName
            return (
              <div style={{
                alignSelf: 'stretch', background: band.bg, color: '#fff',
                fontSize: thin ? 0 : Math.max(7, Math.round((preset.skuFontPx || 9) * 0.9)),
                fontWeight: 800, letterSpacing: '.08em', textAlign: 'center',
                lineHeight: thin ? '3px' : 1.4, height: thin ? 3 : undefined,
                marginBottom: 2, borderRadius: 2,
              }}>{thin ? '' : band.text}</div>
            )
          })()}
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
          {qrDataUrl && (
            <img
              src={qrDataUrl}
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
        </>
      )}
      onClose={onClose}
    />
  )
}
