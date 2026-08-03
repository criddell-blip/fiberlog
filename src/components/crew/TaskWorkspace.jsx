import { useState, useMemo, useEffect, useRef } from 'react'
import { useApp } from '../../AppContext'
import { startSession, saveEntry, getTaskSummary, db } from '../../lib/supabase'
import { getFootageTypePartMap } from '../../lib/inventory'
import { FIBER_COUNTS, CONDUIT_SIZES } from '../../lib/footageTypes'
import { mergePartsById } from '../../lib/shared'
import {
  sumLines, toggleLine, setLineFt as setLineFtIn, removalLosesWork,
  linesToParts, typeLabel, hasFootageLines, migrateLegacyFootage,
} from '../../lib/footageLines'
import { t } from '../../lib/i18n'
import { useBackClose } from '../../lib/backStack'
import PartSearch from './workspace/PartSearch'
import PassdownList, { fmtWhen } from './PassdownList'
import Icon from '../shared/Icon'

// Tab list is now crew-type aware. Fiber crews see the 4-tab fiber build
// strip (aerial / footage / splice / underground) — that's the original
// behavior. Infrastructure crews see a single "Infrastructure" tab because
// the fiber-build-specific entry modes (footage totals, splice cases,
// pole inventory) don't apply to tower work. Returning an array keyed off
// crew_type rather than two separate constants keeps the rendering loop
// downstream identical for both worlds.
const FIBER_TABS = (lang) => [
  { id: 'aerial',      label: t('aerialTab', lang),      icon: '🏗️' },
  { id: 'footage',     label: t('footageTab', lang),     icon: '📏' },
  { id: 'splice',      label: t('spliceTab', lang),      icon: '🔌' },
  { id: 'underground', label: t('undergroundTab', lang), icon: '⛏️' },
]
const INFRA_TABS = () => [
  { id: 'infrastructure', label: 'Infrastructure', icon: '🛠️' },
]
function getTabs(crewType, lang) {
  return crewType === 'infrastructure' ? INFRA_TABS() : FIBER_TABS(lang)
}

const POLE_IDS = ['inter-12','inter-14','inter-16','term-12','term-14','term-16']

