-- parts_catalog.sage_id — the Sage Intacct Item ID (e.g. UB000011 / UB_900001).
--
-- FiberLog's SKU (parts_catalog.id) stays the primary key and the anchor for
-- every movement; this is an ADDITIONAL cross-reference so the Sage export can
-- emit the ID accounting actually keys on (ITEMID = coalesce(sage_id, sku)).
-- Until now names were the only bridge to Sage, which is why catalog names
-- were aligned to Sage's in the June 2026 reset. Nullable: parts with no Sage
-- item yet (or retired duplicates) stay NULL and export as their SKU so
-- accounting can still spot them.
--
-- Partial unique index: one Sage item maps to exactly one SKU. Backfilled from
-- the owner's "Sage Inventory Item IDs" workbook by scripts/sage-id-backfill.mjs
-- (name-matched, reviewed, then applied by SQL). RLS is column-agnostic, so no
-- policy change.

alter table public.parts_catalog
  add column if not exists sage_id text;

create unique index if not exists parts_catalog_sage_id_idx
  on public.parts_catalog (sage_id)
  where sage_id is not null;

comment on column public.parts_catalog.sage_id is
  'Sage Intacct Item ID (UB000011-style). Cross-reference only — SKU (id) remains the key. Used as ITEMID in the Sage export, falling back to SKU when NULL.';
