import QrLabelSheet from '../shared/QrLabelSheet'
import { formatBinCode } from '../../lib/cycleCount'
import { getBinsForWarehouse } from '../../lib/inventory'

// Print bin labels for stuck-on-the-shelf scanning. Generates a QR code
// encoding `BIN:<uuid>` per bin, plus the bin name in large readable type
// and the parent warehouse name as a sub-line.
//
// Thin config wrapper around the shared QrLabelSheet chassis (which owns
// the print-portal technique + Chrome pagination workarounds).
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
  return (
    <QrLabelSheet
      title="Print bin labels"
      subtitle={(
        <>
          Each label has a QR encoding <code style={{ fontFamily: '"DM Mono", monospace', fontSize: 'var(--fs-xs)' }}>BIN:&lt;uuid&gt;</code>.
          Both USB scanners and the phone camera read these.
        </>
      )}
      presets={FORMAT_PRESETS}
      defaultFormat="letter_4up"
      formatFieldLabel="Format"
      loadItems={() => getBinsForWarehouse(warehouse.id)}
      loadKey={warehouse.id}
      qrPayload={bin => formatBinCode(bin.id)}
      qrScale={8}
      loadingText="Loading bins + generating QR codes…"
      errorFallback="Could not load bins"
      emptyContent={(
        <>
          No bins in <strong>{warehouse.name}</strong> yet. Add some in the Locations tab first.
        </>
      )}
      checklistMaxHeight={240}
      renderChecklistRow={bin => (
        <>
          <span style={{ flex: 1, fontSize: 'var(--fs-base)' }}>{bin.name}</span>
          <span style={{ fontSize: 10, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
            {bin.id.slice(0, 8)}…
          </span>
        </>
      )}
      cellBorderColor="#888"
      cellPadding={format => format === 'scan_sheet_60' ? '0.04in' : '0.15in'}
      renderLabel={(bin, preset, qrDataUrl) => (
        <>
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
          {qrDataUrl && (
            <img
              src={qrDataUrl}
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
        </>
      )}
      onClose={onClose}
    />
  )
}
