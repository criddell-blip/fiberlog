-- Backlog #28: ensure_crew_truck's crew_type IN-list predates the June 2026 merges
-- (aerial+underground → fiber_construction; splice+drop+locator+fiber_tech → field_service),
-- so new users created with the merged crew types got NO auto-created personal truck.
-- Fix: add 'fiber_construction' and 'field_service' to the IN-list. Everything else
-- (guards, truck naming, notes) is byte-identical to the live function.
--
-- Verified live 2026-07-07: zero active fiber_construction/field_service users are
-- missing a truck (all existing ones were created pre-merge under legacy types or
-- point at a group via default_pull_location_id), so no backfill is needed.
--
-- Known remaining gap (report-only, NOT changed here): the trigger itself is
-- `AFTER INSERT OR UPDATE OF role, is_active` — it does not fire when crew_type
-- alone changes on an existing user. The admin create-user path inserts crew_type
-- with the row, so INSERT covers the main path.

create or replace function public.ensure_crew_truck()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
BEGIN
  IF NEW.is_active = true
     AND NEW.default_pull_location_id IS NULL
     AND NEW.crew_type IN (
       'aerial','underground','splice','drop','locator',
       'install','contractor','infrastructure','fiber_tech',
       'fiber_construction','field_service'
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.inventory_locations il
       WHERE il.assigned_to = NEW.id
         AND il.type = 'truck'
         AND il.is_active = true
     )
  THEN
    INSERT INTO public.inventory_locations (name, type, assigned_to, notes)
    VALUES (
      split_part(NEW.name, ' ', 1) || '''s Truck',
      'truck',
      NEW.id,
      'Auto-created personal stock location'
    );
  END IF;
  RETURN NEW;
END;
$function$;
