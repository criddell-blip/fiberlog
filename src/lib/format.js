// Shared date/time formatting helpers.
//
// fmtWhen deliberately matches the signature of the crew-side export in
// components/crew/PassdownList.jsx (`fmtWhen(iso, lang = 'en')`) so merging
// the two into one canonical copy later is a one-line import swap. We do
// NOT import from PassdownList here — crew/ is a separate ownership zone.

// Locale-aware "Jul 5, 2:30 PM" / "5 jul, 14:30". Default 'en' keeps
// legacy no-lang call sites working.
export function fmtWhen(iso, lang = 'en') {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(lang === 'es' ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// "2026-08-15" in LOCAL time — never .toISOString().slice(0,10), which is
// the UTC date: after ~5pm MST / 6pm MDT that's TOMORROW in Utah (backlog
// #45 — evening work sessions, PR dates, and reconcile notes were all
// stamping the next day). Use this for any "today" written to the DB or
// shown to a user; the server-side counterpart is
// (now() AT TIME ZONE 'America/Denver')::date (see crew_activity_today).
export function isoLocalDate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// "Aug 13, 2026" — date only, year always shown.
//
// fmtWhen deliberately omits the year, which is right for a live feed of
// today's activity but wrong for history views: a June 2025 and a June 2026
// receipt render identically there. The clock time is noise once rows span
// months, so it's dropped in exchange for the year.
export function fmtDayYear(iso, lang = 'en') {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(lang === 'es' ? 'es' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
