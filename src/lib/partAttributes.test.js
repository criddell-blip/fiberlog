import { describe, it, expect } from 'vitest'
import {
  attrKeyFromLabel,
  isValidAttrKey,
  defAppliesToPart,
  defsForPart,
  coerceAttrValue,
  attrValueToInput,
  formatAttrValue,
  hasAttrValue,
  validateAttrValues,
  mergeAttributes,
  legacyAttrEntries,
  missingRequiredDefs,
  partIsMissingRequired,
  attributeCsvColumns,
  RESERVED_ATTRIBUTE_KEYS,
} from './partAttributes'

// A def with sane defaults so each test states only what it cares about.
const def = (over = {}) => ({
  key: 'manufacturer',
  label: 'Manufacturer',
  input_type: 'text',
  options: [],
  required: false,
  applies_to_departments: [],
  is_active: true,
  sort_order: 0,
  ...over,
})

describe('attrKeyFromLabel', () => {
  it('snake-cases a label', () => {
    expect(attrKeyFromLabel('Mfr part number')).toBe('mfr_part_number')
    expect(attrKeyFromLabel('  Fiber Count  ')).toBe('fiber_count')
  })

  it('prefixes a label that would start with a digit', () => {
    // The DB CHECK requires a leading letter, so "3M tape" must not suggest
    // a key the insert will reject.
    expect(isValidAttrKey(attrKeyFromLabel('3M tape'))).toBe(true)
  })

  it('produces a key the DB CHECK accepts, or nothing at all', () => {
    for (const label of ['Manufacturer', 'Voltage (V)', '___', '!!!', 'a'.repeat(80)]) {
      const key = attrKeyFromLabel(label)
      if (key) expect(isValidAttrKey(key)).toBe(true)
    }
    expect(attrKeyFromLabel('!!!')).toBe('')
  })

  it('rejects the reserved system key', () => {
    expect(isValidAttrKey('created_via')).toBe(false)
    expect(RESERVED_ATTRIBUTE_KEYS).toContain('created_via')
  })
})

describe('scoping', () => {
  it('applies a def with no departments to every part', () => {
    expect(defAppliesToPart(def(), { department: 'Fiber' })).toBe(true)
    expect(defAppliesToPart(def(), { department: null })).toBe(true)
  })

  it('applies a scoped def only inside its departments', () => {
    const d = def({ applies_to_departments: ['Fiber'] })
    expect(defAppliesToPart(d, { department: 'Fiber' })).toBe(true)
    expect(defAppliesToPart(d, { department: 'CPE' })).toBe(false)
  })

  it('leaves a part with no department out of a scoped def', () => {
    const d = def({ applies_to_departments: ['Fiber'] })
    expect(defAppliesToPart(d, { department: null })).toBe(false)
  })

  it('hides retired defs from forms and sorts by sort_order then label', () => {
    const defs = [
      def({ key: 'b', label: 'Bravo', sort_order: 2 }),
      def({ key: 'a', label: 'Alpha', sort_order: 1 }),
      def({ key: 'z', label: 'Zulu', sort_order: 1 }),
      def({ key: 'r', label: 'Retired', is_active: false, sort_order: 0 }),
    ]
    expect(defsForPart(defs, { department: 'Fiber' }).map(d => d.key)).toEqual(['a', 'z', 'b'])
  })
})

describe('coerceAttrValue', () => {
  it('trims text and treats empty as no value', () => {
    expect(coerceAttrValue(def(), '  Corning ')).toBe('Corning')
    expect(coerceAttrValue(def(), '   ')).toBeUndefined()
  })

  it('stores a number as a number', () => {
    expect(coerceAttrValue(def({ input_type: 'number' }), '144')).toBe(144)
    expect(coerceAttrValue(def({ input_type: 'number' }), 'abc')).toBeUndefined()
  })

  it('treats an unchecked box as a real "no", not as empty', () => {
    const d = def({ input_type: 'boolean' })
    expect(coerceAttrValue(d, false)).toBe(false)
    expect(coerceAttrValue(d, 'false')).toBe(false)
    expect(coerceAttrValue(d, true)).toBe(true)
  })
})

