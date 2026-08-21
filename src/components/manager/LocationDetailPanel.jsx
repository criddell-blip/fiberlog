import { useEffect, useState } from 'react'
import { useApp } from '../../AppContext'
import {
  getStockByLocation, exportLocationStockCSV,
} from '../../lib/inventory'
import {
  getMyActiveRun, startCountRun, startOrResumeCountSession,
} from '../../lib/cycleCount'
import BinLabelSheet from '../cycleCount/BinLabelSheet'
import { locationTypeLabel } from '../../lib/locationTypes'
import AisleSignSheet from './AisleSignSheet'
import SkuLabelSheet from './SkuLabelSheet'
import { recencyPillStyle, recencyOf } from '../../lib/recencyPill'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Overlay-sheet that opens when a location row is tapped in the Locations
// tab. Centralizes everything you might want to do with a location:
//   - See what parts are here (stock list with search)
//   - Count this bin (jumps into the cycle-count flow, adding to active
//     run or starting a new one)
//   - Export an audit CSV scoped to this location
//   - View full Stock tab scoped to this location (existing jump)
//   - Print labels (bins/aisles for warehouses; SKU labels for any)
//   - Edit / Retire (callbacks to the existing flows in InventoryLocationsTab)
//
// Sheet renders centered on desktop (good enough for v1) and slides up
// from the bottom on phone — both via the existing .overlay-sheet pattern.
// A true side-panel-on-desktop is a possible future refinement; chose
// the simpler shared pattern for shippability.
export default function LocationDetailPanel({
  location,
  onClose,
  onJumpToStock,
  onJumpToCount,
  onJumpToPart,
  onEdit,
  onRetire,
}) {
  const { showToast, currentUser, isQtyPaused } = useApp()
  const [stock, setStock] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [activeRun, setActiveRun] = useState(null)
  const [busy, setBusy] = useState(false)

  // Per-action sheets — these reuse existing label/sign components
  const [showBinLabels, setShowBinLabels] = useState(false)
  const [showAisleSigns, setShowAisleSigns] = useState(false)
  const [showSkuLabels, setShowSkuLabels] = useState(false)

  // Back closes the panel (mounted only when open). Display/actions hub, no
  // confirm. Nested label sheets register their own layers and close first.
  useBackClose(1, onClose)

  const isBin = location?.type === 'bin'
  const isWarehouse = location?.type === 'warehouse'

  useEffect(() => {
    let cancelled = false
    if (!location?.id) return
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const [s, run] = await Promise.all([
          getStockByLocation(location.id),
          isBin && currentUser?.id
            ? getMyActiveRun(currentUser.id)
            : Promise.resolve(null),
        ])
        if (cancelled) return
        setStock(s || [])
        setActiveRun(run)
      } catch (e) {
        console.error('LocationDetailPanel load:', e)
        if (!cancelled) setError(e.message || 'Could not load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [location?.id, currentUser?.id, isBin])

  async function handleCount() {
    if (!isBin) return
    setBusy(true)
    try {
      let run = activeRun
      if (!run) {
        // No active run — start one scoped to this bin's parent warehouse.
        run = await startCountRun({
          warehouseId: location.parent_location_id || null,
          notes: 'Started from Locations tab',
        })
      }
      const session = await startOrResumeCountSession({
        runId: run.id, binId: location.id,
      })
      onClose()
      onJumpToCount?.(run, session)
    } catch (e) {
      console.error('Count this bin failed:', e)
      showToast(e.message || 'Could not start count')
      setBusy(false)
    }
  }

  async function handleExportCSV() {
    setBusy(true)
    try {
      const count = await exportLocationStockCSV(location)
      showToast(`Exported ${count} part type${count === 1 ? '' : 's'}`)
    } catch (e) {
      console.error('Export CSV failed:', e)
      showToast(e.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const filteredStock = search.trim()
    ? stock.filter(r => {
        const pc = r.parts_catalog
        const q = search.trim().toLowerCase()
        return (pc?.name || '').toLowerCase().includes(q)
            || (pc?.id || '').toLowerCase().includes(q)
      })
    : stock

  const totalUnits = stock.reduce((a, r) => a + Number(r.quantity || 0), 0)

  if (!location) return null

  return (
    <>
      <div className="overlay open" onClick={e => e.target === e.currentTarget && !busy && onClose()}>
        <div className="overlay-sheet" style={{ maxWidth: 720, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
          {/* Header */}
          <div style={{ flexShrink: 0, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ display: 'inline-flex', color: 'var(--accent-dk)' }}><Icon name={TYPE_ICON_NAMES[location.type] || 'box'} size={22} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', wordBreak: 'break-word' }}>
                  {location.assigned_user?.name || location.name}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 2 }}>
                  {locationTypeLabel(location.type)}
                  {location.assigned_user && location.assigned_user.name !== location.name && (
                    <> · {location.name}</>
                  )}
                  {location.notes && <> · {location.notes}</>}
                </div>
              </div>
              <button
                onClick={onClose}
                disabled={busy}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'inline-flex' }}
              ><Icon name="x" size={17} /></button>
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14, flexShrink: 0 }}>
            {isBin && (
              <button
                onClick={handleCount}
                disabled={busy}
                className="btn btn-primary"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
              >
                <Icon name="scan" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />{activeRun ? 'Add to active count run' : 'Start count of this bin'}
              </button>
            )}
            <button
              onClick={handleExportCSV}
              disabled={busy || stock.length === 0}
              className="btn btn-ghost"
              style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
              title="Download audit-format CSV for this location"
            >
              <Icon name="download" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />Export CSV
            </button>
            {onJumpToStock && stock.length > 0 && (
              <button
                onClick={() => { onClose(); onJumpToStock(location.id) }}
                className="btn btn-ghost"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
                title="Open the full Stock tab scoped to this location"
              >
                <Icon name="box" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />View in Stock tab
              </button>
            )}
            {isWarehouse && (
              <>
                <button
                  onClick={() => setShowBinLabels(true)}
                  className="btn btn-ghost"
                  style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)', borderColor: 'var(--purple)', color: 'var(--purple)' }}
                >
                  <Icon name="tag" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />Bin labels
                </button>
                <button
                  onClick={() => setShowAisleSigns(true)}
                  className="btn btn-ghost"
                  style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)', borderColor: 'var(--blue)', color: 'var(--blue)' }}
                >
                  <Icon name="tag" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />Aisle signs
                </button>
              </>
            )}
            {stock.length > 0 && (
              <button
                onClick={() => setShowSkuLabels(true)}
                className="btn btn-ghost"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)', borderColor: 'var(--purple)', color: 'var(--purple)' }}
              >
                <Icon name="tag" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />SKU labels
              </button>
            )}
            <button
              onClick={() => { onClose(); onEdit?.(location) }}
              className="btn btn-ghost"
              style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
            >
              <Icon name="edit" size={14} style={{ verticalAlign: '-2px', marginRight: 6, display: 'inline-block' }} />Edit
            </button>
            {onRetire && (
              <button
                onClick={() => { onClose(); onRetire(location) }}
                className="btn btn-danger"
                style={{ padding: '8px 14px', fontSize: 'var(--fs-sm)' }}
                title="Retire this location"
              >
                ⊘ Retire
              </button>
            )}
          </div>

          {/* Stock list */}
          <div style={{
            flex: 1, overflowY: 'auto', minHeight: 100,
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
          }}>
            {/* Stock list header */}
            <div style={{
              padding: '10px 14px', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              background: 'var(--surface)',
              position: 'sticky', top: 0, zIndex: 1,
            }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', fontWeight: 'var(--fw-bold)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Parts here
              </div>
              {!loading && stock.length > 0 && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)' }}>
                  · {stock.length} type{stock.length === 1 ? '' : 's'}
                  {!isQtyPaused && <> · {totalUnits.toLocaleString()} units</>}
                </div>
              )}
              {stock.length > 4 && (
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search…"
                  style={{
                    marginLeft: 'auto', flex: '0 0 auto',
                    width: 160, padding: '4px 8px',
                    border: '1.5px solid var(--border2)', borderRadius: 'var(--r-xs)',
                    background: 'var(--surface2)', fontSize: 'var(--fs-xs)',
                  }}
                />
              )}
            </div>

            {/* Stock rows */}
            {loading && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-sm)' }}>
                Loading stock…
              </div>
            )}
            {error && (
              <div style={{ padding: 20, color: 'var(--danger-fg)', fontSize: 'var(--fs-sm)' }}>
                Could not load: {error}
              </div>
            )}
            {!loading && !error && stock.length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)', fontSize: 'var(--fs-sm)' }}>
                No stock at this location.
              </div>
            )}
            {!loading && !error && filteredStock.length === 0 && stock.length > 0 && (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--hint)', fontSize: 'var(--fs-sm)' }}>
                No parts match "{search}"
              </div>
            )}
            {!loading && !error && filteredStock.map((r, i) => {
              const pc = r.parts_catalog
              const qty = Number(r.quantity || 0)
              return (
                <div
                  key={pc?.id || i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 14px',
                    borderBottom: i < filteredStock.length - 1 ? '1px solid var(--border)' : 'none',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {pc?.name || pc?.id || 'Unknown'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>
                      {pc?.id}{pc?.category ? ` · ${pc.category}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    {isQtyPaused ? (
                      <span style={recencyPillStyle(r.last_movement_at)}>
                        {recencyOf(r.last_movement_at).label}
                      </span>
                    ) : (
                      <>
                        <div style={{ fontSize: 'var(--fs-base)', fontWeight: 'var(--fw-bold)', color: qty < 0 ? 'var(--danger-fg)' : 'var(--text)' }}>
                          {qty.toLocaleString()}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                          {pc?.unit || 'ea'}
                        </div>
                      </>
                    )}
                  </div>
                  {/* Cross-link: open this part in the Parts tab. Closes
                      the detail panel so the user lands directly on the
                      Parts list with the row highlighted. */}
                  {onJumpToPart && pc?.id && (
                    <button
                      type="button"
                      onClick={() => { onClose(); onJumpToPart(pc.id) }}
                      title="Open this part in the Parts tab"
                      style={{
                        fontSize: 10, padding: '3px 8px',
                        background: 'transparent', color: 'var(--muted)',
                        border: '1px solid var(--border)', borderRadius: 'var(--r-xs)',
                        cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                      }}
                    >
                      → Part
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Bin labels overlay */}
      {showBinLabels && (
        <BinLabelSheet warehouse={location} onClose={() => setShowBinLabels(false)} />
      )}

      {/* Aisle signs overlay */}
      {showAisleSigns && (
        <AisleSignSheet warehouse={location} onClose={() => setShowAisleSigns(false)} />
      )}

      {/* SKU labels overlay */}
      {showSkuLabels && (
        <SkuLabelSheet
          parts={stock.map(r => ({
            id: r.parts_catalog?.id || r.part_id,
            name: r.parts_catalog?.name || r.part_id,
            unit: r.parts_catalog?.unit || 'ea',
          })).filter(p => p.id)}
          title={`SKU labels — ${stock.length} part${stock.length === 1 ? '' : 's'} at ${location.name}`}
          onClose={() => setShowSkuLabels(false)}
        />
      )}
    </>
  )
}

const TYPE_ICON_NAMES = {
  warehouse: 'warehouse',
  truck:     'truck',
  job_site:  'pin',
  vendor:    'warehouse',
  scrap:     'trash',
  bin:       'box',
}
