import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'
import { visibleProjectsForCrew } from '../../lib/crewTypes'
import Icon from '../shared/Icon'

const isCompletedTask = t => t.status === 'done' || t.status === 'approved'

export default function ProjectList({ onSelect, onOpenMyStock, onUserTap }) {
  const { projects: allProjects, currentUser, lang } = useApp()
  // Hide Gigwave / Fixed Wireless from crews that aren't infra/field-tech.
  const projects = visibleProjectsForCrew(allProjects, currentUser?.crew_type)

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
        {/* My Stock entry point — sits above the project list per design. */}
        {onOpenMyStock && (
          <div
            className="card card-tap"
            onClick={onOpenMyStock}
            style={{ borderLeft: '3px solid var(--orange)' }}
          >
            <div className="icon-pill ip-orange" style={{
              border: '1.5px solid var(--orange-dk)',
            }}>
              <Icon name="box" size={22} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>My Stock</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                What's on your truck — load and return
              </div>
            </div>
            <Icon name="chevron-right" size={20} color="var(--border2)" />
          </div>
        )}

        <div className="sec-label">{t('yourProjects', lang)}</div>

        {projects.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--gray-mid)' }}><Icon name="folder" size={32} /></div>
            <div>{t('noProjects', lang)}</div>
          </div>
        )}

        {projects.map(p => {
          const totalTasks = p.phases.reduce((a, ph) => a + ph.tasks.length, 0)
          const doneTasks = p.phases.reduce((a, ph) => a + ph.tasks.filter(isCompletedTask).length, 0)
          const fiberK = ((p.fiber || 0) / 1000).toFixed(0)
          const conduitK = ((p.conduit || 0) / 1000).toFixed(1)
          const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0

          return (
            <div key={p.id} className="card card-tap" onClick={() => onSelect(p)}>
              <div className="icon-pill ip-orange" style={{
                border: '1.5px solid var(--orange-dk)',
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
                    <span><span className="mono">{pct}%</span> {t('pctComplete', lang)}</span>
                    <span><span className="mono">{doneTasks}/{totalTasks}</span> {t('tasksDone', lang)}</span>
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
