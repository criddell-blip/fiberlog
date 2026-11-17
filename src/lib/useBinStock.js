import { useEffect, useState } from 'react'
import { getStockRowsForParts } from './inventory'
import { buildStockIndex } from './binSource'

// Loads per-location stock for the parts an import draws from a warehouse,
// as the index allocateBinSources() reads. Refetches only when the SET of
// part ids changes (sorted join), not on every resolver re-run — typing a
// qty must not refetch. A fetch failure degrades to an empty index (every
// line then falls back to unbinned, i.e. today's behavior) plus a flag the
// sheet can surface.
export function useBinStock(partIds) {
  const key = [...new Set((partIds || []).filter(Boolean))].sort().join('|')
  const [state, setState] = useState({ index: new Map(), loading: false, failed: false })
  useEffect(() => {
    if (!key) { setState({ index: new Map(), loading: false, failed: false }); return }
    let cancelled = false
    setState(s => ({ ...s, loading: true }))
    getStockRowsForParts(key.split('|'))
      .then(rows => { if (!cancelled) setState({ index: buildStockIndex(rows), loading: false, failed: false }) })
      .catch(e => {
        console.error('Bin stock lookup failed:', e)
        if (!cancelled) setState({ index: new Map(), loading: false, failed: true })
      })
    return () => { cancelled = true }
  }, [key])
  return state
}
