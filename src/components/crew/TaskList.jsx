import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import { db, addTask, subscribeToTasks } from '../../lib/supabase'
import { t } from '../../lib/i18n'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

const JOB_TYPES = [
  { id: 'aerial', label: 'Aerial Construction', icon: '🏗️' },
  { id: 'underground', label: 'Underground', icon: '⛏️' },
  { id: 'splice', label: 'Splice', icon: '🔌' },
  { id: 'fiber_pull', label: 'Fiber Pull', icon: '📦' },
  { id: 'emergency', label: 'Emergency Fix', icon: '⚡' },
]

const JOB_COLORS = {
  aerial:      { bg: 'var(--teal-lt)',   text: 'var(--teal-dk)' },
  underground: { bg: 'var(--amber-lt)',  text: 'var(--amber)' },
  splice:      { bg: 'var(--blue-lt)',   text: 'var(--blue)' },
  fiber_pull:  { bg: 'var(--purple-lt)', text: 'var(--purple)' },
  emergency:   { bg: 'var(--red-lt)',    text: 'var(--red)' },
}

const TYPE_MAP = {
  intermediatePole:'aerial', terminalPole:'aerial', lashingIntermediate:'aerial',
  lashingTerminal:'aerial', downGuy:'aerial', poleRiser:'aerial', snowshoe:'aerial',
  caseSplice:'splice', freeform:'aerial'
}

function getJobType(task) {
  const raw = task.type || task.task_type || 'aerial'
  const normalized = TYPE_MAP[raw] || raw
  return JOB_TYPES.find(j => j.id === normalized) || JOB_TYPES[0]
}

