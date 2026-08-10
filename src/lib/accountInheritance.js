// Account-based destination inheritance for the Sonar field-tech import.
//
// A GigaSpire router / power adapter has no routing policy of its own
// ('ask'), but it ships on the same ticket as the ONT or Wave unit it
// powers — the Sonar account is the honest tie between them. Rows whose
// destination resolved (part policy, project tag, city lookup, or a manual
// pick) donate that destination to same-account 'ask' rows.
//
// Deliberately conservative: inheritance fires only when EVERY resolved
// sibling on the account agrees on one destination — a split account
// (e.g. simultaneous fiber + wireless work) stays manual. Only status
// 'ask' inherits; city-unmapped / project-unmapped rows carry an explicit
// routing intent that needs a mapping, and inheriting would mask that.
// Excluded rows still donate: excluding means "don't book this row",
// not "this row's destination is wrong".

export function applyAccountInheritance(rows) {
  const byAccount = new Map()
  for (const r of rows) {
    if (!r.accountId) continue
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, [])
    byAccount.get(r.accountId).push(r)
  }
  return rows.map(r => {
    if (r.status !== 'ask' || !r.accountId) return r
    const donors = byAccount.get(r.accountId)
      .filter(s => s !== r && s.status === 'ready' && s.destId)
    if (donors.length === 0) return r
    if (new Set(donors.map(s => s.destId)).size !== 1) return r
    const donor = donors[0]
    // Donors can agree on the bucket while carrying different phase tags
    // (two Sonar projects whose phases share a parent project). The phase
    // feeds Sage cost-center rollups, so an order-dependent coin-flip is
    // worse than no tag — inherit it only when every donor agrees.
    const phaseTags = new Set(donors.map(s => s.phaseTagId ?? null))
    return {
      ...r,
      destId: donor.destId,
      destName: donor.destName,
      phaseTagId: phaseTags.size === 1 ? (donor.phaseTagId ?? null) : null,
      destReason: `same account → follows ${donor.partName || donor.partId}`,
      status: 'ready',
      inheritedFromAccount: true,
    }
  })
}

// Display order for the preview table: chronological, but with all of an
// account's rows pulled together into one contiguous group (anchored where
// the account first appears). Rows without an account id group alone.
export function groupRowsByAccount(rows) {
  const sorted = [...rows].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) || a.idx - b.idx)
  const groupOrder = new Map()
  sorted.forEach((r, i) => {
    const k = r.accountId || `row-${r.idx}`
    if (!groupOrder.has(k)) groupOrder.set(k, i)
  })
  return sorted.sort((a, b) =>
    groupOrder.get(a.accountId || `row-${a.idx}`) - groupOrder.get(b.accountId || `row-${b.idx}`) ||
    String(a.date).localeCompare(String(b.date)) || a.idx - b.idx)
}
