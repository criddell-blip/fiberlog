// Global part attributes — the pure logic behind the owner-defined registry
// in `part_attribute_defs`.
//
// The registry answers "which fields does THIS part have, and what counts as a
// valid value". Everything in here is pure so the rules stay testable and stay
// identical across the three surfaces that write attributes (Parts tab edit,
// Parts tab bulk fill, Receive PO inline create/edit).
//
// Storage: values live in parts_catalog.attributes, a JSONB bag keyed by
// def.key. Typed per def — text/select store strings, number stores a JSON
// number, boolean stores a JSON boolean — so a CSV round-trip and a numeric
// comparison both behave. The bag ALSO holds the system creation stamp
// (created_via, an object), which is why merging is a merge and never a
// replace: the old free-form editor replaced the whole bag and flattened that
// stamp to the string "[object Object]" on three live parts.

// Keys the system owns. A def may not claim one, the editors never show one,
// and a merge always carries one through untouched.
export const RESERVED_ATTRIBUTE_KEYS = ['created_via']

export function isReservedAttrKey(key) {
  return RESERVED_ATTRIBUTE_KEYS.includes(key)
}

// The four input types. Adding one means a case here, a case in the field
// renderer, and nothing else — the storage is untyped JSON underneath.
export const ATTRIBUTE_INPUT_TYPES = [
  { id: 'text',    label: 'Text',      desc: 'Free text — a manufacturer name, a part number.' },
  { id: 'number',  label: 'Number',    desc: 'Numeric only. Sorts and compares as a number.' },
  { id: 'boolean', label: 'Yes / no',  desc: 'A checkbox. Stored as true / false.' },
  { id: 'select',  label: 'Pick list', desc: 'One of a fixed set of options. Use this when you want the values to match exactly.' },
]

export const MAX_ATTR_KEY_LENGTH = 40

// Label -> storage key. Lowercase snake, leading letter, trimmed to length.
// Mirrors the DB CHECK so a suggestion the UI shows is always accepted.
export function attrKeyFromLabel(label) {
  const base = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!base) return ''
  // A key must start with a letter; a label like "3M tape" would otherwise
  // produce "3m_tape" and be rejected by the CHECK.
  const withLetter = /^[a-z]/.test(base) ? base : `a_${base}`
  return withLetter.slice(0, MAX_ATTR_KEY_LENGTH).replace(/_+$/, '')
}

export function isValidAttrKey(key) {
  return typeof key === 'string'
    && new RegExp(`^[a-z][a-z0-9_]{0,${MAX_ATTR_KEY_LENGTH - 1}}$`).test(key)
    && !isReservedAttrKey(key)
}

// ─── Scoping ────────────────────────────────────────────────────────────────

// Empty applies_to_departments = every part. Otherwise the part's department
// must be listed. A part with NO department is deliberately OUT of scope for a
// department-scoped attribute (we can't claim a router needs a fiber count
// when we don't know it's a router) but IS in scope for a global one.
export function defAppliesToPart(def, part) {
  if (!def) return false
  const depts = def.applies_to_departments || []
  if (depts.length === 0) return true
  return !!part?.department && depts.includes(part.department)
}

// The ordered list of attribute fields to render for one part. Retired defs
// (is_active = false) drop out of the forms but their stored values survive.
export function defsForPart(defs, part) {
  return (defs || [])
    .filter(d => d.is_active !== false)
    .filter(d => defAppliesToPart(d, part))
    .sort(compareDefs)
}

export function compareDefs(a, b) {
  const sa = Number(a.sort_order || 0)
  const sb = Number(b.sort_order || 0)
  if (sa !== sb) return sa - sb
  return String(a.label || '').localeCompare(String(b.label || ''))
}

// ─── Values ─────────────────────────────────────────────────────────────────

// A form field always edits a string; this turns that string into what gets
// stored. Returns undefined for "no value" so the caller can drop the key
// rather than store an empty string that reads as a real answer.
export function coerceAttrValue(def, raw) {
  const type = def?.input_type || 'text'
  if (type === 'boolean') {
    // A boolean field is never "empty" — an unchecked box is a real "no".
    if (raw === true || raw === 'true') return true
    if (raw === false || raw === 'false') return false
    return undefined
  }
  const s = raw == null ? '' : String(raw).trim()
  if (s === '') return undefined
  if (type === 'number') {
    const n = Number(s)
    return Number.isFinite(n) ? n : undefined
  }
  return s
}

// Stored value -> the string a form field shows.
export function attrValueToInput(def, value) {
  if (value == null) return def?.input_type === 'boolean' ? false : ''
  if (def?.input_type === 'boolean') return value === true || value === 'true'
  return String(value)
}

