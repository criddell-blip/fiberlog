import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  getLocations, getPhasesWithBuckets, getReclassChildren, getReclassChainRoot, recordMovementsBatch,
  buildReclassPayload, sageProjectId,
} from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'

// ─── Reclassify a consumption movement between two Regions ─────────────────
//
// "Adjust it later": a unit that landed in the grant ledger but was a fix-job
// swap (or the reverse) moves to the other project's Region. Movements are
// immutable, so this books a Region→Region transfer that points back at the
// original (reclass_of) — see buildReclassPayload for what it carries. Owner
// only: pulling stock OUT of a Region is the one direction managers can't do
// anywhere else in the app either (RecordMovementSheet gates the same way).
export default function ReclassMovementSheet({ movement, onClose, onDone }) {
  const { currentUser, showToast } = useApp()
  const [regions, setRegions] = useState([])
  const [phases, setPhases] = useState([])
  const [alreadyReclassed, setAlreadyReclassed] = useState(0)
  // For a reclass-of-a-reclass: the originally consumed row, whose phase
  // tag is the right one to restore when moving BACK to its project.
  const [chainRoot, setChainRoot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [toBucketId, setToBucketId] = useState('')
  const [qty, setQty] = useState(String(movement?.quantity ?? 1))
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const fromId = movement?.to_location_id || movement?.to_location?.id || null
  const dirty = !!toBucketId || reason.trim() !== ''
  useBackClose(1, onClose, { confirm: () => !dirty || window.confirm('Discard this reclass?') })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [locs, phs, done, root] = await Promise.all([
          getLocations(), getPhasesWithBuckets(), getReclassChildren([movement.id]),
          movement.reclass_of ? getReclassChainRoot(movement).catch(() => null) : Promise.resolve(null),
        ])
        if (cancelled) return
        setRegions(locs.filter(l => l.type === 'job_site' && l.id !== fromId))
        setPhases(phs)
        setChainRoot(root)
        const used = done.get(movement.id) || 0
        setAlreadyReclassed(used)
        setQty(String(Math.max(0, (Number(movement.quantity) || 0) - used)))
      } catch (e) {
        if (!cancelled) setError(e.message || String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [movement?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = Math.max(0, (Number(movement?.quantity) || 0) - alreadyReclassed)
  const target = regions.find(r => r.id === toBucketId) || null
  // Phase tag for the new ledger so Sage's PROJECTID / CLASSID follow it.
  // Moving BACK to the project the chain started in restores the original
  // phase; otherwise the destination's routing phase (lowest sequence). NULL
  // when it has none — sageProjectId then falls back to the bucket name.
  const targetPhase = useMemo(() => {
    if (!target?.project_id) return null
    if (chainRoot?.phase && chainRoot.phase.project_id === target.project_id) {
      return phases.find(ph => ph.id === chainRoot.phase.id) || chainRoot.phase
    }
    return phases.filter(ph => ph.project_id === target.project_id)
      .sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0))[0] || null
  }, [target, phases, chainRoot])

  // Same derivation the export uses, so the preview can't lie.
  const previewProject = target
    ? sageProjectId({ phase: targetPhase ? { ...targetPhase, project: { name: target.name } } : null, to_location: { type: 'job_site', name: target.name } })
    : ''

  async function handleSubmit() {
    setError('')
    let payload
    try {
      payload = buildReclassPayload(movement, {
        toBucketId, toBucketType: target?.type, phaseId: targetPhase?.id || null,
        quantity: qty, reason, userId: currentUser?.id, alreadyReclassed,
      })
    } catch (e) {
      setError(e.message); return
    }
    setSubmitting(true)
    try {
      await recordMovementsBatch([payload])
      showToast(`Reclassed ${payload.quantity} × ${movement.part?.name || movement.part_id} → ${target.name}`)
      onDone?.()
      onClose()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const fromName = movement?.to_location?.name || 'this Region'
  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && (!dirty || window.confirm('Discard this reclass?')) && onClose()}>
      <div className="overlay-sheet">
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Reclassify consumption</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
          Move <b>{movement?.part?.name || movement?.part_id}</b> out of <b>{fromName}</b> into another project's ledger.
          The original stays as recorded; this books a linked counter-movement dated {String(movement?.occurred_at || movement?.created_at || '').slice(0, 10)}.
        </div>

        {loading ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>Loading…</div>
        ) : (
          <>
            {alreadyReclassed > 0 && (
              <div className="banner banner-warning" style={{ marginBottom: 10, fontSize: 12 }}>
                {alreadyReclassed} of {Number(movement.quantity)} already reclassed · {remaining} left
              </div>
            )}
            <div className="field">
              <label>To Region</label>
              <select value={toBucketId} onChange={e => setToBucketId(e.target.value)}>
                <option value="">— pick a Region —</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Quantity (max {remaining})</label>
              <input type="number" min="1" max={remaining} step="1" value={qty} onChange={e => setQty(e.target.value)} />
            </div>
            <div className="field">
              <label>Reason</label>
              <input type="text" placeholder="e.g. Fix job — ONT swap on Drop Fix 8/21" value={reason} onChange={e => setReason(e.target.value)} autoComplete="off" name="reclass-reason" />
            </div>
            {target && (
              <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', marginBottom: 10 }}>
                <div>Reports: <b>−{qty || 0}</b> {fromName} · <b>+{qty || 0}</b> {target.name}</div>
                <div>Sage: one transfer line, {fromName} → {target.name}, PROJECTID <b>{previewProject}</b>{targetPhase ? <>, CLASSID <b>{targetPhase.name}</b></> : null}</div>
              </div>
            )}
            {error && <div className="banner banner-error" style={{ marginBottom: 10, fontSize: 12 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => (!dirty || window.confirm('Discard this reclass?')) && onClose()}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit}
                disabled={submitting || !toBucketId || !reason.trim() || remaining <= 0}>
                {submitting ? 'Booking…' : 'Reclassify'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
