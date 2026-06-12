import { useState, useEffect, useRef } from 'react'
import { searchInventoryGlobal } from '../../lib/inventory'

// One search box at the top of the Inventory section. Type a SKU, part
// name, nickname, location name, or bin name → results appear grouped
// by Parts / Locations / Stock (the part-at-location pivot). Click a
// result → jumps to the right sub-tab with the entity pre-focused.
//
// Solves the friction of "which tab do I start in?" — every inventory
// task now has one obvious entry point regardless of whether the user
// is thinking part-first or location-first.
//
// Debounced 250 ms; minimum 2 chars before a query fires.
export default function InventoryLauncher({ onJumpToPart, onJumpToLocation, onJumpToStockPair }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)  // null = no search yet, {} = a search ran
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const inputRef = useRef(null)

  // Close on outside-click (matches the existing ⋯ More popover pattern
  // in InventoryView).
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Debounced search. Cancel-on-unmount AND on-query-change via the
  // cancelled flag so a slow request from a stale query can't overwrite
  // a fresh one.
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const r = await searchInventoryGlobal(trimmed, { limit: 5 })
        if (!cancelled) {
          setResults(r)
          setLoading(false)
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Inventory search failed:', e)
          setResults({ parts: [], locations: [], stockPairs: [] })
          setLoading(false)
        }
      }
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  function handleSelectPart(p) {
    setOpen(false)
    setQuery('')
    setResults(null)
    onJumpToPart?.(p.id)
  }
  function handleSelectLocation(l) {
    setOpen(false)
    setQuery('')
    setResults(null)
    onJumpToLocation?.(l.id)
  }
  function handleSelectStockPair(s) {
    setOpen(false)
    setQuery('')
    setResults(null)
    onJumpToStockPair?.({ partId: s.partId, locationId: s.locationId })
  }

  function handleClear() {
    setQuery('')
    setResults(null)
    inputRef.current?.focus()
  }

  const showDropdown = open && (loading || results !== null)
  const totalResults = results
    ? (results.parts?.length || 0) + (results.locations?.length || 0) + (results.stockPairs?.length || 0)
    : 0

  return (
    <div ref={wrapperRef} style={{ position: 'relative', marginBottom: 12 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        background: 'var(--surface2)',
        border: `1.5px solid ${open ? 'var(--orange)' : 'var(--border2)'}`,
        borderRadius: 'var(--r-sm)',
        padding: '6px 10px',
        transition: 'border-color 0.15s',
      }}>
        <span style={{ fontSize: 14, color: 'var(--hint)' }}>🔍</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder="Find a part, location, bin, or stock pair…"
          autoComplete="off"
          name="inv-launcher"
          style={{
            flex: 1, border: 'none', background: 'transparent',
            color: 'var(--text)', fontSize: 13, outline: 'none',
            padding: '2px 0',
          }}
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            title="Clear"
            style={{
              background: 'transparent', border: 'none', color: 'var(--muted)',
              cursor: 'pointer', fontSize: 14, padding: '0 4px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {showDropdown && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: 4,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 50,
          maxHeight: '60vh', overflowY: 'auto',
        }}>
          {loading && (
            <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
              Searching…
            </div>
          )}

          {!loading && totalResults === 0 && (
            <div style={{ padding: '14px 14px', fontSize: 12, color: 'var(--hint)', textAlign: 'center' }}>
              No inventory matches "{query.trim()}"
            </div>
          )}

          {!loading && results?.parts?.length > 0 && (
            <>
              <GroupHeader label="PARTS" count={results.parts.length} />
              {results.parts.map(p => (
                <ResultRow
                  key={`p-${p.id}`}
                  icon="📦"
                  primary={
                    <>
                      {p.name}
                      {p.nickname && <span style={{ fontStyle: 'italic', color: 'var(--orange)', marginLeft: 6, fontWeight: 400 }}>aka {p.nickname}</span>}
                      {!p.isActive && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--amber)' }}>(draft)</span>}
                    </>
                  }
                  secondary={p.id}
                  onClick={() => handleSelectPart(p)}
                />
              ))}
            </>
          )}

          {!loading && results?.locations?.length > 0 && (
            <>
              <GroupHeader label="LOCATIONS" count={results.locations.length} />
              {results.locations.map(l => (
                <ResultRow
                  key={`l-${l.id}`}
                  icon="📍"
                  primary={l.displayLabel}
                  secondary={l.type}
                  onClick={() => handleSelectLocation(l)}
                />
              ))}
            </>
          )}

          {!loading && results?.stockPairs?.length > 0 && (
            <>
              <GroupHeader label="STOCK" count={results.stockPairs.length} />
              {results.stockPairs.map((s, i) => (
                <ResultRow
                  key={`s-${s.partId}-${s.locationId}-${i}`}
                  icon="↔"
                  primary={`${s.partName} @ ${s.locationLabel}`}
                  secondary={`${s.qty.toLocaleString()} units`}
                  onClick={() => handleSelectStockPair(s)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function GroupHeader({ label, count }) {
  return (
    <div style={{
      padding: '6px 12px 2px',
      fontSize: 9, fontWeight: 800,
      color: 'var(--muted)',
      letterSpacing: 0.6,
    }}>
      {label} ({count})
    </div>
  )
}

function ResultRow({ icon, primary, secondary, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%', textAlign: 'left',
        padding: '8px 12px',
        background: 'transparent', border: 'none',
        borderRadius: 'var(--r-xs)',
        cursor: 'pointer',
        fontSize: 13,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {primary}
        </div>
        <div style={{ fontSize: 11, color: 'var(--hint)', fontFamily: '"DM Mono", monospace' }}>
          {secondary}
        </div>
      </div>
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>→</span>
    </button>
  )
}
