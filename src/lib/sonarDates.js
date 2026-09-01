// Sonar timestamps are naive local wall-clock strings ("2026-08-27 14:23:35",
// or a bare date on the fiber-jobs report) in Utah time. The importers used
// to feed them to `new Date(...)`, which parses in the *importing browser's*
// timezone — the same delivery booked different `occurred_at` instants
// depending on whose machine ran the import (verified +7h on the Aug 28 2026
// batch: a UTC-7 browser vs Utah's UTC-6 summer offset). Interpret them as
// America/Denver explicitly so the stored instant is machine-independent.

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?\s*$/

// What Denver's wall clock reads at a given UTC instant, expressed as a
// Date.UTC millisecond value (so it can be subtracted from the instant to
// get the zone offset at that moment).
function denverWallClockAsUtcMs(instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instantMs))
  const get = type => Number(parts.find(p => p.type === type)?.value)
  // hourCycle quirk: some engines render midnight as "24"
  const hour = get('hour') % 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
}

// "YYYY-MM-DD[ HH:MM[:SS]]" (Denver wall time) → UTC ISO string, or null if
// the input doesn't parse. Date-only input means Denver midnight. DST-safe:
// the offset is resolved at the target instant itself (two-pass fixpoint).
export function denverNaiveToIso(naive) {
  if (typeof naive !== 'string') return null
  const m = NAIVE_RE.exec(naive.trim())
  if (!m) return null
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  const wallMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
  // First guess: assume the wall time IS the instant, measure Denver's
  // offset there, correct — then re-measure at the corrected instant so a
  // timestamp on the far side of a DST switch lands on the right offset.
  // (Offset is always wall-clock-at-instant minus the instant itself.)
  let instant = wallMs - (denverWallClockAsUtcMs(wallMs) - wallMs)
  instant = wallMs - (denverWallClockAsUtcMs(instant) - instant)
  return new Date(instant).toISOString()
}
