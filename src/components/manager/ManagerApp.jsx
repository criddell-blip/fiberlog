import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import SubmissionsQueue from './SubmissionsQueue'
import CrewStatus from './CrewStatus'
import ProjectManager from './ProjectManager'
import ReportsView from './ReportsView'
import AdminPanel from './AdminPanel'
import AssemblyEditor from './AssemblyEditor'
import InventoryView from './InventoryView'

const isCompletedTask = t => t.status === 'done' || t.status === 'approved'

function useIsWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= 768)
  useEffect(() => {
    const fn = () => setWide(window.innerWidth >= 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return wide
}

const NAV_ITEMS = [
  { id: 'submissions', label: 'Approvals',   icon: '✅' },
  { id: 'crew',        label: 'Crew',         icon: '👷' },
  { id: 'projects',    label: 'Projects',     icon: '📋' },
  { id: 'reports',     label: 'Reports',      icon: '📊' },
  { id: 'assemblies',  label: 'Assemblies',   icon: '🔧' },
  { id: 'inventory',   label: 'Inventory',    icon: '📦' },
]

// ─── Theme toggle ─────────────────────────────────────────────────────────────
// Bigger, labeled, and visually distinct so it's actually findable.
// Sources state from AppContext, so it stays in sync across crew + manager.
function ThemeToggle({ darkMode, onToggle, compact = false }) {
  return (
    <button
      onClick={onToggle}
      title={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: compact ? '4px 8px' : '6px 10px',
        borderRadius: 999,
        border: '1.5px solid var(--border2)',
        background: 'var(--surface2)',
        color: 'var(--text)',
        cursor: 'pointer',
        fontSize: compact ? 11 : 12,
        fontWeight: 700,
        flexShrink: 0,
        transition: 'background .15s',
      }}
    >
      <span style={{ fontSize: compact ? 13 : 15, lineHeight: 1 }}>
        {darkMode ? '🌙' : '☀️'}
      </span>
      <span>{darkMode ? 'Dark' : 'Light'}</span>
    </button>
  )
}

// ─── WIDE SIDEBAR ─────────────────────────────────────────────────────────────
function ManagerSidebar({ tab, setTab, projects, currentUser, selectUser, darkMode, toggleDarkMode, isOwner }) {
  const nav = isOwner ? [...NAV_ITEMS, { id: 'admin', label: 'Admin', icon: '⚙️' }] : NAV_ITEMS

  const totalTasks = projects.reduce((a, p) => a + p.phases.reduce((b, ph) => b + ph.tasks.length, 0), 0)
  const doneTasks  = projects.reduce((a, p) => a + p.phases.reduce((b, ph) => b + ph.tasks.filter(isCompletedTask).length, 0), 0)
  const overallPct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0

  return (
    <div style={{
      width: 220, flexShrink: 0, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%', overflow: 'hidden'
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 4, height: 22, background: 'var(--orange)', borderRadius: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.3px' }}>FiberLog</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
          </div>
        </div>

        {/* Theme toggle on its own row, always visible */}
        <div style={{ marginBottom: 10 }}>
          <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} compact />
        </div>

        {/* User row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%',
            background: currentUser?.role === 'owner' ? 'var(--orange)' : 'var(--orange-lt)',
            color: currentUser?.role === 'owner' ? 'white' : 'var(--orange)',
            border: currentUser?.role === 'owner' ? 'none' : '1.5px solid var(--orange-dk)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 11, flexShrink: 0
          }}>{currentUser?.initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentUser?.name}</div>
            <button onClick={() => selectUser(null)}
              style={{ fontSize: 10, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ padding: '8px 8px 4px', flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--hint)', padding: '4px 8px 6px' }}>Menu</div>
        {nav.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 10px', borderRadius: 'var(--r-sm)', marginBottom: 2,
            background: tab === n.id ? 'var(--orange-lt)' : 'transparent',
            border: tab === n.id ? '1px solid var(--orange-dk)' : '1px solid transparent',
            color: tab === n.id ? 'var(--orange)' : 'var(--muted)',
            cursor: 'pointer', textAlign: 'left', fontWeight: tab === n.id ? 700 : 500,
          }}>
            <span style={{ fontSize: 16 }}>{n.icon}</span>
            <span style={{ fontSize: 13 }}>{n.label}</span>
          </button>
        ))}
      </div>

      {tab === 'projects' && (
        <>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0', flexShrink: 0 }} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 8px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--hint)', padding: '4px 8px 6px' }}>Projects</div>
            {projects.map(p => {
              const totalT = p.phases.reduce((a, ph) => a + ph.tasks.length, 0)
              const doneT  = p.phases.reduce((a, ph) => a + ph.tasks.filter(isCompletedTask).length, 0)
              const pct = totalT > 0 ? Math.round(doneT / totalT * 100) : 0
              return (
                <div key={p.id} style={{
                  padding: '8px 10px', borderRadius: 'var(--r-sm)', marginBottom: 4,
                  background: 'var(--surface2)', cursor: 'default'
                }}>
                  <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                  <div style={{ height: 3, background: 'var(--border2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--orange)', borderRadius: 2 }} />
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{pct}%</div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {tab !== 'projects' && (
        <div style={{ flex: 1 }} />
      )}

      {/* Overall progress bar at bottom */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>Overall progress</div>
        <div style={{ height: 4, background: 'var(--border2)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${overallPct}%`, height: '100%', background: 'var(--orange)', borderRadius: 2 }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--orange)', fontWeight: 700, marginTop: 4 }}>{overallPct}% complete</div>
      </div>
    </div>
  )
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function ManagerApp() {
  // Theme is sourced from AppContext (centralized + persisted) instead of
  // local component state — that way it survives reloads and stays in sync
  // across the crew app too.
  const { projects, loading, error, reload, currentUser, selectUser, darkMode, toggleDarkMode } = useApp()
  const [tab, setTab] = useState('submissions')
  const isWide = useIsWide()
  const isOwner = currentUser?.role === 'owner'

  const nav = isOwner ? [...NAV_ITEMS, { id: 'admin', label: 'Admin', icon: '⚙️' }] : NAV_ITEMS

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid var(--surface2)', borderTopColor: 'var(--orange)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading FiberLog...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, padding: 24 }}>
      <div style={{ fontSize: 32 }}>⚠️</div>
      <div style={{ fontWeight: 700 }}>Could not connect</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>{error}</div>
      <button className="btn btn-primary" onClick={reload}>Retry</button>
    </div>
  )

  const content = (
    <>
      {tab === 'submissions' && <SubmissionsQueue />}
      {tab === 'crew'        && <CrewStatus />}
      {tab === 'projects'    && <ProjectManager />}
      {tab === 'reports'     && <ReportsView />}
      {tab === 'assemblies'  && <AssemblyEditor />}
      {tab === 'inventory'   && <InventoryView />}
      {tab === 'admin'       && <AdminPanel />}
    </>
  )

  // ── WIDE LAYOUT ─────────────────────────────────────────────────────────────
  if (isWide) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg)' }}>
        <ManagerSidebar
          tab={tab} setTab={setTab}
          projects={projects}
          currentUser={currentUser} selectUser={selectUser}
          darkMode={darkMode} toggleDarkMode={toggleDarkMode}
          isOwner={isOwner}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {content}
        </div>
      </div>
    )
  }

  // ── NARROW LAYOUT (phone) ───────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0, gap: 8
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{ width: 6, height: 28, background: 'var(--orange)', borderRadius: 3, flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.3px', color: 'var(--text)' }}>FiberLog</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} compact />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{currentUser?.name}</div>
            <button onClick={() => selectUser(null)}
              style={{ fontSize: 10, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Sign out
            </button>
          </div>
          <div style={{
            width: 34, height: 34, borderRadius: '50%',
            background: currentUser?.role === 'owner' ? 'var(--orange)' : 'var(--orange-lt)',
            color: currentUser?.role === 'owner' ? 'white' : 'var(--orange)',
            border: currentUser?.role === 'owner' ? 'none' : '1.5px solid var(--orange-dk)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 12, flexShrink: 0
          }}>{currentUser?.initials}</div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {content}
      </div>

      {/* Bottom nav */}
      <div style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', display: 'flex', flexShrink: 0 }}>
        {nav.map(n => (
          <button key={n.id} onClick={() => setTab(n.id)} style={{
            flex: 1, padding: '8px 0 12px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            background: 'none', border: 'none', cursor: 'pointer',
            borderTop: `2px solid ${tab === n.id ? 'var(--orange)' : 'transparent'}`,
            color: tab === n.id ? 'var(--orange)' : 'var(--hint)'
          }}>
            <span style={{ fontSize: 18 }}>{n.icon}</span>
            <span style={{ fontSize: 10, fontWeight: 600 }}>{n.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
