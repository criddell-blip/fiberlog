-- Merge crew types splice + drop + locator + fiber_tech → 'field_service'.
-- Worker-classification axis only (users.crew_type + crew_type_part_restrictions
-- + the approve_submission guard). The WORK axis (assemblies.crew_type, task
-- tabs) is untouched. Legacy values kept VALID for back-compat.
-- Applied to the remote DB via MCP (apply_migration); kept here for parity.

-- 1. Widen CHECKs to allow 'field_service'.
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_crew_type_check;
ALTER TABLE public.users ADD CONSTRAINT users_crew_type_check
  CHECK (crew_type IS NULL OR crew_type = ANY (ARRAY[
    'aerial','underground','fiber_construction','splice','drop','locator',
    'contractor','install','infrastructure','fiber_tech','field_service'
  ]));

ALTER TABLE public.crew_type_part_restrictions DROP CONSTRAINT IF EXISTS crew_type_part_restrictions_crew_type_check;
ALTER TABLE public.crew_type_part_restrictions ADD CONSTRAINT crew_type_part_restrictions_crew_type_check
  CHECK (crew_type = ANY (ARRAY[
    'aerial','underground','fiber_construction','splice','drop','locator',
    'contractor','install','infrastructure','fiber_tech','field_service'
  ]));

-- 2. Migrate users (drop 5, splice 3, locator 1, fiber_tech 1).
UPDATE public.users SET crew_type = 'field_service'
 WHERE crew_type IN ('splice','drop','locator','fiber_tech');

-- 3. Unrestricted: drop the merged types' department whitelists.
DELETE FROM public.crew_type_part_restrictions
 WHERE crew_type IN ('splice','drop','locator','fiber_tech');

-- 4. Auto-deduct guard: add 'field_service' to approve_submission's IN-list
--    (so drop/locator now deduct too). Full function re-created via MCP; the
--    only change vs the prior definition is the guard IN-list gaining
--    'field_service'. See remote migration history for the complete body.
-- (CREATE OR REPLACE applied via MCP — body omitted here for brevity/parity.)
