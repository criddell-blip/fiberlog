import { useState, useEffect } from 'react'
import { useApp } from '../../AppContext'
import {
  db, addTask,
  getSitesByProject, addSite, updateSite,
  decommissionSiteWithRecovery,
  getTaskCountsBySite, getTasksBySite, getMaterialsAtSite,
} from '../../lib/supabase'
import { getLocations } from '../../lib/inventory'
import { useBackClose } from '../../lib/backStack'
import Icon from '../shared/Icon'

const SITE_TYPES = [
  { id: 'wireless', label: 'Wireless', iconName: 'pin' },
  { id: 'fiber',    label: 'Fiber',    iconName: 'warehouse' },
]

const JOB_TYPES = [
  { id: 'aerial',      label: 'Aerial',      icon: '🏗️' },
  { id: 'underground', label: 'Underground',  icon: '⛏️' },
  { id: 'splice',      label: 'Splice',       icon: '🔌' },
  { id: 'fiber_pull',  label: 'Fiber Pull',   icon: '📦' },
  { id: 'emergency',   label: 'Emergency',    icon: '⚡' },
]

const TARGET_FIELDS = [
  { key: 'fiber_ft',            label: 'Fiber',        unit: 'ft',    col: 'fiber_ft' },
  { key: 'strand_ft_target',    label: 'Strand',       unit: 'ft',    col: 'strand_ft_target' },
  { key: 'conduit_ft_target',   label: 'Conduit',      unit: 'ft',    col: 'conduit_ft_target' },
  { key: 'mst_hst_target',      label: 'MST/HST',      unit: 'units', col: 'mst_hst_target' },
  { key: 'splice_case_target',  label: 'Splice Cases', unit: 'ea',    col: 'splice_case_target' },
  { key: 'handhole_target',     label: 'Handholes',    unit: 'ea',    col: 'handhole_target' },
  { key: 'vault_target',        label: 'Vaults',       unit: 'ea',    col: 'vault_target' },
]

const PROJECT_TARGET_FIELDS = [
  { key: 'total_fiber_ft',      label: 'Fiber',        unit: 'ft' },
  { key: 'total_strand_ft',     label: 'Strand',       unit: 'ft' },
  { key: 'total_conduit_ft',    label: 'Conduit',      unit: 'ft' },
  { key: 'total_mst_hst',       label: 'MST/HST',      unit: 'units' },
  { key: 'total_splice_cases',  label: 'Splice Cases', unit: 'ea' },
  { key: 'total_handholes',     label: 'Handholes',    unit: 'ea' },
  { key: 'total_vaults',        label: 'Vaults',       unit: 'ea' },
]

