import { useState, useEffect } from 'react'
import { useApp } from '../../../AppContext'
import { useIsWide } from '../../../lib/useIsWide'
import { useBackClose } from '../../../lib/backStack'
import Icon from '../../shared/Icon'
import { getInfraTree, subscribeToAllTaskChanges } from '../../../lib/supabase'
import MyStockView from '../MyStockView'
import TaskWorkspace from '../TaskWorkspace'
import TaskSummaryView from '../TaskSummaryView'
import SitesList from './SitesList'
import SiteTaskList from './SiteTaskList'
// Shared crew-shell chrome + task-state predicates (extracted from the
// former byte-identical copies in this file and CrewApp.jsx).
import SignOutConfirm, { BackToManagerButton, ThemeToggle } from '../SignOutConfirm'
import { isReadOnlyTask, isActiveCrewTask, isCompletedTask } from '../taskState'

// ─── ABOUT THIS SHELL ─────────────────────────────────────────────────────────
// Infrastructure crews work against SITES (towers, business installs, MDU
// equipment closets) — not fiber phases. This shell mirrors CrewApp's overall
// shape (sidebar + workspace, wide + narrow layouts, MyStock entry, sign-out)
// but pivots the project tree on `sites` instead of `phases`.
//
// Routing decision: App.jsx checks currentUser.crew_type and renders this
// for crew_type === 'infrastructure'. Every other crew_type continues to
// render the existing CrewApp unchanged — zero blast radius for fiber crews.
//
// Tasks anchor to either phase_id (fiber) or site_id (infra), enforced by
// the tasks_anchor_present CHECK constraint. We load the infra tree via
// getInfraTree() — a sites-shaped variant of getFullTree() that only returns
// projects which actually have sites.

