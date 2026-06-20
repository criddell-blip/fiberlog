// PhaseList.jsx
import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'
import Icon from '../shared/Icon'

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
              <div className="icon-pill ip-orange" style={{
                width: 40, height: 40, borderRadius: 'var(--r-md)',
                fontWeight: 800, fontSize: 16, color: 'var(--orange)'
              }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{ph.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {done}/{total} {t('tasks', lang)} · {((ph.fiber_ft || 0) / 1000).toFixed(0)}k {t('fiberFt', lang)}
                </div>
                {/* Progress block matches ProjectList: %-complete + count above the bar,
                    so the two screens read the same when stacked back to back. */}
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    <span><span className="mono">{pct}%</span> {t('pctComplete', lang)}</span>
                    <span><span className="mono">{done}/{total}</span> {t('tasksDone', lang)}</span>
                  </div>
                  <div className="prog-bar">
                    <div className="prog-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
              <Icon name="chevron-right" size={20} color="var(--border2)" />
            </div>
          )
        })}
      </div>
    </div>
  )
}
