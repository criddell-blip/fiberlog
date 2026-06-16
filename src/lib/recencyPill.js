// Recency-pill helper for the paused quantity-display mode.
// When the inventory pause switch is on, every surface that used to
// show a qty number renders one of these pills instead — so the user
// sees "this part lives here, last touched X ago" without pretending
// the number is authoritative.
//
// Returns { label, fg, bg, border } using the existing CSS variables
// so colors stay consistent with the rest of the app's pills.

const MS_PER_DAY = 86_400_000

export function recencyOf(lastMovementAt) {
  if (!lastMovementAt) {
    return {
      label: 'unknown',
      fg: 'var(--amber)',
      bg: 'var(--amber-lt)',
      border: 'var(--amber)',
    }
  }
  const then = new Date(lastMovementAt).getTime()
  if (Number.isNaN(then)) {
    return {
      label: 'unknown',
      fg: 'var(--amber)',
      bg: 'var(--amber-lt)',
      border: 'var(--amber)',
    }
  }
  const days = (Date.now() - then) / MS_PER_DAY
  if (days < 1) {
    return {
      label: 'today',
      fg: 'var(--teal-dk)',
      bg: 'var(--teal-lt)',
      border: 'var(--teal)',
    }
  }
  if (days < 7) {
    return {
      label: 'this week',
      fg: 'var(--muted)',
      bg: 'var(--surface2)',
      border: 'var(--border)',
    }
  }
  if (days < 30) {
    return {
      label: 'this month',
      fg: 'var(--muted)',
      bg: 'var(--surface2)',
      border: 'var(--border)',
    }
  }
  return {
    label: 'stale',
    fg: 'var(--amber)',
    bg: 'var(--amber-lt)',
    border: 'var(--amber)',
  }
}

// Inline-styles wrapper for the most common use — a small pill with the
// recency label. Pass `lastMovementAt` and get back a JSX-ready
// <span>. Caller can override styles via `style` prop.
export function recencyPillStyle(lastMovementAt) {
  const r = recencyOf(lastMovementAt)
  return {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 10,
    color: r.fg,
    background: r.bg,
    border: `1px solid ${r.border}`,
    whiteSpace: 'nowrap',
    textTransform: 'lowercase',
  }
}
