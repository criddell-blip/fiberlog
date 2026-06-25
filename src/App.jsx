import { AppProvider, useApp } from './AppContext'
import CrewApp from './components/crew/CrewApp'
import InfraCrewApp from './components/crew/infra/InfraCrewApp'
import ManagerApp from './components/manager/ManagerApp'
import Login from './Login'
import SetNewPassword from './SetNewPassword'
import Icon from './components/shared/Icon'
import { VALID_FIELD_CREW_TYPES } from './lib/crewTypes'
import './styles/global.css'

function RootRouter() {
  const { currentUser, loading, error, reload, viewMode, recoveryMode } = useApp()

  // Opened from a password-reset link: force the set-new-password screen
  // before anything else, even if a (recovery) session already exists.
  if (recoveryMode) return <SetNewPassword />

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid var(--teal-lt)', borderTopColor: 'var(--teal)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading FiberLog...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  // If the initial fetch failed (Supabase down, network out, etc.) the
  // user list is empty and Login.jsx would silently say "Invalid login"
  // for every credential. Show the real error here instead so the user
  // knows it's not their password.
  if (error && !currentUser) return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', flexDirection: 'column', gap: 12, padding: 24,
      background: 'var(--bg)', color: 'var(--text)',
    }}>
      <div style={{ color: 'var(--red)' }}><Icon name="alert" size={32} /></div>
      <div style={{ fontWeight: 700, fontSize: 16 }}>Could not connect</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', maxWidth: 360 }}>
        FiberLog couldn't reach the server. Check your network and try again.
      </div>
      <div style={{ fontSize: 11, color: 'var(--hint)', textAlign: 'center', maxWidth: 360, fontFamily: 'monospace' }}>
        {error}
      </div>
      <button className="btn btn-primary" onClick={reload} style={{ marginTop: 8 }}>Retry</button>
    </div>
  )

  // No user signed in yet — show login form
  if (!currentUser) return <Login />

  // Route by role, then by crew_type for the crew shell. Infrastructure crews
  // work against sites (towers, business installs) — not phases — so they get
  // a sites-shaped shell. Every other crew_type (fiber_construction / splice
  // / drop / locator / contractor / install) stays on the existing CrewApp.
  //
  // Working-managers toggle: if a staff user (owner/manager) has a real
  // field crew_type AND flipped viewMode='crew', send them to the crew
  // shell so they can log their own day. Auto-deduct on approval still
  // requires their crew_type to be one of {fiber_construction, splice,
  // infrastructure} (that's the RPC's guard, not enforced here).
  const isStaff = currentUser.role === 'manager' || currentUser.role === 'owner'
  // A warehouse-only manager (restricted_to_inventory) must NOT be able to flip
  // into the crew shell even if they happen to carry a field crew_type — that
  // would bypass their inventory-only scoping. Mirror this guard in
  // ManagerApp's SwitchToCrewButton.
  const canActAsCrew = isStaff
    && VALID_FIELD_CREW_TYPES.includes(currentUser.crew_type)
    && !currentUser.restricted_to_inventory
  if (isStaff && viewMode === 'crew' && canActAsCrew) {
    return currentUser.crew_type === 'infrastructure' ? <InfraCrewApp /> : <CrewApp />
  }
  if (isStaff) return <ManagerApp />
  if (currentUser.crew_type === 'infrastructure') return <InfraCrewApp />
  return <CrewApp />
}

export default function App() {
  return (
    <AppProvider>
      <RootRouter />
    </AppProvider>
  )
}