export default function TaskWorkspace({ project, phase, task, onBack, onSubmitDone, onUserTap }) {
  const { currentUser, showToast, lang, assemblies, setTaskLocal, projects } = useApp()

  // assemblies is the { aerial: [], footage: [], splice: [], underground: [],
  // infrastructure: [], install: [] } shape from getAssemblies(). Infra is
  // included in ALL_ASSEMBLIES so the derived counts / summary code below
  // can see infra-kit usage (otherwise an infra task's working_counts would
  // contain ids the workspace doesn't know about, and totals would be wrong).
  const ASSEMBLIES = assemblies || { aerial: [], footage: [], splice: [], underground: [], infrastructure: [] }
  const ALL_ASSEMBLIES = useMemo(() => [
    ...(ASSEMBLIES.aerial || []),
    ...(ASSEMBLIES.footage || []),
    ...(ASSEMBLIES.splice || []),
    ...(ASSEMBLIES.underground || []),
    ...(ASSEMBLIES.infrastructure || []),
  ], [assemblies])

  // Default tab honors the user's crew_type — infra users land on the
  // Infrastructure tab, fiber crews land on Aerial as before.
  const defaultTab = currentUser?.crew_type === 'infrastructure' ? 'infrastructure' : 'aerial'
  const [tab, setTab] = useState(defaultTab)
  // Working counts are loaded from the task row in the DB, so they survive
  // refresh, device switch, and crew handoff. We init empty and hydrate
  // in the effect below.
  const [counts, setCounts] = useState({})
  const [sessionId, setSessionId] = useState(null)
  const [hoursWorked, setHoursWorked] = useState(8)
  const [note, setNote] = useState('')
  const [showSummary, setShowSummary] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [partQtyOverrides, setPartQtyOverrides] = useState({})
  const [extraParts, setExtraParts] = useState([])
  const [showPartSearch, setShowPartSearch] = useState(false)
  // Per-assembly footage TYPE breakdown: { [assemblyId]: [{ type, ft }] } in
  // tap order. Replaces the old scalar fiberCount + one-size-per-slot
  // conduitSizes: a crew pulls 144ct AND 288ct on the same span, and picking
  // a second chip used to silently re-point ALL the footage at the new type,
  // so the wrong cable got deducted at approval.
  //
  // counts[assemblyId] stays the AUTHORITATIVE total feet — summary, the
  // total_*_ft rollups and the +/- tally all read it. This map only says how
  // that total splits across types, so submit can consume the right SKU per
  // line. Invariant: when an assembly has >=1 line, counts[id] === sum of ft.
  const [footageLines, setFootageLines] = useState({})
  // Footage type → SKU map (fiber count / conduit size → canonical part). Lets
  // logged fiber/conduit footage consume the matching material at submit.
  // Empty until the manager maps a type; unmapped types stay footage-only.
  const [footageMap, setFootageMap] = useState({ fiber: {}, conduit: {} })
  // Tracked separately from the map: it starts empty, so "no SKU for this
  // type" is indistinguishable from "hasn't loaded yet" and the unmapped hint
  // would flash on every card mid-fetch. Set on SUCCESS only — if the fetch
  // fails we stay quiet rather than telling the crew their fiber is unmapped.
  const [footageMapLoaded, setFootageMapLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    getFootageTypePartMap()
      .then(m => { if (!cancelled) { setFootageMap(m); setFootageMapLoaded(true) } })
      .catch(e => console.warn('Footage type→part map load failed:', e))
    return () => { cancelled = true }
  }, [])

  // Project-routing override. NULL = use task's natural project. If the
  // crew picks a different project here, the submission saves the override
  // and approval routes materials to that bucket instead. Phase actuals
  // stay on the natural phase regardless — this is purely a material
  // routing override for the "this task is in the wrong project" case.
  const [projectIdOverride, setProjectIdOverride] = useState(null)
  const effectiveProjectId = projectIdOverride || project?.id || null

  // Track when the draft is loaded so we don't overwrite the DB with empty
  // state during the initial render before fetch completes
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [lastWorkedInfo, setLastWorkedInfo] = useState(null)
  const [flagInfo, setFlagInfo] = useState(null)
  // Already-submitted passdowns for this task (backlog #34). Under the
  // is_closed model the task stays open across submits, so the crew need
  // to SEE that earlier passdowns exist — otherwise a fresh blank draft
  // reads as "my work disappeared" (the exact confusion that used to make
  // crews re-create tasks). Rendered as a strip above the tabs; tapping
  // opens the full read-only list.
  const [history, setHistory] = useState(null)
  const [showHistory, setShowHistory] = useState(false)
  const saveTimeoutRef = useRef(null)

  // Back closes the history overlay first when it's open (display-only —
  // no dirty state to confirm). Registered unconditionally per Rules of
  // Hooks; depth 0 while closed.
  useBackClose(showHistory ? 1 : 0, () => setShowHistory(false))

  // task.status in the deps keeps history in sync with the flag flow — a
  // manager flagging mid-session flips status to 'open', which refetches
  // here so the flagged passdown's numbers appear in the banner below.
  useEffect(() => {
    let cancelled = false
    getTaskSummary(task.id)
      .then(data => { if (!cancelled) setHistory(data) })
      .catch(e => console.warn('Passdown history load failed:', e))
    return () => { cancelled = true }
  }, [task.id, task.status])

  // The flagged passdown's prior numbers, pulled from history rather than
  // a second query — shown in the flag banner so the crew re-enter the
  // fix from sight, not memory (the draft resets on submit by design).
  // MUST be user-scoped: history is task-wide, and on a shared/handoff
  // task a coworker's flagged passdown would otherwise render under
  // "What you submitted" — the wrong numbers to re-enter.
  const flaggedSub = flagInfo
    ? (history?.submissions || []).find(s => s.status === 'flagged' && s.user_id === currentUser?.id)
    : null

  // Restore the flagged passdown's materials into the editable draft so the
  // crew can EDIT the fix instead of re-typing every part from the banner.
  // Background: submit resets working_counts to {} (backlog #2, so the next
  // day's passdown starts clean), and a manager flag happens later — so when
  // the crew reopen a flagged task the tally is empty. The manager's flag is
  // "fix this ONE thing," not "redo the whole passdown," so an empty tally
  // reads as "all my material disappeared." We repopulate from the flagged
  // submission's parts (as "added" parts — the assembly-count breakdown wasn't
  // preserved past submit, but the materials themselves are exact), plus its
  // hours + note. The resubmit path already deletes the flagged submission and
  // writes a fresh one, so this closes the flag→fix→resubmit loop. Guarded:
  // runs ONCE per mount (key={task.id} remounts per task) and only while the
  // draft is still empty, so it never clobbers work the crew — or a coworker
  // on a shared task — already began.
  const flagRestoredRef = useRef(false)
  useEffect(() => {
    if (!draftLoaded || flagRestoredRef.current || !flaggedSub) return
    const draftHasWork =
      Object.values(counts).some(v => Number(v) > 0) ||
      extraParts.length > 0 ||
      hasFootageLines(footageLines) ||
      !!String(note).trim()
    // Even if we skip (draft already has work), mark restored so we don't
    // keep re-checking on every history refresh.
    flagRestoredRef.current = true
    if (draftHasWork) return
    const restored = (flaggedSub.parts || [])
      .filter(p => (p.partId || p.id) && Number(p.qty) > 0)
      .map(p => ({ id: p.partId || p.id, name: p.name, unit: p.unit || 'ea', qty: Number(p.qty) }))
    if (restored.length > 0) setExtraParts(restored)
    if (typeof flaggedSub.hours_worked === 'number') setHoursWorked(flaggedSub.hours_worked)
    const firstNote = (flaggedSub.notes || []).find(n => String(n || '').trim())
    if (firstNote) setNote(firstNote)
  }, [draftLoaded, flaggedSub, counts, extraParts.length, footageLines, note])

  // If this task was previously flagged by the manager, surface the reason
  // so the crew knows what to fix. Only relevant when the task is back to
  // 'open' (the flow when manager flags: submission='flagged', task reverts
  // 'pending' → 'open'). After a successful resubmit, task→'pending' and
  // this banner won't be shown.
  useEffect(() => {
    if (task.status !== 'open' || !task.id || !currentUser?.id) {
      setFlagInfo(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await db
        .from('submissions')
        .select(`
          flag_reason, reviewed_at,
          reviewer:users!submissions_reviewed_by_fkey(name, initials),
          work_sessions!inner(task_id)
        `)
        .eq('user_id', currentUser.id)
        .eq('status', 'flagged')
        .eq('work_sessions.task_id', task.id)
        .order('reviewed_at', { ascending: false })
        .limit(1)
      if (cancelled) return
      if (error) {
        console.warn('Flag info load failed:', error)
        return
      }
      if (data && data.length > 0) {
        setFlagInfo({
          reason: data[0].flag_reason,
          managerName: data[0].reviewer?.name,
          at: data[0].reviewed_at,
        })
      } else {
        setFlagInfo(null)
      }
    })()
    return () => { cancelled = true }
  }, [task.id, task.status, currentUser?.id])

  useEffect(() => {
    if (currentUser?.id) {
      startSession(currentUser.id, task.id)
        .then(s => setSessionId(s.id))
        .catch(e => console.warn('Session:', e))
    }
  }, [currentUser?.id, task.id])

  // Load the saved working draft from the task row
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await db.from('tasks')
          .select('working_counts, last_worked_by, last_worked_at, last_user:users!tasks_last_worked_by_fkey(name, initials)')
          .eq('id', task.id)
          .single()

        if (cancelled) return

        if (error) {
          // Fall back to localStorage if the column query failed for any reason
          console.warn('Draft load failed, falling back to localStorage:', error.message)
          try {
            const saved = localStorage.getItem('fiberlog_counts_' + task.id)
            if (saved) setCounts(JSON.parse(saved))
          } catch {}
          setDraftLoaded(true)
          return
        }

        const wc = data?.working_counts || {}
        if (wc.counts) setCounts(wc.counts)
        if (wc.partQtyOverrides) setPartQtyOverrides(wc.partQtyOverrides)
        if (wc.extraParts) setExtraParts(wc.extraParts)
        // Draft-shape migration (multi-type footage, July 2026). Drafts written
        // before this shipped carry a scalar `fiberCount` + a one-size-per-slot
        // `conduitSizes`, with the feet living only in `counts`. Crews have open
        // drafts at any given moment, so fold them into a single line each —
        // dropping them would silently stop the cable deducting at approval.
        // Reads wc.counts internally, NOT the counts state — that setState
        // hasn't committed yet inside this same effect.
        const lines = migrateLegacyFootage(wc)
        if (Object.keys(lines).length > 0) setFootageLines(lines)
        if (wc.note) setNote(wc.note)
        if (typeof wc.hoursWorked === 'number') setHoursWorked(wc.hoursWorked)
        // Project-routing override (Flavor A). Persisted in working_counts so
        // the picker state survives refresh / handoff like everything else.
        if (wc.projectIdOverride) setProjectIdOverride(wc.projectIdOverride)

        // Show "continued from X" indicator if someone else worked on this task
        if (data.last_worked_by && data.last_worked_by !== currentUser?.id && data.last_user) {
          // Does the coworker's draft actually contain anything? Tasks are
          // shared by design (handoffs, multi-crew passdowns), but the
          // working draft is per-TASK not per-person — continuing here
          // edits THEIR unsaved work. An empty draft is just a trail
          // (they opened it and left); a non-empty one deserves an
          // explicit opt-in so nobody wanders into a coworker's day by
          // accident (July 2026, Chris's call: shared + warning).
          // Reads the RAW wc, before the shape migration above, so it has to
          // understand both. Note the legacy scalar fiberCount was never
          // checked here at all — a coworker's fiber pick could be clobbered
          // with no warning. Fixed in passing.
          const draftHasWork =
            (wc.counts && Object.values(wc.counts).some(v => Number(v) > 0)) ||
            (wc.extraParts && wc.extraParts.length > 0) ||
            hasFootageLines(wc.footageLines) ||
            !!String(wc.fiberCount || '').trim() ||
            (wc.conduitSizes && Object.values(wc.conduitSizes).some(v => String(v || '').trim() !== '')) ||
            !!String(wc.note || '').trim()
          setLastWorkedInfo({
            name: data.last_user.name,
            initials: data.last_user.initials,
            at: data.last_worked_at,
            hasWork: draftHasWork,
          })
          if (draftHasWork) {
            const ok = window.confirm(
              lang === 'es'
                ? `Esta tarea tiene trabajo SIN ENVIAR de ${data.last_user.name}. Si continúas aquí, editas SU borrador.\n\n¿Continuar?`
                : `This task has UNSUBMITTED work by ${data.last_user.name}. Continuing here edits THEIR draft.\n\nContinue?`
            )
            if (!ok) { onBack(); return }
          }
        }

        setDraftLoaded(true)
      } catch (e) {
        console.warn('Draft load error:', e)
        setDraftLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [task.id, currentUser?.id])

  // Auto-save the working draft whenever relevant state changes (debounced 800ms)
  useEffect(() => {
    if (!draftLoaded || !currentUser?.id) return
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(async () => {
      const draft = {
        counts, partQtyOverrides, extraParts, footageLines, note, hoursWorked, projectIdOverride,
        // Legacy mirror, ONE RELEASE ONLY. Deploys go straight to ~20 live
        // users; a rollback to the previous bundle would read footageLines it
        // doesn't understand and blank every crew's type pick mid-day. Old
        // code reading these gets the first type + the full counts total —
        // exactly its old behavior. Delete once this has been live a week.
        fiberCount: (footageLines['fiber-ft'] || [])[0]?.type || '',
        conduitSizes: {
          'bore-ft': (footageLines['bore-ft'] || [])[0]?.type || '',
          'plow-ft': (footageLines['plow-ft'] || [])[0]?.type || '',
        },
      }
      try {
        const { error } = await db.from('tasks').update({
          working_counts: draft,
          last_worked_by: currentUser.id,
          last_worked_at: new Date().toISOString(),
        }).eq('id', task.id)
        if (error) console.warn('Draft save failed:', error.message)
        // Mirror counts to localStorage as a fast offline backup
        try { localStorage.setItem('fiberlog_counts_' + task.id, JSON.stringify(counts)) } catch {}
      } catch (e) {
        console.warn('Draft save error:', e)
      }
    }, 800)
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current) }
  }, [counts, partQtyOverrides, extraParts, footageLines, note, hoursWorked, projectIdOverride, task.id, currentUser?.id, draftLoaded])

  function adjust(id, delta) {
    setCounts(prev => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }))
  }

  function setFootage(id, val) {
    const ft = parseFloat(val) || 0
    setCounts(prev => ({ ...prev, [id]: ft }))
    // With exactly ONE type picked the card's header input IS that line's
    // input (keeps the single-type flow identical to before multi-select), so
    // mirror it. With 2+ lines the header is read-only and derived, so this
    // never fires; with 0 lines (strand, untyped footage) it's a no-op.
    setFootageLines(prev => {
      const lines = prev[id]
      if (!lines || lines.length !== 1) return prev
      return { ...prev, [id]: [{ ...lines[0], ft }] }
    })
  }

  // THE single writer for footageLines. counts[id] must equal the sum of the
  // lines whenever any type is picked — if they drift, total_fiber_ft and the
  // consumed SKU quantities tell two different stories and inventory deducts
  // feet nobody logged, with nothing to flag it. A second writer reopens that.
  function writeLines(id, lines) {
    setFootageLines(prev => ({ ...prev, [id]: lines }))
    if (lines.length > 0) setCounts(prev => ({ ...prev, [id]: sumLines(lines) }))
  }

  function toggleFootageType(id, type) {
    const lines = footageLines[id] || []
    // Confirm only when the removal actually takes feet off the total —
    // dropping the last line merely un-types footage that stays in counts.
    if (removalLosesWork(lines, type)) {
      const ft = lines.find(l => l.type === type)?.ft || 0
      const msg = t('dropTypeConfirm', lang)
        .replace('{type}', type)
        .replace('{ft}', Number(ft).toLocaleString())
      if (!window.confirm(msg)) return
    }
    writeLines(id, toggleLine(lines, type, counts[id] || 0))
  }

  function setLineFt(id, type, val) {
    writeLines(id, setLineFtIn(footageLines[id] || [], type, val))
  }

  const allParts = useMemo(() => {
    const totals = {}
    ALL_ASSEMBLIES.forEach(asm => {
      const count = counts[asm.id] || 0
      if (!count) return
      asm.parts.forEach(p => {
        const qty = p.perFt ? count : p.qty * count
        if (!totals[p.id]) totals[p.id] = { id: p.id, name: p.name, unit: p.unit || 'ea', qty: 0 }
        totals[p.id].qty += qty
      })
    })
    return Object.values(totals)
      .filter(p => p.qty > 0 && partQtyOverrides[p.id] !== -1)
      .map(p => partQtyOverrides[p.id] !== undefined ? { ...p, qty: partQtyOverrides[p.id] } : p)
      .filter(p => p.qty > 0)
  }, [counts, partQtyOverrides, ALL_ASSEMBLIES])

  const summary = useMemo(() => {
    let strandFt = 0, fiberFt = 0, boreFt = 0, plowFt = 0, poles = 0, mstHst = 0, spliceCases = 0, handholes = 0, vaults = 0
    ALL_ASSEMBLIES.forEach(asm => {
      const count = counts[asm.id] || 0
      if (!count) return
      if (asm.id === 'strand-ft') strandFt += count
      if (asm.id === 'fiber-ft') fiberFt += count
      if (asm.id === 'bore-ft') boreFt += count
      if (asm.id === 'plow-ft') plowFt += count
      if (POLE_IDS.includes(asm.id)) poles += count
      if (asm.isMst) mstHst += count
      if (asm.isSpliceCase) spliceCases += count
      if (asm.isHandhole) handholes += count
      if (asm.isVault) vaults += count
    })
    return { strandFt, fiberFt, boreFt, plowFt, poles, mstHst, spliceCases, handholes, vaults }
  }, [counts, ALL_ASSEMBLIES])

  const totalLogged = useMemo(() => {
    return ALL_ASSEMBLIES
      .filter(asm => !asm.isFootage)
      .reduce((a, asm) => a + (counts[asm.id] || 0), 0)
  }, [counts, ALL_ASSEMBLIES])

  // Material consumed from footage: resolve each picked fiber-count / conduit-
  // size + its feet into the mapped SKU (qty = that line's feet). Unmapped or
  // untyped footage produces nothing (stays a stat, as before). These are
  // merged into the submitted parts so they deduct like any other material at
  // approval — mergePartsById keys on part id, so distinct types stay distinct
  // and two types mapped to the SAME sku sum correctly.
  const footageParts = useMemo(() => linesToParts({
    assemblies: ALL_ASSEMBLIES,
    footageLines,
    footageMap,
    // Don't emit a footage SKU that's already an assembly part (e.g. if a
    // conduit size is mis-mapped to the tracer-wire SKU the bore/plow assembly
    // already derives) — that would double-count. Assembly part wins.
    assemblyPartIds: new Set(allParts.map(p => p.id)),
  }), [footageLines, footageMap, allParts, ALL_ASSEMBLIES])

  async function handleSubmit() {
    if (!currentUser?.id) { showToast(t('toastSelectUser', lang)); return }
    setSubmitting(true)

    // Cancel any pending debounced draft save so we don't race with the
    // post-submit clear below
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }

    try {
      let sid = sessionId
      if (!sid) {
        const s = await startSession(currentUser.id, task.id)
        sid = s.id
        setSessionId(sid)
      }

      // Save the new log_entry first so we know its id and can exclude it
      // from the cleanup that follows. Letting saveEntry errors propagate
      // is intentional — the entry+parts insert is atomic, so failure means
      // nothing landed and we shouldn't continue.
      //
      // Gate on (allParts OR extraParts) so a submission where the user
      // only added parts via "Add part not in list" — no assemblies tapped
      // — still creates the log_entry. Previously this gated on allParts
      // alone, which silently dropped extra-only submissions on the floor
      // (entry_parts row count was 0 even though the UI showed them in the
      // summary). Especially noticeable for infra crew since there are no
      // real infra assemblies yet, so they ALL rely on the part search.
      // Merge footage-derived material (cable/conduit) with the assembly +
      // extra parts. Dedup by id summing so a SKU appearing in two sources
      // doesn't write duplicate entry_parts rows.
      const submitParts = mergePartsById([...allParts, ...footageParts, ...extraParts])
      let newEntryId = null
      if (submitParts.length > 0) {
        const newEntry = await saveEntry(sid, currentUser.id, task.id, {
          type: 'material', qty: totalLogged,
          notes: note || null,
          parts: submitParts,
        })
        newEntryId = newEntry?.id || null
      }

      // Replace-semantics ONLY for flagged submissions (the flag→fix→
      // resubmit flow): deleting them cascades their linked log_entries
      // away (log_entries.submission_id FK, ON DELETE CASCADE). Prior
      // PENDING or approved submissions on this session are earlier
      // passdowns from the same day — under the is_closed model those are
      // additive and MUST survive. (The old code deleted pending too,
      // which silently destroyed a same-day first passdown.)
      const { error: flaggedErr } = await db
        .from('submissions')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('status', 'flagged')
        .eq('session_id', sid)
      if (flaggedErr) console.warn('Prior flagged cleanup failed:', flaggedErr)

      // Sweep UNLINKED entries for this session+task (submission_id NULL):
      // legacy pre-link rows and orphans from a crashed submit (entry saved
      // but submission insert failed — retrying lands here and dedups).
      // Entries linked to surviving submissions are never touched.
      let orphanDel = db
        .from('log_entries')
        .delete()
        .eq('session_id', sid)
        .eq('task_id', task.id)
        .is('submission_id', null)
      if (newEntryId) orphanDel = orphanDel.neq('id', newEntryId)
      const { error: orphanErr } = await orphanDel
      if (orphanErr) console.warn('Orphan log_entries cleanup failed:', orphanErr)

      const { data: newSub, error } = await db.from('submissions').insert({
        session_id: sid, user_id: currentUser.id,
        hours_worked: hoursWorked,
        total_footage: (summary.strandFt || 0) + (summary.fiberFt || 0),
        total_strand_ft: summary.strandFt || 0,
        total_fiber_ft: summary.fiberFt || 0,
        total_assemblies: totalLogged,
        total_poles: summary.poles || 0,
        total_conduit_ft: (summary.boreFt || 0) + (summary.plowFt || 0),
        total_mst_hst: summary.mstHst || 0,
        total_splice_cases: summary.spliceCases || 0,
        total_handholes: summary.handholes || 0,
        total_vaults: summary.vaults || 0,
        // Only persist the override if it differs from the task's natural
        // project. NULL means "use task→phase→project for routing."
        project_id_override:
          projectIdOverride && projectIdOverride !== project?.id
            ? projectIdOverride
            : null,
        status: 'pending',
      }).select('id').single()
      if (error) throw error

      // Link the new entry to its submission. approve_submission deducts
      // per-submission through this link (a session-scoped fallback covers
      // legacy unlinked rows), which is what lets two same-day passdowns
      // coexist without double-deducting. RLS permits updating own entries.
      if (newEntryId && newSub?.id) {
        const { error: linkErr } = await db
          .from('log_entries')
          .update({ submission_id: newSub.id })
          .eq('id', newEntryId)
        if (linkErr) console.warn('Entry→submission link failed:', linkErr)
      }

      // Submit succeeded. Mirror status='pending' (display only now — the
      // task's open/closed lifecycle is governed by is_closed, not status),
      // and RESET the working draft so the NEXT passdown starts from zero.
      // This is the backlog #2 fix for the multi-day double-count: the task
      // stays open across days, so if we kept the draft, tomorrow's passdown
      // would re-log today's counts on top of its own. Each passdown must be
      // independent. (approve_submission no longer clears the draft.)
      const { error: taskErr } = await db.from('tasks').update({
        status: 'pending',
        working_counts: {},
        last_worked_by: null,
        last_worked_at: null,
      }).eq('id', task.id)
      if (taskErr) console.error('Task status update failed:', taskErr)
      try { localStorage.removeItem('fiberlog_counts_' + task.id) } catch {}

      // Propagate to AppContext immediately so when TaskList re-mounts (after
      // the user exits this workspace) the task shows the fresh state. The
      // realtime UPDATE fires too, but the listener is in TaskList which is
      // currently unmounted — so it'd miss this event. is_closed stays false:
      // the task remains in the crew's Active list, ready for the next passdown.
      const updatedTask = {
        ...task,
        status: 'pending',
        working_counts: {},
        is_closed: false,
        updated_at: new Date().toISOString(),
      }
      setTaskLocal(project.id, phase.id, updatedTask)
      showToast(t('toastSubmitted', lang))
      onSubmitDone()
    } catch(e) {
      console.error('Submit failed:', e)
      showToast('Submit failed: ' + e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const tabAsms = ASSEMBLIES[tab] || []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar">
        <button className="back-btn" onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.5px', lineHeight: 1 }}>
            <span style={{ color: 'var(--text)' }}>Fiber</span><span style={{ color: 'var(--orange)' }}>Log</span>
          </div>
          <div className="topbar-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {task.name} · {phase.name}
          </div>
        </div>
        <button className="user-btn" onClick={onUserTap}>{currentUser?.initials || 'Me'}</button>
      </div>

      {/* Flag banner — shown when this task was previously flagged by the
          manager and is now back to 'open' awaiting resubmit. Surfaces the
          reason so the crew knows what to fix. */}
      {flagInfo && (
        <div className="banner banner-danger" style={{ alignItems: 'flex-start' }}>
          <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name="alert" size={16} /></span>
          <div className="banner-body" style={{ fontSize: 'var(--fs-xs)' }}>
            <span style={{ fontWeight: 'var(--fw-bold)' }}>
              {lang === 'es' ? 'Marcado' : 'Flagged'}
              {flagInfo.managerName ? (lang === 'es' ? ` por ${flagInfo.managerName}` : ` by ${flagInfo.managerName}`) : ''}
            </span>
            {flagInfo.reason && (
              <div style={{ marginTop: 2, fontWeight: 'var(--fw-medium)' }}>{flagInfo.reason}</div>
            )}
            {/* The flagged passdown's numbers — the draft resets on submit,
                so without this the crew would re-enter the fix from memory
                (and quietly undercount). */}
            {flaggedSub && (
              <div style={{ marginTop: 4, fontWeight: 'var(--fw-medium)', opacity: 0.9 }}>
                {lang === 'es' ? 'Lo que enviaste: ' : 'What you submitted: '}
                {(Number(flaggedSub.hours_worked) || 0).toLocaleString()} hrs
                {(flaggedSub.parts || []).length > 0 && (
                  <> · {flaggedSub.parts.slice(0, 4).map(p => `${p.qty.toLocaleString()}× ${p.name}`).join(', ')}
                  {flaggedSub.parts.length > 4 ? ` +${flaggedSub.parts.length - 4} ${lang === 'es' ? 'más' : 'more'}` : ''}</>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Submitted-passdowns strip (backlog #34) — the task stays open
          across submits, so surface what's already been turned in. Hidden
          while a flag banner is up for the SAME single passdown (the
          banner already tells that story); shown otherwise. */}
      {(history?.submissions?.length || 0) > 0 && !(flagInfo && history.submissions.length === 1) && (
        <div
          onClick={() => setShowHistory(true)}
          className="banner banner-muted"
          style={{ cursor: 'pointer', padding: '8px var(--space-4)' }}
        >
          <span className="banner-icon" style={{ display: 'inline-flex', color: 'var(--teal-mid)' }}><Icon name="check" size={14} /></span>
          <span className="banner-body" style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' }}>
            {history.submissions.length === 1
              ? (lang === 'es' ? '1 jornada enviada' : '1 passdown submitted')
              : (lang === 'es'
                  ? `${history.submissions.length} jornadas enviadas`
                  : `${history.submissions.length} passdowns submitted`)}
            {' · '}{(history.totalHours || 0).toLocaleString()} hrs
            <span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-medium)' }}>
              {' · '}{lang === 'es' ? 'última' : 'latest'} {fmtWhen(history.submissions[0].created_at, lang)}
              {/* Shared tasks: make coworkers' involvement visible at a
                  glance, not just inside the drill-in. */}
              {(() => {
                const others = [...new Set(history.submissions
                  .filter(s => s.user_id !== currentUser?.id)
                  .map(s => s.users?.name)
                  .filter(Boolean))]
                if (others.length === 0) return null
                const label = others.length === 1 ? others[0] : `${others[0]} +${others.length - 1}`
                return <> · {lang === 'es' ? 'incluye a' : 'includes'} {label}</>
              })()}
            </span>
          </span>
          <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-bold)', color: 'var(--teal-mid)' }}>
            {lang === 'es' ? 'ver ›' : 'view ›'}
          </span>
        </div>
      )}

      {/* "Continued from X" indicator — visible when picking up someone
          else's draft. AMBER when their draft holds real unsent work
          (editing here changes it — the confirm on entry already opted
          in); quiet teal when it's just an activity trail. */}
      {lastWorkedInfo && (
        <div className={`banner ${lastWorkedInfo.hasWork ? 'banner-warning' : 'banner-success'}`} style={{ padding: '6px var(--space-4)' }}>
          <span className="banner-icon" style={{ display: 'inline-flex' }}><Icon name={lastWorkedInfo.hasWork ? 'alert' : 'rotate'} size={13} /></span>
          <span className="banner-body" style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' }}>
            {lastWorkedInfo.hasWork
              ? (lang === 'es' ? `Editando el borrador SIN ENVIAR de ${lastWorkedInfo.name}` : `Editing ${lastWorkedInfo.name}'s UNSUBMITTED draft`)
              : (lang === 'es' ? `Continuando desde ${lastWorkedInfo.name}` : `Continuing from ${lastWorkedInfo.name}`)}
            {lastWorkedInfo.at && (
              <span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-medium)', marginLeft: 4 }}>
                · {new Date(lastWorkedInfo.at).toLocaleString(lang === 'es' ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
          </span>
        </div>
      )}

      {/* Project routing override (Flavor A). Lets the crew tag the work
          to a different project's bucket without moving the task itself.
          NULL = use task's natural project. Only the bucket destination
          changes; phase actuals + reports still belong to the task's
          actual phase. */}
      {projects && projects.length > 1 && (
        <div
          className={`banner ${projectIdOverride && projectIdOverride !== project?.id ? 'banner-warning' : 'banner-muted'}`}
          style={{ padding: '6px var(--space-4)' }}
        >
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', fontWeight: 'var(--fw-semibold)' }}>
            {lang === 'es' ? 'Materiales asignados a:' : 'Routing materials to:'}
          </span>
          <select
            value={projectIdOverride || project?.id || ''}
            onChange={e => {
              const picked = e.target.value
              setProjectIdOverride(picked === project?.id ? null : picked)
            }}
            style={{
              flex: 1, minWidth: 0,
              padding: '3px 6px', fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-bold)',
              border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
              background: 'var(--surface)', color: 'var(--text)',
            }}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.id === project?.id ? (lang === 'es' ? ' (predeterminado)' : ' (default)') : ''}
              </option>
            ))}
          </select>
          {projectIdOverride && projectIdOverride !== project?.id && (
            <button
              onClick={() => setProjectIdOverride(null)}
              title={lang === 'es' ? 'Restablecer' : 'Reset to default'}
              style={{
                fontSize: 10, color: 'var(--amber)', background: 'none',
                border: 'none', cursor: 'pointer', fontWeight: 'var(--fw-bold)',
                whiteSpace: 'nowrap', padding: '0 2px',
              }}
            >
<Icon name="rotate" size={11} style={{ verticalAlign: 'middle', marginRight: 2 }} /> {lang === 'es' ? 'Restablecer' : 'Reset'}
            </button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="workspace-tabs">
        {getTabs(currentUser?.crew_type, lang).map(tb => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`workspace-tab${tab === tb.id ? ' active' : ''}`}
          >
            <span className="workspace-tab-icon">{tb.icon}</span>
            {tb.label}
          </button>
        ))}
      </div>

      {/* Footage totals bar — accent-tinted banner that surfaces the running totals
          above the assembly list so the crew can see the day's footage at a glance. */}
      {(summary.strandFt > 0 || summary.fiberFt > 0 || summary.boreFt > 0 || summary.plowFt > 0) && (
        <div className="banner banner-accent" style={{ gap: 16, flexWrap: 'wrap' }}>
          {summary.strandFt > 0 && <div style={{ fontSize: 'var(--fs-sm)' }}><span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-semibold)' }}>{t('strandLabel', lang)} </span><span style={{ fontWeight: 'var(--fw-black)', color: 'var(--orange)' }}>{summary.strandFt.toLocaleString()} ft</span></div>}
          {summary.fiberFt > 0 && <div style={{ fontSize: 'var(--fs-sm)' }}><span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-semibold)' }}>{t('fiberLabel', lang)} </span><span style={{ fontWeight: 'var(--fw-black)', color: 'var(--orange)' }}>{summary.fiberFt.toLocaleString()} ft {typeLabel(footageLines['fiber-ft'])}</span></div>}
          {summary.boreFt > 0 && <div style={{ fontSize: 'var(--fs-sm)' }}><span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-semibold)' }}>{t('boreLabel', lang)} </span><span style={{ fontWeight: 'var(--fw-black)', color: 'var(--orange)' }}>{summary.boreFt.toLocaleString()} ft</span></div>}
          {summary.plowFt > 0 && <div style={{ fontSize: 'var(--fs-sm)' }}><span style={{ color: 'var(--muted)', fontWeight: 'var(--fw-semibold)' }}>{t('plowLabel', lang)} </span><span style={{ fontWeight: 'var(--fw-black)', color: 'var(--orange)' }}>{summary.plowFt.toLocaleString()} ft</span></div>}
        </div>
      )}

      {/* Assembly list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 100px' }}>
        {tabAsms.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--hint)', fontSize: 13 }}>Loading assemblies...</div>
        )}
        {tabAsms.map(asm => {
          const count = counts[asm.id] || 0
          return (
            <div key={asm.id} style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', padding: '12px 14px', marginBottom: 8,
              borderLeft: `3px solid ${count > 0 ? 'var(--orange)' : 'transparent'}`
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{asm.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{asm.sub}</div>
                </div>
                {asm.isFootage ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {/* Uses the shared .footage-input class for typography (22px, 700,
                        center) but overrides flex+width so the input stays a compact
                        box on the right side of the card instead of stretching, and
                        keeps the orange tint as the visual cue that this is the
                        editable numeric field.

                        Once a SECOND type is picked this stops being an input and
                        becomes the derived total — two editable sources for one
                        number is a divergence bug factory, and the per-type rows
                        below are the honest place to edit. One type (or none)
                        keeps the box exactly as it was. */}
                    {(footageLines[asm.id] || []).length > 1 ? (
                      <div className="footage-input" style={{
                        flex: '0 0 auto', width: 96, color: 'var(--orange)',
                        background: 'var(--surface2)', opacity: 0.85,
                      }}>{count.toLocaleString()}</div>
                    ) : (
                      <input type="number" value={count || ''} placeholder="0"
                        className="footage-input"
                        onChange={e => setFootage(asm.id, e.target.value)}
                        style={{ flex: '0 0 auto', width: 96, color: 'var(--orange)' }} />
                    )}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>ft</span>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {count > 0 && (<>
                      <button className="tally-btn tally-minus" onClick={() => adjust(asm.id, -1)}>−</button>
                      <div className="tally-count">{count}</div>
                    </>)}
                    <button className={`tally-btn ${count > 0 ? 'tally-plus' : 'tally-plus-big'}`} onClick={() => adjust(asm.id, 1)}>+</button>
                  </div>
                )}
              </div>

              {/* Fiber-count / conduit-size picker. Gated on lines too, not just
                  count: two lines both sitting at 0 ft make count 0, and with the
                  header read-only (2+ lines) an unmount here would leave the crew
                  no way to type anything at all. */}
              {(asm.isFiber || asm.isConduit) && (count > 0 || (footageLines[asm.id] || []).length > 0) && (
                <FootageTypePicker
                  asm={asm}
                  lines={footageLines[asm.id] || []}
                  total={count}
                  map={asm.isFiber ? footageMap.fiber : footageMap.conduit}
                  mapLoaded={footageMapLoaded}
                  lang={lang}
                  onToggle={type => toggleFootageType(asm.id, type)}
                  onFt={(type, val) => setLineFt(asm.id, type, val)}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Bottom bar */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderTop: '1px solid var(--border)', padding: '10px 14px 28px' }}>
        {totalLogged > 0 && (
          <div style={{ fontSize: 12, color: 'var(--orange)', fontWeight: 600, marginBottom: 8, textAlign: 'center' }}>
            {summary.poles > 0 && `${summary.poles} ${t('polesLabel', lang)} · `}
            {summary.mstHst > 0 && `${summary.mstHst} MST/HST · `}
            {summary.spliceCases > 0 && `${summary.spliceCases} cases · `}
            {allParts.length} {t('partTypes', lang)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onBack}>
            {lang === 'es' ? 'Pausar' : 'Pause'}
          </button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={() => setShowSummary(true)}>{t('wrapUpDay', lang)}</button>
        </div>
      </div>

      {/* Submitted-passdowns history overlay (backlog #34). Read-only —
          display overlay, so Back/backdrop-click close immediately with
          no dirty-confirm. Renders the same PassdownList as the closed-
          task summary so the two views can't drift. */}
      {showHistory && history && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowHistory(false)}>
          <div className="overlay-sheet" style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2, flexShrink: 0 }}>
              {lang === 'es' ? 'Jornadas enviadas' : 'Submitted passdowns'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 14, flexShrink: 0 }}>
              {task.name} · {(history.totalHours || 0).toLocaleString()} hrs {lang === 'es' ? 'en total' : 'total'}
            </div>
            <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
              <PassdownList submissions={history.submissions} />
            </div>
            <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12, flexShrink: 0 }}
              onClick={() => setShowHistory(false)}>
              {lang === 'es' ? 'Cerrar' : 'Close'}
            </button>
          </div>
        </div>
      )}

      {/* Submit summary sheet */}
      {showSummary && (
        <div className="overlay open" onClick={e => e.target === e.currentTarget && setShowSummary(false)}>
          <div className="overlay-sheet">
            <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 4 }}>{t('submitYourDay', lang)}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
              {currentUser?.name} · {new Date().toLocaleDateString(lang === 'es' ? 'es' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </div>

            <div className="metric-grid">
              {[
                summary.strandFt > 0 && { label: t('strandLabel', lang), value: `${summary.strandFt.toLocaleString()} ft` },
                summary.fiberFt > 0 && { label: t('fiberLabel', lang), value: `${summary.fiberFt.toLocaleString()} ft` },
                summary.boreFt > 0 && { label: t('boreLabel', lang), value: `${summary.boreFt.toLocaleString()} ft` },
                summary.plowFt > 0 && { label: t('plowLabel', lang), value: `${summary.plowFt.toLocaleString()} ft` },
                summary.poles > 0 && { label: t('polesLabel', lang), value: summary.poles },
                summary.mstHst > 0 && { label: 'MST/HST', value: summary.mstHst },
                summary.spliceCases > 0 && { label: 'Cases', value: summary.spliceCases },
                summary.handholes > 0 && { label: 'Handholes', value: summary.handholes },
                summary.vaults > 0 && { label: 'Vaults', value: summary.vaults },
              ].filter(Boolean).map(s => (
                <div key={s.label} className="metric">
                  <div className="metric-value mono">{s.value}</div>
                  <div className="metric-label">{s.label}</div>
                </div>
              ))}
            </div>

            {/* Footage-by-type breakdown. The metric tiles carry the totals (a
                type suffix overflowed the narrow grid cell once there could be
                several); this says what those totals are made of. It's also the
                only place a type whose SKU is unmapped — or shadowed by an
                assembly part — still shows its feet before the crew sign off. */}
            {ALL_ASSEMBLIES.some(a => (footageLines[a.id] || []).length > 0) && (
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{t('footageBreakdown', lang)}</div>
                {ALL_ASSEMBLIES.filter(a => (footageLines[a.id] || []).length > 0).map(a => (
                  <div key={a.id}>
                    {a.label}: {(footageLines[a.id] || [])
                      .map(l => `${(Number(l.ft) || 0).toLocaleString()} ft ${l.type}`).join(' · ')}
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>{t('partsAdjust', lang)}</div>
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', marginBottom: 10, maxHeight: 220, overflowY: 'auto', padding: '0 12px' }}>
              {allParts.length === 0 && footageParts.length === 0 && extraParts.length === 0 && (
                <div style={{ padding: '14px', textAlign: 'center', fontSize: 12, color: 'var(--hint)' }}>{t('noPartsLogged', lang)}</div>
              )}
              {allParts.map(p => (
                <div key={p.id} className="parts-row" style={{ gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                    <div className="part-id">{p.id}</div>
                  </div>
                  <button
                    className="tally-btn tally-sm tally-minus"
                    onClick={() => setPartQtyOverrides(prev => { const cur = prev[p.id] !== undefined ? prev[p.id] : p.qty; const next = Math.max(0, cur - 1); return next === 0 ? { ...prev, [p.id]: -1 } : { ...prev, [p.id]: next } })}
                  >−</button>
                  {/* Typed entry as well as the steppers — 250 of a part is 250
                      taps otherwise. min 0 matches the − button, which treats
                      reaching 0 as "remove this line". */}
                  <QtyInput
                    value={partQtyOverrides[p.id] !== undefined ? partQtyOverrides[p.id] : p.qty}
                    min={0}
                    onCommit={n => setPartQtyOverrides(prev => ({ ...prev, [p.id]: n === 0 ? -1 : n }))}
                  />
                  <button
                    className="tally-btn tally-sm tally-plus"
                    onClick={() => setPartQtyOverrides(prev => { const cur = prev[p.id] !== undefined ? prev[p.id] : p.qty; return { ...prev, [p.id]: cur + 1 } })}
                  >+</button>
                  <span className="part-unit" style={{ minWidth: 14 }}>{p.unit}</span>
                </div>
              ))}
              {footageParts.map(p => (
                <div
                  key={'fp-'+p.srcKey}
                  className="parts-row"
                  style={{ gap: 8, background: 'var(--accent-bg)', margin: '0 -12px', padding: '10px 12px' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="part-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {/* The type label carries "this came from footage" plus the
                          breakdown — two rows of the same SKU name are otherwise
                          indistinguishable when two types map to one part. */}
                      {p.name} <span className="pill pill-accent pill-sm" style={{ marginLeft: 4 }}>{p.srcType}</span>
                    </div>
                    <div className="part-id">{p.id}</div>
                  </div>
                  <span className="part-qty" style={{ minWidth: 28, textAlign: 'center' }}>{p.qty.toLocaleString()}</span>
                  <span className="part-unit">{p.unit}</span>
                </div>
              ))}
              {extraParts.map(p => (
                <div
                  key={'extra-'+p.id}
                  className="parts-row"
                  style={{ gap: 8, background: 'var(--accent-bg)', margin: '0 -12px', padding: '10px 12px' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="part-name">
                      {p.name} <span className="pill pill-accent pill-sm" style={{ marginLeft: 4 }}>added</span>
                    </div>
                    <div className="part-id">{p.id}</div>
                  </div>
                  <button
                    className="tally-btn tally-sm tally-minus"
                    onClick={() => setExtraParts(prev => prev.map(ep => ep.id === p.id ? { ...ep, qty: Math.max(1, ep.qty - 1) } : ep))}
                  >−</button>
                  {/* min 1 mirrors the − button's clamp: an added part is
                      removed with the × on the right, not by typing 0. */}
                  <QtyInput
                    value={p.qty}
                    min={1}
                    onCommit={n => setExtraParts(prev => prev.map(ep => ep.id === p.id ? { ...ep, qty: n } : ep))}
                  />
                  <button
                    className="tally-btn tally-sm tally-plus"
                    onClick={() => setExtraParts(prev => prev.map(ep => ep.id === p.id ? { ...ep, qty: ep.qty + 1 } : ep))}
                  >+</button>
                  <span className="part-unit" style={{ minWidth: 14 }}>{p.unit}</span>
                  <button
                    onClick={() => setExtraParts(prev => prev.filter(ep => ep.id !== p.id))}
                    className="tally-btn tally-sm"
                    style={{ background: 'var(--danger-bg)', color: 'var(--danger-fg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                  ><Icon name="x" size={14} /></button>
                </div>
              ))}
            </div>

            <button
              onClick={() => setShowPartSearch(true)}
              className="add-dashed"
              style={{ padding: 10, marginBottom: 14, fontSize: 'var(--fs-base)' }}
            >
              {t('addPartNotInList', lang)}
            </button>
            {showPartSearch && (
              <PartSearch
                onSelect={p => {
                  setExtraParts(prev => prev.some(ep => ep.id === p.id)
                    ? prev.map(ep => ep.id === p.id ? { ...ep, qty: ep.qty + 1 } : ep)
                    : [...prev, { id: p.id, name: p.name, unit: p.unit || 'ea', qty: 1 }])
                  setShowPartSearch(false)
                }}
                onClose={() => setShowPartSearch(false)}
              />
            )}

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 8 }}>{t('hoursWorked', lang)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="tally-btn tally-minus" onClick={() => setHoursWorked(h => Math.max(0, Math.round((h-.5)*2)/2))}>−</button>
                <div className="mono" style={{ fontSize: 'var(--fs-2xl)', fontWeight: 'var(--fw-black)', flex: 1, textAlign: 'center' }}>{hoursWorked.toFixed(1)}</div>
                <button className="tally-btn tally-plus" onClick={() => setHoursWorked(h => Math.min(16, Math.round((h+.5)*2)/2))}>+</button>
                <span style={{ color: 'var(--muted)' }}>hrs</span>
              </div>
            </div>

            <div className="field">
              <label>{t('noteOptional', lang)}</label>
              <textarea placeholder={t('noteplaceholder', lang)} value={note} onChange={e => setNote(e.target.value)} style={{ minHeight: 56 }} />
            </div>

            {/* Submit is permanent — the submission is the final record even
                if the task stays open for more passdowns later (backlog #2). */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 7,
              padding: '8px 10px', marginBottom: 10,
              background: 'var(--amber-lt)', color: 'var(--amber)',
              borderRadius: 'var(--r-sm)', fontSize: 12, fontWeight: 600, lineHeight: 1.4,
            }}>
              <Icon name="alert" size={14} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>{t('submitFinalNote', lang)}</span>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              {/* Close ONLY — never wipe extraParts/overrides here. "Keep
                  logging" is the designed mid-day loop; wiping silently
                  deleted hand-added parts (and the flag-restore payload) so
                  the crew resubmitted without them. Backdrop-tap already
                  just closes; both dismiss paths now agree. */}
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setShowSummary(false); setShowPartSearch(false) }}>{t('keepLogging', lang)}</button>
              <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSubmit} disabled={submitting}>
                {submitting ? t('submitting', lang) : t('submitDay', lang)}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── FOOTAGE TYPE PICKER ─────────────────────────────────────────────────────
// Multi-select chips + one feet input per selected type. With a SINGLE type
// selected there's no per-line row at all — the card's header input drives it,
// so the common case looks and behaves exactly as it did before multi-select.
// The per-line rows only appear once there's genuinely something to split.
function FootageTypePicker({ asm, lines, total, map, mapLoaded, lang, onToggle, onFt }) {
  const values = asm.isFiber ? FIBER_COUNTS : CONDUIT_SIZES
  const heading = asm.isFiber ? t('tapFiberTypes', lang) : t('tapConduitSizes', lang)
  const multi = lines.length > 1
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>{heading}</div>
      <div className="select-row" style={{ marginTop: 0 }}>
        {values.map(v => (
          <button
            key={v}
            onClick={() => onToggle(v)}
            // Chips are toggles now rather than a radio group, so they get
            // tapped a lot more. Bumped thumb target inline instead of editing
            // the shared .select-chip — FootageMapSheet renders it too.
            style={{ padding: '8px 12px' }}
            className={`select-chip${lines.some(l => l.type === v) ? ' active' : ''}`}
          >{v}</button>
        ))}
      </div>

      {multi && lines.map(l => {
        const unmapped = mapLoaded && !map?.[l.type]
        return (
          <div key={l.type} style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: '0 0 auto', minWidth: 52, fontSize: 12, fontWeight: 700, color: 'var(--orange)' }}>{l.type}</span>
              <input type="number" value={l.ft || ''} placeholder="0"
                className="footage-input"
                onChange={e => onFt(l.type, e.target.value)}
                style={{ flex: 1, minWidth: 0, fontSize: 17, padding: '6px 10px' }} />
              <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--muted)' }}>ft</span>
            </div>
            {unmapped && (
              <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, marginLeft: 60 }}>
                {t('noSkuMapped', lang)}
              </div>
            )}
          </div>
        )
      })}

      {multi && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t('totalWord', lang)}</span>
          <span className="mono" style={{ fontSize: 15, fontWeight: 'var(--fw-black)', color: 'var(--orange)' }}>
            {total.toLocaleString()} ft
          </span>
        </div>
      )}

      {/* Single-type: the original inline confirmation line, now translated —
          it was hardcoded English in front of Spanish-speaking crews. */}
      {lines.length === 1 && asm.isConduit && (
        <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 6, fontWeight: 600 }}>
          {t('conduitLineHint', lang).replace('{ft}', total.toLocaleString()).replace('{size}', lines[0].type)}
        </div>
      )}
      {lines.length === 1 && mapLoaded && !map?.[lines[0].type] && (
        <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{t('noSkuMapped', lang)}</div>
      )}
    </div>
  )
}

