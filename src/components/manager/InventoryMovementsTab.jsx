import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { getRecentMovements, getMovementsForActivityExport, movementEffectiveDate } from '../../lib/inventory'
import { escapeCsvField, downloadTextAsFile } from '../../lib/csvImport'
import { fmtWhen } from '../../lib/format'
import { chipStyle, cardSurface, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

// Local calendar date as YYYY-MM-DD (toISOString would shift the day in
// negative-offset timezones — same trap SageExportSheet documents).
function isoLocalDate(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

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
  const { showToast } = useApp()
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState('all')
  const [filterLocation, setFilterLocation] = useState('all')
  // Export date range — applies ONLY to the CSV export; the live feed above
  // stays "200 most recent" regardless. Defaults to the last 30 days.
  const [exportFrom, setExportFrom] = useState(() =>
    isoLocalDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)))
  const [exportTo, setExportTo] = useState(() => isoLocalDate(new Date()))
  const [exporting, setExporting] = useState(false)

  // Full movement history as a file. Honors the tab's type + location filters
  // plus the date range. Deliberately NOT the Sage exclusion rules — adjusts,
  // truck→truck handoffs and warehouse↔bin shuffles are exactly the rows an
  // investigation needs, and this is the only place they can leave the app.
  async function handleExportCsv() {
    if (!exportFrom || !exportTo) { showToast('Pick a from and to date'); return }
    setExporting(true)
    try {
      const MAX = 20000
      const rows = await getMovementsForActivityExport({
        // Local calendar day → absolute instants (same conversion the Sage
        // sheet uses, so the two exports agree about what "July 30" means).
        since: new Date(`${exportFrom}T00:00:00`).toISOString(),
        until: new Date(`${exportTo}T23:59:59.999`).toISOString(),
        type: filterType === 'all' ? null : filterType,
        locationId: filterLocation === 'all' ? null : filterLocation,
        maxRows: MAX,
      })
      if (rows.length === 0) { showToast('No movements in that range'); return }
      const headers = [
        'Date', 'Recorded', 'Type', 'SKU', 'Part', 'Qty', 'Unit',
        'From', 'To', 'By', 'Vendor/Invoice', 'Notes', 'Movement ID',
      ]
      const lines = [headers.map(escapeCsvField).join(',')]
      for (const m of rows) {
        // Two date columns on purpose: Date is the effective/work date
        // (occurred_at ?? created_at — what reporting uses), Recorded is when
        // the row was inserted. Imports make them differ; exporting both
        // sidesteps the "which day was this really" argument.
        const eff = movementEffectiveDate(m)
        // Adjusts carry their direction in which endpoint is set (to = up,
        // from = down) — spell it out in Type, and sign the qty so a
        // spreadsheet SUM over adjusts nets out correctly.
        const isAdjust = m.movement_type === 'adjust'
        const adjustDown = isAdjust && !m.to_location && !!m.from_location
        const typeLabel = isAdjust ? (adjustDown ? 'adjust down' : 'adjust up') : m.movement_type
        const qtySigned = adjustDown ? -Math.abs(Number(m.quantity)) : Number(m.quantity)
        lines.push([
          eff ? String(eff).slice(0, 10) : '',
          m.created_at ? String(m.created_at).slice(0, 10) : '',
          typeLabel,
          m.part?.id || m.part_id || '',
          m.part?.name || '',
          qtySigned,
          m.unit || m.part?.unit || 'ea',
          m.from_location?.name || (m.movement_type === 'receive' ? 'Vendor' : ''),
          m.to_location?.name || (m.movement_type === 'issue' || m.movement_type === 'scrap' ? 'Consumed' : ''),
          m.created_by_user?.name || '',
          m.vendor_invoice || '',
          m.notes || '',
          m.id,
        ].map(escapeCsvField).join(','))
      }
      downloadTextAsFile(`fiberlog-activity-${exportFrom}_to_${exportTo}.csv`, lines.join('\n'))
      showToast(rows.length === MAX
        ? `Exported ${MAX.toLocaleString()} movements — RANGE CAPPED, narrow the dates for the rest`
        : `Exported ${rows.length.toLocaleString()} movements`)
    } catch (e) {
      console.error('Activity export failed:', e)
      showToast('Export failed: ' + e.message)
    } finally {
      setExporting(false)
    }
  }

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

      {/* Export bar. The feed above shows the 200 most recent; this is how the
          FULL history leaves the app (the Sage export deliberately drops
          adjusts / truck→truck / bin moves — this one keeps everything). */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 10px', marginBottom: 12,
        background: 'var(--surface2)', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Export history</span>
        <input type="date" value={exportFrom} onChange={e => setExportFrom(e.target.value)}
          style={{ height: 30, padding: '0 8px', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', fontSize: 12, background: 'var(--surface)' }} />
        <span style={{ fontSize: 11, color: 'var(--hint)' }}>to</span>
        <input type="date" value={exportTo} onChange={e => setExportTo(e.target.value)}
          style={{ height: 30, padding: '0 8px', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', fontSize: 12, background: 'var(--surface)' }} />
        <button onClick={handleExportCsv} disabled={exporting}
          style={{ ...chipStyle(false), marginLeft: 'auto', opacity: exporting ? 0.6 : 1 }}>
          <Icon name="download" size={13} /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>

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
