import { useState, useMemo, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import { recordMovementsBatch } from '../../lib/inventory'
import { parseCsv, readFileAsText } from '../../lib/csvImport'

// Sonar daily-install-report importer (backlog #3).
//
// Each CSV row represents one inventory item that was installed at a
// customer site. We post one `issue` movement per row, off the crew's
// personal truck. Quantity is always 1; no destination (parts are
// consumed).
//
// Two mapping problems Sonar can't solve for us:
//   1. "Install 1 (Jaco)" → which FiberLog user/truck?
//      Auto-match: parse first name from the parenthetical and look up
//      a user whose name starts with that. Manager can override.
//   2. "Wave LR" → which parts_catalog SKU?
//      Auto-match: case-insensitive name contains (either direction).
//      Manager can override.
//
// UX: pickers are grouped at the top — pick ONCE per unique sonarLoc /
// sonarModel and every transaction sharing that value resolves. The
// transactions table below is derived from those mappings.

const REQUIRED_COLS = [
  'Inventory Item ID',
  'Model | Display Name',
  'Previous Inventory Location',
  'Date Time',
  'Current Assignee',
]

function extractFirstName(sonarLoc) {
  const m = /\(([^)]+)\)/.exec(sonarLoc || '')
  return m ? m[1].trim() : null
}

