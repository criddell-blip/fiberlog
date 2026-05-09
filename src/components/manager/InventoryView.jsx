import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { getLocations } from '../../lib/inventory'
import InventoryStockTab from './InventoryStockTab'
import InventoryLocationsTab from './InventoryLocationsTab'
import InventoryPartsTab from './InventoryPartsTab'
import InventoryMovementsTab from './InventoryMovementsTab'
import InventoryAuditTab from './InventoryAuditTab'
import RecordMovementSheet from './RecordMovementSheet'
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
  const [showImportSheet, setShowImportSheet] = useState(false)
  // Bumped after a movement is recorded or part is updated, so child tabs
  // re-fetch their data
  const [refreshKey, setRefreshKey] = useState(0)

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
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-ghost"
              onClick={() => setShowImportSheet(true)}
              style={{ padding: '6px 12px', fontSize: 13 }}
            >
              ⇪ Import CSV
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
          />
        )}
        {tab === 'locations' && (
          <InventoryLocationsTab
            locations={locations}
            loading={locationsLoading}
            onChanged={handleLocationsChanged}
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
