import { useEffect, useState, useCallback, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  getPartAttributeDefs,
  createPartAttributeDef,
  updatePartAttributeDef,
  deletePartAttributeDef,
  countPartsWithAttribute,
  purgePartAttribute,
} from '../../lib/inventory'
import { getActivePartDepartments } from '../../lib/admin'
import {
  ATTRIBUTE_INPUT_TYPES,
  attrKeyFromLabel,
  isValidAttrKey,
} from '../../lib/partAttributes'
import { useBackClose } from '../../lib/backStack'
import { chipStyle, cardSurface, LoadingBlock, EmptyState } from './chrome'
import Icon from '../shared/Icon'

// Admin → Part attributes. The owner defines an attribute once here and every
// part-editing surface renders it as a labeled, typed field, so the same
// question gets asked of every part instead of each one growing its own
// free-form keys.
//
// The key is generated from the label on create and is immutable afterwards
// (trg_pad_key_immutable) — it's what every stored value on every part is
// keyed by. The form makes that visible rather than hiding it.
export default function PartAttributesView({ onBack }) {
  const { showToast, currentUser } = useApp()
  const [defs, setDefs] = useState([])
  const [departments, setDepartments] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)   // def object, or {} for new
  const [deleting, setDeleting] = useState(null) // { def, count }
  const [busy, setBusy] = useState(false)

  // NOTE: no useBackClose here for the two overlays. Both register their own
  // layer internally (they're mounted only while open), and the form sheet's
  // is the one carrying the discard confirm. Registering here as well would
  // sum to depth 2 per overlay and — because the parent layer activates after
  // the child mounts — put the parent on top, so Back would fire the plain
  // close and skip the "Discard changes?" prompt entirely.

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [rows, depts] = await Promise.all([
        getPartAttributeDefs(),
        getActivePartDepartments(),
      ])
      setDefs(rows)
      setDepartments(depts.map(d => d.department))
    } catch (e) {
      console.error('Load attribute defs failed:', e)
      showToast('Could not load attributes: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => { load() }, [load])

  const existingKeys = useMemo(() => new Set(defs.map(d => d.key)), [defs])

  async function handleSave(form) {
    setBusy(true)
    try {
      if (form.id) {
        await updatePartAttributeDef(form.id, {
          label: form.label,
          input_type: form.input_type,
          options: form.options,
          required: form.required,
          applies_to_departments: form.applies_to_departments,
          help_text: form.help_text,
          show_on_label: form.show_on_label,
          is_active: form.is_active,
        }, currentUser?.id)
        showToast('Attribute updated')
      } else {
        await createPartAttributeDef({
          ...form,
          sort_order: defs.length > 0 ? Math.max(...defs.map(d => d.sort_order || 0)) + 1 : 0,
        }, currentUser?.id)
        showToast(`Added "${form.label}"`)
      }
      setEditing(null)
      await load()
    } catch (e) {
      console.error('Save attribute failed:', e)
      if (e?.code === '23505') showToast('An attribute with that key already exists')
      else showToast('Save failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  // Ask how many parts hold a value before offering the delete, so the choice
  // between "keep the values" and "clear them" is made with the number in view.
  async function openDelete(def) {
    try {
      const count = await countPartsWithAttribute(def.key)
      setDeleting({ def, count })
    } catch (e) {
      // A count failure shouldn't block the delete — just don't pretend to know.
      console.warn('Attribute value count failed:', e)
      setDeleting({ def, count: null })
    }
  }

  async function handleDelete(alsoPurge) {
    const { def } = deleting
    setBusy(true)
    try {
      if (alsoPurge) {
        const n = await purgePartAttribute(def.key)
        showToast(`Cleared ${def.label} from ${n} part${n === 1 ? '' : 's'}`)
      }
      await deletePartAttributeDef(def.id)
      setDeleting(null)
      await load()
      if (!alsoPurge) showToast(`Deleted "${def.label}" — stored values kept`)
    } catch (e) {
      showToast('Delete failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  // Reorder by rewriting the whole list's sort_order from its new positions,
  // rather than swapping two values. Swapping is a no-op whenever the two rows
  // already share a sort_order (they all start at 0 if seeded by SQL), and a
  // failure between the two writes leaves duplicates behind. Renumbering is
  // idempotent and self-healing: whatever the list looks like on screen is
  // what gets written.
  async function move(def, dir) {
    const ordered = [...defs]
    const i = ordered.findIndex(d => d.id === def.id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ordered.length) return
    const [moved] = ordered.splice(i, 1)
    ordered.splice(j, 0, moved)
    setBusy(true)
    try {
      for (let k = 0; k < ordered.length; k++) {
        if ((ordered[k].sort_order ?? -1) === k) continue   // already correct
        await updatePartAttributeDef(ordered[k].id, { sort_order: k }, currentUser?.id)
      }
      await load()
    } catch (e) {
      showToast('Reorder failed: ' + e.message)
      await load()   // show what actually landed
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(def) {
    setBusy(true)
    try {
      await updatePartAttributeDef(def.id, { is_active: !def.is_active }, currentUser?.id)
      await load()
      showToast(def.is_active ? `Retired "${def.label}"` : `Restored "${def.label}"`)
    } catch (e) {
      showToast('Update failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '16px 20px', flexShrink: 0,
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onBack}
            style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >←</button>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Part attributes</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Standard fields every part is asked for
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{
          ...cardSurface, padding: '10px 12px', marginBottom: 12,
          fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
        }}>
          An attribute defined here shows up as a labeled field on every part —
          in the Parts tab and when Receive PO creates a new one. Use a
          <strong> pick list</strong> when the values must match exactly across
          parts. Scope one to a department when it only makes sense there.
        </div>

        {loading ? (
          <LoadingBlock label="Loading attributes…" />
        ) : defs.length === 0 ? (
          <EmptyState>
            No part attributes defined yet. Add one to start standardizing the catalog.
          </EmptyState>
        ) : (
          <div style={{ ...cardSurface, overflow: 'hidden', marginBottom: 12 }}>
            {defs.map((d, i) => (
              <div key={d.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px',
                borderBottom: i < defs.length - 1 ? '1px solid var(--border)' : 'none',
                opacity: d.is_active ? 1 : 0.55,
                flexWrap: 'wrap',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                  <button onClick={() => move(d, -1)} disabled={i === 0 || busy}
                    title="Move up"
                    style={arrowStyle(i === 0 || busy)}>▲</button>
                  <button onClick={() => move(d, 1)} disabled={i === defs.length - 1 || busy}
                    title="Move down"
                    style={arrowStyle(i === defs.length - 1 || busy)}>▼</button>
                </div>

                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {d.label}
                    {d.required && (
                      <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 'var(--r-xs)', padding: '0 5px' }}>
                        REQUIRED
                      </span>
                    )}
                    {!d.is_active && (
                      <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--muted)', border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)', padding: '0 5px' }}>
                        RETIRED
                      </span>
                    )}
                    {d.show_on_label && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)' }} title="Printed on the SKU label">
                        <Icon name="printer" size={11} style={{ verticalAlign: '-2px' }} />
                      </span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>
                    {d.key} · {ATTRIBUTE_INPUT_TYPES.find(t => t.id === d.input_type)?.label || d.input_type}
                    {d.input_type === 'select' && (d.options || []).length > 0 && (
                      <span> ({(d.options || []).length} options)</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {(d.applies_to_departments || []).length === 0
                      ? 'All parts'
                      : `Only: ${(d.applies_to_departments || []).join(', ')}`}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => setEditing(d)} style={chipStyle(false)} disabled={busy}>
                    <Icon name="edit" size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />Edit
                  </button>
                  <button onClick={() => toggleActive(d)} style={chipStyle(false)} disabled={busy}
                    title={d.is_active ? 'Hide from part forms, keep stored values' : 'Show on part forms again'}>
                    {d.is_active ? 'Retire' : 'Restore'}
                  </button>
                  <button onClick={() => openDelete(d)} style={chipStyle(false, { color: 'red' })} disabled={busy}>
                    <Icon name="trash" size={12} style={{ verticalAlign: '-2px' }} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && (
          <button onClick={() => setEditing({})} className="add-dashed"
            style={{ padding: 12, fontSize: 13, width: '100%' }}>
            + Add attribute
          </button>
        )}
      </div>

      {editing && (
        <AttributeFormSheet
          // Every field seeds from `def` in a useState initializer, so the
          // sheet has to remount if the target ever swaps without closing.
          key={editing.id ?? 'new'}
          def={editing}
          departments={departments}
          existingKeys={existingKeys}
          saving={busy}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      )}

      {deleting && (
        <DeleteAttributeSheet
          def={deleting.def}
          count={deleting.count}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}

function arrowStyle(disabled) {
  return {
    background: 'none', border: 'none', padding: 0, lineHeight: 1,
    fontSize: 9, color: disabled ? 'var(--border2)' : 'var(--muted)',
    cursor: disabled ? 'default' : 'pointer',
  }
}

// ─── Add / edit sheet ───────────────────────────────────────────────────────

function AttributeFormSheet({ def, departments, existingKeys, saving, onCancel, onSave }) {
  const isNew = !def.id
  const [label, setLabel] = useState(def.label || '')
  // Key is derived from the label until the user overrides it, and is frozen
  // entirely once the attribute exists — every stored value is keyed by it.
  const [keyTouched, setKeyTouched] = useState(!isNew)
  const [key, setKey] = useState(def.key || '')
  const [inputType, setInputType] = useState(def.input_type || 'text')
  const [optionsText, setOptionsText] = useState((def.options || []).join('\n'))
  const [required, setRequired] = useState(!!def.required)
  const [depts, setDepts] = useState(() => new Set(def.applies_to_departments || []))
  const [helpText, setHelpText] = useState(def.help_text || '')
  const [showOnLabel, setShowOnLabel] = useState(!!def.show_on_label)
  const [isActive, setIsActive] = useState(def.is_active !== false)

  // Back confirms only when something was actually typed — a Back press on an
  // untouched form should just close it.
  const dirty = useMemo(() => (
    label !== (def.label || '')
    || inputType !== (def.input_type || 'text')
    || optionsText !== (def.options || []).join('\n')
    || required !== !!def.required
    || helpText !== (def.help_text || '')
    || showOnLabel !== !!def.show_on_label
    || isActive !== (def.is_active !== false)
    || [...depts].sort().join('|') !== [...(def.applies_to_departments || [])].sort().join('|')
  ), [def, label, inputType, optionsText, required, helpText, showOnLabel, isActive, depts])

  useBackClose(1, onCancel, {
    confirm: () => !dirty || window.confirm('Discard changes to this attribute?'),
  })

  function handleLabelChange(v) {
    setLabel(v)
    if (!keyTouched) setKey(attrKeyFromLabel(v))
  }

  const options = useMemo(
    () => optionsText.split('\n').map(s => s.trim()).filter(Boolean),
    [optionsText]
  )

  const keyError = useMemo(() => {
    if (!isNew) return ''
    if (!key) return 'Enter a label to generate a key'
    if (!isValidAttrKey(key)) return 'Lowercase letters, digits and underscores; must start with a letter'
    if (existingKeys.has(key)) return 'That key is already used by another attribute'
    return ''
  }, [key, isNew, existingKeys])

  const canSave = label.trim() && !keyError
    && (inputType !== 'select' || options.length > 0)

  function toggleDept(d) {
    setDepts(prev => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d); else next.add(d)
      return next
    })
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            {isNew ? 'Add part attribute' : `Edit ${def.label}`}
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div className="field">
            <label>Label</label>
            <input
              type="text" value={label}
              onChange={e => handleLabelChange(e.target.value)}
              placeholder="e.g. Manufacturer"
              autoComplete="off" name="attr-def-label"
            />
          </div>

          <div className="field">
            <label>
              Storage key{' '}
              <span style={{ fontWeight: 400, color: 'var(--hint)' }}>
                {isNew ? '— generated from the label' : '— permanent'}
              </span>
            </label>
            <input
              type="text" value={key}
              onChange={e => { setKeyTouched(true); setKey(e.target.value.toLowerCase()) }}
              disabled={!isNew}
              autoComplete="off" name="attr-def-key"
              className="mono"
              style={{ opacity: isNew ? 1 : 0.6 }}
            />
            <div style={{ fontSize: 11, color: keyError ? 'var(--red)' : 'var(--hint)', marginTop: 4 }}>
              {keyError || (isNew
                ? 'Every part stores its answer under this key. It cannot be changed later.'
                : 'Fixed — every part\'s stored value is keyed by it. Rename the label instead.')}
            </div>
          </div>

          <div className="field">
            <label>Type</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ATTRIBUTE_INPUT_TYPES.map(t => (
                <button key={t.id} type="button" onClick={() => setInputType(t.id)}
                  style={chipStyle(inputType === t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 5 }}>
              {ATTRIBUTE_INPUT_TYPES.find(t => t.id === inputType)?.desc}
            </div>
          </div>

          {inputType === 'select' && (
            <div className="field">
              <label>Options <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— one per line</span></label>
              <textarea
                value={optionsText}
                onChange={e => setOptionsText(e.target.value)}
                rows={5}
                placeholder={'Corning\nCommScope\nAFL'}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit',
                  border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
                  background: 'var(--bg)', color: 'var(--text)', resize: 'vertical',
                }}
              />
              <div style={{ fontSize: 11, color: options.length === 0 ? 'var(--red)' : 'var(--hint)', marginTop: 4 }}>
                {options.length === 0
                  ? 'A pick list needs at least one option'
                  : `${options.length} option${options.length === 1 ? '' : 's'}. Removing one later does not change parts already using it.`}
              </div>
            </div>
          )}

          <div className="field">
            <label>Applies to <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— optional</span></label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setDepts(new Set())}
                style={chipStyle(depts.size === 0)}>
                All parts
              </button>
              {departments.map(d => (
                <button key={d} type="button" onClick={() => toggleDept(d)}
                  style={chipStyle(depts.has(d))}>
                  {d}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 5 }}>
              {depts.size === 0
                ? 'Shown on every part.'
                : 'Shown only on parts in those departments. Parts with no department are not included.'}
            </div>
          </div>

          <div className="field">
            <label>Hint <span style={{ fontWeight: 400, color: 'var(--hint)' }}>— optional</span></label>
            <input
              type="text" value={helpText}
              onChange={e => setHelpText(e.target.value)}
              placeholder="Shown under the field, e.g. As printed on the reel tag"
              autoComplete="off" name="attr-def-hint"
            />
          </div>

          <ToggleRow
            checked={required} onChange={setRequired}
            title="Required"
            desc="Parts missing it are listed under a Missing info filter in the Parts tab, and the edit form won't save without it."
          />
          <ToggleRow
            checked={showOnLabel} onChange={setShowOnLabel}
            title="Print on SKU label"
            desc="Adds the value as an extra line on the part's printed QR label."
          />
          {!isNew && (
            <ToggleRow
              checked={isActive} onChange={setIsActive}
              title="Active"
              desc="Turning this off hides the field from part forms. Values already stored are kept."
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            className="btn btn-primary" style={{ flex: 2 }}
            disabled={!canSave || saving}
            onClick={() => onSave({
              id: def.id,
              key,
              label: label.trim(),
              input_type: inputType,
              options: inputType === 'select' ? options : [],
              required,
              applies_to_departments: [...depts],
              help_text: helpText.trim() || null,
              show_on_label: showOnLabel,
              is_active: isActive,
            })}
          >
            {saving ? 'Saving…' : isNew ? 'Add attribute' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ToggleRow({ checked, onChange, title, desc }) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8,
      padding: '10px 12px', borderRadius: 'var(--r-sm)',
      border: '1.5px solid var(--border2)', cursor: 'pointer',
    }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        style={{ marginTop: 2, cursor: 'pointer' }} />
      <div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{desc}</div>
      </div>
    </label>
  )
}

// ─── Delete confirm ─────────────────────────────────────────────────────────

function DeleteAttributeSheet({ def, count, busy, onCancel, onDelete }) {
  const [purge, setPurge] = useState(false)
  useBackClose(1, onCancel)

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 460 }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 8, color: 'var(--red)' }}>
          <Icon name="alert" size={17} style={{ verticalAlign: '-2px', marginRight: 8 }} />
          Delete “{def.label}”?
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 12 }}>
          {count === null
            ? 'Some parts may already hold a value for this attribute.'
            : count === 0
              ? 'No part holds a value for it yet.'
              : `${count} part${count === 1 ? '' : 's'} already hold a value for it.`}
          {' '}The field stops appearing on part forms either way.
          {count !== 0 && ' Stored values are kept unless you clear them below, and they show under “Other attributes” on the part.'}
        </div>

        {count !== 0 && (
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 12,
            padding: '10px 12px', borderRadius: 'var(--r-sm)',
            border: `1.5px solid ${purge ? 'var(--red)' : 'var(--border2)'}`,
            background: purge ? 'var(--red-lt)' : 'transparent', cursor: 'pointer',
          }}>
            <input type="checkbox" checked={purge} onChange={e => setPurge(e.target.checked)}
              style={{ marginTop: 2, cursor: 'pointer' }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Also clear the stored values</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                Removes this attribute from every part that has it. Cannot be undone.
              </div>
            </div>
          </label>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn" style={{ flex: 2, background: 'var(--red)', color: '#fff' }}
            disabled={busy}
            onClick={() => onDelete(purge)}
          >
            {busy ? 'Deleting…' : purge ? 'Delete and clear values' : 'Delete definition'}
          </button>
        </div>
      </div>
    </div>
  )
}
