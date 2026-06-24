import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { useIsWide } from '../../lib/useIsWide'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'
import { getLocations } from '../../lib/inventory'
import InventoryStockTab from './InventoryStockTab'
import InventoryLocationsTab from './InventoryLocationsTab'
import InventoryPartsTab from './InventoryPartsTab'
import InventoryMovementsTab from './InventoryMovementsTab'
import InventoryAuditTab from './InventoryAuditTab'
import PurchaseRequestsTab from './PurchaseRequestsTab'
import IntakeRequestsQueue from './IntakeRequestsQueue'
import CountTab from '../cycleCount/CountTab'
import PausedBanner from '../shared/PausedBanner'
import RecordMovementSheet from './RecordMovementSheet'
import MoveStockSheet from './MoveStockSheet'
import ReceivePOSheet from './ReceivePOSheet'
import ReconcileSheet from './ReconcileSheet'
import SonarImportSheet from './SonarImportSheet'
import FiberJobsImportSheet from './FiberJobsImportSheet'
import InventoryImportSheet from './InventoryImportSheet'
import SageExportSheet from './SageExportSheet'

// Secondary nav for the Inventory section (Console line icons). The top-level
// section nav lives in ManagerApp's sidebar; these are the inventory sub-views.
const SUBTABS = [
  { id: 'stock',     label: 'Stock',         icon: 'box' },
  { id: 'locations', label: 'Locations',     icon: 'warehouse' },
  { id: 'parts',     label: 'Parts',         icon: 'nut' },
  { id: 'movements', label: 'Activity',      icon: 'activity' },
  { id: 'prs',       label: 'Purchase Reqs', icon: 'clipboard' },
  { id: 'intake',    label: 'Found',         icon: 'download' },
  { id: 'audit',     label: 'Audit',         icon: 'scan' },
  { id: 'count',     label: 'Cycle Count',   icon: 'grid' },
]

