import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { useIsWide } from '../../lib/useIsWide'
import { getPurchaseRequests } from '../../lib/inventory'
import PurchaseRequestSheet from './PurchaseRequestSheet'
import { chipStyle, CARD_SHADOW, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

// Shorten a PR's vendor list for a one-line summary.
function vendorSummary(pr) {
  if (pr.vendors.length === 0) return '—'
  if (pr.vendors.length <= 2) return pr.vendors.join(' · ')
  return `${pr.vendors[0]} · ${pr.vendors[1]} · +${pr.vendors.length - 2} more`
}

// Purchase Requests queue.
//
// Default view shows the "active" set: pending + ordered. Received and
// cancelled hide behind filter pills. Replaces the "incoming product"
// spreadsheet — managers see all open PRs and their ETAs at a glance.
const STATUS_OPTIONS = [
  { id: 'all',       label: 'All',        statuses: ['pending','ordered','partial','received','cancelled'] },
  { id: 'active',    label: 'Active',     statuses: ['pending','ordered','partial'] },
  { id: 'pending',   label: 'Pending',    statuses: ['pending'] },
  { id: 'ordered',   label: 'Ordered',    statuses: ['ordered'] },
  { id: 'partial',   label: 'Partial',    statuses: ['partial'] },
  { id: 'received',  label: 'Received',   statuses: ['received'] },
  { id: 'cancelled', label: 'Cancelled',  statuses: ['cancelled'] },
]

const GRID = '130px 96px 1.2fr 64px 100px 130px 96px 28px'

export default function PurchaseRequestsTab({ locations, refreshKey }) {
  const { currentUser } = useApp()
  const isWide = useIsWide()
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
      {/* Filter chips + New PR */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {STATUS_OPTIONS.map(opt => (
          <button key={opt.id} onClick={() => setFilter(opt.id)} style={chipStyle(filter === opt.id)}>
            {opt.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {canCreate && (
          <button
            onClick={() => setShowSheet({ mode: 'new' })}
            className="btn btn-primary"
            style={{ height: 32, padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}
          >
            <Icon name="plus" size={15} /> New PR
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '8px 12px', marginBottom: 10, background: 'var(--red-lt)', color: 'var(--red)', borderRadius: 'var(--r-sm)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading && <LoadingBlock />}

      {!loading && rows.length === 0 && (
        <EmptyState icon="clipboard" padding={48}>
          <div>No purchase requests in this view.</div>
          {canCreate && (
            <div style={{ marginTop: 12, fontSize: 12 }}>
              Click <strong>New PR</strong> or use bulk-select on the Stock / Parts tabs to create one.
            </div>
          )}
        </EmptyState>
      )}

      {/* Desktop: dense grid table. Phone: collapses to cards (the fixed-px
          grid would otherwise overflow ~390px). */}
      {!loading && rows.length > 0 && isWide && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r)', overflow: 'hidden', boxShadow: CARD_SHADOW }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '0 14px', height: 38, alignItems: 'center', background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
            <span className="eyebrow">PR #</span>
            <span className="eyebrow">Status</span>
            <span className="eyebrow">Vendors</span>
            <span className="eyebrow" style={{ textAlign: 'right' }}>Lines</span>
            <span className="eyebrow" style={{ textAlign: 'right' }}>Est total</span>
            <span className="eyebrow">Created</span>
            <span className="eyebrow">ETA</span>
            <span></span>
          </div>

          {rows.map((pr, i) => (
            <div
              key={pr.id}
              onClick={() => setShowSheet({ mode: 'detail', prId: pr.id })}
              style={{
                display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '10px 14px', alignItems: 'center',
                fontSize: 13, cursor: 'pointer', background: 'var(--surface)',
                borderBottom: i < rows.length - 1 ? '1px solid var(--row-divider)' : 'none',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)' }}
            >
              <div className="mono" style={{ fontWeight: 600, color: 'var(--accent-dk)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pr.pr_number}</div>
              <div><span style={statusPill(pr.status)}>{pr.status}</span></div>
              <div style={{ color: pr.vendors.length === 0 ? 'var(--hint)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {vendorSummary(pr)}
              </div>
              <div className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{pr.lineCount}</div>
              <div className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
                {pr.estTotal > 0 ? `$${pr.estTotal.toFixed(2)}` : '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pr.created_by_user?.name || '—'}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--hint)' }}>{pr.date_requested}</div>
              </div>
              <div className="mono" style={{ fontSize: 12, color: pr.expected_at ? 'var(--text)' : 'var(--hint)' }}>
                {pr.expected_at || '—'}
              </div>
              <div style={{ textAlign: 'right', color: 'var(--hint)', display: 'flex', justifyContent: 'flex-end' }}>
                <Icon name="chevron-right" size={16} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && rows.length > 0 && !isWide && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(pr => (
            <div
              key={pr.id}
              onClick={() => setShowSheet({ mode: 'detail', prId: pr.id })}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', padding: '12px 14px', cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="mono" style={{ fontWeight: 700, color: 'var(--accent-dk)' }}>{pr.pr_number}</span>
                <span style={statusPill(pr.status)}>{pr.status}</span>
              </div>
              <div style={{ fontSize: 13, marginBottom: 6, color: pr.vendors.length === 0 ? 'var(--hint)' : 'var(--text)' }}>
                {vendorSummary(pr)}
              </div>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
                <span><span className="mono" style={{ fontWeight: 600, color: 'var(--text)' }}>{pr.lineCount}</span> lines</span>
                <span className="mono" style={{ fontWeight: 600, color: 'var(--text)' }}>{pr.estTotal > 0 ? `$${pr.estTotal.toFixed(2)}` : '—'}</span>
                <span>ETA <span className="mono">{pr.expected_at || '—'}</span></span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 6 }}>
                {pr.created_by_user?.name || '—'} · <span className="mono">{pr.date_requested}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showSheet && (
        <PurchaseRequestSheet
          mode={showSheet.mode}
          prId={showSheet.prId}
          locations={locations || []}
          onClose={() => setShowSheet(null)}
          onSaved={onSheetSaved}
          onChanged={() => setRefreshTick(t => t + 1)}
        />
      )}
    </div>
  )
}

// Status pill — semantic colors kept (pending amber, ordered emerald,
// received grey, cancelled red).
function statusPill(status) {
  const colors = {
    pending:   { fg: 'var(--amber)',     bg: 'var(--amber-lt)', border: 'var(--amber)' },
    ordered:   { fg: 'var(--accent-dk)', bg: 'var(--accent-lt)', border: 'var(--accent)' },
    partial:   { fg: 'var(--blue)',      bg: 'var(--blue-lt)',  border: 'var(--blue)' },
    received:  { fg: 'var(--muted)',     bg: 'var(--gray-lt)',  border: 'var(--border2)' },
    cancelled: { fg: 'var(--red)',       bg: 'var(--red-lt)',   border: 'var(--red)' },
  }
  const c = colors[status] || colors.pending
  return {
    padding: '2px 9px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em',
    color: c.fg, background: c.bg, border: `1px solid ${c.border}`,
    whiteSpace: 'nowrap',
  }
}
