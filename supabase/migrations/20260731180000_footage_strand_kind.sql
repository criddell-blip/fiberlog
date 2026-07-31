-- Strand joins fiber + conduit as a mapped footage TYPE.
--
-- Until now strand footage reached material through a single per_ft row on the
-- `strand-ft` assembly (600-200001-5000-ERC at qty 1/ft) — a hardcoded 1:1 that
-- can't express a second strand gauge and is a second mechanism to understand
-- alongside footage_type_part_map. This makes strand work like fiber and
-- conduit: a chip pick that resolves through the map.
--
-- Everything here is INERT to the currently-deployed bundle: getAssemblies()
-- destructures the assembly flags explicitly and ignores is_strand, and while
-- getFootageTypePartMap() will surface a `strand` bucket, nothing reads it.
-- Safe to apply before the code deploy. Idempotent; safe to rerun.
--
-- The per_ft assembly row is deliberately NOT removed here — see the follow-up
-- migration. Removing it before the new bundle is live on every phone would
-- silently log zero strand for anyone still running the old JS.

-- 1. assemblies.is_strand — nullable + default false, matching every sibling flag.
alter table public.assemblies
  add column if not exists is_strand boolean default false;

-- 2. footage_type_part_map.kind gains 'strand'. Drop-then-add rather than a
--    second constraint so a rerun converges on exactly one CHECK.
alter table public.footage_type_part_map
  drop constraint if exists footage_type_part_map_kind_check;
alter table public.footage_type_part_map
  add constraint footage_type_part_map_kind_check
  check (kind = any (array['fiber','conduit','strand']));

-- 3. replace_assembly enumerates the flags explicitly in three places (INSERT
--    columns, VALUES, and ON CONFLICT DO UPDATE SET). A new flag missing from
--    any of them means the Assembly editor silently drops it on every save.
create or replace function public.replace_assembly(p_assembly jsonb, p_parts jsonb default '[]'::jsonb)
returns assemblies
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
DECLARE
  v_asm public.assemblies;
BEGIN
  IF (p_assembly->>'id') IS NULL OR (p_assembly->>'id') = '' THEN
    RAISE EXCEPTION 'Assembly id is required' USING ERRCODE = '22P02';
  END IF;
  IF (p_assembly->>'label') IS NULL OR (p_assembly->>'label') = '' THEN
    RAISE EXCEPTION 'Assembly label is required' USING ERRCODE = '22P02';
  END IF;

  INSERT INTO public.assemblies (
    id, label, sub_label, crew_type,
    is_footage, is_fiber, is_mst, is_splice_case,
    is_handhole, is_vault, is_conduit, is_strand,
    is_active, sort_order
  ) VALUES (
    p_assembly->>'id',
    p_assembly->>'label',
    p_assembly->>'sub_label',
    p_assembly->>'crew_type',
    COALESCE((p_assembly->>'is_footage')::boolean,     false),
    COALESCE((p_assembly->>'is_fiber')::boolean,       false),
    COALESCE((p_assembly->>'is_mst')::boolean,         false),
    COALESCE((p_assembly->>'is_splice_case')::boolean, false),
    COALESCE((p_assembly->>'is_handhole')::boolean,    false),
    COALESCE((p_assembly->>'is_vault')::boolean,       false),
    COALESCE((p_assembly->>'is_conduit')::boolean,     false),
    COALESCE((p_assembly->>'is_strand')::boolean,      false),
    COALESCE((p_assembly->>'is_active')::boolean,      true),
    COALESCE((p_assembly->>'sort_order')::integer,     0)
  )
  ON CONFLICT (id) DO UPDATE SET
    label          = EXCLUDED.label,
    sub_label      = EXCLUDED.sub_label,
    crew_type      = EXCLUDED.crew_type,
    is_footage     = EXCLUDED.is_footage,
    is_fiber       = EXCLUDED.is_fiber,
    is_mst         = EXCLUDED.is_mst,
    is_splice_case = EXCLUDED.is_splice_case,
    is_handhole    = EXCLUDED.is_handhole,
    is_vault       = EXCLUDED.is_vault,
    is_conduit     = EXCLUDED.is_conduit,
    is_strand      = EXCLUDED.is_strand,
    is_active      = EXCLUDED.is_active,
    sort_order     = EXCLUDED.sort_order
  RETURNING * INTO v_asm;

  DELETE FROM public.assembly_parts WHERE assembly_id = v_asm.id;

  INSERT INTO public.assembly_parts (
    assembly_id, part_id, default_qty, unit, per_ft, sort_order
  )
  SELECT
    v_asm.id,
    (p->>'part_id')::text,
    COALESCE((p->>'default_qty')::numeric, 1),
    COALESCE(p->>'unit', 'ea'),
    COALESCE((p->>'per_ft')::boolean, false),
    COALESCE((p->>'sort_order')::integer, 0)
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) AS p
  WHERE (p->>'part_id') IS NOT NULL AND (p->>'part_id') <> '';

  RETURN v_asm;
END;
$function$;

-- 4. Data. The only strand cable SKU in the catalog is the EHS 1/4" reel;
--    every other "strand" hit is per-each hardware (strandvise, splice, grip).
update public.assemblies set is_strand = true where id = 'strand-ft';

insert into public.footage_type_part_map (kind, type_value, part_id)
values ('strand', '1/4"', '600-200001-5000-ERC')
on conflict (kind, type_value) do nothing;   -- never clobber a manager remap
