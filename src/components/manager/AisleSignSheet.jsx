import { useEffect, useMemo, useState } from 'react'
import { getBinsForWarehouse } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'
import { PrintPortalStyle, PrintPortal } from '../shared/QrLabelSheet'

// Big readable signs for warehouse navigation — one sign per aisle,
// extracted from existing bin names via the same prefix-parse the
// InventoryLocationsTab uses for collapse groups.
//
// Auto-parses "Aisle X" prefix from bin names. Bins like "Aisle 1, shelf
// a3" → group "Aisle 1". Bins without an "Aisle N" prefix → "Other".
//
// Not scannable — just typography for hanging on aisle ends so crew can
// find the right row from across the warehouse.
//
// 1 sign per page (US Letter, landscape works best — 11×8.5 in or
// portrait 8.5×11). User picks portrait/landscape via the browser's
// print dialog; we just render the giant text and let it scale.

// Mirror the parse from InventoryLocationsTab.groupBinsByAisle().
// Returns [{key, label, bins:[…], sortKey}].
function groupBinsByAisle(bins) {
  const map = new Map()
  for (const bin of bins) {
    const name = bin.name || ''
    const m = name.match(/^Aisle\s+(\d+)/i)
    const key = m ? `aisle-${m[1]}` : 'other'
    const label = m ? `Aisle ${m[1]}` : 'Other'
    if (!map.has(key)) {
      map.set(key, {
        key, label, bins: [], sortKey: m ? (parseInt(m[1], 10) || 999) : 9999,
      })
    }
    map.get(key).bins.push(bin)
  }
  return Array.from(map.values()).sort((a, b) => a.sortKey - b.sortKey)
}

// Try to extract a Bay/Shelf range to print as a sub-line on the sign.
// e.g. bins "Aisle 1, bay a..", "Aisle 1, bay g.." → "Bays A–G"
function summarizeBays(bins) {
  const letters = new Set()
  for (const b of bins) {
    const m = (b.name || '').match(/\b(?:bay|shelf|row)\s*([a-z])/i)
    if (m) letters.add(m[1].toLowerCase())
  }
  if (letters.size === 0) return ''
  const sorted = Array.from(letters).sort()
  if (sorted.length === 1) return `Bay ${sorted[0].toUpperCase()}`
  return `Bays ${sorted[0].toUpperCase()}–${sorted[sorted.length - 1].toUpperCase()}`
}

export default function AisleSignSheet({ warehouse, onClose }) {
  // Back closes the sheet (mounted only when open); display-only, no confirm.
  useBackClose(1, onClose)
  const [bins, setBins] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const b = await getBinsForWarehouse(warehouse.id)
        if (cancelled) return
        setBins(b)
        // Default-select all aisle groups (skip "Other")
        const groups = groupBinsByAisle(b)
        setSelected(new Set(groups.filter(g => g.key !== 'other').map(g => g.key)))
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not load bins')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [warehouse.id])

  const groups = useMemo(() => groupBinsByAisle(bins), [bins])
  const signsToPrint = groups.filter(g => selected.has(g.key))

  function toggle(key) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handlePrint() { window.print() }

  return (
    <>
      {/* Shared portal print chrome (see QrLabelSheet) — replaces the old
          visibility:hidden + position:absolute technique, which broke
          pagination past page one. No size: rule in @page so the user can
          still pick portrait/landscape in the browser's print dialog. */}
      <PrintPortalStyle
        pageMargin="0.4in"
        pageSize={null}
        extraPrintCss={`
          .aisle-sign-page {
            page-break-after: always;
            break-after: page;
          }
          .aisle-sign-page:last-child {
            page-break-after: auto;
            break-after: auto;
          }
        `}
      />

      <div
        className="overlay open no-print"
        onClick={e => e.target === e.currentTarget && onClose()}
      >
        <div className="overlay-sheet" style={{ maxWidth: 560 }}>
          <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
            Print aisle signs
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
            One full-page sign per aisle, with the aisle name in giant text +
            a sub-line listing the bay/shelf range. Hang on aisle ends for
            warehouse navigation.
          </div>

          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
              Loading bins…
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

          {!loading && !error && groups.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)' }}>
              No bins in <strong>{warehouse.name}</strong> yet — nothing to print.
            </div>
          )}

          {!loading && !error && groups.length > 0 && (
            <>
              <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 14 }}>
                {groups.map(g => (
                  <label key={g.key} style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 6px', cursor: 'pointer',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <input
                      type="checkbox"
                      checked={selected.has(g.key)}
                      onChange={() => toggle(g.key)}
                      style={{ cursor: 'pointer' }}
                    />
                    <span style={{ flex: 1, fontWeight: 600, fontSize: 'var(--fs-base)' }}>
                      {g.label}
                    </span>
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)' }}>
                      {g.bins.length} bin{g.bins.length === 1 ? '' : 's'}
                      {summarizeBays(g.bins) && ` · ${summarizeBays(g.bins)}`}
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
                  disabled={signsToPrint.length === 0}
                >
                  <Icon name="printer" size={15} style={{ display: 'inline-block', verticalAlign: '-3px', marginRight: 6 }} />Print {signsToPrint.length} sign{signsToPrint.length === 1 ? '' : 's'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Printable signs — one page per aisle, rendered to body via the
          shared PrintPortal so multi-page output flows across pages. */}
      {signsToPrint.length > 0 && (
        <PrintPortal>
          {signsToPrint.map(g => (
            <div key={g.key} className="aisle-sign-page" style={{
              color: 'black',
              background: 'white',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '10in',
              textAlign: 'center',
              padding: '0.5in',
              boxSizing: 'border-box',
            }}>
              <div style={{
                fontSize: '180pt',
                fontWeight: 900,
                letterSpacing: '-0.02em',
                lineHeight: 1,
                marginBottom: '0.3in',
              }}>
                {g.label.toUpperCase()}
              </div>
              {summarizeBays(g.bins) && (
                <div style={{
                  fontSize: '48pt',
                  fontWeight: 600,
                  color: '#666',
                  letterSpacing: '0.02em',
                }}>
                  {summarizeBays(g.bins).toUpperCase()}
                </div>
              )}
              <div style={{
                fontSize: '18pt',
                color: '#888',
                marginTop: '0.6in',
                fontWeight: 500,
              }}>
                {warehouse.name}
              </div>
            </div>
          ))}
        </PrintPortal>
      )}
    </>
  )
}
