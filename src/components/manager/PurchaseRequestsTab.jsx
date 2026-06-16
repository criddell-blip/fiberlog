import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { getPurchaseRequests } from '../../lib/inventory'
import PurchaseRequestSheet from './PurchaseRequestSheet'

// Purchase Requests queue.
//
// Default view shows the "active" set: pending + ordered. Received and
// cancelled hide behind filter pills. Replaces the "incoming product"
// spreadsheet — managers see all open PRs and their ETAs at a glance.
const STATUS_OPTIONS = [
  { id: 'all',       label: 'All',        statuses: ['pending','ordered','received','cancelled'] },
  { id: 'active',    label: 'Active',     statuses: ['pending','ordered'] },
  { id: 'pending',   label: 'Pending',    statuses: ['pending'] },
  { id: 'ordered',   label: 'Ordered',    statuses: ['ordered'] },
  { id: 'received',  label: 'Received',   statuses: ['received'] },
  { id: 'cancelled', label: 'Cancelled',  statuses: ['cancelled'] },
]

export default function PurchaseRequestsTab({ locations, refreshKey }) {
  const { currentUser } = useApp()
  const [filter, setFilter] = useState('active')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Composition / detail sheet state
  const [showSheet, setShowSheet] = useState(null)  // { mode: 'new'|'detail', prId? }
  const [refreshTick, setRefreshTick] = useState(0)

  const activeStatuses = useMemo(() => {
    const opt = STATUS_OPTIONS.find(s => s.id === filter)
    return opt?.statuses || STATUS_OPTIONS[0].statuses
  }, [filter])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getPurchaseRequests({ statuses: activeStatuses, limit: 200 })
      .then(d => { if (!cancelled) setRows(d || []) })
      .catch(e => { if (!cancelled) setError(e.message || 'Failed to load PRs') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [activeStatuses, refreshKey, refreshTick])

  function onSheetSaved() {
    setShowSheet(null)
    setRefreshTick(t => t + 1)
  }

  const canCreate = currentUser?.role === 'owner' || currentUser?.role === 'manager'

  return (
    <div>
      {/* Top action row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 12, flexWrap: 'wrap',
      }}>
        {STATUS_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => setFilter(opt.id)}
            style={{
              padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              background: filter === opt.id ? 'var(--orange)' : 'var(--gray-lt)',
              color: filter === opt.id ? 'white' : 'var(--muted)',
              border: 'none', cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {canCreate && (
          <button
            onClick={() => setShowSheet({ mode: 'new' })}
            className="btn btn-primary"
            style={{ padding: '6px 14px', fontSize: 13 }}
          >
            ＋ New PR
          </button>
        )}
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', marginBottom: 10,
          background: 'var(--red-lt)', color: 'var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
      )}

      {!loading && rows.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--hint)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
          <div>No purchase requests in this view.</div>
          {canCreate && (
            <div style={{ marginTop: 12, fontSize: 12 }}>
              Click <strong>＋ New PR</strong> or use bulk-select on the Stock / Parts tabs to create one.
            </div>
          )}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
          {/* Column header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '130px 90px 1.2fr 70px 100px 130px 100px 50px',
            gap: 8, padding: '8px 12px',
            background: 'var(--surface2)', fontSize: 10, fontWeight: 700,
            color: 'var(--muted)', textTransform: 'uppercase',
            borderBottom: '1px solid var(--border)',
          }}>
            <div>PR #</div>
            <div>Status</div>
            <div>Vendors</div>
            <div style={{ textAlign: 'right' }}>Lines</div>
            <div style={{ textAlign: 'right' }}>Est total</div>
            <div>Created</div>
            <div>ETA</div>
            <div></div>
          </div>

          {rows.map((pr, i) => {
            const vendorStr = pr.vendors.length === 0
              ? '—'
              : pr.vendors.length <= 2
                ? pr.vendors.join(' · ')
                : `${pr.vendors[0]} · ${pr.vendors[1]} · +${pr.vendors.length - 2} more`
            return (
              <div
                key={pr.id}
                onClick={() => setShowSheet({ mode: 'detail', prId: pr.id })}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '130px 90px 1.2fr 70px 100px 130px 100px 50px',
                  gap: 8, padding: '10px 12px', alignItems: 'center',
                  fontSize: 13, cursor: 'pointer',
                  background: 'var(--surface)',
                  borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)' }}
              >
                <div style={{ fontWeight: 700, color: 'var(--orange)' }}>{pr.pr_number}</div>
                <div>
                  <span style={statusPill(pr.status)}>{pr.status}</span>
                </div>
                <div style={{ color: pr.vendors.length === 0 ? 'var(--hint)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {vendorStr}
                </div>
                <div style={{ textAlign: 'right', fontWeight: 600 }}>{pr.lineCount}</div>
                <div style={{ textAlign: 'right', fontWeight: 600 }}>
                  {pr.estTotal > 0 ? `$${pr.estTotal.toFixed(2)}` : '—'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {pr.created_by_user?.name || '—'}
                  <div style={{ fontSize: 10, color: 'var(--hint)' }}>
                    {pr.date_requested}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: pr.expected_at ? 'var(--text)' : 'var(--hint)' }}>
                  {pr.expected_at || '—'}
                </div>
                <div style={{ textAlign: 'right', color: 'var(--muted)' }}>›</div>
              </div>
            )
          })}
        </div>
      )}

      {showSheet && (
        <PurchaseRequestSheet
          mode={showSheet.mode}
          prId={showSheet.prId}
          locations={locations || []}
          onClose={() => setShowSheet(null)}
          onSaved={onSheetSaved}
        />
      )}
    </div>
  )
}

function statusPill(status) {
  const colors = {
    pending: { fg: 'var(--amber)', bg: 'var(--amber-lt)', border: 'var(--amber)' },
    ordered: { fg: 'var(--teal-dk)', bg: 'var(--teal-lt)', border: 'var(--teal)' },
    received: { fg: 'var(--muted)', bg: 'var(--gray-lt)', border: 'var(--border)' },
    cancelled: { fg: 'var(--red)', bg: 'var(--red-lt)', border: 'var(--red)' },
  }
  const c = colors[status] || colors.pending
  return {
    padding: '2px 8px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    color: c.fg, background: c.bg, border: `1px solid ${c.border}`,
    whiteSpace: 'nowrap',
  }
}
