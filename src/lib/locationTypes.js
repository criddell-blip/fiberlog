// Display labels + icons for inventory_locations.type. Single source of
// truth — before this file existed four components each carried their own
// map and disagreed (a job_site was "Job site" in the Locations tab and
// "Project bucket" in the detail panel opened from it), and a dozen
// dropdowns printed the raw token ("(job_site)", "All job_sites").
//
// The DB value is still 'job_site' (CHECK constraint, triggers, RPCs,
// ledger logic all key on it) — only the words the user sees change.
// Aug 2026: owner renamed the buckets "Region/Projects" because they are
// the per-project consumption ledgers, not physical job sites.
export const LOCATION_TYPE_LABELS = {
  warehouse: 'Warehouse',
  truck:     'Truck',
  group:     'Group',
  job_site:  'Region/Project',
  vendor:    'Vendor',
  scrap:     'Scrap',
  bin:       'Bin',
}

export const LOCATION_TYPE_PLURALS = {
  warehouse: 'Warehouses',
  truck:     'Trucks',
  group:     'Groups',
  job_site:  'Region/Projects',
  vendor:    'Vendors',
  scrap:     'Scrap',
  bin:       'Bins',
}

export const LOCATION_TYPE_ICONS = {
  warehouse: '🏭',
  truck:     '🚚',
  group:     '👥',
  job_site:  '📍',
  vendor:    '🏢',
  scrap:     '🗑️',
  bin:       '📥',
}

// Humanised fallback so an unknown/new type never renders as snake_case.
export function locationTypeLabel(type, { plural = false } = {}) {
  if (!type) return ''
  const map = plural ? LOCATION_TYPE_PLURALS : LOCATION_TYPE_LABELS
  if (map[type]) return map[type]
  const s = String(type).replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + (plural ? 's' : '')
}
