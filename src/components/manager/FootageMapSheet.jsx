import { useState, useEffect, useCallback } from 'react'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import { getFootageTypePartMap, setFootageTypePart, clearFootageTypePart } from '../../lib/inventory'
import { FOOTAGE_TYPE_VALUES, FOOTAGE_KIND_LABELS } from '../../lib/footageTypes'
import PartSearch from '../crew/workspace/PartSearch'
import Icon from '../shared/Icon'

// Manager editor for the footage type → part map. Each fiber strand count,
// conduit size and strand size maps to one canonical SKU; when a crew logs
// that footage + type,
// the workspace consumes the mapped part by the foot. Unmapped = footage-only
// (no material), exactly as before mapping.
export default function FootageMapSheet({ onClose }) {
  const { showToast } = useApp()
  const [map, setMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(null)   // { kind, value } while choosing a SKU

  // Static depth 1 — PartSearch self-registers its own back layer when open
  // (the picker handles its own Back); we just own the sheet.
  useBackClose(1, onClose)

  const load = useCallback(async () => {
    setLoading(true)
    try { setMap(await getFootageTypePartMap()) }
    catch (e) { showToast('Load failed: ' + e.message) }
    finally { setLoading(false) }
  }, [showToast])
  useEffect(() => { load() }, [load])

  async function handlePick(p) {
    if (!picking) return
    try {
      await setFootageTypePart(picking.kind, picking.value, p.id)
      showToast(`${picking.value} → ${p.name}`)
      setPicking(null)
      load()
    } catch (e) { showToast('Map failed: ' + e.message) }
  }

  async function handleClear(kind, value) {
    try {
      await clearFootageTypePart(kind, value)
      showToast(`Cleared ${value}`)
      load()
    } catch (e) { showToast('Clear failed: ' + e.message) }
  }

  function Section({ title, kind, values }) {
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{title}</div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
          {values.map((v, i) => {
            const hit = map[kind]?.[v]
            return (
              <div key={v} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                borderBottom: i < values.length - 1 ? '1px solid var(--border)' : 'none',
                background: 'var(--surface)',
              }}>
                <div style={{ width: 56, flexShrink: 0, fontWeight: 700, fontSize: 14 }}>{v}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {hit ? (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hit.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--hint)', fontFamily: 'var(--font-mono)' }}>{hit.partId} · {hit.unit || 'ft'}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--hint)' }}>Not mapped — footage logs no material</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPicking({ kind, value: v })}
                  style={{ padding: '6px 10px', borderRadius: 'var(--r-sm)', border: '1.5px solid var(--teal)', background: 'var(--surface2)', color: 'var(--teal-mid)', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}
                >{hit ? 'Change' : 'Set'}</button>
                {hit && (
                  <button type="button" onClick={() => handleClear(kind, v)} aria-label="Clear"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: 18, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>×</button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet" style={{ maxWidth: 520, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>Footage → part map</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Map each fiber strand count and conduit size to the SKU that footage consumes.
          When a crew logs that footage + type, the part deducts by the foot at approval.
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>
          ) : (
            <>
              {/* One section per footage kind, straight from the registry, so
                  adding a kind needs no edit here. */}
              {Object.entries(FOOTAGE_TYPE_VALUES).map(([kind, values]) => (
                <Section key={kind} title={FOOTAGE_KIND_LABELS[kind]} kind={kind} values={values} />
              ))}
            </>
          )}
        </div>

        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12, flexShrink: 0 }} onClick={onClose}>Done</button>
      </div>

      {picking && (
        <PartSearch onSelect={handlePick} onClose={() => setPicking(null)} />
      )}
    </div>
  )
}
