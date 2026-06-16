import { useState, useEffect, useRef } from 'react'
import { useApp } from '../../AppContext'
import { useIsWide } from '../../lib/useIsWide'
import { getLocations } from '../../lib/inventory'
import InventoryStockTab from './InventoryStockTab'
import InventoryLocationsTab from './InventoryLocationsTab'
import InventoryPartsTab from './InventoryPartsTab'
import InventoryMovementsTab from './InventoryMovementsTab'
import InventoryAuditTab from './InventoryAuditTab'
import PurchaseRequestsTab from './PurchaseRequestsTab'
import CountTab from '../cycleCount/CountTab'
import PausedBanner from '../shared/PausedBanner'
import RecordMovementSheet from './RecordMovementSheet'
import ReceivePOSheet from './ReceivePOSheet'
import ReconcileSheet from './ReconcileSheet'
import SonarImportSheet from './SonarImportSheet'
import FiberJobsImportSheet from './FiberJobsImportSheet'
import InventoryImportSheet from './InventoryImportSheet'
import SageExportSheet from './SageExportSheet'

const SUBTABS = [
  { id: 'stock',     label: 'Stock',     icon: '📦' },
  { id: 'locations', label: 'Locations', icon: '🏭' },
  { id: 'parts',     label: 'Parts',     icon: '🔧' },
  { id: 'movements', label: 'Activity',  icon: '📜' },
  { id: 'prs',       label: 'PRs',       icon: '📋' },
  { id: 'audit',     label: 'Audit',     icon: '🔍' },
  { id: 'count',     label: 'Count',     icon: '🔢' },
]