export default function ProjectManager() {
  const { projects, setProjects, showToast, reload, currentUser } = useApp()
  const [selProject, setSelProject] = useState(null)
  const [selPhase, setSelPhase] = useState(null)

  // Site counts per project. Infra projects (Gigwave / Fixed Wireless /
  // regional infra projects) are populated by sites — without this count the
  // project card just shows "0 phases · 0 tasks" and looks broken to the
  // owner. AppContext's projects tree doesn't carry sites (the fiber + infra
  // shells each load their own tree), so this is a small standalone fetch.
  const [siteCountByProject, setSiteCountByProject] = useState({})
  useEffect(() => {
    let cancelled = false
    db.from('sites')
      .select('project_id')
      .eq('status', 'active')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { console.warn('Site counts load failed:', error); return }
        const counts = {}
        ;(data || []).forEach(s => {
          if (!s.project_id) return
          counts[s.project_id] = (counts[s.project_id] || 0) + 1
        })
        setSiteCountByProject(counts)
      })
    return () => { cancelled = true }
  }, [])
  const [showAddPhase, setShowAddPhase] = useState(false)
  const [showAddProject, setShowAddProject] = useState(false)

  // Add phase form state
  const [phaseName, setPhaseName] = useState('')
  const [phaseTargets, setPhaseTargets] = useState({})
  const [phasePermitUrl, setPhasePermitUrl] = useState('')
  const [phaseSaving, setPhaseSaving] = useState(false)

  // Add project form
  const [projName, setProjName] = useState('')
  const [projRegion, setProjRegion] = useState('')
  const [projFiber, setProjFiber] = useState('')
  const [projTargets, setProjTargets] = useState({})
  const [projSaving, setProjSaving] = useState(false)

  // Project target editing
  const [editingProjTarget, setEditingProjTarget] = useState(null)
  const [editProjVal, setEditProjVal] = useState('')
  const [editProjSaving, setEditProjSaving] = useState(false)

  // Phase target editing
  const [editingTarget, setEditingTarget] = useState(null)
  const [editVal, setEditVal] = useState('')
  // Phase-targets accordion. Targets grid eats ~80px even when most fields
  // are zero; collapsed by default so the phase detail focuses on the
  // tasks list (the more frequently-touched content).
  const [phaseTargetsOpen, setPhaseTargetsOpen] = useState(false)
  const [editSaving, setEditSaving] = useState(false)

  // Permit URL editing
  const [editingPermit, setEditingPermit] = useState(false)
  const [editPermitVal, setEditPermitVal] = useState('')
  const [permitSaving, setPermitSaving] = useState(false)

  // Add task
  const [showAddTask, setShowAddTask] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskNotes, setTaskNotes] = useState('')
  const [taskJobType, setTaskJobType] = useState('aerial')
  const [taskSaving, setTaskSaving] = useState(false)
  const [confirmDeleteTask, setConfirmDeleteTask] = useState(null)

  // Sites — loaded when a project is opened. Sites are infra crew's unit of
  // work (towers, business installs, MDU equipment closets). The Sites
  // section + "Add site" overlay only render for infra-style projects
  // (zero phases + non-zero sites), so fiber regional projects stay clean.
  const [projectSites, setProjectSites] = useState([])
  const [siteTaskCounts, setSiteTaskCounts] = useState({})  // { site_id: count }
  const [sitesLoading, setSitesLoading] = useState(false)
  const [showAddSite, setShowAddSite] = useState(false)
  const [siteName, setSiteName] = useState('')
  const [siteType, setSiteType] = useState('wireless')
  const [siteAddress, setSiteAddress] = useState('')
  const [siteNotes, setSiteNotes] = useState('')
  const [siteSaving, setSiteSaving] = useState(false)

  // Sites search / filter — Gigwave has 128 sites, the unfiltered list is
  // unscrollable. Empty query + 'all' type = no-op.
  const [siteQuery, setSiteQuery] = useState('')
  const [siteTypeFilter, setSiteTypeFilter] = useState('all')

  // Edit-site overlay state. selSite is the row being edited (kept separate
  // from add-site state so the two overlays don't share inputs).
  const [editSite, setEditSite] = useState(null)
  const [editSiteName, setEditSiteName] = useState('')
  const [editSiteType, setEditSiteType] = useState('wireless')
  const [editSiteAddress, setEditSiteAddress] = useState('')
  const [editSiteNotes, setEditSiteNotes] = useState('')
  const [editSiteProjectId, setEditSiteProjectId] = useState('')
  const [editSiteSaving, setEditSiteSaving] = useState(false)
  const [confirmDecommSite, setConfirmDecommSite] = useState(null)
  // Decommission modal state. Populated when confirmDecommSite is set —
  // we load materials at the site + valid recovery destinations in parallel.
  // selectedParts shape: { [partId]: { selected: bool, qty: number, name, unit } }
  // — qty defaults to the consumed total but the user can dial it down for
  // partial recovery.
  const [decommMaterials, setDecommMaterials] = useState([])
  const [decommSelectedParts, setDecommSelectedParts] = useState({})
  const [decommDestinations, setDecommDestinations] = useState([])
  const [decommDestinationId, setDecommDestinationId] = useState('')
  const [decommLoading, setDecommLoading] = useState(false)

  // Sub-modals stacked on top of Edit Site: tasks-at-site, materials-at-site.
  // null = closed; a populated object means open. The data is loaded lazily
  // when the manager taps the corresponding button so we don't pay the
  // query cost just for opening the edit overlay.
  const [siteTasksModal, setSiteTasksModal] = useState(null)        // { siteId, siteName, loading, rows }
  const [siteMaterialsModal, setSiteMaterialsModal] = useState(null)  // { siteId, siteName, loading, rows }

  // Back button: close whichever overlay is open (most-recently-opened wins via
  // the coordinator's move-to-top, so stacked sub-modals close first). Add-forms
  // confirm before discarding typed input; edit/confirm/display overlays close
  // immediately (edit overlays load existing values; confirm dialogs and the
  // tasks/materials drilldowns have nothing to lose).
  useBackClose(showAddPhase ? 1 : 0, () => setShowAddPhase(false), {
    confirm: () => !phaseName.trim() || window.confirm('Discard this phase?'),
  })
  useBackClose(showAddProject ? 1 : 0, () => setShowAddProject(false), {
    confirm: () => !projName.trim() || window.confirm('Discard this project?'),
  })
  useBackClose(showAddTask ? 1 : 0, () => setShowAddTask(false), {
    confirm: () => !(taskName.trim() || taskNotes.trim()) || window.confirm('Discard this task?'),
  })
  useBackClose(showAddSite ? 1 : 0, () => setShowAddSite(false), {
    confirm: () => !(siteName.trim() || siteAddress.trim() || siteNotes.trim()) || window.confirm('Discard this site?'),
  })
  useBackClose(editSite ? 1 : 0, () => setEditSite(null))
  useBackClose(confirmDeleteTask ? 1 : 0, () => setConfirmDeleteTask(null))
  useBackClose(confirmDecommSite ? 1 : 0, () => setConfirmDecommSite(null))
  useBackClose(siteTasksModal ? 1 : 0, () => setSiteTasksModal(null))
  useBackClose(siteMaterialsModal ? 1 : 0, () => setSiteMaterialsModal(null))
  // Drill-in: Back steps phase detail → project detail → project list. Overlays
  // above (add forms, confirms) close first via move-to-top.
  useBackClose((selPhase && selProject) ? 2 : selProject ? 1 : 0, () => {
    if (selPhase) setSelPhase(null)
    else if (selProject) setSelProject(null)
  })

  useEffect(() => {
    if (!selProject?.id) {
      setProjectSites([]); setSiteTaskCounts({}); return
    }
    let cancelled = false
    setSitesLoading(true)
    // Load sites + per-site task counts in parallel. Counts are best-effort —
    // if that call fails the sites still render, just without badges.
    Promise.all([
      getSitesByProject(selProject.id),
      getTaskCountsBySite(selProject.id).catch(e => {
        console.warn('Site task counts failed:', e); return {}
      }),
    ])
      .then(([sites, counts]) => {
        if (cancelled) return
        setProjectSites(sites)
        setSiteTaskCounts(counts)
      })
      .catch(e => { console.warn('Sites load failed:', e); if (!cancelled) setProjectSites([]) })
      .finally(() => { if (!cancelled) setSitesLoading(false) })
    return () => { cancelled = true }
  }, [selProject?.id])

  function openEditSite(s) {
    setEditSite(s)
    setEditSiteName(s.name || '')
    setEditSiteType(s.type || 'wireless')
    setEditSiteAddress(s.address || '')
    setEditSiteNotes(s.notes || '')
    setEditSiteProjectId(s.project_id || '')
  }

  async function handleEditSite() {
    if (!editSite || !editSiteName.trim()) return
    setEditSiteSaving(true)
    try {
      const newProjectId = editSiteProjectId || null
      const movedToDifferentProject = newProjectId !== editSite.project_id
      const updated = await updateSite(editSite.id, {
        name: editSiteName.trim(),
        type: editSiteType,
        address: editSiteAddress,
        notes: editSiteNotes,
        project_id: newProjectId,
      })
      if (movedToDifferentProject) {
        // Site left this project — drop from the current list and adjust
        // both project counts so the list view + detail header stay sane
        // without a refetch.
        setProjectSites(prev => prev.filter(s => s.id !== updated.id))
        setSiteCountByProject(prev => {
          const next = { ...prev }
          if (editSite.project_id) {
            next[editSite.project_id] = Math.max(0, (next[editSite.project_id] || 1) - 1)
          }
          if (newProjectId) {
            next[newProjectId] = (next[newProjectId] || 0) + 1
          }
          return next
        })
        showToast(`Site moved to ${projects.find(p => p.id === newProjectId)?.name || 'new project'}`)
      } else {
        setProjectSites(prev => prev.map(s => s.id === updated.id ? updated : s)
          .sort((a, b) => a.name.localeCompare(b.name)))
        showToast('Site updated')
      }
      setEditSite(null)
    } catch (e) {
      console.error('Update site failed:', e)
      showToast('Update failed: ' + e.message)
    } finally {
      setEditSiteSaving(false)
    }
  }

  async function openSiteTasks(site) {
    setSiteTasksModal({ siteId: site.id, siteName: site.name, loading: true, rows: [] })
    try {
      const rows = await getTasksBySite(site.id)
      setSiteTasksModal({ siteId: site.id, siteName: site.name, loading: false, rows })
    } catch (e) {
      console.error('Load site tasks failed:', e)
      showToast('Load tasks failed: ' + e.message)
      setSiteTasksModal(null)
    }
  }

  async function openSiteMaterials(site) {
    setSiteMaterialsModal({ siteId: site.id, siteName: site.name, loading: true, rows: [] })
    try {
      const rows = await getMaterialsAtSite(site.id)
      setSiteMaterialsModal({ siteId: site.id, siteName: site.name, loading: false, rows })
    } catch (e) {
      console.error('Load site materials failed:', e)
      showToast('Load materials failed: ' + e.message)
      setSiteMaterialsModal(null)
    }
  }

  // Whenever the decommission confirm opens, load the site's materials
  // (so the owner sees what's been consumed) AND the list of valid
  // destinations for recovery (warehouses only — recovering INTO another
  // project bucket would just shuffle problems around). Cleared again
  // when the modal closes so the next open starts fresh.
  useEffect(() => {
    if (!confirmDecommSite) {
      setDecommMaterials([]); setDecommSelectedParts({})
      setDecommDestinations([]); setDecommDestinationId('')
      return
    }
    let cancelled = false
    setDecommLoading(true)
    Promise.all([
      getMaterialsAtSite(confirmDecommSite.id),
      getLocations().then(locs => locs.filter(l => l.type === 'warehouse')),
    ])
      .then(([mats, dests]) => {
        if (cancelled) return
        setDecommMaterials(mats)
        // Default: nothing selected. User opts in to recovery. Most
        // decommissions are accounting-only (gear stays installed) so
        // making "select all" the default would push them toward writing
        // transfers they didn't intend.
        setDecommSelectedParts(Object.fromEntries(
          mats.map(m => [m.partId, { selected: false, qty: m.qty, name: m.name, unit: m.unit }])
        ))
        setDecommDestinations(dests)
        if (dests.length === 1) setDecommDestinationId(dests[0].id)  // auto-pick if only one warehouse
      })
      .catch(e => {
        console.warn('Decommission modal load failed:', e)
        showToast('Could not load materials: ' + e.message)
      })
      .finally(() => { if (!cancelled) setDecommLoading(false) })
    return () => { cancelled = true }
  }, [confirmDecommSite])

  function toggleDecommPart(partId) {
    setDecommSelectedParts(prev => ({
      ...prev,
      [partId]: { ...prev[partId], selected: !prev[partId]?.selected },
    }))
  }
  function setDecommPartQty(partId, qty) {
    const n = Math.max(0, Number(qty) || 0)
    setDecommSelectedParts(prev => ({
      ...prev,
      [partId]: { ...prev[partId], qty: n },
    }))
  }
  function selectAllDecommParts(select) {
    setDecommSelectedParts(prev => Object.fromEntries(
      Object.entries(prev).map(([id, v]) => [id, { ...v, selected: select }])
    ))
  }

  async function handleDecommissionSite() {
    if (!confirmDecommSite) return
    const id = confirmDecommSite.id
    // Build the recovery list from the user's selections. Parts with
    // qty=0 are filtered out (selecting then zeroing = "I changed my
    // mind, don't recover this one"). If nothing selected, this is a
    // pure decommission (zero transfers, no destination required).
    const recoveryItems = Object.entries(decommSelectedParts)
      .filter(([, v]) => v.selected && v.qty > 0)
      .map(([partId, v]) => ({ partId, quantity: v.qty, unit: v.unit }))
    if (recoveryItems.length > 0 && !decommDestinationId) {
      showToast('Pick a destination warehouse for the parts you selected.')
      return
    }
    setEditSiteSaving(true)
    try {
      await decommissionSiteWithRecovery(id, recoveryItems, recoveryItems.length > 0 ? decommDestinationId : null)
      setProjectSites(prev => prev.filter(s => s.id !== id))
      setSiteCountByProject(prev => ({
        ...prev,
        [selProject.id]: Math.max(0, (prev[selProject.id] || 1) - 1),
      }))
      setConfirmDecommSite(null)
      setEditSite(null)
      showToast(recoveryItems.length > 0
        ? `Site decommissioned · ${recoveryItems.length} part${recoveryItems.length === 1 ? '' : 's'} recovered`
        : 'Site decommissioned')
    } catch (e) {
      console.error('Decommission failed:', e)
      showToast('Decommission failed: ' + e.message)
    } finally {
      setEditSiteSaving(false)
    }
  }

  async function handleAddSite() {
    if (!siteName.trim() || !selProject?.id) return
    setSiteSaving(true)
    try {
      const newSite = await addSite({
        projectId: selProject.id,
        name: siteName.trim(),
        type: siteType,
        address: siteAddress.trim() || null,
        notes: siteNotes.trim() || null,
      })
      setProjectSites(prev => [...prev, newSite].sort((a, b) => a.name.localeCompare(b.name)))
      // Bump the list-view count so it stays in sync without a refetch.
      setSiteCountByProject(prev => ({
        ...prev,
        [selProject.id]: (prev[selProject.id] || 0) + 1,
      }))
      setShowAddSite(false)
      setSiteName(''); setSiteAddress(''); setSiteNotes(''); setSiteType('wireless')
      showToast('Site added')
    } catch (e) {
      console.error('Add site failed:', e)
      showToast('Add site failed: ' + e.message)
    } finally {
      setSiteSaving(false)
    }
  }

  async function handleDeleteTask(task) {
    try {
      // Delete related sessions, entries, submissions first
      const { data: sessions } = await db.from('work_sessions').select('id').eq('task_id', task.id)
      const sessionIds = (sessions || []).map(s => s.id)
      if (sessionIds.length > 0) {
        const { data: entries } = await db.from('log_entries').select('id').in('session_id', sessionIds)
        const entryIds = (entries || []).map(e => e.id)
        if (entryIds.length > 0) await db.from('entry_parts').delete().in('entry_id', entryIds)
        await db.from('log_entries').delete().in('session_id', sessionIds)
        await db.from('submissions').delete().in('session_id', sessionIds)
        await db.from('work_sessions').delete().in('id', sessionIds)
      }
      await db.from('tasks').delete().eq('id', task.id)

      setProjects(prev => prev.map(p => {
        if (p.id !== selProject?.id) return p
        const updatedPhases = p.phases.map(ph =>
          ph.id === selPhase.id ? { ...ph, tasks: ph.tasks.filter(t => t.id !== task.id) } : ph
        )
        const updated = { ...p, phases: updatedPhases }
        setSelProject(updated)
        setSelPhase({ ...selPhase, tasks: selPhase.tasks.filter(t => t.id !== task.id) })
        return updated
      }))
      setConfirmDeleteTask(null)
      showToast('Task deleted')
    } catch(e) {
      showToast('Delete failed: ' + e.message)
    }
  }

  async function handleAddTask() {
    if (!taskName.trim() || !selPhase) return
    setTaskSaving(true)
    try {
      const saved = await addTask(selPhase.id, taskName.trim(), taskJobType, taskNotes.trim(), currentUser?.id)
      const newTask = { ...saved, type: saved.task_type, notes: saved.scope_notes || '', status: 'open' }
      setProjects(prev => prev.map(p => {
        if (p.id !== selProject?.id) return p
        const updatedPhases = p.phases.map(ph =>
          ph.id === selPhase.id ? { ...ph, tasks: [...(ph.tasks || []), newTask] } : ph
        )
        const updated = { ...p, phases: updatedPhases }
        setSelProject(updated)
        setSelPhase({ ...selPhase, tasks: [...(selPhase.tasks || []), newTask] })
        return updated
      }))
      setTaskName('')
      setTaskNotes('')
      setTaskJobType('aerial')
      setShowAddTask(false)
      showToast('Task added')
    } catch(e) {
      showToast('Failed: ' + e.message)
    } finally {
      setTaskSaving(false)
    }
  }

  async function handleAddPhase() {
    if (!phaseName.trim() || !selProject) return
    setPhaseSaving(true)
    try {
      const nextSeq = (selProject.phases?.length || 0) + 1
      const insert = {
        project_id: selProject.id,
        name: phaseName.trim(),
        sequence_order: nextSeq,
        permit_url: phasePermitUrl.trim() || null,
      }
      TARGET_FIELDS.forEach(f => {
        insert[f.col] = parseInt(phaseTargets[f.key]) || 0
      })

      const { data, error } = await db.from('phases').insert(insert).select().single()
      if (error) throw error

      const newPhase = { ...data, tasks: [] }
      setProjects(prev => prev.map(p => {
        if (p.id !== selProject.id) return p
        const updated = { ...p, phases: [...(p.phases || []), newPhase] }
        setSelProject(updated)
        return updated
      }))

      setPhaseName('')
      setPhaseTargets({})
      setPhasePermitUrl('')
      setShowAddPhase(false)
      showToast(`Phase added: ${data.name}`)
    } catch (e) {
      showToast('Failed: ' + e.message)
    } finally {
      setPhaseSaving(false)
    }
  }

  async function handleAddProject() {
    if (!projName.trim()) return
    setProjSaving(true)
    try {
      const insert = {
        name: projName.trim(),
        region: projRegion.trim() || projName.trim(),
        status: 'active',
      }
      PROJECT_TARGET_FIELDS.forEach(f => { insert[f.key] = parseInt(projTargets[f.key]) || 0 })
      const { data, error } = await db.from('projects').insert(insert).select().single()
      if (error) throw error

      setProjects(prev => [...prev, { ...data, fiber: data.total_fiber_ft, conduit: data.total_conduit_ft, phases: [] }])
      setProjName(''); setProjRegion(''); setProjFiber(''); setProjTargets({})
      setShowAddProject(false)
      showToast(`Project created: ${data.name}`)
    } catch (e) {
      showToast('Failed: ' + e.message)
    } finally {
      setProjSaving(false)
    }
  }

  async function savePermitUrl() {
    setPermitSaving(true)
    try {
      const url = editPermitVal.trim() || null
      await db.from('phases').update({ permit_url: url }).eq('id', selPhase.id)

      const updatedPhase = { ...selPhase, permit_url: url }
      setSelPhase(updatedPhase)
      setProjects(prev => prev.map(p => {
        if (p.id !== selProject?.id) return p
        const updatedPhases = p.phases.map(ph => ph.id === selPhase.id ? updatedPhase : ph)
        const updated = { ...p, phases: updatedPhases }
        setSelProject(updated)
        return updated
      }))

      setEditingPermit(false)
      showToast('Permit link updated')
    } catch(e) {
      showToast('Update failed: ' + e.message)
    } finally {
      setPermitSaving(false)
    }
  }

  async function saveTarget(phase, field) {
    setEditSaving(true)
    try {
      const val = parseInt(editVal) || 0
      await db.from('phases').update({ [field.col]: val }).eq('id', phase.id)

      // Update local state
      setProjects(prev => prev.map(p => {
        if (p.id !== selProject?.id) return p
        const updatedPhases = p.phases.map(ph =>
          ph.id === phase.id ? { ...ph, [field.col]: val } : ph
        )
        const updated = { ...p, phases: updatedPhases }
        setSelProject(updated)
        if (selPhase?.id === phase.id) setSelPhase({ ...selPhase, [field.col]: val })
        return updated
      }))

      setEditingTarget(null)
      showToast(`${field.label} target updated`)
    } catch (e) {
      showToast('Update failed: ' + e.message)
    } finally {
      setEditSaving(false)
    }
  }

  async function saveProjectTarget(field) {
    setEditProjSaving(true)
    try {
      const val = parseInt(editProjVal) || 0
      await db.from('projects').update({ [field.key]: val }).eq('id', selProject.id)
      const updated = { ...selProject, [field.key]: val }
      setSelProject(updated)
      setProjects(prev => prev.map(p => p.id === selProject.id ? { ...p, [field.key]: val } : p))
      setEditingProjTarget(null)
      showToast(`${field.label} target updated`)
    } catch(e) {
      showToast('Update failed: ' + e.message)
    } finally {
      setEditProjSaving(false)
    }
  }

  // Phase detail view
  if (selPhase && selProject) {
    const done = selPhase.tasks?.filter(t => t.status === 'done' || t.status === 'approved').length || 0
    const total = selPhase.tasks?.length || 0

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setSelPhase(null)} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 800, fontSize: 17 }}>{selPhase.name}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{selProject.name}</div>
            </div>
            {selPhase.permit_url && (
              <a
                href={selPhase.permit_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px', background: 'var(--orange)', color: 'white',
                  borderRadius: 20, fontSize: 12, fontWeight: 700,
                  textDecoration: 'none', flexShrink: 0,
                }}>
                <Icon name="clipboard" size={13} /> Permit
              </a>
            )}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>

          {/* Permit URL row */}
          <div style={{
            background: 'var(--surface)', border: `1px solid ${editingPermit ? 'var(--orange)' : 'var(--border)'}`,
            borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 14,
            display: 'flex', alignItems: 'center', gap: 10
          }}>
            <span style={{ display: 'inline-flex', color: 'var(--muted)' }}><Icon name="clipboard" size={16} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 2 }}>PERMIT</div>
              {editingPermit ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="url"
                    value={editPermitVal}
                    onChange={e => setEditPermitVal(e.target.value)}
                    placeholder="https://drive.google.com/..."
                    autoFocus
                    style={{
                      flex: 1, padding: '4px 8px', background: 'var(--surface2)',
                      border: '1.5px solid var(--orange)', borderRadius: 'var(--r-xs)',
                      color: 'var(--text)', fontSize: 12, minWidth: 0,
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') savePermitUrl(); if (e.key === 'Escape') setEditingPermit(false) }}
                  />
                  <button onClick={savePermitUrl} disabled={permitSaving}
                    style={{ padding: '4px 10px', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                    {permitSaving ? '...' : 'Save'}
                  </button>
                  <button onClick={() => setEditingPermit(false)}
                    style={{ padding: '4px 8px', background: 'var(--gray-lt)', color: 'var(--muted)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 12, cursor: 'pointer', flexShrink: 0, display: 'inline-flex' }}><Icon name="x" size={12} /></button>
                </div>
              ) : selPhase.permit_url ? (
                <div style={{ fontSize: 12, color: 'var(--orange)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selPhase.permit_url}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--hint)' }}>No permit linked</div>
              )}
            </div>
            <button
              onClick={() => { setEditingPermit(true); setEditPermitVal(selPhase.permit_url || '') }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', flexShrink: 0, display: 'inline-flex' }}>
              <Icon name="edit" size={15} />
            </button>
          </div>

          <button
            onClick={() => setPhaseTargetsOpen(v => !v)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              width: '100%', marginBottom: phaseTargetsOpen ? 8 : 12,
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '4px 0', textAlign: 'left',
            }}
          >
            <div className="sec-label" style={{ margin: 0 }}>
              <span style={{
                display: 'inline-flex', transform: phaseTargetsOpen ? 'rotate(90deg)' : 'none',
                transition: 'transform .15s', marginRight: 6, color: 'var(--muted)', verticalAlign: '-2px',
              }}><Icon name="chevron-right" size={12} /></span>
              Phase targets
            </div>
            <span style={{ fontSize: 11, color: 'var(--hint)' }}>{phaseTargetsOpen ? 'tap to edit · hide' : 'show'}</span>
          </button>
          {phaseTargetsOpen && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 16 }}>
            {TARGET_FIELDS.map(field => {
              const current = selPhase[field.col] || selPhase[field.key] || 0
              const isEditing = editingTarget === `${selPhase.id}-${field.key}`
              return (
                <div key={field.key} style={{
                  background: 'var(--surface)', border: `1px solid ${isEditing ? 'var(--orange)' : 'var(--border)'}`,
                  borderRadius: 'var(--r-sm)', padding: '8px 10px'
                }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600, marginBottom: 3 }}>{field.label}</div>
                  {isEditing ? (
                    <div>
                      <input type="number" value={editVal} onChange={e => setEditVal(e.target.value)} autoFocus
                        style={{ width: '100%', padding: '3px 4px', background: 'transparent', border: 'none', color: 'var(--orange)', fontSize: 15, fontWeight: 800, outline: 'none' }}
                        onKeyDown={e => { if (e.key === 'Enter') saveTarget(selPhase, field); if (e.key === 'Escape') setEditingTarget(null) }} />
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        <button onClick={() => saveTarget(selPhase, field)} disabled={editSaving}
                          style={{ flex: 1, padding: '3px 0', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                          {editSaving ? '...' : 'Save'}
                        </button>
                        <button onClick={() => setEditingTarget(null)}
                          style={{ padding: '3px 6px', background: 'var(--gray-lt)', color: 'var(--muted)', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer', display: 'inline-flex' }}><Icon name="x" size={11} /></button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => { setEditingTarget(`${selPhase.id}-${field.key}`); setEditVal(String(current)) }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, width: '100%', textAlign: 'left' }}>
                      <div style={{ fontSize: 15, fontWeight: 800, color: current > 0 ? 'var(--orange)' : 'var(--hint)' }}>
                        {current > 0 ? current.toLocaleString() : '—'}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--hint)' }}>{field.unit}</div>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          )}

          {/* Tasks */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 8 }}>
            <div className="sec-label" style={{ margin: 0 }}>Tasks — {done} done / {total} total</div>
            <button onClick={() => setShowAddTask(true)}
              style={{ fontSize: 13, color: 'var(--orange)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>
              + Add task
            </button>
          </div>

          {(() => {
            const tasks = selPhase.tasks || []
            const openT = tasks.filter(t => t.status === 'open' || (!t.status))
            const pendingT = tasks.filter(t => t.status === 'pending')
            const approvedT = tasks.filter(t => t.status === 'approved' || t.status === 'done')

            const CreatorChip = ({ task }) => {
              const c = task.creator
              if (!c) return null
              return (
                <span className="creator-chip" title={c.name}>
                  <span className="creator-initials">{c.initials}</span>
                  <span className="creator-name">{c.name}</span>
                </span>
              )
            }

            return (
              <>
                {openT.map(t => {
                  const jt = JOB_TYPES.find(j => j.id === (t.type || t.task_type)) || JOB_TYPES[0]
                  return (
                    <div key={t.id} style={{
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
                      display: 'flex', alignItems: 'center', gap: 10
                    }}>
                      <span style={{ fontSize: 16 }}>{jt.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {t.name}
                          <CreatorChip task={t} />
                        </div>
                        {t.notes && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.notes}</div>}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'var(--gray-lt)', color: 'var(--muted)' }}>Open</span>
                      <button onClick={() => setConfirmDeleteTask(t)}
                        style={{ background: 'var(--red-lt)', border: 'none', borderRadius: 'var(--r-xs)', padding: '4px 8px', cursor: 'pointer', fontSize: 13, color: 'var(--red)' }}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )
                })}

                {pendingT.map(t => {
                  const jt = JOB_TYPES.find(j => j.id === (t.type || t.task_type)) || JOB_TYPES[0]
                  return (
                    <div key={t.id} style={{
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
                      display: 'flex', alignItems: 'center', gap: 10
                    }}>
                      <span style={{ fontSize: 16 }}>{jt.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {t.name}
                          <CreatorChip task={t} />
                        </div>
                        {t.notes && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t.notes}</div>}
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'var(--amber-lt)', color: 'var(--amber)' }}>Pending</span>
                      <button onClick={() => setConfirmDeleteTask(t)}
                        style={{ background: 'var(--red-lt)', border: 'none', borderRadius: 'var(--r-xs)', padding: '4px 8px', cursor: 'pointer', fontSize: 13, color: 'var(--red)' }}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )
                })}

                {approvedT.map(t => (
                  <div key={t.id} style={{
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
                    display: 'flex', alignItems: 'center', gap: 10, opacity: 0.6
                  }}>
                    <span style={{ display: 'inline-flex', color: 'var(--teal-mid)' }}><Icon name="check" size={14} /></span>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--muted)', flex: 1, minWidth: 0 }}>
                      {t.name}
                      <CreatorChip task={t} />
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'var(--teal-lt)', color: 'var(--teal-mid)' }}>
                      {t.status === 'approved' ? 'Approved' : 'Done'}
                    </span>
                    <button onClick={() => setConfirmDeleteTask(t)}
                      style={{ background: 'var(--red-lt)', border: 'none', borderRadius: 'var(--r-xs)', padding: '4px 8px', cursor: 'pointer', fontSize: 13, color: 'var(--red)' }}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
              </>
            )
          })()}

          {(selPhase.tasks || []).length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px 0', fontSize: 13, color: 'var(--hint)' }}>
              No tasks yet — add one above
            </div>
          )}

          {/* Delete task confirmation */}
          {confirmDeleteTask && (
            <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirmDeleteTask(null)}>
              <div className="overlay-sheet">
                <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Delete task?</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 20 }}>
                  "{confirmDeleteTask.name}" and all its logged data will be permanently removed.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDeleteTask(null)}>Cancel</button>
                  <button className="btn btn-danger" style={{ flex: 2 }} onClick={() => handleDeleteTask(confirmDeleteTask)}>
                    Delete task
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Add task overlay */}
          {showAddTask && (
            <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowAddTask(false)}>
              <div className="overlay-sheet">
                <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Add Task</div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Adding to {selPhase.name}</div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>Job type</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {JOB_TYPES.map(jt => (
                      <button key={jt.id}
                        className={`job-chip${taskJobType === jt.id ? ' selected' : ''}`}
                        onClick={() => setTaskJobType(jt.id)}>
                        {jt.icon} {jt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label>Task name / location</label>
                  <input type="text" placeholder="e.g. Elm St Poles 14–21"
                    value={taskName} onChange={e => setTaskName(e.target.value)} autoFocus />
                </div>
                <div className="field">
                  <label>Notes (optional)</label>
                  <textarea placeholder="Scope notes, special conditions..."
                    value={taskNotes} onChange={e => setTaskNotes(e.target.value)} style={{ minHeight: 56 }} />
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddTask(false)}>Cancel</button>
                  <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleAddTask}
                    disabled={taskSaving || !taskName.trim()}>
                    {taskSaving ? 'Saving...' : 'Add task'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Project detail view
  if (selProject) {
    const totalTasks = selProject.phases?.reduce((a, ph) => a + ph.tasks.length, 0) || 0
    const doneTasks = selProject.phases?.reduce((a, ph) => a + ph.tasks.filter(t => t.status === 'done' || t.status === 'approved').length, 0) || 0
    // A project is "infra-style" if it has zero phases but at least one site.
    // Drives all the conditional rendering below — swap PHASES stat → SITES,
    // hide fiber targets section, surface the Sites admin.
    const phaseCount = selProject.phases?.length || 0
    const siteCount = siteCountByProject[selProject.id] || projectSites.length || 0
    const isInfraProject = phaseCount === 0 && siteCount > 0

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '16px 20px', flexShrink: 0, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={() => setSelProject(null)} style={{ fontSize: 20, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
            <div>
              <div style={{ fontWeight: 800, fontSize: 17 }}>
                {selProject.name}
                {isInfraProject && (
                  <span style={{
                    marginLeft: 8, padding: '2px 8px', borderRadius: 20,
                    background: 'var(--teal-lt)', color: 'var(--teal-mid)',
                    fontSize: 10, fontWeight: 700, verticalAlign: 'middle',
                  }}>INFRA</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{selProject.region}</div>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>TASKS</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--orange)' }}>{doneTasks}/{totalTasks}</div>
              <div style={{ fontSize: 11, color: 'var(--hint)' }}>done</div>
            </div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 14 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>
                {isInfraProject ? 'SITES' : 'PHASES'}
              </div>
              <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--orange)' }}>
                {isInfraProject ? siteCount : phaseCount}
              </div>
              <div style={{ fontSize: 11, color: 'var(--hint)' }}>total</div>
            </div>
          </div>

          {/* Project-level fiber targets. Hidden on infra projects — those
              metrics (strand/fiber/conduit/MST/splice cases/handholes/vaults)
              are all fiber-build-specific and would just show zeros, making
              the page look like it has missing data. */}
          {!isInfraProject && (
            <>
          <div className="sec-label" style={{ marginBottom: 8 }}>Project targets — tap to edit</div>
          {PROJECT_TARGET_FIELDS.map(f => {
            const current = selProject[f.key] || 0
            const isEditing = editingProjTarget === f.key
            return (
              <div key={f.key} style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between'
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{f.unit}</div>
                </div>
                {isEditing ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="number" value={editProjVal} onChange={e => setEditProjVal(e.target.value)} autoFocus
                      style={{ width: 100, padding: '6px 10px', background: 'var(--surface2)', border: '1.5px solid var(--orange)', borderRadius: 'var(--r-xs)', color: 'var(--text)', fontSize: 16, fontWeight: 700, textAlign: 'right' }}
                      onKeyDown={e => { if (e.key === 'Enter') saveProjectTarget(f); if (e.key === 'Escape') setEditingProjTarget(null) }} />
                    <button onClick={() => saveProjectTarget(f)} disabled={editProjSaving}
                      style={{ padding: '6px 12px', background: 'var(--orange)', color: 'white', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      {editProjSaving ? '...' : 'Save'}
                    </button>
                    <button onClick={() => setEditingProjTarget(null)}
                      style={{ padding: '6px 10px', background: 'var(--gray-lt)', color: 'var(--muted)', border: 'none', borderRadius: 'var(--r-xs)', fontSize: 13, cursor: 'pointer', display: 'inline-flex' }}><Icon name="x" size={13} /></button>
                  </div>
                ) : (
                  <button onClick={() => { setEditingProjTarget(f.key); setEditProjVal(String(current)) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'right' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: current > 0 ? 'var(--orange)' : 'var(--hint)' }}>{current.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>tap to edit</div>
                  </button>
                )}
              </div>
            )
          })}
          <div style={{ marginBottom: 16 }} />
            </>
          )}

          {/* Sites section — only meaningful for infra-style projects.
              List sites + offer "Add site". Mirrors the phases-list pattern
              just below. Edit/delete is intentionally deferred; the owner
              uses InfraCrewApp + the DB if a one-off fix is needed. */}
          {isInfraProject && (() => {
            // Filter sites by search + type. Done in-render — projectSites
            // tops out at a few hundred even on Gigwave, no need to memoize.
            const q = siteQuery.trim().toLowerCase()
            const filteredSites = projectSites.filter(s => {
              if (siteTypeFilter !== 'all' && s.type !== siteTypeFilter) return false
              if (!q) return true
              return (
                s.name.toLowerCase().includes(q) ||
                (s.address || '').toLowerCase().includes(q)
              )
            })
            // Only show the type pills for types that actually exist —
            // a 100%-wireless project shouldn't carry a "Fiber" tab.
            const availableTypes = Array.from(new Set(projectSites.map(s => s.type)))
            return (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div className="sec-label" style={{ margin: 0 }}>
                    Sites
                    <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--hint)', fontWeight: 600 }}>
                      {filteredSites.length}{filteredSites.length !== projectSites.length ? ` of ${projectSites.length}` : ''}
                    </span>
                  </div>
                  <button onClick={() => setShowAddSite(true)}
                    style={{ fontSize: 13, color: 'var(--orange)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>
                    + Add site
                  </button>
                </div>

                {/* Search + type filter — only render when there's enough
                    sites to make scrolling annoying. Below ~8 the list is
                    fine raw. */}
                {projectSites.length >= 8 && (
                  <div style={{ marginBottom: 10 }}>
                    <input type="text" value={siteQuery}
                      onChange={e => setSiteQuery(e.target.value)}
                      placeholder="Search sites by name or address"
                      autoComplete="off" name="site-filter"
                      style={{
                        width: '100%', padding: '8px 12px', fontSize: 13,
                        background: 'var(--surface2)', color: 'var(--text)',
                        border: '1.5px solid var(--border2)', borderRadius: 8,
                        boxSizing: 'border-box',
                      }} />
                    {availableTypes.length > 1 && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {['all', ...availableTypes].map(tval => (
                          <button key={tval} onClick={() => setSiteTypeFilter(tval)}
                            style={{
                              padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                              background: siteTypeFilter === tval ? 'var(--orange)' : 'var(--gray-lt)',
                              color: siteTypeFilter === tval ? 'white' : 'var(--muted)',
                              border: 'none', cursor: 'pointer',
                            }}>
                            {tval === 'all' ? 'All' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name={tval === 'wireless' ? 'pin' : 'warehouse'} size={12} /> {tval === 'wireless' ? 'Wireless' : 'Fiber'}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {sitesLoading && (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--muted)', fontSize: 12 }}>Loading sites…</div>
                )}
                {!sitesLoading && projectSites.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--hint)', fontSize: 12 }}>No sites yet — tap “+ Add site” above.</div>
                )}
                {!sitesLoading && projectSites.length > 0 && filteredSites.length === 0 && (
                  <div style={{ textAlign: 'center', padding: 16, color: 'var(--hint)', fontSize: 12 }}>No sites match the filter.</div>
                )}
                {!sitesLoading && filteredSites.map(s => {
                  const taskCount = siteTaskCounts[s.id] || 0
                  return (
                    <div key={s.id} onClick={() => openEditSite(s)}
                      style={{
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 'var(--r-sm)', padding: '10px 14px', marginBottom: 6,
                        display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                      }}>
                      <span style={{ display: 'inline-flex', color: 'var(--accent-dk)' }}><Icon name={s.type === 'wireless' ? 'pin' : 'warehouse'} size={16} /></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {s.name}
                        </div>
                        {s.address && (
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {s.address}
                          </div>
                        )}
                      </div>
                      {taskCount > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                          background: 'var(--orange-lt)', color: 'var(--orange)',
                        }}>
                          {taskCount} task{taskCount === 1 ? '' : 's'}
                        </span>
                      )}
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                        background: s.type === 'wireless' ? 'var(--blue-lt)' : 'var(--teal-lt)',
                        color: s.type === 'wireless' ? 'var(--blue)' : 'var(--teal-mid)',
                      }}>
                        {s.type}
                      </span>
                      <span style={{ fontSize: 14, color: 'var(--hint)' }}>›</span>
                    </div>
                  )
                })}
                <div style={{ marginBottom: 16 }} />
              </>
            )
          })()}

          {/* Phases section. Hidden entirely on infra projects (where the
              Sites section above takes its place). The fiber crews still
              get the standard phases UI. */}
          {!isInfraProject && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div className="sec-label" style={{ margin: 0 }}>Phases — tap to edit targets</div>
            <button onClick={() => setShowAddPhase(true)}
              style={{ fontSize: 13, color: 'var(--orange)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer' }}>
              + Add phase
            </button>
          </div>
          )}

          {!isInfraProject && (selProject.phases || []).map(ph => {
            const done = ph.tasks.filter(t => t.status === 'done' || t.status === 'approved').length
            const total = ph.tasks.length
            const pct = total > 0 ? Math.round(done / total * 100) : 0
            const hasTargets = TARGET_FIELDS.some(f => (ph[f.col] || ph[f.key] || 0) > 0)

            return (
              <div key={ph.id}
                onClick={() => setSelPhase(ph)}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 700 }}>{ph.name}</span>
                      {ph.permit_url && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: 'var(--orange)', color: 'white' }}>
                          <Icon name="clipboard" size={10} /> Permit
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {done}/{total} tasks
                      {hasTargets && (
                        <span style={{ marginLeft: 8, color: 'var(--hint)' }}>
                          {TARGET_FIELDS.filter(f => (ph[f.col] || ph[f.key] || 0) > 0).map(f =>
                            `${(ph[f.col] || ph[f.key] || 0).toLocaleString()} ${f.unit} ${f.label}`
                          ).join(' · ')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 12 }}>
                    <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--orange)' }}>{pct}%</div>
                    <span style={{ fontSize: 16, color: 'var(--muted)' }}>›</span>
                  </div>
                </div>
                <div className="prog-bar" style={{ marginTop: 8 }}>
                  <div className="prog-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}

          {!isInfraProject && (!selProject.phases || selProject.phases.length === 0) && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--hint)', fontSize: 13 }}>No phases yet — add one above</div>
          )}
        </div>

        {showAddSite && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowAddSite(false)}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Add Site</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Adding to {selProject.name}</div>

              <div className="field">
                <label>Site name</label>
                <input type="text" placeholder="e.g. Alexis Tower, Spruces MDU"
                  value={siteName} onChange={e => setSiteName(e.target.value)}
                  autoFocus autoComplete="off" name="new-site-name" />
              </div>

              <div className="field">
                <label>Type</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {SITE_TYPES.map(st => (
                    <button key={st.id} onClick={() => setSiteType(st.id)}
                      style={{
                        flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                        background: siteType === st.id ? 'var(--orange)' : 'var(--gray-lt)',
                        color: siteType === st.id ? 'white' : 'var(--muted)',
                        border: 'none', cursor: 'pointer',
                      }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}><Icon name={st.iconName} size={14} /> {st.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Address (optional)</label>
                <input type="text" placeholder="Street, city"
                  value={siteAddress} onChange={e => setSiteAddress(e.target.value)}
                  autoComplete="off" name="new-site-address" />
              </div>

              <div className="field">
                <label>Notes (optional)</label>
                <textarea rows={2} placeholder="Tower height, access notes, etc."
                  value={siteNotes} onChange={e => setSiteNotes(e.target.value)} />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }}
                  onClick={() => setShowAddSite(false)} disabled={siteSaving}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 2 }}
                  onClick={handleAddSite} disabled={siteSaving || !siteName.trim()}>
                  {siteSaving ? 'Adding…' : 'Add site'}
                </button>
              </div>
            </div>
          </div>
        )}

        {editSite && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setEditSite(null)}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Edit Site</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
                {selProject.name} · {(siteTaskCounts[editSite.id] || 0)} task{(siteTaskCounts[editSite.id] || 0) === 1 ? '' : 's'}
              </div>

              <div className="field">
                <label>Site name</label>
                <input type="text" value={editSiteName}
                  onChange={e => setEditSiteName(e.target.value)}
                  autoFocus autoComplete="off" name="edit-site-name" />
              </div>

              <div className="field">
                <label>Type</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {SITE_TYPES.map(st => (
                    <button key={st.id} onClick={() => setEditSiteType(st.id)}
                      style={{
                        flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                        background: editSiteType === st.id ? 'var(--orange)' : 'var(--gray-lt)',
                        color: editSiteType === st.id ? 'white' : 'var(--muted)',
                        border: 'none', cursor: 'pointer',
                      }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}><Icon name={st.iconName} size={14} /> {st.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>Address (optional)</label>
                <input type="text" value={editSiteAddress}
                  onChange={e => setEditSiteAddress(e.target.value)}
                  autoComplete="off" name="edit-site-address" />
              </div>

              <div className="field">
                <label>Notes (optional)</label>
                <textarea rows={2} value={editSiteNotes}
                  onChange={e => setEditSiteNotes(e.target.value)} />
              </div>

              {/* Project picker — lets the manager fix mis-assigned sites
                  (e.g. Prestige II) without dropping to SQL. Also useful if
                  a site genuinely moves between projects. */}
              <div className="field">
                <label>Project</label>
                <select value={editSiteProjectId}
                  onChange={e => setEditSiteProjectId(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 10px', fontSize: 13,
                    background: 'var(--surface2)', color: 'var(--text)',
                    border: '1.5px solid var(--border2)', borderRadius: 8,
                  }}>
                  <option value="">— Unassigned —</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                {editSiteProjectId !== (editSite.project_id || '') && (
                  <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>
                    ⤳ Will move to {projects.find(p => p.id === editSiteProjectId)?.name || 'Unassigned'} on save.
                  </div>
                )}
              </div>

              {/* Read-only drilldowns — useful before deciding to
                  decommission or recover materials. */}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, marginBottom: 12 }}>
                <button
                  onClick={() => openSiteTasks(editSite)}
                  style={{
                    flex: 1, padding: '8px 10px',
                    background: 'var(--surface2)', color: 'var(--text)',
                    border: '1px solid var(--border2)', borderRadius: 8,
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}>
                  <Icon name="clipboard" size={14} /> View tasks ({siteTaskCounts[editSite.id] || 0})
                </button>
                <button
                  onClick={() => openSiteMaterials(editSite)}
                  style={{
                    flex: 1, padding: '8px 10px',
                    background: 'var(--surface2)', color: 'var(--text)',
                    border: '1px solid var(--border2)', borderRadius: 8,
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  }}>
                  <Icon name="box" size={14} /> View materials
                </button>
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }}
                  onClick={() => setEditSite(null)} disabled={editSiteSaving}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 2 }}
                  onClick={handleEditSite} disabled={editSiteSaving || !editSiteName.trim()}>
                  {editSiteSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>

              {/* Decommission lives under a thin divider — keeps it
                  recoverable but visually distinct from "Save changes"
                  so the manager doesn't fat-finger it. Hard-delete is
                  intentionally NOT offered because sites are FK targets
                  for tasks; decommission flips status='decommissioned'
                  and the UI filters them out everywhere.
                  Owner-only: managers can edit attrs + move to project,
                  but retiring a location is owner-gated since it removes
                  it from every UI list system-wide. */}
              {currentUser?.role === 'owner' && (
                <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
                  <button
                    onClick={() => setConfirmDecommSite(editSite)}
                    disabled={editSiteSaving}
                    style={{
                      width: '100%', padding: '8px 12px',
                      background: 'none', border: '1px solid var(--red)',
                      color: 'var(--red)', borderRadius: 8,
                      fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    }}>
                    ⊘ Decommission site
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {siteTasksModal && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setSiteTasksModal(null)}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Tasks at site</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
                {siteTasksModal.siteName}
              </div>
              {siteTasksModal.loading && (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
              )}
              {!siteTasksModal.loading && siteTasksModal.rows.length === 0 && (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--hint)', fontSize: 13 }}>
                  No tasks at this site yet.
                </div>
              )}
              {!siteTasksModal.loading && siteTasksModal.rows.map(t => (
                <div key={t.id} style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', padding: '10px 12px', marginBottom: 6,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t.name}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--hint)', marginTop: 2 }}>
                      {t.task_type || 'task'}{t.creator?.name ? ` · ${t.creator.name}` : ''} · {new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                    background:
                      t.status === 'approved' ? 'var(--teal-lt)' :
                      t.status === 'pending'  ? 'var(--amber-lt)' :
                      t.status === 'done'     ? 'var(--gray-lt)'  :
                                                'var(--orange-lt)',
                    color:
                      t.status === 'approved' ? 'var(--teal-mid)' :
                      t.status === 'pending'  ? 'var(--amber)'    :
                      t.status === 'done'     ? 'var(--muted)'    :
                                                'var(--orange)',
                  }}>
                    {t.status}
                  </span>
                </div>
              ))}
              <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12 }}
                onClick={() => setSiteTasksModal(null)}>Close</button>
            </div>
          </div>
        )}

        {siteMaterialsModal && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setSiteMaterialsModal(null)}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Materials at site</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14 }}>
                {siteMaterialsModal.siteName} · summed across all tasks
              </div>
              {siteMaterialsModal.loading && (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
              )}
              {!siteMaterialsModal.loading && siteMaterialsModal.rows.length === 0 && (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--hint)', fontSize: 13 }}>
                  No materials consumed at this site yet.
                </div>
              )}
              {!siteMaterialsModal.loading && siteMaterialsModal.rows.length > 0 && (
                <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)' }}>
                  {siteMaterialsModal.rows.map((p, i) => (
                    <div key={p.partId} style={{
                      display: 'flex', alignItems: 'center', padding: '9px 12px',
                      borderBottom: i < siteMaterialsModal.rows.length - 1 ? '1px solid var(--border)' : 'none',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {p.name}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>{p.partId}</div>
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--orange)', flexShrink: 0, marginLeft: 8 }}>
                        {p.qty.toLocaleString()} <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{p.unit}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!siteMaterialsModal.loading && siteMaterialsModal.rows.length > 0 && (
                <div style={{
                  marginTop: 12, padding: '8px 10px',
                  background: 'var(--gray-lt)', color: 'var(--muted)',
                  fontSize: 11, borderRadius: 'var(--r-xs)',
                }}>
                  💡 To physically recover any of this, log it via <strong>Inventory → Receive PO</strong> with a note like <em>“Site recovery”</em>.
                </div>
              )}
              <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12 }}
                onClick={() => setSiteMaterialsModal(null)}>Close</button>
            </div>
          </div>
        )}

        {confirmDecommSite && (() => {
          const selectedItems = Object.values(decommSelectedParts).filter(v => v.selected && v.qty > 0)
          const recoveryCount = selectedItems.length
          const allSelected = decommMaterials.length > 0
            && decommMaterials.every(m => decommSelectedParts[m.partId]?.selected)
          return (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setConfirmDecommSite(null)}>
            <div className="overlay-sheet" style={{ maxWidth: 560 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <div style={{ fontSize: 24 }}>⊘</div>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17 }}>Decommission <strong>{confirmDecommSite.name}</strong>?</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    Site disappears from the UI. Task history stays linked for the audit trail.
                  </div>
                </div>
              </div>

              {/* Materials section — what was consumed at this site (from
                  the project bucket via auto-deduct). Owner picks which
                  to physically recover; nothing selected = pure
                  decommission, no movements written. */}
              <div className="sec-label" style={{ marginTop: 16, marginBottom: 6 }}>
                Recover materials? <span style={{ color: 'var(--hint)', fontWeight: 600, marginLeft: 6 }}>(optional)</span>
              </div>

              {decommLoading && (
                <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)', fontSize: 13 }}>Loading materials…</div>
              )}

              {!decommLoading && decommMaterials.length === 0 && (
                <div style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', padding: 14, textAlign: 'center',
                  color: 'var(--hint)', fontSize: 12, marginBottom: 12,
                }}>
                  No materials consumed at this site — nothing to recover.
                </div>
              )}

              {!decommLoading && decommMaterials.length > 0 && (
                <>
                  {/* Select all / none toggle */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <button
                      onClick={() => selectAllDecommParts(!allSelected)}
                      style={{
                        fontSize: 11, fontWeight: 700, padding: '4px 10px',
                        background: 'var(--surface2)', color: 'var(--teal-mid)',
                        border: '1.5px solid var(--teal)', borderRadius: 999, cursor: 'pointer',
                      }}>
                      {allSelected ? '☐ Deselect all' : '☑ Select all'}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--hint)', alignSelf: 'center' }}>
                      {recoveryCount} of {decommMaterials.length} selected
                    </span>
                  </div>

                  {/* Materials list — checkbox + name + qty input. The qty
                      pre-fills with the consumed total; user can dial it
                      down for partial recovery. */}
                  <div style={{
                    border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
                    maxHeight: 240, overflowY: 'auto', marginBottom: 10,
                  }}>
                    {decommMaterials.map((m, i) => {
                      const sel = decommSelectedParts[m.partId] || {}
                      return (
                        <div key={m.partId} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 12px',
                          borderBottom: i < decommMaterials.length - 1 ? '1px solid var(--border)' : 'none',
                          background: sel.selected ? 'var(--teal-lt)' : 'transparent',
                        }}>
                          <input
                            type="checkbox"
                            checked={sel.selected || false}
                            onChange={() => toggleDecommPart(m.partId)}
                            style={{ flexShrink: 0, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {m.name}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--hint)', fontFamily: 'monospace' }}>
                              {m.partId} · consumed {m.qty.toLocaleString()} {m.unit}
                            </div>
                          </div>
                          <input
                            type="number"
                            min={0}
                            max={m.qty}
                            value={sel.qty ?? m.qty}
                            disabled={!sel.selected}
                            onChange={e => setDecommPartQty(m.partId, e.target.value)}
                            style={{
                              width: 70, padding: '4px 8px', textAlign: 'right',
                              fontSize: 13, fontWeight: 700,
                              background: sel.selected ? 'var(--bg)' : 'var(--gray-lt)',
                              color: sel.selected ? 'var(--orange)' : 'var(--hint)',
                              border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
                            }}
                          />
                          <span style={{ fontSize: 11, color: 'var(--muted)', width: 28 }}>{m.unit}</span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Destination dropdown — only required when at least
                      one part is selected. Greyed when no selection. */}
                  <div className="field">
                    <label>Move recovered parts to</label>
                    <select
                      value={decommDestinationId}
                      onChange={e => setDecommDestinationId(e.target.value)}
                      disabled={recoveryCount === 0}
                      style={{
                        width: '100%', padding: '8px 10px', fontSize: 13,
                        background: recoveryCount === 0 ? 'var(--gray-lt)' : 'var(--surface2)',
                        color: recoveryCount === 0 ? 'var(--hint)' : 'var(--text)',
                        border: '1.5px solid var(--border2)', borderRadius: 8,
                      }}>
                      <option value="">— Pick a warehouse —</option>
                      {decommDestinations.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}

              <div style={{
                fontSize: 11, color: 'var(--hint)',
                background: 'var(--gray-lt)',
                borderRadius: 'var(--r-xs)', padding: '8px 10px',
                marginBottom: 16,
              }}>
                💡 Most decommissions are accounting-only — gear stays at the site, we just stop servicing it. Only pick materials to recover if you're physically pulling them back.
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }}
                  onClick={() => setConfirmDecommSite(null)} disabled={editSiteSaving}>Cancel</button>
                <button className="btn btn-danger" style={{ flex: 2 }}
                  onClick={handleDecommissionSite}
                  disabled={editSiteSaving || decommLoading || (recoveryCount > 0 && !decommDestinationId)}>
                  {editSiteSaving
                    ? 'Working…'
                    : recoveryCount > 0
                      ? `Recover ${recoveryCount} part${recoveryCount === 1 ? '' : 's'} + Decommission`
                      : 'Decommission only'}
                </button>
              </div>
            </div>
          </div>
          )
        })()}

        {showAddPhase && (
          <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowAddPhase(false)}>
            <div className="overlay-sheet">
              <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>Add Phase</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Adding to {selProject.name}</div>

              <div className="field">
                <label>Phase name</label>
                <input type="text" placeholder="e.g. Elk Ridge Greenfield 2026" value={phaseName}
                  onChange={e => setPhaseName(e.target.value)} autoFocus />
              </div>

              <div className="field">
                <label>Permit URL (optional)</label>
                <input type="url" placeholder="https://drive.google.com/..."
                  value={phasePermitUrl} onChange={e => setPhasePermitUrl(e.target.value)} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {TARGET_FIELDS.map(f => (
                  <div className="field" key={f.key}>
                    <label>{f.label} target ({f.unit})</label>
                    <input type="number" placeholder="0"
                      value={phaseTargets[f.key] || ''}
                      onChange={e => setPhaseTargets(prev => ({ ...prev, [f.key]: e.target.value }))} />
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddPhase(false)}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleAddPhase}
                  disabled={phaseSaving || !phaseName.trim()}>
                  {phaseSaving ? 'Saving...' : 'Add phase'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Project list
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 20px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Projects</div>
          <button className="btn btn-primary" onClick={() => setShowAddProject(true)}
            style={{ height: 34, padding: '0 14px', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon name="plus" size={15} /> New project
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
        {projects.map(p => {
          const totalTasks = p.phases?.reduce((a, ph) => a + ph.tasks.length, 0) || 0
          const doneTasks = p.phases?.reduce((a, ph) => a + ph.tasks.filter(t => t.status === 'done' || t.status === 'approved').length, 0) || 0
          const pct = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0
          const siteCount = siteCountByProject[p.id] || 0
          // Build the count line conditionally — for an infra-only project
          // showing "0 phases" is more confusing than helpful. If there are
          // no phases but sites exist, only show the sites + tasks lines.
          const phaseCount = p.phases?.length || 0
          const parts = []
          if (phaseCount > 0 || siteCount === 0) parts.push(`${phaseCount} phase${phaseCount === 1 ? '' : 's'}`)
          if (siteCount > 0) parts.push(`${siteCount} site${siteCount === 1 ? '' : 's'}`)
          parts.push(`${totalTasks} task${totalTasks === 1 ? '' : 's'}`)

          return (
            <div key={p.id} onClick={() => setSelProject(p)}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 16, marginBottom: 10, cursor: 'pointer', boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {p.name}
                    {siteCount > 0 && phaseCount === 0 && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 6,
                        background: 'var(--accent-lt)', color: 'var(--accent-dk)',
                        fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
                      }}>INFRA</span>
                    )}
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--hint)', marginTop: 3 }}>
                    {parts.join(' · ')}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--accent-dk)' }}>{pct}%</div>
                  <Icon name="chevron-right" size={18} color="var(--hint)" />
                </div>
              </div>
              <div className="prog-bar">
                <div className="prog-fill" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>

      {showAddProject && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowAddProject(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>New Project</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>Add a new market or build area</div>

            <div className="field">
              <label>Project name</label>
              <input type="text" placeholder="e.g. Spanish Fork, Saratoga Springs" value={projName} onChange={e => setProjName(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label>Region</label>
              <input type="text" placeholder="e.g. Utah Valley, Wasatch Front" value={projRegion} onChange={e => setProjRegion(e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {PROJECT_TARGET_FIELDS.map(f => (
                <div className="field" key={f.key}>
                  <label>{f.label} target ({f.unit})</label>
                  <input type="number" placeholder="0"
                    value={projTargets[f.key] || ''}
                    onChange={e => setProjTargets(prev => ({ ...prev, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShowAddProject(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleAddProject}
                disabled={projSaving || !projName.trim()}>
                {projSaving ? 'Creating...' : 'Create project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
