import { useState } from 'react'
import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'

const CREW_TYPE_LABELS = (lang) => ({
  aerial:      t('aerial', lang),
  underground: t('underground', lang),
  splice:      t('splice', lang),
  drop:        t('drop', lang),
  locator:     t('locator', lang),
  contractor:  t('contractor', lang),
})

export default function UserSheet({ onClose }) {
  const { users, currentUser, login, logout, lang } = useApp()
  const [pendingUser, setPendingUser] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [shake, setShake] = useState(false)

  function handleSelect(user) {
    if (user.id === currentUser?.id) return
    if (!user.email) {
      setError(lang === 'es' ? 'Cuenta no migrada' : 'User not migrated')
      return
    }
    setPendingUser(user)
    setPassword('')
    setError('')
  }

  async function handleLogin() {
    const { error: loginError } = await login(pendingUser, password)
    if (loginError) {
      setError(lang === 'es' ? 'Contraseña incorrecta' : 'Incorrect password')
      setShake(true)
      setPassword('')
      setTimeout(() => setShake(false), 500)
    } else {
      onClose()
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="overlay-sheet">

        {/* Password prompt for switching user */}
        {pendingUser ? (
          <>
            <style>{`
              @keyframes shake {
                0%, 100% { transform: translateX(0); }
                20% { transform: translateX(-10px); }
                40% { transform: translateX(10px); }
                60% { transform: translateX(-8px); }
                80% { transform: translateX(8px); }
              }
            `}</style>
            <div style={{ animation: shake ? 'shake 0.4s ease' : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: '50%',
                  background: pendingUser.role === 'manager' ? 'var(--orange-lt)' : 'var(--surface2)',
                  border: pendingUser.role === 'manager' ? '2px solid var(--orange-dk)' : '1px solid var(--border2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800, fontSize: 18,
                  color: pendingUser.role === 'manager' ? 'var(--orange)' : 'var(--muted)',
                  marginBottom: 10,
                }}>
                  {pendingUser.initials}
                </div>
                <div style={{ fontWeight: 800, fontSize: 17 }}>{pendingUser.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {lang === 'es' ? 'Ingresa tu contraseña' : 'Enter your password'}
                </div>
              </div>

              <div className="field">
                <input
                  type="password"
                  placeholder={lang === 'es' ? 'Contraseña' : 'Password'}
                  value={password}
                  onChange={e => { setPassword(e.target.value); setError('') }}
                  onKeyDown={e => e.key === 'Enter' && handleLogin()}
                  autoFocus
                  style={{
                    width: '100%', padding: '12px 14px', fontSize: 16,
                    border: `1.5px solid ${error ? 'var(--red)' : 'var(--border2)'}`,
                    borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                    color: 'var(--text)', outline: 'none', textAlign: 'center', letterSpacing: 4,
                  }}
                />
                {error && (
                  <div style={{ fontSize: 12, color: 'var(--red)', textAlign: 'center', marginTop: 6, fontWeight: 600 }}>
                    {error}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }}
                  onClick={() => { setPendingUser(null); setPassword(''); setError('') }}>
                  {t('cancel', lang)}
                </button>
                <button className="btn btn-primary" style={{ flex: 2 }}
                  onClick={handleLogin} disabled={!password.trim()}>
                  {lang === 'es' ? 'Entrar' : 'Sign in'}
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Current user info */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--border)' }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'var(--orange)', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 16, color: 'white',
              }}>
                {currentUser?.initials}
              </div>
              <div>
                <div style={{ fontWeight: 800, fontSize: 15 }}>{currentUser?.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {CREW_TYPE_LABELS(lang)[currentUser?.crew_type] || currentUser?.crew_type}
                </div>
              </div>
            </div>

            {/* Switch user list */}
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
              {lang === 'es' ? 'Cambiar usuario' : 'Switch user'}
            </div>

            <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 12 }}>
              {users.filter(u => u.role === 'crew' || u.role === 'manager').filter(u => u.id !== currentUser?.id).map(u => (
                <div
                  key={u.id}
                  onClick={() => handleSelect(u)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 'var(--r-sm)',
                    background: 'var(--bg)', marginBottom: 4, cursor: 'pointer',
                    border: '1px solid transparent',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--bg)'}
                >
                  <div style={{
                    width: 34, height: 34, borderRadius: '50%',
                    background: 'var(--surface2)', border: '1px solid var(--border2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, fontWeight: 700, color: 'var(--muted)', flexShrink: 0
                  }}>
                    {u.initials}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{u.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {CREW_TYPE_LABELS(lang)[u.crew_type] || u.crew_type}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>
                {t('close', lang)}
              </button>
              <button className="btn btn-danger" style={{ flex: 1 }}
                onClick={async () => { await logout(); onClose(); }}>
                {t('signOut', lang)}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
