import Icon from '../shared/Icon'

// Shared presentational layer for the CSV importer sheets (Sonar asset
// consumption, fiber jobs, BoxHero seed, bulk Sonar projects). Extracted
// July 2026 from verbatim/near-verbatim copies that had started to drift.
//
// Deliberately presentational-only: the per-sheet resolvers and apply
// loops write append-only inventory_movements with three different
// failure contracts, so they stay in their sheets. Anything added here
// must render correctly for EVERY importer — sheet-specific vocabulary
// (status maps, placeholder text, audit labels) comes in as config.

// ─── Section + mapping row (the accent-bordered mapping blocks) ─────────

export function Section({ title, subtitle, accent, children }) {
  return (
    <div style={{
      marginBottom: 12, padding: 10,
      border: `1px solid ${accent}`, borderRadius: 'var(--r-sm)',
      background: 'var(--surface)',
    }}>
      <div style={{
        fontSize: 12, fontWeight: 800, color: accent,
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 2,
      }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>{subtitle}</div>
      {children}
    </div>
  )
}

export function MappingRow({ primary, secondary, status, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
      padding: '4px 6px', background: 'var(--surface2)', borderRadius: 6,
    }}>
      <div style={{ flex: 2, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{primary}</div>
        {secondary && <div style={{ fontSize: 10, color: 'var(--hint)' }}>{secondary}</div>}
      </div>
      <div style={{ flex: 3, minWidth: 0 }}>{children}</div>
      {status && <StatusTag tag={status.tag} color={status.color} />}
    </div>
  )
}

// ─── Status chips ───────────────────────────────────────────────────────

// Outlined chip used on mapping rows ({tag, color} pairs computed by the
// sheet). The two originals had drifted (Sonar: radius 10 + bg fill;
// fiber-jobs: radius 999 + uppercase); reconciled to the fiber-jobs look —
// the newer sheet, and it matches the app's pill classes.
export function StatusTag({ tag, color }) {
  return (
    <div style={{
      padding: '2px 8px', borderRadius: 999,
      border: `1px solid ${color}`,
      color, fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
      flexShrink: 0,
    }}>{tag}</div>
  )
}

// Filled pill for transaction/job preview rows. The status VOCABULARY is
// per-sheet (each resolver has its own failure modes), so the map is
// config: { [status]: { label, color, bg } }. Unknown statuses fall back
// to the map's `ready` entry (same forgiving behavior as the originals).
export function StatusBadge({ status, map }) {
  const m = map[status] || map.ready
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999,
      background: m.bg, color: m.color,
      fontSize: 10, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '.04em',
      flexShrink: 0,
    }}>{m.label}</span>
  )
}

// ─── Shared control style ───────────────────────────────────────────────

// The compact select/input style every importer uses. Reconciled from two
// drifted copies (Sonar: 11px / radius 4 / var(--bg); fiber-jobs: 12px /
// var(--r-xs) / var(--surface2)) to the fiber-jobs token-based variant.
// Call sites that need the smaller size still spread an override.
export const selectStyle = () => ({
  width: '100%',
  padding: '4px 6px',
  fontSize: 12,
  border: '1px solid var(--border2)',
  borderRadius: 'var(--r-xs)',
  background: 'var(--surface2)',
  color: 'var(--text)',
})

// ─── Source-location picker ─────────────────────────────────────────────

// Every location a Sonar-imported movement could plausibly have sourced
// from, grouped for the <select>. job_site buckets + scrap are excluded
// upstream (they're destinations, not sources).
export const SOURCE_LOCATION_GROUPS = [
  ['warehouse', '🏭 Warehouses'],
  ['group',     '👥 Shared trailers'],
  ['truck',     '🚚 Crew trucks'],
  ['bin',       '🗄️ Bins'],
]

