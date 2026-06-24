import { useState, useEffect, useCallback } from 'react'
import { db, nextChannelSuffix } from '../../lib/supabase'
import { getIntakeRequests, approveIntakeRequest, rejectIntakeRequest } from '../../lib/inventory'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Manager review queue for crew "found inventory" requests (backlog #19).
// Mirrors SubmissionsQueue: realtime list + detail overlay with approve/reject.
// Approve books a `receive` movement into the warehouse (creating a draft part
// when needed) via the approve_intake_request RPC; reject carries a reason.

const STATUS_COLORS = {
  pending:  { bg: 'var(--amber-lt)', text: 'var(--amber)',   label: 'Pending' },
  approved: { bg: 'var(--teal-lt)',  text: 'var(--teal-dk)', label: 'Approved' },
  rejected: { bg: 'var(--red-lt)',   text: 'var(--red)',     label: 'Rejected' },
}

const STATUSES_FOR = f => (f === 'all' ? ['pending', 'approved', 'rejected'] : [f])

function partLabel(r) {
  return r.part?.name || r.draft_name || r.part_id || 'Unknown part'
}
function unitOf(r) {
  return r.part?.unit || r.draft_unit || 'ea'
}

export default function IntakeRequestsQueue() {
  const { showToast, reload } = useApp()
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [note, setNote] = useState('')
  const [acting, setActing] = useState(false)
  const [filter, setFilter] = useState('pending')

  useBackClose(selected ? 1 : 0, () => setSelected(null))

  const loadRequests = useCallback(async () => {
    setLoading(true)
    try {
      setRequests(await getIntakeRequests({ statuses: STATUSES_FOR(filter) }))
    } catch (e) {
      console.error('Load intake requests failed:', e)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { loadRequests() }, [loadRequests])

  // Realtime — new requests + status changes, with auto-reconnect.
  useEffect(() => {
    let channel = null, reconnectTimer = null, cancelled = false
    const setup = () => {
      if (cancelled) return
      if (channel) { try { channel.unsubscribe() } catch {} }
      channel = db.channel('manager_intake_' + nextChannelSuffix())
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inventory_intake_requests' },
          () => { loadRequests(); showToast('New found-inventory request') })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'inventory_intake_requests' },
          () => loadRequests())
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            if (reconnectTimer) clearTimeout(reconnectTimer)
            reconnectTimer = setTimeout(setup, 2000)
          }
        })
    }
    setup()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (channel) { try { channel.unsubscribe() } catch {} }
    }
  }, [loadRequests, showToast])

  async function handleApprove(r) {
    setActing(true)
    try {
      await approveIntakeRequest(r.id, note)
      setSelected(null); setNote('')
      showToast(`Booked ${partLabel(r)} into ${r.target_location?.name || 'warehouse'}`)
      await loadRequests()
      reload()   // refresh global state (stock changed)
    } catch (e) {
      showToast('Approve failed: ' + e.message)
    } finally { setActing(false) }
  }

  async function handleReject(r) {
    setActing(true)
    try {
      await rejectIntakeRequest(r.id, note)
      setSelected(null); setNote('')
      showToast('Request rejected')
      await loadRequests()
    } catch (e) {
      showToast('Reject failed: ' + e.message)
    } finally { setActing(false) }
  }

  const pendingCount = requests.filter(r => r.status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            Found inventory
            {pendingCount > 0 && <span style={{ marginLeft: 8, background: 'var(--amber)', color: 'white', fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{pendingCount}</span>}
          </div>
          <button onClick={loadRequests} style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>Refresh</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{
              height: 30, padding: '0 10px', fontSize: 12, fontWeight: 600,
              border: '1px solid var(--border2)', borderRadius: 999,
              background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
            }}
          >
            {[
              { id: 'pending',  label: 'Pending' },
              { id: 'approved', label: 'Approved' },
              { id: 'rejected', label: 'Rejected' },
              { id: 'all',      label: 'All statuses' },
            ].map(opt => <option key={opt.id} value={opt.id}>Status: {opt.label}</option>)}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>}
        {!loading && requests.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--gray-mid)' }}><Icon name="box" size={32} /></div>
            <div>No {filter === 'all' ? '' : filter + ' '}requests</div>
          </div>
        )}

        {requests.map(r => {
          const colors = STATUS_COLORS[r.status] || STATUS_COLORS.pending
          return (
            <div key={r.id} onClick={() => { setSelected(r); setNote('') }}
              style={{
                background: 'var(--surface)',
                borderLeft: `4px solid ${colors.text}`,
                border: '1px solid var(--border)', borderLeftWidth: 4,
                borderRadius: 'var(--r-sm)', padding: '12px 14px', cursor: 'pointer', marginBottom: 8,
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--teal-lt)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 11, color: 'var(--teal-dk)', flexShrink: 0 }}>{r.requested_by_user?.initials || '?'}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {partLabel(r)}
                        {r.is_draft && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, background: 'var(--purple-lt)', color: 'var(--purple)' }}>NEW</span>}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {r.requested_by_user?.name} · {new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span className="mono" style={{ fontWeight: 700, color: 'var(--text)' }}>{Number(r.quantity).toLocaleString()} {unitOf(r)}</span>
                    → {r.target_location?.name || '—'}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: colors.bg, color: colors.text, flexShrink: 0 }}>{colors.label}</span>
              </div>
            </div>
          )
        })}
      </div>

      {selected && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setSelected(null)}>
          <div className="overlay-sheet">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
              <div style={{ fontWeight: 800, fontSize: 17 }}>{partLabel(selected)}</div>
              {selected.is_draft && <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: 'var(--purple-lt)', color: 'var(--purple)' }}>NEW PART</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              Reported by {selected.requested_by_user?.name} · {new Date(selected.created_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>

            <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Quantity</div>
                <div className="mono" style={{ fontWeight: 700, fontSize: 16 }}>{Number(selected.quantity).toLocaleString()} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{unitOf(selected)}</span></div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Book into</div>
                <div style={{ fontWeight: 700 }}>🏭 {selected.target_location?.name || '—'}</div>
              </div>
              {selected.part_id && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>SKU</div>
                  <div className="mono" style={{ fontSize: 12 }}>{selected.part_id}</div>
                </div>
              )}
              {selected.is_draft && (
                <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--purple)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <Icon name="alert" size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  Will be created as a <strong>draft part</strong> on approval — review it under Parts → Drafts afterward.
                </div>
              )}
            </div>

            {selected.reason && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Crew note</div>
                <div style={{ fontSize: 13, background: 'var(--surface2)', borderRadius: 'var(--r-sm)', padding: '8px 12px' }}>{selected.reason}</div>
              </div>
            )}

            {selected.status === 'pending' ? (
              <>
                <div className="field">
                  <label>Note (optional — saved on the request)</label>
                  <textarea placeholder="Add a note…" value={note} onChange={e => setNote(e.target.value)} style={{ minHeight: 52 }} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-danger" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => handleReject(selected)} disabled={acting}>
                    <Icon name="x" size={14} /> Reject
                  </button>
                  <button className="btn btn-primary" style={{ flex: 2, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => handleApprove(selected)} disabled={acting}>
                    {acting ? 'Saving…' : <><Icon name="check" size={14} /> Approve & book in</>}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ textAlign: 'center', padding: 12, borderRadius: 'var(--r-sm)', fontWeight: 700, background: STATUS_COLORS[selected.status]?.bg, color: STATUS_COLORS[selected.status]?.text }}>
                  {STATUS_COLORS[selected.status]?.label}
                  {selected.reviewed_by_user?.name ? ` · by ${selected.reviewed_by_user.name}` : ''}
                </div>
                {selected.review_note && (
                  <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10, textAlign: 'center' }}>"{selected.review_note}"</div>
                )}
              </>
            )}
            <button style={{ width: '100%', marginTop: 10, padding: 12, background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }} onClick={() => setSelected(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
