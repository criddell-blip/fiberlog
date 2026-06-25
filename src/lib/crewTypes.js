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
  'splice',
  'drop',
  'locator',
  'install',
  'fiber_tech',
  'infrastructure',
]

// Display labels for users.crew_type. Single source of truth so the merged
// 'fiber_construction' value never renders as the raw underscored string.
// Falls back to a title-cased value for any crew_type not listed here.
const CREW_TYPE_DISPLAY = {
  fiber_construction: 'Fiber construction',
  fiber_tech:         'Fiber tech',
  aerial:             'Aerial',        // legacy — kept valid for back-compat
  underground:        'Underground',   // legacy — kept valid for back-compat
  splice:             'Splice',
  drop:               'Drop',
  locator:            'Locator',
  install:            'Install',
  infrastructure:     'Infrastructure',
  contractor:         'Contractor',
}

export function crewTypeLabel(ct) {
  if (!ct) return ''
  if (CREW_TYPE_DISPLAY[ct]) return CREW_TYPE_DISPLAY[ct]
  // Title-case an unknown value: 'some_role' → 'Some role'
  const s = ct.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}
