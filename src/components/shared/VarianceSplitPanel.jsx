import { useEffect, useMemo, useRef, useState } from 'react'
import { getPartLocations } from '../../lib/inventory'
import { getRecentPartAdjustments } from '../../lib/cycleCount'
import { splitStatus, splitPrefillQty } from '../../lib/varianceSplit'
import Icon from './Icon'

// "Where did the difference go / come from?" — the ONE panel for settling a
// counted-vs-books difference, shared by the cycle-count review (Recount /
// move…), Reconcile (Split across locations…) and Record movement → Counted
// total (Oct 2026: the owner liked the count-review way and wanted it
// everywhere). Controlled: the parent owns `lines` and does the booking.
//
// Shows, for the part:
//   - one line per location (picker + qty), the picker listing where the part
//     IS on the books first, with the quantity;
//   - "Also on the books at" chips — tap adds that location, prefilled
//     (splitPrefillQty: a −3 truck on a loss most likely took 3);
//   - what's left over (books as an adjust), overdraw warnings on a gain;
//   - recent adjustments of the part — a −40 here next to last week's +40 on
//     the next shelf is almost always the same stock.
//
// Props:
//   partId, unit, location {id, name}   the counted spot
//   diff            counted − books (signed); null while unknown
//   gain            override direction while diff is 0/unknown (else diff > 0)
//   lines           [{ key, locationId, qty }] (qty as typed); onLinesChange
//   options         [{ id, label }] — places stock can move to/from
//   stockByLocation Map locationId → qty for this part; omitted = loaded here
//                   (negatives included — that's the point of the chips)
//   reloadKey       bump to refetch the loaded data
//   showRecent      load + show recent adjustments (default true)
//   nameBase        input name prefix (autofill suppression)
//   optional        label the section optional (false where a split is required)
export default function VarianceSplitPanel({
  partId, unit = 'ea', location, diff, gain: gainProp, lines, onLinesChange,
  options, stockByLocation = null, reloadKey = 0, showRecent = true, nameBase = 'variance-split', optional = true,
}) {
  const [loadedStock, setLoadedStock] = useState(null)
  const [recent, setRecent] = useState(null)

  useEffect(() => {
    if (stockByLocation) return
    let cancelled = false
    setLoadedStock(null)  // no stale chips / warnings while refetching
    getPartLocations(partId, { includeNegative: true })
      .then(r => {
        if (cancelled) return
        // Regions are consumed material, never a place to move stock to/from.
        setLoadedStock(new Map(r.locations.filter(l => !l.isConsumed).map(l => [l.locationId, Number(l.qty) || 0])))
      })
      .catch(e => { console.warn('Split panel stock load failed:', e); if (!cancelled) setLoadedStock(new Map()) })
    return () => { cancelled = true }
  }, [partId, stockByLocation, reloadKey])

  useEffect(() => {
    if (!showRecent) return
    let cancelled = false
    setRecent(null)
    getRecentPartAdjustments(partId)
      .then(m => { if (!cancelled) setRecent(m) })
      .catch(e => { console.warn('Recent adjustments load failed:', e); if (!cancelled) setRecent([]) })
    return () => { cancelled = true }
  }, [partId, showRecent, reloadKey])

  const stock = stockByLocation || loadedStock
  const qtyAt = id => stock?.get(id) ?? 0
  const gain = diff != null && diff !== 0 ? diff > 0 : !!gainProp
  const st = splitStatus(diff, lines)

  // Lines entered as "went to Truck A" mean the opposite once the difference
  // flips sign (a recount / corrected count): a loss's destination would
  // silently become a gain's source. Clear them so they're re-picked on
  // purpose. Only a real flip counts — 0 / unknown keeps the last direction.
  const lastSign = useRef(null)
  const sign = diff == null || Number(diff) === 0 ? null : Math.sign(Number(diff))
  useEffect(() => {
    if (sign == null) return
    if (lastSign.current != null && lastSign.current !== sign && lines.length > 0) onLinesChange([])
    lastSign.current = sign
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sign])
  const labelOf = id => options.find(o => o.id === id)?.label || '?'

  // Picker: locations that hold the part (either sign) first, by quantity.
  const choices = useMemo(() => options.filter(o => o.id !== location.id), [options, location.id])
  const withStock = useMemo(
    () => choices.filter(o => qtyAt(o.id) !== 0).sort((a, b) => Math.abs(qtyAt(b.id)) - Math.abs(qtyAt(a.id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [choices, stock]
  )
  const withStockIds = new Set(withStock.map(o => o.id))
  const others = choices.filter(o => !withStockIds.has(o.id))

  function addLine(locationId = '') {
    if (locationId && lines.some(l => l.locationId === locationId)) return
    const remaining = st.qty == null ? 0 : Math.max(0, st.qty - st.total)
    const q = splitPrefillQty({ gain, remaining, onBooks: locationId ? qtyAt(locationId) : null })
    onLinesChange([...lines, { key: `vs-${++lineKeySeq}`, locationId, qty: q > 0 ? String(q) : '' }])
  }
  const update = (key, patch) => onLinesChange(lines.map(l => (l.key === key ? { ...l, ...patch } : l)))
  const remove = key => onLinesChange(lines.filter(l => l.key !== key))
  const optionText = o => {
    const q = qtyAt(o.id)
    return q !== 0 ? `${o.label} · ${q.toLocaleString()} on hand` : o.label
  }

  return (
    <div>
      <div className="field" style={{ marginBottom: 8 }}>
        <label>
          {gain ? 'Came from other locations?' : 'Went to other locations?'}
          <span style={{ fontWeight: 400, color: 'var(--hint)' }}> ({optional ? 'optional — ' : ''}books moves instead of an adjustment; split it across as many as you need)</span>
        </label>
        {lines.map(l => (
          <div key={l.key} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <select value={l.locationId} onChange={e => update(l.key, { locationId: e.target.value })}
              style={{ flex: 1, minWidth: 0, ...(l.locationId ? null : { borderColor: 'var(--amber)' }) }}>
              <option value="">Pick a location…</option>
              {/* A location already on another line is left out. */}
              {[['Has this part', withStock], [withStock.length ? 'Other locations' : 'Locations', others]].map(([title, list]) => {
                const shown = list.filter(o => o.id === l.locationId || !lines.some(x => x.locationId === o.id))
                return shown.length > 0 && (
                  <optgroup key={title} label={title}>
                    {shown.map(o => <option key={o.id} value={o.id}>{optionText(o)}</option>)}
                  </optgroup>
                )
              })}
            </select>
            <input type="number" inputMode="decimal" min="0" value={l.qty}
              onChange={e => update(l.key, { qty: e.target.value })}
              placeholder="Qty" aria-label="Quantity" autoComplete="off" name={`${nameBase}-qty`}
              style={{ width: 76, flexShrink: 0 }} />
            <button type="button" className="btn btn-ghost" onClick={() => remove(l.key)}
              aria-label="Remove line" style={{ flexShrink: 0, padding: '6px 8px' }}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => addLine()}
          style={{ padding: '6px 10px', fontSize: 'var(--fs-sm)' }}>
          + {lines.length === 0 ? (gain ? 'Add where it came from' : 'Add where it went') : 'Add another location'}
        </button>
        {lines.length > 0 && st.qty != null && (
          <div style={{ fontSize: 11, marginTop: 4, fontWeight: st.over || st.incomplete ? 700 : 400, color: st.over || st.incomplete ? 'var(--danger-fg)' : 'var(--hint)' }}>
            {st.incomplete
              ? 'Pick a location and a quantity on every line.'
              : st.over
                ? `These add up to ${st.total.toLocaleString()} ${unit} — the difference is only ${st.qty.toLocaleString()} ${unit}.`
                : st.remainder > 0
                  ? `${st.total.toLocaleString()} of ${st.qty.toLocaleString()} ${unit} accounted for — the other ${st.remainder.toLocaleString()} posts as a ${gain ? 'found' : 'lost'} adjustment at ${location.name}.`
                  : `All ${st.qty.toLocaleString()} ${unit} accounted for — no adjustment.`}
          </div>
        )}
      </div>

      {withStock.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={ctxLabel}>Also on the books at — tap to add</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {withStock.slice(0, 10).map(o => {
              const q = qtyAt(o.id)
              const on = lines.some(l => l.locationId === o.id)
              return (
                <button key={o.id} type="button" onClick={() => addLine(o.id)} disabled={on}
                  title={on ? 'Already listed' : 'Add as a location it went to / came from'}
                  style={{ ...miniBtn(on), color: on ? undefined : q < 0 ? 'var(--danger-fg)' : undefined }}>
                  {o.label} · {q.toLocaleString()}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Warn-but-allow: pulling more than a location holds drives it negative. */}
      {gain && stock && st.good.map(sp => {
        const have = qtyAt(sp.locationId)
        return have < sp.qty ? (
          <div key={sp.locationId} style={{ fontSize: 11, color: 'var(--warning-fg)', marginBottom: 6 }}>
            {labelOf(sp.locationId)} only has {have.toLocaleString()} {unit} on the books — this will take it negative.
          </div>
        ) : null
      })}

      {showRecent && recent && recent.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={ctxLabel}>Recent adjustments & count moves of this part (21 days)</div>
          <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-xs)' }}>
            {recent.map(m => {
              const isAdjust = m.movement_type === 'adjust'
              const up = !!m.to_location_id
              const where = isAdjust
                ? (up ? m.to_location : m.from_location)?.name
                : `${m.from_location?.name || '?'} → ${m.to_location?.name || '?'}`
              // An opposite-direction adjust at ANOTHER location is the
              // "counted in the wrong spot" signature — highlight it.
              const opposite = isAdjust
                && (up ? m.to_location_id : m.from_location_id) !== location.id
                && up !== gain
              return (
                <div key={m.id} style={{
                  display: 'flex', gap: 6, padding: '4px 8px', fontSize: 11,
                  borderBottom: '1px solid var(--border)',
                  background: opposite ? 'var(--warning-bg)' : undefined,
                }}>
                  <span style={{ width: 46, flexShrink: 0, color: 'var(--hint)' }}>
                    {new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <span style={{ width: 52, flexShrink: 0, fontWeight: 700, color: !isAdjust ? 'var(--muted)' : up ? 'var(--success-fg)' : 'var(--danger-fg)' }}>
                    {isAdjust ? (up ? '+' : '−') : '⇄ '}{Number(m.quantity).toLocaleString()}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.notes || ''}>
                    {where}{m.notes ? ` · ${m.notes}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

let lineKeySeq = 0  // line keys: unique even when added within one millisecond

const ctxLabel = { fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }

function miniBtn(active) {
  return {
    height: 26, padding: '0 10px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: active ? 'default' : 'pointer',
    background: active ? 'var(--dark-bar)' : 'var(--surface)',
    color: active ? '#fff' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--dark-bar)' : 'var(--border2)'}`,
  }
}