describe('display helpers', () => {
  it('round-trips a value through the input form', () => {
    const d = def({ input_type: 'boolean' })
    expect(attrValueToInput(d, true)).toBe(true)
    expect(attrValueToInput(d, null)).toBe(false)
    expect(attrValueToInput(def(), null)).toBe('')
    expect(attrValueToInput(def({ input_type: 'number' }), 144)).toBe('144')
  })

  it('never renders an object value (the created_via stamp)', () => {
    expect(formatAttrValue(def(), { source: 'Receive PO' })).toBe('')
    expect(formatAttrValue(def({ input_type: 'boolean' }), false)).toBe('No')
  })

  it('counts false as an answer but blank text as missing', () => {
    expect(hasAttrValue(false)).toBe(true)
    expect(hasAttrValue(0)).toBe(true)
    expect(hasAttrValue('')).toBe(false)
    expect(hasAttrValue('  ')).toBe(false)
    expect(hasAttrValue(null)).toBe(false)
  })
})

describe('validateAttrValues', () => {
  const part = { department: 'Fiber' }

  it('passes when nothing is required', () => {
    expect(validateAttrValues([def()], part, {})).toEqual([])
  })

  it('flags a required attribute left blank', () => {
    const errs = validateAttrValues([def({ required: true })], part, { manufacturer: '' })
    expect(errs).toHaveLength(1)
    expect(errs[0].key).toBe('manufacturer')
  })

  it('does not let a required attribute out of scope block the save', () => {
    const d = def({ required: true, applies_to_departments: ['CPE'] })
    expect(validateAttrValues([d], part, {})).toEqual([])
  })

  it('rejects a select value that is not one of the options', () => {
    const d = def({ key: 'fiber_count', label: 'Fiber count', input_type: 'select', options: ['12', '144'] })
    expect(validateAttrValues([d], part, { fiber_count: '288' })).toHaveLength(1)
    expect(validateAttrValues([d], part, { fiber_count: '144' })).toEqual([])
  })

  it('rejects a non-numeric number', () => {
    const d = def({ key: 'voltage', label: 'Voltage', input_type: 'number', required: true })
    // 'abc' coerces to undefined, so it reads as missing rather than as a bad
    // number — either way the save is blocked, which is what matters.
    expect(validateAttrValues([d], part, { voltage: 'abc' })).toHaveLength(1)
    expect(validateAttrValues([d], part, { voltage: '48' })).toEqual([])
  })
})

describe('mergeAttributes', () => {
  const defs = [
    def({ key: 'manufacturer', label: 'Manufacturer' }),
    def({ key: 'fiber_count', label: 'Fiber count', input_type: 'number' }),
  ]

  it('carries the created_via stamp through untouched', () => {
    // The old free-form editor stringified this object to "[object Object]"
    // on three live parts. It must survive every save verbatim.
    const stamp = { source: 'Receive PO', by: 'Amber Von Almen' }
    const out = mergeAttributes({ created_via: stamp }, defs, { manufacturer: 'Corning' })
    expect(out.created_via).toEqual(stamp)
    expect(out.manufacturer).toBe('Corning')
  })

  it('refuses to let a form value overwrite a reserved key', () => {
    const stamp = { source: 'Sonar import' }
    const out = mergeAttributes({ created_via: stamp }, defs, { created_via: 'nonsense' })
    expect(out.created_via).toEqual(stamp)
  })

  it('removes a key when its field is cleared', () => {
    const out = mergeAttributes({ manufacturer: 'Corning' }, defs, { manufacturer: '' })
    expect('manufacturer' in out).toBe(false)
  })

  it('leaves a key absent from values alone', () => {
    // fiber_count is scoped away for this part, so the form never rendered it;
    // saving the part must not delete the stored answer.
    const out = mergeAttributes({ fiber_count: 144 }, defs, { manufacturer: 'Corning' })
    expect(out.fiber_count).toBe(144)
  })

  it('replaces the legacy section only when legacy values are supplied', () => {
    const existing = { manufacturer: 'Corning', old_key: 'x', created_via: { source: 'CSV' } }
    const kept = mergeAttributes(existing, defs, { manufacturer: 'Corning' })
    expect(kept.old_key).toBe('x')

    const rewritten = mergeAttributes(existing, defs, { manufacturer: 'Corning' }, { other: 'y' })
    expect('old_key' in rewritten).toBe(false)
    expect(rewritten.other).toBe('y')
    expect(rewritten.created_via).toEqual({ source: 'CSV' })
  })

  it('stores typed values, not strings', () => {
    const out = mergeAttributes({}, defs, { fiber_count: '144' })
    expect(out.fiber_count).toBe(144)
  })

  // Regression: Receive PO's edit panel seeds its field values when the panel
  // opens, but the attribute definitions are fetched separately. A def that
  // landed after the seed used to be handed over as `undefined`, which reads
  // as "cleared" and deleted the part's stored value. Callers now omit keys
  // they never showed; this pins the behaviour that makes that safe.
  it('distinguishes a cleared field from one that was never shown', () => {
    const existing = { manufacturer: 'Corning', fiber_count: 144 }
    const cleared = mergeAttributes(existing, defs, { manufacturer: '' })
    expect('manufacturer' in cleared).toBe(false)
    expect(cleared.fiber_count).toBe(144)

    const neverShown = mergeAttributes(existing, defs, {})
    expect(neverShown.manufacturer).toBe('Corning')
    expect(neverShown.fiber_count).toBe(144)
  })

  it('treats an explicitly undefined value as a clear, so callers must omit instead', () => {
    // The dangerous shape, documented: a caller that passes `{key: undefined}`
    // IS asking for a delete. Anything seeding from an async source has to
    // check `key in values` before including it.
    const out = mergeAttributes({ manufacturer: 'Corning' }, defs, { manufacturer: undefined })
    expect('manufacturer' in out).toBe(false)
  })

  it('leaves the whole bag alone when no legacy section is supplied', () => {
    // Guards the failed-defs-read path: with no definitions loaded we must not
    // conclude that every key is an unexplained leftover and drop it.
    const existing = { manufacturer: 'Corning', stray: 'x', created_via: { source: 'CSV' } }
    const out = mergeAttributes(existing, [], {})
    expect(out).toEqual(existing)
  })
})

