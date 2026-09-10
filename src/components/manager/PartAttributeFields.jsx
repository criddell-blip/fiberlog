import { useMemo } from 'react'
import {
  defsForPart,
  attrValueToInput,
  validateAttrValues,
} from '../../lib/partAttributes'
import Icon from '../shared/Icon'

// Renders the owner-defined attribute fields for one part.
//
// The single place a part attribute is drawn — the Parts tab edit sheet and
// Receive PO's inline create/edit panel both mount this, so a field added in
// Admin appears on every path that mints or edits a part without either file
// knowing what the attributes are.
//
// Controlled: `values` is a { [key]: rawInputValue } map owned by the parent
// (raw, not coerced — coercion happens once at save via mergeAttributes).
// `part` supplies the department the scoping reads, so passing the DRAFT
// department (what the form currently shows, not what's stored) makes the
// field list follow a department change live.
export default function PartAttributeFields({
  defs,
  part,
  values,
  onChange,
  showErrors = false,
  compact = false,
  emptyHint = true,
}) {
  const scoped = useMemo(() => defsForPart(defs, part), [defs, part])
  const errors = useMemo(
    () => (showErrors ? validateAttrValues(defs, part, values) : []),
    [defs, part, values, showErrors]
  )
  const errorByKey = useMemo(() => {
    const m = new Map()
    for (const e of errors) m.set(e.key, e.message)
    return m
  }, [errors])

  if (scoped.length === 0) {
    if (!emptyHint) return null
    return (
      <div style={{ fontSize: 11, color: 'var(--hint)' }}>
        No standard attributes apply to this part.{' '}
        {(defs || []).length === 0
          ? 'Define them in Admin → Part attributes so every part answers the same questions.'
          : 'The ones that exist are scoped to other departments.'}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10 }}>
      {scoped.map(def => {
        const raw = attrValueToInput(def, values?.[def.key])
        const err = errorByKey.get(def.key)
        const inputStyle = {
          width: '100%',
          padding: compact ? '6px 10px' : '8px 10px',
          fontSize: compact ? 12 : 14,
          border: `1.5px solid ${err ? 'var(--red)' : 'var(--border2)'}`,
          borderRadius: 'var(--r-sm)',
          background: 'var(--bg)',
          color: 'var(--text)',
        }
        return (
          <div key={def.key}>
            <label style={{
              display: 'block', fontSize: compact ? 11 : 12, fontWeight: 700,
              marginBottom: 4, color: 'var(--muted)',
            }}>
              {def.label}
              {def.required && <span style={{ color: 'var(--red)', marginLeft: 3 }}>*</span>}
            </label>

            {def.input_type === 'boolean' ? (
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                fontSize: compact ? 12 : 13,
              }}>
                <input
                  type="checkbox"
                  checked={raw === true}
                  onChange={e => onChange(def.key, e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                <span>{raw === true ? 'Yes' : 'No'}</span>
              </label>
            ) : def.input_type === 'select' ? (
              <select
                value={raw}
                onChange={e => onChange(def.key, e.target.value)}
                style={inputStyle}
              >
                <option value="">— none —</option>
                {(def.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                {/* A value stored before an option was renamed/removed would
                    otherwise silently reset to "none" on the next save. */}
                {raw && !(def.options || []).includes(raw) && (
                  <option value={raw}>{raw} (not in list)</option>
                )}
              </select>
            ) : (
              <input
                type={def.input_type === 'number' ? 'number' : 'text'}
                value={raw}
                onChange={e => onChange(def.key, e.target.value)}
                placeholder={def.help_text || ''}
                autoComplete="off"
                name={`part-attr-${def.key}`}
                style={inputStyle}
              />
            )}

            {err ? (
              <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Icon name="alert" size={11} /> {err}
              </div>
            ) : def.help_text && def.input_type !== 'text' ? (
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 3 }}>{def.help_text}</div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
