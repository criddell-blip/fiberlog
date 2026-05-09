import { createContext, useContext, useState, useEffect } from 'react'
import { db, getFullTree, getAssemblies, getUsers, subscribeToAllTaskChanges } from './lib/supabase'

const AppContext = createContext(null)

// LocalStorage key for the theme preference. Read once at first render so
// there's no flash of dark mode for users who chose light.
const THEME_STORAGE_KEY = 'fiberlog_dark_mode'

function readInitialDarkMode() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved !== null) return saved === 'true'
  } catch (e) {
    // localStorage unavailable (private mode etc.) — fall through to default
  }
  return true   // default to dark, matching the original :root variables
}

export function AppProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [assemblies, setAssemblies] = useState({})
  const [users, setUsers] = useState([])
  const [currentUser, setCurrentUser] = useState(null)
  const [currentSession, setCurrentSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  // Theme is global state so the toggle works the same way no matter which
  // sub-app the user is in (crew or manager), and it persists across reloads.
  const [darkMode, setDarkMode] = useState(readInitialDarkMode)

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

  function updateTask(projectId, phaseId, task) {
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

  return (
    <AppContext.Provider value={{
      projects, setProjects,
      assemblies,
      users,
      currentUser, selectUser,
      login, logout,
      lang: currentUser?.language || 'en',
      currentSession, setCurrentSession,
      loading, error,
      toast, showToast,
      updateTask,
      reload: loadAll,
      // Theme
      darkMode, setDarkMode, toggleDarkMode,
    }}>
      {children}
      {toast && <div className="toast">{toast}</div>}
    </AppContext.Provider>
  )
}

export function useApp() {
  return useContext(AppContext)
}
