import { useState, useEffect, useRef } from 'react'
import { useApp } from './AppContext'
import { db } from './lib/supabase'
import { t } from './lib/i18n'

// Standard username + password login. Replaced the old avatar-grid picker
// once crew rosters grew past the point where a grid of faces was useful.
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
  // lang here resolves pre-auth as: localStorage override → 'en' (no
  // currentUser yet). The corner toggle below calls setLang, which seeds
  // localStorage.fiberlog_lang — so a Spanish-only crew member can get
  // Spanish BEFORE authenticating, and the whole app follows after login.
  const { users, login, darkMode, lang, setLang } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  // Error state holds an i18n KEY (not text) so a live language flip
  // re-renders the message in the new language.
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
      setError('errEnterUsername')
      return
    }
    if (!password) {
      setError('errEnterPassword')
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
      setError('errInvalidLogin')
      setShake(true)
      setPassword('')
      setTimeout(() => setShake(false), 500)
      return
    }
    if (!matchingUser.is_active) {
      setError('errInactiveAccount')
      return
    }

    setSubmitting(true)
    setError('')

    const { error: loginError } = await login(matchingUser, password)

    if (loginError) {
      // Don't leak whether it was bad username vs bad password
      setError('errInvalidLogin')
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
                <label>{t('loginNameOrEmail', lang)}</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => { setUsername(e.target.value); setError('') }}
                  placeholder={t('loginUserPlaceholder', lang)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="username"
                  spellCheck="false"
                  autoFocus={!username}
                />
                <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                  {t('loginHelper', lang)}
                </div>
              </div>

              <div className="field">
                <label>{t('passwordLabel', lang)}</label>
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
                {t('rememberMe', lang)}
              </label>

              {error && (
                <div style={{
                  padding: '10px 12px',
                  background: 'var(--red-lt)', color: 'var(--red)',
                  borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
                  textAlign: 'center', fontWeight: 600,
                }}>
                  {t(error, lang)}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={submitting}
                style={{ width: '100%' }}
              >
                {submitting ? t('signingIn', lang) : t('signIn', lang)}
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
                  {t('forgotPasswordQ', lang)}
                </button>
              </div>
            )}
          </>
        ) : (
          /* ── Forgot-password panel ──────────────────────────────────── */
          resetSent ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📧</div>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>{t('resetCheckEmail', lang)}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 20 }}>
                {t('resetCheckEmailBody', lang)}
              </div>
              <button className="btn btn-ghost" style={{ width: '100%' }} onClick={backToLogin}>
                {t('backToSignIn', lang)}
              </button>
            </div>
          ) : (
            <form onSubmit={handleForgot}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{t('resetTitle', lang)}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>
                {t('resetSub', lang)}
              </div>
              <div className="field">
                <label>{t('loginNameOrEmail', lang)}</label>
                <input
                  type="text"
                  value={resetId}
                  onChange={e => setResetId(e.target.value)}
                  placeholder={t('loginUserPlaceholder', lang)}
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
                {resetSubmitting ? t('sending', lang) : t('resetSend', lang)}
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
                {t('cancel', lang)}
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
              ? t('loginFooterStuck', lang)
              : t('loginFooterForgot', lang)}
          </div>
        )}
      </div>

      {/* Language toggle — bottom corner, pre-auth. A Spanish-only crew
          member must be able to get Spanish BEFORE signing in; flipping
          here seeds localStorage.fiberlog_lang (per-device, survives
          logout) so the rest of the app follows. */}
      <div style={{
        position: 'fixed', bottom: 14, right: 16,
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 12, color: 'var(--hint)',
      }}>
        <span aria-hidden>🌐</span>
        <button type="button" onClick={() => setLang('en')} style={langBtnStyle(lang !== 'es')}>EN</button>
        <span>·</span>
        <button type="button" onClick={() => setLang('es')} style={langBtnStyle(lang === 'es')}>ES</button>
      </div>
    </div>
  )
}

// Tiny text-button style for the corner language toggle — deliberately
// unobtrusive (hint color, no chrome) so it doesn't compete with the form.
function langBtnStyle(active) {
  return {
    background: 'none', border: 'none', cursor: 'pointer', padding: 2,
    fontSize: 12, fontWeight: active ? 800 : 500,
    color: active ? 'var(--orange)' : 'var(--muted)',
    textDecoration: active ? 'none' : 'underline',
  }
}