export default function TaskList({ project, phase, onSelect, onBack, onUserTap }) {
  const { currentUser, setTaskLocal, showToast, lang } = useApp()
  const [tasks, setTasks] = useState(phase.tasks || [])
  const [showNewTask, setShowNewTask] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskNotes, setTaskNotes] = useState('')
  const [jobType, setJobType] = useState('aerial')
  const [saving, setSaving] = useState(false)
  const [showPast, setShowPast] = useState(false)
  // Set of task ids in this phase that have a flagged submission for the
  // current user. Used to badge open tasks that were previously flagged
  // and reverted, so the crew knows there's a flag to address before
  // even opening the workspace.
  const [flaggedTaskIds, setFlaggedTaskIds] = useState(() => new Set())

  // Back closes the New-task overlay; confirm first if a name/notes were typed.
  useBackClose(showNewTask ? 1 : 0, () => setShowNewTask(false), {
    confirm: () => !(taskName.trim() || taskNotes.trim()) || window.confirm('Discard this new task?'),
  })

  // Refresh the flagged-id set whenever the task list changes (covers
  // realtime task INSERTs/UPDATEs that change which tasks are in scope).
  // Cheap query — one round-trip, no joins beyond an !inner filter.
  useEffect(() => {
    if (!currentUser?.id || tasks.length === 0) {
      setFlaggedTaskIds(new Set())
      return
    }
    let cancelled = false
    ;(async () => {
      const ids = tasks.map(tk => tk.id)
      const { data, error } = await db
        .from('submissions')
        .select('work_sessions!inner(task_id)')
        .eq('user_id', currentUser.id)
        .eq('status', 'flagged')
        .in('work_sessions.task_id', ids)
      if (cancelled) return
      if (error) { console.warn('Flagged-task lookup failed:', error); return }
      const flagged = new Set(
        (data || []).map(d => d.work_sessions?.task_id).filter(Boolean)
      )
      setFlaggedTaskIds(flagged)
    })()
    return () => { cancelled = true }
  }, [currentUser?.id, tasks])

  useEffect(() => {
    const channel = subscribeToTasks(phase.id, {
      // New tasks created by anyone — hydrate the creator and add to list
      onInsert: async newTask => {
        let creator = null
        if (newTask.created_by) {
          const { data } = await db
            .from('users')
            .select('id, name, initials')
            .eq('id', newTask.created_by)
            .single()
          creator = data || null
        }
        const hydrated = { ...newTask, creator, type: newTask.task_type, notes: newTask.scope_notes || '' }
        setTasks(prev => {
          if (prev.find(tk => tk.id === hydrated.id)) return prev
          showToast(`New task: ${hydrated.name}`)
          return [...prev, hydrated]
        })
        // Defer global update to the microtask queue — React 18's batching means
        // the setTasks updater above hasn't necessarily run yet, but setTaskLocal
        // doesn't depend on local state, so we can queue it directly.
        Promise.resolve().then(() => setTaskLocal(project.id, phase.id, hydrated))
      },
      // Task updated (status change, name edit, etc.) — merge and propagate.
      // The realtime payload only has raw columns, so merge with existing
      // local state to preserve joined fields like `creator`.
      onUpdate: updated => {
        setTasks(prev => {
          const existing = prev.find(tk => tk.id === updated.id)
          if (!existing) return prev
          const merged = {
            ...existing,
            ...updated,
            type: updated.task_type || existing.type,
            notes: updated.scope_notes || existing.notes,
          }
          // Propagate to global state. Defer to the microtask queue so we
          // don't trigger an AppContext update during this component's render.
          Promise.resolve().then(() => {
            setTaskLocal(project.id, phase.id, merged)
            if (updated.status === 'approved') {
              showToast(`${merged.name} approved`)
            }
          })
          return prev.map(tk => tk.id === merged.id ? merged : tk)
        })
      },
    })
    return () => channel.unsubscribe()
  }, [phase.id])

  async function handleCreateTask() {
    if (!taskName.trim()) return
    setSaving(true)
    try {
      const saved = await addTask(phase.id, taskName.trim(), jobType, taskNotes.trim(), currentUser?.id)
      const newTask = { ...saved, type: saved.task_type, notes: saved.scope_notes || '', status: 'open' }
      setTasks(prev => prev.find(tk => tk.id === newTask.id) ? prev : [...prev, newTask])
      setTaskLocal(project.id, phase.id, newTask)
      setTaskName(''); setTaskNotes(''); setJobType('aerial')
      setShowNewTask(false)
      showToast(t('toastTaskAdded', lang))
      // Drop the crew member straight into the newly created task
      onSelect(newTask)
    } catch (e) {
      console.error('Create task failed:', e)
      showToast(t('toastFailedSave', lang))
    } finally {
      setSaving(false)
    }
  }

  // Backlog #2: a task stays in Active until the manager closes it, no
  // matter how many passdowns have been submitted or approved against it.
  // The last passdown's status still shows as a small pill on the row.
  const openTasks = tasks.filter(tk => !tk.is_closed)
  // Only show closed tasks from the last 30 days — older work lives in reports
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - THIRTY_DAYS_MS
  const approvedTasks = tasks.filter(tk => {
    if (!tk.is_closed) return false
    const ts = tk.closed_at || tk.updated_at || tk.created_at
    if (!ts) return true
    return new Date(ts).getTime() >= cutoff
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
          </div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {phase.name} · {project.name}
          </div>
        </div>
        {phase.permit_url && (
          <a
            href={phase.permit_url}
            target="_blank"
            rel="noopener noreferrer"
            className="pill pill-solid-accent"
            style={{ padding: '5px 10px', textDecoration: 'none', flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Icon name="clipboard" size={13} /> Permit
          </a>
        )}
        {onUserTap && <button className="user-btn" onClick={onUserTap}>{currentUser?.initials || 'Me'}</button>}
      </div>

      <div className="scroll-body">
        <div className="sec-label">{t('activeTasks', lang)}</div>

        {openTasks.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 20px', color: 'var(--hint)', fontSize: 13 }}>
            {t('noActiveTasks', lang)}
          </div>
        )}

        {openTasks.map(task => {
          const jt = getJobType(task)
          const colors = JOB_COLORS[jt.id] || JOB_COLORS.aerial
          const isFlagged = flaggedTaskIds.has(task.id)
          return (
            <div key={task.id} className="card card-tap" onClick={() => onSelect(task)}
                 style={isFlagged ? { borderColor: 'var(--red)' } : undefined}>
              <div className="icon-pill" style={{
                width: 40, height: 40, borderRadius: 'var(--r-sm)',
                background: colors.bg, fontSize: 20
              }}>
                {jt.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Title is the title — no creator chip splitting it. Creator lives
                    in the metadata row below alongside the job-type pill. */}
                <div style={{ fontWeight: 700 }}>{task.name}</div>
                {task.notes && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{task.notes}</div>}
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span className="pill" style={{ background: colors.bg, color: colors.text }}>
                    {jt.label}
                  </span>
                  {task.creator && (
                    <span className="creator-chip" title={task.creator.name} style={{ marginLeft: 0 }}>
                      <span className="creator-initials">{task.creator.initials}</span>
                      <span className="creator-name">{task.creator.name}</span>
                    </span>
                  )}
                  {/* Open tasks stay in Active even after a passdown is
                      submitted/approved — a small pill tells the crew the
                      state of their last passdown. Flagged wins over the
                      others. Plain open needs no pill. */}
                  {isFlagged ? (
                    <span className="pill pill-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="alert" size={12} /> {lang === 'es' ? 'Marcado' : 'Flagged'}
                    </span>
                  ) : task.status === 'pending' ? (
                    <span className="pill" style={{ background: 'var(--amber-lt)', color: 'var(--amber)' }}>
                      {lang === 'es' ? 'Enviada' : 'Submitted'}
                    </span>
                  ) : task.status === 'approved' ? (
                    <span className="pill pill-success" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="check" size={12} /> {lang === 'es' ? 'Aprobada' : 'Approved'}
                    </span>
                  ) : null}
                </div>
              </div>
              <Icon name="chevron-right" size={20} color="var(--border2)" />
            </div>
          )
        })}

        {/* Closed tasks — collapsed by default, last 30 days only */}
        {approvedTasks.length > 0 && (
          <>
            <button
              onClick={() => setShowPast(prev => !prev)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', marginTop: 12,
                background: 'transparent', border: 'none',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--hint)' }}>
                {lang === 'es' ? 'Completadas' : 'Completed'}
                <span style={{ marginLeft: 6, color: 'var(--muted)' }}>· {approvedTasks.length}</span>
              </span>
              <span style={{ color: 'var(--hint)', display: 'inline-flex', transform: showPast ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}><Icon name="chevron-right" size={15} /></span>
            </button>

            {showPast && approvedTasks.map((task, i) => {
              const jt = getJobType(task)
              // closed_at = the moment the manager closed the task. Close
              // enough to "date completed" for the crew's mental model; an
              // exact submission timestamp lives on the submissions row,
              // fetched by TaskSummaryView when they tap in.
              const when = (task.closed_at || task.updated_at)
                ? new Date(task.closed_at || task.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : null
              // Tappable so the crew can open TaskSummaryView and inspect
              // what was submitted/approved. The parent's onSelect handler
              // routes closed tasks to the read-only summary view.
              return (
                <div key={task.id} onClick={() => onSelect(task)} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 14px',
                  background: 'transparent',
                  borderTop: i === 0 ? '1px solid var(--border)' : 'none',
                  borderBottom: '1px solid var(--border)',
                  opacity: 0.55,
                  cursor: 'pointer',
                }}>
                  <span style={{ fontSize: 14, flexShrink: 0 }}>{jt.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {task.name}
                    </div>
                    {when && (
                      <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 1 }}>
                        {when}
                      </div>
                    )}
                  </div>
                  <span className="pill pill-success pill-sm" style={{ flexShrink: 0, display: 'inline-flex' }}><Icon name="check" size={11} /></span>
                  <Icon name="chevron-right" size={15} color="var(--hint)" />
                </div>
              )
            })}
          </>
        )}

        {/* Add task button */}
        <button
          onClick={() => setShowNewTask(true)}
          className="add-dashed add-accent"
          style={{ marginTop: 8 }}
        >
          <span style={{ fontSize: 20 }}>＋</span>
          {t('addTask', lang)}
        </button>
      </div>

      {showNewTask && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowNewTask(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>{t('addTaskTitle', lang)}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>{t('addTaskSub', lang)}</div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>{t('jobType', lang)}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {JOB_TYPES.map(jt => (
                  <button key={jt.id} className={`job-chip${jobType === jt.id ? ' selected' : ''}`} onClick={() => setJobType(jt.id)}>
                    {jt.icon} {jt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>{t('locationName', lang)}</label>
              <input type="text" placeholder={t('locationPlaceholder', lang)} value={taskName} onChange={e => setTaskName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>{t('notesOptional', lang)}</label>
              <textarea placeholder={t('notesPlaceholder', lang)} value={taskNotes} onChange={e => setTaskNotes(e.target.value)} style={{ minHeight: 60 }} />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowNewTask(false)}>{t('cancel', lang)}</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleCreateTask} disabled={saving || !taskName.trim()}>
                {saving ? t('saving', lang) : t('startTask', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
