// Sonar's field-tech asset report bundles every per-unit identifier into one
// column — `Model Field Data | Value List` (Sonar report path:
// InventoryModels > InventoryItems > InventoryModelFieldData). It's a
// pipe-separated string, unlabeled, with each value repeated once per
// aggregation level the Looker report echoed:
//
//   92858 | 92858 | CXNK0125B87D | CXNK0125B87D | 04:BC:9F:4D:AD:8B | 04:BC:9F:4D:AD:8B | 59995 | 59995
//
// Field order follows the model's field definition in Sonar, and the owner
// confirmed (Sep 2026) the FIRST number is the physical asset tag — the same
// number the importer has always used as its dedup key (`[sonar:<tag>]`).
// Older items carry a second trailing number from an earlier labeling
// scheme; it's kept as an alternate tag rather than dropped. Serial and MAC
// are classified by shape (a serial is the alphanumeric token that isn't a
// MAC; a MAC is 6 colon/dash-separated hex pairs or 12 bare hex digits —
// Calix ONTs print MACs without separators).
//
// Pure: no DB, no React — the importer, the Reports CSV and the backfill
// script (scripts/backfill-sonar-asset-tags.mjs) all share it so one parse
// rule decides what lands in inventory_movements.line_note.

// First 3+-digit token = the asset tag / Sonar item key. Unchanged from the
// original importer rule so the [sonar:<n>] dedup marker never shifts.
export function extractItemIdFromValueList(valueList) {
  if (!valueList || typeof valueList !== 'string') return ''
  const tokens = valueList.split('|').map(s => s.trim()).filter(Boolean)
  for (const t of tokens) {
    if (/^\d{3,}$/.test(t)) return t
  }
  return tokens[0] || ''
}

const MAC_RE = /^(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}$|^[0-9A-F]{12}$/i

export function isMacLike(token) {
  return MAC_RE.test(token || '')
}

// → { assetTag, serial, mac, altTag, other: [] } — every field null/empty
// when absent. Tokens are de-duplicated preserving first-seen order.
export function parseSonarValueList(valueList) {
  const out = { assetTag: null, serial: null, mac: null, altTag: null, other: [] }
  if (!valueList || typeof valueList !== 'string') return out
  const seen = new Set()
  const tokens = []
  for (const raw of valueList.split('|')) {
    const t = raw.trim()
    if (!t) continue
    const k = t.toUpperCase()
    if (seen.has(k)) continue
    seen.add(k)
    tokens.push(t)
  }
  for (const t of tokens) {
    if (/^\d{3,}$/.test(t)) {
      if (!out.assetTag) out.assetTag = t
      else if (!out.altTag) out.altTag = t
      else out.other.push(t)
      continue
    }
    if (isMacLike(t)) {
      if (!out.mac) out.mac = t.toUpperCase()
      else out.other.push(t.toUpperCase())
      continue
    }
    if (/^[A-Z0-9-]{6,}$/i.test(t)) {
      if (!out.serial) out.serial = t.toUpperCase()
      else out.other.push(t)
      continue
    }
    out.other.push(t)
  }
  return out
}

// The human-readable line note the importer stamps on each transfer. Same
// column the infra passdown asset tags use, so Activity / the raw-history
// CSV / the site materials drilldown render it with the same tag icon.
//   'Tag 92858 · SN CXNK0125B87D · MAC 04:BC:9F:4D:AD:8B · Alt tag 59995'
// Returns null when the value list carried nothing usable.
export function formatSonarLineNote(parsed) {
  if (!parsed) return null
  const parts = [
    parsed.assetTag && `Tag ${parsed.assetTag}`,
    parsed.serial && `SN ${parsed.serial}`,
    parsed.mac && `MAC ${parsed.mac}`,
    parsed.altTag && `Alt tag ${parsed.altTag}`,
    ...(parsed.other || []),
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

export function sonarLineNoteFromValueList(valueList) {
  return formatSonarLineNote(parseSonarValueList(valueList))
}

// ─── Bare asset ID for a movement ───────────────────────────────────────────
// Just the number, for its own CSV column — sortable and VLOOKUP-able against
// a Sonar inventory export, which the combined "Tag … · SN … · MAC …" text is
// not. Two sources, in order:
//   1. the importer's dedup marker `[sonar:<tag>]` in notes — present on every
//      asset-report row, including the ~50 pre-Sep-2026 rows with no line_note;
//   2. the `Tag <n>` prefix formatSonarLineNote writes — the only source on a
//      reclass row, which copies line_note but carries its own notes.
// Verified on prod Sep 17 2026: 1,090 rows, the two never disagree.
// The marker match is digits-then-bracket on purpose: the composite fallback
// key `[sonar:<acct>-<Date Time>]` is an account, not an asset, and must not
// leak into this column. Infra passdown tags are free text and never start
// with the importer's `Tag ` prefix, so they stay out too. '' when absent.
const SONAR_MARKER_ID_RE = /\[sonar:(\d+)\]/
const LINE_NOTE_TAG_RE = /^Tag (\d{3,})(?!\d)/

export function sonarAssetIdFromMovement(m) {
  const marker = SONAR_MARKER_ID_RE.exec(m?.notes || '')
  if (marker) return marker[1]
  const tag = LINE_NOTE_TAG_RE.exec(m?.line_note || '')
  return tag ? tag[1] : ''
}
