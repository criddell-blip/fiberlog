import { describe, it, expect } from 'vitest'
import {
  isServiceJobType, isServiceProject, serviceProjectFor, servicePhaseFor, resolveServiceRedirect,
} from './serviceRouting.js'

const WM = 'wm', SVC = 'wm-svc', HEBER = 'heber'
const projects = [
  { id: WM, name: 'West Mountain', service_for_project_id: null },
  { id: SVC, name: 'West Mountain - Service', service_for_project_id: WM },
  { id: HEBER, name: 'Heber', service_for_project_id: null },
]
const phase = (id, project_id, name, sequence_order, bucket_id, project) =>
  ({ id, project_id, name, sequence_order, bucket_id, project })
const phases = [
  phase('ph-wm-1', WM, 'West Mountain Fiber', 1, 'bucket-wm', projects[0]),
  phase('ph-svc-2', SVC, 'Later', 2, 'bucket-svc', projects[1]),
  phase('ph-svc-1', SVC, 'Service', 1, 'bucket-svc', projects[1]),
  phase('ph-heber-1', HEBER, 'Lake Creek', 1, 'bucket-heber', projects[2]),
]

describe('isServiceJobType', () => {
  it('matches the word Fix anywhere in the job type, any case', () => {
    for (const t of ['Drop Fix', 'Fiber Fix', 'FIX', 'Fix - Drop', 'fix']) {
      expect(isServiceJobType(t), t).toBe(true)
    }
  })
  it('never matches "Fixed" or "Prefix" — word boundary, not substring', () => {
    for (const t of ['Fixed Wireless Install', 'Install', 'Prefix Job', 'Fiber Install with Router', '', null, undefined]) {
      expect(isServiceJobType(t), String(t)).toBe(false)
    }
  })
  it('takes an alternate word list', () => {
    expect(isServiceJobType('Repair Visit', ['fix', 'repair'])).toBe(true)
    expect(isServiceJobType('Repair Visit', ['fix'])).toBe(false)
  })
})

describe('serviceProjectFor / isServiceProject', () => {
  it('finds the sibling of a grant project', () => {
    expect(serviceProjectFor(WM, projects)?.id).toBe(SVC)
    expect(isServiceProject(projects[1])).toBe(true)
    expect(isServiceProject(projects[0])).toBe(false)
  })
  it('returns null when there is no sibling', () => {
    expect(serviceProjectFor(HEBER, projects)).toBeNull()
  })
  it('never chains — a Service project has no sibling of its own', () => {
    const chained = [...projects, { id: 'x', name: 'chain', service_for_project_id: SVC }]
    expect(serviceProjectFor(SVC, chained)).toBeNull()
  })
  it('tolerates bad input', () => {
    expect(serviceProjectFor(null, projects)).toBeNull()
    expect(serviceProjectFor(WM, null)).toBeNull()
  })
})

describe('servicePhaseFor', () => {
  it('returns the sibling phase with the lowest sequence_order', () => {
    expect(servicePhaseFor(WM, phases)?.id).toBe('ph-svc-1')
  })
  it('returns null when the project has no sibling or is itself a Service project', () => {
    expect(servicePhaseFor(HEBER, phases)).toBeNull()
    expect(servicePhaseFor(SVC, phases)).toBeNull()
  })
})

describe('resolveServiceRedirect', () => {
  it('never overrides a manual pick', () => {
    expect(resolveServiceRedirect({ projectId: WM, jobTypeRaw: 'Drop Fix', manual: true, phases }))
      .toEqual({ redirected: false, reason: 'manual' })
  })
  it('leaves non-fix jobs alone', () => {
    expect(resolveServiceRedirect({ projectId: WM, jobTypeRaw: 'Fiber Install', phases }).redirected).toBe(false)
  })
  it('redirects a fix job to the sibling bucket + phase', () => {
    expect(resolveServiceRedirect({ projectId: WM, jobTypeRaw: 'Fiber Fix', phases })).toEqual({
      redirected: true, projectId: SVC, projectName: 'West Mountain - Service',
      bucketId: 'bucket-svc', phaseId: 'ph-svc-1', phaseName: 'Service',
    })
  })
  it('reports redirected with a null bucket when the sibling has no active bucket', () => {
    const noBucket = phases.map(ph => ph.project_id === SVC ? { ...ph, bucket_id: null } : ph)
    const r = resolveServiceRedirect({ projectId: WM, jobTypeRaw: 'Drop Fix', phases: noBucket })
    expect(r.redirected).toBe(true)
    expect(r.bucketId).toBeNull()
  })
  it('does not redirect a fix job on a project with no sibling (non-grant projects)', () => {
    expect(resolveServiceRedirect({ projectId: HEBER, jobTypeRaw: 'Drop Fix', phases }))
      .toEqual({ redirected: false, reason: 'no-service-project' })
  })
  it('does not redirect when the project is unknown', () => {
    expect(resolveServiceRedirect({ projectId: null, jobTypeRaw: 'Drop Fix', phases }).reason).toBe('no-project')
  })
})
