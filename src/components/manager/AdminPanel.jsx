import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db } from '../../lib/supabase'
import AdminUsersView from './AdminUsersView'
import CrewTypePermissionsView from './CrewTypePermissionsView'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

export default function AdminPanel() {
  const {
    projects, setProjects, showToast, reload,
    qtyDisplayMode, qtyDisplayUpdatedAt, qtyDisplayUpdatedBy,
    setInventoryQtyDisplayMode, users,
  } = useApp()
  const [qtyToggling, setQtyToggling] = useState(false)
  const [selProject, setSelProject] = useState(null)
  const [loading, setLoading] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [view, setView] = useState('projects') // 'projects' | 'users' | 'crewperms'

  // Back dismisses the confirm dialog (same as its Cancel).
  useBackClose(confirm ? 1 : 0, () => setConfirm(null))
  // Back steps out of a sub-view (Users / Crew perms) or the project detail
  // back to the admin home. One level — these don't stack.
  useBackClose((view !== 'projects' || selProject) ? 1 : 0, () => {
    if (view !== 'projects') setView('projects')
    else if (selProject) setSelProject(null)
  })

  // Editing state
  const [editingName, setEditingName] = useState(null)
  const [editVal, setEditVal] = useState('')
  const [saving, setSaving] = useState(false)

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
            style={{ padding: '6px 10px', background: 'var(--gray-lt)', color: 'var(--muted)', border: 'none', borderRadius: 'var(--r-xs)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}><Icon name="x" size={14} /></button>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{value}</span>
        <button onClick={() => { setEditingName(id); setEditVal(value) }}
          style={{ fontSize: 11, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
          <Icon name="edit" size={11} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 4 }} />rename
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
              <Icon name="trash" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Delete project
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
                  <Icon name="trash" size={13} style={{ verticalAlign: '-2px', marginRight: 5, display: 'inline-block' }} />Clear data
                </button>
                <button
                  onClick={() => setConfirm({ label: `Delete phase "${ph.name}" and ALL its tasks and submissions?`, action: () => deletePhase(ph) })}
                  style={{ flex: 1, padding: '7px', background: 'var(--red-lt)', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  <Icon name="trash" size={12} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Delete phase
                </button>
              </div>
            </div>
          ))}
        </div>

        {confirm && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirm(null)}>
            <div className="overlay-sheet">
              <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 12, color: 'var(--red)' }}><Icon name="alert" size={17} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 8 }} />Are you sure?</div>
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
            <div style={{ fontWeight: 700, fontSize: 14 }}><Icon name="users" size={14} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }} />Manage users</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Add new users, edit roles & permissions, deactivate accounts
            </div>
          </div>
          <span style={{ display: 'inline-flex', color: 'var(--muted)' }}><Icon name="chevron-right" size={16} /></span>
        </div>

        {/* Inventory section */}
        <div className="sec-label">Inventory</div>

        {/* Org-wide stock display mode (Tracking / Paused).
            Pause hides qty numbers across the app and shows "last seen"
            recency instead — useful when Sage Intacct is authoritative
            on counts and FiberLog's logged quantities would drift. */}
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="eye" size={15} /> Stock display mode</div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, lineHeight: 1.4 }}>
                {qtyDisplayMode === 'paused'
                  ? <>Paused — qty numbers are hidden and replaced with last-seen recency.
                      Sage Intacct is the source of truth. Movements still record qty normally.</>
                  : <>Tracking — all qty numbers visible. Switch to <strong>Paused</strong> if Sage is
                      authoritative and you don't want FiberLog's running totals to drift.</>}
              </div>
              {qtyDisplayUpdatedAt && (
                <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 4 }}>
                  Last toggled {new Date(qtyDisplayUpdatedAt).toLocaleString()}
                  {qtyDisplayUpdatedBy && users && (() => {
                    const u = users.find(x => x.id === qtyDisplayUpdatedBy)
                    return u ? ` by ${u.name}` : ''
                  })()}
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={qtyToggling}
              onClick={async () => {
                setQtyToggling(true)
                try {
                  const next = qtyDisplayMode === 'paused' ? 'tracking' : 'paused'
                  await setInventoryQtyDisplayMode(next)
                  showToast(next === 'paused'
                    ? 'Stock display paused — Sage is now the authoritative source'
                    : 'Stock display resumed — qty numbers are back')
                } catch (e) {
                  showToast(e.message || 'Failed to update display mode')
                } finally {
                  setQtyToggling(false)
                }
              }}
              style={{
                padding: '6px 12px', borderRadius: 999,
                background: qtyDisplayMode === 'paused' ? 'var(--amber-lt)' : 'var(--teal-lt)',
                color: qtyDisplayMode === 'paused' ? 'var(--amber)' : 'var(--teal-dk)',
                border: `1.5px solid ${qtyDisplayMode === 'paused' ? 'var(--amber)' : 'var(--teal)'}`,
                fontWeight: 700, fontSize: 12,
                cursor: qtyToggling ? 'not-allowed' : 'pointer',
                opacity: qtyToggling ? 0.5 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {qtyToggling
                ? '…'
                : qtyDisplayMode === 'paused'
                  ? '⏸ Paused · Resume'
                  : '▶ Tracking · Pause'}
            </button>
          </div>
        </div>

        <div
          onClick={() => setView('crewperms')}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 7 }}><Icon name="lock" size={15} /> Crew × Department permissions</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              Restrict which part departments each crew type can move (leave empty for unrestricted)
            </div>
          </div>
          <span style={{ display: 'inline-flex', color: 'var(--muted)' }}><Icon name="chevron-right" size={16} /></span>
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
            <span style={{ display: 'inline-flex', color: 'var(--muted)' }}><Icon name="chevron-right" size={16} /></span>
          </div>
        ))}
      </div>
    </div>
  )
}
