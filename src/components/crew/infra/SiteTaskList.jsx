import { useState } from 'react'
import { useApp } from '../../../AppContext'
import { addInfraTask } from '../../../lib/supabase'

// SiteTaskList — leaf layer of the infra navigation. Shows the tasks for a
// given site and lets the crew create a new one. Mirrors TaskList.jsx from
// the fiber shell but anchors new tasks on site_id (not phase_id).
//
// We intentionally keep the JOB_TYPES list short for infra: the fiber-specific
// types (fiber_pull, emergency) aren't meaningful here. If/when infra needs
// its own task-type vocabulary (e.g. "tower install", "site maintenance",
// "antenna swap"), extend this list — task_type is a free text column.

const INFRA_JOB_TYPES = [
  { id: 'maintenance', label: 'Maintenance', icon: '🔧' },
  { id: 'build',       label: 'Build / Install', icon: '🏗️' },
  { id: 'swap',        label: 'Equipment Swap', icon: '🔁' },
  { id: 'audit',       label: 'Audit / Inspect', icon: '🔍' },
  { id: 'emergency',   label: 'Emergency', icon: '⚡' },
]

const isActiveCrewTask = t => t.status !== 'done' && t.status !== 'approved' && t.status !== 'pending'
const isCompletedTask  = t => t.status === 'done' || t.status === 'approved'

export default function SiteTaskList({ project, site, onSelect, onBack, onUserTap, onTaskCreated }) {
  const { currentUser, showToast } = useApp()
  const [showNewTask, setShowNewTask] = useState(false)
  const [taskName, setTaskName]   = useState('')
  const [taskNotes, setTaskNotes] = useState('')
  const [jobType, setJobType]     = useState('maintenance')
  const [saving, setSaving]       = useState(false)
  const [showPast, setShowPast]   = useState(false)

  const activeTasks    = site.tasks.filter(isActiveCrewTask)
  const completedTasks = site.tasks.filter(isCompletedTask)
  const pendingTasks   = site.tasks.filter(t => t.status === 'pending')

  async function handleCreate() {
    if (!taskName.trim()) return
    if (!currentUser?.id) return
    setSaving(true)
    try {
      await addInfraTask(site.id, taskName.trim(), jobType, taskNotes.trim(), currentUser.id)
      // Realtime in InfraCrewApp will push the new task in, but onTaskCreated
      // also fires loadTree() as a belt-and-braces refresh in case realtime
      // is lagging (the same pattern fiber crews see via setTaskLocal).
      onTaskCreated?.()
      setTaskName(''); setTaskNotes(''); setJobType('maintenance')
      setShowNewTask(false)
      showToast('Task created')
    } catch (e) {
      console.error('Create infra task failed:', e)
      showToast('Could not create task: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        background: 'var(--surface)',
      }}>
        {onBack && (
          <button
            onClick={onBack}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, color: 'var(--muted)', padding: 4
            }}
          >‹</button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {site.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {project.name}{site.address ? ' · ' + site.address : ''}
          </div>
        </div>
        {onUserTap && (
          <button
            onClick={onUserTap}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'var(--orange-lt)', color: 'var(--orange)',
              border: '1.5px solid var(--orange-dk)',
              fontWeight: 800, fontSize: 11,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer'
            }}
          >👤</button>
        )}
      </div>

      {/* New task button */}
      <div style={{ padding: '10px 14px', flexShrink: 0 }}>
        <button
          className="btn btn-primary"
          onClick={() => setShowNewTask(true)}
          style={{ width: '100%', padding: '10px 14px', fontSize: 13 }}
        >
          ＋ New task at this site
        </button>
      </div>

      {/* Tasks list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 16px' }}>
        {activeTasks.length === 0 && pendingTasks.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
            No active tasks at this site. Tap “New task” above to start one.
          </div>
        )}

        {activeTasks.map(t => (
          <TaskCard key={t.id} task={t} onClick={() => onSelect(t)} />
        ))}

        {pendingTasks.length > 0 && (
          <>
            <SectionLabel>Submitted (awaiting approval)</SectionLabel>
            {pendingTasks.map(t => (
              <TaskCard key={t.id} task={t} onClick={() => onSelect(t)} muted />
            ))}
          </>
        )}

        {completedTasks.length > 0 && (
          <>
            <button
              onClick={() => setShowPast(p => !p)}
              style={{
                width: '100%', marginTop: 16, padding: '8px 0',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 12, color: 'var(--muted)', fontWeight: 600, textAlign: 'left'
              }}
            >
              {showPast ? '▾' : '▸'} {completedTasks.length} completed task{completedTasks.length === 1 ? '' : 's'}
            </button>
            {showPast && completedTasks.map(t => (
              // Tappable — routes through onSelect which the parent
              // (InfraCrewApp) sends to TaskSummaryView for read-only
              // inspection of what was submitted/approved.
              <TaskCard key={t.id} task={t} onClick={() => onSelect(t)} muted />
            ))}
          </>
        )}
      </div>

      {/* New-task overlay */}
      {showNewTask && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowNewTask(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 15, marginBottom: 4 }}>New task</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
              At <strong>{site.name}</strong>
            </div>

            <div className="field">
              <label>Task name</label>
              <input
                type="text"
                value={taskName}
                onChange={e => setTaskName(e.target.value)}
                placeholder="e.g. Replace UPS battery"
                autoFocus
                autoComplete="off"
                name="infra-task-name"
              />
            </div>

            <div className="field">
              <label>Type</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {INFRA_JOB_TYPES.map(jt => (
                  <button
                    key={jt.id}
                    onClick={() => setJobType(jt.id)}
                    style={{
                      padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                      background: jobType === jt.id ? 'var(--orange)' : 'var(--gray-lt)',
                      color: jobType === jt.id ? 'white' : 'var(--muted)',
                      border: 'none', cursor: 'pointer'
                    }}
                  >
                    {jt.icon} {jt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Scope notes (optional)</label>
              <textarea
                value={taskNotes}
                onChange={e => setTaskNotes(e.target.value)}
                rows={3}
                placeholder="What's the work?"
              />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                onClick={() => setShowNewTask(false)}
                disabled={saving}
              >Cancel</button>
              <button
                className="btn btn-primary"
                style={{ flex: 2 }}
                onClick={handleCreate}
                disabled={saving || !taskName.trim()}
              >{saving ? 'Creating…' : 'Create task'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function TaskCard({ task, onClick, muted }) {
  const isPending = task.status === 'pending'
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginBottom: 8,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        cursor: onClick ? 'pointer' : 'default',
        opacity: muted ? 0.7 : 1,
      }}
    >
      <span style={{ fontSize: 16 }}>🛠️</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {task.name}
        </div>
        {task.notes && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.notes}
          </div>
        )}
        <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 2 }}>
          {task.type || task.task_type || 'task'}{task.creator?.name ? ` · ${task.creator.name}` : ''}
        </div>
      </div>
      {isPending && (
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '2px 8px',
          borderRadius: 20, background: 'var(--amber-lt)', color: 'var(--amber)', flexShrink: 0
        }}>Pending</span>
      )}
      {onClick && (
        <span style={{ fontSize: 16, color: 'var(--hint)' }}>›</span>
      )}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '.06em', color: 'var(--hint)',
      padding: '12px 4px 6px',
    }}>{children}</div>
  )
}
