import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { useBackClose } from '../../lib/backStack'
import { crewTypeLabel } from '../../lib/crewTypes'
import { ACCESS_TYPES, accessTypeForUser, accessTypeToFields } from '../../lib/access'
import {
  createUser, updateUserMetadata, deactivateUser, reactivateUser,
  resetUserPassword, setUserEmail, getAllUsers,
  buildEmailFromUsername, generateInitials,
  CREW_OPERATIONS,
  getUserPermissions, setUserOperationPermission, clearUserOperationPermission,
} from '../../lib/admin'
import {
  getLocations, bulkAssignPullLocation,
  getCrewLoadDestinations, setCrewLoadDestinations,
} from '../../lib/inventory'
import Icon from '../shared/Icon'

const CREW_TYPE_OPTIONS = [
  { id: 'fiber_construction', label: '🏗️ Fiber construction' },
  { id: 'splice',         label: '🔌 Splice' },
  { id: 'drop',           label: '💧 Drop' },
  { id: 'locator',        label: '📍 Locator' },
  { id: 'install',        label: '🏠 Install' },
  { id: 'fiber_tech',     label: '🧰 Fiber tech' },
  { id: 'infrastructure', label: '📡 Infrastructure (tower/site)' },
  { id: 'contractor',     label: '🛠️ Contractor' },
]

// Soft cross-crew detection: infer a likely crew_type from a trailer name's
// keywords. Used only for the "Assign anyway?" amber warning on the per-user
// dropdown — does NOT block assignment, just nudges. Returns null if no
// keyword matches.
// Returns ALL crew_types whose keyword appears in the trailer name —
// shared trailers commonly span multiple crew types ("Aerial &
// Underground Shared", "UG/Splice trailer"), so a single-type lookup
// would fire false-positive cross-crew warnings against any user not
// matching the FIRST keyword in the name. Returning every match lets
// the warning logic say "user is in the set" instead of "user matches
// the only inferred type."
function crewTypesFromName(lower) {
  const types = []
  // aerial + underground merged into one worker class — a trailer named
  // "Aerial/UG Shared" must yield a single 'fiber_construction' entry, not two.
  if (lower.includes('aerial') || lower.includes('underground')
      || /\bug\b/.test(lower) || lower.includes('/ug') || lower.includes('ug/'))
                                        types.push('fiber_construction')
  if (lower.includes('splice'))         types.push('splice')
  if (lower.includes('drop'))           types.push('drop')
  if (lower.includes('locator'))        types.push('locator')
  if (lower.includes('install'))        types.push('install')
  if (lower.includes('fiber tech') || lower.includes('ftech'))
                                        types.push('fiber_tech')
  if (lower.includes('infra') || lower.includes('tower'))
                                        types.push('infrastructure')
  return types
}

