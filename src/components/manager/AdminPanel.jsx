import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import AdminUsersView from './AdminUsersView'
import CrewTypePermissionsView from './CrewTypePermissionsView'

export default function AdminPanel() {
  const { projects, setProjects, users, showToast, reload } = useApp()
  const [selProject, setSelProject] = useState(null)
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [view, setView] = useState('projects') // 'projects' | 'crew' | 'users' | 'crewperms'

  // Password editing
  const [editingPassword, setEditingPassword] = useState(null)
  const [newPassword, setNewPassword] = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  // Editing state
  const [editingName, setEditingName] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [saving, setSaving] = useState(false)

  async function savePassword(user) {
    const pwd = newPassword.trim()
    if (!pwd) {
      showToast('Password cannot be empty')
      return
    }
    if (pwd.length < 8) {
      showToast('Password must be at least 8 characters')
      return
    }
    setPwSaving(true)
    try {
      const { data: { session } } = await db.auth.getSession()
      if (!session) throw new Error('Not signed in')

      const res = await fetch(
        `${db.supabaseUrl}/functions/v1/admin-set-password`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ userId: user.id, newPassword: pwd }),
        }
      )

      const result = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`)

      setEditingPassword(null)
      setNewPassword('')
      showToast(`Password updated for ${user.name}`)
      reload()
    } catch(e) {
      showToast('Failed: ' + e.message)
    } finally {
      setPwSaving(false)
    }
  }

  async function saveProjectName(project) {
    if (!editVal.trim()) return
    setSaving(true)
    try {
      await db.from('projects').update({ name: editVal.trim() }).eq('id', project.id)
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, name: editVal.trim() } : p))
      if (selProject?.id === project.id) setSelProject(prev => ({ ...prev, name: editVal.trim() }))
      setEditingName(null)
      showToast('Project renamed')
    } catch(e) { showToast('Failed: ' + e.message) }
    finally { setSaving(false) }
  }

  async function savePhaseName(phase) {
    if (!editVal.trim()) return
    setSaving(true)
    try {
      await db.from('phases').update({ name: editVal.trim() }).eq('id', phase.id)
      setSelProject(prev => ({
        ...prev,
        phases: prev.phases.map(ph => ph.id === phase.id ? { ...ph, name: editVal.trim() } : ph)
      }))
      setEditingName(null)
      showToast('Phase renamed')
    } catch(e) { showToast('Failed: ' + e.message) }
    finally { setSaving(false) }
  }

  async function deletePhase(phase) {
    setLoading(true)
    try {
      const { data: tasks } = await db.from('tasks').select('id').eq('phase_id', phase.id)
      const taskIds = (tasks || []).map(t => t.id)
      if (taskIds.length > 0) {
        const { data: sessions } = await db.from('work_sessions').select('id').in('task_id', taskIds)
        const sessionIds = (sessions || []).map(s => s.id)
        if (sessionIds.length > 0) {
          const { data: entries } = await db.from('log_entries').select('id').in('session_id', sessionIds)
          const entryIds = (entries || []).map(e => e.id)
          if (entryIds.length > 0) await db.from('entry_parts').delete().in('entry_id', entryIds)
          await db.from('log_entries').delete().in('session_id', sessionIds)
          await db.from('submissions').delete().in('session_id', sessionIds)
          await db.from('work_sessions').delete().in('id', sessionIds)
        }
        await db.from('tasks').delete().in('id', taskIds)
      }
      await db.from('phases').delete().eq('id', phase.id)
      setSelProject(prev => ({ ...prev, phases: prev.phases.filter(ph => ph.id !== phase.id) }))
      setProjects(prev => prev.map(p => p.id === selProject.id
        ? { ...p, phases: p.phases.filter(ph => ph.id !== phase.id) } : p
      ))
      setConfirm(null)
      showToast(`Phase deleted: ${phase.name}`)
    } catch(e) { showToast('Delete failed: ' + e.message) }
    finally { setLoading(false) }
  }

  async function deleteProject(project) {
    setLoading(true)
    try {
      const { data: phases } = await db.from('phases').select('id').eq('project_id', project.id)
      for (const phase of (phases || [])) {
        const { data: tasks } = await db.from('tasks').select('id').eq('phase_id', phase.id)
        const taskIds = (tasks || []).map(t => t.id)
        if (taskIds.length > 0) {
          const { data: sessions } = await db.from('work_sessions').select('id').in('task_id', taskIds)
          const sessionIds = (sessions || []).map(s => s.id)
          if (sessionIds.length > 0) {
            const { data: entries } = await db.from('log_entries').select('id').in('session_id', sessionIds)
            const entryIds = (entries || []).map(e => e.id)
            if (entryIds.length > 0) await db.from('entry_parts').delete().in('entry_id', entryIds)
            await db.from('log_entries').delete().in('session_id', sessionIds)
            await db.from('submissions').delete().in('session_id', sessionIds)
            await db.from('work_sessions').delete().in('id', sessionIds)
          }
          await db.from('tasks').delete().in('id', taskIds)
        }
        await db.from('phases').delete().eq('id', phase.id)
      }
      await db.from('projects').delete().eq('id', project.id)
      setProjects(prev => prev.filter(p => p.id !== project.id))
      setSelProject(null)
      setConfirm(null)
      showToast(`Project deleted: ${project.name}`)
    } catch(e) { showToast('Delete failed: ' + e.message) }
    finally { setLoading(false) }
  }

  async function clearPhaseData(phase) {
    setLoading(true)
    try {
      const { data: tasks } = await db.from('tasks').select('id').eq('phase_id', phase.id)
      const taskIds = (tasks || []).map(t => t.id)
      if (taskIds.length > 0) {
        const { data: sessions } = await db.from('work_sessions').select('id').in('task_id', taskIds)
        const sessionIds = (sessions || []).map(s => s.id)
        if (sessionIds.length > 0) {
          const { data: entries } = await db.from('log_entries').select('id').in('session_id', sessionIds)
          const entryIds = (entries || []).map(e => e.id)
          if (entryIds.length > 0) await db.from('entry_parts').delete().in('entry_id', entryIds)
          await db.from('log_entries').delete().in('session_id', sessionIds)
          await db.from('submissions').delete().in('session_id', sessionIds)
          await db.from('work_sessions').delete().in('id', sessionIds)
        }
        await db.from('tasks').update({ status: 'open' }).in('id', taskIds)
      }
      setConfirm(null)
      showToast(`Test data cleared from ${phase.name}`)
      reload()
    } catch(e) { showToast('Clear failed: ' + e.message) }
    finally { setLoading(false) }
  }

  function EditableField({ value, id, onSave }) {
    const isEditing = editingName === id
    if (isEditing) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') setEditingName(null) }}
            style={{ flex: 1, padding: '6px 10px', background: 'var(--surface2)', border: '1.5px solid var(--orange)', borderRadius: 'var(--r-xs)', color: 'var(--text)', fontSize: 14, fontWeight: 700 }} />
          <button onClick={onSave} disabled={saving}
            style={{ padding: '6px 12px', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {saving ? '...' : 'Save'}
          </button>
          <button onClick={() => setEditingName(null)}
            style={{ padding: '6px 10px', background: 'var(--gray-lt)', color: 'var(--muted)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 12, cursor: 'pointer' }}>✕</button>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{value}</span>
        <button onClick={() => { setEditingName(id); setEditVal(value) }}
          style={{ fontSize: 11, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
          ✎ rename
        </button>
      </div>
    )
  }

  // ── Users management view ───────────────────────────────────────────────
  if (view === 'users') {
    return <AdminUsersView onBack={() => setView('projects')} />
  }

  if (view === 'crewperms') {
    return <CrewTypePermissionsView onBack={() => setView('projects')} />
  }

  // ── Crew / password view ────────────────────────────────────────────────────
  if (view === 'crew') {
    const crewMembers = users.filter(u => u.role !== 'owner')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setView('projects')} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
            <div>
              <div style={{ fontWeight: 800, fontSize: 17 }}>Crew Passwords</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>Set or clear login passwords</div>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {crewMembers.map(u => (
            <div key={u.id} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
                  background: u.role === 'manager' ? 'var(--orange-lt)' : 'var(--surface2)',
                  border: u.role === 'manager' ? '1.5px solid var(--orange-dk)' : '1px solid var(--border2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: 13,
                  color: u.role === 'manager' ? 'var(--orange)' : 'var(--muted)',
                }}>
                  {u.initials}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                    {u.role} · {u.crew_type || '—'}
                  </div>
                </div>
                <button
                  onClick={() => { setEditingPassword(u); setNewPassword('') }}
                  style={{ fontSize: 12, color: 'var(--orange)', fontWeight: 700, background: 'none', border: '1px solid var(--orange)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer', flexShrink: 0 }}>
                  Reset password
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Password edit overlay */}
        {editingPassword && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && (setEditingPassword(null), setNewPassword(''))}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>
                Reset password
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                {editingPassword.name}
              </div>
              <div className="field">
                <label>New password</label>
                <input
                  type="text"
                  placeholder="At least 8 characters"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && savePassword(editingPassword)}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)', marginBottom: 16 }}>
                Communicate the new password to the crew member directly.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }}
                  onClick={() => { setEditingPassword(null); setNewPassword('') }}>
                  Cancel
                </button>
                <button className="btn btn-primary" style={{ flex: 2 }}
                  onClick={() => savePassword(editingPassword)} disabled={pwSaving}>
                  {pwSaving ? 'Saving...' : 'Save password'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Phase detail ────────────────────────────────────────────────────────────
  if (selProject) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setSelProject(null)} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
            <EditableField value={selProject.name} id={`proj-${selProject.id}`} onSave={() => saveProjectName(selProject)} />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div className="sec-label" style={{ margin: 0 }}>Phases</div>
            <button
              onClick={() => setConfirm({ label: `Delete entire project "${selProject.name}" and ALL its data?`, action: () => deleteProject(selProject) })}
              style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700, background: 'none', border: '1px solid var(--red)', borderRadius: 20, padding: '4px 12px', cursor: 'pointer' }}>
              🗑 Delete project
            </button>
          </div>

          {(selProject.phases || []).map(ph => (
            <div key={ph.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8 }}>
              <EditableField value={ph.name} id={`phase-${ph.id}`} onSave={() => savePhaseName(ph)} />
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, marginBottom: 10 }}>
                {ph.tasks?.length || 0} tasks
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => setConfirm({ label: `Clear all test data from "${ph.name}"? Tasks will be reset to open.`, action: () => clearPhaseData(ph) })}
                  style={{ flex: 1, padding: '7px', background: 'var(--amber-lt)', color: 'var(--amber)', border: '1px solid var(--amber)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  🧹 Clear data
                </button>
                <button
                  onClick={() => setConfirm({ label: `Delete phase "${ph.name}" and ALL its tasks and submissions?`, action: () => deletePhase(ph) })}
                  style={{ flex: 1, padding: '7px', background: 'var(--red-lt)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  🗑 Delete phase
                </button>
              </div>
            </div>
          ))}
        </div>

        {confirm && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirm(null)}>
            <div className="overlay-sheet">
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 12, color: 'var(--red)' }}>⚠️ Are you sure?</div>
              <div style={{ fontSize: 14, color: 'var(--text)', marginBottom: 24, lineHeight: 1.5 }}>{confirm.label}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 20 }}>This cannot be undone.</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Cancel</button>
                <button onClick={() => confirm.action()} disabled={loading}
                  style={{ flex: 2, padding: '13px', background: 'var(--red)', color: 'white', border: 'none', borderRadius: 'var(--r-sm)', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                  {loading ? 'Deleting...' : 'Yes, delete'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Project list (home) ─────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 12px', flexShrink: 0 }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Admin</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Owner only — rename, delete, or clear test data</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>

        {/* Crew passwords + Users management */}
        <div className="sec-label">Crew</div>
        <div
          onClick={() => setView('users')}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>👤 Manage users</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Add new users, edit roles & permissions, deactivate accounts
            </div>
          </div>
          <span style={{ fontSize: 16, color: 'var(--muted)' }}>›</span>
        </div>
        <div
          onClick={() => setView('crew')}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🔒 Reset passwords</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Quick password resets for crew and managers
            </div>
          </div>
          <span style={{ fontSize: 16, color: 'var(--muted)' }}>›</span>
        </div>

        {/* Inventory section */}
        <div className="sec-label">Inventory</div>
        <div
          onClick={() => setView('crewperms')}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🔒 Crew × Department permissions</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Restrict which part departments each crew type can move (leave empty for unrestricted)
            </div>
          </div>
          <span style={{ fontSize: 16, color: 'var(--muted)' }}>›</span>
        </div>

        {/* Projects section */}
        <div className="sec-label">Projects</div>
        {projects.map(p => (
          <div key={p.id}
            onClick={() => setSelProject(p)}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{p.phases?.length || 0} phases</div>
            </div>
            <span style={{ fontSize: 16, color: 'var(--muted)' }}>›</span>
          </div>
        ))}
      </div>
    </div>
  )
}
