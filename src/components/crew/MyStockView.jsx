import { useEffect, useState, useMemo, useCallback } from 'react'
import { useApp } from '../../AppContext'
import { getMyTruckStock, getMyCrewPermissions } from '../../lib/inventory'
import CrewMovementSheet from './CrewMovementSheet'
import PausedBanner from '../shared/PausedBanner'
import { recencyPillStyle, recencyOf } from '../../lib/recencyPill'
import Icon from '../shared/Icon'

// Crew-facing "what's on my truck" view. Read-only stock list scoped to
// the caller's personal truck (auto-created at user setup), plus action
// buttons for Load and Return. Issue / Scrap / Transfer are intentionally
// not exposed yet — the RPC supports them and they're queued for a follow-up
// (see backlog #4).
//
// No realtime subscription on inventory_stock right now — the table isn't
// in the supabase_realtime publication. We refetch on mount, on manual
// refresh, and after any successful movement. Good enough for a single
// crew member's session.
export default function MyStockView({ onBack, onUserTap }) {
  const { currentUser, showToast, isQtyPaused } = useApp()
  const [truck, setTruck] = useState(null)
  const [stock, setStock] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sheetMode, setSheetMode] = useState(null)   // 'load' | 'return' | null
  // Set of operation strings the caller is *denied* (per crew_operation_permissions).
  // Empty by default = everything allowed. RPC enforces server-side too.
  const [deniedOps, setDeniedOps] = useState(() => new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [{ truck: t, stock: s }, perms] = await Promise.all([
        getMyTruckStock(),
        getMyCrewPermissions(),
      ])
      setTruck(t)
      setStock(s)
      setDeniedOps(new Set(perms.filter(p => p.allowed === false).map(p => p.operation)))
    } catch (e) {
      console.error('Load my-stock failed:', e)
      showToast('Could not load stock: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => { load() }, [load])

  const canLoad   = !deniedOps.has('load')
  const canReturn = !deniedOps.has('return')

  // Client-side filter — stock lists for crew should never be huge (tens
  // to maybe a couple hundred parts), so doing this in JS keeps things
  // snappy and avoids a network round-trip per keystroke.
  const filteredStock = useMemo(() => {
    if (!search.trim()) return stock
    const q = search.trim().toLowerCase()
    return stock.filter(r => {
      const pc = r.parts_catalog
      return (pc?.name || '').toLowerCase().includes(q)
          || (pc?.id || '').toLowerCase().includes(q)
    })
  }, [stock, search])

  const totalUnits = useMemo(
    () => stock.reduce((a, r) => a + Number(r.quantity || 0), 0),
    [stock]
  )

  function handleMovementComplete() {
    setSheetMode(null)
    load()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PausedBanner />
      {/* ─── Topbar ────────────────────────────────────────────────────── */}
      <div className="topbar">
        {onBack && <button className="back-btn" onClick={onBack}>←</button>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="box" size={19} /><span style={{ color: 'var(--text)' }}>My</span>{' '}
            <span style={{ color: 'var(--orange)' }}>Stock</span>
          </div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {truck
              ? (truck._isShared
                  ? <>{truck.name} <span style={{ color: 'var(--teal-mid)', fontWeight: 600 }}>· shared</span></>
                  : truck.name)
              : (loading ? 'Loading…' : 'No truck assigned')}
          </div>
        </div>
        {onUserTap && (
          <button className="user-btn" onClick={onUserTap}>
            {currentUser?.initials || 'Me'}
          </button>
        )}
      </div>

      {/* ─── Summary + actions ─────────────────────────────────────────── */}
      <div style={{
        padding: '12px 16px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        {/* Stats row — Total units hidden when display mode is paused
            (per org-wide pause switch). Just "Part types" stays. */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          <Stat label="Part types" value={stock.length} color="var(--teal)" />
          {!isQtyPaused && (
            <Stat label="Total units" value={totalUnits.toLocaleString()} color="var(--orange)" />
          )}
        </div>

        {/* Action buttons. Load / Return only for now; Issue/Scrap/Transfer
            ship in a follow-up. Buttons disappear entirely if a manager has
            denied that operation for this crew member (per
            crew_operation_permissions). RPC re-checks server-side regardless. */}
        <div style={{ display: 'flex', gap: 8 }}>
          {canLoad && (
            <button
              className="btn btn-primary"
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
              onClick={() => setSheetMode('load')}
              disabled={!truck || loading}
            >
              <Icon name="download" size={16} /> Load
            </button>
          )}
          {canReturn && (
            <button
              className="btn btn-ghost"
              style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}
              onClick={() => setSheetMode('return')}
              disabled={!truck || loading || stock.length === 0}
            >
              <Icon name="upload" size={16} /> Return
            </button>
          )}
          {!canLoad && !canReturn && (
            <div style={{ flex: 1, padding: '8px 12px', textAlign: 'center', fontSize: 12, color: 'var(--muted)', background: 'var(--surface2)', borderRadius: 'var(--r-sm)' }}>
              No movements permitted — ask your manager.
            </div>
          )}
          <button
            onClick={load}
            disabled={loading}
            title="Refresh"
            style={{
              padding: '0 12px',
              border: '1px solid var(--border2)',
              background: 'var(--surface2)',
              borderRadius: 'var(--r-sm)',
              cursor: loading ? 'wait' : 'pointer',
              color: 'var(--muted)',
              display: 'inline-flex', alignItems: 'center',
            }}
          >
            <Icon name="rotate" size={16} />
          </button>
        </div>
      </div>

      {/* ─── Search ────────────────────────────────────────────────────── */}
      {stock.length > 4 && (
        <div style={{ padding: '8px 16px', flexShrink: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
          <input
            type="text"
            placeholder="Search parts by name or SKU…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoComplete="off"
            name="stock-search"
            style={{
              width: '100%', padding: '8px 12px',
              border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
              background: 'var(--bg)', fontSize: 14,
            }}
          />
        </div>
      )}

      {/* ─── Stock list ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 24px' }}>
        {loading && stock.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)', fontSize: 14 }}>
            Loading your stock…
          </div>
        )}

        {!loading && !truck && (
          <div style={{
            textAlign: 'center', padding: 40, color: 'var(--hint)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <div style={{ color: 'var(--gray-mid)' }}><Icon name="truck" size={34} /></div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
              No truck assigned yet
            </div>
            <div style={{ fontSize: 13, maxWidth: 280 }}>
              Ask your manager to set up your personal stock location.
            </div>
          </div>
        )}

        {!loading && truck && stock.length === 0 && (
          <div style={{
            textAlign: 'center', padding: 40, color: 'var(--hint)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
          }}>
            <div style={{ color: 'var(--gray-mid)' }}><Icon name="box" size={34} /></div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
              {truck._isShared ? `${truck.name} is empty` : 'Your truck is empty'}
            </div>
            <div style={{ fontSize: 13, maxWidth: 280 }}>
              Tap <strong>Load</strong> to bring parts from a warehouse
              {truck._isShared ? ` onto ${truck.name}` : ' onto your truck'}.
            </div>
          </div>
        )}

        {!loading && filteredStock.length === 0 && stock.length > 0 && search && (
          <div style={{ textAlign: 'center', padding: 30, color: 'var(--hint)', fontSize: 13 }}>
            No matches for "{search}"
          </div>
        )}

        {filteredStock.map((r, i) => {
          const pc = r.parts_catalog
          const qty = Number(r.quantity || 0)
          return (
            <div
              key={pc?.id || i}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)',
                marginBottom: 6,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {pc?.name || pc?.id || 'Unknown part'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--hint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {pc?.id}
                  {pc?.category && <> · {pc.category}</>}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                {isQtyPaused ? (
                  <span style={recencyPillStyle(r.last_movement_at)}>
                    {recencyOf(r.last_movement_at).label}
                  </span>
                ) : (
                  <>
                    <div className="mono" style={{ fontSize: 17, fontWeight: 600, color: qty < 0 ? 'var(--red)' : 'var(--text)' }}>
                      {qty.toLocaleString()}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                      {pc?.unit || 'ea'}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ─── Movement sheet ────────────────────────────────────────────── */}
      {sheetMode && (
        <CrewMovementSheet
          mode={sheetMode}
          myTruck={truck}
          myStock={stock}
          onClose={() => setSheetMode(null)}
          onComplete={handleMovementComplete}
        />
      )}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Uses the shared .metric class for layout + typography, with the value color
// overridden inline so the parts/units split (teal vs orange) is preserved.
function Stat({ label, value, color }) {
  return (
    <div className="metric" style={{ flex: 1, background: 'var(--surface2)', border: '1px solid var(--border)' }}>
      <div className="metric-value mono" style={{ color }}>{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  )
}
