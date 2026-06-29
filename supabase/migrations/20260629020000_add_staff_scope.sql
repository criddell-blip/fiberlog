-- Staff access scope for the manager portal. Supersedes the binary
-- restricted_to_inventory: full (all tabs) | warehouse (inventory ops +
-- reports + admin) | accounting (reports + limited inventory). NULL = full.
-- Only meaningful for role='manager'; owner is implicitly full. UI-scoping
-- only (RLS still governs the API), same posture as restricted_to_inventory.
-- Applied to the remote DB via MCP (apply_migration); kept here for parity.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS staff_scope text;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_staff_scope_check;
ALTER TABLE public.users ADD CONSTRAINT users_staff_scope_check
  CHECK (staff_scope IS NULL OR staff_scope = ANY (ARRAY['full'::text,'warehouse'::text,'accounting'::text]));

-- Backfill the known personas.
UPDATE public.users SET staff_scope='warehouse', restricted_to_inventory=false
  WHERE id='a7a13c4e-303b-47a1-ba2b-2ca28e691264';  -- Clint Anderson (warehouse manager)
UPDATE public.users SET staff_scope='accounting', crew_type=NULL
  WHERE id='908031ae-0510-404e-bfec-cc158bc12266';  -- Amber Von Almen (clear stale 'aerial')
UPDATE public.users SET staff_scope='accounting'
  WHERE id='8bd089ca-06a1-416c-932f-8918199fc83f';  -- Michelle Filleman
