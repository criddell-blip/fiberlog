import { useState, useEffect } from 'react'
import { getRecentMovements } from '../../lib/inventory'
import { fmtWhen } from '../../lib/format'
import { chipStyle, cardSurface, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

// Movement-type accents. Receive/issue are the in/out pair; the rest keep
// distinct hues so the activity feed is scannable at a glance.
const TYPE_COLORS = {
  receive:  { bg: 'var(--teal-lt)',   text: 'var(--accent-dk)', icon: 'download' },
  transfer: { bg: 'var(--blue-lt)',   text: 'var(--blue)',      icon: 'move' },
  return:   { bg: 'var(--purple-lt)', text: 'var(--purple)',    icon: 'rotate' },
  issue:    { bg: 'var(--amber-lt)',  text: 'var(--amber)',     icon: 'upload' },
  scrap:    { bg: 'var(--red-lt)',    text: 'var(--red)',       icon: 'x' },
  adjust:   { bg: 'var(--gray-lt)',   text: 'var(--muted)',     icon: 'sliders' },
}

const TYPE_LABELS = {
  receive:  'Receive',
  transfer: 'Transfer',
  return:   'Return',
  issue:    'Issue',
  scrap:    'Scrap',
  adjust:   'Adjust',
}

export default function InventoryMovementsTab({ locations, refreshKey }) {
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState('all')
  const [filterLocation, setFilterLocation] = useState('all')

  async function load() {
    setLoading(true)
    try {
      const data = await getRecentMovements({
        limit: 200,
        type: filterType === 'all' ? null : filterType,
        locationId: filterLocation === 'all' ? null : filterLocation,
      })
      setMovements(data)
    } catch (e) {
      console.error('Load movements failed:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filterType, filterLocation, refreshKey])

  return (
    <div>
      {/* Type filter chips */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={() => setFilterType('all')} style={chipStyle(filterType === 'all')}>All types</button>
        {Object.keys(TYPE_LABELS).map(t => (
          <button key={t} onClick={() => setFilterType(t)} style={chipStyle(filterType === t)}>
            <Icon name={TYPE_COLORS[t].icon} size={13} /> {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      <select
        value={filterLocation}
        onChange={e => setFilterLocation(e.target.value)}
        style={{ width: '100%', height: 38, padding: '0 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border2)', fontSize: 14, background: 'var(--surface)', marginBottom: 12 }}
      >
        <option value="all">All locations</option>
        {locations.map(loc => (
          <option key={loc.id} value={loc.id}>
            {loc.assigned_user?.name || loc.name} ({loc.type})
          </option>
        ))}
      </select>

      {loading ? (
        <LoadingBlock />
      ) : movements.length === 0 ? (
        <EmptyState icon="activity" padding={48}>
          <div>No movements match your filters.</div>
        </EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {movements.map(m => {
            const baseColors = TYPE_COLORS[m.movement_type] || TYPE_COLORS.adjust
            // Adjust has two directions: positive (to only, adds stock) and
            // negative (from only, removes stock). Surface that visually.
            const isAdjust     = m.movement_type === 'adjust'
            const isAdjustUp   = isAdjust && !m.from_location_id && !!m.to_location_id
            const isAdjustDown = isAdjust && !!m.from_location_id && !m.to_location_id
            const colors = isAdjustUp
              ? { bg: 'var(--teal-lt)', text: 'var(--accent-dk)', icon: 'plus' }
              : isAdjustDown
              ? { bg: 'var(--red-lt)',  text: 'var(--red)',       icon: 'x' }
              : baseColors
            const label = isAdjustUp ? 'Adjust up' : isAdjustDown ? 'Adjust down' : TYPE_LABELS[m.movement_type]
            const qtyColor = isAdjustUp ? 'var(--accent-dk)' : isAdjustDown ? 'var(--red)' : 'var(--text)'
            const qtyPrefix = isAdjustUp ? '+' : isAdjustDown ? '−' : ''
            const fromName = m.from_location?.name || (m.movement_type === 'receive' ? 'Vendor' : null)
            const toName   = m.to_location?.name   || (m.movement_type === 'issue' || m.movement_type === 'scrap' ? 'Consumed' : null)
            return (
              <div key={m.id} style={{
                ...cardSurface,
                borderLeft: `3px solid ${colors.text}`,
                padding: '11px 14px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                    background: colors.bg, color: colors.text, whiteSpace: 'nowrap',
                  }}><Icon name={colors.icon} size={12} /> {label}</span>
                  <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {m.part?.name || m.part_id}
                  </div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: qtyColor }}>
                    {qtyPrefix}{Number(m.quantity).toLocaleString()}<span style={{ fontSize: 11, color: 'var(--hint)', fontWeight: 500, marginLeft: 3 }}>{m.unit || m.part?.unit || 'ea'}</span>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {fromName && <span>From <strong style={{ color: 'var(--text)' }}>{fromName}</strong></span>}
                  {fromName && toName && <span style={{ color: 'var(--hint)' }}>→</span>}
                  {toName && <span>To <strong style={{ color: 'var(--text)' }}>{toName}</strong></span>}
                  <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--hint)' }}>
                    {fmtWhen(m.created_at)}
                    {m.created_by_user && ` · ${m.created_by_user.initials}`}
                  </span>
                </div>
                {(m.vendor_invoice || m.notes) && (
                  <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                    {m.vendor_invoice && <span>Invoice: {m.vendor_invoice}</span>}
                    {m.vendor_invoice && m.notes && ' · '}
                    {m.notes && <span>{m.notes}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
