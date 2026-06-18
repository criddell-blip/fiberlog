import { useState } from 'react'
import { searchParts } from '../../../lib/supabase'
import { useBackClose } from '../../../lib/backStack'

export default function PartSearch({ onSelect, onClose, filter }) {
  // Mounted only while open, so depth is always 1. Display-only (picking a part
  // is the action) — Back closes it with no confirm.
  useBackClose(1, onClose)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)

  async function handleSearch(q) {
    setQuery(q)
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const data = await searchParts(q)
      setResults(data)
    } catch (e) {
      console.warn('Part search failed:', e)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet">
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 14 }}>Find a part</div>

        <div className="field">
          <input
            type="text"
            placeholder="Search by name or SKU..."
            value={query}
            onChange={e => handleSearch(e.target.value)}
            autoFocus
          />
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: 13 }}>
            Searching...
          </div>
        )}

        {!loading && results.length === 0 && query.length >= 2 && (
          <div style={{ textAlign: 'center', padding: 20, color: 'var(--hint)', fontSize: 13 }}>
            No parts found — try a different term or SKU
          </div>
        )}

        {results.map(p => (
          <div
            key={p.id}
            onClick={() => onSelect({ id: p.id, name: p.name, unit: p.unit || 'ea' })}
            style={{
              padding: '12px 14px', background: 'var(--bg)',
              borderRadius: 'var(--r-sm)', marginBottom: 6, cursor: 'pointer',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}
          >
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: 'var(--hint)', fontFamily: 'DM Mono, monospace', marginTop: 2 }}>
                {p.id}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--gray-lt)', padding: '3px 8px', borderRadius: 20 }}>
              {p.material_group || p.category || '—'}
            </div>
          </div>
        ))}

        <button
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: 12 }}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
