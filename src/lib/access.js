// Staff access model — single source of truth for "who can see/do what" in
// the manager portal. Derives a `staff_scope` from a user row and maps it to
// visible tabs, crew-mode eligibility, and inventory limits.
//
// Axes on the user row:
//   role        — owner | manager | crew | contractor   (the security primitive / RLS)
//   crew_type   — field role; only set for crew + working managers
//   staff_scope — full | warehouse | accounting | NULL   (manager UI scope)
//   restricted_to_inventory — legacy boolean; honored as a fallback so nothing
//                             breaks before every manager carries a staff_scope.
//
// This is a UI-scoping layer (like restricted_to_inventory was); RLS still
// governs the API. The access-type picker in AdminUsersView writes the right
// {role, staff_scope, crew_type} via accessTypeToFields().

import { VALID_FIELD_CREW_TYPES } from './crewTypes'

export { VALID_FIELD_CREW_TYPES }

// Manager nav tab ids, in display order. Mirrors ManagerApp's NAV_ITEMS (+admin).
export const ALL_MANAGER_TABS = ['submissions', 'crew', 'projects', 'reports', 'assemblies', 'inventory', 'admin']

// Resolve a user's staff scope. Returns null for non-staff (crew/contractor).
export function staffScope(user) {
  if (!user) return 'full'
  if (user.role === 'owner') return 'full'
  if (user.role !== 'manager') return null
  return user.staff_scope || (user.restricted_to_inventory ? 'warehouse' : 'full')
}

// Tabs a staff user should see, ordered by ALL_MANAGER_TABS.
export function visibleManagerTabs(user) {
  const scope = staffScope(user)
  let allowed
  if (scope === 'warehouse')      allowed = ['inventory', 'reports', 'admin']
  else if (scope === 'accounting') allowed = ['reports', 'inventory']
  else                             allowed = ALL_MANAGER_TABS  // full (incl. owner)
  return ALL_MANAGER_TABS.filter(t => allowed.includes(t))
}

// Only full-scope staff with a field crew_type can flip into the crew shell.
// Warehouse + accounting never act as crew, regardless of crew_type.
export function canActAsCrew(user) {
  if (staffScope(user) !== 'full') return false
  return VALID_FIELD_CREW_TYPES.includes(user?.crew_type)
}

// Accounting gets a reduced Inventory tab: Receive PO + Purchase Requests +
// read-only stock. Everyone else with Inventory access gets full ops.
export function inventoryIsLimited(user) {
  return staffScope(user) === 'accounting'
}

// ─── Access types (the named picker at user create/edit) ──────────────────
// Each maps to a concrete {role, staff_scope, crew_type-handling}. `needsCrew`
// flags the two types that show a crew_type picker; the rest force crew_type
// NULL (so non-crew staff never carry a stale field tag).
export const ACCESS_TYPES = [
  { id: 'owner',           label: 'Owner',             role: 'owner',      scope: 'full',       needsCrew: false, ownerOnly: true,
    desc: 'Full admin; can create other owners.' },
  { id: 'full_manager',    label: 'Full manager',      role: 'manager',    scope: 'full',       needsCrew: false,
    desc: 'All tabs. No field crew_type, so no crew mode.' },
  { id: 'working_manager', label: 'Working manager',   role: 'manager',    scope: 'full',       needsCrew: true,
    desc: 'All tabs + can switch into crew mode to log their own work.' },
  { id: 'warehouse',       label: 'Warehouse manager', role: 'manager',    scope: 'warehouse',  needsCrew: false,
    desc: 'Inventory (move/count/adjust/receive/locate) + Reports + Admin.' },
  { id: 'accounting',      label: 'Accounting',        role: 'manager',    scope: 'accounting', needsCrew: false,
    desc: 'Reports + receive POs / purchase requests + view stock. No cycle count or adjust.' },
  { id: 'crew',            label: 'Crew',              role: 'crew',       scope: null,         needsCrew: true,
    desc: 'Field worker. Logs work in the crew app.' },
  { id: 'contractor',      label: 'Contractor',        role: 'contractor', scope: null,         needsCrew: false,
    desc: 'External worker, limited access.' },
]

// Pick the access-type id that best matches an existing user row (for edit).
export function accessTypeForUser(user) {
  if (!user) return 'crew'
  if (user.role === 'owner') return 'owner'
  if (user.role === 'crew') return 'crew'
  if (user.role === 'contractor') return 'contractor'
  // manager
  const scope = staffScope(user)
  if (scope === 'warehouse') return 'warehouse'
  if (scope === 'accounting') return 'accounting'
  return VALID_FIELD_CREW_TYPES.includes(user.crew_type) ? 'working_manager' : 'full_manager'
}

// Map an access-type id (+ chosen crew_type) to the persisted user fields.
// crew_type is forced NULL for every non-crew-carrying type.
export function accessTypeToFields(typeId, crewType) {
  const t = ACCESS_TYPES.find(a => a.id === typeId) || ACCESS_TYPES[0]
  return {
    role: t.role,
    staff_scope: t.scope,                       // null for crew/contractor
    crew_type: t.needsCrew ? (crewType || null) : null,
  }
}
