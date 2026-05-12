import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import {
  createUser, updateUserMetadata, deactivateUser, reactivateUser,
  resetUserPassword, getAllUsers,
  buildEmailFromUsername, generateInitials,
  CREW_OPERATIONS,
  getUserPermissions, setUserOperationPermission, clearUserOperationPermission,
} from '../../lib/admin'

const ROLE_OPTIONS = [
  { id: 'crew',       label: 'Crew',       desc: 'Field worker' },
  { id: 'manager',    label: 'Manager',    desc: 'Can approve, manage projects, reset passwords' },
  { id: 'owner',      label: 'Owner',      desc: 'Full admin (can create other owners)' },
  { id: 'contractor', label: 'Contractor', desc: 'External worker, limited access' },
]

const CREW_TYPE_OPTIONS = [
  { id: 'aerial',         label: '🏗️ Aerial' },
  { id: 'underground',    label: '⛏️ Underground' },
  { id: 'splice',         label: '🔌 Splice' },
  { id: 'drop',           label: '💧 Drop' },
  { id: 'locator',        label: '📍 Locator' },
  { id: 'install',        label: '🏠 Install (field tech)' },
  { id: 'infrastructure', label: '📡 Infrastructure (tower/site)' },
  { id: 'contractor',     label: '🛠️ Contractor' },
]

