import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { getLocations } from '../../lib/inventory'
import InventoryStockTab from './InventoryStockTab'
import InventoryLocationsTab from './InventoryLocationsTab'
import InventoryPartsTab from './InventoryPartsTab'
import InventoryMovementsTab from './InventoryMovementsTab'
import InventoryAuditTab from './InventoryAuditTab'
import RecordMovementSheet from './RecordMovementSheet'
import ReceivePOSheet from './ReceivePOSheet'
import ReconcileSheet from './ReconcileSheet'
import SonarImportSheet from './SonarImportSheet'
import InventoryImportSheet from './InventoryImportSheet'

const SUBTABS = [
  { id: 'stock',     label: 'Stock',     icon: '📦' },
  { id: 'locations', label: 'Locations', icon: '🏭' },
  { id: 'parts',     label: 'Parts',     icon: '🔧' },
  { id: 'movements', label: 'Activity',  icon: '📜' },
  { id: 'audit',     label: 'Audit',     icon: '🔍' },
]

export default function InventoryView() {
  const { showToast, currentUser } = useApp()
  const [tab, setTab] = useState('stock')
  const [locations, setLocations] = useState([])
  const [locationsLoading, setLocationsLoading] = useState(true)
  const [showRecordSheet, setShowRecordSheet] = useState(false)
  const [showReceiveSheet, setShowReceiveSheet] = useState(false)
  const [showReconcileSheet, setShowReconcileSheet] = useState(false)
  const [showSonarSheet, setShowSonarSheet] = useState(false)
  const [showImportSheet, setShowImportSheet] = useState(false)
  // Bumped after a movement is recorded or part is updated, so child tabs
  // re-fetch their data
  const [refreshKey, setRefreshKey] = useState(0)
  // When the user clicks "View stock" on a location card, we set this and
  // flip the tab. StockTab reads it on mount + on change to seed its
  // scope; the counter ensures repeat clicks on the same location still
  // re-fire the effect.
  const [stockJump, setStockJump] = useState({ locationId: null, n: 0 })

  function jumpToStock(locationId) {
    setStockJump(prev => ({ locationId, n: prev.n + 1 }))
    setTab('stock')
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

  function handleMovementRecorded() {
    setShowRecordSheet(false)
    setRefreshKey(k => k + 1)
    showToast('Movement recorded')
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Inventory</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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
              title={noLocations ? 'Create a location first' : 'Import a Sonar daily install report (issues consumed parts off crew trucks)'}
              style={{ padding: '6px 12px', fontSize: 13 }}
            >
              ⚡ Sonar
            </button>
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
          />
        )}
        {tab === 'locations' && (
          <InventoryLocationsTab
            locations={locations}
            loading={locationsLoading}
            onChanged={handleLocationsChanged}
            onJumpToStock={jumpToStock}
            refreshKey={refreshKey}
          />
        )}
        {tab === 'parts' && (
          <InventoryPartsTab
            refreshKey={refreshKey}
            onChanged={handlePartsChanged}
          />
        )}
        {tab === 'movements' && (
          <InventoryMovementsTab
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