// Stored value -> display / CSV text.
export function formatAttrValue(def, value) {
  if (value == null) return ''
  if (def?.input_type === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No'
  if (typeof value === 'object') return ''   // never render the created_via stamp as a value
  return String(value)
}

export function hasAttrValue(value) {
  if (value == null) return false
  if (value === false) return true      // an explicit "no" is an answer
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

// ─── Validation ─────────────────────────────────────────────────────────────

// Returns [{ key, label, message }]. Empty array = the form can save.
// Only checks defs in scope for this part — a required attribute scoped to
// Fiber can't block saving a router.
export function validateAttrValues(defs, part, values) {
  const errors = []
  for (const def of defsForPart(defs, part)) {
    const raw = values?.[def.key]
    const coerced = coerceAttrValue(def, raw)
    const present = coerced !== undefined

    if (!present) {
      if (def.required) {
        errors.push({ key: def.key, label: def.label, message: `${def.label} is required` })
      }
      continue
    }
    if (def.input_type === 'number' && !Number.isFinite(Number(coerced))) {
      errors.push({ key: def.key, label: def.label, message: `${def.label} must be a number` })
    }
    if (def.input_type === 'select') {
      const opts = def.options || []
      if (!opts.includes(String(coerced))) {
        errors.push({ key: def.key, label: def.label, message: `${def.label} must be one of: ${opts.join(', ')}` })
      }
    }
  }
  return errors
}

// ─── Merging ────────────────────────────────────────────────────────────────

// Build the attributes bag to save. Starts from what's already stored so
// nothing outside the form's reach is lost:
//   * reserved keys (created_via) always survive verbatim
//   * legacy keys with no def survive unless `legacyValues` explicitly rewrites
//     them (that's the "Other attributes" section of the editor)
//   * a key present in `values` with no value is REMOVED, so clearing a field
//     clears it rather than storing ""
//   * a key ABSENT from `values` is left alone. `values` only ever carries the
//     defs the form actually rendered, so an attribute scoped to a department
//     this part isn't in keeps its stored answer instead of being deleted by a
//     save that never showed it.
export function mergeAttributes(existing, defs, values, legacyValues) {
  const out = {}
  const src = existing && typeof existing === 'object' ? existing : {}
  for (const [k, v] of Object.entries(src)) out[k] = v

  if (legacyValues) {
    // Replace the whole legacy section: any legacy key the editor dropped is
    // meant to be gone. Reserved keys are re-applied after this loop.
    const defKeys = new Set((defs || []).map(d => d.key))
    for (const k of Object.keys(out)) {
      if (defKeys.has(k) || isReservedAttrKey(k)) continue
      delete out[k]
    }
    for (const [k, v] of Object.entries(legacyValues)) {
      const key = String(k || '').trim()
      if (!key || isReservedAttrKey(key)) continue
      out[key] = v
    }
  }

  for (const [key, raw] of Object.entries(values || {})) {
    if (isReservedAttrKey(key)) continue
    const def = (defs || []).find(d => d.key === key)
    const coerced = coerceAttrValue(def, raw)
    if (coerced === undefined) delete out[key]
    else out[key] = coerced
  }

  // Reserved keys are never editable and never lost.
  for (const rk of RESERVED_ATTRIBUTE_KEYS) {
    if (rk in src) out[rk] = src[rk]
  }
  return out
}

// The keys stored on a part that no active def explains — shown as
// "Other attributes" so nothing becomes invisible when a def is retired.
export function legacyAttrEntries(attributes, defs) {
  const defKeys = new Set((defs || []).map(d => d.key))
  const src = attributes && typeof attributes === 'object' ? attributes : {}
  return Object.entries(src)
    .filter(([k, v]) => !defKeys.has(k) && !isReservedAttrKey(k) && typeof v !== 'object')
    .map(([key, value]) => ({ key, value: value == null ? '' : String(value) }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

// ─── Completeness ───────────────────────────────────────────────────────────

// Required-but-empty attributes for one part. Drives the Parts tab's
// "Missing info" work-down chip and the per-row badge.
export function missingRequiredDefs(defs, part) {
  const attrs = part?.attributes && typeof part.attributes === 'object' ? part.attributes : {}
  return defsForPart(defs, part).filter(d => d.required && !hasAttrValue(attrs[d.key]))
}

export function partIsMissingRequired(defs, part) {
  return missingRequiredDefs(defs, part).length > 0
}

// CSV columns for the catalog export: one per active def, stable order,
// header = label so accounting reads words rather than snake_case.
export function attributeCsvColumns(defs) {
  return (defs || [])
    .filter(d => d.is_active !== false)
    .sort(compareDefs)
    .map(d => ({ key: d.key, header: d.label, def: d }))
}