// typeLabel / hasFootageLines and the rest of the footage-line logic live in
// lib/footageLines.js — it's a money path (it decides which SKU leaves the
// truck), so it's extracted and unit-tested rather than inline here.

// ─── QUANTITY INPUT ──────────────────────────────────────────────────────────
// Typed quantity next to the −/+ steppers on the submit sheet. Tapping + 250
// times to log a box of connectors was the whole problem.
//
// Holds its own draft string rather than binding straight to the number,
// because both lists DROP a row at qty 0 (allParts filters `qty > 0`;
// partQtyOverrides uses -1 as the remove sentinel). Committing on every
// keystroke would make the row vanish the instant you cleared the box to
// retype — so a partial/empty entry is held locally and only resolved on blur.
function QtyInput({ value, min = 0, onCommit }) {
  const [draft, setDraft] = useState(String(value))
  // Re-sync when the steppers (or a footage edit) change the value out from
  // under us. Skipped while focused so it can't fight the user mid-type.
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(String(value)) }, [value, focused])

  return (
    <input
      type="number"
      inputMode="decimal"
      value={draft}
      onFocus={e => { setFocused(true); e.target.select() }}
      onChange={e => {
        setDraft(e.target.value)
        const n = parseFloat(e.target.value)
        // Only commit a positive number live. 0 and empty wait for blur, so
        // clearing the field doesn't delete the row under the cursor.
        if (Number.isFinite(n) && n > 0) onCommit(n)
      }}
      onBlur={() => {
        setFocused(false)
        const n = parseFloat(draft)
        if (!Number.isFinite(n)) { setDraft(String(value)); return }  // empty → leave as-was
        const next = Math.max(min, n)
        setDraft(String(next))
        onCommit(next)
      }}
      className="part-qty"
      style={{
        width: 56, minWidth: 56, textAlign: 'center', padding: '4px 2px',
        border: '1px solid var(--border2)', borderRadius: 'var(--r-xs)',
        background: 'var(--bg)', color: 'var(--text)', fontWeight: 700,
      }}
    />
  )
}
