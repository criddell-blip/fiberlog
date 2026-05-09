export default function PartsTally({ parts, onUpdate, onRemove }) {
  if (!parts || parts.length === 0) return null

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-sm)',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        fontSize: 12, fontWeight: 700,
        color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.04em',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <span>{parts.length} part type{parts.length !== 1 ? 's' : ''}</span>
        <span style={{ fontSize: 10, fontWeight: 500, textTransform: 'none', color: 'var(--hint)' }}>
          tap qty to edit
        </span>
      </div>
      {parts.map(p => (
        <div key={p.id} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 14px', borderBottom: '1px solid var(--border)'
        }}>
          <div style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
            <div className="part-name">{p.name}</div>
            <div className="part-id">{p.id}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <input
              type="number"
              value={p.qty}
              min="0"
              onChange={e => {
                const val = parseInt(e.target.value) || 0
                if (val === 0) { onRemove && onRemove(p.id) }
                else { onUpdate && onUpdate(p.id, val) }
              }}
              style={{
                width: 56, padding: '4px 6px', fontSize: 15, fontWeight: 700,
                textAlign: 'center', border: '1.5px solid var(--border2)',
                borderRadius: 6, background: 'var(--bg)', color: 'var(--teal-dk)'
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 16 }}>{p.unit || 'ea'}</span>
            <button
              onClick={() => onRemove && onRemove(p.id)}
              style={{
                width: 26, height: 26, borderRadius: '50%',
                background: 'var(--red-lt)', color: 'var(--red)',
                fontSize: 14, display: 'flex', alignItems: 'center',
                justifyContent: 'center', flexShrink: 0
              }}
            >×</button>
          </div>
        </div>
      ))}
    </div>
  )
}
