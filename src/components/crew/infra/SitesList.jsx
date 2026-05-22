import { useState, useMemo } from 'react'

// SitesList — middle layer of the infra navigation. Given an infra project
// (which carries its sites pre-loaded via getInfraTree), renders a searchable,
// type-filterable list of sites. Tapping a site drills into SiteTaskList.
//
// Per-site stats: count of open vs total tasks, with the standard pending-pill
// when a submission's mid-flight. No fancy progress bar yet — sites don't have
// a "% complete" concept the way phases do (a tower is binary done/not-done,
// not partial).

const SITE_TYPE_ICONS = {
  wireless: '📡',
  fiber:    '🏢',
}
const SITE_TYPE_LABELS = {
  wireless: 'Wireless',
  fiber:    'Fiber',
}

const isActiveCrewTask = t => t.status !== 'done' && t.status !== 'approved' && t.status !== 'pending'

export default function SitesList({ project, onSelect, onBack, onUserTap }) {
  const [query, setQuery]   = useState('')
  const [typeFilter, setTypeFilter] = useState('all')   // all | wireless | fiber

  // Available type filters — only show pills for types that actually exist
  // in this project's sites. Keeps the UI honest (no "Fiber" tab on a project
  // that's 100% wireless).
  const availableTypes = useMemo(() => {
    const set = new Set(project.sites.map(s => s.type))
    return Array.from(set)
  }, [project.sites])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return project.sites.filter(s => {
      if (typeFilter !== 'all' && s.type !== typeFilter) return false
      if (!q) return true
      return (
        s.name.toLowerCase().includes(q) ||
        (s.address || '').toLowerCase().includes(q)
      )
    })
  }, [project.sites, query, typeFilter])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header — back arrow + project name + user chip */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        background: 'var(--surface)',
      }}>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: 'var(--muted)', padding: 4
            }}
          >‹</button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {project.sites.length} site{project.sites.length === 1 ? '' : 's'}
          </div>
        </div>
        {onUserTap && (
          <button
            onClick={onUserTap}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--orange-lt)', color: 'var(--orange)',
              border: '1.5px solid var(--orange-dk)',
              fontWeight: 800, fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
            }}
          >👤</button>
        )}
      </div>

      {/* Search + type pills */}
      <div style={{ padding: '10px 14px', flexShrink: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search sites by name or address"
          autoComplete="off"
          name="site-search"
          style={{
            width: '100%', padding: '8px 12px', fontSize: 13,
            background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            boxSizing: 'border-box',
          }}
        />
        {availableTypes.length > 1 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              onClick={() => setTypeFilter('all')}
              style={pillStyle(typeFilter === 'all')}
            >All</button>
            {availableTypes.map(t => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                style={pillStyle(typeFilter === t)}
              >
                {SITE_TYPE_ICONS[t] || '📍'} {SITE_TYPE_LABELS[t] || t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sites list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            {query ? `No sites match "${query}".` : 'No sites yet in this project.'}
          </div>
        )}
        {filtered.map(s => {
          const open  = s.tasks.filter(isActiveCrewTask).length
          const total = s.tasks.length
          const icon  = SITE_TYPE_ICONS[s.type] || '📍'
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: 12, marginBottom: 8,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r)', cursor: 'pointer', textAlign: 'left',
                color: 'var(--text)',
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                background: 'var(--gray-lt)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16,
              }}>{icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {s.name}
                </div>
                {s.address && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.address}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 2 }}>
                  {open} open / {total} task{total === 1 ? '' : 's'}
                </div>
              </div>
              {open > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px',
                  borderRadius: 20, background: 'var(--orange-lt)', color: 'var(--orange)', flexShrink: 0
                }}>{open}</span>
              )}
              <span style={{ fontSize: 16, color: 'var(--hint)' }}>›</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function pillStyle(active) {
  return {
    padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: active ? 'var(--orange)' : 'var(--gray-lt)',
    color: active ? 'white' : 'var(--muted)',
    border: 'none', cursor: 'pointer',
  }
}
