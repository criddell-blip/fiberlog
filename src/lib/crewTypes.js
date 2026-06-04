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
  'aerial',
  'underground',
  'splice',
  'drop',
  'locator',
  'install',
  'fiber_tech',
  'infrastructure',
]
