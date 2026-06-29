-- Add a 'group' location type for shared/multi-member buckets (the contractor
-- trailer, the construction crew's shared truck, etc.), distinct from personal
-- trucks so they get their own section in the Locations admin. Membership is
-- modeled with the existing users.default_pull_location_id pointer + getMyTruck,
-- so crew load/return/My-Stock needs no change.
--
-- Applied to the remote DB via MCP (apply_migration); this file is kept for
-- parity (db push skips already-applied migrations). Idempotent.

ALTER TABLE public.inventory_locations DROP CONSTRAINT IF EXISTS inventory_locations_type_check;
ALTER TABLE public.inventory_locations ADD CONSTRAINT inventory_locations_type_check
  CHECK (type = ANY (ARRAY['warehouse'::text,'truck'::text,'group'::text,'job_site'::text,'vendor'::text,'scrap'::text,'bin'::text]));

-- Convert existing shared trucks (no assigned owner) to the new type:
-- Contractor - RNS, Crew - Construction Underground/Aerial, and the 5
-- decommissioned Crew - * trucks.
UPDATE public.inventory_locations
SET type = 'group'
WHERE type = 'truck' AND assigned_to IS NULL;
