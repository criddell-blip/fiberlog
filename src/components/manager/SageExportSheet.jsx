import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  getMovementsForSageExport,
  isExportableMovement,
  buildSageCsv,
  markMovementsExported,
} from '../../lib/inventory'
import { downloadTextAsFile } from '../../lib/csvImport'
import { isoLocalDate } from '../../lib/format'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Prototype Sage Intacct export. Pick a date range, preview what would
// export, download the CSV, and stamp every included row's exported_at
// so the next export skips them. Toggle to include already-exported
// rows for re-issuing a corrected batch.
//
// Defaults are Sage Intacct standard transaction-type names + FiberLog
// location/project names used directly as codes. We'll layer code
// mappings (warehouse name → Sage warehouse code, etc) once the actual
// values are known.
export default function SageExportSheet({ onClose, initialSince = null, initialUntil = null }) {
  const { showToast, currentUser } = useApp()

  // Back closes the export sheet (mounted only when open). No data entry to
  // lose — just a date range — so no confirm.
  useBackClose(1, onClose)

  // Default range: the range passed in (e.g. the Consumption report's current
  // filter, so "Export to Sage" exports what you're viewing) else last 7 days.
  const defaultUntil = useMemo(() => initialUntil || isoLocalDate(new Date()), [initialUntil])
  const defaultSince = useMemo(() => {
    if (initialSince) return initialSince
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return isoLocalDate(d)
  }, [initialSince])

  const [since, setSince] = useState(defaultSince)
  const [until, setUntil] = useState(defaultUntil)
  const [includeExported, setIncludeExported] = useState(false)
  // Strict-consumption mode: when on, the filter additionally strips out
  // truck staging (crew loadouts + returns). Result is a "pure
  // consumption + purchases" export. Default off so today's behavior is
  // preserved unless the accountant flips it.
  const [strictConsumption, setStrictConsumption] = useState(false)
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastBatch, setLastBatch] = useState(null)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const ms = await getMovementsForSageExport({
        // Convert local dates to UTC ISO bounds. Inclusive of both endpoints.
        since: since ? new Date(since + 'T00:00:00').toISOString() : null,
        until: until ? new Date(until + 'T23:59:59.999').toISOString() : null,
        includeExported,
      })
      setMovements(ms)
    } catch (e) {
      console.error('Sage export load failed:', e)
      setError(e.message || String(e))
      setMovements([])
    } finally {
      setLoading(false)
    }
  }

  // Load on open + whenever filters change
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [since, until, includeExported])

  // Filter to exportable + count by type. Pass strict-consumption flag
  // so the same filter decision drives both the on-screen preview and
  // the CSV builder (buildSageCsv runs the same filter at write time).
  const filterOpts = useMemo(() => ({ strictConsumption }), [strictConsumption])
  const exportable = useMemo(
    () => movements.filter(m => isExportableMovement(m, filterOpts)),
    [movements, filterOpts]
  )
  const skippedInternal = movements.length - exportable.length
  const typeCounts = useMemo(() => {
    const c = {}
    for (const m of exportable) c[m.movement_type] = (c[m.movement_type] || 0) + 1
    return c
  }, [exportable])

  // Dry-run: build + download the EXACT same CSV as a real export but WITHOUT
  // stamping exported_at. Lets the accountant inspect what a batch would look
  // like — or re-pull an already-exported batch (with "Include already
  // exported" on) — with zero side effects. Committing the batch (mark
  // exported) stays a separate, deliberate click via handleDownload. Filename
  // is prefixed PREVIEW so it can't be mistaken for a delivered batch.
  function handlePreview() {
    if (exportable.length === 0) {
      setError('Nothing to preview in this range')
      return
    }
    setError('')
    const csv = buildSageCsv(movements, filterOpts)  // same filter as the real export
    const filename = `sage_PREVIEW_${since}_to_${until}.csv`
    downloadTextAsFile(filename, csv)
    showToast(`Previewed ${exportable.length} movement${exportable.length === 1 ? '' : 's'} — not marked exported`)
  }

  async function handleDownload() {
    if (exportable.length === 0) {
      setError('Nothing to export in this range')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const csv = buildSageCsv(movements, filterOpts)  // applies the filter internally
      const includedIds = exportable.map(m => m.id)
      // Stamp the batch first — markMovementsExported creates the parent
      // batch row + sets exported_at/export_batch_id on every movement.
      const batch = await markMovementsExported(includedIds, {
        userId: currentUser?.id,
        notes: `Sage export · ${since} → ${until}`,
      })
      const filename = `sage_export_${since}_to_${until}_${batch.id.slice(0, 8)}.csv`
      downloadTextAsFile(filename, csv)
      setLastBatch({ batchId: batch.id, count: includedIds.length, filename })
      showToast(`Exported ${includedIds.length} movement${includedIds.length === 1 ? '' : 's'}`)
      // Reload so the preview reflects the new exported_at stamps
      await load()
    } catch (e) {
      console.error('Sage export failed:', e)
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 1000, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--fw-black)', fontSize: 'var(--fs-lg)', marginBottom: 4 }}>
          <Icon name="receipt" size={20} /> Sage Intacct export <span style={{ fontSize: 12, color: 'var(--orange)', marginLeft: 6 }}>prototype</span>
        </div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)', marginBottom: 14 }}>
          Builds a Sage Inventory Transactions CSV of what FiberLog <em>consumed</em> in the picked range.
          Always filtered: <strong>receipts</strong> (POs are received straight into Sage, so sending them
          again would double-count the purchase — FiberLog keeps them for tracking), count corrections
          (adjusts, since Sage runs its own reconciliation), and internal staging (truck → truck and
          warehouse↔bin within the same warehouse). Toggle <em>Strict consumption</em> to also drop
          crew loadouts + returns. <strong>Preview CSV</strong> downloads the file to inspect with no side
          effects; <strong>Download + mark exported</strong> also stamps the rows so the next batch skips them.
          To re-view an already-exported batch (e.g. Grady's earlier export), turn on <em>Include already exported</em>.
        </div>

        {/* Filter row */}
        <div style={{
          display: 'flex', alignItems: 'flex-end', gap: 12,
          padding: '10px 12px', marginBottom: 12,
          background: 'var(--surface2)', borderRadius: 'var(--r-sm)',
          flexShrink: 0, flexWrap: 'wrap',
        }}>
          <div className="field" style={{ flex: '1 1 140px', marginBottom: 0 }}>
            <label>From</label>
            <input type="date" value={since} onChange={e => setSince(e.target.value)} disabled={submitting} />
          </div>
          <div className="field" style={{ flex: '1 1 140px', marginBottom: 0 }}>
            <label>To</label>
            <input type="date" value={until} onChange={e => setUntil(e.target.value)} disabled={submitting} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeExported}
              onChange={e => setIncludeExported(e.target.checked)}
              disabled={submitting}
            />
            Include already exported
          </label>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}
            title="Drop crew loadouts + returns (truck staging) from the export. Keeps truck→project consumption, issue and scrap."
          >
            <input
              type="checkbox"
              checked={strictConsumption}
              onChange={e => setStrictConsumption(e.target.checked)}
              disabled={submitting}
            />
            Strict consumption only
          </label>
          <button onClick={load} className="btn btn-ghost" style={{ padding: '6px 12px', fontSize: 12 }} disabled={loading || submitting}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div style={{
            background: 'var(--danger-bg)', color: 'var(--danger-fg)',
            padding: '8px 12px', borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-sm)', marginBottom: 10,
          }}>
            {error}
          </div>
        )}

        {lastBatch && (
          <div style={{
            background: 'var(--success-bg)', color: 'var(--success-fg)',
            padding: '10px 14px', borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-sm)', marginBottom: 10,
          }}>
            <strong>Exported {lastBatch.count} movements.</strong>{' '}
            File: <code style={{ fontSize: 11 }}>{lastBatch.filename}</code><br />
            Batch ID: <code style={{ fontSize: 11 }}>{lastBatch.batchId}</code>
          </div>
        )}

        {/* Stats */}
        {!loading && (
          <div style={{
            display: 'flex', gap: 16, fontSize: 12,
            padding: '8px 0', marginBottom: 8,
            color: 'var(--muted)', flexWrap: 'wrap',
          }}>
            <span><strong style={{ color: 'var(--text)' }}>{exportable.length}</strong> ready to export</span>
            {skippedInternal > 0 && (
              <span style={{ color: 'var(--hint)' }}>
                {skippedInternal} skipped (receipts + adjusts + internal staging{strictConsumption ? ' + crew loads/returns' : ''})
              </span>
            )}
            {Object.entries(typeCounts).map(([type, count]) => (
              <span key={type}><strong style={{ color: 'var(--text)' }}>{count}</strong> {type}</span>
            ))}
          </div>
        )}

        {/* Preview table */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          {loading && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
          )}
          {!loading && exportable.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
              No movements in this range. Try widening the date filter or enabling "Include already exported".
            </div>
          )}
          {!loading && exportable.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead style={{ background: 'var(--surface2)', position: 'sticky', top: 0 }}>
                <tr>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Item</th>
                  <th style={thStyle}>Qty</th>
                  <th style={thStyle}>From</th>
                  <th style={thStyle}>To</th>
                  <th style={thStyle}>Project / Phase</th>
                  <th style={thStyle}>Status</th>
                </tr>
              </thead>
              <tbody>
                {exportable.slice(0, 200).map(m => (
                  <tr key={m.id} style={{ background: m.exported_at ? 'var(--gray-lt)' : 'transparent', opacity: m.exported_at ? 0.6 : 1 }}>
                    <td style={tdStyle}>{(m.created_at || '').slice(0, 10)}</td>
                    <td style={tdStyle}>{m.movement_type}</td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{m.part?.name || m.part?.id || '—'}</div>
                      <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>{m.part?.id || ''}</div>
                    </td>
                    <td style={tdStyle}>{m.quantity} {m.unit || m.part?.unit || ''}</td>
                    <td style={tdStyle}>{m.from_location?.name || <span style={{ color: 'var(--hint)' }}>—</span>}</td>
                    <td style={tdStyle}>{m.to_location?.name || <span style={{ color: 'var(--hint)' }}>—</span>}</td>
                    <td style={tdStyle}>
                      <div>{m.phase?.project?.name || m.to_location?.name || ''}</div>
                      {m.phase?.name && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{m.phase.name}</div>}
                    </td>
                    <td style={tdStyle}>
                      {m.exported_at
                        ? <span className="pill pill-muted pill-sm">re-export</span>
                        : <span className="pill pill-success pill-sm">new</span>}
                    </td>
                  </tr>
                ))}
                {exportable.length > 200 && (
                  <tr><td colSpan={8} style={{ padding: 10, textAlign: 'center', color: 'var(--hint)', fontSize: 11 }}>
                    Showing first 200 of {exportable.length}. All will be in the export.
                  </td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Action bar */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={submitting}>
            Close
          </button>
          <button
            className="btn btn-ghost"
            style={{ flex: 1.6, border: '1px solid var(--border2)' }}
            onClick={handlePreview}
            disabled={submitting || exportable.length === 0}
            title="Download the CSV to inspect it — does NOT mark anything exported"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="eye" size={16} /> Preview CSV (no mark)
            </span>
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleDownload}
            disabled={submitting || exportable.length === 0}
          >
            {submitting
              ? 'Exporting…'
              : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="receipt" size={16} /> Download CSV + mark {exportable.length} exported
                </span>
              )}
          </button>
        </div>
      </div>
    </div>
  )
}

const thStyle = {
  padding: '6px 10px', textAlign: 'left',
  fontSize: 10, fontWeight: 700, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.04em',
  borderBottom: '1px solid var(--border)',
}
const tdStyle = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
}