const SITE_TYPE_ICON_NAME = {
  wireless: 'pin',
  fiber:    'warehouse',
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────────
// Projects → Sites → Tasks tree. Same visual language as the fiber sidebar so
// crews moving between roles see consistent affordances, but the middle layer
// is sites with type icons (wireless 📡 / fiber 🏢) instead of phase names.
function InfraSidebar({
  projects, selTask, view, onSelectMyStock, onSelectTask, onSelectSite,
  currentUser, onUserTap, darkMode, toggleDarkMode, exitCrewMode,
}) {
  // Remember which project this user last had open (see CrewSidebar — the
  // old auto-expand-first default opened Heber for everyone). Keyed by
  // user id; collapsed on first-ever login.
  const expandKey = 'fiberlog_expanded_project_' + (currentUser?.id || 'anon')
  const [expandedProject, setExpandedProject] = useState(() => {
    try { return localStorage.getItem(expandKey) || null } catch { return null }
  })
  const [expandedSite, setExpandedSite] = useState(null)
  function expandProject(id) {
    setExpandedProject(id)
    try {
      if (id) localStorage.setItem(expandKey, id)
      else localStorage.removeItem(expandKey)
    } catch {}
  }

  const isMyStock = view === 'mystock'

  return (
    <div style={{
      width: 220, flexShrink: 0, background: 'var(--surface)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', height: '100%', overflow: 'hidden'
    }}>
      {/* User header — see CrewApp.jsx for the layout rationale. Two
          stacked rows: user info, then a settings ribbon (theme +
          back-to-manager pills). Mirrors ManagerApp so working managers
          find the mode toggle in the same spot in both portals. */}
      <div style={{
        padding: '14px 14px 12px', borderBottom: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0
      }}>
       <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={onUserTap}
          className={`avatar avatar-md${currentUser?.role === 'owner' ? ' avatar-owner' : ''}`}
          style={{ cursor: 'pointer' }}
        >
          {currentUser?.initials || 'Me'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {currentUser?.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
            Infrastructure
            {exitCrewMode && (
              <span style={{ marginLeft: 6, color: 'var(--teal-mid)', fontWeight: 700 }}>· acting as crew</span>
            )}
          </div>
        </div>
       </div>

       {(toggleDarkMode || exitCrewMode) && (
         <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
           {toggleDarkMode && <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} compact />}
           {exitCrewMode && <BackToManagerButton exitCrewMode={exitCrewMode} compact />}
         </div>
       )}
      </div>

      {/* My Stock entry — same affordance as fiber shell. */}
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
        <Icon name="box" size={17} />
        <span>My Stock</span>
      </button>

      {/* Project / site / task tree */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0 20px' }}>
        <div className="sec-label" style={{ padding: '8px 14px 4px', margin: 0 }}>Projects</div>

        {projects.length === 0 && (
          <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--muted)' }}>
            No projects with sites yet.
          </div>
        )}

        {projects.map(p => {
          const isExpP = expandedProject === p.id
          const totalTasks = p.sites.reduce((a, s) => a + s.tasks.length, 0)
          const doneTasks  = p.sites.reduce((a, s) => a + s.tasks.filter(isCompletedTask).length, 0)
          const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0

          return (
            <div key={p.id}>
              <div
                onClick={() => {
                  // Mirror CrewApp's behavior: tap-to-collapse keeps the
                  // current selection, tap-to-expand also navigates to this
                  // project's first site so the right panel updates instead
                  // of feeling like nothing happened.
                  if (isExpP) {
                    expandProject(null)
                  } else {
                    expandProject(p.id)
                    if (p.sites && p.sites.length > 0) {
                      onSelectSite(p, p.sites[0])
                    }
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', cursor: 'pointer',
                  background: isExpP ? 'var(--surface2)' : 'transparent',
                }}
              >
                <div className="icon-pill ip-orange" style={{
                  width: 28, height: 28, borderRadius: 7,
                  border: '1.5px solid var(--orange-dk)',
                  fontSize: 10, fontWeight: 800, color: 'var(--orange)', letterSpacing: '-0.5px'
                }}>
                  {p.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
                    {p.sites.length} site{p.sites.length === 1 ? '' : 's'}
                  </div>
                  <div className="prog-bar prog-bar-sm">
                    <div className="prog-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                <span style={{
                  color: 'var(--muted)', flexShrink: 0, display: 'inline-flex',
                  transform: isExpP ? 'rotate(90deg)' : 'none', transition: 'transform .15s'
                }}><Icon name="chevron-right" size={14} /></span>
              </div>

              {isExpP && p.sites.map(s => {
                const isExpS = expandedSite === s.id
                const openTasks = s.tasks.filter(isActiveCrewTask)
                const iconName = SITE_TYPE_ICON_NAME[s.type] || 'pin'

                return (
                  <div key={s.id}>
                    <div
                      onClick={() => {
                        setExpandedSite(isExpS ? null : s.id)
                        onSelectSite(p, s)
                      }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '7px 14px 7px 22px', cursor: 'pointer',
                        background: isExpS ? 'var(--surface2)' : 'transparent',
                      }}
                    >
                      <span style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--accent-dk)' }}><Icon name={iconName} size={14} /></span>
                      <div style={{ fontSize: 11, color: 'var(--muted)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.name}
                      </div>
                      {openTasks.length > 0 && (
                        <span className="pill pill-accent pill-sm" style={{ flexShrink: 0 }}>{openTasks.length}</span>
                      )}
                      <span style={{
                        color: 'var(--hint)', flexShrink: 0, display: 'inline-flex',
                        transform: isExpS ? 'rotate(90deg)' : 'none', transition: 'transform .15s'
                      }}><Icon name="chevron-right" size={13} /></span>
                    </div>

                    {isExpS && s.tasks.filter(isActiveCrewTask).map(t => {
                      const isActive = selTask?.id === t.id
                      const isPending = t.status === 'pending'
                      return (
                        <div
                          key={t.id}
                          onClick={() => onSelectTask(p, s, t)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '7px 14px 7px 30px', cursor: 'pointer',
                            background: isActive ? 'var(--orange-lt)' : 'transparent',
                            borderLeft: isActive ? '3px solid var(--orange)' : '3px solid transparent',
                          }}
                        >
                          <span style={{ flexShrink: 0, display: 'inline-flex', color: 'var(--hint)' }}><Icon name="box" size={13} /></span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12, fontWeight: isActive ? 700 : 500,
                              color: isActive ? 'var(--orange)' : 'var(--text)',
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                            }}>{t.name}</div>
                          </div>
                          {isPending && (
                            <span className="pill pill-warning pill-dot" style={{ flexShrink: 0 }} title="Submitted" />
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

      {/* Footer — just the wordmark. Toggles moved to the header
          ribbon so they're discoverable in the same spot as ManagerApp. */}
      <div style={{
        padding: '10px 14px', borderTop: '1px solid var(--border)',
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6
      }}>
        <div style={{ width: 4, height: 18, background: 'var(--orange)', borderRadius: 2 }} />
        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.3px' }}>
          FiberLog <span style={{ fontWeight: 500, color: 'var(--muted)' }}>· Infra</span>
        </span>
      </div>
    </div>
  )
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function InfraCrewApp() {
  const { currentUser, selectUser, lang, darkMode, toggleDarkMode, viewMode, exitCrewMode } = useApp()
  const isWide = useIsWide()
  // Only render the back-to-manager pill for staff users acting as crew
  // via the toggle. Regular crew users (role=crew) never see it.
  const isStaffActingAsCrew =
    (currentUser?.role === 'owner' || currentUser?.role === 'manager') && viewMode === 'crew'
  const backToManager = isStaffActingAsCrew ? exitCrewMode : null

  // Local infra tree — the global AppContext.projects holds the fiber-shaped
  // tree (phases). Infra needs sites, so we maintain our own state here. The
  // realtime task subscription below keeps it fresh; getInfraTree() handles
  // the initial load.
  const [infraProjects, setInfraProjects] = useState([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState(null)

  const [screen, setScreen] = useState('projects')   // narrow nav
  const [view, setView]     = useState('projects')   // wide nav (projects | mystock)
  const [selProjectId, setSelProjectId] = useState(null)
  const [selSiteId, setSelSiteId]       = useState(null)
  const [selTaskId, setSelTaskId]       = useState(null)
  const [showSignOut, setShowSignOut]   = useState(false)

  // Live-derived selection, same pattern as CrewApp — IDs are persisted in
  // state but the live objects come from infraProjects so updates flow.
  const selProject = selProjectId ? infraProjects.find(p => p.id === selProjectId) || null : null
  const selSite    = selProject && selSiteId
    ? selProject.sites.find(s => s.id === selSiteId) || null
    : null
  const selTask    = selSite && selTaskId
    ? selSite.tasks.find(t => t.id === selTaskId) || null
    : null

  async function loadTree() {
    try {
      setTreeLoading(true)
      setTreeError(null)
      const tree = await getInfraTree()
      setInfraProjects(tree)
    } catch (err) {
      console.error('InfraTree load failed:', err)
      setTreeError(err.message)
    } finally {
      setTreeLoading(false)
    }
  }

  useEffect(() => { loadTree() }, [])

  // Realtime: keep infra tree fresh when tasks change anywhere in the system.
  // AppContext's global subscriber updates the FIBER tree (projects/phases)
  // and won't touch infraProjects, so this shell needs its own.
  //
  // We try/catch the whole subscribe + return — earlier a channel-name
  // collision with AppContext's subscriber threw synchronously during
  // setup, the error bubbled out of useEffect, and React rendered nothing
  // (blank screen on login). Channel names are now unique, but defending
  // here means any future realtime breakage degrades to "no live updates"
  // instead of "shell doesn't render."
  useEffect(() => {
    if (!currentUser?.id) return
    let sub
    try {
      sub = subscribeToAllTaskChanges({
      onUpdate: (task) => {
        if (!task.site_id) return  // not an infra task — ignore
        setInfraProjects(prev => prev.map(p => ({
          ...p,
          sites: p.sites.map(s => {
            if (s.id !== task.site_id) return s
            if (!s.tasks.some(t => t.id === task.id)) return s
            return {
              ...s,
              tasks: s.tasks.map(t => t.id === task.id
                ? { ...t, ...task,
                    type: task.task_type || t.type,
                    notes: task.scope_notes || t.notes }
                : t)
            }
          })
        })))
      },
      onInsert: (task) => {
        if (!task.site_id) return
        setInfraProjects(prev => prev.map(p => ({
          ...p,
          sites: p.sites.map(s => {
            if (s.id !== task.site_id) return s
            if (s.tasks.some(t => t.id === task.id)) return s
            return {
              ...s,
              tasks: [...s.tasks, {
                ...task,
                type: task.task_type || 'task',
                notes: task.scope_notes || '',
                creator: null,
              }]
            }
          })
        })))
      },
      onDelete: (task) => {
        if (!task.site_id) return
        setInfraProjects(prev => prev.map(p => ({
          ...p,
          sites: p.sites.map(s => ({
            ...s,
            tasks: s.tasks.filter(t => t.id !== task.id)
          }))
        })))
      },
      })
    } catch (e) {
      console.warn('InfraCrewApp: realtime subscription failed; live updates disabled this session.', e)
    }
    return () => { try { sub?.unsubscribe() } catch {} }
  }, [currentUser?.id])

  function navTo(s) { setScreen(s) }
  function handleSignOut() { selectUser(null); setShowSignOut(false) }

  // ── Browser/phone Back button ───────────────────────────────────────────────
  // Same as CrewApp, but the middle layer is `sites` instead of `phases`. Back
  // walks workspace → tasks → sites → projects in the narrow layout. See
  // lib/backStack.js.
  const screenDepth = { projects: 0, mystock: 1, sites: 1, tasks: 2, workspace: 3 }[screen] || 0
  useBackClose(isWide ? 0 : screenDepth, () => {
    if (screen === 'workspace') navTo('tasks')
    else if (screen === 'tasks') navTo('sites')
    else if (screen === 'sites') navTo('projects')
    else if (screen === 'mystock') navTo('projects')
  })
  // Wide layout: sidebar-driven selection. Back steps task → site → project list.
  const wideSelDepth = isWide ? (selTaskId ? 3 : selSiteId ? 2 : selProjectId ? 1 : 0) : 0
  useBackClose(wideSelDepth, () => {
    if (selTaskId) setSelTaskId(null)
    else if (selSiteId) setSelSiteId(null)
    else if (selProjectId) setSelProjectId(null)
  })
  // Wide layout: My Stock is a peer toggle over the current selection.
  useBackClose(isWide && view === 'mystock' ? 1 : 0, () => setView('projects'))
  useBackClose(showSignOut ? 1 : 0, () => setShowSignOut(false))

  function handleSidebarTaskSelect(project, site, task) {
    setSelProjectId(project.id)
    setSelSiteId(site.id)
    setSelTaskId(task.id)
    setView('projects')
  }

  // TaskWorkspace was built for the fiber phase-shaped flow. We adapt by
  // passing a phase-shaped shim (`{ id: site.id, name: site.name }`).
  // TaskWorkspace only reads phase.id (for AppContext.setTaskLocal, which
  // is a latency-hiding hint that's harmless if it no-ops) and phase.name
  // (for display in the header). The submit path goes through save_log_entry
  // which is anchored on session_id/task_id — not phase_id — so it works
  // unchanged. approve_submission's auto-deduct now handles infra approvals
  // too: its project lookup chain is override → phases.project_id →
  // sites.project_id, so materials transfer truck → site's project bucket
  // on approval. Phase actuals stay skipped (no site-actuals concept).
  const workspacePhaseShim = selSite ? { id: selSite.id, name: selSite.name } : null

  if (treeLoading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid var(--teal-lt)', borderTopColor: 'var(--teal)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading FiberLog...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (treeError) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, padding: 24 }}>
      <div style={{ color: 'var(--red)' }}><Icon name="alert" size={32} /></div>
      <div style={{ fontWeight: 700 }}>Could not load sites</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>{treeError}</div>
      <button className="btn btn-primary" onClick={loadTree}>Retry</button>
    </div>
  )

  // ── WIDE LAYOUT ─────────────────────────────────────────────────────────────
  if (isWide) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'var(--bg)' }}>
        <InfraSidebar
          projects={infraProjects}
          selTask={selTask}
          view={view}
          onSelectMyStock={() => setView('mystock')}
          onSelectTask={handleSidebarTaskSelect}
          onSelectSite={(project, site) => {
            setSelProjectId(project.id); setSelSiteId(site.id); setSelTaskId(null)
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
            selProject && selSite ? (
              // key= forces remount when the site (or project) changes —
              // otherwise SiteTaskList's local state lags behind the sidebar
              // selection. Same pattern on TaskWorkspace + TaskSummaryView.
              <SiteTaskList
                key={selSite.id}
                project={selProject}
                site={selSite}
                onSelect={t => { setSelTaskId(t.id) }}
                onBack={() => setSelSiteId(null)}
                onUserTap={() => setShowSignOut(true)}
                onTaskCreated={() => loadTree()}
              />
            ) : selProject ? (
              <SitesList
                key={selProject.id}
                project={selProject}
                onSelect={s => { setSelSiteId(s.id); setSelTaskId(null) }}
                onBack={() => setSelProjectId(null)}
                onUserTap={() => setShowSignOut(true)}
              />
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', flexDirection: 'column', gap: 12, color: 'var(--muted)',
                padding: 20,
              }}>
                <div style={{ color: 'var(--gray-mid)', display: 'flex', justifyContent: 'center' }}><Icon name="arrow" size={34} style={{ transform: 'scaleX(-1)' }} /></div>
                <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>Pick a project from the sidebar</div>
                <div style={{ fontSize: 13 }}>Expand a project → site → task to start logging</div>

                {/* Same day-flow card as the fiber crew shell, with "site"
                    swapped in for "phase" since infra anchors on sites. */}
                <div style={{
                  marginTop: 24, padding: '16px 20px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', maxWidth: 420, width: '100%',
                  textAlign: 'left',
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--muted)',
                    textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10,
                  }}>
                    Your day in 3 steps
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text)' }}>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <span style={{ fontWeight: 800, color: 'var(--orange)' }}>1.</span>
                      <span>
                        📦 <strong>Load up</strong> — tap <strong>My Stock</strong> at the top of the sidebar and load parts onto your truck before heading out.
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <span style={{ fontWeight: 800, color: 'var(--orange)' }}>2.</span>
                      <span>
                        📡 <strong>Work the task</strong> — pick a project → site → task, tally parts and time as you go.
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <span style={{ fontWeight: 800, color: 'var(--orange)' }}>3.</span>
                      <span>
                        ✅ <strong>Submit passdown</strong> when the task is done. Your manager reviews it; auto-deduct moves the materials off your truck into the project's region.
                      </span>
                    </div>
                  </div>
                  <div style={{
                    marginTop: 12, paddingTop: 10,
                    borderTop: '1px solid var(--border)',
                    fontSize: 11, color: 'var(--hint)', fontStyle: 'italic',
                  }}>
                    End of day, drop back to My Stock to return anything you didn't use.
                  </div>
                </div>
              </div>
            )
          ) : isReadOnlyTask(selTask) ? (
            <TaskSummaryView
              key={selTask.id}
              project={selProject}
              phase={workspacePhaseShim}
              task={selTask}
              onBack={() => setSelTaskId(null)}
              onUserTap={() => setShowSignOut(true)}
            />
          ) : (
            <TaskWorkspace
              key={selTask.id}
              project={selProject}
              phase={workspacePhaseShim}
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
        <InfraProjectsScreen
          projects={infraProjects}
          onSelectProject={p => { setSelProjectId(p.id); navTo('sites') }}
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
      {screen === 'sites' && selProject && (
        <SitesList
          key={selProject.id}
          project={selProject}
          onSelect={s => { setSelSiteId(s.id); navTo('tasks') }}
          onBack={() => navTo('projects')}
          onUserTap={() => setShowSignOut(true)}
        />
      )}
      {screen === 'tasks' && selProject && selSite && (
        <SiteTaskList
          key={selSite.id}
          project={selProject}
          site={selSite}
          onSelect={t => { setSelTaskId(t.id); navTo('workspace') }}
          onBack={() => navTo('sites')}
          onUserTap={() => setShowSignOut(true)}
          onTaskCreated={() => loadTree()}
        />
      )}
      {screen === 'workspace' && selTask && (
        isReadOnlyTask(selTask) ? (
          <TaskSummaryView
            key={selTask.id}
            project={selProject}
            phase={workspacePhaseShim}
            task={selTask}
            onBack={() => navTo('tasks')}
            onUserTap={() => setShowSignOut(true)}
          />
        ) : (
          <TaskWorkspace
            key={selTask.id}
            project={selProject}
            phase={workspacePhaseShim}
            task={selTask}
            onBack={() => navTo('tasks')}
            // Land back on the site's task list (1 step up), not the project
            // root — the task stays open under is_closed and ascending one
            // level avoids the multi-entry history unwind that can bounce the
            // browser out of the app on submit (see lib/backStack.js).
            onSubmitDone={() => { setSelTaskId(null); navTo('tasks') }}
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

// ─── NARROW: PROJECTS SCREEN ──────────────────────────────────────────────────
// Top-level list of infra projects for phone/small-screen layout. Tapping a
// project drills into its SitesList. MyStock and sign-out live in the header.
function InfraProjectsScreen({ projects, onSelectProject, onOpenMyStock, onUserTap }) {
  const { currentUser } = useApp()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '14px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        background: 'var(--surface)',
      }}>
        <button
          onClick={onUserTap}
          className={`avatar avatar-md${currentUser?.role === 'owner' ? ' avatar-owner' : ''}`}
          style={{ cursor: 'pointer' }}
        >
          {currentUser?.initials || 'Me'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>Projects</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>Infrastructure</div>
        </div>
        <button
          className="btn btn-ghost"
          onClick={onOpenMyStock}
          style={{ padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Icon name="box" size={14} /> My Stock
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {projects.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No projects with sites yet.
          </div>
        )}
        {projects.map(p => {
          const totalTasks = p.sites.reduce((a, s) => a + s.tasks.length, 0)
          const openTasks  = p.sites.reduce((a, s) => a + s.tasks.filter(isActiveCrewTask).length, 0)
          return (
            <button
              key={p.id}
              onClick={() => onSelectProject(p)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: 14, marginBottom: 8,
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r)', cursor: 'pointer', textAlign: 'left',
                color: 'var(--text)',
              }}
            >
              <div className="icon-pill ip-orange" style={{
                width: 40, height: 40, borderRadius: 'var(--r-md)',
                border: '1.5px solid var(--orange-dk)',
                fontSize: 12, fontWeight: 800, color: 'var(--orange)'
              }}>
                {p.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="mono">{p.sites.length}</span> site{p.sites.length === 1 ? '' : 's'} · <span className="mono">{openTasks}</span> open / <span className="mono">{totalTasks}</span> total task{totalTasks === 1 ? '' : 's'}
                </div>
              </div>
              <Icon name="chevron-right" size={16} color="var(--hint)" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
