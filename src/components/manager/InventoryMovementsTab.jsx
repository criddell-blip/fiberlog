import { useState, useEffect } from 'react'
import { getRecentMovements } from '../../lib/inventory'

const TYPE_COLORS = {
  receive:  { bg: 'var(--teal-lt)',   text: 'var(--teal-dk)', icon: '⬇' },
  transfer: { bg: 'var(--blue-lt)',   text: 'var(--blue)',    icon: '↔' },
  return:   { bg: 'var(--purple-lt)', text: 'var(--purple)',  icon: '↩' },
  issue:    { bg: 'var(--orange-lt)', text: 'var(--orange)',  icon: '⬆' },
  scrap:    { bg: 'var(--red-lt)',    text: 'var(--red)',     icon: '✕' },
  adjust:   { bg: 'var(--amber-lt)',  text: 'var(--amber)',   icon: '±' },
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
      {/* Filters */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <button onClick={() => setFilterType('all')} style={pillStyle(filterType === 'all')}>All types</button>
        {Object.keys(TYPE_LABELS).map(t => (
          <button key={t} onClick={() => setFilterType(t)} style={pillStyle(filterType === t)}>
            {TYPE_COLORS[t].icon} {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      <select
        value={filterLocation}
        onChange={e => setFilterLocation(e.target.value)}
        style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--border2)', fontSize: 13, background: 'var(--bg)', marginBottom: 12 }}
      >
        <option value="all">All locations</option>
        {locations.map(loc => (
          <option key={loc.id} value={loc.id}>
            {loc.assigned_user?.name || loc.name} ({loc.type})
          </option>
        ))}
      </select>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
      ) : movements.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div>No movements match your filters.</div>
        </div>
      ) : (
        <div>
          {movements.map(m => {
            const colors = TYPE_COLORS[m.movement_type] || TYPE_COLORS.adjust
            const fromName = m.from_location?.name || (m.movement_type === 'receive' ? 'Vendor' : null)
            const toName   = m.to_location?.name   || (m.movement_type === 'issue' || m.movement_type === 'scrap' ? 'Consumed' : null)
            return (
              <div key={m.id} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderLeft: `4px solid ${colors.text}`,
                borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                    background: colors.bg, color: colors.text
                  }}>{colors.icon} {TYPE_LABELS[m.movement_type]}</span>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {m.part?.name || m.part_id}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--orange)' }}>
                    {Number(m.quantity).toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{m.unit || m.part?.unit || 'ea'}</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {fromName && <span>From <strong style={{ color: 'var(--text)' }}>{fromName}</strong></span>}
                  {fromName && toName && <span>→</span>}
                  {toName && <span>To <strong style={{ color: 'var(--text)' }}>{toName}</strong></span>}
                  <span style={{ marginLeft: 'auto' }}>
                    {new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {m.created_by_user && ` · ${m.created_by_user.initials}`}
                  </span>
                </div>
                {(m.vendor_invoice || m.notes) && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
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

function pillStyle(selected) {
  return {
    padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: selected ? 'var(--orange)' : 'var(--gray-lt)',
    color: selected ? 'white' : 'var(--muted)',
    border: 'none', cursor: 'pointer',
  }
}
