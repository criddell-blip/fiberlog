import { useState } from 'react'
import { useApp } from './AppContext'
import { useBackClose } from './lib/backStack'
import { t } from './lib/i18n'

// Set-new-password screen. Two modes:
//   • Recovery (default): full-screen card App.jsx shows when the app is
//     opened from an email reset link (recoveryMode). Calls
//     completePasswordReset, which reloads + routes the user in once set.
//   • In-app change (asSheet): overlay reachable while signed in. Calls
//     changeOwnPassword and closes on success.
//
// Mirrors the ResetPasswordSheet form in AdminUsersView (≥8 chars, show/hide)
// but adds a confirm field since there's no manager reading it back.
export default function SetNewPassword({ asSheet = false, onClose }) {
  const { completePasswordReset, changeOwnPassword, lang } = useApp()
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Holds an i18n key for our own validation messages, or a raw server
  // message — t() passes unknown strings through unchanged, so rendering
  // t(error, lang) covers both.
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Back closes the in-app sheet; recovery screen owns no back-step.
  useBackClose(asSheet ? 1 : 0, () => { if (asSheet && onClose) onClose() })

  async function handleSubmit(e) {
    if (e) e.preventDefault()
    if (submitting) return
    if (!pw || pw.length < 8) { setError('pwTooShort'); return }
    if (pw !== confirm) { setError('pwNoMatch'); return }
    setSubmitting(true); setError('')
    try {
      if (asSheet) {
        await changeOwnPassword(pw)
        setDone(true)
        setTimeout(() => onClose && onClose(), 900)
      } else {
        // Reloads on success → this component unmounts; nothing more to do.
        await completePasswordReset(pw)
      }
    } catch (err) {
      setError(err.message || 'pwUpdateFailed')
      setSubmitting(false)
    }
  }

  const form = (
    <form onSubmit={handleSubmit}>
      <div className="field">
        <label>{t('newPasswordLabel', lang)}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type={showPw ? 'text' : 'password'}
            value={pw}
            onChange={e => { setPw(e.target.value); setError('') }}
            autoComplete="new-password"
            name="new-password-field"
            autoFocus
            style={{ flex: 1 }}
          />
          <button
            type="button" onClick={() => setShowPw(s => !s)}
            style={{
              padding: '8px 10px', borderRadius: 'var(--r-sm)',
              border: '1.5px solid var(--border2)', background: 'var(--bg)',
              color: 'var(--muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}
          >{showPw ? t('hidePw', lang) : t('showPw', lang)}</button>
        </div>
      </div>

      <div className="field">
        <label>{t('confirmPasswordLabel', lang)}</label>
        <input
          type={showPw ? 'text' : 'password'}
          value={confirm}
          onChange={e => { setConfirm(e.target.value); setError('') }}
          autoComplete="new-password"
          name="confirm-password-field"
        />
      </div>

      {error && (
        <div style={{
          padding: '10px 12px', background: 'var(--red-lt)', color: 'var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
          textAlign: 'center', fontWeight: 600,
        }}>{t(error, lang)}</div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        {asSheet && (
          <button type="button" className="btn btn-ghost" style={{ flex: 1 }}
            onClick={onClose} disabled={submitting}>{t('cancel', lang)}</button>
        )}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={submitting}
          style={{ flex: asSheet ? 2 : 1, width: asSheet ? undefined : '100%' }}
        >
          {submitting ? t('saving', lang) : t('setPasswordBtn', lang)}
        </button>
      </div>
    </form>
  )

  const successBlock = (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>✅</div>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{t('pwUpdated', lang)}</div>
    </div>
  )

  // ── In-app sheet ──────────────────────────────────────────────────────────
  if (asSheet) {
    return (
      <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onClose && onClose()}>
        <div className="overlay-sheet">
          <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 14 }}>{t('changePassword', lang)}</div>
          {done ? successBlock : form}
        </div>
      </div>
    )
  }

  // ── Recovery full-screen ────────────────────────────────────────────────--
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', padding: 20, background: 'var(--bg)',
    }}>
      <div style={{
        width: '100%', maxWidth: 380,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', padding: '32px 28px',
      }}>
        <div style={{
          fontSize: 32, fontWeight: 800, letterSpacing: '-1px',
          marginBottom: 4, lineHeight: 1, textAlign: 'center',
        }}>
          <span style={{ color: 'var(--text)' }}>Fiber</span>
          <span style={{ color: 'var(--orange)' }}>Log</span>
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', marginBottom: 24 }}>
          {t('recoverySub', lang)}
        </div>
        {form}
      </div>
    </div>
  )
}
