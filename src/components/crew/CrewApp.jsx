import { useState } from 'react'
import { useApp } from '../../AppContext'
import { useIsWide } from '../../lib/useIsWide'
import ProjectList from './ProjectList'
import PhaseList from './PhaseList'
import TaskList from './TaskList'
import TaskWorkspace from './TaskWorkspace'
import TaskSummaryView from './TaskSummaryView'
import MyStockView from './MyStockView'

// Tasks in these states aren't editable from the crew workspace — they go
// to the read-only TaskSummaryView so the crew can inspect what they
// submitted without thinking they can re-edit it. (Manager flagging is
// the only path that flips it back to 'open' for re-editing.)
const isReadOnlyTask = t => t.status === 'pending' || t.status === 'approved' || t.status === 'done'

// "Back to manager" pill — only rendered for staff users acting as crew
// via the manager↔crew toggle. Helps them flip back without signing out
// and back in. The visual style intentionally differs from the theme
// toggle so it reads as a mode-switch action, not a setting.
function BackToManagerButton({ exitCrewMode, compact = false }) {
  return (
    <button
      onClick={exitCrewMode}
      title="Return to the manager portal"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: compact ? '4px 8px' : '6px 10px',
        borderRadius: 999,
        border: '1.5px solid var(--teal)',
        background: 'var(--surface2)',
        color: 'var(--teal-mid)',
        cursor: 'pointer',
        fontSize: compact ? 11 : 12,
        fontWeight: 700,
        flexShrink: 0,
      }}>
      <span style={{ fontSize: compact ? 12 : 14, lineHeight: 1 }}>⚙️</span>
      <span>Manager</span>
    </button>
  )
}

// Small theme toggle — mirrors ManagerApp's ThemeToggle so the same pill
// shows up wherever a user can flip dark/light. Without this, crew on a
// tablet outdoors had no way to switch out of dark mode.
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
      }}
    >
      <span style={{ fontSize: compact ? 13 : 15, lineHeight: 1 }}>
        {darkMode ? '🌙' : '☀️'}
      </span>
      <span>{darkMode ? 'Dark' : 'Light'}</span>
    </button>
  )
}

const JOB_COLORS = {
  aerial:      { bg: 'var(--teal-lt)',   text: 'var(--teal-mid)' },
  underground: { bg: 'var(--amber-lt)',  text: 'var(--amber)' },
  splice:      { bg: 'var(--blue-lt)',   text: 'var(--blue)' },
  fiber_pull:  { bg: 'var(--purple-lt)', text: 'var(--purple)' },
  emergency:   { bg: 'var(--red-lt)',    text: 'var(--red)' },
}
const JOB_ICONS = { aerial: '🏗️', underground: '⛏️', splice: '🔌', fiber_pull: '📦', emergency: '⚡' }

// Tasks the crew can still act on in the sidebar. Submitted (pending) tasks
// are hidden — once the crew submits, the task should disappear from the
// sidebar so it doesn't look like there's still work to do. The main
// TaskList panel still surfaces them in a "Submitted" section. If the
// manager flags a submission, SubmissionsQueue reverts the task to 'open'
// so it reappears here.
const isActiveCrewTask = t => t.status !== 'done' && t.status !== 'approved' && t.status !== 'pending'
const isCompletedTask = t => t.status === 'done' || t.status === 'approved'

