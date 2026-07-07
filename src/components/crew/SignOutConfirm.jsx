import { useState } from 'react'
import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'
import Icon from '../shared/Icon'
import SetNewPassword from '../../SetNewPassword'

// Shared crew-shell chrome — SignOutConfirm plus the two settings pills it
// hosts (BackToManagerButton, ThemeToggle). Both crew shells (CrewApp and
// infra/InfraCrewApp) used to carry byte-identical copies of all of this
// with "KEEP IN SYNC" comments; extracted here so there's one copy.

// "Back to manager" pill — only rendered for staff users acting as crew
// via the manager↔crew toggle. Helps them flip back without signing out
// and back in. The visual style intentionally differs from the theme
// toggle so it reads as a mode-switch action, not a setting.
export function BackToManagerButton({ exitCrewMode, compact = false }) {
  return (
    <button
      onClick={exitCrewMode}
      title="Return to the manager portal"
      className={`settings-pill mode${compact ? ' compact' : ''}`}
    >
      <span style={{ display: 'inline-flex', lineHeight: 1 }}><Icon name="gear" size={compact ? 13 : 15} /></span>
      <span>Manager</span>
    </button>
  )
}

// Small theme toggle — mirrors ManagerApp's ThemeToggle so the same pill
// shows up wherever a user can flip dark/light. Without this, crew on a
// tablet outdoors had no way to switch out of dark mode.
export function ThemeToggle({ darkMode, onToggle, compact = false }) {
  // HIDDEN — dark-mode toggle no-ops (real bug, backlogged); dark CSS dormant.
  return null
  // eslint-disable-next-line no-unreachable
  return (
    <button
      onClick={onToggle}
      title={`Switch to ${darkMode ? 'light' : 'dark'} mode`}
      className={`settings-pill${compact ? ' compact' : ''}`}
    >
      <span style={{ fontSize: compact ? 13 : 15, lineHeight: 1 }}>
        {darkMode ? '🌙' : '☀️'}
      </span>
      <span>{darkMode ? 'Dark' : 'Light'}</span>
    </button>
  )
}

// ─── SIGN OUT CONFIRM ─────────────────────────────────────────────────────────
// Hosts the theme toggle for narrow layouts (sidebar isn't rendered).
// Also hosts the back-to-manager pill when applicable, plus the crew
// self-service language toggle (EN | Español) and the change-password
// entry point.
export default function SignOutConfirm({ onConfirm, onCancel, lang, darkMode, toggleDarkMode, exitCrewMode }) {
  const { currentUser, setLang } = useApp()
  const [showChangePw, setShowChangePw] = useState(false)
  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="overlay-sheet" style={{ textAlign: 'center' }}>
        <div className="avatar avatar-lg avatar-owner" style={{ margin: '0 auto 12px' }}>
          {currentUser?.initials}
        </div>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>{currentUser?.name}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 18 }}>
          {t('signOutQ', lang)}
        </div>
        {(toggleDarkMode || exitCrewMode) && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
            {toggleDarkMode && <ThemeToggle darkMode={darkMode} onToggle={toggleDarkMode} />}
            {exitCrewMode && <BackToManagerButton exitCrewMode={exitCrewMode} />}
          </div>
        )}
        {/* Language toggle — crew self-service (the manager-set
            users.language is only the default; this overrides per-device
            via localStorage.fiberlog_lang, kept across logouts). */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 12, color: 'var(--hint)' }}>🌐 {t('language', lang)}</span>
          <button type="button" onClick={() => setLang('en')} style={langPillStyle(lang !== 'es')}>EN</button>
          <button type="button" onClick={() => setLang('es')} style={langPillStyle(lang === 'es')}>Español</button>
        </div>
        <button
          type="button"
          onClick={() => setShowChangePw(true)}
          style={{
            width: '100%', marginBottom: 10, padding: '9px 12px',
            background: 'var(--surface2)', color: 'var(--text)',
            border: '1px solid var(--border2)', borderRadius: 'var(--r-sm)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >🔑 {t('changePassword', lang)}</button>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>
            {t('cancel', lang)}
          </button>
          <button className="btn btn-danger" style={{ flex: 2 }} onClick={onConfirm}>
            {t('signOut', lang)}
          </button>
        </div>
      </div>
      {showChangePw && <SetNewPassword asSheet onClose={() => setShowChangePw(false)} />}
    </div>
  )
}

// Small selected/unselected pill for the EN | Español toggle.
function langPillStyle(active) {
  return {
    padding: '5px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    fontWeight: active ? 800 : 500,
    border: `1.5px solid ${active ? 'var(--orange)' : 'var(--border2)'}`,
    background: active ? 'var(--orange-lt)' : 'var(--surface)',
    color: active ? 'var(--orange-dk)' : 'var(--muted)',
  }
}