describe('legacyAttrEntries', () => {
  it('lists only keys no def explains, and never an object', () => {
    const defs = [def({ key: 'manufacturer' })]
    const attrs = { manufacturer: 'Corning', supplier_code: 'X1', created_via: { source: 'CSV' } }
    expect(legacyAttrEntries(attrs, defs)).toEqual([{ key: 'supplier_code', value: 'X1' }])
  })

  it('surfaces the values of a retired def so they do not vanish', () => {
    const defs = []
    expect(legacyAttrEntries({ manufacturer: 'Corning' }, defs).map(e => e.key)).toEqual(['manufacturer'])
  })
})

describe('completeness', () => {
  const defs = [
    def({ key: 'manufacturer', label: 'Manufacturer', required: true }),
    def({ key: 'fiber_count', label: 'Fiber count', required: true, applies_to_departments: ['Fiber'] }),
  ]

  it('reports a required attribute with no value', () => {
    const part = { department: 'Fiber', attributes: { manufacturer: 'Corning' } }
    expect(missingRequiredDefs(defs, part).map(d => d.key)).toEqual(['fiber_count'])
    expect(partIsMissingRequired(defs, part)).toBe(true)
  })

  it('does not report an attribute scoped to another department', () => {
    const part = { department: 'CPE', attributes: { manufacturer: 'Ubiquiti' } }
    expect(missingRequiredDefs(defs, part)).toEqual([])
    expect(partIsMissingRequired(defs, part)).toBe(false)
  })

  it('accepts an explicit "no" as an answer', () => {
    const boolDefs = [def({ key: 'serialized', label: 'Serialized', input_type: 'boolean', required: true })]
    const part = { department: 'CPE', attributes: { serialized: false } }
    expect(partIsMissingRequired(boolDefs, part)).toBe(false)
  })

  it('handles a part with no attributes at all', () => {
    expect(partIsMissingRequired(defs, { department: 'Fiber' })).toBe(true)
  })
})

describe('attributeCsvColumns', () => {
  it('emits one labeled column per active def in display order', () => {
    const defs = [
      def({ key: 'b', label: 'Bravo', sort_order: 2 }),
      def({ key: 'a', label: 'Alpha', sort_order: 1 }),
      def({ key: 'r', label: 'Retired', is_active: false }),
    ]
    expect(attributeCsvColumns(defs).map(c => c.header)).toEqual(['Alpha', 'Bravo'])
  })
})