// ─── SIGN OUT CONFIRM ─────────────────────────────────────────────────────────
// Hosts the theme toggle for narrow layouts (sidebar isn't rendered).
// Also hosts the back-to-manager pill when applicable.
function SignOutConfirm({ onConfirm, onCancel, lang, darkMode, toggleDarkMode, exitCrewMode }) {
  const { currentUser } = useApp()
  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ textAlign: 'center' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--orange)', margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: 18, color: 'white',
        }}>
          {currentUser?.initials}
        </div>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>{currentUser?.name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
          {lang === 'es' ? '¿Cerrar sesión?' : 'Sign out?'}
        </div>
        {(toggleDarkMode || exitCrewMode) && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
            {toggleDarkMode && <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} />}
            {exitCrewMode && <BackToManagerButton exitCrewMode={exitCrewMode} />}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>
            {lang === 'es' ? 'Cancelar' : 'Cancel'}
          </button>
          <button className="btn btn-danger" style={{ flex: 2 }} onClick={onConfirm}>
            {lang === 'es' ? 'Cerrar sesión' : 'Sign out'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
function CrewSidebar({
  projects, selTask, view, onSelectMyStock, onSelectTask, onSelectPhase,
  currentUser, onUserTap, darkMode, toggleDarkMode, exitCrewMode,
}) {
  const [expandedProject, setExpandedProject] = useState(projects[0]?.id || null)
  const [expandedPhase, setExpandedPhase] = useState(null)

  const isMyStock = view === 'mystock'

  return (
    <div style={{
      width: 220, flexShrink: 0, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%', overflow: 'hidden'
    }}>
      {/* User header */}
      <div style={{
        padding: '14px 14px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0
      }}>
        <button
          onClick={onUserTap}
          style={{
            width: 36, height: 36, borderRadius: '50%',
            background: currentUser?.role === 'owner' ? 'var(--orange)' : 'var(--orange-lt)',
            color: currentUser?.role === 'owner' ? 'white' : 'var(--orange)',
            border: '1.5px solid var(--orange-dk)',
            fontWeight: 800, fontSize: 12, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
          }}
        >
          {currentUser?.initials || 'Me'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {currentUser?.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
            {currentUser?.crew_type || 'Crew'}
            {exitCrewMode && (
              <span style={{ marginLeft: 6, color: 'var(--teal-mid)', fontWeight: 700 }}>· acting as crew</span>
            )}
          </div>
        </div>
      </div>

      {/* My Stock entry — sits above the project tree per the design.
          Active state mirrors the main panel's view. */}
      <button
        onClick={onSelectMyStock}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: isMyStock ? 'var(--orange-lt)' : 'transparent',
          border: 'none',
          borderLeft: isMyStock ? '3px solid var(--orange)' : '3px solid transparent',
          color: isMyStock ? 'var(--orange)' : 'var(--text)',
          fontWeight: isMyStock ? 800 : 600,
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 16 }}>📦</span>
        <span>My Stock</span>
      </button>

      {/* Project / phase / task tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 20px' }}>
        <div style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '.06em', color: 'var(--hint)', padding: '8px 14px 4px'
        }}>Projects</div>

        {projects.map(p => {
          const isExpP = expandedProject === p.id
          const totalTasks = p.phases.reduce((a, ph) => a + ph.tasks.length, 0)
          const doneTasks = p.phases.reduce((a, ph) => a + ph.tasks.filter(isCompletedTask).length, 0)
          const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0

          return (
            <div key={p.id}>
              <div
                onClick={() => setExpandedProject(isExpP ? null : p.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  background: isExpP ? 'var(--surface2)' : 'transparent',
                }}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: 7, flexShrink: 0,
                  background: 'var(--orange-lt)', border: '1.5px solid var(--orange-dk)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 800, color: 'var(--orange)', letterSpacing: '-0.5px'
                }}>
                  {p.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div style={{ height: 3, background: 'var(--border2)', borderRadius: 2, marginTop: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--orange)', borderRadius: 2 }} />
                  </div>
                </div>
                <span style={{
                  fontSize: 12, color: 'var(--muted)', flexShrink: 0,
                  display: 'inline-block',
                  transform: isExpP ? 'rotate(90deg)' : 'none', transition: 'transform .15s'
                }}>›</span>
              </div>

              {isExpP && p.phases.map(ph => {
                const isExpPh = expandedPhase === ph.id
                const openTasks = ph.tasks.filter(isActiveCrewTask)

                return (
                  <div key={ph.id}>
                    <div
                      onClick={() => {
                        setExpandedPhase(isExpPh ? null : ph.id)
                        onSelectPhase(p, ph)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 14px 7px 22px', cursor: 'pointer',
                        background: isExpPh ? 'var(--surface2)' : 'transparent',
                      }}
                    >
                      <div style={{ fontSize: 11, color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {ph.name}
                      </div>
                      {openTasks.length > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '1px 6px',
                          borderRadius: 20, background: 'var(--orange-lt)', color: 'var(--orange)', flexShrink: 0
                        }}>{openTasks.length}</span>
                      )}
                      <span style={{
                        fontSize: 11, color: 'var(--hint)', flexShrink: 0,
                        display: 'inline-block',
                        transform: isExpPh ? 'rotate(90deg)' : 'none', transition: 'transform .15s'
                      }}>›</span>
                    </div>

                    {isExpPh && ph.tasks.filter(isActiveCrewTask).map(t => {
                      const type = t.type || t.task_type || 'aerial'
                      const icon = JOB_ICONS[type] || '🏗️'
                      const isActive = selTask?.id === t.id
                      const isPending = t.status === 'pending'

                      return (
                        <div
                          key={t.id}
                          onClick={() => onSelectTask(p, ph, t)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 14px 7px 30px', cursor: 'pointer',
                            background: isActive ? 'var(--orange-lt)' : 'transparent',
                            borderLeft: isActive ? '3px solid var(--orange)' : '3px solid transparent',
                          }}
                        >
                          <span style={{ fontSize: 13, flexShrink: 0 }}>{icon}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12, fontWeight: isActive ? 700 : 500,
                              color: isActive ? 'var(--orange)' : 'var(--text)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }}>{t.name}</div>
                          </div>
                          {isPending && (
                            <span style={{
                              fontSize: 9, fontWeight: 700, padding: '1px 5px',
                              borderRadius: 20, background: 'var(--amber-lt)',
                              color: 'var(--amber)', flexShrink: 0
                            }}>•</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      <div style={{
        padding: '10px 14px', borderTop: '1px solid var(--border)',
        flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 4, height: 18, background: 'var(--orange)', borderRadius: 2 }} />
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.3px' }}>FiberLog</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {exitCrewMode && <BackToManagerButton exitCrewMode={exitCrewMode} compact />}
          {toggleDarkMode && <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} compact />}
        </div>
      </div>
    </div>
  )
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function CrewApp() {
  const { projects, currentUser, selectUser, loading, error, lang, darkMode, toggleDarkMode, viewMode, exitCrewMode } = useApp()
  const isWide = useIsWide()
  // Only show the back-to-manager pill when a staff user is acting as
  // crew via the toggle. Regular crew users never see it.
  const isStaffActingAsCrew =
    (currentUser?.role === 'owner' || currentUser?.role === 'manager') && viewMode === 'crew'
  const backToManager = isStaffActingAsCrew ? exitCrewMode : null

  const [screen, setScreen] = useState('projects')
  // Wide-layout main-panel view. 'projects' (default) shows the project
  // tree → TaskList/TaskWorkspace flow. 'mystock' replaces the right panel
  // with MyStockView. Narrow layout uses `screen` instead for the same
  // distinction (screen='mystock' is a peer of 'projects'/'phases'/etc.).
  const [view, setView] = useState('projects')
  // We track selections by ID, not by snapshot — so they always pick up the
  // latest data from `projects` (which AppContext keeps in sync via realtime
  // and createTask/approval flows).
  const [selProjectId, setSelProjectId] = useState(null)
  const [selPhaseId, setSelPhaseId] = useState(null)
  const [selTaskId, setSelTaskId] = useState(null)
  const [showSignOut, setShowSignOut] = useState(false)

  // Live-derived selection from current projects state. If a task gets added,
  // approved, or modified, these refs update on the next render automatically.
  const selProject = selProjectId ? projects.find(p => p.id === selProjectId) || null : null
  const selPhase = selProject && selPhaseId
    ? selProject.phases.find(ph => ph.id === selPhaseId) || null
    : null
  const selTask = selPhase && selTaskId
    ? selPhase.tasks.find(t => t.id === selTaskId) || null
    : null

  function navTo(s) { setScreen(s) }

  function handleSidebarTaskSelect(project, phase, task) {
    setSelProjectId(project.id)
    setSelPhaseId(phase.id)
    setSelTaskId(task.id)
    setView('projects')
  }

  function handleSignOut() {
    selectUser(null)
    setShowSignOut(false)
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid var(--teal-lt)', borderTopColor: 'var(--teal)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading FiberLog...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, padding: 24 }}>
      <div style={{ fontSize: 32 }}>⚠️</div>
      <div style={{ fontWeight: 700 }}>Could not connect</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>{error}</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Retry</button>
    </div>
  )

  // ── WIDE LAYOUT ─────────────────────────────────────────────────────────────
  if (isWide) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg)' }}>
        <CrewSidebar
          projects={projects}
          selTask={selTask}
          view={view}
          onSelectMyStock={() => setView('mystock')}
          onSelectTask={handleSidebarTaskSelect}
          onSelectPhase={(project, phase) => {
            setSelProjectId(project.id); setSelPhaseId(phase.id); setSelTaskId(null)
            setView('projects')
          }}
          currentUser={currentUser}
          onUserTap={() => setShowSignOut(true)}
          darkMode={darkMode}
          toggleDarkMode={toggleDarkMode}
          exitCrewMode={backToManager}
        />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {view === 'mystock' ? (
            <MyStockView onUserTap={() => setShowSignOut(true)} />
          ) : !selTask ? (
            selProject && selPhase ? (
              <TaskList
                project={selProject}
                phase={selPhase}
                onSelect={t => { setSelTaskId(t.id) }}
                onBack={() => setSelPhaseId(null)}
                onUserTap={() => setShowSignOut(true)}
              />
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', flexDirection: 'column', gap: 12, color: 'var(--muted)'
              }}>
                <div style={{ fontSize: 40 }}>👈</div>
                <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Pick a project from the sidebar</div>
                <div style={{ fontSize: 13 }}>Expand a project → phase → task to start logging</div>
              </div>
            )
          ) : isReadOnlyTask(selTask) ? (
            <TaskSummaryView
              project={selProject}
              phase={selPhase}
              task={selTask}
              onBack={() => setSelTaskId(null)}
              onUserTap={() => setShowSignOut(true)}
            />
          ) : (
            <TaskWorkspace
              project={selProject}
              phase={selPhase}
              task={selTask}
              onBack={() => setSelTaskId(null)}
              onSubmitDone={() => setSelTaskId(null)}
              onUserTap={() => setShowSignOut(true)}
            />
          )}
        </div>

        {showSignOut && (
          <SignOutConfirm
            lang={lang}
            onConfirm={handleSignOut}
            onCancel={() => setShowSignOut(false)}
            darkMode={darkMode}
            toggleDarkMode={toggleDarkMode}
            exitCrewMode={backToManager}
          />
        )}
      </div>
    )
  }

  // ── NARROW LAYOUT ───────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {screen === 'projects' && (
        <ProjectList
          onSelect={p => { setSelProjectId(p.id); navTo('phases') }}
          onOpenMyStock={() => navTo('mystock')}
          onUserTap={() => setShowSignOut(true)}
        />
      )}
      {screen === 'mystock' && (
        <MyStockView
          onBack={() => navTo('projects')}
          onUserTap={() => setShowSignOut(true)}
        />
      )}
      {screen === 'phases' && selProject && (
        <PhaseList
          project={selProject}
          onSelect={ph => { setSelPhaseId(ph.id); navTo('tasks') }}
          onBack={() => navTo('projects')}
          onUserTap={() => setShowSignOut(true)}
        />
      )}
      {screen === 'tasks' && selPhase && (
        <TaskList
          project={selProject}
          phase={selPhase}
          onSelect={t => { setSelTaskId(t.id); navTo('workspace') }}
          onBack={() => navTo('phases')}
          onUserTap={() => setShowSignOut(true)}
        />
      )}
      {screen === 'workspace' && selTask && (
        isReadOnlyTask(selTask) ? (
          <TaskSummaryView
            project={selProject}
            phase={selPhase}
            task={selTask}
            onBack={() => navTo('tasks')}
            onUserTap={() => setShowSignOut(true)}
          />
        ) : (
          <TaskWorkspace
            project={selProject}
            phase={selPhase}
            task={selTask}
            onBack={() => navTo('tasks')}
            onSubmitDone={() => { setSelTaskId(null); navTo('projects') }}
            onUserTap={() => setShowSignOut(true)}
          />
        )
      )}
      {showSignOut && (
        <SignOutConfirm
          lang={lang}
          onConfirm={handleSignOut}
          onCancel={() => setShowSignOut(false)}
          darkMode={darkMode}
          toggleDarkMode={toggleDarkMode}
          exitCrewMode={backToManager}
        />
      )}
    </div>
  )
}
