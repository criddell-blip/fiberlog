import { useEffect, useState, useCallback } from 'react'
import {
  CREW_TYPES,
  getCrewTypePartRestrictions,
  addCrewTypePartRestriction,
  removeCrewTypePartRestriction,
  getActivePartDepartments,
} from '../../lib/admin'
import Icon from '../shared/Icon'

// Crew-type × department whitelist editor. Each cell represents whether
// a given crew_type can move parts from a given department.
//
// Rules (mirror the SQL in record_crew_movement):
//   - Empty row (no checked cells for a crew_type) = NO restriction;
//     that crew_type can move ANY part.
//   - One or more checked cells = whitelist; ONLY those departments
//     are allowed for that crew_type.
//   - Parts with no department (NULL) always pass, regardless.
//
// Saves are live per-toggle. Optimistic UI: the cell flips immediately,
// the RPC fires async, and on failure we revert + show an error.

const CREW_TYPE_LABELS = {
  fiber_construction: { icon: '🏗️', label: 'Fiber construction' },
  field_service:  { icon: '🛠️', label: 'Field service' },
  install:        { icon: '🏠', label: 'Install' },
  infrastructure: { icon: '📡', label: 'Infrastructure' },
  contractor:     { icon: '🧰', label: 'Contractor' },
}

// "crew_type|department" key for membership lookups.
function k(crewType, department) {
  return `${crewType}|${department}`
}

export default function CrewTypePermissionsView({ onBack }) {
  const [departments, setDepartments] = useState([])
  const [allowed, setAllowed] = useState(() => new Set())
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const [depts, rows] = await Promise.all([
        getActivePartDepartments(),
        getCrewTypePartRestrictions(),
      ])
      setDepartments(depts)
      setAllowed(new Set(rows.map(r => k(r.crew_type, r.department))))
    } catch (e) {
      console.error('Load failed:', e)
      setErr(e.message || 'Could not load whitelist')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function toggle(crewType, department) {
    const key = k(crewType, department)
    const currentlyAllowed = allowed.has(key)
    // Optimistic flip
    setAllowed(prev => {
      const next = new Set(prev)
      if (currentlyAllowed) next.delete(key)
      else next.add(key)
      return next
    })
    setSavingKey(key); setErr('')
    try {
      if (currentlyAllowed) {
        await removeCrewTypePartRestriction(crewType, department)
      } else {
        await addCrewTypePartRestriction(crewType, department)
      }
    } catch (e) {
      // Revert on failure
      setAllowed(prev => {
        const next = new Set(prev)
        if (currentlyAllowed) next.add(key)
        else next.delete(key)
        return next
      })
      setErr(e.message || 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  function crewTypeRowState(crewType) {
    // How many cells this row has checked. 0 = unrestricted; >0 = whitelist mode.
    let count = 0
    for (const d of departments) {
      if (allowed.has(k(crewType, d.department))) count++
    }
    return { count, unrestricted: count === 0 }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', flexShrink: 0,
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onBack}
            style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >←</button>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Crew × Department permissions</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Restrict which part departments each crew type can move
            </div>
          </div>
        </div>
      </div>

      {/* Explainer */}
      <div style={{
        padding: '10px 20px',
        background: 'var(--surface2)',
        borderBottom: '1px solid var(--border)',
        fontSize: 12, color: 'var(--muted)', lineHeight: 1.5,
        flexShrink: 0,
      }}>
        <strong style={{ color: 'var(--text)' }}>Rules:</strong> if you leave a row empty,
        that crew type can move <em>any</em> part. If you check one or more, that crew type
        can <em>only</em> move parts from those departments. Parts with no department set
        are always allowed.
      </div>

      {err && (
        <div style={{
          margin: '10px 20px', padding: '8px 12px',
          background: 'var(--red-lt)', color: 'var(--red)',
          borderRadius: 'var(--r-sm)', fontSize: 13,
        }}>
          {err}
        </div>
      )}

      {/* Matrix */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading…</div>
        )}

        {!loading && departments.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            No part departments in the catalog yet.
          </div>
        )}

        {!loading && departments.length > 0 && (
          <div style={{
            display: 'inline-block',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            overflow: 'hidden',
            minWidth: '100%',
          }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
              <thead>
                <tr style={{ background: 'var(--surface2)' }}>
                  <th style={thStyle({ minWidth: 160, textAlign: 'left' })}>Crew type</th>
                  {departments.map(d => (
                    <th key={d.department} style={thStyle({ minWidth: 120 })} title={d.department}>
                      <div style={{ fontWeight: 700, fontSize: 12 }}>{d.department}</div>
                      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400, marginTop: 2 }}>
                        {d.count} {d.count === 1 ? 'part' : 'parts'}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CREW_TYPES.map(ct => {
                  const meta = CREW_TYPE_LABELS[ct]
                  const { count, unrestricted } = crewTypeRowState(ct)
                  return (
                    <tr key={ct}>
                      <td style={tdStyle({ background: 'var(--surface2)' })}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 16 }}>{meta?.icon || ''}</span>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>{meta?.label || ct}</div>
                            <div style={{ fontSize: 10, color: unrestricted ? 'var(--teal-mid)' : 'var(--orange)' }}>
                              {unrestricted ? 'Unrestricted' : `${count} dept${count === 1 ? '' : 's'} allowed`}
                            </div>
                          </div>
                        </div>
                      </td>
                      {departments.map(d => {
                        const key = k(ct, d.department)
                        const checked = allowed.has(key)
                        const busy = savingKey === key
                        return (
                          <td key={d.department} style={tdStyle({ textAlign: 'center', cursor: 'pointer' })}>
                            <button
                              onClick={() => toggle(ct, d.department)}
                              disabled={busy}
                              title={checked ? 'Click to remove' : 'Click to allow'}
                              style={{
                                width: 32, height: 32, borderRadius: 6,
                                border: `1.5px solid ${checked ? 'var(--teal)' : 'var(--border2)'}`,
                                background: checked ? 'var(--teal)' : 'transparent',
                                color: checked ? 'white' : 'transparent',
                                fontSize: 16, fontWeight: 800,
                                cursor: busy ? 'wait' : 'pointer',
                                opacity: busy ? 0.5 : 1,
                                transition: 'all .12s',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              }}
                            >
                              {checked ? <Icon name="check" size={16} /> : ''}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && departments.length > 0 && (
          <div style={{
            marginTop: 16, padding: '10px 14px',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)',
            fontSize: 12, color: 'var(--muted)', lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>How this affects movements</div>
            The RPC <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>record_crew_movement</code> checks
            this matrix on every Load / Return / Issue / Scrap / Transfer.
            If a crew member tries to move a part whose department isn't in their whitelist,
            the operation is rejected at the server.
            Parts created via BoxHero imports (or any part with no department set) bypass this rule.
          </div>
        )}
      </div>
    </div>
  )
}

const thStyle = (extra = {}) => ({
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  borderRight: '1px solid var(--border)',
  fontSize: 12, fontWeight: 700, color: 'var(--muted)',
  textAlign: 'center',
  whiteSpace: 'nowrap',
  ...extra,
})

const tdStyle = (extra = {}) => ({
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  borderRight: '1px solid var(--border)',
  ...extra,
})
