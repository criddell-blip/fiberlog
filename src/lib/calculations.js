// ─── PARTS CALCULATION ENGINE ─────────────────────────────────────────────────
// Converts work descriptions (poles hung, footage lashed, etc.)
// into calculated parts lists using BoxHero SKUs

// Standard hardware per pole type
const POLE_HARDWARE = {
  intermediate: {
    label: 'Intermediate Pole',
    parts: [
      { id: 'SKU-STLVBCPS', name: 'Nut, Square 5/8"', qty: 2 },
      { id: '600-100023-ALB', name: 'Washer, Square 2x2"', qty: 2 },
      { id: '600-100003-ALB', name: 'Bolt, Machine 5/8" x 14"', qty: 1 },
      { id: '600-100028-ALB', name: 'Clamp, B Suspension 5/8"', qty: 1 },
    ]
  },
  terminal: {
    label: 'Terminal Pole',
    parts: [
      { id: '600-100048-ALB', name: 'Bolt, Thimble Eye 5/8" x 14"', qty: 1 },
      { id: 'SKU-STLVBCPS', name: 'Nut, Square 5/8"', qty: 1 },
      { id: '600-100023-ALB', name: 'Washer, Square 2x2"', qty: 1 },
      { id: '600-200009-ALB', name: 'Grip, Deadend Guy 1/4"', qty: 1 },
    ]
  },
  downGuy: {
    label: 'Down Guy',
    parts: [
      { id: '600-200001-5000-ERC', name: 'Strand EHS 1/4"', qty: 20, unit: 'ft' },
      { id: '600-200009-ALB', name: 'Grip, Deadend Guy 1/4"', qty: 4 },
      { id: '600-300001-ALB', name: 'Anchor Rod 3/4" x 66"', qty: 1 },
      { id: '600-100038-ALB', name: 'Guy Insulator', qty: 1 },
      { id: '600-300003-EMC', name: 'Guy Guard 96" Yellow', qty: 1 },
      { id: '600-100068-ALB', name: 'Hook, B Guy 5/8"', qty: 1 },
    ]
  },
  poleRiser: {
    label: 'Pole Riser',
    parts: [
      { id: 'SKU-HCZXESJ3', name: '2" x 10ft Rigid Metal Conduit', qty: 2 },
      { id: 'SKU-97ECXI38', name: '6" V-Style Standoff', qty: 2 },
    ]
  },
  snowshoe: {
    label: 'Snowshoe',
    parts: [
      { id: '600-100035-ALB', name: 'Strap, Lashing Support 16"', qty: 5 },
      { id: '600-100019-MUL', name: 'Fiber Storage Unit 16" Snowshoe', qty: 1 },
    ]
  }
}

// Standard lashing hardware per 100ft
const LASHING_HARDWARE_PER_100FT = {
  intermediate: [
    { id: '600-100029-ALB', name: 'Clamp, D Lashing Bug Nut', qtyPer100: 0.5 },
    { id: '600-100030', name: 'Spacer, 1/2" Lashing Strap', qtyPer100: 0.5 },
    { id: '600-100035-ALB', name: 'Strap, Lashing Support 16"', qtyPer100: 1 },
  ],
  terminal: [
    { id: '600-100029-ALB', name: 'Clamp, D Lashing Bug Nut', qtyPer100: 0.5 },
    { id: '600-100030', name: 'Spacer, 1/2" Lashing Strap', qtyPer100: 0.5 },
    { id: '600-100035-ALB', name: 'Strap, Lashing Support 16"', qtyPer100: 1.5 },
    { id: '600-200009-ALB', name: 'Grip, Deadend Guy 1/4"', qtyPer100: 0.25 },
  ]
}

// ─── CALCULATION FUNCTIONS ────────────────────────────────────────────────────

/**
 * Calculate parts for strand/hardware work
 * @param {Array} poleEntries - [{type: 'intermediate'|'terminal'|'downGuy'|'poleRiser'|'snowshoe', count: N, boltSize: '14'|'16'|'12'}]
 */
