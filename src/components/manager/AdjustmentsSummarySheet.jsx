import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import { getAdjustmentsForSummary, getLocations } from '../../lib/inventory'
import { isoLocalDate } from '../../lib/format'
import { escapeCsvField, downloadTextAsFile } from '../../lib/csvImport'
import {
  ADJUST_SOURCES, DEFAULT_SOURCES, toAdjustRows, filterBySources,
  summarizeByLocation, summarizeByArea, summarizeByPart, totals, fmtSigned,
} from '../../lib/adjustmentsSummary'
import { chipStyle, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

// Inventory → Activity → "Adjustments summary" (also linked from Cycle count).
//
// Built Oct 2026 for the warehouse + truck count: adjustments were coming from
// count runs, Reconcile CSVs and spot counts at once, and the only view was a
// one-row-at-a-time feed. This answers "what have we adjusted up vs down, and
// where", and surfaces the pattern that caused most of the confusion — a part
// adjusted DOWN in one spot and UP in another (counted in the wrong place, not
// lost). Read-only; pure aggregation lives in lib/adjustmentsSummary.js.
export default function AdjustmentsSummarySheet({ onClose, initialSince = null }) {
  const { showToast } = useApp()
  useBackClose(1, onClose)

  const [since, setSince] = useState(() => initialSince || isoLocalDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)))
  const [until, setUntil] = useState(() => isoLocalDate(new Date()))
  const [sources, setSources] = useState(DEFAULT_SOURCES)
  const [view, setView] = useState('location')  // 'location' | 'part'
  const [onlyUpDown, setOnlyUpDown] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [capped, setCapped] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!since || !until) return
      setLoading(true)
      setError('')
      try {
        const [movements, locs] = await Promise.all([
          getAdjustmentsForSummary({
            // Local calendar days → instants, same as the Activity export.
            since: new Date(`${since}T00:00:00`).toISOString(),
            until: new Date(`${until}T23:59:59.999`).toISOString(),
            maxRows: MAX_ROWS,
          }),
          getLocations({ includeBins: true, includeInactive: true }),
        ])
        if (cancelled) return
        const locById = new Map(locs.map(l => [l.id, l]))
        setAllRows(toAdjustRows(movements, locById))
        setCapped(movements.length >= MAX_ROWS)
      } catch (e) {
        console.error('Adjustments summary load failed:', e)
        if (!cancelled) setError(e.message || 'Could not load adjustments')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [since, until])

  const rows = useMemo(() => filterBySources(allRows, sources), [allRows, sources])
  const sum = useMemo(() => totals(rows), [rows])
  const byArea = useMemo(() => summarizeByArea(rows), [rows])
  const byLocation = useMemo(() => summarizeByLocation(rows), [rows])
  const byPart = useMemo(() => summarizeByPart(rows), [rows])
  const upDownCount = byPart.filter(p => p.upAndDown).length
  const sourceCounts = useMemo(() => {
    const c = {}
    for (const r of allRows) c[r.source] = (c[r.source] || 0) + 1
    return c
  }, [allRows])

  const q = search.trim().toLowerCase()
  const shownLocations = q
    ? byLocation.filter(l => l.locName.toLowerCase().includes(q) || l.areaName.toLowerCase().includes(q)
      || l.parts.some(p => String(p.partName).toLowerCase().includes(q) || String(p.partId).toLowerCase().includes(q)))
    : byLocation
  const shownParts = byPart
    .filter(p => !onlyUpDown || p.upAndDown)
    .filter(p => !q || String(p.partName).toLowerCase().includes(q) || String(p.partId).toLowerCase().includes(q)
      || p.locations.some(l => l.locName.toLowerCase().includes(q)))

  function toggleSource(key) {
    setSources(s => s.includes(key) ? s.filter(k => k !== key) : [...s, key])
  }

  function handleExport() {
    if (rows.length === 0) { showToast('Nothing to export'); return }
    const flagged = new Set(byPart.filter(p => p.upAndDown).map(p => p.partId))
    const label = Object.fromEntries(ADJUST_SOURCES.map(s => [s.key, s.label]))
    const headers = ['Date', 'Area', 'Location', 'SKU', 'Part', 'Unit', 'Direction', 'Signed qty',
      'Source', 'Up & down elsewhere', 'Entered by', 'Notes', 'Movement ID']
    const lines = [headers.map(escapeCsvField).join(',')]
    const sorted = [...rows].sort((a, b) => a.areaName.localeCompare(b.areaName)
      || a.locName.localeCompare(b.locName) || String(a.partId).localeCompare(String(b.partId))
      || String(a.at).localeCompare(String(b.at)))
    for (const r of sorted) {
      lines.push([
        new Date(r.at).toLocaleString(), r.areaName, r.locName, r.partId, r.partName, r.unit,
        r.signed > 0 ? 'Up' : 'Down', r.signed, label[r.source] || r.source,
        flagged.has(r.partId) ? 'yes' : '', r.by, r.notes, r.id,
      ].map(escapeCsvField).join(','))
    }
    downloadTextAsFile(`fiberlog-adjustments-${since}_to_${until}.csv`, lines.join('\n'))
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 820, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)' }}>Adjustments summary</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', marginTop: 2 }}>
              Every stock adjustment booked in the window — up vs down, by location and by part.
            </div>
          </div>
          <button onClick={handleExport} className="btn btn-ghost" disabled={loading || rows.length === 0}
            style={{ flexShrink: 0, padding: '8px 12px', fontSize: 'var(--fs-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="download" size={14} /> CSV
          </button>
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <input type="date" value={since} onChange={e => setSince(e.target.value)} style={dateInput} />
          <span style={{ fontSize: 11, color: 'var(--hint)' }}>to</span>
          <input type="date" value={until} onChange={e => setUntil(e.target.value)} style={dateInput} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {ADJUST_SOURCES.filter(s => sourceCounts[s.key] || sources.includes(s.key)).map(s => (
            <button key={s.key} onClick={() => toggleSource(s.key)} style={chipStyle(sources.includes(s.key))}
              title={s.key === 'refurb' ? 'New → refurbished conversions are a pair, not a count difference — off by default' : undefined}>
              {sources.includes(s.key) && <Icon name="check" size={12} />} {s.label}
              <span style={{ opacity: 0.7 }}>{sourceCounts[s.key] || 0}</span>
            </button>
          ))}
        </div>

        {!loading && capped && (
          <div style={{ fontSize: 12, color: 'var(--warning-fg)', marginBottom: 8, fontWeight: 600 }}>
            Showing the first {MAX_ROWS.toLocaleString()} adjustments only — narrow the dates for complete totals.
          </div>
        )}

        {/* Totals */}
        {!loading && !error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 10 }}>
            <Stat label="Adjusted up" value={`${sum.upLines} lines`} tone="up" />
            <Stat label="Adjusted down" value={`${sum.downLines} lines`} tone="down" />
            <Stat label="Parts / locations" value={`${sum.parts} / ${sum.locations}`} />
            <Stat label="Up here, down there" value={`${upDownCount} parts`} tone={upDownCount > 0 ? 'warn' : null}
              onClick={upDownCount > 0 ? () => { setView('part'); setOnlyUpDown(true); setExpanded(null) } : null} />
          </div>
        )}

        {/* View toggle + search */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => { setView('location'); setExpanded(null) }} style={chipStyle(view === 'location')}>
            <Icon name="pin" size={13} /> By location
          </button>
          <button onClick={() => { setView('part'); setExpanded(null) }} style={chipStyle(view === 'part')}>
            <Icon name="box" size={13} /> By part
          </button>
          {view === 'part' && (
            <button onClick={() => setOnlyUpDown(v => !v)} style={chipStyle(onlyUpDown, { color: 'amber' })}>
              Up & down only
            </button>
          )}
          <input
            type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter by part or location" autoComplete="off" name="adjustments-search"
            style={{ flex: '1 1 180px', minWidth: 0, height: 30, padding: '0 10px', border: '1px solid var(--border2)', borderRadius: 999, fontSize: 12, background: 'var(--surface)' }}
          />
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {loading ? <LoadingBlock /> : error ? (
            <div className="banner banner-danger" style={{ borderRadius: 'var(--r-sm)', border: '1px solid var(--danger-border)' }}>
              <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name="alert" size={16} /></span>
              <div className="banner-body">{error}</div>
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon="activity">No adjustments in this window.</EmptyState>
          ) : view === 'location' ? (
            <>
              {/* Area roll-up: one line per warehouse (all its bins) / truck / group */}
              {!q && byArea.length > 1 && (
                <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                  <div style={tableHead}>
                    <span style={{ flex: 1 }}>Area</span><span style={numCol}>Up</span><span style={numCol}>Down</span>
                  </div>
                  {byArea.map(a => (
                    <div key={a.areaId} style={tableRow}>
                      <span style={{ flex: 1, minWidth: 0, fontWeight: 'var(--fw-semibold)' }}>
                        {a.areaName}
                        {a.areaType === 'warehouse' && <span style={{ color: 'var(--hint)', fontWeight: 400 }}> · {a.locationCount} spot{a.locationCount === 1 ? '' : 's'}</span>}
                      </span>
                      <span style={{ ...numCol, color: 'var(--success-fg)' }}>{a.upLines}</span>
                      <span style={{ ...numCol, color: 'var(--danger-fg)' }}>{a.downLines}</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 6 }}>
                Counts are adjustment lines. Quantities mix feet and each — compare them only within one part. Tap a location for its parts.
              </div>
              {shownLocations.map(l => {
                const open = expanded === l.locId
                return (
                  <div key={l.locId} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 6, background: 'var(--surface)' }}>
                    <button onClick={() => setExpanded(open ? null : l.locId)} style={rowButton}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)' }}>{l.locName}</div>
                        <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                          {l.locType === 'bin' ? l.areaName : l.locType} · {l.parts.length} part{l.parts.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <UpDown up={l.upLines} down={l.downLines} />
                      <span style={{ color: 'var(--hint)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                    </button>
                    {open && (
                      <div style={{ padding: '0 12px 8px' }}>
                        {l.parts.map(p => (
                          <div key={p.partId} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderTop: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              {p.partName}
                              <span style={{ fontSize: 11, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}> {p.partId}</span>
                              {p.lines > 1 && <span style={{ fontSize: 11, color: 'var(--warning-fg)' }}> · {p.lines}× adjusted</span>}
                            </span>
                            <NetQty net={p.net} unit={p.unit} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 6 }}>
                Net change per part across every location. <b style={{ color: 'var(--warning-fg)' }}>Amber</b> = went up in one place
                and down in another — usually the same stock counted in the wrong spot. Recount those before trusting either side.
              </div>
              {shownParts.length === 0 && <EmptyState padding={24}>No parts match.</EmptyState>}
              {shownParts.map(p => {
                const open = expanded === p.partId
                return (
                  <div key={p.partId} style={{
                    border: `1px solid ${p.upAndDown ? 'var(--warning-fg)' : 'var(--border)'}`,
                    background: p.upAndDown ? 'var(--warning-bg)' : 'var(--surface)',
                    borderRadius: 'var(--r-sm)', marginBottom: 6,
                  }}>
                    <button onClick={() => setExpanded(open ? null : p.partId)} style={rowButton}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-sm)' }}>{p.partName}</div>
                        <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                          <span style={{ fontFamily: 'var(--font-mono)' }}>{p.partId}</span> · {p.locations.length} location{p.locations.length === 1 ? '' : 's'}
                          {p.repeats > 0 && <> · {p.repeats} adjusted more than once</>}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <NetQty net={p.net} unit={p.unit} />
                        <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                          {fmtSigned(p.upQty)} / {fmtSigned(-p.downQty)}
                        </div>
                      </div>
                      <span style={{ color: 'var(--hint)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                    </button>
                    {open && (
                      <div style={{ padding: '0 12px 8px' }}>
                        {p.locations.map(l => (
                          <div key={l.locId} style={{ borderTop: '1px solid var(--border)', padding: '6px 0' }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 'var(--fs-sm)' }}>
                              <span style={{ flex: 1, minWidth: 0, fontWeight: 'var(--fw-semibold)' }}>{l.locName}</span>
                              <NetQty net={l.net} unit={p.unit} />
                            </div>
                            {l.rows.map(r => (
                              <div key={r.id} style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--muted)', paddingLeft: 10, marginTop: 2 }}>
                                <span style={{ width: 70, flexShrink: 0 }}>{new Date(r.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                                <span style={{ width: 52, flexShrink: 0, color: r.signed > 0 ? 'var(--success-fg)' : 'var(--danger-fg)', fontWeight: 600 }}>{fmtSigned(r.signed)}</span>
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.notes}>
                                  {ADJUST_SOURCES.find(s => s.key === r.source)?.label}{r.by ? ` · ${r.by}` : ''}{r.notes ? ` · ${r.notes}` : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>

        <button className="btn btn-primary" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Cap so a year-long window can't hang a phone; the UI says when it bites.
const MAX_ROWS = 20000

const dateInput = {
  height: 30, padding: '0 8px', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
  fontSize: 12, background: 'var(--surface)',
}
const tableHead = {
  display: 'flex', gap: 8, padding: '6px 12px', fontSize: 11, fontWeight: 700,
  color: 'var(--muted)', background: 'var(--surface2)', borderBottom: '1px solid var(--border)',
}
const tableRow = {
  display: 'flex', gap: 8, padding: '6px 12px', fontSize: 'var(--fs-sm)', borderBottom: '1px solid var(--border)',
}
const numCol = { width: 56, textAlign: 'right', flexShrink: 0, fontWeight: 600 }
const rowButton = {
  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 12px',
  background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'var(--text)',
}

function Stat({ label, value, tone = null, onClick = null }) {
  const fg = tone === 'up' ? 'var(--success-fg)' : tone === 'down' ? 'var(--danger-fg)' : tone === 'warn' ? 'var(--warning-fg)' : 'var(--text)'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag onClick={onClick || undefined} style={{
      padding: '8px 10px', borderRadius: 'var(--r-sm)', textAlign: 'left',
      border: `1px solid ${tone === 'warn' ? 'var(--warning-fg)' : 'var(--border)'}`,
      background: tone === 'warn' ? 'var(--warning-bg)' : 'var(--surface)',
      cursor: onClick ? 'pointer' : 'default', color: 'var(--text)',
    }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-black)', color: fg }}>{value}</div>
    </Tag>
  )
}

function UpDown({ up, down }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexShrink: 0, fontSize: 12, fontWeight: 700 }}>
      <span style={{ color: up ? 'var(--success-fg)' : 'var(--hint)' }}>▲ {up}</span>
      <span style={{ color: down ? 'var(--danger-fg)' : 'var(--hint)' }}>▼ {down}</span>
    </span>
  )
}

function NetQty({ net, unit }) {
  const color = net > 0 ? 'var(--success-fg)' : net < 0 ? 'var(--danger-fg)' : 'var(--hint)'
  return (
    <span style={{ fontWeight: 700, color, fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap' }}>
      {fmtSigned(net)} <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--hint)' }}>{unit || 'ea'}</span>
    </span>
  )
}
