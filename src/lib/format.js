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