export function calcStrandParts(poleEntries) {
  const totals = {}

  poleEntries.forEach(({ type, count, boltOverride }) => {
    const template = POLE_HARDWARE[type]
    if (!template) return

    template.parts.forEach(p => {
      const isBoltPart = p.id.startsWith('600-10000') || p.id.startsWith('600-10004')

      if (isBoltPart) {
        // Always use boltOverride size (defaults to '14' if not set)
        const size = boltOverride || '14'
        const overrideId = getBoltId(p.id, size)
        const overrideName = getBoltName(p.id, size)
        if (!totals[overrideId]) totals[overrideId] = { id: overrideId, name: overrideName, qty: 0, unit: 'ea' }
        totals[overrideId].qty += p.qty * count
        return
      }

      const key = p.id
      if (!totals[key]) totals[key] = { ...p, qty: 0, unit: p.unit || 'ea' }
      totals[key].qty += p.qty * count
    })
  })

  return Object.values(totals)
}

// Bolt ID map: [machine 12, machine 14, machine 16, thimble 12, thimble 14, thimble 16]
const BOLT_ID_MAP = {
  machine: { '12': '600-100002-ALB', '14': '600-100003-ALB', '16': '600-100004-ALB' },
  thimble: { '12': '600-100047-ALB', '14': '600-100048-ALB', '16': '600-100049-ALB' },
}
const BOLT_NAME_MAP = {
  machine: { '12': 'Bolt, Machine 5/8" x 12"', '14': 'Bolt, Machine 5/8" x 14"', '16': 'Bolt, Machine 5/8" x 16"' },
  thimble: { '12': 'Bolt, Thimble Eye 5/8" x 12"', '14': 'Bolt, Thimble Eye 5/8" x 14"', '16': 'Bolt, Thimble Eye 5/8" x 16"' },
}

function getBoltId(originalId, size) {
  const s = String(size)
  if (originalId.includes('600-10000')) return BOLT_ID_MAP.machine[s] || originalId
  if (originalId.includes('600-10004')) return BOLT_ID_MAP.thimble[s] || originalId
  return originalId
}

function getBoltName(originalId, size) {
  const s = String(size)
  if (originalId.includes('600-10000')) return BOLT_NAME_MAP.machine[s] || originalId
  if (originalId.includes('600-10004')) return BOLT_NAME_MAP.thimble[s] || originalId
  return originalId
}

/**
 * Calculate parts for fiber lashing
 * @param {number} footage - feet of fiber lashed
 * @param {string} lashType - 'intermediate' | 'terminal'
 * @param {string} fiberPartId - BoxHero SKU for the fiber reel
 */
export function calcLashingParts(footage, lashType, fiberPartId) {
  const parts = []

  // Fiber itself
  if (fiberPartId && footage > 0) {
    parts.push({
      id: fiberPartId,
      name: 'Fiber Cable',
      unit: 'ft',
      qty: footage,
    })
  }

  // Lashing wire — approximately 1 coil per 1200ft
  if (footage > 0) {
    parts.push({
      id: '600-210001-CWP',
      name: 'Lashing Wire .045" T430',
      unit: 'ea',
      qty: Math.ceil(footage / 1200),
    })
  }

  // Hardware based on footage
  const hardware = LASHING_HARDWARE_PER_100FT[lashType] || LASHING_HARDWARE_PER_100FT.intermediate
  hardware.forEach(h => {
    parts.push({
      id: h.id,
      name: h.name,
      unit: 'ea',
      qty: Math.ceil((footage / 100) * h.qtyPer100),
    })
  })

  return parts
}

/**
 * Calculate parts for strand installation
 * @param {number} footage - feet of strand
 */
export function calcStrandFootageParts(footage) {
  if (!footage) return []
  return [{
    id: '600-200001-5000-ERC',
    name: 'Strand EHS 1/4" per foot',
    unit: 'ft',
    qty: footage,
  }]
}

/**
 * Calculate parts for underground work
 * @param {Array} boreEntries - [{footage, conduitType}]
 * @param {Array} placeEntries - [{footage, conduitType}]
 * @param {Array} structures - [{type: 'handhole_plastic'|'handhole_poly'|'vault_large', count}]
 */
