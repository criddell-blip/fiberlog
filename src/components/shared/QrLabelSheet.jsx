import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'
import { useBackClose } from '../../lib/backStack'
import Icon from './Icon'

// Shared chassis for the printable label sheets. SkuLabelSheet and
// BinLabelSheet are thin config wrappers around the default export;
// AisleSignSheet reuses just the print chrome (PrintPortalStyle +
// PrintPortal) with its own one-sign-per-page layout.
//
// The print technique here is hard-won Chrome-bug knowledge — keep it
// centralized in this file:
//   1. Printable content renders to document.body via Portal so
//      multi-page output flows naturally instead of getting clipped by
//      position:absolute (the old visibility-hidden approach broke
//      pagination past the first page).
//   2. global.css's html/body/#root height:100% + overflow:hidden must
//      be overridden in @media print or the document never extends
//      beyond one viewport (see PrintPortalStyle).
//   3. Label grids use flex-wrap, NOT display:grid — Chrome's print
//      engine won't paginate a grid container past one page.
//
// Preset shape (per format key):
//   { label, description, pageMargin, columns, rows, qrSize,
//     minHeight, ...per-sheet font sizes / show flags }
// The chassis reads label/description/pageMargin/columns/minHeight;
// everything else is passed through to renderLabel via `preset`.

// ─── PRINT CHROME (also used standalone by AisleSignSheet) ──────────────────

// Print-only stylesheet. The print-labels element is rendered to
// body via Portal so it's a direct child of body. In print mode we
// hide every direct child of body EXCEPT the portal — that way the
// labels flow naturally across pages instead of getting clipped
// by position:absolute (the old approach broke pagination past
// the first page).
export function PrintPortalStyle({ pageMargin, pageSize = 'letter', extraPrintCss = '' }) {
  return (
    <style>{`
      .print-labels-portal { display: none; }
      @media print {
        /* CRITICAL: global.css locks html/body/#root to height:100%
           + overflow:hidden so the app fits in one viewport without
           a body scrollbar. That same rule kills print past page 1
           because the document never extends beyond one viewport.
           Override here so multi-page output actually flows. */
        html, body, #root {
          height: auto !important;
          overflow: visible !important;
        }
        body > *:not(.print-labels-portal) { display: none !important; }
        .print-labels-portal { display: block !important; }
        @page { ${pageSize ? `size: ${pageSize}; ` : ''}margin: ${pageMargin}; }
        ${extraPrintCss}
      }
    `}</style>
  )
}

// Printable layout — rendered to body via Portal so it flows
// naturally across pages in print mode. Hidden on screen by the
// .print-labels-portal default; revealed in @media print.
export function PrintPortal({ children }) {
  return createPortal(
    <div className="print-labels-portal">{children}</div>,
    document.body
  )
}

// ─── QR LABEL SHEET CHASSIS ─────────────────────────────────────────────────

