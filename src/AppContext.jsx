import { createContext, useContext, useState, useEffect } from 'react'
import { db, getFullTree, getAssemblies, getUsers, subscribeToAllTaskChanges, nextChannelSuffix } from './lib/supabase'

const AppContext = createContext(null)

// LocalStorage key for the theme preference. Read once at first render so
// there's no flash of dark mode for users who chose light.
const THEME_STORAGE_KEY = 'fiberlog_dark_mode'
// LocalStorage key for the manager↔crew view mode. Working managers (owner
// or manager role who also field-work) flip into the crew shell to log
// their own work; we persist so a reload doesn't bounce them back to the
// manager view mid-task.
const VIEW_MODE_KEY = 'fiberlog_view_mode'

function readInitialDarkMode() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved !== null) return saved === 'true'
  } catch (e) {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return true   // default to dark, matching the original :root variables
}

function readInitialViewMode() {
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY)
    if (saved === 'crew' || saved === 'manager') return saved
  } catch (e) {}
  return 'manager'  // sensible default for staff; non-staff ignore this entirely
}

export function AppProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [assemblies, setAssemblies] = useState({})
  const [users, setUsers] = useState([])
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  // True while the app is opened from a password-reset link. Supabase
  // establishes a temporary recovery session and fires a PASSWORD_RECOVERY
  // event; we gate the router on this so the user lands on the set-new-
  // password screen instead of being dropped straight into the app.
  const [recoveryMode, setRecoveryMode] = useState(false)
  // Org-wide inventory quantity display mode. 'tracking' shows the
  // numbers as today; 'paused' hides them and shows last-seen recency
  // instead (Sage is then the authoritative source). Loaded from
  // app_settings table at init + subscribed via realtime so flipping
  // the switch in one tab propagates to every connected client.
  const [qtyDisplayMode, setQtyDisplayMode] = useState('tracking')
  const [qtyDisplayUpdatedAt, setQtyDisplayUpdatedAt] = useState(null)
  const [qtyDisplayUpdatedBy, setQtyDisplayUpdatedBy] = useState(null)

  // Theme is global state so the toggle works the same way no matter which
  // sub-app the user is in (crew or manager), and it persists across reloads.
  const [darkMode, setDarkMode] = useState(readInitialDarkMode)

  // viewMode controls whether a staff user (owner / manager) sees the
  // manager portal or the crew shell. Crew users ignore this entirely —
  // App.jsx never reads viewMode for non-staff. Persisted to localStorage
  // so reload mid-task doesn't drop the manager back into the manager view.
  const [viewMode, setViewMode] = useState(readInitialViewMode)
  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode) } catch (e) {}
  }, [viewMode])
  function enterCrewMode() { setViewMode('crew') }
  function exitCrewMode()  { setViewMode('manager') }

  // Apply the theme attribute on <html> and persist to localStorage every
  // time it changes. The CSS [data-theme="light"] selector flips all the
  // CSS variables.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light')
    try {
      localStorage.setItem(THEME_STORAGE_KEY, String(darkMode))
    } catch (e) {
      // Ignore — preference just won't persist this session
    }
  }, [darkMode])

  function toggleDarkMode() {
    setDarkMode(d => !d)
  }

  useEffect(() => {
    loadAll()
  }, [])

  // Listen for the password-recovery auth event. When a user opens a reset
  // link, supabase-js (detectSessionInUrl is on by default) consumes the
  // token in the URL, signs them into a temporary recovery session, and
  // emits PASSWORD_RECOVERY. Flip recoveryMode so the router shows the
  // set-new-password screen. Registered once on mount.
  useEffect(() => {
    const { data: sub } = db.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true)
    })
    return () => { try { sub?.subscription?.unsubscribe() } catch (e) {} }
  }, [])

  // Keep the global project tree in sync with task changes happening anywhere
  // in the system (manager flagging a submission, another crew creating a
  // task, etc.). Without this the sidebar can show stale data — most visibly,
  // a task that was reverted from 'pending' back to 'open' on a flag won't
  // reappear until the user reloads. Subscribe only after a user is signed
  // in so we don't open a channel on the login screen.
  useEffect(() => {
    if (!currentUser?.id) return

    const sub = subscribeToAllTaskChanges({
      onUpdate: (task) => {
        // Infra tasks (phase_id NULL, site_id set) are owned by InfraCrewApp's
        // own subscriber — bail out early here so we don't pretend to handle
        // them and silently drop the update. Without the guard the .map()
        // below walks every phase looking for a NULL id which always misses,
        // wasting CPU and obscuring intent.
        if (!task.phase_id) return
        // Merge payload into the existing task to preserve the joined
        // `creator` field (realtime payloads don't include joins).
        setProjects(prev => prev.map(p => ({
          ...p,
          phases: p.phases.map(ph => {
            if (ph.id !== task.phase_id) return ph
            if (!ph.tasks.some(t => t.id === task.id)) return ph
            return {
              ...ph,
              tasks: ph.tasks.map(t => t.id === task.id
                ? { ...t, ...task,
                    type: task.task_type || t.type,
                    notes: task.scope_notes || t.notes }
                : t)
            }
          })
        })))
      },
      onInsert: (task) => {
        if (!task.phase_id) return  // infra tasks → InfraCrewApp's subscriber handles them
        // Add to the right phase if not already present. Creator is missing
        // (no join in realtime payload); the chip will just be absent until
        // next full reload — acceptable trade for not doing an extra query
        // on every insert.
        setProjects(prev => prev.map(p => ({
          ...p,
          phases: p.phases.map(ph => {
            if (ph.id !== task.phase_id) return ph
            if (ph.tasks.some(t => t.id === task.id)) return ph
            return {
              ...ph,
              tasks: [...ph.tasks, {
                ...task,
                type: task.task_type || 'aerial',
                notes: task.scope_notes || '',
                creator: null,
              }]
            }
          })
        })))
      },
      onDelete: (task) => {
        // Delete payloads only carry the OLD row's id reliably; phase_id may
        // also be in there but we don't gate on it — a fiber task delete with
        // missing phase_id should still flush from the tree. The filter is
        // already a no-op for ids we don't have.
        setProjects(prev => prev.map(p => ({
          ...p,
          phases: p.phases.map(ph => ({
            ...ph,
            tasks: ph.tasks.filter(t => t.id !== task.id)
          }))
        })))
      },
    })

    return () => sub.unsubscribe()
  }, [currentUser?.id])

  // Org-wide inventory display mode: fetch on auth + subscribe to
  // changes. Owner flips it from Admin; every connected client picks up
  // the change live.
  useEffect(() => {
    if (!currentUser?.id) return
    let cancelled = false

    async function loadMode() {
      try {
        const { data } = await db
          .from('app_settings')
          .select('value, updated_at, updated_by')
          .eq('key', 'inventory_qty_display_mode')
          .maybeSingle()
        if (cancelled || !data) return
        setQtyDisplayMode(data.value === 'paused' ? 'paused' : 'tracking')
        setQtyDisplayUpdatedAt(data.updated_at || null)
        setQtyDisplayUpdatedBy(data.updated_by || null)
      } catch (e) {
        console.warn('Load inventory display mode failed:', e)
      }
    }
    loadMode()

    // Defensively wrap the subscribe so a realtime throw degrades to "no live
    // updates" instead of bubbling into the render. Channel name via
    // nextChannelSuffix() (not Math.random) to match the project convention.
    let channel = null
    try {
      channel = db
        .channel('app_settings_inventory_qty_' + nextChannelSuffix())
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'app_settings', filter: 'key=eq.inventory_qty_display_mode' },
          payload => {
            const row = payload.new || payload.old
            if (!row) return
            setQtyDisplayMode(row.value === 'paused' ? 'paused' : 'tracking')
            setQtyDisplayUpdatedAt(row.updated_at || null)
            setQtyDisplayUpdatedBy(row.updated_by || null)
          }
        )
        .subscribe()
    } catch (e) {
      console.warn('app_settings realtime subscribe failed:', e)
    }

    return () => {
      cancelled = true
      try { if (channel) db.removeChannel(channel) } catch (e) { /* noop */ }
    }
  }, [currentUser?.id])

  async function loadAll() {
    try {
      setLoading(true)
      setError(null)

      // Check for an existing Supabase auth session
      const { data: { session } } = await db.auth.getSession()

      const [tree, asms, userList] = await Promise.all([
        getFullTree(),
        getAssemblies(),
        getUsers(),
      ])
      setProjects(tree)
      setAssemblies(asms)
      setUsers(userList)

      // Restore user only if Supabase still has a valid session
      if (session) {
        const matched = userList.find(u => u.id === session.user.id)
        if (matched) {
          setCurrentUser(matched)
        } else {
          // Session exists but no matching FiberLog user — clean up
          await db.auth.signOut()
        }
      } else {
        setCurrentUser(null)
      }
    } catch (err) {
      console.error('FiberLog init error:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function login(user, password) {
    if (!user.email) {
      return { error: 'No email on user — run auth migration' }
    }
    const { error } = await db.auth.signInWithPassword({
      email: user.email,
      password,
    })
    if (error) return { error: error.message }
    setCurrentUser(user)
    // Re-fetch data now that we have an authenticated session.
    // The initial loadAll ran as anon and likely got empty results
    // for tables that are authenticated-only.
    try {
      const [tree, asms] = await Promise.all([getFullTree(), getAssemblies()])
      setProjects(tree)
      setAssemblies(asms)
    } catch (e) {
      console.error('Post-login data reload failed:', e)
    }
    return { error: null }
  }

  async function logout() {
    await db.auth.signOut()
    setCurrentUser(null)
    setProjects([])
    setAssemblies({})
    // Reset view mode so the next login (potentially a different user)
    // doesn't inherit a stale "crew mode" preference.
    setViewMode('manager')
    try { localStorage.removeItem(VIEW_MODE_KEY) } catch (e) {}
  }

  // Kept for backward compatibility with existing call sites.
  // For an actual login use `login(user, password)`. Passing null logs out.
  function selectUser(user) {
    if (user) {
      setCurrentUser(user)
    } else {
      logout()
    }
  }

  function showToast(msg, duration = 3000) {
    setToast(msg)
    setTimeout(() => setToast(null), duration)
  }

  // Imperatively patch a task in the in-memory project tree. LOCAL-ONLY —
  // does not persist to the DB. Use this when you've already written to
  // the DB (or are about to) and want the UI to reflect the change before
  // the realtime subscription fires. The realtime listener will eventually
  // arrive at the same state, so this is a latency-hiding tool, not a
  // source of truth.
  function setTaskLocal(projectId, phaseId, task) {
    setProjects(prev => prev.map(p => {
      if (p.id !== projectId) return p
      return {
        ...p,
        phases: p.phases.map(ph => {
          if (ph.id !== phaseId) return ph
          const exists = ph.tasks.find(t => t.id === task.id)
          return {
            ...ph,
            tasks: exists
              ? ph.tasks.map(t => t.id === task.id ? task : t)
              : [...ph.tasks, task]
          }
        })
      }
    }))
  }

  // Refresh just the users list without toggling the global loading state.
  // Use this after a user CRUD action — full reload() flips loading=true,
  // which unmounts the manager portal tree and resets nav state (e.g.
  // AdminPanel's view='users' falls back to 'projects' on remount).
  async function refreshUsers() {
    try {
      const list = await getUsers()
      setUsers(list)
      // Keep currentUser in sync if their own row changed
      const me = currentUser?.id ? list.find(u => u.id === currentUser.id) : null
      if (me) setCurrentUser(me)
    } catch (e) {
      console.warn('refreshUsers failed:', e)
    }
  }

  // Change the signed-in user's OWN password. Works for a normal session
  // (in-app "Change password") and for the temporary recovery session.
  async function changeOwnPassword(newPassword) {
    const { error: err } = await db.auth.updateUser({ password: newPassword })
    if (err) throw new Error(err.message)
  }

  // Finish a password reset opened from an email link: set the new password
  // on the recovery session, clear recoveryMode, then reload so the now-valid
  // session routes the user into the app signed in.
  async function completePasswordReset(newPassword) {
    await changeOwnPassword(newPassword)
    setRecoveryMode(false)
    await loadAll()
  }

  // Owner-only: flip the org-wide inventory display mode. RLS enforces
  // owner-role on the write; non-owners hit a permission error.
  async function setInventoryQtyDisplayMode(nextMode) {
    if (nextMode !== 'tracking' && nextMode !== 'paused') {
      throw new Error('Invalid mode')
    }
    const { error: err } = await db
      .from('app_settings')
      .update({ value: nextMode, updated_by: currentUser?.id || null })
      .eq('key', 'inventory_qty_display_mode')
    if (err) throw err
    // Optimistic local update — realtime will reconfirm.
    setQtyDisplayMode(nextMode)
  }

  return (
    <AppContext.Provider value={{
      projects, setProjects,
      assemblies,
      users,
      currentUser, selectUser,
      login, logout,
      // Self-service password: recovery-link reset + in-app change
      recoveryMode, completePasswordReset, changeOwnPassword,
      lang: currentUser?.language || 'en',
      loading, error,
      toast, showToast,
      setTaskLocal,
      reload: loadAll,
      refreshUsers,
      // Theme
      darkMode, setDarkMode, toggleDarkMode,
      // View mode (manager↔crew toggle for working managers)
      viewMode, enterCrewMode, exitCrewMode,
      // Inventory display mode (org-wide pause switch)
      qtyDisplayMode,
      isQtyPaused: qtyDisplayMode === 'paused',
      qtyDisplayUpdatedAt,
      qtyDisplayUpdatedBy,
      setInventoryQtyDisplayMode,
    }}>
      {children}
      {toast && <div className="toast">{toast}</div>}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
