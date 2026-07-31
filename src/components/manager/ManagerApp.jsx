import { useState, useEffect } from 'react'
import { crewTypeLabel, VALID_FIELD_CREW_TYPES } from '../../lib/crewTypes'
import { visibleManagerTabs, canActAsCrew, staffScope } from '../../lib/access'
import { updateUserMetadata } from '../../lib/admin'
import { useApp } from '../../AppContext'
import { useIsWide } from '../../lib/useIsWide'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'
import SubmissionsQueue from './SubmissionsQueue'
import CrewStatus from './CrewStatus'
import ProjectManager from './ProjectManager'
import ReportsView from './ReportsView'
import AdminPanel from './AdminPanel'
import AssemblyEditor from './AssemblyEditor'
import InventoryView from './InventoryView'

// Console nav — line icons (Icon component) replace the old emoji.
const NAV_ITEMS = [
  { id: 'submissions', label: 'Approvals',  icon: 'check' },
  { id: 'crew',        label: 'Crew',        icon: 'users' },
  { id: 'projects',    label: 'Projects',    icon: 'folder' },
  { id: 'reports',     label: 'Reports',     icon: 'chart' },
  { id: 'assemblies',  label: 'Assemblies',  icon: 'nut' },
  { id: 'inventory',   label: 'Inventory',   icon: 'box' },
]

// ─── Theme + crew-mode pills ────────────────────────────────────────────────
// Dark-slate Console shipped, so the theme toggle is now a live control. Styled
// with the accent (not muted) so it reads as obviously clickable and isn't
// confused with the disabled "Crew mode" pill beside it. Label shows the mode
// you'll switch TO; emoji flips sun/moon.
function ThemeToggle({ darkMode, onToggle }) {
  // HIDDEN: the dark-mode toggle is a confirmed no-op (real bug — clicking it
  // never visibly switches the theme, even in clean incognito with the dark
  // CSS verified live). Hidden so users don't see a dead control. The dark
  // palette stays dormant (default light). Restore by deleting this return
  // once the toggle bug is fixed. See backlog.
  return null
  // eslint-disable-next-line no-unreachable
  return (
    <button
      onClick={onToggle}
      title={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px',
        borderRadius: 999, border: '1.5px solid var(--accent)', background: 'var(--accent-lt)',
        color: 'var(--accent-dk)', cursor: 'pointer', fontSize: 11.5, fontWeight: 700, flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>{darkMode ? '☀️' : '🌙'}</span>
      <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
    </button>
  )
}

// Two-part pill. The body is "go" (using the crew_type already on the row);
// the chevron is "go as something else" — it persists a new crew_type, then
// goes. When the row has NO crew_type the whole pill opens the picker: it used
// to be a dead disabled button whose only escape hatch was the Admin → Users
// crew-type dropdown, which wasn't even rendered for owners. That was the trap.
//
// Still scope-gated. canActAsCrew() rejects warehouse/accounting on SCOPE
// regardless of crew_type, so handing them a picker would only let them write
// a value they could never use — they keep the plain disabled pill.
function SwitchToCrewButton({ currentUser, enterCrewMode, onOpenCrewPicker }) {
  const canCrew = canActAsCrew(currentUser)
  const isFullStaff = staffScope(currentUser) === 'full'

  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px',
    border: `1px solid ${isFullStaff ? 'var(--accent)' : 'var(--border2)'}`,
    background: isFullStaff ? 'var(--accent-lt)' : 'transparent',
    color: isFullStaff ? 'var(--accent-dk)' : 'var(--hint)',
    cursor: isFullStaff ? 'pointer' : 'not-allowed',
    fontSize: 11.5, fontWeight: 600,
  }

  if (!isFullStaff) {
    return (
      <button disabled style={{ ...base, borderRadius: 999, flexShrink: 0 }}
        title="Only full-access staff can switch to crew mode.">
        <Icon name="truck" size={13} /><span>Crew mode</span>
      </button>
    )
  }

  return (
    <div style={{ display: 'inline-flex', flexShrink: 0, minWidth: 0 }}>
      <button
        onClick={canCrew ? enterCrewMode : onOpenCrewPicker}
        title={canCrew
          ? `Switch to ${crewTypeLabel(currentUser.crew_type)} crew view to log your own work`
          : 'Pick a field crew type to start logging your own work'}
        style={{ ...base, borderRadius: '999px 0 0 999px', borderRight: 'none', minWidth: 0 }}>
        <Icon name="truck" size={13} />
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {canCrew ? crewTypeLabel(currentUser.crew_type) : 'Crew mode…'}
        </span>
      </button>
      <button
        onClick={onOpenCrewPicker}
        aria-label="Enter crew mode as a different crew type"
        title="Enter crew mode as a different crew type"
        style={{ ...base, borderRadius: '0 999px 999px 0', padding: '5px 8px' }}>
        <Icon name="chevron-down" size={12} />
      </button>
    </div>
  )
}

