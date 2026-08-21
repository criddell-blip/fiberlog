// Display labels + pill colours for purchase_requests.status. One map so the
// PR list, the PR sheet and the Receive-PO hand-off pill agree (they used to
// carry three private copies; two disagreed on the `ordered` hue and all three
// printed the raw token under text-transform: uppercase).
export const PR_STATUS_LABELS = {
  pending:   'Pending',
  ordered:   'Ordered',
  partial:   'Partial',
  received:  'Received',
  cancelled: 'Cancelled',
}

// Semantic colours: pending amber, ordered emerald, partial blue, received
// grey, cancelled red.
export const PR_STATUS_COLORS = {
  pending:   { fg: 'var(--amber)',     bg: 'var(--amber-lt)',  border: 'var(--amber)' },
  ordered:   { fg: 'var(--accent-dk)', bg: 'var(--accent-lt)', border: 'var(--accent)' },
  partial:   { fg: 'var(--blue)',      bg: 'var(--blue-lt)',   border: 'var(--blue)' },
  received:  { fg: 'var(--muted)',     bg: 'var(--gray-lt)',   border: 'var(--border2)' },
  cancelled: { fg: 'var(--red)',       bg: 'var(--red-lt)',    border: 'var(--red)' },
}

export function prStatusLabel(status) {
  if (!status) return ''
  return PR_STATUS_LABELS[status] || status.charAt(0).toUpperCase() + status.slice(1)
}
