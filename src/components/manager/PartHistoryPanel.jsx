import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  getPartMovements, getRecentMovements, getPartLocations,
  movementEffectiveDate, locationTypeLabel, isConsumedLocationType,
} from '../../lib/inventory'
import { movementDisplay, resolveReceiveMeta } from '../../lib/movementDisplay'
import { withRunningBalance } from '../../lib/runningBalance'
import { fmtDayYear } from '../../lib/format'
import { useBackClose } from '../../lib/backStack'
import { chipStyle, cardSurface, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

const LIMIT = 200

// Per-part movement history, opened from the Parts tab.
//
// Opens on RECEIVES because that's the question managers actually bring to a
// part ("when did we last get this, from whom, what did it cost") — the full
// movement list is one tap away. Read-only: this panel books nothing, which is
// why it takes no currentUser/readOnly and never touches refreshKey.
//
// Receives and all-movements are two separate queries fired together rather
// than one list filtered client-side: the all-movements query is capped at
// LIMIT by created_at, so on a busy part the oldest receipts would fall off
// the end and the received total would silently under-report.
//
// The third mode, BALANCE, answers "what was on hand before this happened".
// Nothing in the DB stores that, so it's rebuilt per location from today's
// stock (lib/runningBalance.js). It has to be per location — a transfer
// changes two balances at once, so an app-wide "previous quantity" doesn't
// exist — which is why the mode opens on a location picker rather than a
// number. Its movements are a third, location-filtered query for the same
// cap reason as receives: filtering the capped all-list client-side would
// silently lose the older rows at a busy bin.
export default function PartHistoryPanel({ part, onClose }) {
  const { isQtyPaused } = useApp()

  // Standalone sheet mounted only when open, so it self-registers Back (the
  // BulkMoveSheet / SkuLabelSheet convention). The Parts tab deliberately does
  // NOT also register a layer for it — that would take two Backs to close.
  // Display-only, so no unsaved-input confirm.
  useBackClose(1, onClose)

  const [mode, setMode] = useState('receive')   // 'receive' | 'all' | 'balance'
  const [receives, setReceives] = useState([])
  const [all, setAll] = useState([])
  const [stockLocs, setStockLocs] = useState([])   // every stock row, zero included
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  // Balance mode. `balLoc` is a location id; '' = nothing picked yet.
  const [balLoc, setBalLoc] = useState('')
  const [balMovements, setBalMovements] = useState([])
  const [balLoading, setBalLoading] = useState(false)
  const [balErr, setBalErr] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setErr(null)
    Promise.all([
      getPartMovements(part.id, { type: 'receive', limit: LIMIT }),
      getPartMovements(part.id, { limit: LIMIT }),
      // Stock rows feed the Balance picker's on-hand figures AND its anchor
      // quantity, so they load with everything else. A failure here only
      // costs the picker, not the history — hence the swallow.
      getPartLocations(part.id, { includeZero: true }).catch(() => ({ locations: [] })),
    ])
      .then(([r, a, pl]) => {
        if (cancelled) return
        // The query orders by created_at (what the index provides) but we
        // DISPLAY the effective work date, and the ~487 backfilled import rows
        // disagree between the two. Re-sort so the visible dates stay
        // monotonic. The LIMIT above remains a created_at cap either way.
        setReceives(byEffectiveDateDesc(r))
        setAll(byEffectiveDateDesc(a))
        setStockLocs(pl.locations || [])
      })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [part.id])

  // Picker options: every location with a stock row (zero included) plus any
  // endpoint in the loaded movements that has no stock row at all (a location
  // whose row was cleaned up still deserves a replay). Usable stock first,
  // qty desc, consumed regions last — the shelf before the ledger.
  const locOptions = useMemo(() => {
    const byId = new Map()
    for (const l of stockLocs) {
      byId.set(l.locationId, {
        id: l.locationId, name: l.name, type: l.type, parentName: l.parentName,
        qty: l.qty, isConsumed: l.isConsumed,
      })
    }
    for (const m of all) {
      for (const loc of [m.from_location, m.to_location]) {
        if (loc?.id && !byId.has(loc.id)) {
          byId.set(loc.id, {
            id: loc.id, name: loc.name, type: loc.type, parentName: null,
            qty: 0, isConsumed: isConsumedLocationType(loc.type),
          })
        }
      }
    }
    return [...byId.values()].sort((a, b) =>
      (a.isConsumed - b.isConsumed) || (b.qty - a.qty) || a.name.localeCompare(b.name))
  }, [stockLocs, all])

  // Entering Balance mode with nothing picked: default to the biggest shelf.
  useEffect(() => {
    if (mode === 'balance' && !balLoc && locOptions.length) setBalLoc(locOptions[0].id)
  }, [mode, balLoc, locOptions])

  useEffect(() => {
    if (!balLoc) return
    let cancelled = false
    setBalLoading(true)
    setBalErr(null)
    getRecentMovements({ partId: part.id, locationId: balLoc, limit: LIMIT })
      .then(rows => { if (!cancelled) setBalMovements(rows) })
      .catch(e => { if (!cancelled) setBalErr(e.message || String(e)) })
      .finally(() => { if (!cancelled) setBalLoading(false) })
    return () => { cancelled = true }
  }, [part.id, balLoc])

  const balOption = locOptions.find(o => o.id === balLoc) || null
  const balTruncated = balMovements.length >= LIMIT
  const balance = useMemo(
    () => withRunningBalance(balMovements, balLoc, balOption?.qty ?? 0, { truncated: balTruncated }),
    [balMovements, balLoc, balOption, balTruncated]
  )

  const rows = mode === 'receive' ? receives : all
  const truncated = all.length >= LIMIT
  const unit = part.unit || 'ea'

  // Received summary. Quantities are Numbers only after coercion — PostgREST
  // hands back `numeric` as a string.
  const summary = useMemo(() => {
    if (!receives.length) return null
    const total = receives.reduce((s, m) => s + (Number(m.quantity) || 0), 0)
    const withCost = receives.filter(m => resolveReceiveMeta(m).unitCost != null)
    return {
      total,
      count: receives.length,
      // Most RECENT known cost, never an average — receives is already sorted
      // newest first. 595 of 721 live receives have no cost at all, so this
      // has to read as "last known", not as a computed figure.
      lastCost: withCost.length ? resolveReceiveMeta(withCost[0]).unitCost : null,
      missingCost: receives.length - withCost.length,
      lastDate: movementEffectiveDate(receives[0]),
    }
  }, [receives])

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{
        maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 2 }}>
              {part.name}
            </div>
            <div style={{
              fontSize: 'var(--fs-xs)', color: 'var(--hint)',
              fontFamily: 'var(--font-mono)', marginBottom: 12,
            }}>
              {part.id}{part.unit ? ` · ${part.unit}` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18, padding: '0 4px' }}
            title="Close"
          >✕</button>
        </div>

        {/* Mode toggle — receive/all are client-side, both sets are already loaded */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexShrink: 0, flexWrap: 'wrap' }}>
          <button onClick={() => setMode('receive')} style={chipStyle(mode === 'receive')}>
            Received{receives.length ? ` (${receives.length})` : ''}
          </button>
          <button onClick={() => setMode('all')} style={chipStyle(mode === 'all')}>
            All movements{all.length ? ` (${all.length}${truncated ? '+' : ''})` : ''}
          </button>
          <button onClick={() => setMode('balance')} style={chipStyle(mode === 'balance')}>
            <Icon name="sliders" size={12} /> Balance
          </button>
        </div>

        {/* Received summary */}
        {!loading && mode === 'receive' && summary && (
          <div style={{
            fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 10,
            paddingBottom: 10, borderBottom: '1px solid var(--border)', flexShrink: 0,
          }}>
            {!isQtyPaused && (
              <>Total received: <strong style={{ color: 'var(--text)' }}>
                {summary.total.toLocaleString()} {unit}
              </strong> over </>
            )}
            {summary.count} receipt{summary.count === 1 ? '' : 's'}
            {summary.lastDate && <> · last {fmtDayYear(summary.lastDate)}</>}
            {summary.lastCost != null && (
              <> · last cost <strong style={{ color: 'var(--text)' }}>${summary.lastCost.toFixed(2)}</strong>/{unit}</>
            )}
            {summary.missingCost > 0 && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', marginTop: 3 }}>
                {summary.missingCost} of {summary.count} receipt{summary.count === 1 ? '' : 's'} have no cost recorded.
              </div>
            )}
          </div>
        )}

        {/* Cap note */}
        {!loading && mode === 'all' && truncated && (
          <div style={{
            fontSize: 'var(--fs-xs)', color: 'var(--amber)', background: 'var(--amber-lt)',
            padding: '6px 10px', borderRadius: 'var(--r-sm)', marginBottom: 10, flexShrink: 0,
          }}>
            Showing the {LIMIT} most recent. For the full history use Inventory → Activity → Export CSV.
          </div>
        )}

        {/* Balance: location picker + anchor */}
        {!loading && mode === 'balance' && (
          <div style={{ flexShrink: 0, marginBottom: 10 }}>
            {locOptions.length === 0 ? null : (
              <>
                <select
                  value={balLoc}
                  onChange={e => setBalLoc(e.target.value)}
                  style={{
                    width: '100%', height: 38, padding: '0 12px', borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border2)', fontSize: 14, background: 'var(--surface)',
                  }}
                >
                  {locOptions.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name}{o.parentName ? ` · ${o.parentName}` : ''} ({locationTypeLabel(o.type)})
                      {isQtyPaused ? '' : ` — ${o.qty.toLocaleString()} ${o.isConsumed ? 'consumed' : 'on hand'}`}
                    </option>
                  ))}
                </select>
                {balOption && !isQtyPaused && (
                  <div style={{
                    fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginTop: 8,
                    paddingBottom: 10, borderBottom: '1px solid var(--border)',
                  }}>
                    {balOption.isConsumed ? 'Consumed into' : 'On hand at'} <strong style={{ color: 'var(--text)' }}>{balOption.name}</strong> now:{' '}
                    <strong className="mono" style={{ color: 'var(--text)' }}>{balOption.qty.toLocaleString()} {unit}</strong>
                    {balTruncated && (
                      <div style={{
                        fontSize: 'var(--fs-xs)', color: 'var(--amber)', background: 'var(--amber-lt)',
                        padding: '6px 10px', borderRadius: 'var(--r-sm)', marginTop: 8,
                      }}>
                        Showing the {LIMIT} most recent at this location. Balances are still exact — they count back from today's on-hand.
                      </div>
                    )}
                    {balance.driftAtOldest !== 0 && (
                      <div style={{
                        fontSize: 'var(--fs-xs)', color: 'var(--amber)', background: 'var(--amber-lt)',
                        padding: '6px 10px', borderRadius: 'var(--r-sm)', marginTop: 8,
                      }}>
                        The oldest movement here starts from {balance.driftAtOldest.toLocaleString()}, not 0 — at some
                        point this location's stock was set outside the movement log. Balances before that row are off by that amount.
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {(err || (mode === 'balance' && balErr)) && (
          <div style={{
            padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12, flexShrink: 0,
          }}>{err || balErr}</div>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading ? (
            <LoadingBlock label="Loading history…" />
          ) : mode === 'balance' ? (
            locOptions.length === 0 ? (
              <EmptyState icon="activity"><div>No movement history for this part yet.</div></EmptyState>
            ) : balLoading ? (
              <LoadingBlock label="Rebuilding balance…" />
            ) : balance.rows.length === 0 ? (
              <EmptyState icon="activity"><div>No movements at this location.</div></EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {balance.rows.map(r => (
                  <HistoryRow key={r.m.id} m={r.m} part={part} isQtyPaused={isQtyPaused} balance={r} />
                ))}
              </div>
            )
          ) : rows.length === 0 ? (
            <EmptyState icon="activity">
              {mode === 'receive' && all.length > 0 ? (
                <>
                  <div>No receipts logged for this part.</div>
                  <button
                    onClick={() => setMode('all')}
                    style={{
                      marginTop: 8, background: 'transparent', border: 'none', cursor: 'pointer',
                      color: 'var(--accent)', fontSize: 'var(--fs-sm)', fontWeight: 600, textDecoration: 'underline',
                    }}
                  >See all {all.length} movements →</button>
                </>
              ) : (
                <div>No movement history for this part yet.</div>
              )}
            </EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(m => (
                <HistoryRow key={m.id} m={m} part={part} isQtyPaused={isQtyPaused} />
              ))}
            </div>
          )}
        </div>

        {/* Dates are the effective work date, which for receives is the entry
            date — worth saying so before someone reconciles against a packing
            slip. Balance mode is the exception: it must follow booking order
            (see lib/runningBalance.js), so it says so instead. */}
        <div style={{
          fontSize: 'var(--fs-xs)', color: 'var(--hint)', fontStyle: 'italic',
          marginTop: 10, flexShrink: 0,
        }}>
          {mode === 'balance'
            ? 'Rows are in the order they were booked, newest first — a back-dated import sits where it was entered, not on its work date.'
            : 'Dates are the logged work date. Receipts carry no separate delivery date, so a back-dated PO shows the day it was entered.'}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

// Deliberately NOT shared with InventoryMovementsTab's row. That feed's most
// important column is the part name (many parts, one location); here the part
// is constant and the valuable columns are vendor / reference / cost. Sharing
// the markup would mean a config prop per difference. The derivation is shared
// (lib/movementDisplay.js); the markup is tuned per context.
//
// `balance` ({ delta, before, after }) switches the quantity column to the
// location-relative view: the sign follows the picked location (a transfer
// OUT of it is −12 here even though the feed shows a plain 12), and the
// before → after pair sits under it.
function HistoryRow({ m, part, isQtyPaused, balance = null }) {
  const d = movementDisplay(m)
  const meta = resolveReceiveMeta(m)
  const isReceive = m.movement_type === 'receive'
  const qty = Number(m.quantity) || 0
  const ext = meta.unitCost != null ? meta.unitCost * qty : null
  const unit = m.unit || part.unit || 'ea'

  // Suppress notes the resolver already consumed, or the vendor prints twice.
  const notesAreRedundant = !m.notes || meta.notesConsumed

  return (
    <div style={{ ...cardSurface, borderLeft: `3px solid ${d.colors.text}`, padding: '11px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
          background: d.colors.bg, color: d.colors.text, whiteSpace: 'nowrap',
        }}><Icon name={d.colors.icon} size={12} /> {d.label}</span>
        <div style={{ flex: 1 }} />
        {!isQtyPaused && (balance ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="mono" style={{
              fontSize: 14, fontWeight: 600,
              color: balance.delta < 0 ? 'var(--red)' : balance.delta > 0 ? 'var(--accent-dk)' : 'var(--muted)',
            }}>
              {balance.delta > 0 ? '+' : balance.delta < 0 ? '−' : ''}{Math.abs(balance.delta).toLocaleString()}
            </span>
            <span className="mono" style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
              {balance.before.toLocaleString()}
              <span style={{ color: 'var(--hint)', margin: '0 5px' }}>→</span>
              <strong style={{ color: 'var(--text)' }}>{balance.after.toLocaleString()}</strong>
              <span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 500, marginLeft: 3 }}>{unit}</span>
            </span>
          </div>
        ) : (
          <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: d.qtyColor }}>
            {d.qtyPrefix}{qty.toLocaleString()}
            <span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 500, marginLeft: 3 }}>
              {unit}
            </span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {/* A receive's source is always "Vendor" — saying so adds nothing when
            the vendor name is on its own line below. Show the destination. */}
        {isReceive ? (
          d.toName && <span>Into <strong style={{ color: 'var(--text)' }}>{d.toName}</strong></span>
        ) : (
          <>
            {d.fromName && <span>From <strong style={{ color: 'var(--text)' }}>{d.fromName}</strong></span>}
            {d.fromName && d.toName && <span style={{ color: 'var(--hint)' }}>→</span>}
            {d.toName && <span>To <strong style={{ color: 'var(--text)' }}>{d.toName}</strong></span>}
          </>
        )}
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--hint)' }}>
          {fmtDayYear(balance ? m.created_at : movementEffectiveDate(m))}
          {m.created_by_user && ` · ${m.created_by_user.initials}`}
        </span>
      </div>

      {/* Vendor / reference / cost. Labels follow the resolved shape — a
          freeform vendor_invoice is never labelled as an invoice number. */}
      {isReceive && (meta.vendor || meta.reference || meta.unitCost != null) && (
        <div style={{
          fontSize: 11, color: 'var(--muted)', marginTop: 5,
          display: 'flex', gap: 8, flexWrap: 'wrap', wordBreak: 'break-word',
        }}>
          {meta.vendor && <span>Vendor <strong style={{ color: 'var(--text)' }}>{meta.vendor}</strong></span>}
          {meta.reference && <span style={{ color: 'var(--hint)' }}>Ref {meta.reference}</span>}
          {meta.unitCost != null && (
            <span style={{ color: 'var(--hint)' }}>
              ${meta.unitCost.toFixed(2)}/{unit}
              {ext != null && !isQtyPaused && ` · ext $${ext.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </span>
          )}
        </div>
      )}

      {!notesAreRedundant && (
        <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4, wordBreak: 'break-word' }}>
          {m.notes}
        </div>
      )}
    </div>
  )
}

// Newest first by effective work date (occurred_at ?? created_at).
function byEffectiveDateDesc(rows) {
  return [...rows].sort((a, b) => {
    const ta = new Date(movementEffectiveDate(a) || 0).getTime()
    const tb = new Date(movementEffectiveDate(b) || 0).getTime()
    return tb - ta
  })
}
