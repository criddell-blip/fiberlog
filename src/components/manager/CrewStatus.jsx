import { useState, useEffect } from 'react'
import { getTodaySessions, db, nextChannelSuffix } from '../../lib/supabase'
import { useApp } from '../../AppContext'

const CREW_TYPE_ICON = {
  aerial: '🏗️', underground: '⛏️', splice: '🔌',
  drop: '🏠', locator: '📡', contractor: '🔧',
  // Infrastructure crew (towers, business installs, MDU equipment closets).
  // Install techs render with the house emoji distinct from drop crews.
  infrastructure: '🛠️', install: '🏘️',
}

const STATUS_CONFIG = {
  'in-progress': { color: 'var(--teal)', bg: 'var(--teal-lt)', label: 'In progress' },
  'started': { color: 'var(--blue)', bg: 'var(--blue-lt)', label: 'Started' },
  'submitted': { color: 'var(--gray)', bg: 'var(--gray-lt)', label: 'Submitted' },
  'none': { color: 'var(--hint)', bg: 'var(--bg)', label: 'Not started' },
}

export default function CrewStatus() {
  const { currentUser, users } = useApp()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  // Manager-scope filter: a manager (role='manager') only sees crew
  // members whose users.manager_id points at them. Owners see everyone
  // (the original behavior). Lookup keyed off the AppContext users list
  // — that's a stable copy of public.users with manager_id included.
  // If we don't yet have currentUser (initial paint), don't filter.
  const isManagerScoped = currentUser?.role === 'manager'
  const myReportIds = (() => {
    if (!isManagerScoped) return null  // null = no filter
    return new Set(
      (users || [])
        .filter(u => u.manager_id === currentUser.id)
        .map(u => u.id)
    )
  })()

  useEffect(() => {
    load()

    // Real-time updates. Channel name is dynamic so a remount (e.g. tab
    // switch back to Crew) doesn't collide with the previous channel that's
    // still being torn down — the static 'crew_status_live' name caused
    // "cannot add postgres_changes callbacks after subscribe()" errors.
    const channel = db.channel('crew_status_live_' + nextChannelSuffix())
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'work_sessions' },
        () => load()
      ).subscribe()

    return () => { try { channel.unsubscribe() } catch {} }
  }, [])

  async function load() {
    try {
      // Try the view first
      let data = await getTodaySessions()
      
      // If view returns nothing, fall back to users list
      if (!data || data.length === 0) {
        const { data: users, error } = await db
          .from('users')
          .select('id, name, initials, crew_type, is_contractor')
          .eq('role', 'crew')
          .eq('is_active', true)
          .order('name')
        if (!error) {
          data = (users || []).map(u => ({
            user_id: u.id,
            name: u.name,
            initials: u.initials,
            crew_type: u.crew_type,
            is_contractor: u.is_contractor,
            session_status: null,
            entry_count: 0,
            footage_total: 0,
            current_task: null,
            current_project: null,
          }))
        }
      }
      
      setSessions(data)
      setLastUpdated(new Date())
    } catch (e) {
      console.error('Crew status load failed:', e)
    } finally {
      setLoading(false)
    }
  }

  // Apply the manager-scope filter once, then derive everything else from
  // the scoped list. Counts at the top of the page reflect what's visible
  // — a manager seeing 4 reports sees the totals for those 4, not all 21.
  const scopedSessions = myReportIds
    ? sessions.filter(s => myReportIds.has(s.user_id))
    : sessions

  const active = scopedSessions.filter(s => s.session_status && s.session_status !== 'none')
  const inactive = scopedSessions.filter(s => !s.session_status || s.session_status === 'none')

  const totalFootage = scopedSessions.reduce((a, s) => a + (s.footage_total || 0), 0)
  const totalEntries = scopedSessions.reduce((a, s) => a + (s.entry_count || 0), 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header stats */}
      <div style={{ padding: '16px 20px', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Crew Today</div>
          <div style={{ fontSize: 11, color: 'var(--hint)' }}>
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
          </div>
        </div>

        {/* Auto-fit so stats drop to 2-col (or 1-col) on really narrow phones.
            minmax(120px, 1fr) means each card needs ≥120px or it wraps. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          {[
            { label: 'Active', value: active.length, color: 'var(--teal)' },
            { label: 'Footage', value: `${totalFootage.toLocaleString()} ft`, color: 'var(--blue)' },
            { label: 'Log entries', value: totalEntries, color: 'var(--purple)' },
          ].map(s => (
            <div key={s.label} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', padding: '12px', textAlign: 'center'
            }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Crew list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {/* Scope hint for managers — clarifies why they're seeing a
            subset, and points them at Admin if they're seeing no one. */}
        {isManagerScoped && !loading && (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 12,
            fontSize: 12, color: 'var(--muted)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <span>
              👀 Showing your <strong>{scopedSessions.length}</strong> direct report{scopedSessions.length === 1 ? '' : 's'}.
              {scopedSessions.length === 0 && (
                <> No one's reporting to you yet — assign reports via <strong>Admin → Users → Reports to</strong>.</>
              )}
            </span>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>
        )}

        {active.length > 0 && (
          <>
            <div className="sec-label">Active now — {active.length}</div>
            {active.map(s => {
              const cfg = STATUS_CONFIG[s.session_status] || STATUS_CONFIG.none
              return (
                <div key={s.user_id} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8,
                  borderLeft: `4px solid ${cfg.color}`
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 36, height: 36, borderRadius: '50%',
                      background: cfg.bg, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontWeight: 700, fontSize: 12,
                      color: cfg.color, flexShrink: 0
                    }}>
                      {s.initials || '?'}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {CREW_TYPE_ICON[s.crew_type]} {s.current_task || 'No task selected'}
                      </div>
                      {s.current_project && (
                        <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                          📍 {s.current_project}
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color }}>{cfg.label}</div>
                      {s.entry_count > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.entry_count} entries</div>
                      )}
                      {s.footage_total > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.footage_total.toLocaleString()} ft</div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </>
        )}

        {inactive.length > 0 && (
          <>
            <div className="sec-label" style={{ marginTop: 16 }}>Not started — {inactive.length}</div>
            {inactive.map(s => (
              <div key={s.user_id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 14px', background: 'var(--surface)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                marginBottom: 6, opacity: 0.6
              }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%',
                  background: 'var(--gray-lt)', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontWeight: 700, fontSize: 11,
                  color: 'var(--gray)', flexShrink: 0
                }}>
                  {s.initials || '?'}
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--hint)' }}>
                    {CREW_TYPE_ICON[s.crew_type]} {s.crew_type}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