export default function AdminUsersView({ onBack }) {
  const { showToast, currentUser, refreshUsers } = useApp()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('active')   // 'all' | 'active' | 'inactive'
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)     // null | { mode: 'new' } | user object
  const [resettingPwFor, setResettingPwFor] = useState(null)
  const [showBulkAssign, setShowBulkAssign] = useState(false)

  // Back closes whichever overlay is open (behaves like each one's Cancel).
  useBackClose(editing ? 1 : 0, () => setEditing(null))
  useBackClose(resettingPwFor ? 1 : 0, () => setResettingPwFor(null))
  useBackClose(showBulkAssign ? 1 : 0, () => setShowBulkAssign(false))

  const isOwner = currentUser?.role === 'owner'
  // Truck-type locations for the per-user "Pull materials from" dropdown.
  // Loaded once with the users; refreshed when a bulk-assign completes.
  const [truckLocations, setTruckLocations] = useState([])

  async function load() {
    setLoading(true)
    try {
      const [all, allLocs] = await Promise.all([
        getAllUsers(),
        getLocations(),
      ])
      setUsers(all)
      // Trucks + group locations are both valid "pull from" targets. Groups
      // are shared/multi-member buckets (Contractor - RNS, etc.).
      setTruckLocations((allLocs || []).filter(l => (l.type === 'truck' || l.type === 'group') && l.is_active))
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
      refreshUsers()   // refresh AppContext.users so the new person can sign in immediately
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
      refreshUsers()
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
      refreshUsers()
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

  // Change a user's login email (auth identity). Goes through admin-set-email
  // (service_role) which also mirrors public.users.email. Leaves the edit
  // sheet open so the manager can keep working; the sheet shows its own
  // inline confirmation.
  async function handleChangeEmail(user, newEmail) {
    try {
      await setUserEmail(user.id, newEmail)
      await load()
      refreshUsers()
      showToast(`Login email updated for ${user.name}`)
    } catch (e) {
      showToast('Email change failed: ' + e.message)
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
          {truckLocations.length > 0 && (
            <button
              onClick={() => setShowBulkAssign(true)}
              title="Bulk-assign N users to a shared pull location at once"
              style={{
                padding: '7px 14px',
                background: 'var(--surface2)', color: 'var(--teal-mid)',
                border: '1.5px solid var(--teal)',
                borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            ><Icon name="truck" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Bulk assign</button>
          )}
          <button
            onClick={() => setEditing({ mode: 'new' })}
            style={{ padding: '7px 14px', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 20, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
          ><Icon name="plus" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Add user</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          <button onClick={() => setFilter('all')} style={pillStyle(filter === 'all')}>
            All ({counts.all})
          </button>
          <button onClick={() => setFilter('active')} style={pillStyle(filter === 'active', 'teal')}>
            <Icon name="check" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Active ({counts.active})
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
                      {(ACCESS_TYPES.find(a => a.id === accessTypeForUser(u))?.label) || u.role}
                      {u.crew_type ? ` · ${crewTypeLabel(u.crew_type)}` : ''} · {u.email}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => setEditing(u)} style={tinyBtn('default')}>Edit</button>
                    <button onClick={() => setResettingPwFor(u)} style={tinyBtn('default')}><Icon name="key" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 4 }} />Pw</button>
                    <button
                      onClick={() => handleToggleActive(u)}
                      disabled={isSelf}
                      title={isSelf ? `Can't deactivate yourself` : ''}
                      style={tinyBtn(u.is_active ? 'amber' : 'teal', isSelf)}
                    >
                      {u.is_active ? '⊘' : <Icon name="check" size={12} style={{ display: 'inline-block', verticalAlign: '-2px' }} />}
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
          truckLocations={truckLocations}
          onChangeEmail={handleChangeEmail}
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

      {/* Bulk-assign pull location to N users */}
      {showBulkAssign && (
        <BulkAssignPullLocationSheet
          users={users.filter(u => u.is_active)}
          truckLocations={truckLocations}
          onCancel={() => setShowBulkAssign(false)}
          onComplete={(result) => {
            setShowBulkAssign(false)
            const msg = []
            if (result.assigned > 0) msg.push(`${result.assigned} assigned`)
            if (result.cleared > 0) msg.push(`${result.cleared} cleared`)
            if (result.transfers > 0) msg.push(`${result.transfers} stock transfers`)
            if (result.skipped > 0) msg.push(`${result.skipped} unchanged`)
            showToast(msg.length ? msg.join(' · ') : 'Done')
            load()
          }}
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

function UserFormSheet({ mode, user, isOwner, existingUsers, truckLocations = [], onChangeEmail, onCancel, onSubmit }) {
  const isNew = mode === 'new'

  // For new users, "username" is the user-facing field. For existing users
  // we treat email as read-only and only edit metadata.
  const [name, setName] = useState(user?.name || '')
  const [username, setUsername] = useState('')
  // Named access type (Crew / Working manager / Warehouse / Accounting /
  // Full manager / Owner / Contractor). Maps to {role, staff_scope, crew_type}
  // via accessTypeToFields — see lib/access.js. Replaces the old role select +
  // restricted_to_inventory checkbox.
  const [accessType, setAccessType] = useState(accessTypeForUser(user))
  const [crewType, setCrewType] = useState(user?.crew_type || 'fiber_construction')
  const selectedType = ACCESS_TYPES.find(a => a.id === accessType) || ACCESS_TYPES[0]
  const accessFields = accessTypeToFields(accessType, crewType)
  const role = accessFields.role   // derived; used by the existing role-gated sections
  // Who this user reports to. Drives CrewStatus filtering (managers see
  // only their direct reports). Empty string = unmanaged; we map to NULL
  // on save. Owners typically have no manager.
  const [managerId, setManagerId] = useState(user?.manager_id || '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [initials, setInitials] = useState(user?.initials || '')
  const [isActive, setIsActive] = useState(user?.is_active !== false)
  const [language, setLanguage] = useState(user?.language || 'en')
  // Shared pull location override. NULL = use personal truck (default).
  // When changed, we go through the RPC (not the plain users UPDATE) so
  // stock migration + truck deactivation happen atomically.
  const [pullLocationId, setPullLocationId] = useState(user?.default_pull_location_id || '')
  const initialPullLocationId = user?.default_pull_location_id || ''
  // Manager-side direct reports. Multi-select that flips each crew's
  // manager_id when saved. Only meaningful for owners + managers; hidden
  // for crew/contractor. Initialized from existingUsers where manager_id
  // matches this user. New users skip this section (we need an id to
  // assign reports to).
  const initialDirectReportIds = useMemo(() => {
    if (!user?.id) return new Set()
    return new Set(
      (existingUsers || []).filter(u => u.manager_id === user.id).map(u => u.id)
    )
  }, [user?.id, existingUsers])
  const [directReportIds, setDirectReportIds] = useState(initialDirectReportIds)
  const [reportsSearch, setReportsSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Editable login email (existing users only). Changing it goes through the
  // admin-set-email Edge Function via onChangeEmail — separate from the main
  // metadata Save because it's a privileged auth-identity change that can fail
  // independently. Has its own inline Save + confirmation.
  const [companyEmail, setCompanyEmail] = useState(user?.email || '')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailMsg, setEmailMsg] = useState(null)   // { type: 'ok'|'err', text }

  async function handleSaveEmail() {
    const next = companyEmail.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
      setEmailMsg({ type: 'err', text: 'Enter a valid email address' }); return
    }
    setEmailSaving(true); setEmailMsg(null)
    try {
      await onChangeEmail(user, next)
      setEmailMsg({ type: 'ok', text: 'Login email updated' })
    } catch (e) {
      setEmailMsg({ type: 'err', text: e.message || 'Failed' })
    } finally {
      setEmailSaving(false)
    }
  }

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
      if (!password || password.length < 8) { setError('Password must be at least 8 characters'); return }
      if (usernameConflict) { setError('Username already taken'); return }
    }
    if (!ACCESS_TYPES.find(a => a.id === accessType)) { setError('Pick an access type'); return }
    if (accessType === 'owner' && cannotPickOwner) { setError('Only owners can create other owners'); return }

    setSubmitting(true)
    try {
      if (isNew) {
        await onSubmit({
          name: name.trim(),
          username: username.trim().toLowerCase(),
          role: accessFields.role,
          crew_type: accessFields.crew_type,
          staff_scope: accessFields.staff_scope,
          password,
          initials: initials.trim() || generateInitials(name),
          language,
          is_active: isActive,
          manager_id: managerId || null,
          restricted_to_inventory: false,   // superseded by staff_scope
        })
      } else {
        // Pull-location change goes through the RPC (handles stock migration
        // + personal-truck deactivation atomically). Do this BEFORE the
        // metadata save so failures don't leave inconsistent state.
        const normalizedPull = pullLocationId || null
        const normalizedInitial = initialPullLocationId || null
        if (normalizedPull !== normalizedInitial) {
          await bulkAssignPullLocation({
            userIds: [user.id],
            locationId: normalizedPull,  // null = clear assignment + reactivate personal truck
          })
        }
        await onSubmit({
          name: name.trim(),
          role: accessFields.role,
          crew_type: accessFields.crew_type,
          staff_scope: accessFields.staff_scope,
          initials: initials.trim() || generateInitials(name),
          language,
          is_active: isActive,
          manager_id: managerId || null,
          restricted_to_inventory: false,   // superseded by staff_scope
        })
        // Direct-reports diff — only for owner/manager edits. Add: set
        // manager_id = this user's id on newly-checked crews. Remove: clear
        // manager_id on newly-unchecked crews (set NULL). Errors here are
        // non-fatal (the main user save already succeeded) — surfaced but
        // don't roll back.
        if (role === 'manager' || role === 'owner') {
          const adds = [...directReportIds].filter(id => !initialDirectReportIds.has(id))
          const removes = [...initialDirectReportIds].filter(id => !directReportIds.has(id))
          const reportErrors = []
          for (const id of adds) {
            try { await updateUserMetadata(id, { manager_id: user.id }) }
            catch (e) { reportErrors.push(`add ${id}: ${e.message}`) }
          }
          for (const id of removes) {
            try { await updateUserMetadata(id, { manager_id: null }) }
            catch (e) { reportErrors.push(`remove ${id}: ${e.message}`) }
          }
          if (reportErrors.length > 0) {
            setError(`User saved but ${reportErrors.length} direct-report change(s) failed: ${reportErrors.slice(0, 3).join('; ')}`)
            return
          }
        }
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
            <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'inline-flex' }}><Icon name="x" size={18} /></button>
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

          {/* Login email — only for new users. Enter the real company mailbox
              so password-reset links deliver; a bare prefix still works and
              auto-appends the domain (legacy path). */}
          {isNew && (
            <div className="field">
              <label>Company email *</label>
              <input
                type="text" value={username}
                onChange={e => { setUsername(e.target.value.toLowerCase()); setError('') }}
                placeholder="firstname.lastname@utahbroadband.com"
                autoCapitalize="none" autoCorrect="off" spellCheck="false"
                autoComplete="off"
                name="new-user-username"
                style={{
                  borderColor: usernameConflict ? 'var(--red)' : undefined
                }}
              />
              <div style={{ fontSize: 11, color: usernameConflict ? 'var(--red)' : 'var(--hint)', marginTop: 4 }}>
                Email: <code style={{ fontFamily: 'monospace' }}>{emailPreview}</code>
                {usernameConflict && <span style={{ marginLeft: 8 }}><Icon name="alert" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 4 }} />already taken</span>}
              </div>
            </div>
          )}

          {/* Login email — editable for existing users (auth identity). */}
          {!isNew && (
            <div className="field">
              <label>Login email</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="email"
                  value={companyEmail}
                  onChange={e => { setCompanyEmail(e.target.value); setEmailMsg(null) }}
                  autoCapitalize="none" autoCorrect="off" spellCheck="false"
                  autoComplete="off" name="company-email-field"
                  style={{ flex: 1, fontFamily: 'monospace' }}
                />
                <button
                  type="button"
                  onClick={handleSaveEmail}
                  disabled={
                    emailSaving ||
                    !companyEmail.trim() ||
                    companyEmail.trim().toLowerCase() === (user?.email || '').toLowerCase()
                  }
                  style={{
                    padding: '8px 12px', borderRadius: 'var(--r-sm)',
                    border: '1.5px solid var(--teal)', background: 'var(--surface2)',
                    color: 'var(--teal-mid)', fontSize: 12, fontWeight: 700,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                    opacity: (emailSaving || !companyEmail.trim() || companyEmail.trim().toLowerCase() === (user?.email || '').toLowerCase()) ? 0.5 : 1,
                  }}
                >{emailSaving ? 'Saving…' : 'Update'}</button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4, lineHeight: 1.5 }}>
                Used to sign in (name or this address) and to deliver password-reset links.
                {companyEmail.trim() && !companyEmail.trim().toLowerCase().endsWith('@utahbroadband.com') && (
                  <span style={{ display: 'block', color: 'var(--amber)', marginTop: 2 }}>
                    <Icon name="alert" size={11} style={{ display: 'inline-block', verticalAlign: '-1px', marginRight: 4 }} />
                    Not a @utahbroadband.com address — reset links won't deliver unless this inbox is real.
                  </span>
                )}
              </div>
              {emailMsg && (
                <div style={{
                  marginTop: 6, padding: '6px 10px', borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600,
                  background: emailMsg.type === 'ok' ? 'var(--teal-lt)' : 'var(--red-lt)',
                  color: emailMsg.type === 'ok' ? 'var(--teal)' : 'var(--red)',
                }}>{emailMsg.text}</div>
              )}
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

          {/* Access type — sets role + scope + crew_type behind the scenes. */}
          <div className="field">
            <label>Access type *</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ACCESS_TYPES.map(a => {
                const disabled = a.ownerOnly && cannotPickOwner
                const selected = accessType === a.id
                return (
                  <button
                    key={a.id}
                    onClick={() => !disabled && setAccessType(a.id)}
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
                      {a.label}{disabled ? ' (owner-only)' : ''}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{a.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Crew type — only for the access types that carry one (Crew +
              Working manager). Everyone else persists crew_type = NULL. */}
          {selectedType.needsCrew && (
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
                Determines which assemblies crew see, and (for working managers) which crew view they switch into.
              </div>
            </div>
          )}

          {/* Pull materials from — only shown in edit mode. New users default
              to personal truck (auto-created by trigger); admin can flip
              them to a shared trailer afterwards.
              Changes go through bulk_assign_pull_location RPC so stock from
              the personal truck migrates atomically to the new location,
              and the personal truck auto-deactivates. Clearing back to
              "Personal truck" reactivates the personal truck (empty). */}
          {!isNew && (
            <div className="field">
              <label>Pull materials from</label>
              <select
                value={pullLocationId}
                onChange={e => setPullLocationId(e.target.value)}
                style={{ width: '100%' }}
                disabled={truckLocations.length === 0}
              >
                <option value="">— Personal truck (default) —</option>
                {/* The user's own personal truck (if any) first. */}
                {truckLocations
                  .filter(l => l.assigned_to === user?.id)
                  .map(l => (
                    <option key={l.id} value={l.id}>
                      🚚 {l.name} (their personal truck)
                    </option>
                  ))}
                {/* Shared targets: group locations + any other crew's/unassigned truck. */}
                {truckLocations
                  .filter(l => l.assigned_to !== user?.id)
                  .map(l => (
                    <option key={l.id} value={l.id}>
                      👥 {l.name} (shared)
                    </option>
                  ))}
              </select>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
                Set this to a shared trailer (e.g. Grady's Trailer) for crews who pull
                from a pooled on-site location instead of their personal truck. Changing
                this will move any stock on the user's personal truck to the new location
                and deactivate the personal truck.
              </div>
              {(() => {
                // Cross-crew soft warning. If the picked trailer's name suggests
                // crew types that DON'T include this user's crew_type, render
                // an amber note — doesn't block, just confirms intent. Shared
                // trailers ("Aerial & Underground") return multiple inferred
                // types; user passing any of them suppresses the warning.
                if (!pullLocationId || !crewType) return null
                const loc = truckLocations.find(l => l.id === pullLocationId)
                if (!loc) return null
                const lowerName = (loc.name || '').toLowerCase()
                const trailerTypes = crewTypesFromName(lowerName)
                if (trailerTypes.length === 0 || trailerTypes.includes(crewType)) return null
                return (
                  <div style={{
                    marginTop: 6, padding: '6px 10px',
                    background: 'var(--amber-lt)', color: 'var(--amber)',
                    border: '1px solid var(--amber)', borderRadius: 'var(--r-xs)',
                    fontSize: 11, fontWeight: 600,
                  }}>
                    <Icon name="alert" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 4 }} /><strong>{loc.name}</strong> sounds like a <strong>{trailerTypes.join(' / ')}</strong> trailer,
                    but this user's crew type is <strong>{crewType}</strong>. Assign anyway?
                  </div>
                )
              })()}
            </div>
          )}

          {/* Manager — who this user reports to. Drives the CrewStatus
              filter: managers see only their direct reports; owners see
              everyone. Self-assignment is filtered out to avoid cycles. */}
          <div className="field">
            <label>Reports to (manager)</label>
            <select
              value={managerId}
              onChange={e => setManagerId(e.target.value)}
              style={{ width: '100%' }}
            >
              <option value="">— Unmanaged —</option>
              {existingUsers
                .filter(u => (u.role === 'owner' || u.role === 'manager') && u.is_active && u.id !== user?.id)
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                .map(u => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
            </select>
            <div style={{ fontSize: 11, color: 'var(--hint)', marginTop: 4 }}>
              Determines who sees this user on their Crew tab. Leave blank for owners or unassigned users.
            </div>
          </div>

          {/* Direct reports — multi-select that flips each crew's manager_id
              on save. Visible for owner/manager edits only; new users skip
              it (we need the id to assign reports to). */}
          {!isNew && (role === 'manager' || role === 'owner') && (
            <DirectReportsPicker
              user={user}
              existingUsers={existingUsers}
              search={reportsSearch}
              setSearch={setReportsSearch}
              selectedIds={directReportIds}
              setSelectedIds={setDirectReportIds}
            />
          )}

          {/* Password — new users only */}
          {isNew && (
            <div className="field">
              <label>Initial password * (minimum 8 characters)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
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
            <>
              <CrewPermissionsSection userId={user?.id} />
              <LoadDestinationsSection userId={user?.id} />
            </>
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
            disabled={submitting || !name.trim() || (isNew && (!username.trim() || password.length < 8 || usernameConflict))}
          >
            {submitting ? 'Saving…' : (isNew ? 'Create user' : 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Direct reports picker ────────────────────────────────────────────────
// Multi-select of crews assigned to this manager/owner. On save, the
// parent diffs selectedIds vs the initial set and flips manager_id on
// each affected crew. Search filter narrows the list when there are
// many active users.
function DirectReportsPicker({ user, existingUsers, search, setSearch, selectedIds, setSelectedIds }) {
  // Pool of users we can assign: active crew + contractor, never the
  // user themselves. Sorted by name for stable rendering.
  const pool = useMemo(() => {
    return (existingUsers || [])
      .filter(u => u.is_active && u.id !== user?.id && (u.role === 'crew' || u.role === 'contractor'))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [existingUsers, user?.id])
  // Filtered by search across name + crew_type + email
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return pool
    return pool.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.crew_type || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    )
  }, [pool, search])
  function toggle(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function selectAllFiltered() {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const u of filtered) next.add(u.id)
      return next
    })
  }
  function clearAllFiltered() {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const u of filtered) next.delete(u.id)
      return next
    })
  }
  return (
    <div className="field">
      <label>Direct reports ({selectedIds.size} selected)</label>
      <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 6 }}>
        Crews assigned here will see this user as their manager. Checking a crew already managed by someone else
        will move them under this manager on save.
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          type="text"
          placeholder="Search by name, crew type, email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoComplete="off"
          name="reports-search"
          style={{ flex: 1, padding: '6px 10px', fontSize: 13, border: '1.5px solid var(--border2)', borderRadius: 'var(--r-sm)', background: 'var(--surface2)' }}
        />
        <button type="button" onClick={selectAllFiltered} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
          All
        </button>
        <button type="button" onClick={clearAllFiltered} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }}>
          None
        </button>
      </div>
      <div style={{
        maxHeight: 240, overflowY: 'auto',
        border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
        background: 'var(--surface)',
      }}>
        {filtered.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--hint)', fontSize: 12 }}>
            {pool.length === 0 ? 'No active crew users to assign.' : 'No matches for that search.'}
          </div>
        )}
        {filtered.map(u => {
          const checked = selectedIds.has(u.id)
          const isMovingFromAnother = u.manager_id && u.manager_id !== user?.id && checked
          return (
            <label key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '9px 12px', margin: 0, cursor: 'pointer',
              borderBottom: '1px solid var(--row-divider)',
              background: checked ? 'var(--accent-lt)' : 'transparent',
            }}>
              <input type="checkbox" checked={checked} onChange={() => toggle(u.id)} style={{ accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Explicit color + size: the row is a <label>, and the global
                    `.field label` rule otherwise leaks muted grey / small type
                    into these names, making them hard to read on the light theme. */}
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{u.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 1 }}>
                  {u.role}{u.crew_type ? ` · ${crewTypeLabel(u.crew_type)}` : ''}
                  {isMovingFromAnother && <span style={{ color: 'var(--amber)', marginLeft: 6 }}>· will move from current manager</span>}
                </div>
              </div>
            </label>
          )
        })}
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
    if (!pw || pw.length < 8) { setError('Password must be at least 8 characters'); return }
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
          <label>New password (minimum 8 characters)</label>
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
            onClick={handleSubmit} disabled={submitting || pw.length < 8}
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
  load:     { iconName: 'download', label: 'Load',     desc: 'Warehouse → my truck' },
  return:   { iconName: 'rotate',   label: 'Return',   desc: 'My truck → warehouse' },
  issue:    { iconName: 'upload',   label: 'Issue',    desc: 'Consumed in field (manual)' },
  scrap:    { iconName: 'trash',    label: 'Scrap',    desc: 'Damaged / written off' },
  transfer: { iconName: 'move',     label: 'Transfer', desc: 'My truck → another crew' },
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
              <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center' }}><Icon name={meta.iconName} size={16} /></span>
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

