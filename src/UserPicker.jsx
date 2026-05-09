import { useState } from 'react'
import { useApp } from './AppContext'

export default function UserPicker() {
  const { users, login } = useApp()
  const [search, setSearch] = useState('')
  const [pendingUser, setPendingUser] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [shake, setShake] = useState(false)

  const filtered = users.filter(u =>
    u.name.toLowerCase().includes(search.toLowerCase())
  )

  const managers = filtered.filter(u => u.role === 'manager' || u.role === 'owner')
  const crew = filtered.filter(u => u.role === 'crew' || u.role === 'contractor')

  function handleAvatarTap(user) {
    // Everyone has a real password now — always prompt
    if (!user.email) {
      setError('User account not migrated. Contact admin.')
      return
    }
    setPendingUser(user)
    setPassword('')
    setError('')
  }

  async function handleLogin() {
    const { error: loginError } = await login(pendingUser, password)
    if (loginError) {
      setError('Incorrect password')
      setShake(true)
      setPassword('')
      setTimeout(() => setShake(false), 500)
    } else {
      setPendingUser(null)
      setPassword('')
      setError('')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)' }}>

      {/* Header */}
      <div style={{
        background: 'var(--surface)',
        borderBottom: '3px solid var(--orange)',
        padding: '40px 24px 20px',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-1px', marginBottom: 4, lineHeight: 1 }}>
          <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Utah Broadband · {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '16px 20px 8px', flexShrink: 0 }}>
        <input
          type="text"
          placeholder="🔍  Search name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: '100%', padding: '10px 14px',
            border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
            fontSize: 14, background: 'var(--surface)', outline: 'none', color: 'var(--text)'
          }}
          autoFocus
        />
      </div>

      {/* Avatar grid */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 20px 40px' }}>
        {managers.length > 0 && (
          <>
            <div className="sec-label">Management</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
              {managers.map(u => <AvatarCard key={u.id} user={u} onSelect={handleAvatarTap} />)}
            </div>
          </>
        )}
        {crew.length > 0 && (
          <>
            <div className="sec-label">Crew</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              {crew.map(u => <AvatarCard key={u.id} user={u} onSelect={handleAvatarTap} />)}
            </div>
          </>
        )}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>No one found</div>
        )}
      </div>

      {/* Password overlay */}
      {pendingUser && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && (setPendingUser(null), setPassword(''), setError(''))}>
          <div className="overlay-sheet" style={{
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

            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 20 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                background: pendingUser.role === 'owner' ? 'var(--orange)' : pendingUser.role === 'manager' ? 'var(--orange-lt)' : 'var(--surface2)',
                border: pendingUser.role === 'manager' ? '2px solid var(--orange-dk)' : pendingUser.role === 'owner' ? 'none' : '1px solid var(--border2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 20,
                color: pendingUser.role === 'owner' ? 'white' : pendingUser.role === 'manager' ? 'var(--orange)' : 'var(--muted)',
                marginBottom: 10,
              }}>
                {pendingUser.initials}
              </div>
              <div style={{ fontWeight: 800, fontSize: 17 }}>{pendingUser.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>Enter your password to continue</div>
            </div>

            <div className="field">
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={e => { setPassword(e.target.value); setError('') }}
                onKeyDown={e => e.key === 'Enter' && handleLogin()}
                autoFocus
                style={{
                  width: '100%', padding: '12px 14px', fontSize: 16,
                  border: `1.5px solid ${error ? 'var(--red)' : 'var(--border2)'}`,
                  borderRadius: 'var(--r-sm)', background: 'var(--surface)',
                  color: 'var(--text)', outline: 'none', textAlign: 'center',
                  letterSpacing: 4,
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
                Cancel
              </button>
              <button className="btn btn-primary" style={{ flex: 2 }}
                onClick={handleLogin} disabled={!password.trim()}>
                Sign in
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AvatarCard({ user, onSelect }) {
  const isOwner = user.role === 'owner'
  const isManager = user.role === 'manager'

  const bgColor = isOwner ? 'var(--orange)' : isManager ? 'var(--orange-lt)' : 'var(--surface2)'
  const textColor = isOwner ? 'white' : isManager ? 'var(--orange)' : 'var(--muted)'
  const borderStyle = isOwner ? 'none' : isManager ? '1.5px solid var(--orange-dk)' : '1px solid var(--border2)'

  const crewLabel = {
    aerial: 'Aerial', underground: 'UG', splice: 'Splice',
    drop: 'Drop', locator: 'Locator', contractor: 'Contractor',
  }

  return (
    <div
      onClick={() => onSelect(user)}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 6, padding: '14px 8px',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)', cursor: 'pointer',
        transition: 'transform .1s, border-color .1s',
        position: 'relative',
      }}
      onTouchStart={e => e.currentTarget.style.transform = 'scale(0.95)'}
      onTouchEnd={e => e.currentTarget.style.transform = 'scale(1)'}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--orange)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      <div style={{
        width: 52, height: 52, borderRadius: '50%',
        background: bgColor, border: borderStyle,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 800, fontSize: 15, color: textColor, flexShrink: 0,
      }}>
        {user.initials}
      </div>
      <div style={{ textAlign: 'center', minWidth: 0, width: '100%' }}>
        <div style={{ fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {user.name.split(' ')[0]}
        </div>
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
          {isOwner ? 'Owner' : isManager ? 'Manager' : crewLabel[user.crew_type] || user.crew_type}
        </div>
      </div>
    </div>
  )
}
