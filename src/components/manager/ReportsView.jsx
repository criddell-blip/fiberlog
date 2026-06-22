import { useState, useEffect, useMemo } from 'react'
import { useApp } from '../../AppContext'
import { db, SUPABASE_URL, SUPABASE_ANON_KEY } from '../../lib/supabase'
import { useIsWide } from '../../lib/useIsWide'
import Icon from '../shared/Icon'

async function fetchBoxHeroStock() {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/dynamic-worker`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      }
    })
    if (!res.ok) {
      const txt = await res.text()
      console.warn('BoxHero response:', res.status, txt)
      throw new Error('BoxHero fetch failed: ' + res.status)
    }
    const json = await res.json()
    console.log('BoxHero stock response:', JSON.stringify(json).slice(0, 300))
    return json
  } catch(e) {
    console.warn('BoxHero stock fetch failed:', e)
    return {}
  }
}

function getDateRange(preset) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  
  switch(preset) {
    case 'this_week': {
      const day = today.getDay()
      const start = new Date(today); start.setDate(today.getDate() - day)
      return { from: start, to: now }
    }
    case 'last_week': {
      const day = today.getDay()
      const start = new Date(today); start.setDate(today.getDate() - day - 7)
      const end = new Date(today); end.setDate(today.getDate() - day - 1)
      return { from: start, to: end }
    }
    case 'this_month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from: start, to: now }
    }
    case 'last_month': {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const end = new Date(today.getFullYear(), today.getMonth(), 0)
      return { from: start, to: end }
    }
    case 'all_time': {
      return { from: new Date('2000-01-01'), to: now }
    }
    default: return null
  }
}

const PRESETS = [
  { id: 'this_week', label: 'This week' },
  { id: 'last_week', label: 'Last week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'all_time', label: 'All-time' },
]

export default function ReportsView() {
  const { projects, showToast } = useApp()
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState([])
  const [preset, setPreset] = useState('this_week')
  const [dateFrom, setDateFrom] = useState(() => {
    const r = getDateRange('this_week')
    return r.from.toISOString().split('T')[0]
  })
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().split('T')[0])
  const [selProject, setSelProject] = useState('all')
  const [selUser, setSelUser] = useState('all')
  const [users, setUsers] = useState([])
  const [groupBy, setGroupBy] = useState('part')
  const [stockMap, setStockMap] = useState({})
  const [stockLoading, setStockLoading] = useState(false)
  const [barcodeMap, setBarcodeMap] = useState({}) // 'part' | 'person' | 'project'
  const isWide = useIsWide()
  // Filters chrome was eating ~200px of vertical on phones — six rows of
  // pills/inputs/buttons before the actual data started. Default to
  // collapsed on narrow viewports; desktop keeps the old all-visible layout.
  // After first render, user toggles freely; resize doesn't auto-reset.
  const [showFilters, setShowFilters] = useState(() => isWide)

  useEffect(() => {
    db.from('users').select('id, name, initials, crew_type').eq('is_active', true).order('name')
      .then(({ data }) => setUsers(data || []))
  }, [])

  useEffect(() => { load() }, [dateFrom, dateTo, selProject, selUser])

  async function loadStock() {
    setStockLoading(true)
    const map = await fetchBoxHeroStock()
    // map is now { sku: { quantity, barcode } }
    const qtyMap = {}
    const bcMap = {}
    Object.entries(map).forEach(([sku, val]) => {
      if (typeof val === 'object') {
        qtyMap[sku] = val.quantity ?? 0
        bcMap[sku] = val.barcode || ''
      } else {
        qtyMap[sku] = val
      }
    })
    setStockMap(qtyMap)
    setBarcodeMap(bcMap)
    setStockLoading(false)
  }

  async function load() {
    setLoading(true)
    try {
      // Get approved submissions in date range. tasks.sites is joined alongside
      // tasks.phases so infra submissions (phase_id NULL, site_id set) carry
      // their project context too — otherwise the project filter below would
      // silently exclude every infra row and the Sage CSV would be missing
      // infra material consumption entirely.
      let subQuery = db
        .from('submissions')
        .select(`
          id, session_id, created_at, hours_worked, user_id,
          users!submissions_user_id_fkey ( id, name, initials, crew_type ),
          work_sessions!submissions_session_id_fkey (
            task_id,
            tasks (
              name,
              phases ( name, projects ( id, name ) ),
              sites  ( name, projects ( id, name ) )
            )
          )
        `)
        .eq('status', 'approved')
        .eq('archived', false)
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
        .order('created_at', { ascending: false })

      const { data: subs, error: subErr } = await subQuery
      if (subErr) throw subErr

      // Filter by project
      let filteredSubs = subs || []

      // work_sessions comes back as array from Supabase join — normalize it
      filteredSubs = filteredSubs.map(s => ({
        ...s,
        _session: Array.isArray(s.work_sessions) ? s.work_sessions[0] : s.work_sessions
      }))

      if (selProject !== 'all') {
        filteredSubs = filteredSubs.filter(s => {
          const t = s._session?.tasks
          const projId = t?.phases?.projects?.id || t?.sites?.projects?.id
          return projId === selProject
        })
      }
      if (selUser !== 'all') {
        filteredSubs = filteredSubs.filter(s => s.user_id === selUser)
      }

      if (filteredSubs.length === 0) { setRows([]); setLoading(false); return }

      // Get all log entries for these submissions
      const sessionIds = [...new Set(filteredSubs.map(s => s.session_id).filter(Boolean))]

      // Build a map of session_id -> submission
      const sessionToSub = {}
      filteredSubs.forEach(s => { if (s.session_id) sessionToSub[s.session_id] = s })

      // Get log entries
      const { data: entries } = await db
        .from('log_entries')
        .select('id, session_id, task_id, footage_amt, entry_type')
        .in('session_id', filteredSubs.map(s => s.session_id).filter(Boolean))

      if (!entries || entries.length === 0) { setRows([]); setLoading(false); return }

      const entryIds = entries.map(e => e.id)
      const entryMap = {}
      entries.forEach(e => { entryMap[e.id] = e })

      // Get parts
      const { data: parts } = await db
        .from('entry_parts')
        .select('entry_id, part_id, quantity, parts_catalog ( id, name, unit, boxhero_id, department, item_type, material_group )')
        .in('entry_id', entryIds)

      // Build report rows. project/location names coalesce fiber (phase) and
      // infra (site) — same row shape so the rest of the view (grouping,
      // CSV, summaries) doesn't need to know which crew type produced it.
      const reportRows = []
      ;(parts || []).forEach(p => {
        const entry = entryMap[p.entry_id]
        if (!entry) return
        const sub = sessionToSub[entry.session_id]
        if (!sub) return

        const task = sub._session?.tasks
        const projectName = task?.phases?.projects?.name || task?.sites?.projects?.name || '—'
        const locationName = task?.phases?.name || task?.sites?.name || '—'

        reportRows.push({
          date: new Date(sub.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          dateRaw: sub.created_at,
          partId: p.parts_catalog?.id || p.part_id,
          partName: p.parts_catalog?.name || p.part_id,
          unit: p.parts_catalog?.unit || 'ea',
          qty: p.quantity || 0,
          barcode: p.parts_catalog?.boxhero_id || '',
          department: p.parts_catalog?.department || '',
          itemType: p.parts_catalog?.item_type || '',
          materialGroup: p.parts_catalog?.material_group || '',
          userName: sub.users?.name || 'Unknown',
          userInitials: sub.users?.initials || '?',
          crewType: sub.users?.crew_type || '',
          projectName,
          // phaseName kept as the field name for back-compat with existing
          // consumers (CSV header is renamed to "Phase / Site" in exportCSV
          // for clarity to Sage). Holds phase name for fiber, site name for infra.
          phaseName: locationName,
          taskName: task?.name || '—',
          submissionId: sub.id,
        })
      })

      setRows(reportRows)
    } catch(e) {
      console.error('Reports load failed:', e)
    } finally {
      setLoading(false)
    }
  }

  function applyPreset(p) {
    setPreset(p)
    const r = getDateRange(p)
    if (r) {
      setDateFrom(r.from.toISOString().split('T')[0])
      setDateTo(r.to.toISOString().split('T')[0])
    }
  }

  // Aggregate by part for the summary view
  const partSummary = useMemo(() => {
    const totals = {}
    rows.forEach(r => {
      const key = r.partId
      if (!totals[key]) totals[key] = { partId: r.partId, partName: r.partName, unit: r.unit, qty: 0, people: new Set(), projects: new Set() }
      totals[key].qty += r.qty
      totals[key].people.add(r.userName)
      totals[key].projects.add(r.projectName)
    })
    return Object.values(totals).sort((a, b) => b.qty - a.qty)
  }, [rows])

  // Stats
  const totalParts = rows.reduce((a, r) => a + r.qty, 0)
  const uniqueSKUs = new Set(rows.map(r => r.partId)).size
  const uniquePeople = new Set(rows.map(r => r.userName)).size

  async function generateProjectReport() {
    if (selProject === 'all') { showToast('Select a project first'); return }
    const proj = projects.find(p => p.id === selProject)
    if (!proj) return

    // Determine if the report is time-filtered (anything other than "all-time")
    const isFiltered = preset !== 'all_time'
    const rangeLabel = (() => {
      if (!isFiltered) return 'All-time'
      const presetInfo = PRESETS.find(p => p.id === preset)
      const fmt = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const base = presetInfo?.label || 'Custom range'
      return `${base} · ${fmt(dateFrom)} – ${fmt(dateTo)}`
    })()

    // Get phase data
    const { data: phases } = await db
      .from('phases')
      .select('*')
      .eq('project_id', selProject)
      .order('sequence_order')

    // Get approved submissions for this project — respect the date filter
    let subsQuery = db
      .from('submissions')
      .select(`
        *, users!submissions_user_id_fkey(name, crew_type),
        work_sessions!submissions_session_id_fkey(
          tasks(name, phases(name))
        )
      `)
      .eq('status', 'approved')
      .eq('archived', false)

    if (isFiltered) {
      subsQuery = subsQuery
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
    }

    const { data: subs } = await subsQuery

    const projSubs = (subs || []).map(s => ({
      ...s,
      _session: Array.isArray(s.work_sessions) ? s.work_sessions[0] : s.work_sessions
    })).filter(s =>
      phases?.some(ph => ph.name === s._session?.tasks?.phases?.name)
    )

    // === Fiber & Conduit breakdown ===
    // Pull entry_parts for these submissions' sessions to break out counts/sizes
    const sessionIds = projSubs.map(s => s.session_id).filter(Boolean)
    const fiberBreakdown = {}  // { '144 ct': qty, '12 ct': qty, ... }
    const conduitBreakdown = {}  // { '2"': qty, '1 1/4"': qty, ... }

    if (sessionIds.length > 0) {
      const { data: sessionEntries } = await db
        .from('log_entries')
        .select('id, session_id')
        .in('session_id', sessionIds)

      const eIds = (sessionEntries || []).map(e => e.id)
      if (eIds.length > 0) {
        const { data: eParts } = await db
          .from('entry_parts')
          .select('quantity, parts_catalog ( name, unit, material_group )')
          .in('entry_id', eIds)

        ;(eParts || []).forEach(ep => {
          const pc = ep.parts_catalog
          if (!pc) return
          const name = pc.name || ''
          const qty = ep.quantity || 0
          if (qty <= 0) return

          // Fiber: material_group = 'Fiber' AND name contains 'N ct'
          if (pc.material_group === 'Fiber') {
            const m = name.match(/(\d+)\s*ct/i)
            if (m) {
              const label = `${m[1]} ct`
              fiberBreakdown[label] = (fiberBreakdown[label] || 0) + qty
            }
          }

          // Conduit: name starts with 'Conduit ' and isn't a fitting
          const isConduitLinear =
            /^conduit\s/i.test(name) &&
            !/coupler|plug|standoff|bracket|rigid metal/i.test(name)

          if (isConduitLinear) {
            // Extract size: everything after "Conduit " up to the first non-size word
            // Examples: 'Conduit 1 1/2"' → '1 1/2"', 'Conduit 2" power' → '2" power'
            const m = name.match(/^conduit\s+(.+?)\s*$/i)
            if (m) {
              const label = m[1].trim()
              conduitBreakdown[label] = (conduitBreakdown[label] || 0) + qty
            }
          }
        })
      }
    }

    // Sort breakdowns: fiber by count descending (144 before 12), conduit by size
    const fiberEntries = Object.entries(fiberBreakdown)
      .sort(([a], [b]) => parseInt(b) - parseInt(a))
    const conduitEntries = Object.entries(conduitBreakdown)
      .sort(([a], [b]) => a.localeCompare(b))

    const totalHours = projSubs.reduce((a, s) => a + (s.hours_worked || 0), 0)
    const totalPoles = projSubs.reduce((a, s) => a + (s.total_poles || 0), 0)
    const totalStrand = projSubs.reduce((a, s) => a + (s.total_strand_ft || 0), 0)
    const totalFiber = projSubs.reduce((a, s) => a + (s.total_fiber_ft || 0), 0)
    const totalConduit = projSubs.reduce((a, s) => a + (s.total_conduit_ft || 0), 0)
    const totalMst = projSubs.reduce((a, s) => a + (s.total_mst_hst || 0), 0)
    const totalCases = projSubs.reduce((a, s) => a + (s.total_splice_cases || 0), 0)
    const totalHH = projSubs.reduce((a, s) => a + (s.total_handholes || 0), 0)
    const totalVaults = projSubs.reduce((a, s) => a + (s.total_vaults || 0), 0)

    function pct(actual, target) {
      if (!target || target === 0) return 0
      return Math.min(100, Math.round((actual / target) * 100))
    }

    function bar(pct) {
      const filled = Math.round(pct / 5)
      const empty = 20 - filled
      return `<div style="height:8px;background:#2E2E2B;border-radius:4px;overflow:hidden;margin-top:4px">
        <div style="height:100%;width:${pct}%;background:#F5871F;border-radius:4px"></div>
      </div>`
    }

    function statRow(label, actual, target, unit) {
      // When filtered by time, suppress targets — comparing a week's work to a project total is misleading
      if (isFiltered) {
        return `
          <div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:#888780">${label}</span>
              <span style="color:#F0EFE8;font-weight:700">${actual.toLocaleString()} ${unit}</span>
            </div>
          </div>`
      }
      const p = pct(actual, target)
      return `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:12px">
            <span style="color:#888780">${label}</span>
            <span style="color:#F0EFE8;font-weight:700">${actual.toLocaleString()} ${unit} ${target > 0 ? `<span style="color:#555550">/ ${target.toLocaleString()} ${unit} (${p}%)</span>` : ''}</span>
          </div>
          ${target > 0 ? bar(p) : ''}
        </div>`
    }

    const reportDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })

    const phasesHTML = (phases || []).map(ph => {
      const phSubs = projSubs.filter(s => s._session?.tasks?.phases?.name === ph.name)
      const phStrand = phSubs.reduce((a,s) => a + (s.total_strand_ft||0), 0)
      const phFiber = phSubs.reduce((a,s) => a + (s.total_fiber_ft||0), 0)
      const phConduit = phSubs.reduce((a,s) => a + (s.total_conduit_ft||0), 0)
      const phMst = phSubs.reduce((a,s) => a + (s.total_mst_hst||0), 0)
      const phCases = phSubs.reduce((a,s) => a + (s.total_splice_cases||0), 0)
      const phHH = phSubs.reduce((a,s) => a + (s.total_handholes||0), 0)
      const phVaults = phSubs.reduce((a,s) => a + (s.total_vaults||0), 0)

      // Skip phases with no activity when filtered — keeps weekly reports focused
      const phaseTotal = phStrand + phFiber + phConduit + phMst + phCases + phHH + phVaults
      if (isFiltered && phaseTotal === 0) return ''

      return `
        <div style="background:#1C1C1A;border:1px solid #2E2E2B;border-radius:10px;padding:16px;margin-bottom:12px">
          <div style="font-size:15px;font-weight:700;color:#F0EFE8;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2E2E2B">
            ${ph.name}
          </div>
          ${statRow('Strand', phStrand, ph.strand_ft_target || 0, 'ft')}
          ${statRow('Fiber', phFiber, ph.fiber_ft || 0, 'ft')}
          ${statRow('Conduit', phConduit, ph.conduit_ft_target || 0, 'ft')}
          ${statRow('MST/HST', phMst, ph.mst_hst_target || 0, 'units')}
          ${statRow('Splice cases', phCases, ph.splice_case_target || 0, 'cases')}
          ${statRow('Handholes', phHH, ph.handhole_target || 0, 'ea')}
          ${statRow('Vaults', phVaults, ph.vault_target || 0, 'ea')}
        </div>`
    }).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>FiberLog — ${proj.name} Progress Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Arial, sans-serif; }
    body { background: #111210; color: #F0EFE8; padding: 32px; max-width: 800px; margin: 0 auto; }
    @media print {
      body { background: white; color: #111; padding: 16px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div>
      <div style="font-size:28px;font-weight:800;color:#F5871F;letter-spacing:-0.5px">FiberLog</div>
      <div style="font-size:13px;color:#888780">Utah Broadband · Progress Report</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:13px;color:#888780">${reportDate}</div>
    </div>
  </div>

  <div style="border-bottom:2px solid #F5871F;margin-bottom:24px;padding-bottom:12px">
    <div style="font-size:22px;font-weight:800;color:#F0EFE8">${proj.name}</div>
    <div style="font-size:13px;color:#888780;margin-top:4px">${proj.region || ''}</div>
    <div style="display:inline-block;margin-top:8px;padding:4px 12px;background:#F5871F;color:white;border-radius:20px;font-size:12px;font-weight:700">
      ${rangeLabel}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:24px">
    ${[
      { label: 'Total hours', value: totalHours.toFixed(1) },
      { label: 'Poles hung', value: totalPoles.toLocaleString() },
      { label: 'Strand', value: totalStrand.toLocaleString() + ' ft' },
      { label: 'Fiber', value: totalFiber.toLocaleString() + ' ft' },
      { label: 'Conduit', value: totalConduit.toLocaleString() + ' ft' },
      { label: 'MST/HST', value: totalMst },
      { label: 'Splice cases', value: totalCases },
      { label: 'Handholes', value: totalHH },
    ].map(s => `
      <div style="background:#1C1C1A;border:1px solid #2E2E2B;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:800;color:#F5871F">${s.value}</div>
        <div style="font-size:10px;color:#888780;margin-top:2px">${s.label}</div>
      </div>`).join('')}
  </div>

  <div style="font-size:13px;font-weight:700;color:#555550;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">${isFiltered ? 'Activity by Phase' : 'Phase Breakdown'}</div>
  ${phasesHTML || '<div style="text-align:center;padding:40px;color:#555550;font-size:13px">No activity in this range</div>'}

  ${(fiberEntries.length > 0 || conduitEntries.length > 0) ? `
  <div style="font-size:13px;font-weight:700;color:#555550;text-transform:uppercase;letter-spacing:.06em;margin:24px 0 12px">Materials Detail</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
    <div style="background:#1C1C1A;border:1px solid #2E2E2B;border-radius:10px;padding:16px">
      <div style="font-size:14px;font-weight:700;color:#F0EFE8;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #2E2E2B">
        Fiber by count
      </div>
      ${fiberEntries.length === 0
        ? '<div style="font-size:12px;color:#555550">No fiber logged</div>'
        : fiberEntries.map(([label, qty]) => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0">
              <span style="color:#888780">${label}</span>
              <span style="color:#F0EFE8;font-weight:700">${qty.toLocaleString()} ea</span>
            </div>`).join('')}
    </div>
    <div style="background:#1C1C1A;border:1px solid #2E2E2B;border-radius:10px;padding:16px">
      <div style="font-size:14px;font-weight:700;color:#F0EFE8;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #2E2E2B">
        Conduit by size
      </div>
      ${conduitEntries.length === 0
        ? '<div style="font-size:12px;color:#555550">No conduit logged</div>'
        : conduitEntries.map(([label, qty]) => `
            <div style="display:flex;justify-content:space-between;font-size:12px;padding:4px 0">
              <span style="color:#888780">${label}</span>
              <span style="color:#F0EFE8;font-weight:700">${qty.toLocaleString()} ea</span>
            </div>`).join('')}
    </div>
  </div>
  ` : ''}

  <div style="margin-top:24px;text-align:center">
    <button class="no-print" onclick="window.print()" style="background:#F5871F;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">
      Save as PDF
    </button>
  </div>
</body>
</html>`

    const win = window.open('', '_blank')
    win.document.write(html)
    win.document.close()
  }

  function exportCSV() {
    const headers = ['Date', 'Crew Member', 'Crew Type', 'Project', 'Phase / Site', 'Task', 'Part SKU', 'BoxHero ID', 'Barcode', 'Department', 'Type', 'Material Group', 'Part Name', 'Qty', 'Unit']
    const csvRows = [headers, ...rows.map(r => [
      r.date, r.userName, r.crewType, r.projectName, r.phaseName, r.taskName,
      r.partId, r.barcode, barcodeMap[r.partId] || '', r.department, r.itemType, r.materialGroup, r.partName, r.qty, r.unit
    ])]
    const csv = csvRows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `fiberlog-parts-${dateFrom}-to-${dateTo}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Filter summary line used when the filters panel is collapsed —
  // condenses six rows of chrome into a single readable status string
  // so the user knows what data they're looking at.
  const presetLabel = preset
    ? (PRESETS.find(p => p.id === preset)?.label || 'Custom')
    : `${dateFrom} → ${dateTo}`
  const projectLabel = selProject === 'all' ? 'All projects' : (projects.find(p => p.id === selProject)?.name || 'Project')
  const userLabel = selUser === 'all' ? 'All crew' : (users.find(u => u.id === selUser)?.name || 'Crew')
  const groupLabel = groupBy === 'part' ? 'parts' : groupBy === 'person' ? 'people' : 'projects'
  const selProj = selProject !== 'all' ? projects.find(p => p.id === selProject) : null
  const isInfraOnly = selProj && (!selProj.phases || selProj.phases.length === 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Slim header — always visible. Title + filter toggle + group-by +
          primary actions. The bulky filter chrome moves into a collapsible
          panel below so it doesn't eat the screen on phones. */}
      <div style={{
        padding: '12px 16px', flexShrink: 0,
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--text)' }}>Reports</div>
          <button
            onClick={() => setShowFilters(v => !v)}
            className={`chip${showFilters ? ' chip-active' : ''}`}
            title={showFilters ? 'Hide filter controls' : 'Show date range, project, crew filters'}
          >
            <Icon name="filter" size={14} /> {showFilters ? 'Hide filters' : 'Filters'}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={exportCSV} disabled={rows.length === 0}
            className="btn btn-primary"
            style={{ height: 30, padding: '0 14px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6,
              opacity: rows.length > 0 ? 1 : 0.5, cursor: rows.length > 0 ? 'pointer' : 'not-allowed' }}>
            <Icon name="download" size={14} /> CSV
          </button>
        </div>

        {/* Group-by stays one tap away — it changes what you're seeing,
            not what you're filtering. Compact pill row. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[{ id: 'part', label: 'By part' }, { id: 'person', label: 'By person' }, { id: 'project', label: 'By project' }].map(g => (
            <button key={g.id} onClick={() => setGroupBy(g.id)} style={{
              padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
              background: groupBy === g.id ? 'var(--orange)' : 'transparent',
              color: groupBy === g.id ? 'white' : 'var(--muted)',
              border: `1.5px solid ${groupBy === g.id ? 'var(--orange)' : 'var(--border)'}`,
              cursor: 'pointer'
            }}>{g.label}</button>
          ))}
        </div>

        {/* Status line — only when filters collapsed. Tells the user what's
            being filtered so they don't have to expand to find out. */}
        {!showFilters && (
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8, lineHeight: 1.4 }}>
            {presetLabel} · {projectLabel} · {userLabel}
            {rows.length > 0 && (
              <span className="mono" style={{ marginLeft: 8, color: 'var(--text)', fontWeight: 600 }}>
                · {totalParts.toLocaleString()} parts · {uniqueSKUs} SKUs · {uniquePeople} crew
              </span>
            )}
          </div>
        )}

        {/* Expanded filter panel */}
        {showFilters && (
          <div style={{ marginTop: 12 }}>
            {/* Preset buttons */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              {PRESETS.map(p => (
                <button key={p.id} onClick={() => applyPreset(p.id)} style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                  background: preset === p.id ? 'var(--orange)' : 'var(--gray-lt)',
                  color: preset === p.id ? 'white' : 'var(--muted)',
                  border: 'none', cursor: 'pointer'
                }}>{p.label}</button>
              ))}
            </div>

            {/* Date range */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, marginBottom: 3 }}>From</div>
                <input type="date" value={dateFrom}
                  onChange={e => { setDateFrom(e.target.value); setPreset('') }}
                  style={{ width: '100%', padding: '7px 10px', background: 'var(--surface2)',
                    border: '1.5px solid var(--border2)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }} />
              </div>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, marginBottom: 3 }}>To</div>
                <input type="date" value={dateTo}
                  onChange={e => { setDateTo(e.target.value); setPreset('') }}
                  style={{ width: '100%', padding: '7px 10px', background: 'var(--surface2)',
                    border: '1.5px solid var(--border2)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }} />
              </div>
            </div>

            {/* Project + crew filters */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <select value={selProject} onChange={e => setSelProject(e.target.value)}
                style={{ flex: 1, minWidth: 120, padding: '7px 10px', background: 'var(--surface2)',
                  border: '1.5px solid var(--border2)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }}>
                <option value="all">All projects</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={selUser} onChange={e => setSelUser(e.target.value)}
                style={{ flex: 1, minWidth: 120, padding: '7px 10px', background: 'var(--surface2)',
                  border: '1.5px solid var(--border2)', borderRadius: 8, color: 'var(--text)', fontSize: 12 }}>
                <option value="all">All crew</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>

            {/* Secondary actions — less-used (per-session) buttons live in
                the expanded panel so they don't crowd the always-visible row. */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={loadStock} className="chip">
                <Icon name="box" size={14} /> {stockLoading ? 'Loading…' : 'Stock levels'}
              </button>
              {/* Progress PDF is fiber-only — disabled for infra-only projects */}
              <button onClick={generateProjectReport}
                disabled={isInfraOnly}
                title={isInfraOnly ? 'Progress PDF is fiber-only (organized by phases). Infra projects don’t use phases yet.' : ''}
                className="chip"
                style={{ opacity: isInfraOnly ? 0.5 : 1, cursor: isInfraOnly ? 'not-allowed' : 'pointer' }}>
                <Icon name="receipt" size={14} /> Progress PDF
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 20px' }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>Loading...</div>}

        {!loading && rows.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10, color: 'var(--gray-mid)' }}><Icon name="chart" size={32} /></div>
            <div>No approved submissions in this range</div>
          </div>
        )}

        {/* Inline stats — slim row at top of data so totals are always
            visible whether filters are expanded or collapsed. */}
        {!loading && rows.length > 0 && showFilters && (
          <div style={{
            display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap',
            padding: '8px 0', fontSize: 12, color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
          }}>
            <span><strong className="mono" style={{ color: 'var(--accent-dk)' }}>{totalParts.toLocaleString()}</strong> parts</span>
            <span>·</span>
            <span><strong className="mono" style={{ color: 'var(--accent-dk)' }}>{uniqueSKUs}</strong> SKUs</span>
            <span>·</span>
            <span><strong className="mono" style={{ color: 'var(--accent-dk)' }}>{uniquePeople}</strong> crew</span>
          </div>
        )}

        {/* By Part view */}
        {!loading && groupBy === 'part' && partSummary.map((p, i) => (
          <PartRow key={p.partId} part={p} rows={rows.filter(r => r.partId === p.partId)} stock={stockMap[p.partId]} barcode={barcodeMap[p.partId]} />
        ))}

        {/* By Person view */}
        {!loading && groupBy === 'person' && (() => {
          const byPerson = {}
          rows.forEach(r => {
            if (!byPerson[r.userName]) byPerson[r.userName] = { name: r.userName, initials: r.userInitials, rows: [] }
            byPerson[r.userName].rows.push(r)
          })
          return Object.values(byPerson).sort((a,b) => a.name.localeCompare(b.name)).map(person => (
            <PersonGroup key={person.name} person={person} />
          ))
        })()}

        {/* By Project view */}
        {!loading && groupBy === 'project' && (() => {
          const byProject = {}
          rows.forEach(r => {
            if (!byProject[r.projectName]) byProject[r.projectName] = { name: r.projectName, rows: [] }
            byProject[r.projectName].rows.push(r)
          })
          return Object.values(byProject).sort((a,b) => a.name.localeCompare(b.name)).map(proj => (
            <ProjectGroup key={proj.name} proj={proj} />
          ))
        })()}
      </div>
    </div>
  )
}

function PartRow({ part, rows, stock, barcode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ marginBottom: 6 }}>
      <div onClick={() => setExpanded(p => !p)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: expanded ? '8px 8px 0 0' : 8, padding: '10px 14px',
          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{part.partName}</div>
          <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 2, fontFamily: 'monospace' }}>{part.partId}</div>
          {barcode && <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 1 }}>Barcode: {barcode}</div>}
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
            {[...part.people].join(', ')} · {[...part.projects].join(', ')}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 12 }}>
          <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: 'var(--orange)' }}>{part.qty.toLocaleString()}</div>
          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{part.unit} used</div>
          {stock !== undefined && (
            <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2,
              color: stock <= 0 ? 'var(--red)' : stock < part.qty * 2 ? 'var(--amber)' : 'var(--teal-mid)' }}>
              {stock <= 0 ? <><Icon name="alert" size={11} style={{ display: 'inline-block', verticalAlign: '-2px', marginRight: 3 }} />Out of stock</> : <><span className="mono">{stock.toLocaleString()}</span> in stock</>}
            </div>
          )}
        </div>
      </div>
      {expanded && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 14px', borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{r.userName}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.date} · {r.projectName} › {r.taskName}</div>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--orange)', flexShrink: 0, marginLeft: 8 }}>
                {r.qty.toLocaleString()} <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{r.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PersonGroup({ person }) {
  const [expanded, setExpanded] = useState(false)
  const total = person.rows.reduce((a, r) => a + r.qty, 0)
  const skus = new Set(person.rows.map(r => r.partId)).size
  return (
    <div style={{ marginBottom: 8 }}>
      <div onClick={() => setExpanded(p => !p)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: expanded ? '8px 8px 0 0' : 8, padding: '10px 14px',
          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--orange-lt)', border: '1px solid var(--orange-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--orange)', flexShrink: 0 }}>{person.initials}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{person.name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{skus} SKUs · {total.toLocaleString()} total parts</div>
          </div>
        </div>
        <span style={{ color: 'var(--muted)', transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-flex', transition: 'transform .2s' }}><Icon name="chevron-right" size={15} /></span>
      </div>
      {expanded && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
          {Object.entries(person.rows.reduce((acc, r) => {
            if (!acc[r.partId]) acc[r.partId] = { name: r.partName, unit: r.unit, qty: 0 }
            acc[r.partId].qty += r.qty
            return acc
          }, {})).sort(([,a],[,b]) => b.qty - a.qty).map(([id, p], i, arr) => (
            <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>{id}</div>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--orange)', flexShrink: 0, marginLeft: 8 }}>
                {p.qty.toLocaleString()} <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectGroup({ proj }) {
  const [expanded, setExpanded] = useState(false)
  const total = proj.rows.reduce((a, r) => a + r.qty, 0)
  const skus = new Set(proj.rows.map(r => r.partId)).size
  const initials = proj.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()
  return (
    <div style={{ marginBottom: 8 }}>
      <div onClick={() => setExpanded(p => !p)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: expanded ? '8px 8px 0 0' : 8, padding: '10px 14px',
          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--orange-lt)', border: '1px solid var(--orange-dk)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: 'var(--orange)', flexShrink: 0 }}>{initials}</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>{proj.name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{skus} SKUs · {total.toLocaleString()} total parts</div>
          </div>
        </div>
        <span style={{ color: 'var(--muted)', transform: expanded ? 'rotate(90deg)' : 'none', display: 'inline-flex', transition: 'transform .2s' }}><Icon name="chevron-right" size={15} /></span>
      </div>
      {expanded && (
        <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderTop: 'none', borderRadius: '0 0 8px 8px' }}>
          {Object.entries(proj.rows.reduce((acc, r) => {
            if (!acc[r.partId]) acc[r.partId] = { name: r.partName, unit: r.unit, qty: 0 }
            acc[r.partId].qty += r.qty
            return acc
          }, {})).sort(([,a],[,b]) => b.qty - a.qty).map(([id, p], i, arr) => (
            <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>{id}</div>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--orange)', flexShrink: 0, marginLeft: 8 }}>
                {p.qty.toLocaleString()} <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
