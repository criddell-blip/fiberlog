import { useState, useEffect } from 'react'
import { db, saveAssembly, deleteAssembly, getAssembliesRaw, searchPartsCatalog } from '../../lib/supabase'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

// Unified Console action chip for the assembly row buttons.
function asmChip() {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 12, fontWeight: 600, color: 'var(--muted)',
    background: 'var(--surface)', border: '1px solid var(--border2)',
    borderRadius: 8, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
  }
}

// All crew types now show as tabs. The new install/infrastructure tabs will
// be empty until the manager builds out their kits — Chris will see them
// as places to start building install/tower templates ahead of those
// crews actually using the app.
const CREW_TYPES = [
  { id: 'aerial',         label: 'Aerial',         icon: '🏗️' },
  { id: 'footage',        label: 'Footage/MST',    icon: '📏' },
  { id: 'splice',         label: 'Splice',         icon: '🔌' },
  { id: 'underground',    label: 'Underground',    icon: '⛏️' },
  { id: 'install',        label: 'Install',        icon: '🏠' },
  { id: 'infrastructure', label: 'Infrastructure', icon: '📡' },
]

// Crew types that support the existing fiber-build behavior flags below.
// Install + infrastructure crews don't use any of these (they're all
// fiber-construction concepts: footage runs, splice cases, vaults,
// conduit). When/if those crews need their own behavior flags, we add
// them as a separate group with a different `appliesTo` set.
const FIBER_CREW_TYPES = ['aerial', 'footage', 'splice', 'underground']
const FLAG_KEYS = [
  'is_footage', 'is_fiber', 'is_mst',
  'is_splice_case', 'is_handhole', 'is_vault', 'is_conduit', 'is_strand',
]

const FLAGS = [
  { key: 'is_footage',    label: 'Is footage (input box instead of tally)' },
  { key: 'is_fiber',      label: 'Show fiber count picker' },
  { key: 'is_mst',        label: 'Counts as MST/HST unit' },
  { key: 'is_splice_case',label: 'Counts as splice case' },
  { key: 'is_handhole',   label: 'Counts as handhole' },
  { key: 'is_vault',      label: 'Counts as vault' },
  { key: 'is_conduit',    label: 'Show conduit size picker' },
  { key: 'is_strand',     label: 'Show strand size picker' },
]

// Should the flags section be shown for a given crew type?
function crewSupportsFlags(crewType) {
  return FIBER_CREW_TYPES.includes(crewType)
}

