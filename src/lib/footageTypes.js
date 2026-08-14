// Crew footage "type" pick lists, shared by the workspace chips
// (TaskWorkspace) and the manager footage→part map editor so the two can't
// drift. These are the values stored in footage_type_part_map.type_value.

export const FIBER_COUNTS = ['12ct', '24ct', '48ct', '72ct', '144ct', '288ct']
export const CONDUIT_SIZES = ['3/4"', '1"', '1-1/4"', '1-1/2"', '2"', '3"']

// Exactly one strand cable SKU exists (EHS 1/4" — everything else matching
// "strand" in the catalog is per-each hardware: strandvises, splices, grips).
//
// Deliberately NOT padded with 3/8" / 5/16". For strand an unmapped chip has
// zero upside — the feet already reach total_strand_ft through `counts`
// regardless of type — and one real downside: picking it turns a working
// consumption path into a silent zero. Keeping this list at length 1 is also
// what makes the auto-pick in TaskWorkspace deterministic. Adding a size means
// adding the SKU, the mapping and this entry, on purpose.
export const STRAND_SIZES = ['1/4"']

// kind → chip values. THE enumeration of footage kinds: the crew picker, the
// manager map editor, the auto-pick and the DB CHECK all key off this, so a
// new kind is one entry here plus one `is_*` assembly flag — not five
// scattered `isFiber ? … : isConduit ? …` ternaries.
export const FOOTAGE_TYPE_VALUES = {
  fiber: FIBER_COUNTS,
  conduit: CONDUIT_SIZES,
  strand: STRAND_SIZES,
}

// Crew picker headings (i18n keys) and manager section titles, same keying.
export const FOOTAGE_HEADING_KEYS = {
  fiber: 'tapFiberTypes',
  conduit: 'tapConduitSizes',
  strand: 'tapStrandSizes',
}

export const FOOTAGE_KIND_LABELS = {
  fiber: 'Fiber — strand count',
  conduit: 'Conduit — size',
  strand: 'Strand — size',
}
