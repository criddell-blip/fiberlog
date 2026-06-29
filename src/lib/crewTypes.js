// Shared field-crew-type set. Single source of truth used by App.jsx's
// router (deciding when to route a staff user into the crew shell on
// viewMode='crew') and ManagerApp's SwitchToCrewButton (deciding when
// to enable the 🔧 Crew mode pill).
//
// A staff user (role = owner|manager) with crew_type in this set can
// flip into "crew mode" and log work as one of these crew types. The
// list intentionally excludes:
//   • 'contractor' — no real crew shell wired for them
//   • NULL crew_type — pure managers with no field role
//
// Keep in sync with public.users.crew_type CHECK constraint when adding
// new field roles.
export const VALID_FIELD_CREW_TYPES = [
  'fiber_construction',
  'field_service',   // June 2026 merged splice + drop + locator + fiber_tech
  'install',
  'infrastructure',
]

// Display labels for users.crew_type. Single source of truth so the merged
// 'fiber_construction' value never renders as the raw underscored string.
// Falls back to a title-cased value for any crew_type not listed here.
const CREW_TYPE_DISPLAY = {
  fiber_construction: 'Fiber construction',
  field_service:      'Field service',
  install:            'Install',
  infrastructure:     'Infrastructure',
  contractor:         'Contractor',
  // Legacy values — kept for back-compat rendering of historical rows; no
  // longer assignable in the UI. June 2026 merges:
  //   aerial + underground            → fiber_construction
  //   splice + drop + locator + fiber_tech → field_service
  aerial:             'Aerial',
  underground:        'Underground',
  splice:             'Splice',
  drop:               'Drop',
  locator:            'Locator',
  fiber_tech:         'Fiber tech',
}

export function crewTypeLabel(ct) {
  if (!ct) return ''
  if (CREW_TYPE_DISPLAY[ct]) return CREW_TYPE_DISPLAY[ct]
  // Title-case an unknown value: 'some_role' → 'Some role'
  const s = ct.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Crew-mode project visibility ─────────────────────────────────────
// Gigwave + Fixed Wireless are wireless/infra projects identified by name
// (projects have no type column). They clutter the fiber crews' project
// list, so hide them from everyone except infrastructure (who have their own
// InfraCrewApp shell anyway). field_service crew — which absorbed the old
// fiber_tech — do NOT see wireless projects (owner's call).
export const WIRELESS_ONLY_PROJECTS = ['Gigwave', 'Fixed Wireless']
export const CREW_TYPES_SEE_WIRELESS = ['infrastructure']

export function visibleProjectsForCrew(projects, crewType) {
  if (!Array.isArray(projects)) return projects
  if (CREW_TYPES_SEE_WIRELESS.includes(crewType)) return projects
  return projects.filter(p => !WIRELESS_ONLY_PROJECTS.includes(p?.name))
}