export default function AssemblyEditor() {
  const { showToast, reload } = useApp()
  const [assemblies, setAssemblies] = useState([])
  const [loading, setLoading] = useState(true)
  const [selTab, setSelTab] = useState('aerial')
  const [editing, setEditing] = useState(null) // null | new-template object | existing assembly object
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(null)

  // Back dismisses the delete-confirm first (move-to-top), else closes the
  // editor back to the assembly list (like its Cancel).
  useBackClose(confirm ? 1 : 0, () => setConfirm(null))
  useBackClose(editing ? 1 : 0, () => setEditing(null))
  const [partSearch, setPartSearch] = useState('')
  const [partResults, setPartResults] = useState([])

  useEffect(() => { loadAssemblies() }, [])

  async function loadAssemblies() {
    setLoading(true)
    try {
      const data = await getAssembliesRaw()
      setAssemblies(data)
    } catch(e) { showToast('Load failed: ' + e.message) }
    finally { setLoading(false) }
  }

  async function searchParts(q) {
    setPartSearch(q)
    if (q.length < 2) { setPartResults([]); return }
    const data = await searchPartsCatalog(q, { limit: 8 })
    setPartResults(data || [])
  }

  function startNew() {
    setEditing({
      // Default the new assembly to whichever tab the manager is currently
      // viewing — saves a click when filling out empty install/infra tabs.
      id: '', label: '', sub_label: '', crew_type: selTab,
      is_footage: false, is_fiber: false, is_mst: false,
      is_splice_case: false, is_handhole: false, is_vault: false, is_conduit: false, is_strand: false,
      is_active: true, sort_order: 0,
      assembly_parts: []
    })
    setPartSearch('')
    setPartResults([])
  }

  function startEdit(asm) {
    setEditing({ ...asm, assembly_parts: asm.assembly_parts ? [...asm.assembly_parts] : [] })
    setPartSearch('')
    setPartResults([])
  }

  // Clone an existing assembly to a new id/crew. Useful when an install kit
  // is similar to an aerial kit, or when copying a template across crews.
  function startDuplicate(asm) {
    setEditing({
      // Blank id forces a new one to be generated from the (modified) label
      id: '',
      label: asm.label + ' (copy)',
      sub_label: asm.sub_label || '',
      crew_type: asm.crew_type,
      is_footage: !!asm.is_footage,
      is_fiber: !!asm.is_fiber,
      is_mst: !!asm.is_mst,
      is_splice_case: !!asm.is_splice_case,
      is_handhole: !!asm.is_handhole,
      is_vault: !!asm.is_vault,
      is_conduit: !!asm.is_conduit,
      is_strand: !!asm.is_strand,
      is_active: asm.is_active !== false,
      sort_order: (asm.sort_order || 0) + 1,
      // Deep copy parts so edits don't leak back to the source
      assembly_parts: (asm.assembly_parts || []).map(p => ({
        part_id: p.part_id,
        parts_catalog: p.parts_catalog
          ? { name: p.parts_catalog.name, unit: p.parts_catalog.unit }
          : undefined,
        default_qty: p.default_qty,
        unit: p.unit || 'ea',
        per_ft: !!p.per_ft,
        sort_order: p.sort_order,
      })),
    })
    setPartSearch('')
    setPartResults([])
  }

  // Switching crew_type. If the new type doesn't support behavior flags,
  // clear them — keeps the saved data clean and avoids surprise behavior
  // if someone later switches the assembly back to a fiber crew type.
  function setEditingCrewType(newCrewType) {
    setEditing(prev => {
      if (!prev) return prev
      const next = { ...prev, crew_type: newCrewType }
      if (!crewSupportsFlags(newCrewType)) {
        for (const k of FLAG_KEYS) next[k] = false
      }
      return next
    })
  }

  function addPart(part) {
    if (!editing) return
    if (editing.assembly_parts.find(p => p.part_id === part.id)) { showToast('Part already in assembly'); return }
    setEditing(prev => ({
      ...prev,
      assembly_parts: [...prev.assembly_parts, {
        part_id: part.id,
        parts_catalog: { name: part.name, unit: part.unit || 'ea' },
        default_qty: 1,
        unit: part.unit || 'ea',
        per_ft: false,
        sort_order: prev.assembly_parts.length,
      }]
    }))
    setPartSearch('')
    setPartResults([])
  }

  function updatePart(idx, field, val) {
    setEditing(prev => ({
      ...prev,
      assembly_parts: prev.assembly_parts.map((p, i) => i === idx ? { ...p, [field]: val } : p)
    }))
  }

  function removePart(idx) {
    setEditing(prev => ({ ...prev, assembly_parts: prev.assembly_parts.filter((_, i) => i !== idx) }))
  }

  async function handleSave() {
    if (!editing.label.trim()) { showToast('Assembly needs a name'); return }
    if (!editing.id.trim() && editing.id !== undefined) {
      // Generate ID from label for new (or duplicated) assemblies
      editing.id = editing.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    }
    setSaving(true)
    try {
      await saveAssembly({
        id: editing.id,
        label: editing.label.trim(),
        sub: editing.sub_label || '',
        crew_type: editing.crew_type,
        isFootage: editing.is_footage,
        isFiber: editing.is_fiber,
        isMst: editing.is_mst,
        isSpliceCase: editing.is_splice_case,
        isHandhole: editing.is_handhole,
        isVault: editing.is_vault,
        isConduit: editing.is_conduit,
        isStrand: editing.is_strand,
        is_active: editing.is_active !== false,
        sort_order: editing.sort_order || 0,
        parts: editing.assembly_parts.map((p, i) => ({
          id: p.part_id,
          qty: parseFloat(p.default_qty) || 1,
          unit: p.unit || 'ea',
          perFt: p.per_ft || false,
          sort_order: i,
        }))
      })
      showToast(editing.id ? 'Assembly saved' : 'Assembly created')
      setEditing(null)
      await loadAssemblies()
    } catch(e) {
      showToast('Save failed: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(asm) {
    try {
      await deleteAssembly(asm.id)
      showToast(`Deleted: ${asm.label}`)
      setConfirm(null)
      setAssemblies(prev => prev.filter(a => a.id !== asm.id))
    } catch(e) {
      showToast('Delete failed: ' + e.message)
    }
  }

  // Build a counts map so the tabs can show how many assemblies each
  // crew type has — empty crew types now have an obvious "0" so it's
  // clear they need filling out.
  const countsByCrew = assemblies.reduce((acc, a) => {
    acc[a.crew_type] = (acc[a.crew_type] || 0) + 1
    return acc
  }, {})

  const tabAsms = assemblies.filter(a => a.crew_type === selTab)

  // ── Edit form ──────────────────────────────────────────────────────────────
  if (editing) {
    const showFlags = crewSupportsFlags(editing.crew_type)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => setEditing(null)} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
          <div style={{ fontWeight: 800, fontSize: 17 }}>{editing.id ? 'Edit Assembly' : 'New Assembly'}</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Basic info */}
          <div className="field">
            <label>Assembly name *</label>
            <input type="text" value={editing.label} onChange={e => setEditing(p => ({ ...p, label: e.target.value }))} placeholder='e.g. Inter Pole 12"' autoFocus />
          </div>
          <div className="field">
            <label>Sub-label (description)</label>
            <input type="text" value={editing.sub_label || ''} onChange={e => setEditing(p => ({ ...p, sub_label: e.target.value }))} placeholder='e.g. Machine bolt 12"' />
          </div>

          {/* Crew type */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Tab / crew type</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CREW_TYPES.map(ct => (
                <button key={ct.id} onClick={() => setEditingCrewType(ct.id)}
                  style={{ padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    background: editing.crew_type === ct.id ? 'var(--orange)' : 'var(--gray-lt)',
                    color: editing.crew_type === ct.id ? 'white' : 'var(--muted)', border: 'none' }}>
                  {ct.icon} {ct.label}
                </button>
              ))}
            </div>
          </div>

          {/* Flags — only shown for fiber-build crew types. Install and
              infrastructure don't have meaningful flags yet (the existing
              ones are all fiber-construction concepts: footage, splice
              cases, vaults, conduit). */}
          {showFlags ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Behavior flags</div>
              {FLAGS.map(f => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={editing[f.key] || false}
                    onChange={e => setEditing(p => ({ ...p, [f.key]: e.target.checked }))} />
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{f.label}</span>
                </label>
              ))}
            </div>
          ) : (
            <div style={{
              marginBottom: 16, padding: '10px 14px',
              background: 'var(--surface2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--muted)',
            }}>
              No behavior flags for {(CREW_TYPES.find(ct => ct.id === editing.crew_type) || {}).label || editing.crew_type} assemblies — those are all fiber-build specific.
            </div>
          )}

          {/* Sort order */}
          <div className="field">
            <label>Sort order</label>
            <input type="number" value={editing.sort_order || 0} onChange={e => setEditing(p => ({ ...p, sort_order: parseInt(e.target.value) || 0 }))} style={{ width: 80 }} />
          </div>

          {/* Parts list */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Parts in this assembly</div>
            {editing.assembly_parts.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--hint)', marginBottom: 8, padding: '10px 0' }}>No parts yet — search below to add</div>
            )}
            {editing.assembly_parts.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 6 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.parts_catalog?.name || p.part_id}</div>
                  <div style={{ fontSize: 10, color: 'var(--hint)' }}>{p.part_id}</div>
                </div>
                <input type="number" value={p.default_qty} min="1" onChange={e => updatePart(i, 'default_qty', parseFloat(e.target.value) || 1)}
                  style={{ width: 52, padding: '4px 6px', border: '1px solid var(--border2)', borderRadius: 6, fontSize: 13, fontWeight: 700, textAlign: 'center', background: 'var(--bg)', color: 'var(--orange)' }} />
                <select value={p.unit || 'ea'} onChange={e => updatePart(i, 'unit', e.target.value)}
                  style={{ padding: '4px 6px', border: '1px solid var(--border2)', borderRadius: 6, fontSize: 12, background: 'var(--bg)', color: 'var(--text)' }}>
                  <option value="ea">ea</option>
                  <option value="ft">ft</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={p.per_ft || false} onChange={e => updatePart(i, 'per_ft', e.target.checked)} />
                  /ft
                </label>
                <button onClick={() => removePart(i)} style={{ background: 'var(--red-lt)', border: 'none', borderRadius: 'var(--r-xs)', padding: '4px 8px', cursor: 'pointer', color: 'var(--red)', fontSize: 13 }}>✕</button>
              </div>
            ))}
          </div>

          {/* Part search */}
          <div style={{ marginBottom: 20 }}>
            <input type="text" placeholder="🔍 Search parts catalog to add..." value={partSearch}
              onChange={e => searchParts(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', border: '1.5px solid var(--teal)', borderRadius: 'var(--r-sm)', fontSize: 13, background: 'var(--bg)', color: 'var(--text)' }} />
            {partResults.map(p => (
              <div key={p.id} onClick={() => addPart(p)}
                style={{ padding: '10px 12px', background: 'var(--surface)', borderRadius: 6, marginTop: 4, cursor: 'pointer', border: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'var(--hint)' }}>{p.id} · {p.unit || 'ea'}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save assembly'}
          </button>
        </div>
      </div>
    )
  }

  // ── Assembly list ──────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Assembly Editor</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{assemblies.length} assemblies total</div>
          </div>
          <button onClick={startNew} className="btn btn-primary" style={{ height: 34, padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={15} /> New
          </button>
        </div>

        {/* Crew-type picker — was 6 pills (wrapped to 2 rows on phone);
            now a single dropdown to save a row. Includes counts so empty
            crew types still read as "build me" prompts. */}
        <div style={{ marginBottom: 12 }}>
          <select
            value={selTab}
            onChange={e => setSelTab(e.target.value)}
            style={{
              padding: '7px 12px', fontSize: 13, fontWeight: 600,
              border: '1px solid var(--border2)', borderRadius: 999,
              background: 'var(--surface)', color: 'var(--text)',
              cursor: 'pointer', minWidth: 220,
            }}
          >
            {CREW_TYPES.map(ct => {
              const count = countsByCrew[ct.id] || 0
              return (
                <option key={ct.id} value={ct.id}>
                  {ct.icon} {ct.label} ({count})
                </option>
              )
            })}
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>}
        {!loading && tabAsms.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8, color: 'var(--gray-mid)' }}><Icon name="nut" size={30} /></div>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>No {(CREW_TYPES.find(ct => ct.id === selTab) || {}).label || selTab} assemblies yet</div>
            {selTab === 'infrastructure' ? (
              <div style={{ fontSize: 12, maxWidth: 360, margin: '0 auto', lineHeight: 1.5 }}>
                Author kits infra crew taps when logging site work — tower install, antenna swap, UPS replace, business install. Pull parts from the <strong>Network Infrastructure</strong> + <strong>Infrastructure Construction</strong> departments in the catalog. Click <strong>+ New</strong> to build one.
              </div>
            ) : selTab === 'install' ? (
              <div style={{ fontSize: 12, maxWidth: 360, margin: '0 auto', lineHeight: 1.5 }}>
                Parts in Install assemblies show up as <strong>Common items</strong> at the top of an installer's My Stock — one tap loads the part onto their truck. Build one kit (or several) of the parts installers grab every day. Installers don't log passdowns here, so there are no behavior flags.
              </div>
            ) : (
              <div style={{ fontSize: 12 }}>Click <strong>+ New</strong> to add one, or duplicate an existing assembly from another tab.</div>
            )}
          </div>
        )}
        {/* Install assemblies double as the installers' Common-items strip
            (MyStockView) — say so where the owner edits them. */}
        {!loading && selTab === 'install' && tabAsms.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '0 2px 10px', lineHeight: 1.5 }}>
            Parts listed here appear as <strong>Common items</strong> on installers' My Stock (tap-to-load). Order follows the assembly + part order below; duplicates across kits collapse to one chip.
          </div>
        )}
        {tabAsms.map(asm => (
          <div key={asm.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{asm.label}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {asm.sub_label && `${asm.sub_label} · `}
                <span className="mono">{(asm.assembly_parts || []).length}</span> parts
                {!asm.is_active && <span style={{ marginLeft: 8, color: 'var(--hint)' }}>· hidden</span>}
              </div>
            </div>
            <button onClick={() => startEdit(asm)} style={asmChip()}>Edit</button>
            <button onClick={() => startDuplicate(asm)}
              title="Duplicate to a new assembly (e.g. clone for a different crew type)"
              style={asmChip()}>
              <Icon name="layers" size={13} /> Copy
            </button>
            <button onClick={() => setConfirm(asm)} title="Delete assembly"
              style={{ ...asmChip(), color: 'var(--red)' }}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>

      {confirm && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirm(null)}>
          <div className="overlay-sheet">
            <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 8, color: 'var(--red)', display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="alert" size={16} /> Delete assembly?</div>
            <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 20 }}>"{confirm.label}" will be permanently removed. Historical log entries are unaffected.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Cancel</button>
              <button onClick={() => handleDelete(confirm)} style={{ flex: 2, padding: '13px', background: 'var(--red)', color: 'white', border: 'none', borderRadius: 'var(--r-sm)', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