// Config-driven select-and-print sheet: format picker + item checklist
// + flex-wrap label grid printed via the portal above.
//
//   title / subtitle       — sheet header (subtitle may be JSX)
//   presets                — FORMAT_PRESETS table (see shape above)
//   defaultFormat          — initial preset key
//   formatFieldLabel       — label over the format <select>
//   items                  — static item array (SkuLabelSheet path), OR
//   loadItems + loadKey    — async loader re-run when loadKey changes
//                            (BinLabelSheet path; selects all on load)
//   itemKey(item)          — stable id (default item.id)
//   qrPayload(item)        — string encoded into the QR
//   qrScale                — QRCode.toDataURL scale
//   loadingText            — spinner-block copy
//   errorFallback          — error text when the loader throws messageless
//   emptyContent           — JSX/string when there are no items
//   checklistMaxHeight     — px height of the scrolling checklist
//   renderChecklistRow(it) — row content (between checkbox and row end)
//   cellBorderColor        — dashed border color of each printed cell
//   cellPadding(formatKey) — padding of each printed cell
//   renderLabel(it, preset, qrDataUrl) — printed cell content
export default function QrLabelSheet({
  title,
  subtitle,
  presets,
  defaultFormat = 'letter_4up',
  formatFieldLabel = 'Format',
  items: itemsProp,
  loadItems,
  loadKey,
  itemKey = it => it?.id,
  qrPayload = it => it.id,
  qrScale = 6,
  loadingText = 'Generating QR codes…',
  errorFallback = 'Could not load data',
  emptyContent = 'Nothing to label.',
  checklistMaxHeight = 280,
  renderChecklistRow,
  cellBorderColor = '#999',
  cellPadding,
  renderLabel,
  onClose,
}) {
  // Back closes the sheet (mounted only when open); display-only, no confirm.
  useBackClose(1, onClose)
  const [format, setFormat] = useState(defaultFormat)
  const [items, setItems] = useState(() => itemsProp || [])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Static-items path: default-select everything up front. Loader path
  // starts empty and selects all once the load resolves.
  const [selected, setSelected] = useState(() => new Set((itemsProp || []).map(itemKey)))
  const [qrCache, setQrCache] = useState({})  // itemKey → data URL

  // Loader lives in a ref so an inline-closure prop doesn't retrigger
  // the effect every render — reloads are keyed on loadKey/items only.
  const loadItemsRef = useRef(loadItems)
  loadItemsRef.current = loadItems

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        let list = itemsProp || []
        if (loadItemsRef.current) {
          list = await loadItemsRef.current()
          if (cancelled) return
          setItems(list)
          // Default selection: everything just loaded
          setSelected(new Set(list.map(itemKey)))
        } else {
          setItems(list)
        }
        // Pre-generate QR codes
        const cache = {}
        for (const it of list) {
          const key = itemKey(it)
          if (!key) continue
          cache[key] = await QRCode.toDataURL(qrPayload(it), {
            errorCorrectionLevel: 'M',
            margin: 1,
            scale: qrScale,
          })
        }
        if (!cancelled) setQrCache(cache)
      } catch (e) {
        console.error('Label data load failed:', e)
        if (!cancelled) setError(e.message || errorFallback)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [itemsProp, loadKey])

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAll()  { setSelected(new Set(items.map(itemKey))) }
  function selectNone() { setSelected(new Set()) }

  function handlePrint() { window.print() }

  const preset = presets[format]
  const labelsToPrint = items.filter(it => selected.has(itemKey(it)))

  return (
    <>
      <PrintPortalStyle pageMargin={preset.pageMargin} />

      <div
        className="overlay open no-print"
        onClick={e => e.target === e.currentTarget && onClose()}
      >
        <div className="overlay-sheet" style={{ maxWidth: 720 }}>
          <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
            {title}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            {subtitle}
          </div>

          {/* Format picker — labels for stick-on, scan sheets for clipboard reference */}
          <div className="field">
            <label>{formatFieldLabel}</label>
            <select value={format} onChange={e => setFormat(e.target.value)} style={{ width: '100%' }}>
              {Object.entries(presets).map(([key, p]) => (
                <option key={key} value={key}>{p.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', marginTop: 4 }}>
              {preset.description}
            </div>
          </div>

          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
              {loadingText}
            </div>
          )}

          {error && (
            <div className="banner banner-danger" style={{
              borderRadius: 'var(--r-sm)', borderBottom: 'none',
              border: '1px solid var(--danger-border)', marginBottom: 14,
            }}>
              <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name="alert" size={16} /></span>
              <div className="banner-body">{error}</div>
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)' }}>
              {emptyContent}
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <>
              {/* Selection controls */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 0', marginBottom: 8,
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
                  {selected.size} of {items.length} selected
                </div>
                <button onClick={selectAll} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  All
                </button>
                <button onClick={selectNone} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 'var(--fs-xs)' }}>
                  None
                </button>
              </div>

              {/* Item checklist */}
              <div style={{ maxHeight: checklistMaxHeight, overflowY: 'auto', marginBottom: 14 }}>
                {items.map(it => (
                  <label key={itemKey(it)} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 4px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <input
                      type="checkbox"
                      checked={selected.has(itemKey(it))}
                      onChange={() => toggle(itemKey(it))}
                      style={{ cursor: 'pointer' }}
                    />
                    {renderChecklistRow(it)}
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
                  <Icon name="printer" size={15} style={{ display: 'inline-block', verticalAlign: '-3px', marginRight: 6 }} />Print {labelsToPrint.length} label{labelsToPrint.length === 1 ? '' : 's'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {labelsToPrint.length > 0 && (
        <PrintPortal>
          {/* Flex-wrap instead of CSS grid: Chrome's print engine has a
              long-standing pagination bug with display:grid (the grid
              container won't split across pages, content past page 1
              gets clipped). Flex-wrap with explicit cell widths
              paginates cleanly across any browser. */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            width: '100%',
            color: 'black',
            background: 'white',
          }}>
            {labelsToPrint.map(it => (
              <div key={itemKey(it)} style={{
                flex: `0 0 calc(100% / ${preset.columns})`,
                maxWidth: `calc(100% / ${preset.columns})`,
                border: `1px dashed ${cellBorderColor}`,
                padding: cellPadding(format),
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
                {renderLabel(it, preset, qrCache[itemKey(it)])}
              </div>
            ))}
          </div>
        </PrintPortal>
      )}
    </>
  )
}
