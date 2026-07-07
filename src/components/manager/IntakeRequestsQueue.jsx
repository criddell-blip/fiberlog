import { useState, useEffect, useCallback } from 'react'
import { getIntakeRequests, approveIntakeRequest, rejectIntakeRequest } from '../../lib/inventory'
import { useApp } from '../../AppContext'
import useRealtimeQueue from '../../lib/useRealtimeQueue'
import ReviewQueue, { ReviewActions, InitialsAvatar, StatusPill, fmtShortDateTime } from './ReviewQueue'
import Icon from '../shared/Icon'

// Manager review queue for crew "found inventory" requests (backlog #19).
// Built on the shared ReviewQueue chassis (backlog #22): realtime list +
// detail overlay with approve/reject. Approve books a `receive` movement into
// the warehouse (creating a draft part when needed) via the
// approve_intake_request RPC; reject carries a reason.

const STATUS_COLORS = {
  pending:  { bg: 'var(--amber-lt)', text: 'var(--amber)',   label: 'Pending' },
  approved: { bg: 'var(--teal-lt)',  text: 'var(--teal-dk)', label: 'Approved' },
  rejected: { bg: 'var(--red-lt)',   text: 'var(--red)',     label: 'Rejected' },
}

const STATUS_OPTIONS = [
  { id: 'pending',  label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all',      label: 'All statuses' },
]

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

  // Realtime — new requests + status changes, with auto-reconnect (shared hook).
  useRealtimeQueue('inventory_intake_requests', {
    channelPrefix: 'manager_intake_',
    onEvent: type => {
      loadRequests()
      if (type === 'INSERT') showToast('New found-inventory request')
    },
  })

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
    <ReviewQueue
      title="Found inventory"
      pendingCount={pendingCount}
      onRefresh={loadRequests}
      filter={filter}
      onFilterChange={setFilter}
      statusOptions={STATUS_OPTIONS}
      loading={loading}
      isEmpty={requests.length === 0}
      emptyIcon="box"
      emptyMessage={`No ${filter === 'all' ? '' : filter + ' '}requests`}
      selected={selected}
      onCloseDetail={() => setSelected(null)}
      renderDetail={renderDetail}
    >
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
                  <InitialsAvatar initials={r.requested_by_user?.initials} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {partLabel(r)}
                      {r.is_draft && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 4, background: 'var(--purple-lt)', color: 'var(--purple)' }}>NEW</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {r.requested_by_user?.name} · {fmtShortDateTime(r.created_at)}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="mono" style={{ fontWeight: 700, color: 'var(--text)' }}>{Number(r.quantity).toLocaleString()} {unitOf(r)}</span>
                  → {r.target_location?.name || '—'}
                </div>
              </div>
              <StatusPill colors={colors} />
            </div>
          </div>
        )
      })}
    </ReviewQueue>
  )

  function renderDetail(sel) {
    const colors = STATUS_COLORS[sel.status] || {}
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{partLabel(sel)}</div>
          {sel.is_draft && <span style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: 'var(--purple-lt)', color: 'var(--purple)' }}>NEW PART</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Reported by {sel.requested_by_user?.name} · {new Date(sel.created_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </div>

        <div style={{ background: 'var(--bg)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Quantity</div>
            <div className="mono" style={{ fontWeight: 700, fontSize: 16 }}>{Number(sel.quantity).toLocaleString()} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--muted)' }}>{unitOf(sel)}</span></div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>Book into</div>
            <div style={{ fontWeight: 700 }}>🏭 {sel.target_location?.name || '—'}</div>
          </div>
          {sel.part_id && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>SKU</div>
              <div className="mono" style={{ fontSize: 12 }}>{sel.part_id}</div>
            </div>
          )}
          {sel.is_draft && (
            <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--purple)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <Icon name="alert" size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              Will be created as a <strong>draft part</strong> on approval — review it under Parts → Drafts afterward.
            </div>
          )}
        </div>

        {sel.reason && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Crew note</div>
            <div style={{ fontSize: 13, background: 'var(--surface2)', borderRadius: 'var(--r-sm)', padding: '8px 12px' }}>{sel.reason}</div>
          </div>
        )}

        <ReviewActions
          isPending={sel.status === 'pending'}
          note={note}
          onNoteChange={setNote}
          noteLabel="Note (optional — saved on the request)"
          notePlaceholder="Add a note…"
          noteMinHeight={52}
          acting={acting}
          danger={{ label: 'Reject', icon: 'x', onClick: () => handleReject(sel) }}
          primary={{ label: 'Approve & book in', icon: 'check', busyLabel: 'Saving…', onClick: () => handleApprove(sel) }}
          banner={{ ...colors, suffix: sel.reviewed_by_user?.name ? ` · by ${sel.reviewed_by_user.name}` : '' }}
        />
        {sel.status !== 'pending' && sel.review_note && (
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10, textAlign: 'center' }}>"{sel.review_note}"</div>
        )}
      </>
    )
  }
}
