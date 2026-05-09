import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'

const PROJECT_ICONS = ['🏔️', '🌄', '🏕️', '📡', '🌲']
const PROJECT_COLORS = ['ip-teal', 'ip-blue', 'ip-amber', 'ip-purple', 'ip-orange']

const isCompletedTask = t => t.status === 'done' || t.status === 'approved'

function getProjectStyle(name, index) {
  const i = index % PROJECT_ICONS.length
  return { icon: PROJECT_ICONS[i], cls: PROJECT_COLORS[i] }
}

export default function ProjectList({ onSelect, onUserTap }) {
  const { projects, currentUser, lang } = useApp()

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Topbar */}
      <div className="topbar">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
          </div>
          <div className="topbar-sub">{today}</div>
        </div>
        <button className="user-btn" onClick={onUserTap}>
          {currentUser?.initials || 'Me'}
        </button>
      </div>

      {/* Scroll body */}
      <div className="scroll-body">
        <div className="sec-label">{t('yourProjects', lang)}</div>

        {projects.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--hint)' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            <div>{t('noProjects', lang)}</div>
          </div>
        )}

        {projects.map((p, i) => {
          const { icon, cls } = getProjectStyle(p.name, i)
          const totalTasks = p.phases.reduce((a, ph) => a + ph.tasks.length, 0)
          const doneTasks = p.phases.reduce((a, ph) => a + ph.tasks.filter(isCompletedTask).length, 0)
          const fiberK = ((p.fiber || 0) / 1000).toFixed(0)
          const conduitK = ((p.conduit || 0) / 1000).toFixed(1)
          const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0

          return (
            <div key={p.id} className="card card-tap" onClick={() => onSelect(p)}>
              <div style={{
                width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                background: 'var(--orange-lt)', border: '1.5px solid var(--orange-dk)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 13, color: 'var(--orange)', letterSpacing: '-0.5px'
              }}>
                {p.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  {p.phases.length} {t('phases', lang)} · {fiberK}k {t('fiberFt', lang)} · {conduitK}k {t('conduitFt', lang)}
                </div>
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    <span>{pct}% {t('pctComplete', lang)}</span>
                    <span>{doneTasks}/{totalTasks} {t('tasksDone', lang)}</span>
                  </div>
                  <div className="prog-bar">
                    <div className="prog-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 20, color: 'var(--border2)', flexShrink: 0 }}>›</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