export default function InventoryView() {
  const { showToast, currentUser } = useApp()
  const isWide = useIsWide()
  // Mobile action-menu state. On phone the 4 secondary actions (Import / PO /
  // Reconcile / Sonar) collapse behind a "⋯ More" button to keep the header
  // slim; primary "+ Record movement" stays visible. Closed by default.
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const actionMenuRef = useRef(null)
  // Auto-close the menu on outside-tap (matches native popover UX)
  useEffect(() => {
    if (!actionMenuOpen) return
    const handler = (e) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target)) {
        setActionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [actionMenuOpen])
  const [tab, setTab] = useState('stock')
  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(true)
  const [showRecordSheet, setShowRecordSheet] = useState(false)
  const [showReceiveSheet, setShowReceiveSheet] = useState(false)
  const [showReconcileSheet, setShowReconcileSheet] = useState(false)
  const [showSonarSheet, setShowSonarSheet] = useState(false)
  const [showFiberJobsSheet, setShowFiberJobsSheet] = useState(false)
  const [showImportSheet, setShowImportSheet] = useState(false)
  const [showSageSheet, setShowSageSheet] = useState(false)
  // Bumped after a movement is recorded or part is updated, so child tabs
  // re-fetch their data
  const [refreshKey, setRefreshKey] = useState(0)
  // When the user clicks "View stock" on a location card, we set this and
  // flip the tab. StockTab reads it on mount + on change to seed its
  // scope; the counter ensures repeat clicks on the same location still
  // re-fire the effect. partId is set by the launcher when picking a
  // stock pair so the Stock tab can also pre-filter to the SKU.
  const [stockJump, setStockJump] = useState({ locationId: null, partId: null, n: 0 })
  // Count jump — flips to Count tab and seeds CountTab with a specific run +
  // optional session to auto-open. Used by LocationDetailPanel's "Count this
  // bin" action so the manager goes directly into the bin's session instead
  // of starting from Count tab's empty state. Counter (n) ensures repeat
  // clicks on the same target still re-fire the effect.
  const [countJump, setCountJump] = useState({ run: null, session: null, n: 0 })
  // Parts / Locations focus jumps from the launcher and cross-tab links.
  // Each tab consumes its jump prop on mount/change, scrolls to the
  // target row, and highlights for ~2 sec. Counter pattern matches the
  // existing stockJump / countJump pattern so repeated clicks on the
  // same entity still re-fire.
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

  // Count sub-tab takes over the full panel — its body is a scanner-driven
  // counter UI that needs every vertical pixel on mobile. The Inventory
  // chrome (action buttons + sub-tab pills) doesn't apply while counting,
  // so we suppress it and give CountTab the full panel. Navigation back is
  // via CountTab's own "← Inventory" button.
  if (tab === 'count') {
    return <CountTab onExitTab={() => setTab('stock')} jumpTo={countJump} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PausedBanner />
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Inventory</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Desktop: all 4 secondary actions visible.
                Mobile: collapsed behind a "⋯ More" button to keep the
                header at one row even on a 360px viewport. */}
            {isWide ? (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowImportSheet(true)}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  ⇪ Import CSV
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowReceiveSheet(true)}
                  disabled={noLocations}
                  title={noLocations ? 'Create a destination location first' : 'Receive a vendor delivery / purchase order'}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  📥 Receive PO
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowReconcileSheet(true)}
                  disabled={noLocations}
                  title={noLocations ? 'Create a location first' : 'Upload a filled-in Audit CSV to reconcile system stock to a physical count'}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  🔄 Reconcile
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowSonarSheet(true)}
                  disabled={noLocations}
                  title={noLocations ? 'Create a location first' : 'Import the Sonar asset-tagged consumption report'}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  ⚡ Sonar
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowFiberJobsSheet(true)}
                  disabled={noLocations}
                  title={noLocations ? 'Create a location first' : 'Import the Sonar fiber-jobs report (pushable cable, drops, ONT boxes, etc.)'}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  🧵 Fiber jobs
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowSageSheet(true)}
                  title="Export movements to Sage Intacct Inventory Transactions CSV"
                  style={{ padding: '6px 12px', fontSize: 13 }}
                >
                  🧾 Sage export
                </button>
              </>
            ) : (
              <div ref={actionMenuRef} style={{ position: 'relative' }}>
                <button
                  className="btn btn-ghost"
                  onClick={() => setActionMenuOpen(v => !v)}
                  style={{ padding: '6px 12px', fontSize: 13 }}
                  title="Import / Receive PO / Reconcile / Sonar"
                >
                  ⋯ More
                </button>
                {actionMenuOpen && (
                  <div style={{
                    // left:0 anchors the popover to the LEFT edge of the
                    // button. On phone the action row wraps to its own line
                    // and the More button ends up near the left of the
                    // viewport, so right:0 was sending the popover off-screen.
                    // (More button is mobile-only — desktop renders all 4
                    // actions inline so this menu never opens there.)
                    position: 'absolute', top: 'calc(100% + 4px)', left: 0,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)',
                    padding: 4, minWidth: 180,
                    maxWidth: 'calc(100vw - 32px)',
                    zIndex: 100,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  }}>
                    {[
                      { label: '⇪ Import CSV', onClick: () => setShowImportSheet(true), disabled: false },
                      { label: '📥 Receive PO', onClick: () => setShowReceiveSheet(true), disabled: noLocations },
                      { label: '🔄 Reconcile', onClick: () => setShowReconcileSheet(true), disabled: noLocations },
                      { label: '⚡ Sonar (assets)', onClick: () => setShowSonarSheet(true), disabled: noLocations },
                      { label: '🧵 Sonar (fiber jobs)', onClick: () => setShowFiberJobsSheet(true), disabled: noLocations },
                      { label: '🧾 Sage export', onClick: () => setShowSageSheet(true), disabled: false },
                    ].map(item => (
                      <button
                        key={item.label}
                        onClick={() => { item.onClick(); setActionMenuOpen(false) }}
                        disabled={item.disabled}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '8px 12px', background: 'transparent', border: 'none',
                          fontSize: 13, fontWeight: 600,
                          color: item.disabled ? 'var(--hint)' : 'var(--text)',
                          cursor: item.disabled ? 'not-allowed' : 'pointer',
                          borderRadius: 'var(--r-xs)',
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              className="btn btn-primary"
              onClick={() => setShowRecordSheet(true)}
              disabled={noLocations}
              title={noLocations ? 'Create a location first' : ''}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              ＋ Record movement
            </button>
          </div>
        </div>
        {/* Sub-tab nav: pills on desktop, native dropdown on phone.
            6 pills wrap to 2 rows on a 360px viewport; dropdown is 1 row. */}
        {isWide ? (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {SUBTABS.map(s => (
              <button
                key={s.id}
                onClick={() => setTab(s.id)}
                style={{
                  padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                  background: tab === s.id ? 'var(--orange)' : 'var(--gray-lt)',
                  color: tab === s.id ? 'white' : 'var(--muted)',
                  border: 'none', cursor: 'pointer'
                }}
              >
                {s.icon} {s.label}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <select
              value={tab}
              onChange={e => setTab(e.target.value)}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 14, fontWeight: 700,
                border: '1.5px solid var(--orange)',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface2)', color: 'var(--text)',
              }}
            >
              {SUBTABS.map(s => (
                <option key={s.id} value={s.id}>{s.icon} {s.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {noLocations && tab !== 'locations' && (
        <div style={{ padding: '0 20px 12px' }}>
          <div style={{
            background: 'var(--amber-lt)', border: '1px solid var(--amber)',
            borderRadius: 'var(--r-sm)', padding: '10px 14px',
            fontSize: 13, color: 'var(--amber)'
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
          <InventoryMovementsTab
            locations={locations}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'prs' && (
          <PurchaseRequestsTab
            locations={locations}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'audit' && (
          <InventoryAuditTab
            locations={locations}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'count' && <CountTab />}
      </div>

      {showRecordSheet && (
        <RecordMovementSheet
          locations={locations}
          currentUser={currentUser}
          onClose={() => setShowRecordSheet(false)}
          onRecorded={handleMovementRecorded}
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