// The warehouse/group/truck/bin optgroup picker that appeared 4× across
// the Sonar sheets. `onChange` receives the raw option value ('' for the
// placeholder) — callers keep their own null/persist handling.
export function SourceLocationSelect({ locations, value, onChange, placeholder, style, disabled }) {
  return (
    <select
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      style={style || selectStyle()}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {SOURCE_LOCATION_GROUPS.map(([type, label]) => {
        const locs = locations.filter(l => l.type === type)
        if (locs.length === 0) return null
        return (
          <optgroup key={type} label={label}>
            {locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </optgroup>
        )
      })}
    </select>
  )
}

// ─── Webhook delivery panels (pending queue + processed audit) ──────────
//
// Both take the object returned by useSonarPendingQueue (lib/useCsvImport.js).
// Rendering follows the SonarImportSheet originals — the superset: the
// fiber-jobs copy had drifted behind (no loading row, no auto-discard
// styling, no applied_at timestamp) and picks those up by adopting this.

export function PendingImportsPanel({ queue, disabled }) {
  const { pendingImports, pendingLoading, activePendingId, loadPending, discardPending } = queue
  if (pendingLoading || pendingImports.length === 0) return null
  return (
    <div style={{
      marginBottom: 12, padding: 10,
      border: '1px solid var(--accent-border)',
      background: 'var(--accent-bg)',
      borderRadius: 'var(--r-sm)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 12, fontWeight: 800, color: 'var(--accent-fg)',
        textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6,
      }}>
        <Icon name="download" size={14} /> Auto-delivered from Sonar ({pendingImports.length})
      </div>
      {/* Scroll the list itself, not the whole sheet — a long backlog
          otherwise buries the mapping sections below the fold. */}
      <div style={{ maxHeight: 240, overflowY: 'auto', paddingRight: 2 }}>
      {pendingImports.map(p => {
        const isActive = activePendingId === p.id
        return (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 8px', marginBottom: 4,
            background: isActive ? 'var(--orange)' : 'var(--surface)',
            color: isActive ? '#fff' : 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 13 }}>
                {new Date(p.received_at).toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: isActive ? 'rgba(255,255,255,0.85)' : 'var(--hint)' }}>
                {p.parsed_row_count} row{p.parsed_row_count === 1 ? '' : 's'}
                {p.filename ? ` · ${p.filename}` : ''}
              </div>
            </div>
            <button
              onClick={() => loadPending(p)}
              className="btn"
              style={{
                padding: '5px 10px', fontSize: 12,
                background: isActive ? '#fff' : 'var(--orange)',
                color: isActive ? 'var(--orange)' : '#fff',
                border: 'none', borderRadius: 'var(--r-xs)',
                fontWeight: 'var(--fw-semibold)', cursor: 'pointer',
              }}
              disabled={disabled}
            >
              {isActive ? 'Loaded' : 'Review'}
            </button>
            <button
              onClick={() => discardPending(p)}
              style={{
                display: 'inline-flex', alignItems: 'center',
                padding: '5px 8px', fontSize: 11,
                background: 'transparent',
                color: isActive ? 'rgba(255,255,255,0.8)' : 'var(--muted)',
                border: 'none', cursor: 'pointer',
              }}
              title="Discard this delivery"
              disabled={disabled}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        )
      })}
      </div>
    </div>
  )
}

// Processed (imported + discarded) deliveries — the audit trail. `label`
// customizes the toggle text ("recent webhook deliveries" vs "recent
// fiber-jobs deliveries"). Always available so the manager can audit even
// when nothing's pending.
export function ProcessedImportsPanel({ queue, label = 'webhook' }) {
  const { pendingLoading, showProcessed, toggleProcessed, processedImports, processedLoading } = queue
  if (pendingLoading) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={toggleProcessed}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--muted)', fontSize: 12,
          padding: '4px 0', textDecoration: 'underline',
        }}
      >
        <Icon name={showProcessed ? 'chevron-down' : 'chevron-right'} size={13} />
        {showProcessed ? 'Hide' : 'Show'} recent {label} deliveries (audit)
      </button>
      {showProcessed && (
        <div style={{
          marginTop: 6, padding: 8,
          background: 'var(--surface2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
        }}>
          {processedLoading && (
            <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              Loading…
            </div>
          )}
          {!processedLoading && processedImports && processedImports.length === 0 && (
            <div style={{ padding: 12, textAlign: 'center', color: 'var(--hint)', fontSize: 12 }}>
              No processed deliveries yet. Once you import or discard a Sonar webhook delivery, it'll show up here.
            </div>
          )}
          {!processedLoading && processedImports && processedImports.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {processedImports.map(p => {
                const isImported = p.status === 'imported'
                const isAutoDiscard = p.discard_reason?.startsWith('Auto-discarded')
                return (
                  <div key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 6px', marginBottom: 2,
                    fontSize: 11,
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span
                      className={isImported ? 'pill pill-success pill-sm' : isAutoDiscard ? 'pill pill-danger pill-sm' : 'pill pill-muted pill-sm'}
                      style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      {isImported
                        ? <><Icon name="check" size={12} /> imported</>
                        : isAutoDiscard
                          ? <><Icon name="alert" size={12} /> auto-discarded</>
                          : 'discarded'}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 'var(--fw-semibold)' }}>
                        {new Date(p.received_at).toLocaleString()}
                        <span style={{ color: 'var(--hint)', fontWeight: 'normal', marginLeft: 6 }}>
                          · {p.parsed_row_count} row{p.parsed_row_count === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div style={{ color: 'var(--hint)', fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {isImported
                          ? `applied ${p.applied_movement_count || 0} movement${p.applied_movement_count === 1 ? '' : 's'}${p.applied_at ? ` at ${new Date(p.applied_at).toLocaleString()}` : ''}`
                          : (p.error_message || p.discard_reason || 'no reason given')}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
