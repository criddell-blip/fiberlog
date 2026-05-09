// PhaseList.jsx
import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'

const isCompletedTask = t => t.status === 'done' || t.status === 'approved'

export default function PhaseList({ project, onSelect, onBack, onUserTap }) {
  const { currentUser, lang } = useApp()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
          </div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project.name}
          </div>
        </div>
      </div>
      <div className="scroll-body">
        <div className="sec-label">{t('phasesLabel', lang)}</div>
        {project.phases.map((ph, i) => {
          const done = ph.tasks.filter(isCompletedTask).length
          const total = ph.tasks.length
          const pct = total > 0 ? Math.round(done / total * 100) : 0
          return (
            <div key={ph.id} className="card card-tap" onClick={() => onSelect(ph)}>
              <div style={{
                width: 40, height: 40, borderRadius: 10, background: 'var(--orange-lt)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 16, color: 'var(--orange)', flexShrink: 0
              }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{ph.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {done}/{total} {t('tasks', lang)} · {((ph.fiber_ft || 0) / 1000).toFixed(0)}k {t('fiberFt', lang)}
                </div>
                <div className="prog-bar" style={{ marginTop: 6 }}>
                  <div className="prog-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--orange)', flexShrink: 0 }}>{pct}%</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
