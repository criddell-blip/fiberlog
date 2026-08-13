// Read-only list of a task's submitted passdowns — one card per submission,
// newest first: status banner, when/by whom, hours + non-zero footage stats,
// parts, crew notes, manager flag reason / notes. Shared by TaskSummaryView
// (closed tasks) and TaskWorkspace's history overlay (open tasks, backlog
// #34) so the two renderings can't drift. Data shape = getTaskSummary()'s
// submissions array.

import { useApp } from '../../AppContext'
import { t } from '../../lib/i18n'
import Icon from '../shared/Icon'

// labelKey → i18n; render via t(cfg.labelKey, lang).
export const STATUS_CONFIG = {
  pending:  { bg: 'var(--amber-lt)', text: 'var(--amber)',    labelKey: 'statusPendingReview', icon: '⏳' },
  approved: { bg: 'var(--teal-lt)',  text: 'var(--teal-mid)', labelKey: 'statusApproved',      icon: '✅' },
  flagged:  { bg: 'var(--red-lt)',   text: 'var(--red)',      labelKey: 'statusFlagged',       icon: '🚩' },
  done:     { bg: 'var(--gray-lt)',  text: 'var(--muted)',    labelKey: 'statusDone',          icon: '✓'  },
  open:     { bg: 'var(--orange-lt)', text: 'var(--orange)',  labelKey: 'statusOpen',          icon: '○'  },
}

const FOOTAGE_FIELDS = [
  { key: 'total_strand_ft',    labelKey: 'strandLabel',      unitKey: 'unitFt' },
  { key: 'total_fiber_ft',     labelKey: 'fiberLabel',       unitKey: 'unitFt' },
  { key: 'total_conduit_ft',   labelKey: 'conduitLabel',     unitKey: 'unitFt' },
  { key: 'total_mst_hst',      labelKey: 'mstLabel',         unitKey: 'unitUnits' },
  { key: 'total_splice_cases', labelKey: 'spliceCasesLabel', unitKey: 'unitCases' },
  { key: 'total_handholes',    labelKey: 'handholesLabel',   unitKey: 'unitEa' },
  { key: 'total_vaults',       labelKey: 'vaultsLabel',      unitKey: 'unitEa' },
  { key: 'total_poles',        labelKey: 'polesCap',         unitKey: 'unitEa' },
]

export default function PassdownList({ submissions }) {
  // Lang comes from context (not a prop) — TaskSummaryView and
  // TaskWorkspace both render inside the provider, so this keeps the two
  // call sites identical and drift-free.
  const { lang } = useApp()
  if (!submissions || submissions.length === 0) return null
  return submissions.map((sub, i) => {
    const cfg = STATUS_CONFIG[sub.status] || STATUS_CONFIG.open
    return (
      <div key={sub.id} style={{ marginBottom: i < submissions.length - 1 ? 18 : 0 }}>
        {/* Status banner — the verdict first; for flagged passdowns the
            manager's reason is the most important thing on screen. */}
        <div style={{
          background: cfg.bg, color: cfg.text,
          borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 14 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />
            <span>{t(cfg.labelKey, lang)}</span>
            <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700 }}>
              {(Number(sub.hours_worked) || 0).toLocaleString()} hrs
            </span>
          </div>
          <div style={{ fontSize: 11, marginTop: 4, opacity: 0.85 }}>
            {t('submittedWord', lang)} {fmtWhen(sub.created_at, lang)} {t('byWord', lang)} {sub.users?.name || t('youWord', lang)}
            {sub.reviewed_at && sub.reviewer?.name && (
              <> · {t('reviewedWord', lang)} {fmtWhen(sub.reviewed_at, lang)} {t('byWord', lang)} {sub.reviewer.name}</>
            )}
          </div>
          {sub.status === 'flagged' && sub.flag_reason && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 600 }}>
              {t('managerNote', lang)} {sub.flag_reason}
            </div>
          )}
          {sub.status !== 'flagged' && sub.manager_notes && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(0,0,0,0.06)', borderRadius: 'var(--r-xs)', fontSize: 12, fontStyle: 'italic' }}>
              {t('managerNote', lang)} {sub.manager_notes}
            </div>
          )}
        </div>

        {/* Footage stats — only non-zero fields so hours-only passdowns
            don't fill the card with empty fiber metrics. */}
        {FOOTAGE_FIELDS.some(f => (sub[f.key] || 0) > 0) && (
          <div className="metric-row" style={{ marginBottom: 10, alignItems: 'center' }}>
            {FOOTAGE_FIELDS.filter(f => (sub[f.key] || 0) > 0).map(f => (
              <div key={f.key} style={{ fontSize: 12, lineHeight: 1.2 }}>
                <div style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}>{t(f.labelKey, lang)}</div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  {(sub[f.key] || 0).toLocaleString()} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>{t(f.unitKey, lang)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Parts — empty state matters: hours-only passdowns are legitimate. */}
        {(sub.parts || []).length === 0 ? (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: 12, textAlign: 'center',
            color: 'var(--hint)', fontSize: 12,
          }}>
            {t('noPartsOnPassdown', lang)}
          </div>
        ) : (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', overflow: 'hidden', padding: '0 14px',
          }}>
            {/* (part, source truck) is the line identity — the same SKU from
                two trucks renders as two lines, matching how it deducts. */}
            {sub.parts.map(p => (
              <div key={p.partId + '|' + (p.sourceLocationId || '')} className="parts-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {p.name}
                  </div>
                  <div className="part-id">{p.partId}</div>
                  {p.sourceName && (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2,
                      fontSize: 10, fontWeight: 700, borderRadius: 20, padding: '1px 7px',
                      background: 'var(--teal-lt)', border: '1px solid var(--teal)',
                      color: 'var(--teal-dk)',
                    }}>
                      <Icon name="truck" size={10} /> {p.sourceName}
                    </span>
                  )}
                </div>
                <div className="part-qty" style={{ flexShrink: 0, marginLeft: 10 }}>
                  {p.qty.toLocaleString()} <span className="part-unit" style={{ fontWeight: 400 }}>{p.unit}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {(sub.notes || []).length > 0 && (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', padding: '8px 12px', marginTop: 8,
            fontSize: 12, color: 'var(--text)', whiteSpace: 'pre-wrap',
          }}>
            {sub.notes.join('\n\n')}
          </div>
        )}
      </div>
    )
  })
}

// Locale-aware "Jul 5, 2:30 PM" / "5 jul, 14:30". Default 'en' keeps
// legacy no-lang call sites working.
export function fmtWhen(iso, lang = 'en') {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(lang === 'es' ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