export function calcUndergroundParts(boreEntries, placeEntries, structures) {
  const totals = {}

  const addPart = (id, name, unit, qty) => {
    if (!totals[id]) totals[id] = { id, name, unit, qty: 0 }
    totals[id].qty += qty
  }

  // Bore footage → conduit
  boreEntries.forEach(({ footage, conduitId, conduitName }) => {
    if (footage && conduitId) addPart(conduitId, conduitName, 'ft', footage)
    // Tracer wire for underground
    if (footage) addPart('SKU-BY9IKNAP', 'Tracer Wire 2500ft spool', 'ea', Math.ceil(footage / 2500))
  })

  // Direct place/plow footage → conduit
  placeEntries.forEach(({ footage, conduitId, conduitName }) => {
    if (footage && conduitId) addPart(conduitId, conduitName, 'ft', footage)
    if (footage) addPart('200-130001', 'Pull Tape 1800#', 'ft', footage)
  })

  // Structures
  const structureParts = {
    handhole_plastic: { id: 'SKU-26H3G0GO', name: 'Handhole, Plastic 14"x19"' },
    handhole_poly: { id: '400-300815-ODC', name: 'Handhole, Polymer Concrete 13x24x12' },
    vault_large: { id: '400-3001080-ODC', name: 'Handhole, Polymer Concrete 17x30x18' },
  }

  structures.forEach(({ type, count }) => {
    const p = structureParts[type]
    if (p && count) addPart(p.id, p.name, 'ea', count)
  })

  return Object.values(totals)
}

/**
 * Calculate parts for splice work
 * @param {Array} closures - [{type: 'A4'|'C6'|'D6', count, trays}]
 * @param {Array} splitters - [{type: '1x2'|'1x4'|'1x8', count}]
 */
export function calcSpliceParts(closures, splitters) {
  const totals = {}

  const addPart = (id, name, unit, qty) => {
    if (!totals[id]) totals[id] = { id, name, unit: unit || 'ea', qty: 0 }
    totals[id].qty += qty
  }

  const closureMap = {
    A4: { id: 'OFDC-A4-S2/44-14-N-12', name: 'OFDC-A4 Splice/Patch Closure' },
    C6: { id: '150-100125', name: 'C6 Case FOSC450' },
    D6: { id: 'FOSC450-D6-6-NT-0-D6V', name: 'D6 Case No Tray' },
  }

  const trayMap = {
    A4: { id: '429567-000', name: 'A Tray FOSC-ACC-A-TRAY-24' },
    C6: { id: '150-110024', name: 'C Tray FOSC-ACC-C-TRAY-24' },
    D6: { id: 'FOSC-ACC-D-TRAY-72-KIT', name: 'D Tray FOSC-ACC-D-TRAY-72' },
  }

  const splitterMap = {
    '1x2': { id: 'PLC-102-ST-25-15', name: '1x2 Bare PLC Splitter' },
    '1x4': { id: 'PLC-104-ST-25-15', name: '1x4 Bare PLC Splitter' },
    '1x8': { id: 'PLC-108-ST-25-15', name: '1x8 Bare PLC Splitter' },
  }

  closures.forEach(({ type, count, trays }) => {
    const c = closureMap[type]
    if (c && count) {
      addPart(c.id, c.name, 'ea', count)
      // Gel seal kit per closure
      addPart('CZ3388-000', 'Drop Gel Seal Kit', 'ea', count)
      // Aerial clamp kit per closure
      addPart('FOSC-ACC-450-AERIAL-CLMP', 'Aerial Clamp Kit', 'ea', count)
    }
    // Trays
    const t = trayMap[type]
    if (t && trays) addPart(t.id, t.name, 'ea', trays)
  })

  splitters.forEach(({ type, count }) => {
    const s = splitterMap[type]
    if (s && count) addPart(s.id, s.name, 'ea', count)
  })

  return Object.values(totals)
}

/**
 * Merge parts arrays, summing quantities for duplicate IDs
 */
export function mergeParts(partsArrays) {
  const totals = {}
  partsArrays.flat().forEach(p => {
    if (!totals[p.id]) totals[p.id] = { ...p, qty: 0 }
    totals[p.id].qty += p.qty
  })
  return Object.values(totals).filter(p => p.qty > 0)
}
