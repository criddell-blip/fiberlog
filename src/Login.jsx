import { useState, useEffect, useRef } from 'react'
import { useApp } from './AppContext'

// Standard username + password login. Replaces the old UserPicker now that
// crew rosters are growing past the point where a grid of avatars is useful.
//
// Username format: firstname.lastname (e.g. "francisco.molina"). The app
// auto-appends @fiberlog.utahbroadband.com to form the synthetic email
// stored in Supabase Auth. If the user types a full email (anything with
// an "@"), we use it as-is, so admins can still sign in with their real
// address if they're set up that way.

const EMAIL_DOMAIN = '@fiberlog.utahbroadband.com'
const REMEMBERED_USERNAME_KEY = 'fiberlog_remembered_username'

export default function Login() {
  const { users, login, darkMode } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [shake, setShake] = useState(false)
  const passwordRef = useRef(null)

  // Restore remembered username from localStorage on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBERED_USERNAME_KEY)
      if (saved) setUsername(saved)
    } catch (e) {
      // localStorage unavailable — fine, just start blank
    }
  }, [])

  // Build the email we'll send to Supabase Auth from whatever the user typed.
  // - "francisco.molina" → "francisco.molina@fiberlog.utahbroadband.com"
  // - "chris.riddell@fiberlog.utahbroadband.com" → unchanged
  // - "  Francisco.Molina  " → trimmed and lowercased
  function resolveEmail(raw) {
    const cleaned = (raw || '').trim().toLowerCase()
    if (!cleaned) return ''
    if (cleaned.includes('@')) return cleaned
    return cleaned + EMAIL_DOMAIN
  }

  async function handleSubmit(e) {
    if (e) e.preventDefault()
    if (submitting) return

    const trimmed = username.trim()
    if (!trimmed) {
      setError('Enter your username')
      return
    }
    if (!password) {
      setError('Enter your password')
      passwordRef.current?.focus()
      return
    }

    const email = resolveEmail(trimmed)

    // Find the local user record matching this email so we can pass the
    // full user object to login() — login() does the actual auth call,
    // we just need the user metadata.
    const matchingUser = (users || []).find(
      u => u.email && u.email.toLowerCase() === email
    )
    if (!matchingUser) {
      setError('Invalid login')
      setShake(true)
      setPassword('')
      setTimeout(() => setShake(false), 500)
      return
    }
    if (!matchingUser.is_active) {
      setError('This account is inactive — contact your manager')
      return
    }

    setSubmitting(true)
    setError('')

    const { error: loginError } = await login(matchingUser, password)

    if (loginError) {
      // Don't leak whether it was bad username vs bad password
      setError('Invalid login')
      setShake(true)
      setPassword('')
      setTimeout(() => setShake(false), 500)
      setSubmitting(false)
      return
    }

    // Persist (or clear) remembered username based on the checkbox
    try {
      if (remember) {
        localStorage.setItem(REMEMBERED_USERNAME_KEY, trimmed)
      } else {
        localStorage.removeItem(REMEMBERED_USERNAME_KEY)
      }
    } catch (e) {
      // Storage unavailable, oh well
    }

    setSubmitting(false)
    // login() already sets currentUser via context; RootRouter takes care
    // of redirecting to the right surface
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', padding: 20,
      background: 'var(--bg)',
    }}>
      <div style={{
        width: '100%', maxWidth: 380,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '32px 28px',
        animation: shake ? 'shake 0.4s ease' : 'none',
      }}>
        <style>{`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20% { transform: translateX(-10px); }
            40% { transform: translateX(10px); }
            60% { transform: translateX(-8px); }
            80% { transform: translateX(8px); }
          }
        `}</style>

        {/* Wordmark */}
        <div style={{
          fontSize: 32, fontWeight: 800, letterSpacing: '-1px',
          marginBottom: 4, lineHeight: 1, textAlign: 'center',
        }}>
          <span style={{ color: 'var(--text)' }}>Fiber</span>
          <span style={{ color: 'var(--orange)' }}>Log</span>
        </div>
        <div style={{
          fontSize: 12, color: 'var(--muted)', textAlign: 'center',
          marginBottom: 28,
        }}>
          Utah Broadband
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={e => { setUsername(e.target.value); setError('') }}
              placeholder="firstname.lastname"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              spellCheck="false"
              autoFocus={!username}
            />
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              Just your name — no email needed
            </div>
          </div>

          <div className="field">
            <label>Password</label>
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError('') }}
              autoComplete="current-password"
              autoFocus={!!username}
            />
          </div>

          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 13, color: 'var(--muted)', cursor: 'pointer',
            marginBottom: 16,
          }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Remember my username on this device
          </label>

          {error && (
            <div style={{
              padding: '10px 12px',
              background: 'var(--red-lt)', color: 'var(--red)',
              borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
              textAlign: 'center', fontWeight: 600,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ width: '100%' }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div style={{
          marginTop: 20, fontSize: 11, color: 'var(--hint)',
          textAlign: 'center', lineHeight: 1.5,
        }}>
          Forgot your password? Ask your manager — they can reset it from the Admin panel.
        </div>
      </div>
    </div>
  )
}
