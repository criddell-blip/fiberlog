import { useState, useEffect, useRef } from 'react'
import { useApp } from './AppContext'
import { db } from './lib/supabase'

// Standard username + password login. Replaces the old UserPicker now that
// crew rosters are growing past the point where a grid of avatars is useful.
//
// Users sign in with the local-part of their login email — historically the
// synthetic "firstname.lastname" (@fiberlog.utahbroadband.com), now migrating
// to their real company mailbox prefix (e.g. "criddell"@utahbroadband.com).
// A full email (anything with an "@") is matched as-is. See resolveUserByLogin.

const REMEMBERED_USERNAME_KEY = 'fiberlog_remembered_username'

// Gate for the self-service "Forgot password?" email-reset flow. It only
// works once custom SMTP (Google Workspace) + the reset redirect URL are
// configured in the Supabase dashboard — until then a reset would say "check
// your email" but send nothing, so the button stays hidden and crew are
// pointed at their manager. Flip to true and redeploy once SMTP is live.
// Everything else (real-email logins, manager reset, in-app change password)
// works regardless of this flag.
const PASSWORD_RESET_ENABLED = false

// Match a typed login (full email OR email local-part) to a user record.
// Exact full-email match wins first so prefix collisions can't misroute;
// then fall back to local-part. Case-insensitive. Returns null if no match.
export function resolveUserByLogin(users, typedRaw) {
  const typed = String(typedRaw || '').trim().toLowerCase()
  if (!typed) return null
  const list = users || []
  return list.find(u => (u.email || '').toLowerCase() === typed)
    || list.find(u => (u.email || '').toLowerCase().split('@')[0] === typed)
    || null
}

export default function Login() {
  const { users, login, darkMode } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [shake, setShake] = useState(false)
  const passwordRef = useRef(null)

  // Forgot-password flow. 'login' = normal sign-in; 'forgot' = the reset-
  // request panel. resetSent gates the confirmation message (shown for both
  // hit and miss so we never leak whether an account exists).
  const [mode, setMode] = useState('login')
  const [resetId, setResetId] = useState('')
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  // Restore remembered username from localStorage on first mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBERED_USERNAME_KEY)
      if (saved) setUsername(saved)
    } catch (e) {
      // localStorage unavailable — fine, just start blank
    }
  }, [])

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

    // Resolve the typed value to a user record so we can pass the full user
    // object to login() (which does the actual auth call). Match on the full
    // email first, then the email's local-part ("francisco.molina" or
    // "fmolina"). Matching the local-part is what lets the email migration run
    // gradually: un-migrated accounts still answer to their old synthetic
    // prefix while migrated ones answer to their company-email prefix — both
    // work at once, no lockstep cutover.
    const matchingUser = resolveUserByLogin(users, trimmed)
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

  async function handleForgot(e) {
    if (e) e.preventDefault()
    if (resetSubmitting) return
    setResetSubmitting(true)

    // Resolve the typed name/email to the user's real login email. If it's a
    // full email, send straight to it. We always show the same confirmation
    // afterward (hit or miss) so the screen never reveals whether an account
    // exists — matching the generic "Invalid login" convention.
    const typed = resetId.trim()
    const matched = resolveUserByLogin(users, typed)
    const target = matched?.email || (typed.includes('@') ? typed.toLowerCase() : null)

    if (target) {
      try {
        await db.auth.resetPasswordForEmail(target, {
          // Full deployed URL incl. the GitHub Pages /fiberlog/ base — must be
          // in Supabase Auth's redirect allow-list or the link errors.
          redirectTo: window.location.origin + import.meta.env.BASE_URL,
        })
      } catch (err) {
        // Swallow — still show the neutral confirmation (no enumeration).
        console.warn('resetPasswordForEmail:', err)
      }
    }

    setResetSubmitting(false)
    setResetSent(true)
  }

  function openForgot() {
    setMode('forgot')
    setResetId(username)   // pre-fill with whatever they already typed
    setResetSent(false)
    setError('')
  }

  function backToLogin() {
    setMode('login')
    setResetSent(false)
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

        {mode === 'login' ? (
          <>
            <form onSubmit={handleSubmit}>
              <div className="field">
                <label>Name or email</label>
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
                  Your name or company email
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

            {PASSWORD_RESET_ENABLED && (
              <div style={{ marginTop: 18, textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={openForgot}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--teal-mid)', fontSize: 13, fontWeight: 600,
                    textDecoration: 'underline', padding: 4,
                  }}
                >
                  Forgot your password?
                </button>
              </div>
            )}
          </>
        ) : (
          /* ── Forgot-password panel ──────────────────────────────────── */
          resetSent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📧</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>Check your email</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 20 }}>
                If that account exists, we sent a password reset link to its company
                email. Open the link on this device to set a new password.
              </div>
              <button className="btn btn-ghost" style={{ width: '100%' }} onClick={backToLogin}>
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgot}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Reset your password</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
                Enter your name or company email. We'll send a reset link to your
                company inbox.
              </div>
              <div className="field">
                <label>Name or email</label>
                <input
                  type="text"
                  value={resetId}
                  onChange={e => setResetId(e.target.value)}
                  placeholder="firstname.lastname"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  spellCheck="false"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={resetSubmitting || !resetId.trim()}
                style={{ width: '100%' }}
              >
                {resetSubmitting ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                type="button"
                onClick={backToLogin}
                style={{
                  marginTop: 12, background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--muted)', fontSize: 13, fontWeight: 600,
                  width: '100%', padding: 4,
                }}
              >
                Cancel
              </button>
            </form>
          )
        )}

        {mode === 'login' && (
          <div style={{
            marginTop: 16, fontSize: 11, color: 'var(--hint)',
            textAlign: 'center', lineHeight: 1.5,
          }}>
            {PASSWORD_RESET_ENABLED
              ? 'Still stuck? Ask your manager — they can reset it from the Admin panel.'
              : 'Forgot your password? Ask your manager — they can reset it from the Admin panel.'}
          </div>
        )}
      </div>
    </div>
  )
}