// ─── Console sidebar (shared by desktop rail + phone drawer) ─────────────────
function ConsoleSidebar({ nav, tab, onNavigate, currentUser, selectUser, darkMode, toggleDarkMode, enterCrewMode, onOpenCrewPicker, onClose }) {
  return (
    <div style={{
      width: onClose ? 300 : 236, flexShrink: 0, background: 'var(--sidebar)',
      borderRight: onClose ? 'none' : '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
    }}>
      {/* Brand row (60px) */}
      <div style={{
        height: 60, flexShrink: 0, padding: '0 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}><Icon name="box" size={16} /></div>
        <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.03em', flex: 1 }}>FiberLog</div>
        {onClose && (
          <button onClick={onClose} aria-label="Close menu" style={{
            width: 34, height: 34, borderRadius: 8, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: 'var(--muted)', background: 'transparent', cursor: 'pointer',
          }}><Icon name="x" size={20} /></button>
        )}
      </div>

      {/* Nav */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 12px' }}>
        <div className="eyebrow" style={{ padding: '0 10px 8px' }}>Menu</div>
        {nav.map(n => {
          const active = tab === n.id
          return (
            <button key={n.id} onClick={() => onNavigate(n.id)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 11,
              padding: '9px 11px', borderRadius: 8, marginBottom: 2,
              background: active ? 'var(--accent-lt)' : 'transparent',
              color: active ? 'var(--accent-dk)' : 'var(--muted)',
              boxShadow: active ? 'inset 2px 0 0 var(--accent)' : 'none',
              border: 'none', cursor: 'pointer', textAlign: 'left',
              fontSize: 13.5, fontWeight: active ? 700 : 600,
            }}>
              <Icon name={n.icon} size={18} />
              <span>{n.label}</span>
            </button>
          )
        })}
      </div>

      {/* Footer: toggles + user */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', padding: 12 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} />
          <SwitchToCrewButton currentUser={currentUser} enterCrewMode={enterCrewMode}
            onOpenCrewPicker={onOpenCrewPicker} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-lt)',
            color: 'var(--accent-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: 12, flexShrink: 0,
          }}>{currentUser?.initials}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentUser?.name}</div>
            <button onClick={() => selectUser(null)} style={{
              fontSize: 11, color: 'var(--hint)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}>Sign out</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function ManagerApp() {
  const { projects, loading, error, reload, currentUser, selectUser, darkMode, toggleDarkMode, enterCrewMode, refreshUsers, showToast } = useApp()
  const isWide = useIsWide()

  // Visible tabs come from the staff access scope (see lib/access.js):
  //   full       → all tabs + Admin
  //   warehouse  → Inventory + Reports + Admin
  //   accounting → Reports + Inventory (limited inside InventoryView)
  // The owner/manager boundary (owner-only account minting) is enforced
  // elsewhere (cannotPickOwner + admin-create-user), not by hiding Admin.
  const visibleTabIds = visibleManagerTabs(currentUser)
  const TAB_DEFS = [...NAV_ITEMS, { id: 'admin', label: 'Admin', icon: 'gear' }]
  const nav = TAB_DEFS.filter(t => visibleTabIds.includes(t.id))

  const homeTab = visibleTabIds[0] || 'inventory'
  const [tab, setTab] = useState(homeTab)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Defensive: keep the active tab within the allowed set (e.g. if scope changes).
  useEffect(() => {
    if (!visibleTabIds.includes(tab)) setTab(homeTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.role, currentUser?.staff_scope, currentUser?.restricted_to_inventory, tab])

  // Back button: phone drawer closes first; otherwise a non-home tab returns
  // to the home tab — on BOTH layouts now (the persistent desktop sidebar no
  // longer means top-level Back is skipped). In-tab drill-ins register their
  // own deeper layers, so Back unwinds detail → sub-tab → tab → home.
  useBackClose(drawerOpen ? 1 : 0, () => setDrawerOpen(false))
  useBackClose(tab !== homeTab ? 1 : 0, () => setTab(homeTab))

  // "Enter crew mode as…" picker. State lives HERE, not in ConsoleSidebar —
  // the sidebar is rendered twice (desktop rail + phone drawer) and unmounts
  // with the drawer, so hoisting gives one overlay and one Back layer.
  const [crewPicker, setCrewPicker] = useState(false)
  const [crewPickerSaving, setCrewPickerSaving] = useState(false)
  useBackClose(crewPicker ? 1 : 0, () => setCrewPicker(false))

  // Persist the chosen field crew type, then enter crew mode — one action.
  // Routing keys off users.crew_type (App.jsx), so switching fiber ↔ infra is
  // a save, not a live toggle. refreshUsers() re-points currentUser at the
  // saved row, and THAT is what makes App.jsx re-route; awaiting it before
  // enterCrewMode() avoids a frame where viewMode is 'crew' but canActAsCrew
  // is still false (which would silently bounce back to the manager shell).
  async function pickCrewTypeAndEnter(nextType) {
    if (!currentUser?.id) return
    setCrewPickerSaving(true)
    try {
      if (currentUser.crew_type !== nextType) {
        await updateUserMetadata(currentUser.id, { crew_type: nextType })
        await refreshUsers()
      }
      setCrewPicker(false)
      enterCrewMode()
    } catch (e) {
      showToast('Could not switch crew type: ' + e.message)
    } finally {
      setCrewPickerSaving(false)
    }
  }

  const crewPickerOverlay = crewPicker ? (
    <CrewTypePickerSheet
      currentUser={currentUser}
      saving={crewPickerSaving}
      onPick={pickCrewTypeAndEnter}
      onCancel={() => setCrewPicker(false)}
    />
  ) : null

  function navigate(id) { setTab(id); setDrawerOpen(false) }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 36, height: 36, border: '3px solid var(--surface2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading FiberLog...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 12, padding: 24 }}>
      <div style={{ color: 'var(--red)' }}><Icon name="alert" size={32} /></div>
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
        <ConsoleSidebar
          nav={nav} tab={tab} onNavigate={navigate}
          currentUser={currentUser} selectUser={selectUser}
          darkMode={darkMode} toggleDarkMode={toggleDarkMode}
          enterCrewMode={enterCrewMode}
          onOpenCrewPicker={() => setCrewPicker(true)}
        />
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {content}
        </div>
        {crewPickerOverlay}
      </div>
    )
  }

  // ── NARROW LAYOUT (phone) ───────────────────────────────────────────────────
  const activeLabel = nav.find(n => n.id === tab)?.label || 'FiberLog'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>
      {/* Top bar */}
      <div style={{
        height: 60, flexShrink: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
      }}>
        <button onClick={() => setDrawerOpen(true)} aria-label="Open menu" style={{
          width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: 'var(--text)', background: 'transparent', cursor: 'pointer',
        }}><Icon name="menu" size={22} /></button>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.01em' }}>{activeLabel}</div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {content}
      </div>

      {/* Drawer */}
      {drawerOpen && (
        <div
          onClick={e => e.target === e.currentTarget && setDrawerOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 200, display: 'flex',
            background: 'rgba(15,23,42,0.45)',
          }}
        >
          <div style={{ height: '100%', boxShadow: '0 0 40px rgba(0,0,0,0.25)', animation: 'drawerIn .2s ease' }}>
            <ConsoleSidebar
              nav={nav} tab={tab} onNavigate={navigate}
              currentUser={currentUser} selectUser={selectUser}
              darkMode={darkMode} toggleDarkMode={toggleDarkMode}
              enterCrewMode={enterCrewMode}
              onOpenCrewPicker={() => setCrewPicker(true)}
              onClose={() => setDrawerOpen(false)}
            />
          </div>
          <style>{`@keyframes drawerIn { from { transform: translateX(-100%); } to { transform: translateX(0); } }`}</style>
        </div>
      )}
      {crewPickerOverlay}
    </div>
  )
}