export default function InventoryView() {
  const { showToast, currentUser } = useApp()
  const isWide = useIsWide()
  // Phone: the secondary inventory actions collapse into a bottom "Actions"
  // sheet opened from the toolbar ⋯ button. Desktop shows them inline as the
  // Actions strip. Closed by default.
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  useBackClose(actionMenuOpen ? 1 : 0, () => setActionMenuOpen(false))
  const [tab, setTab] = useState('stock')
  // Back returns from any sub-tab to the default Stock sub-tab (then another
  // Back leaves the Inventory tab via ManagerApp's tab layer). Sheets opened
  // over a sub-tab self-register and close first.
  useBackClose(tab !== 'stock' ? 1 : 0, () => setTab('stock'))
  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(true)
  const [showRecordSheet, setShowRecordSheet] = useState(false)
  const [showMoveSheet, setShowMoveSheet] = useState(false)
  const [showReceiveSheet, setShowReceiveSheet] = useState(false)
  const [showReconcileSheet, setShowReconcileSheet] = useState(false)
  const [showSonarSheet, setShowSonarSheet] = useState(false)
  const [showFiberJobsSheet, setShowFiberJobsSheet] = useState(false)
  const [showImportSheet, setShowImportSheet] = useState(false)
  const [showSageSheet, setShowSageSheet] = useState(false)
  // Bumped after a movement is recorded or part is updated, so child tabs re-fetch.
  const [refreshKey, setRefreshKey] = useState(0)
  // Cross-tab jumps (launcher + inline links). Each tab consumes its jump on
  // mount/change; the `n` counter re-fires the effect on repeat jumps.
  const [stockJump, setStockJump] = useState({ locationId: null, partId: null, n: 0 })
  const [countJump, setCountJump] = useState({ run: null, session: null, n: 0 })
  const [partsJump, setPartsJump] = useState({ partId: null, n: 0 })
  const [locationsJump, setLocationsJump] = useState({ locationId: null, n: 0 })

  function jumpToStock(locationId) {
    setStockJump(prev => ({ locationId, partId: null, n: prev.n + 1 }))
    setTab('stock')
  }
  function jumpToCount(run, session) {
    setCountJump(prev => ({ run, session, n: prev.n + 1 }))
    setTab('count')
  }
  function jumpToPart(partId) {
    setPartsJump(prev => ({ partId, n: prev.n + 1 }))
    setTab('parts')
  }
  function jumpToLocation(locationId) {
    setLocationsJump(prev => ({ locationId, n: prev.n + 1 }))
    setTab('locations')
  }

  async function loadLocations() {
    setLocationsLoading(true)
    try {
      const data = await getLocations()
      setLocations(data)
    } catch (e) {
      console.error('Load locations failed:', e)
      showToast('Could not load locations: ' + e.message)
    } finally {
      setLocationsLoading(false)
    }
  }

  useEffect(() => { loadLocations() }, [])

  function handleMovementRecorded(count = 1) {
    setShowRecordSheet(false)
    setRefreshKey(k => k + 1)
    showToast(count === 1 ? 'Movement recorded' : `${count} movements recorded`)
  }
  function handleMoved(count = 1) {
    setShowMoveSheet(false)
    setRefreshKey(k => k + 1)
    showToast(`Moved ${count} item${count === 1 ? '' : 's'}`)
  }
  function handlePOReceived(lineCount) {
    setShowReceiveSheet(false)
    setRefreshKey(k => k + 1)
    showToast(`Received ${lineCount} item${lineCount === 1 ? '' : 's'}`)
  }
  function handleReconcileApplied(count) {
    setShowReconcileSheet(false)
    setRefreshKey(k => k + 1)
    showToast(`Applied ${count} adjustment${count === 1 ? '' : 's'}`)
  }
  function handleSonarApplied(count) {
    setShowSonarSheet(false)
    setRefreshKey(k => k + 1)
    showToast(`Issued ${count} Sonar transaction${count === 1 ? '' : 's'}`)
  }
  function handleFiberJobsApplied(count) {
    setShowFiberJobsSheet(false)
    setRefreshKey(k => k + 1)
    showToast(`Imported ${count} fiber-job movement${count === 1 ? '' : 's'}`)
  }
  function handleLocationsChanged() {
    loadLocations()
    setRefreshKey(k => k + 1)
  }
  function handleImportComplete() {
    loadLocations()
    setRefreshKey(k => k + 1)
  }
  function handlePartsChanged() {
    setRefreshKey(k => k + 1)
  }

  const noLocations = !locationsLoading && locations.length === 0

  // Secondary inventory actions (shared by the desktop Actions strip + the
  // phone Actions sheet). These open the various import/receive/export sheets.
  const ACTIONS = [
    { id: 'move',      label: 'Move stock',  sub: 'Scan to relocate',    icon: 'move',     onClick: () => setShowMoveSheet(true),      disabled: noLocations },
    { id: 'receive',   label: 'Receive PO',  sub: 'Vendor delivery',     icon: 'download', onClick: () => setShowReceiveSheet(true),   disabled: noLocations },
    { id: 'reconcile', label: 'Reconcile',   sub: 'Apply an audit CSV',  icon: 'refresh',  onClick: () => setShowReconcileSheet(true), disabled: noLocations },
    { id: 'sonar',     label: 'Sonar',       sub: 'Serialized installs', icon: 'zap',      onClick: () => setShowSonarSheet(true),     disabled: noLocations },
    { id: 'fiber',     label: 'Fiber jobs',  sub: 'Cable & drops report',icon: 'layers',   onClick: () => setShowFiberJobsSheet(true), disabled: noLocations },
    { id: 'import',    label: 'Import CSV',  sub: 'BoxHero catalog',     icon: 'upload',   onClick: () => setShowImportSheet(true),    disabled: false },
    { id: 'sage',      label: 'Sage export', sub: 'Build the period CSV',icon: 'receipt',  onClick: () => setShowSageSheet(true),      disabled: false },
  ]

  // Count sub-tab takes over the full panel — its body is a scanner-driven
  // counter UI that needs every vertical pixel on mobile. Navigation back is
  // via CountTab's own "← Inventory" button.
  if (tab === 'count') {
    return <CountTab onExitTab={() => setTab('stock')} jumpTo={countJump} />
  }

  const activeLabel = SUBTABS.find(s => s.id === tab)?.label || 'Inventory'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PausedBanner />

      {/* Toolbar */}
      <div style={{
        height: 60, flexShrink: 0, padding: '0 20px', background: 'var(--surface)',
        borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.01em', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {activeLabel}
        </div>
        <button
          className="btn btn-primary"
          onClick={() => setShowRecordSheet(true)}
          disabled={noLocations}
          title={noLocations ? 'Create a location first' : ''}
          style={{ height: 36, padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}
        >
          <Icon name="plus" size={16} /> {isWide ? 'Record movement' : 'Record'}
        </button>
        {!isWide && (
          <button
            onClick={() => setActionMenuOpen(true)}
            aria-label="More actions"
            style={{ width: 36, height: 36, borderRadius: 8, border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
          >
            <Icon name="dots" size={18} />
          </button>
        )}
      </div>

      {/* Secondary sub-nav */}
      <div style={{
        flexShrink: 0, display: 'flex', gap: 4, padding: '8px 16px', background: 'var(--surface)',
        borderBottom: '1px solid var(--border)', overflowX: 'auto',
      }}>
        {SUBTABS.map(s => {
          const active = tab === s.id
          return (
            <button key={s.id} onClick={() => setTab(s.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderRadius: 8,
              fontSize: 13, fontWeight: active ? 700 : 600, whiteSpace: 'nowrap', border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent-lt)' : 'transparent',
              color: active ? 'var(--accent-dk)' : 'var(--muted)',
            }}>
              <Icon name={s.icon} size={16} /> {s.label}
            </button>
          )
        })}
      </div>

      {/* Actions strip (desktop) */}
      {isWide && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px',
          background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap',
        }}>
          <span className="eyebrow" style={{ marginRight: 2 }}>Actions</span>
          {ACTIONS.map(a => (
            <button key={a.id} onClick={a.onClick} disabled={a.disabled}
              title={a.disabled ? 'Create a location first' : a.sub}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 12px', borderRadius: 8,
                fontSize: 12.5, fontWeight: 600, background: 'var(--surface2)', border: '1px solid var(--border2)',
                color: a.disabled ? 'var(--hint)' : 'var(--text)', cursor: a.disabled ? 'not-allowed' : 'pointer',
              }}>
              <Icon name={a.icon} size={15} /> {a.label}
            </button>
          ))}
        </div>
      )}

      {noLocations && tab !== 'locations' && (
        <div style={{ padding: '12px 20px 0' }}>
          <div style={{
            background: 'var(--amber-lt)', border: '1px solid var(--amber)',
            borderRadius: 'var(--r-sm)', padding: '10px 14px', fontSize: 13, color: 'var(--amber)',
          }}>
            No locations yet — head to <button
              onClick={() => setTab('locations')}
              style={{ background: 'none', border: 'none', color: 'var(--amber)', cursor: 'pointer', padding: 0, fontWeight: 800, textDecoration: 'underline', fontSize: 13 }}
            >Locations</button> to add a warehouse and assign trucks.
            (You can also create locations on the fly during CSV import.)
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {tab === 'stock' && (
          <InventoryStockTab
            locations={locations}
            locationsLoading={locationsLoading}
            refreshKey={refreshKey}
            jumpToScope={stockJump}
            onJumpToPart={jumpToPart}
            onJumpToLocation={jumpToLocation}
          />
        )}
        {tab === 'locations' && (
          <InventoryLocationsTab
            locations={locations}
            loading={locationsLoading}
            onChanged={handleLocationsChanged}
            onJumpToStock={jumpToStock}
            onJumpToCount={jumpToCount}
            onJumpToPart={jumpToPart}
            focusJump={locationsJump}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'parts' && (
          <InventoryPartsTab
            refreshKey={refreshKey}
            onChanged={handlePartsChanged}
            focusJump={partsJump}
            onJumpToLocation={jumpToLocation}
            locations={locations}
            currentUser={currentUser}
          />
        )}
        {tab === 'movements' && (
          <InventoryMovementsTab locations={locations} refreshKey={refreshKey} />
        )}
        {tab === 'prs' && (
          <PurchaseRequestsTab locations={locations} refreshKey={refreshKey} />
        )}
        {tab === 'intake' && (
          <IntakeRequestsQueue />
        )}
        {tab === 'audit' && (
          <InventoryAuditTab locations={locations} refreshKey={refreshKey} />
        )}
      </div>

      {/* Phone: Actions bottom sheet */}
      {actionMenuOpen && !isWide && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setActionMenuOpen(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 12 }}>Actions</div>
            {ACTIONS.map(a => (
              <button key={a.id} disabled={a.disabled}
                onClick={() => { a.onClick(); setActionMenuOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 4px',
                  background: 'transparent', border: 'none', borderBottom: '1px solid var(--row-divider)',
                  textAlign: 'left', cursor: a.disabled ? 'not-allowed' : 'pointer', opacity: a.disabled ? 0.5 : 1,
                }}>
                <div style={{ width: 38, height: 38, borderRadius: 9, background: 'var(--surface2)', color: 'var(--accent-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name={a.icon} size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{a.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--hint)' }}>{a.sub}</div>
                </div>
                <Icon name="chevron-right" size={18} color="var(--hint)" />
              </button>
            ))}
            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 14 }} onClick={() => setActionMenuOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {showRecordSheet && (
        <RecordMovementSheet
          locations={locations}
          currentUser={currentUser}
          onClose={() => setShowRecordSheet(false)}
          onRecorded={handleMovementRecorded}
        />
      )}
      {showMoveSheet && (
        <MoveStockSheet
          onClose={() => setShowMoveSheet(false)}
          onDone={handleMoved}
        />
      )}
      {showReceiveSheet && (
        <ReceivePOSheet
          locations={locations}
          currentUser={currentUser}
          onClose={() => setShowReceiveSheet(false)}
          onRecorded={handlePOReceived}
        />
      )}
      {showReconcileSheet && (
        <ReconcileSheet
          onClose={() => setShowReconcileSheet(false)}
          onApplied={handleReconcileApplied}
        />
      )}
      {showSonarSheet && (
        <SonarImportSheet
          onClose={() => setShowSonarSheet(false)}
          onApplied={handleSonarApplied}
        />
      )}
      {showFiberJobsSheet && (
        <FiberJobsImportSheet
          onClose={() => setShowFiberJobsSheet(false)}
          onApplied={handleFiberJobsApplied}
        />
      )}
      {showSageSheet && (
        <SageExportSheet onClose={() => setShowSageSheet(false)} />
      )}
      {showImportSheet && (
        <InventoryImportSheet
          locations={locations}
          currentUser={currentUser}
          onClose={() => setShowImportSheet(false)}
          onComplete={handleImportComplete}
        />
      )}
    </div>
  )
}
