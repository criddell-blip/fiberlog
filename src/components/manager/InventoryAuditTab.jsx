import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  getStockForAudit,
  getPartsCatalogTaxonomy,
  getBinsForWarehouse,
  compareNamesNatural,
} from '../../lib/inventory'

// Audit / cycle-count export tab.
//
// Manager picks a location scope plus optional filters, generates an audit
// sheet (CSV), and walks the warehouse with it. The CSV has an "Actual qty"
// blank column and a "Variance" formula column so opening it in Excel /
// Sheets / Numbers makes the discrepancy show up automatically as the
// counter fills in actual quantities.

const TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

// Scope is encoded as a string with prefix:
//   'all'                       → every location
//   'warehouse-tree:<id>'       → a specific warehouse + all its bins
//   'loc:<id>'                  → exactly one location (any type, including a bin)
//   'type:<type>'               → all locations of one type (e.g., all trucks)

export default function InventoryAuditTab({ locations, refreshKey }) {
  const { showToast } = useApp()

  const [scope, setScope] = useState('all')
  const [partStatus, setPartStatus] = useState('active')
  const [stockLevel, setStockLevel] = useState('with')
  const [department, setDepartment] = useState('')
  const [materialGroup, setMaterialGroup] = useState('')
  const [staleEnabled, setStaleEnabled] = useState(false)
  const [staleDays, setStaleDays] = useState('90')

  const [taxonomy, setTaxonomy] = useState({ departments: [], materialGroups: [] })
  const [binsByWarehouse, setBinsByWarehouse] = useState({})

  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  // Load taxonomy + bins once
  useEffect(() => {
    getPartsCatalogTaxonomy().then(setTaxonomy).catch(e => {
      console.warn('Load taxonomy failed:', e)
    })
  }, [refreshKey])

  // Load bins for every warehouse so we can build the scope dropdown
  useEffect(() => {
    const warehouses = locations.filter(l => l.type === 'warehouse')
    if (warehouses.length === 0) {
      setBinsByWarehouse({})
      return
    }
    let cancelled = false
    Promise.all(warehouses.map(async (w) => {
      try {
        const bins = await getBinsForWarehouse(w.id)
        return [w.id, bins]
      } catch (e) {
        return [w.id, []]
      }
    })).then(pairs => {
      if (!cancelled) setBinsByWarehouse(Object.fromEntries(pairs))
    })
    return () => { cancelled = true }
  }, [locations, refreshKey])

  // Resolve the scope string into a list of location ids (or null = all)
  function resolveScope() {
    if (scope === 'all') return null
    if (scope.startsWith('loc:')) {
      return [scope.slice(4)]
    }
    if (scope.startsWith('warehouse-tree:')) {
      const warehouseId = scope.slice('warehouse-tree:'.length)
      const bins = binsByWarehouse[warehouseId] || []
      return [warehouseId, ...bins.map(b => b.id)]
    }
    if (scope.startsWith('type:')) {
      const t = scope.slice(5)
      return locations.filter(l => l.type === t).map(l => l.id)
    }
    return null
  }

  // Build a friendly scope description for the result header
  function scopeLabel() {
    if (scope === 'all') return 'All locations'
    if (scope.startsWith('loc:')) {
      const id = scope.slice(4)
      // Could be a top-level location or a bin
      const top = locations.find(l => l.id === id)
      if (top) return `${TYPE_ICONS[top.type] || '📦'} ${top.assigned_user?.name || top.name}`
      // Search bins
      for (const [wid, bins] of Object.entries(binsByWarehouse)) {
        const bin = bins.find(b => b.id === id)
        if (bin) {
          const w = locations.find(l => l.id === wid)
          return `📥 ${w?.name || 'Warehouse'} / ${bin.name}`
        }
      }
      return 'Specific location'
    }
    if (scope.startsWith('warehouse-tree:')) {
      const wid = scope.slice('warehouse-tree:'.length)
      const w = locations.find(l => l.id === wid)
      return `🏭 ${w?.name || 'Warehouse'} (incl. all bins)`
    }
    if (scope.startsWith('type:')) {
      const t = scope.slice(5)
      return `All ${t}s`
    }
    return scope
  }

  async function handleGenerate() {
    setError(null)
    setGenerating(true)
    try {
      const locationIds = resolveScope()
      const rows = await getStockForAudit({
        locationIds,
        partStatus,
        stockLevel,
        department: department || null,
        materialGroup: materialGroup || null,
        staleDays: staleEnabled ? Number(staleDays) : null,
      })

      // Sort: location name → bin presence (no-bin first within a warehouse) → bin name → part name
      const sorted = [...rows].sort((a, b) => {
        const aLoc = a.location, bLoc = b.location
        // For bins, sort by parent warehouse name; for non-bins, by own name
        const aGroup = aLoc?.type === 'bin'
          ? (locations.find(l => l.id === aLoc.parent_location_id)?.name || aLoc.name)
          : (aLoc?.assigned_user?.name || aLoc?.name || '')
        const bGroup = bLoc?.type === 'bin'
          ? (locations.find(l => l.id === bLoc.parent_location_id)?.name || bLoc.name)
          : (bLoc?.assigned_user?.name || bLoc?.name || '')
        const groupCmp = aGroup.localeCompare(bGroup)
        if (groupCmp !== 0) return groupCmp

        // Within the same group, unbinned warehouse stock (type=warehouse) first,
        // then bins alphabetically
        if (aLoc?.type === 'warehouse' && bLoc?.type === 'bin') return -1
        if (aLoc?.type === 'bin' && bLoc?.type === 'warehouse') return 1
        if (aLoc?.type === 'bin' && bLoc?.type === 'bin') {
          const binCmp = compareNamesNatural(aLoc.name, bLoc.name)
          if (binCmp !== 0) return binCmp
        }

        // Finally by part name
        return (a.parts_catalog?.name || '').localeCompare(b.parts_catalog?.name || '')
      })

      setResult({
        rows: sorted,
        generatedAt: new Date(),
        filters: {
          scopeLabel: scopeLabel(),
          partStatus, stockLevel,
          department, materialGroup,
          staleDays: staleEnabled ? Number(staleDays) : null,
        },
      })
    } catch (e) {
      console.error('Audit generate failed:', e)
      setError(e.message || 'Generate failed')
    } finally {
      setGenerating(false)
    }
  }

  function handleDownload() {
    if (!result) return
    const csv = buildAuditCsv(result.rows, locations)
    const stamp = result.generatedAt.toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const safeScope = result.filters.scopeLabel
      .replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase()
      .slice(0, 40) || 'audit'
    downloadText(`fiberlog-audit-${safeScope}-${stamp}.csv`, csv)
    showToast('Audit sheet downloaded')
  }

  function handleReset() {
    setResult(null)
    setError(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (result) {
    return <ResultView
      result={result}
      locations={locations}
      onReset={handleReset}
      onDownload={handleDownload}
    />
  }

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 4 }}>Audit / cycle-count export</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Generate a printable CSV with expected quantities. Walk the location, fill in actual counts,
          then reconcile.
        </div>
      </div>

      {/* Scope */}
      <div className="field">
        <label>Scope (what are you counting?)</label>
        <select
          value={scope}
          onChange={e => setScope(e.target.value)}
          style={{ width: '100%' }}
        >
          <option value="all">All locations</option>

          {/* Whole-warehouse + bins option for each warehouse */}
          {locations.filter(l => l.type === 'warehouse').length > 0 && (
            <optgroup label="Whole warehouse (incl. bins)">
              {locations.filter(l => l.type === 'warehouse').map(w => (
                <option key={`wt:${w.id}`} value={`warehouse-tree:${w.id}`}>
                  🏭 {w.name} (incl. all bins)
                </option>
              ))}
            </optgroup>
          )}

          {/* Per-bin options grouped by warehouse */}
          {Object.entries(binsByWarehouse).filter(([, bins]) => bins.length > 0).map(([wid, bins]) => {
            const w = locations.find(l => l.id === wid)
            if (!w) return null
            return (
              <optgroup key={`bingroup:${wid}`} label={`${w.name} — specific bins`}>
                {bins.map(b => (
                  <option key={`loc:${b.id}`} value={`loc:${b.id}`}>
                    📥 {w.name} / {b.name}
                  </option>
                ))}
                <option value={`loc:${wid}`}>
                  🏭 {w.name} — unbinned only
                </option>
              </optgroup>
            )
          })}

          {/* Specific top-level locations grouped by type */}
          {['truck', 'job_site', 'vendor', 'scrap'].map(t => {
            const list = locations.filter(l => l.type === t)
            if (list.length === 0) return null
            return (
              <optgroup key={`type:${t}`} label={`All ${t}s`}>
                <option value={`type:${t}`}>All {t}s</option>
                {list.map(l => (
                  <option key={`loc:${l.id}`} value={`loc:${l.id}`}>
                    {TYPE_ICONS[t]} {l.assigned_user?.name || l.name}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
      </div>

      {/* Part status pills */}
      <div className="field">
        <label>Part status</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'active', label: '✓ Active' },
            { id: 'draft',  label: '⚠ Drafts' },
            { id: 'all',    label: 'All' },
          ].map(opt => (
            <button key={opt.id} onClick={() => setPartStatus(opt.id)} style={pillStyle(partStatus === opt.id)}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stock level pills */}
      <div className="field">
        <label>Stock level</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { id: 'with',          label: 'With stock (>0)' },
            { id: 'zero_negative', label: 'Zero or negative' },
            { id: 'all',           label: 'All (including 0)' },
          ].map(opt => (
            <button key={opt.id} onClick={() => setStockLevel(opt.id)} style={pillStyle(stockLevel === opt.id)}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Optional taxonomy filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label>Department (optional)</label>
          <select value={department} onChange={e => setDepartment(e.target.value)} style={{ width: '100%' }}>
            <option value="">— Any —</option>
            {taxonomy.departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}>
          <label>Material group (optional)</label>
          <select value={materialGroup} onChange={e => setMaterialGroup(e.target.value)} style={{ width: '100%' }}>
            <option value="">— Any —</option>
            {taxonomy.materialGroups.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {/* Stale stock filter */}
      <div style={{
        marginBottom: 14,
        padding: '10px 14px', borderRadius: 'var(--r-sm)',
        border: `1.5px solid ${staleEnabled ? 'var(--orange)' : 'var(--border2)'}`,
        background: staleEnabled ? 'var(--orange-lt)' : 'var(--bg)',
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={staleEnabled}
            onChange={e => setStaleEnabled(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: staleEnabled ? 'var(--orange)' : 'var(--text)' }}>
            Only stale stock
          </span>
          {staleEnabled && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>not moved in</span>
              <input
                type="number"
                min="1"
                value={staleDays}
                onChange={e => setStaleDays(e.target.value)}
                style={{ width: 60, padding: '4px 8px', textAlign: 'right' }}
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>days</span>
            </span>
          )}
        </label>
        {!staleEnabled && (
          <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
            Useful for cycle counts: focus on parts that haven't moved recently — they're most likely to drift.
          </div>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 12,
          background: 'var(--red-lt)', color: 'var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 13,
        }}>{error}</div>
      )}

      <button
        className="btn btn-primary"
        onClick={handleGenerate}
        disabled={generating}
        style={{ width: '100%' }}
      >
        {generating ? 'Generating…' : 'Generate audit sheet'}
      </button>
    </div>
  )
}

// ─── Result view ─────────────────────────────────────────────────────────────

function ResultView({ result, locations, onReset, onDownload }) {
  const { rows, filters, generatedAt } = result

  // Summary stats
  const totalLines = rows.length
  const totalUnits = rows.reduce((a, r) => a + Math.abs(Number(r.quantity) || 0), 0)
  const distinctParts = new Set(rows.map(r => r.part_id)).size
  const distinctLocations = new Set(rows.map(r => r.location_id)).size

  return (
    <div>
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={onReset}
          style={{ fontSize: 18, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          title="Back to filters"
        >←</button>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Audit sheet ready</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {filters.scopeLabel} · generated {generatedAt.toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <Stat label="Rows" value={totalLines.toLocaleString()} accent />
        <Stat label="Distinct parts" value={distinctParts.toLocaleString()} />
        <Stat label="Locations" value={distinctLocations.toLocaleString()} />
        <Stat label="Total units" value={totalUnits.toLocaleString()} />
      </div>

      {/* Filter recap */}
      <div style={{
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 14,
        fontSize: 11, color: 'var(--muted)',
      }}>
        <div><strong style={{ color: 'var(--text)' }}>Filters:</strong></div>
        <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 18 }}>
          <li>Part status: <code>{filters.partStatus}</code></li>
          <li>Stock level: <code>{filters.stockLevel}</code></li>
          {filters.department && <li>Department: <code>{filters.department}</code></li>}
          {filters.materialGroup && <li>Material group: <code>{filters.materialGroup}</code></li>}
          {filters.staleDays != null && <li>Stale: not moved in &gt; {filters.staleDays} days</li>}
        </ul>
      </div>

      <button
        className="btn btn-primary"
        onClick={onDownload}
        style={{ width: '100%', marginBottom: 14 }}
      >
        ⬇ Download CSV
      </button>

      {totalLines === 0 ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--hint)' }}>
          No rows matched these filters. Loosen them and try again.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--hint)', marginBottom: 6 }}>
            Preview (first {Math.min(50, totalLines)} of {totalLines.toLocaleString()})
          </div>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', overflow: 'auto', maxHeight: 400,
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead style={{
                position: 'sticky', top: 0, background: 'var(--surface2)',
                borderBottom: '1px solid var(--border)',
              }}>
                <tr>
                  <th style={cellHead}>SKU</th>
                  <th style={cellHead}>Name</th>
                  <th style={cellHead}>Location</th>
                  <th style={cellHead}>Bin</th>
                  <th style={{ ...cellHead, textAlign: 'right' }}>Expected</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => {
                  const loc = r.location
                  const isBin = loc?.type === 'bin'
                  const locName = isBin
                    ? (locations.find(l => l.id === loc.parent_location_id)?.name || 'Warehouse')
                    : (loc?.assigned_user?.name || loc?.name || '?')
                  const binName = isBin ? loc.name : ''
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ ...cell, fontFamily: 'monospace', fontSize: 10 }}>{r.parts_catalog?.id}</td>
                      <td style={cell}>{r.parts_catalog?.name}</td>
                      <td style={cell}>{locName}</td>
                      <td style={cell}>{binName}</td>
                      <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>
                        {Number(r.quantity).toLocaleString()} {r.parts_catalog?.unit || 'ea'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── CSV building ────────────────────────────────────────────────────────────

const HEADERS = [
  'SKU',
  'Name',
  'Category',
  'Department',
  'Material Group',
  'Unit',
  'Location',
  'Bin',
  'Expected Qty',
  'Actual Qty',
  'Variance',
  'Last Movement',
  'Notes',
]

function csvField(v) {
  if (v == null) return ''
  const s = String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function buildAuditCsv(rows, allLocations) {
  // Variance column index (0-based) → 10, so column letter K. Actual = J, Expected = I.
  // Excel/Sheets formula: =J<row>-I<row>
  const lines = [HEADERS.map(csvField).join(',')]

  rows.forEach((r, idx) => {
    const rowNum = idx + 2   // +2 because row 1 is header, and Excel rows are 1-indexed
    const loc = r.location
    const isBin = loc?.type === 'bin'
    const locName = isBin
      ? (allLocations.find(l => l.id === loc.parent_location_id)?.name || 'Warehouse')
      : (loc?.assigned_user?.name || loc?.name || '')
    const binName = isBin ? (loc?.name || '') : ''
    const lastMoved = r.last_movement_at
      ? new Date(r.last_movement_at).toISOString().slice(0, 10)
      : ''
    const pc = r.parts_catalog || {}

    const fields = [
      pc.id || r.part_id,
      pc.name || '',
      pc.category || '',
      pc.department || '',
      pc.material_group || '',
      pc.unit || 'ea',
      locName,
      binName,
      Number(r.quantity) || 0,
      '',                          // Actual qty — blank for the counter
      `=J${rowNum}-I${rowNum}`,    // Variance formula
      lastMoved,
      '',                          // Notes
    ]
    lines.push(fields.map(csvField).join(','))
  })

  return lines.join('\n')
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ─── Styles ──────────────────────────────────────────────────────────────────

// Console filter chip — active reads as a dark chip.
function pillStyle(selected) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: 30, padding: '0 13px', borderRadius: 999, fontSize: 12, fontWeight: 600,
    whiteSpace: 'nowrap', cursor: 'pointer',
    background: selected ? 'var(--dark-bar)' : 'var(--surface)',
    color: selected ? '#fff' : 'var(--muted)',
    border: `1px solid ${selected ? 'var(--dark-bar)' : 'var(--border2)'}`,
  }
}

function Stat({ label, value, accent }) {
  return (
    <div style={{
      flex: 1, minWidth: 110,
      background: accent ? 'var(--accent-lt)' : 'var(--surface)',
      border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 'var(--r)', padding: '10px 12px', textAlign: 'center',
      boxShadow: accent ? 'none' : '0 1px 3px rgba(15,23,42,0.06)',
    }}>
      <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: accent ? 'var(--accent-dk)' : 'var(--text)' }}>{value}</div>
      <div className="eyebrow" style={{ marginTop: 2 }}>{label}</div>
    </div>
  )
}

const cellHead = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '.04em',
}

const cell = {
  padding: '6px 10px',
  fontSize: 12,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 200,
}