// ─── Crew-type picker ────────────────────────────────────────────────────────
// "Enter crew mode as…" — saves the crew type and opens the matching shell in
// one action. zIndex overrides .overlay's 100 because the phone nav drawer
// sits at 200 and this sheet is rendered as a sibling of it.
function CrewTypePickerSheet({ currentUser, saving, onPick, onCancel }) {
  return (
    <div className="overlay open" style={{ zIndex: 300 }}
      onClick={e => e.target === e.currentTarget && !saving && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 460, width: '100%', margin: '0 auto' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Enter crew mode as…</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Saves your crew type, then opens the matching crew app. Your manager access is
          unchanged — use the ⚙️ Manager pill to come back.
        </div>
        {VALID_FIELD_CREW_TYPES.map(ct => {
          const current = currentUser?.crew_type === ct
          return (
            <button key={ct} onClick={() => onPick(ct)} disabled={saving} style={{
              width: '100%', minHeight: 46, textAlign: 'left', marginBottom: 6,
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              border: `1.5px solid ${current ? 'var(--accent)' : 'var(--border2)'}`,
              background: current ? 'var(--accent-lt)' : 'var(--bg)',
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: current ? 'var(--accent-dk)' : 'var(--text)' }}>
                {crewTypeLabel(ct)}{current ? ' · current' : ''}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                {ct === 'infrastructure' ? 'Sites shell — towers / MDU' : 'Phases + tasks shell'}
                {/* approve_submission's auto-deduct guard covers
                    fiber_construction / field_service / infrastructure only, so
                    'install' logs work fine but moves no material on approval. */}
                {ct === 'install' ? ' · approvals will NOT auto-deduct materials' : ''}
              </div>
            </button>
          )
        })}
        <button className="btn btn-ghost" style={{ width: '100%', marginTop: 8 }}
          onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  )
}