export default function AdminUsersView({ onBack }) {
  const { showToast, currentUser, reload } = useApp()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('active')   // 'all' | 'active' | 'inactive'
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)     // null | { mode: 'new' } | user object
  const [resettingPwFor, setResettingPwFor] = useState(null)

  const isOwner = currentUser?.role === 'owner'

  async function load() {
    setLoading(true)
    try {
      const all = await getAllUsers()
      setUsers(all)
    } catch (e) {
      showToast('Failed to load users: ' + e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const counts = useMemo(() => ({
    all:      users.length,
    active:   users.filter(u => u.is_active).length,
    inactive: users.filter(u => !u.is_active).length,
  }), [users])

  const filtered = useMemo(() => {
    let list = users
    if (filter === 'active')   list = list.filter(u => u.is_active)
    if (filter === 'inactive') list = list.filter(u => !u.is_active)
    if (search.trim().length >= 2) {
      const q = search.toLowerCase()
      list = list.filter(u =>
        (u.name || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.role || '').toLowerCase().includes(q) ||
        (u.crew_type || '').toLowerCase().includes(q)
      )
    }
    return list
  }, [users, filter, search])

  // ── Action handlers ──────────────────────────────────────────────────────

  async function handleCreate(payload) {
    try {
      await createUser(payload)
      setEditing(null)
      await load()
      reload()   // refresh AppContext.users so the new person can sign in immediately
      showToast(`Created ${payload.name}`)
    } catch (e) {
      showToast('Create failed: ' + e.message)
      console.error('createUser:', e)
      throw e   // form keeps the data in case the user wants to retry
    }
  }

  async function handleUpdate(userId, updates) {
    try {
      await updateUserMetadata(userId, updates)
      setEditing(null)
      await load()
      reload()
      showToast('Saved')
    } catch (e) {
      showToast('Save failed: ' + e.message)
      throw e
    }
  }

  async function handleToggleActive(user) {
    if (user.id === currentUser?.id) {
      showToast(`You can't deactivate yourself`)
      return
    }
    const verb = user.is_active ? 'Deactivate' : 'Reactivate'
    if (!window.confirm(`${verb} ${user.name}?`)) return
    try {
      if (user.is_active) await deactivateUser(user.id)
      else                await reactivateUser(user.id)
      await load()
      reload()
      showToast(`${verb}d ${user.name}`)
    } catch (e) {
      showToast(verb + ' failed: ' + e.message)
    }
  }

  async function handleResetPassword(user, newPassword) {
    try {
      await resetUserPassword(user.id, newPassword)
      setResettingPwFor(null)
      showToast(`Password updated for ${user.name}`)
    } catch (e) {
      showToast('Reset failed: ' + e.message)
      throw e
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Users</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Add, edit, or deactivate users</div>
          </div>
          <button
            onClick={() => setEditing({ mode: 'new' })}
            style={{ padding: '7px 14px', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          >＋ Add user</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setFilter('all')} style={pillStyle(filter === 'all')}>
            All ({counts.all})
          </button>
          <button onClick={() => setFilter('active')} style={pillStyle(filter === 'active', 'teal')}>
            ✓ Active ({counts.active})
          </button>
          <button onClick={() => setFilter('inactive')} style={pillStyle(filter === 'inactive', 'amber')}>
            ⊘ Inactive ({counts.inactive})
          </button>
        </div>

        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, role, crew type…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          name="user-search"
          style={{
            width: '100%', padding: '10px 12px',
            border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)',
            fontSize: 14, background: 'var(--bg)', marginBottom: 12,
          }}
        />

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading users…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            {users.length === 0 ? 'No users yet' : 'No users match your filters'}
          </div>
        ) : (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
            {filtered.map((u, i) => {
              const isSelf = u.id === currentUser?.id
              return (
                <div key={u.id} style={{
                  display: 'flex', alignItems: 'center', padding: '12px 14px', gap: 10,
                  borderBottom: i < filtered.length - 1 ? '1px solid var(--border)' : 'none',
                  opacity: u.is_active ? 1 : 0.55,
                }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                    background: u.role === 'owner' ? 'var(--orange)'
                              : u.role === 'manager' ? 'var(--orange-lt)'
                              : 'var(--surface2)',
                    border: u.role === 'manager' ? '1.5px solid var(--orange-dk)'
                          : u.role === 'owner' ? 'none'
                          : '1px solid var(--border2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: 12,
                    color: u.role === 'owner' ? 'white'
                         : u.role === 'manager' ? 'var(--orange)'
                         : 'var(--muted)',
                  }}>{u.initials}</div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {u.name}
                      {isSelf && <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                        background: 'var(--teal-lt)', color: 'var(--teal)',
                      }}>YOU</span>}
                      {!u.is_active && <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                        background: 'var(--amber-lt)', color: 'var(--amber)',
                      }}>INACTIVE</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {u.role}{u.crew_type ? ` · ${u.crew_type}` : ''} · {u.email}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => setEditing(u)} style={tinyBtn('default')}>Edit</button>
                    <button onClick={() => setResettingPwFor(u)} style={tinyBtn('default')}>🔑 Pw</button>
                    <button
                      onClick={() => handleToggleActive(u)}
                      disabled={isSelf}
                      title={isSelf ? `Can't deactivate yourself` : ''}
                      style={tinyBtn(u.is_active ? 'amber' : 'teal', isSelf)}
                    >
                      {u.is_active ? '⊘' : '✓'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add/edit form */}
      {editing && (
        <UserFormSheet
          mode={editing.mode === 'new' ? 'new' : 'edit'}
          user={editing.mode === 'new' ? null : editing}
          isOwner={isOwner}
          existingUsers={users}
          onCancel={() => setEditing(null)}
          onSubmit={async (payload) => {
            if (editing.mode === 'new') await handleCreate(payload)
            else                        await handleUpdate(editing.id, payload)
          }}
        />
      )}

      {/* Reset password */}
      {resettingPwFor && (
        <ResetPasswordSheet
          user={resettingPwFor}
          onCancel={() => setResettingPwFor(null)}
          onSubmit={(pw) => handleResetPassword(resettingPwFor, pw)}
        />
      )}
    </div>
  )
}

// ─── Pill / button helpers ────────────────────────────────────────────────

function pillStyle(selected, color = 'orange') {
  const colorMap = {
    orange: 'var(--orange)',
    teal: 'var(--teal)',
    amber: 'var(--amber)',
  }
  return {
    padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
    background: selected ? colorMap[color] : 'var(--gray-lt)',
    color: selected ? 'white' : 'var(--muted)',
    border: 'none', cursor: 'pointer',
  }
}

function tinyBtn(variant, disabled) {
  const base = {
    padding: '5px 8px', borderRadius: 'var(--r-sm)',
    fontSize: 11, fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap', opacity: disabled ? 0.4 : 1,
  }
  if (variant === 'teal')  return { ...base, border: '1.5px solid var(--teal)',  background: 'var(--teal-lt)',  color: 'var(--teal)' }
  if (variant === 'amber') return { ...base, border: '1.5px solid var(--amber)', background: 'var(--amber-lt)', color: 'var(--amber)' }
  return                       { ...base, border: '1.5px solid var(--border2)', background: 'var(--bg)',     color: 'var(--muted)' }
}

// ─── User form sheet (add OR edit) ────────────────────────────────────────

function UserFormSheet({ mode, user, isOwner, existingUsers, onCancel, onSubmit }) {
  const isNew = mode === 'new'

  // For new users, "username" is the user-facing field. For existing users
  // we treat email as read-only and only edit metadata.
  const [name, setName] = useState(user?.name || '')
  const [username, setUsername] = useState('')
  const [role, setRole] = useState(user?.role || 'crew')
  const [crewType, setCrewType] = useState(user?.crew_type || 'aerial')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [initials, setInitials] = useState(user?.initials || '')
  const [isActive, setIsActive] = useState(user?.is_active !== false)
  const [language, setLanguage] = useState(user?.language || 'en')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Auto-generate initials from name when user hasn't manually overridden them.
  // We track whether the user has typed in the initials field — if not,
  // keep regenerating from the name as they type.
  const [initialsManuallyEdited, setInitialsManuallyEdited] = useState(!!user?.initials)
  useEffect(() => {
    if (isNew && !initialsManuallyEdited) {
      setInitials(generateInitials(name))
    }
  }, [name, isNew, initialsManuallyEdited])

  // Email preview
  const emailPreview = useMemo(() => {
    if (!isNew) return user?.email || ''
    return buildEmailFromUsername(username) || '(enter username)'
  }, [isNew, username, user])

  // Validation: warn if username conflicts with an existing one
  const usernameConflict = useMemo(() => {
    if (!isNew || !username.trim()) return null
    const candidate = buildEmailFromUsername(username)
    return existingUsers.some(u => (u.email || '').toLowerCase() === candidate)
  }, [isNew, username, existingUsers])

  // If the user isn't an owner and they pick "owner" role, the server will
  // reject — surface this hint locally too.
  const cannotPickOwner = !isOwner

  async function handleSubmit() {
    setError('')

    // Client-side validation
    if (!name.trim()) { setError('Name is required'); return }
    if (isNew) {
      if (!username.trim()) { setError('Username is required'); return }
      if (!password || password.length < 6) { setError('Password must be at least 6 characters'); return }
      if (usernameConflict) { setError('Username already taken'); return }
    }
    if (!ROLE_OPTIONS.find(r => r.id === role)) { setError('Pick a role'); return }
    if (role === 'owner' && cannotPickOwner) { setError('Only owners can create other owners'); return }

    setSubmitting(true)
    try {
      if (isNew) {
        await onSubmit({
          name: name.trim(),
          username: username.trim().toLowerCase(),
          role,
          crew_type: crewType || null,
          password,
          initials: initials.trim() || generateInitials(name),
          language,
          is_active: isActive,
        })
      } else {
        await onSubmit({
          name: name.trim(),
          role,
          crew_type: crewType || null,
          initials: initials.trim() || generateInitials(name),
          language,
          is_active: isActive,
        })
      }
    } catch (e) {
      setError(e.message || 'Failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 560, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexShrink: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>
            {isNew ? 'Add user' : `Edit ${user?.name || 'user'}`}
          </div>
          {!submitting && (
            <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--muted)' }}>✕</button>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div className="field">
            <label>Full name *</label>
            <input
              type="text" value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Francisco Molina"
              autoFocus
            />
          </div>

          {/* Username — only for new users */}
          {isNew && (
            <div className="field">
              <label>Username *</label>
              <input
                type="text" value={username}
                onChange={e => { setUsername(e.target.value.toLowerCase()); setError('') }}
                placeholder="firstname.lastname"
                autoCapitalize="none" autoCorrect="off" spellCheck="false"
                autoComplete="off"
                name="new-user-username"
                style={{
                  borderColor: usernameConflict ? 'var(--red)' : undefined
                }}
              />
              <div style={{ fontSize: 11, color: usernameConflict ? 'var(--red)' : 'var(--hint)', marginTop: 4 }}>
                Email: <code style={{ fontFamily: 'monospace' }}>{emailPreview}</code>
                {usernameConflict && <span style={{ marginLeft: 8 }}>⚠ already taken</span>}
              </div>
            </div>
          )}

          {/* Email (read-only) for existing users */}
          {!isNew && (
            <div className="field">
              <label>Username (locked)</label>
              <div style={{
                padding: '10px 12px', borderRadius: 'var(--r-sm)',
                border: '1.5px solid var(--border2)', background: 'var(--surface2)',
                fontSize: 13, color: 'var(--muted)', fontFamily: 'monospace',
              }}>
                {user?.email}
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                Username/email can't be changed after creation. Use Reset password to change credentials.
              </div>
            </div>
          )}

          {/* Initials */}
          <div className="field">
            <label>Initials</label>
            <input
              type="text" value={initials}
              onChange={e => {
                setInitials(e.target.value.toUpperCase().slice(0, 4))
                setInitialsManuallyEdited(true)
              }}
              placeholder="FM"
              maxLength={4}
              style={{ width: 100 }}
            />
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              {isNew ? 'Auto-generated from name. Override if needed.' : 'Up to 4 characters.'}
            </div>
          </div>

          {/* Role */}
          <div className="field">
            <label>Role *</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ROLE_OPTIONS.map(r => {
                const disabled = r.id === 'owner' && cannotPickOwner
                const selected = role === r.id
                return (
                  <button
                    key={r.id}
                    onClick={() => !disabled && setRole(r.id)}
                    disabled={disabled}
                    style={{
                      textAlign: 'left',
                      padding: '10px 12px', borderRadius: 'var(--r-sm)',
                      border: `1.5px solid ${selected ? 'var(--orange)' : 'var(--border2)'}`,
                      background: selected ? 'var(--orange-lt)' : 'var(--bg)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.4 : 1,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13, color: selected ? 'var(--orange)' : 'var(--text)' }}>
                      {r.label}{disabled ? ' (owner-only)' : ''}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{r.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Crew type */}
          <div className="field">
            <label>Crew type</label>
            <select
              value={crewType}
              onChange={e => setCrewType(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">— None —</option>
              {CREW_TYPE_OPTIONS.map(ct => (
                <option key={ct.id} value={ct.id}>{ct.label}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              For managers and owners this is informational. For crew it determines which assemblies they see.
            </div>
          </div>

          {/* Password — new users only */}
          {isNew && (
            <div className="field">
              <label>Initial password * (minimum 6 characters)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  autoComplete="new-password"
                  name="new-user-password"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  style={{
                    padding: '8px 10px', borderRadius: 'var(--r-sm)',
                    border: '1.5px solid var(--border2)', background: 'var(--bg)',
                    color: 'var(--muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}
                >{showPassword ? 'Hide' : 'Show'}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                Tell the user their password directly. They can change it later via password reset.
              </div>
            </div>
          )}

          {/* Language */}
          <div className="field">
            <label>Language</label>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              style={{ width: 200 }}
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </div>

          {/* Active toggle (edit only) */}
          {!isNew && (
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '10px 12px', borderRadius: 'var(--r-sm)',
              border: `1.5px solid ${isActive ? 'var(--teal)' : 'var(--amber)'}`,
              background: isActive ? 'var(--teal-lt)' : 'var(--amber-lt)',
              cursor: 'pointer', marginBottom: 14,
            }}>
              <input
                type="checkbox"
                checked={isActive}
                onChange={e => setIsActive(e.target.checked)}
                style={{ marginTop: 2, cursor: 'pointer' }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: isActive ? 'var(--teal)' : 'var(--amber)' }}>
                  {isActive ? 'Active' : 'Inactive'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {isActive
                    ? 'Can sign in and appears in pickers'
                    : 'Cannot sign in. History is preserved.'}
                </div>
              </div>
            </label>
          )}

          {/* Movement permissions (edit only; only applies to crew/contractor).
              Saves immediately on toggle — independent of the form Save button
              since it writes a separate table. */}
          {!isNew && (role === 'crew' || role === 'contractor') && (
            <CrewPermissionsSection userId={user?.id} />
          )}

          {error && (
            <div style={{
              padding: '8px 12px',
              background: 'var(--red-lt)', color: 'var(--red)',
              borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
            }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || (isNew && (!username.trim() || password.length < 6 || usernameConflict))}
          >
            {submitting ? 'Saving…' : (isNew ? 'Create user' : 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Reset password sheet ─────────────────────────────────────────────────

function ResetPasswordSheet({ user, onCancel, onSubmit }) {
  const [pw, setPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [showPw, setShowPw] = useState(false)

  async function handleSubmit() {
    if (!pw || pw.length < 6) { setError('Password must be at least 6 characters'); return }
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(pw)
    } catch (e) {
      setError(e.message || 'Reset failed')
      setSubmitting(false)
    }
  }

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onCancel()}>
      <div className="overlay-sheet">
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Reset password</div>
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
          {user.name} · {user.email}
        </div>

        <div className="field">
          <label>New password (minimum 6 characters)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type={showPw ? 'text' : 'password'}
              value={pw}
              onChange={e => { setPw(e.target.value); setError('') }}
              autoFocus
              autoComplete="new-password"
              name="reset-password-field"
              onKeyDown={e => e.key === 'Enter' && handleSubmit()}
              style={{ flex: 1 }}
            />
            <button
              type="button" onClick={() => setShowPw(s => !s)}
              style={{
                padding: '8px 10px', borderRadius: 'var(--r-sm)',
                border: '1.5px solid var(--border2)', background: 'var(--bg)',
                color: 'var(--muted)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}
            >{showPw ? 'Hide' : 'Show'}</button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 16 }}>
          Tell the user their new password directly.
        </div>

        {error && (
          <div style={{
            padding: '8px 12px', background: 'var(--red-lt)', color: 'var(--red)',
            borderRadius: 'var(--r-sm)', fontSize: 13, marginBottom: 12,
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-primary" style={{ flex: 2 }}
            onClick={handleSubmit} disabled={submitting || pw.length < 6}
          >
            {submitting ? 'Saving…' : 'Save password'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Crew operation permissions section ──────────────────────────────────
// Renders 5 toggles (one per crew operation). Default state for each op
// is "allowed" (= no row in crew_operation_permissions for that op).
// Toggling off creates/updates a row with allowed=false. Toggling back on
// deletes the row. Reason field appears when an op is denied; saves on blur.
//
// Saves are live (per-toggle) rather than batched with the parent form's
// submit, because permissions live in a different table and the user-edit
// form has a different lifecycle.

const OPERATION_LABELS = {
  load:     { icon: '⬇', label: 'Load',     desc: 'Warehouse → my truck' },
  return:   { icon: '↩', label: 'Return',   desc: 'My truck → warehouse' },
  issue:    { icon: '⬆', label: 'Issue',    desc: 'Consumed in field (manual)' },
  scrap:    { icon: '✕', label: 'Scrap',    desc: 'Damaged / written off' },
  transfer: { icon: '↔', label: 'Transfer', desc: 'My truck → another crew' },
}

function CrewPermissionsSection({ userId }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyOp, setBusyOp] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    getUserPermissions(userId)
      .then(d => { if (!cancelled) setRows(d || []) })
      .catch(e => { if (!cancelled) setErr(e.message || 'Failed to load permissions') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  const denyByOp = useMemo(() => {
    const m = {}
    for (const r of rows) {
      if (r.allowed === false) m[r.operation] = r
    }
    return m
  }, [rows])

  async function setDenied(op, deny, reason = null) {
    if (!userId) return
    setBusyOp(op); setErr('')
    try {
      if (deny) {
        const saved = await setUserOperationPermission(userId, op, false, reason)
        // Trust our input even if the upsert SELECT-back returned null
        // (PostgREST quirk on some on-conflict update paths). The data
        // landed; we just synthesize the row locally.
        const row = saved || {
          user_id: userId,
          operation: op,
          allowed: false,
          reason: reason || null,
          updated_at: new Date().toISOString(),
        }
        setRows(prev => [...prev.filter(r => r.operation !== op), row])
      } else {
        await clearUserOperationPermission(userId, op)
        setRows(prev => prev.filter(r => r.operation !== op))
      }
    } catch (e) {
      setErr(e.message || 'Update failed')
    } finally {
      setBusyOp(null)
    }
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
      }}>
        Movement permissions
      </div>
      <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 8 }}>
        Every operation is allowed by default. Toggle off to block this user from doing it.
      </div>

      {loading && (
        <div style={{ padding: 8, color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
      )}

      {!loading && CREW_OPERATIONS.map(op => {
        const meta = OPERATION_LABELS[op]
        const deny = denyByOp[op]
        const denied = !!deny
        const busy = busyOp === op
        return (
          <div
            key={op}
            style={{
              border: `1px solid ${denied ? 'var(--red)' : 'var(--border)'}`,
              background: denied ? 'var(--red-lt)' : 'var(--surface)',
              borderRadius: 'var(--r-sm)',
              padding: '8px 12px',
              marginBottom: 6,
            }}
          >
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={!denied}
                disabled={busy}
                onChange={e => setDenied(op, !e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontSize: 16, width: 18, textAlign: 'center' }}>{meta.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: denied ? 'var(--red)' : 'var(--text)' }}>
                  {meta.label} {denied && <span style={{ fontWeight: 400, fontSize: 11 }}>— blocked</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{meta.desc}</div>
              </div>
              {busy && <span style={{ fontSize: 11, color: 'var(--muted)' }}>saving…</span>}
            </label>

            {denied && (
              <div style={{ marginTop: 8, paddingLeft: 38 }}>
                <input
                  type="text"
                  defaultValue={deny.reason || ''}
                  placeholder="Reason (shown to crew when they try)"
                  onBlur={e => {
                    const next = e.target.value.trim() || null
                    if (next !== (deny.reason || null)) {
                      setDenied(op, true, next)
                    }
                  }}
                  autoComplete="off"
                  name={`perm-reason-${op}`}
                  style={{
                    width: '100%', padding: '6px 10px', fontSize: 12,
                    border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
                    background: 'var(--bg)',
                  }}
                />
              </div>
            )}
          </div>
        )
      })}

      {err && (
        <div style={{ padding: '6px 10px', fontSize: 12, color: 'var(--red)', background: 'var(--red-lt)', borderRadius: 'var(--r-xs)' }}>
          {err}
        </div>
      )}
    </div>
  )
}