// ─── Load-destinations whitelist section ──────────────────────────────────
// Per-user list of locations this crew member can Load TO (in addition
// to their own truck, which is always implicit). Empty list = today's
// behavior (truck-only). Staff write per RLS (cld_staff_write = is_staff()),
// so all managers can edit these — not just owners.
function LoadDestinationsSection({ userId }) {
  const { currentUser } = useApp()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [allLocations, setAllLocations] = useState([])
  const [addPickerId, setAddPickerId] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      getCrewLoadDestinations(userId),
      getLocations({ includeBins: true }),
    ])
      .then(([dests, locs]) => {
        if (cancelled) return
        setRows(dests || [])
        setAllLocations((locs || []).filter(l => l.is_active))
      })
      .catch(e => { if (!cancelled) setErr(e.message || 'Failed to load destinations') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userId])

  const grantedIds = useMemo(() => new Set(rows.map(r => r.id)), [rows])
  // Master list of options the owner can add: any active location they
  // haven't already granted, minus this user's own truck (always allowed
  // implicitly so it shouldn't appear).
  const addOptions = useMemo(() => {
    return allLocations.filter(l =>
      !grantedIds.has(l.id) &&
      // Hide the user's own truck so it doesn't appear as an option (it's
      // implicit). We don't have userId-truck mapping in this section, so
      // we just hide trucks assigned to this user.
      !(l.type === 'truck' && l.assigned_to === userId)
    )
  }, [allLocations, grantedIds, userId])

  async function persist(nextIds) {
    setSaving(true); setErr('')
    try {
      await setCrewLoadDestinations(userId, nextIds, { grantedBy: currentUser?.id || null })
      // Build the new rows array from allLocations using the picked IDs.
      const next = nextIds
        .map(id => allLocations.find(l => l.id === id))
        .filter(Boolean)
      setRows(next)
      setAddPickerId('')
    } catch (e) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function add(id) {
    if (!id) return
    const nextIds = [...rows.map(r => r.id), id]
    persist(nextIds)
  }
  function remove(id) {
    const nextIds = rows.map(r => r.id).filter(x => x !== id)
    persist(nextIds)
  }

  function labelFor(loc) {
    if (!loc) return ''
    if (loc.type === 'bin' && loc.parent_location_id) {
      const parent = allLocations.find(l => l.id === loc.parent_location_id)
      if (parent) return `${parent.name} · ${loc.name}`
    }
    return loc.name
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: 'var(--muted)',
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
      }}>
        <Icon name="truck" size={13} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Load destinations
      </div>
      <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 8 }}>
        Allowed Load targets besides this user's own truck. Empty = truck-only (default).
      </div>

      {loading && (
        <div style={{ padding: 8, color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
      )}

      {!loading && rows.length === 0 && (
        <div style={{
          padding: '8px 12px', marginBottom: 8,
          background: 'var(--surface2)', border: '1px dashed var(--border)',
          borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--muted)',
        }}>
          Truck-only (no additional destinations granted).
        </div>
      )}

      {!loading && rows.map(loc => (
        <div
          key={loc.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px', marginBottom: 6,
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{labelFor(loc)}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{loc.type}</div>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => remove(loc.id)}
            title="Remove"
            style={{
              padding: '4px 10px', fontSize: 11, fontWeight: 700,
              background: 'transparent', color: 'var(--red)',
              border: '1px solid var(--red)', borderRadius: 'var(--r-xs)',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.5 : 1,
              display: 'inline-flex', alignItems: 'center',
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}

      {!loading && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select
            value={addPickerId}
            onChange={e => setAddPickerId(e.target.value)}
            disabled={saving || addOptions.length === 0}
            autoComplete="off"
            name={`load-dest-picker-${userId}`}
            style={{ flex: 1 }}
          >
            <option value="">
              {addOptions.length === 0 ? '— no locations available —' : '＋ Add a destination'}
            </option>
            {addOptions.map(l => (
              <option key={l.id} value={l.id}>{labelFor(l)} ({l.type})</option>
            ))}
          </select>
          <button
            type="button"
            disabled={saving || !addPickerId}
            onClick={() => add(addPickerId)}
            className="btn btn-ghost"
            style={{ padding: '6px 12px', fontSize: 12 }}
          >
            Add
          </button>
        </div>
      )}

      {err && (
        <div style={{ padding: '6px 10px', marginTop: 6, fontSize: 12, color: 'var(--red)', background: 'var(--red-lt)', borderRadius: 'var(--r-xs)' }}>
          {err}
        </div>
      )}
    </div>
  )
}

// ─── Bulk-assign pull location sheet ──────────────────────────────────────
// Multi-select users + pick a target trailer (or "Personal truck" to clear).
// Fires bulk_assign_pull_location with the full user_id array. Atomic
// per-user: stock migrates from personal truck → trailer, personal truck
// deactivates. Used for "flip Grady's 6 to Grady's Trailer" scenarios.
function BulkAssignPullLocationSheet({ users, truckLocations, onCancel, onComplete }) {
  const [selectedUserIds, setSelectedUserIds] = useState(() => new Set())
  const [targetLocationId, setTargetLocationId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [crewTypeFilter, setCrewTypeFilter] = useState('all')

  // Crew-type filter — convenience for "select all aerial guys" workflows.
  const filteredUsers = useMemo(() => {
    if (crewTypeFilter === 'all') return users
    return users.filter(u => u.crew_type === crewTypeFilter)
  }, [users, crewTypeFilter])

  function toggle(userId) {
    setSelectedUserIds(prev => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  function selectAllFiltered() {
    setSelectedUserIds(prev => {
      const next = new Set(prev)
      filteredUsers.forEach(u => next.add(u.id))
      return next
    })
  }

  function selectNone() { setSelectedUserIds(new Set()) }

  async function handleSubmit() {
    setError('')
    if (selectedUserIds.size === 0) { setError('Pick at least one user'); return }
    setSubmitting(true)
    try {
      // Empty string = "Personal truck (clear assignment)" maps to NULL
      const locationId = targetLocationId || null
      const result = await bulkAssignPullLocation({
        userIds: Array.from(selectedUserIds),
        locationId,
      })
      onComplete(result)
    } catch (e) {
      setError(e.message || 'Bulk assignment failed')
      setSubmitting(false)
    }
  }

  const selectedTrailer = targetLocationId ? truckLocations.find(l => l.id === targetLocationId) : null

  return (
    <div className="overlay open" onClick={e => e.target === e.currentTarget && !submitting && onCancel()}>
      <div className="overlay-sheet" style={{ maxWidth: 560, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flexShrink: 0, marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>
            <Icon name="truck" size={17} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 8 }} />Bulk assign pull location
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Assign N users to a shared trailer at once. Each user's personal-truck stock
            migrates to the target location, and their personal truck deactivates.
          </div>
        </div>

        {/* Target location */}
        <div className="field" style={{ flexShrink: 0 }}>
          <label>Target location</label>
          <select
            value={targetLocationId}
            onChange={e => setTargetLocationId(e.target.value)}
            disabled={submitting}
          >
            <option value="">— Personal truck (clear current assignments) —</option>
            {truckLocations.map(l => (
              <option key={l.id} value={l.id}>
                🚚 {l.name}{l.assigned_user?.name ? ` (${l.assigned_user.name}'s personal)` : ' (shared)'}
              </option>
            ))}
          </select>
        </div>

        {/* Crew-type filter + selection controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <select
            value={crewTypeFilter}
            onChange={e => setCrewTypeFilter(e.target.value)}
            disabled={submitting}
            style={{ padding: '6px 10px', fontSize: 12, borderRadius: 'var(--r-xs)', border: '1.5px solid var(--border2)', background: 'var(--surface2)' }}
          >
            <option value="all">All crew types</option>
            {CREW_TYPE_OPTIONS.map(ct => (
              <option key={ct.id} value={ct.id}>{ct.label}</option>
            ))}
          </select>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {selectedUserIds.size} selected · {filteredUsers.length} shown
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={selectAllFiltered} disabled={submitting} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }}>Select shown</button>
            <button onClick={selectNone} disabled={submitting} className="btn btn-ghost" style={{ padding: '4px 10px', fontSize: 11 }}>None</button>
          </div>
        </div>

        {/* User checklist */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 100, marginBottom: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
          {filteredUsers.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--hint)', fontSize: 13 }}>
              No users match this filter.
            </div>
          )}
          {filteredUsers.map(u => (
            <label key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
              borderBottom: '1px solid var(--border)', cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={selectedUserIds.has(u.id)}
                onChange={() => toggle(u.id)}
                disabled={submitting}
                style={{ cursor: 'pointer' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{u.name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {u.role}{u.crew_type ? ` · ${crewTypeLabel(u.crew_type)}` : ''}
                  {u.default_pull_location_id && <> · currently assigned</>}
                </div>
              </div>
            </label>
          ))}
        </div>

        {/* Confirm summary */}
        {selectedUserIds.size > 0 && (
          <div style={{
            padding: '8px 12px', marginBottom: 10, flexShrink: 0,
            background: 'var(--orange-lt)', border: '1px solid var(--orange-dk)',
            borderRadius: 'var(--r-sm)', fontSize: 12, color: 'var(--orange)',
          }}>
            <strong>{selectedUserIds.size} user{selectedUserIds.size === 1 ? '' : 's'}</strong>{' '}
            will be assigned to{' '}
            <strong>{selectedTrailer ? selectedTrailer.name : 'their personal truck (cleared)'}</strong>.
            {selectedTrailer && ' Any non-zero stock on each user\'s personal truck will move to the target.'}
          </div>
        )}

        {error && (
          <div style={{
            padding: '6px 10px', marginBottom: 10, flexShrink: 0,
            background: 'var(--red-lt)', color: 'var(--red)', fontSize: 12, fontWeight: 600,
            borderRadius: 'var(--r-xs)',
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            style={{ flex: 2 }}
            onClick={handleSubmit}
            disabled={submitting || selectedUserIds.size === 0}
          >
            {submitting ? 'Applying…' : `Assign ${selectedUserIds.size} user${selectedUserIds.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
