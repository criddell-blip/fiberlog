// ─── Service projects: keep fix-job material out of the grant ledger ────────
//
// A BEAD project's Region bucket is the reimbursement ledger. The grant pays
// for installs, not repairs, so any Sonar job whose type names a *Fix* must
// land in the project's non-grant sibling ("<name> - Service",
// projects.service_for_project_id → the grant parent) instead.
//
// This module is the ONE place the rule lives. Both importers call
// resolveServiceRedirect(); the Projects admin uses the lookups. Pure — no
// Supabase — so the money path is unit-tested.
//
// Adjusting later:
//   • a new repair job type ("Repair") → add the word here + a test;
//   • one row → the importers' per-row pickers outrank this rule;
//   • after the fact → Reclassify (Region→Region transfer, reclass_of).

// Word-boundary match, case-insensitive. A bare substring would turn
// "Fixed Wireless Install" into a repair — see the test tripwire.
export const SERVICE_JOB_TYPE_WORDS = ['fix']

export function isServiceJobType(jobTypeRaw, words = SERVICE_JOB_TYPE_WORDS) {
  const s = String(jobTypeRaw || '')
  if (!s) return false
  return words.some(w => new RegExp(`\\b${escapeRe(w)}\\b`, 'i').test(s))
}

export function isServiceProject(project) {
  return !!project?.service_for_project_id
}

// The sibling of a grant project among AppContext-shaped projects (rows carry
// service_for_project_id via select *). Null when none, and null when the
// input is itself a Service project — no chains.
export function serviceProjectFor(projectId, projects) {
  if (!projectId || !Array.isArray(projects)) return null
  const self = projects.find(p => p?.id === projectId)
  if (self && isServiceProject(self)) return null
  return projects.find(p => p?.service_for_project_id === projectId) || null
}

// Same lookup over the importers' phase list (getPhasesWithBuckets: each phase
// embeds project {id, name, service_for_project_id} + bucket_id). Returns the
// sibling's routing phase — lowest sequence_order — or null. The phase carries
// both the bucket (phase.bucket_id) and the phase_id tag, exactly like the
// importers' own phase-driven destination.
export function servicePhaseFor(projectId, phases) {
  if (!projectId || !Array.isArray(phases)) return null
  const own = phases.find(ph => ph?.project_id === projectId)
  if (own && isServiceProject(own.project)) return null
  const candidates = phases.filter(ph => ph?.project?.service_for_project_id === projectId)
  if (candidates.length === 0) return null
  return candidates.slice().sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0))[0]
}

// Decide whether a resolved import row must be redirected to its project's
// Service sibling.
//   projectId  — the project the row resolved to (via phase / bucket)
//   jobTypeRaw — Sonar "Job Type | Name" (fiber-jobs) or the nearest job's
//                type (asset report)
//   manual     — true when a human picked this row's destination; a human
//                choice is never overridden
//   phases     — getPhasesWithBuckets() output
// Returns { redirected:false, reason } or
//         { redirected:true, projectId, projectName, bucketId, phaseId, phaseName }
//   — bucketId null means the sibling exists but has no active bucket yet;
//   callers map that to their existing 'no-project-bucket' status.
export function resolveServiceRedirect({ projectId, jobTypeRaw, manual = false, phases }) {
  if (manual) return { redirected: false, reason: 'manual' }
  if (!isServiceJobType(jobTypeRaw)) return { redirected: false, reason: 'not-service-job' }
  if (!projectId) return { redirected: false, reason: 'no-project' }
  const ph = servicePhaseFor(projectId, phases)
  if (!ph) return { redirected: false, reason: 'no-service-project' }
  return {
    redirected: true,
    projectId: ph.project_id,
    projectName: ph.project?.name || ph.project_name || '',
    bucketId: ph.bucket_id || null,
    phaseId: ph.id,
    phaseName: ph.name || '',
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