export default function SonarImportSheet({ onClose, onApplied }) {
  const { showToast, currentUser } = useApp()

  // Lookups for the pickers
  const [crewUsers, setCrewUsers] = useState([])         // active crew/contractor
  const [trucksByUser, setTrucksByUser] = useState({})   // user_id → truck_id
  const [parts, setParts] = useState([])                 // active parts_catalog

  // CSV state
  const [fileName, setFileName] = useState('')
  const [csvRows, setCsvRows] = useState(null)
  const [error, setError] = useState('')
  const [parsing, setParsing] = useState(false)

  // Per-mapping picks
  const [crewMap, setCrewMap] = useState({})  // sonarLoc → user_id (or '')
  const [partMap, setPartMap] = useState({})  // sonarModel → part_id (or '')

  // Per-row exclude
  const [excluded, setExcluded] = useState(() => new Set())

  // Submit state
  const [submitting, setSubmitting] = useState(false)

  // Fetch lookups on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [usersRes, trucksRes, partsRes] = await Promise.all([
          db.from('users')
            .select('id, name, role, crew_type')
            .eq('is_active', true)
            .in('role', ['crew', 'contractor'])
            .order('name'),
          db.from('inventory_locations')
            .select('id, assigned_to')
            .eq('type', 'truck')
            .eq('is_active', true)
            .not('assigned_to', 'is', null),
          db.from('parts_catalog')
            .select('id, name, unit')
            .eq('is_active', true)
            .order('name'),
        ])
        if (cancelled) return
        if (usersRes.error)  throw usersRes.error
        if (trucksRes.error) throw trucksRes.error
        if (partsRes.error)  throw partsRes.error
        setCrewUsers(usersRes.data || [])
        const tbu = {}
        for (const t of trucksRes.data || []) tbu[t.assigned_to] = t.id
        setTrucksByUser(tbu)
        setParts(partsRes.data || [])
      } catch (e) {
        if (!cancelled) setError('Failed to load FiberLog lookups: ' + (e.message || e))
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Unique sonar locations + models discovered in the uploaded CSV
  const uniqueSonarLocs = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => r['Previous Inventory Location'] || '').filter(Boolean))]
  }, [csvRows])
  const uniqueSonarModels = useMemo(() => {
    if (!csvRows) return []
    return [...new Set(csvRows.map(r => r['Model | Display Name'] || '').filter(Boolean))]
  }, [csvRows])

  // Auto-match once when CSV loads. Manager picks override these via dropdowns.
  useEffect(() => {
    if (!csvRows || crewUsers.length === 0) return
    const auto = {}
    for (const loc of uniqueSonarLocs) {
      const first = extractFirstName(loc)?.toLowerCase()
      if (!first) continue
      const u = crewUsers.find(u => u.name.toLowerCase().split(' ')[0] === first)
      if (u) auto[loc] = u.id
    }
    setCrewMap(prev => ({ ...auto, ...prev }))   // existing picks win
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueSonarLocs, crewUsers])

  useEffect(() => {
    if (!csvRows || parts.length === 0) return
    const auto = {}
    for (const model of uniqueSonarModels) {
      const ml = model.toLowerCase().trim()
      if (!ml) continue
      // Try exact match first, then substring either direction
      const exact = parts.find(p => (p.name || '').toLowerCase() === ml)
      if (exact) { auto[model] = exact.id; continue }
      const sub = parts.find(p => {
        const pn = (p.name || '').toLowerCase()
        return pn.includes(ml) || ml.includes(pn)
      })
      if (sub) auto[model] = sub.id
    }
    setPartMap(prev => ({ ...auto, ...prev }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueSonarModels, parts])

  async function handleFile(file) {
    if (!file) return
    setError('')
    setParsing(true)
    setFileName(file.name)
    try {
      const text = await readFileAsText(file)
      const { headers, rows } = parseCsv(text)
      if (rows.length === 0) {
        setError('CSV had no data rows')
        setCsvRows([])
        return
      }
      const missing = REQUIRED_COLS.filter(c => !headers.includes(c))
      if (missing.length > 0) {
        setError(`CSV is missing required Sonar columns: ${missing.join(', ')}`)
        setCsvRows([])
        return
      }
      setCsvRows(rows)
      setExcluded(new Set())
      setCrewMap({})
      setPartMap({})
    } catch (e) {
      console.error('Sonar parse failed:', e)
      setError(e.message || String(e))
      setCsvRows([])
    } finally {
      setParsing(false)
    }
  }

  // Resolved status per row, derived from CSV + current mappings
  const resolved = useMemo(() => {
    if (!csvRows) return []
    return csvRows.map((row, idx) => {
      const sonarLoc = row['Previous Inventory Location'] || ''
      const sonarModel = row['Model | Display Name'] || ''
      const userId = crewMap[sonarLoc] || null
      const truckId = userId ? trucksByUser[userId] : null
      const partId = partMap[sonarModel] || null
      const userName = userId
        ? crewUsers.find(u => u.id === userId)?.name || ''
        : ''
      const partName = partId
        ? parts.find(p => p.id === partId)?.name || ''
        : ''
      let status = 'ready'
      if (!userId) status = 'no-crew'
      else if (!truckId) status = 'no-truck'
      else if (!partId) status = 'no-part'
      return {
        idx,
        date: row['Date Time'] || '',
        customer: row['Current Assignee'] || '',
        city: row['Address | City'] || '',
        sonarLoc, sonarModel,
        sonarItemId: row['Inventory Item ID'] || '',
        userId, truckId, userName,
        partId, partName,
        status,
      }
    })
  }, [csvRows, crewMap, partMap, trucksByUser, crewUsers, parts])

  const stats = useMemo(() => {
    if (resolved.length === 0) return null
    let ready = 0, noCrew = 0, noTruck = 0, noPart = 0, excludedCount = 0
    for (const r of resolved) {
      if (excluded.has(r.idx)) { excludedCount++; continue }
      switch (r.status) {
        case 'ready':    ready++;    break
        case 'no-crew':  noCrew++;   break
        case 'no-truck': noTruck++;  break
        case 'no-part':  noPart++;   break
      }
    }
    return { total: resolved.length, ready, noCrew, noTruck, noPart, excludedCount }
  }, [resolved, excluded])

  function toggleExclude(idx) {
    setExcluded(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }

  async function handleApply() {
    setError('')
    setSubmitting(true)
    try {
      const movements = resolved
        .filter(r => !excluded.has(r.idx) && r.status === 'ready')
        .map(r => {
          // Date label for the note. Sonar gives ISO-ish; just take first 16 chars.
          const dateStr = String(r.date).slice(0, 16)
          const noteParts = [
            'Sonar install',
            dateStr,
            r.customer,
            r.city,
            r.sonarItemId && `[sonar:${r.sonarItemId}]`,
          ].filter(Boolean)
          return {
            movement_type: 'issue',
            part_id: r.partId,
            quantity: 1,
            unit: 'ea',
            from_location_id: r.truckId,
            to_location_id: null,
            notes: noteParts.join(' · '),
            created_by: currentUser?.id,
          }
        })
      if (movements.length === 0) {
        setError('Nothing ready to apply')
        return
      }
      await recordMovementsBatch(movements)
      onApplied(movements.length)
    } catch (e) {
      console.error('Sonar apply failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 960, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>⚡ Sonar daily install import</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Upload a Sonar export. Each install row becomes one <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>issue</code> movement off the assigned crew's truck.
        </div>

        {/* File picker */}
        <div style={{
          marginBottom: 12, padding: 10,
          background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <label style={{
            display: 'inline-block', padding: '6px 12px',
            background: 'var(--orange)', color: 'white',
            borderRadius: 'var(--r-sm)', cursor: 'pointer',
            fontSize: 13, fontWeight: 700, flexShrink: 0,
          }}>
            {csvRows ? 'Choose a different file' : 'Choose Sonar CSV'}
            <input
              type="file" accept=".csv,text/csv"
              onChange={e => handleFile(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
          </label>
          {fileName && (
            <div style={{ fontSize: 12, color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fileName}
            </div>
          )}
        </div>

        {parsing && <div style={{ padding: 16, color: 'var(--muted)', textAlign: 'center' }}>Parsing…</div>}

        {error && (
          <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>

          {/* Crew mappings */}
          {uniqueSonarLocs.length > 0 && (
            <MappingSection
              title="Crew mappings"
              subtitle="One pick per Sonar source. Auto-matched by the name in parens; override if wrong."
              accent="var(--teal)"
              items={uniqueSonarLocs}
              renderPicker={(sonarLoc) => (
                <select
                  value={crewMap[sonarLoc] || ''}
                  onChange={e => setCrewMap(prev => ({ ...prev, [sonarLoc]: e.target.value }))}
                  style={selectStyle()}
                >
                  <option value="">— pick crew —</option>
                  {crewUsers.map(u => {
                    const hasTruck = !!trucksByUser[u.id]
                    return (
                      <option key={u.id} value={u.id}>
                        {u.name}{u.crew_type ? ` (${u.crew_type})` : ''}{hasTruck ? '' : ' — no truck!'}
                      </option>
                    )
                  })}
                </select>
              )}
              statusFor={(loc) => {
                const userId = crewMap[loc]
                if (!userId) return { tag: 'unmatched', color: 'var(--amber)' }
                if (!trucksByUser[userId]) return { tag: 'no truck', color: 'var(--red)' }
                return { tag: 'matched', color: 'var(--teal-dk)' }
              }}
              countFor={(loc) => resolved.filter(r => r.sonarLoc === loc).length}
            />
          )}

          {/* Part mappings */}
          {uniqueSonarModels.length > 0 && (
            <MappingSection
              title="Part mappings"
              subtitle="One pick per Sonar model. Auto-matched by name; override if wrong."
              accent="var(--orange)"
              items={uniqueSonarModels}
              renderPicker={(sonarModel) => (
                <select
                  value={partMap[sonarModel] || ''}
                  onChange={e => setPartMap(prev => ({ ...prev, [sonarModel]: e.target.value }))}
                  style={selectStyle()}
                >
                  <option value="">— pick part —</option>
                  {parts.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.id})
                    </option>
                  ))}
                </select>
              )}
              statusFor={(model) => {
                const partId = partMap[model]
                if (!partId) return { tag: 'unmatched', color: 'var(--amber)' }
                return { tag: 'matched', color: 'var(--orange-dk)' }
              }}
              countFor={(model) => resolved.filter(r => r.sonarModel === model).length}
            />
          )}

          {/* Transactions preview */}
          {resolved.length > 0 && (
            <>
              <div style={{
                fontSize: 12, fontWeight: 700, color: 'var(--muted)',
                textTransform: 'uppercase', letterSpacing: '.04em',
                marginTop: 16, marginBottom: 6,
                display: 'flex', justifyContent: 'space-between',
              }}>
                <span>Transactions</span>
                {stats && (
                  <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--hint)' }}>
                    {stats.ready} ready · {stats.noCrew + stats.noPart + stats.noTruck} blocked · {stats.excludedCount} excluded
                  </span>
                )}
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: 'var(--surface2)' }}>
                    <tr>
                      <th style={thStyle({ width: 32 })}>✓</th>
                      <th style={thStyle({ textAlign: 'left' })}>Date</th>
                      <th style={thStyle({ textAlign: 'left' })}>Customer / City</th>
                      <th style={thStyle({ textAlign: 'left' })}>Part</th>
                      <th style={thStyle({ textAlign: 'left' })}>Crew</th>
                      <th style={thStyle({ textAlign: 'left' })}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.map(r => {
                      const isExcluded = excluded.has(r.idx)
                      const isReady = r.status === 'ready'
                      return (
                        <tr key={r.idx} style={{
                          background: isExcluded
                            ? 'var(--gray-lt)'
                            : isReady ? 'transparent' : 'var(--amber-lt)',
                          opacity: isExcluded ? 0.45 : 1,
                        }}>
                          <td style={tdStyle({ textAlign: 'center' })}>
                            {isReady && (
                              <input
                                type="checkbox"
                                checked={!isExcluded}
                                onChange={() => toggleExclude(r.idx)}
                              />
                            )}
                          </td>
                          <td style={tdStyle()}>{String(r.date).slice(0, 16)}</td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>{r.customer}</div>
                            <div style={{ fontSize: 10, color: 'var(--hint)' }}>{r.city}</div>
                          </td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>{r.partName || <em style={{ color: 'var(--amber)' }}>{r.sonarModel}</em>}</div>
                            {r.partId && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{r.partId}</div>}
                          </td>
                          <td style={tdStyle()}>
                            <div style={{ fontWeight: 600 }}>{r.userName || <em style={{ color: 'var(--amber)' }}>{r.sonarLoc}</em>}</div>
                          </td>
                          <td style={tdStyle()}>
                            <StatusBadge status={r.status} />
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

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            {csvRows ? 'Cancel' : 'Close'}
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleApply}
            disabled={submitting || !stats || stats.ready === 0}
          >
            {submitting
              ? 'Applying…'
              : stats && stats.ready > 0
                ? `Apply ${stats.ready} issue${stats.ready === 1 ? '' : 's'}`
                : 'Nothing to apply'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────

function MappingSection({ title, subtitle, accent, items, renderPicker, statusFor, countFor }) {
  return (
    <div style={{
      marginBottom: 12, padding: 10,
      border: `1px solid ${accent}`, borderRadius: 'var(--r-sm)',
      background: 'var(--surface)',
    }}>
      <div style={{
        fontSize: 12, fontWeight: 800, color: accent,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2,
      }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>{subtitle}</div>
      {items.map(item => {
        const s = statusFor(item)
        const n = countFor(item)
        return (
          <div key={item} style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
            padding: '4px 6px', background: 'var(--surface2)', borderRadius: 6,
          }}>
            <div style={{ flex: 2, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item}</div>
              <div style={{ fontSize: 10, color: 'var(--hint)' }}>{n} row{n === 1 ? '' : 's'}</div>
            </div>
            <div style={{ flex: 3, minWidth: 0 }}>{renderPicker(item)}</div>
            <div style={{
              flexShrink: 0, fontSize: 10, fontWeight: 700,
              padding: '2px 8px', borderRadius: 10,
              background: 'var(--bg)', color: s.color,
              border: `1px solid ${s.color}`,
            }}>{s.tag}</div>
          </div>
        )
      })}
    </div>
  )
}

function StatusBadge({ status }) {
  const map = {
    ready:    { label: 'ready',           color: 'var(--teal-dk)',  bg: 'var(--teal-lt)' },
    'no-crew':  { label: 'no crew picked', color: 'var(--amber)',    bg: 'var(--amber-lt)' },
    'no-truck': { label: 'no truck',       color: 'var(--red)',      bg: 'var(--red-lt)' },
    'no-part':  { label: 'no part picked', color: 'var(--amber)',    bg: 'var(--amber-lt)' },
  }
  const m = map[status] || map.ready
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: '2px 6px',
      borderRadius: 8, background: m.bg, color: m.color,
    }}>{m.label}</span>
  )
}

const selectStyle = () => ({
  width: '100%',
  padding: '4px 6px',
  fontSize: 11,
  border: '1px solid var(--border2)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
})

const thStyle = (extra = {}) => ({
  padding: '6px 8px', fontSize: 11, fontWeight: 700,
  color: 'var(--muted)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  ...extra,
})

const tdStyle = (extra = {}) => ({
  padding: '6px 8px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  ...extra,
})
