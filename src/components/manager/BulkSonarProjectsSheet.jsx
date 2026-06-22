import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import { parseCsv, readFileAsText } from '../../lib/csvImport'
import {
  bulkCreateSonarPhases,
  getPhasesWithBuckets,
  getSonarProjectMap,
} from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Bulk-bootstrap (or top-up) the Sonar project → FiberLog phase map.
// Paste a CSV with a "Project" column (the format Sonar emits in the
// weekly project list); the sheet:
//   • Auto-suggests a region by matching against existing phase names
//     (exact) or contains-either-way
//   • Detects already-mapped projects and skips them by default
//   • Lets manager assign a region in one click per row, with bulk
//     "assign region to all unmapped" shortcuts
//   • On submit, creates phases under the picked regions + upserts the
//     Sonar → phase map in one batch
//
// Used during initial setup AND as a manual review tool for the weekly
// projects webhook (future).
export default function BulkSonarProjectsSheet({ onClose, onDone }) {
  const { showToast } = useApp()
  const [projects, setProjects] = useState([])  // regional projects (target for phases)
  const [phases, setPhases] = useState([])
  const [existingMap, setExistingMap] = useState(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [csvText, setCsvText] = useState('')
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState([])  // [{sonarProject, projectId, status, suggestedReason}]
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  // Back closes the sheet (mounted only when open). Confirm once a CSV is
  // loaded. Sits on top of SonarImportSheet's layer, so Back closes this first.
  useBackClose(1, onClose, {
    confirm: () => rows.length === 0 || window.confirm('Discard these project mappings?'),
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [projRes, phasesData, mapData] = await Promise.all([
          db.from('projects')
            .select('id, name')
            .eq('status', 'active')
            .order('name'),
          getPhasesWithBuckets(),
          getSonarProjectMap(),
        ])
        if (cancelled) return
        if (projRes.error) throw projRes.error
        setProjects(projRes.data || [])
        setPhases(phasesData || [])
        setExistingMap(mapData)
      } catch (e) {
        if (!cancelled) setError('Load failed: ' + (e.message || e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Parse CSV text → seed rows with suggested project assignments
  function parseAndSeed(text) {
    setError('')
    setCsvText(text)
    try {
      const { headers, rows: parsed } = parseCsv(text)
      const projectKey = headers.find(h => h.toLowerCase().trim() === 'project')
      if (!projectKey) {
        setError('CSV needs a "Project" column header')
        setRows([])
        return
      }
      const uniqueProjects = [...new Set(
        parsed.map(r => (r[projectKey] || '').trim()).filter(Boolean)
      )]
      const seeded = uniqueProjects.map(sonarProject => {
        const up = sonarProject.toUpperCase()
        // Already mapped? Mark and skip by default
        const existingPhaseId = existingMap.get(up)
        if (existingPhaseId) {
          const ph = phases.find(p => p.id === existingPhaseId)
          return {
            sonarProject,
            projectId: ph?.project_id || '',
            phaseName: sonarProject,
            status: 'already-mapped',
            suggestedReason: ph ? `→ ${ph.project_name} / ${ph.name}` : 'mapped',
          }
        }
        // Try exact phase-name match
        let match = phases.find(p => (p.name || '').toUpperCase() === up)
        if (match) return {
          sonarProject, projectId: match.project_id, phaseName: sonarProject,
          status: 'auto', suggestedReason: `phase exists in ${match.project_name}`,
        }
        // Contains either-way (West Mountain Fiber ↔ West Mountain)
        match = projects.find(p => {
          const pn = (p.name || '').toUpperCase()
          return pn && (pn.includes(up) || up.includes(pn))
        })
        if (match) return {
          sonarProject, projectId: match.id, phaseName: sonarProject,
          status: 'auto', suggestedReason: `name matches ${match.name}`,
        }
        return {
          sonarProject, projectId: '', phaseName: sonarProject,
          status: 'pending', suggestedReason: '',
        }
      })
      setRows(seeded)
    } catch (e) {
      setError('Parse failed: ' + (e.message || e))
      setRows([])
    }
  }

  async function handleFile(file) {
    if (!file) return
    setFileName(file.name)
    try {
      const text = await readFileAsText(file)
      parseAndSeed(text)
    } catch (e) {
      setError('Read failed: ' + (e.message || e))
    }
  }

  function setRowProject(idx, projectId) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      return {
        ...r,
        projectId,
        status: projectId ? (r.status === 'already-mapped' ? 'already-mapped' : 'ready') : 'pending',
      }
    }))
  }

  function setRowPhaseName(idx, name) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, phaseName: name } : r))
  }

  function assignAllUnmappedTo(projectId) {
    setRows(prev => prev.map(r => {
      if (r.status === 'already-mapped' || r.projectId) return r
      return { ...r, projectId, status: 'ready' }
    }))
  }

  const stats = useMemo(() => {
    let ready = 0, alreadyMapped = 0, pending = 0
    for (const r of rows) {
      if (r.status === 'already-mapped') alreadyMapped++
      else if (r.projectId) ready++
      else pending++
    }
    return { ready, alreadyMapped, pending, total: rows.length }
  }, [rows])

  async function handleSubmit() {
    setSubmitting(true)
    setError('')
    try {
      // Only submit rows that are 'ready' OR 'auto' (i.e. have a projectId
      // assigned and aren't already mapped). 'already-mapped' rows are
      // skipped — manager already approved them via the map.
      const toSubmit = rows
        .filter(r => r.projectId && r.status !== 'already-mapped')
        .map(r => ({
          sonarProject: r.sonarProject,
          projectId: r.projectId,
          phaseName: r.phaseName?.trim() || r.sonarProject,
        }))
      if (toSubmit.length === 0) {
        setError('Nothing to submit — pick regions for the pending rows first')
        setSubmitting(false)
        return
      }
      const res = await bulkCreateSonarPhases(toSubmit)
      setResult(res)
      showToast(`Created ${res.created} phases, skipped ${res.skipped}`)
      if (onDone) onDone(res)
    } catch (e) {
      console.error('Bulk submit failed:', e)
      setError('Submit failed: ' + (e.message || e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 920, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
          <Icon name="box" size={20} /> Bulk-add Sonar projects as phases
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
          Paste or upload Sonar's project list (CSV with a <code>Project</code> column).
          Each project becomes a phase under the region you pick. Mappings save to
          <code> sonar_project_phase_map</code> so daily install imports route correctly.
        </div>

        {loading && <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>Loading regions and phases…</div>}

        {!loading && (
          <>
            {/* CSV input — paste OR upload */}
            {rows.length === 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <label style={{
                    display: 'inline-block', padding: '6px 12px',
                    background: 'var(--orange)', color: 'white',
                    borderRadius: 'var(--r-sm)', cursor: 'pointer',
                    fontSize: 13, fontWeight: 700,
                  }}>
                    Choose CSV file
                    <input
                      type="file" accept=".csv,text/csv"
                      onChange={e => handleFile(e.target.files?.[0])}
                      style={{ display: 'none' }}
                    />
                  </label>
                  {fileName && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fileName}</span>}
                  <span style={{ fontSize: 12, color: 'var(--hint)' }}>— or paste below:</span>
                </div>
                <textarea
                  value={csvText}
                  onChange={e => setCsvText(e.target.value)}
                  onBlur={() => csvText.trim() && parseAndSeed(csvText)}
                  placeholder="Paste CSV here (must include a Project column)..."
                  style={{
                    width: '100%', minHeight: 100, padding: 10,
                    fontFamily: 'monospace', fontSize: 12,
                    border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
                    background: 'var(--surface2)', color: 'var(--text)',
                  }}
                />
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--hint)', marginTop: 4 }}>
                  Tip: tab away from the textarea (blur) to parse.
                </div>
              </div>
            )}

            {error && (
              <div style={{
                background: 'var(--danger-bg)', color: 'var(--danger-fg)',
                borderRadius: 'var(--r-sm)', padding: '8px 12px',
                fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)',
                marginBottom: 10,
              }}>
                {error}
              </div>
            )}

            {/* Result of submit */}
            {result && (
              <div style={{
                background: 'var(--success-bg)', color: 'var(--success-fg)',
                borderRadius: 'var(--r-sm)', padding: '10px 14px',
                fontSize: 'var(--fs-sm)', marginBottom: 10,
              }}>
                <strong>Done.</strong> Created {result.created} phase{result.created === 1 ? '' : 's'}, skipped {result.skipped}.
                {result.errors?.length > 0 && (
                  <div style={{ marginTop: 6, color: 'var(--danger-fg)' }}>
                    {result.errors.length} error{result.errors.length === 1 ? '' : 's'}:
                    <ul style={{ margin: '4px 0 0 16px' }}>
                      {result.errors.slice(0, 5).map((e, i) => (
                        <li key={i}>{e.sonarProject}: {e.message}</li>
                      ))}
                      {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Rows table */}
            {rows.length > 0 && (
              <>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '6px 0', marginBottom: 6, flexShrink: 0,
                  fontSize: 12,
                }}>
                  <div style={{ flex: 1 }}>
                    <strong>{stats.total}</strong> total ·{' '}
                    <span style={{ color: 'var(--success-fg)' }}>{stats.ready} ready</span> ·{' '}
                    <span style={{ color: 'var(--muted)' }}>{stats.alreadyMapped} already mapped</span> ·{' '}
                    <span style={{ color: 'var(--amber)' }}>{stats.pending} pending</span>
                  </div>
                  {/* Bulk-assign shortcuts */}
                  {stats.pending > 0 && (
                    <select
                      onChange={e => { if (e.target.value) { assignAllUnmappedTo(e.target.value); e.target.value = '' } }}
                      style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                    >
                      <option value="">— assign all pending to… —</option>
                      {projects.map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  )}
                </div>

                <div style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: 'var(--surface2)', position: 'sticky', top: 0 }}>
                      <tr>
                        <th style={thStyle}>Sonar project</th>
                        <th style={thStyle}>Region</th>
                        <th style={thStyle}>Phase name</th>
                        <th style={thStyle}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, idx) => {
                        const isAlreadyMapped = r.status === 'already-mapped'
                        const bgStatus = isAlreadyMapped ? 'var(--gray-lt)'
                          : r.status === 'auto' ? 'var(--success-bg)'
                          : !r.projectId ? 'var(--amber-lt)' : 'transparent'
                        return (
                          <tr key={r.sonarProject} style={{ background: bgStatus, opacity: isAlreadyMapped ? 0.55 : 1 }}>
                            <td style={tdStyle}>
                              <div style={{ fontWeight: 'var(--fw-semibold)' }}>{r.sonarProject}</div>
                              {r.suggestedReason && (
                                <div style={{ fontSize: 10, color: 'var(--hint)' }}>{r.suggestedReason}</div>
                              )}
                            </td>
                            <td style={tdStyle}>
                              <select
                                value={r.projectId}
                                onChange={e => setRowProject(idx, e.target.value)}
                                disabled={isAlreadyMapped || submitting}
                                style={{ width: '100%', padding: '4px 6px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                              >
                                <option value="">— pick —</option>
                                {projects.map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </td>
                            <td style={tdStyle}>
                              <input
                                type="text"
                                value={r.phaseName}
                                onChange={e => setRowPhaseName(idx, e.target.value)}
                                disabled={isAlreadyMapped || submitting}
                                style={{ width: '100%', padding: '4px 6px', fontSize: 12, border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', background: 'var(--surface2)' }}
                              />
                            </td>
                            <td style={tdStyle}>
                              {isAlreadyMapped && <span className="pill pill-muted pill-sm">already mapped</span>}
                              {!isAlreadyMapped && r.projectId && r.status === 'auto' && <span className="pill pill-success pill-sm">auto-picked</span>}
                              {!isAlreadyMapped && r.projectId && r.status === 'ready' && <span className="pill pill-success pill-sm">ready</span>}
                              {!isAlreadyMapped && !r.projectId && <span className="pill pill-warning pill-sm">pick a region</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && rows.length > 0 && (
            <button
              className="btn btn-primary"
              style={{ flex: 2 }}
              onClick={handleSubmit}
              disabled={submitting || stats.ready === 0}
            >
              {submitting
                ? 'Creating…'
                : stats.ready > 0
                  ? `Create ${stats.ready} phase${stats.ready === 1 ? '' : 's'} + map`
                  : 'Pick regions for pending rows'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const thStyle = {
  padding: '6px 10px', textAlign: 'left',
  fontSize: 11, fontWeight: 700, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.04em',
  borderBottom: '1px solid var(--border)',
}
const tdStyle = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
}
