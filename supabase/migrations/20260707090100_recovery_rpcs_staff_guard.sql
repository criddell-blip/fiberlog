-- Backlog #30: deactivate_location_with_recovery (and its sibling
-- decommission_site_with_recovery) still raised "Only owners can ..." on a
-- role='owner' check, but the June 2026 "open owner-only toggles to all staff"
-- work made both retire UIs staff-reachable (InventoryLocationsTab /
-- ProjectManager are gated on isStaff). Fix: swap the owner-only role check for
-- the house-standard public.is_staff() guard (owner OR manager), matching
-- approve_intake_request et al. The unused v_caller_role local is dropped;
-- everything else is byte-identical to the live functions.
--
-- Grants are intentionally untouched — CREATE OR REPLACE preserves the existing
-- ACL (authenticated + anon EXECUTE; the auth.uid() guard rejects anon callers).

create or replace function public.deactivate_location_with_recovery(
  p_location_id uuid,
  p_recovery_items jsonb default '[]'::jsonb,
  p_destination_location_id uuid default null::uuid
)
returns inventory_locations
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_caller_id   uuid;
  v_loc         public.inventory_locations;
  v_item        jsonb;
  v_qty         numeric;
  v_recovery_n  int;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only staff can retire locations' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_loc FROM public.inventory_locations
    WHERE id = p_location_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Location % not found', p_location_id USING ERRCODE = 'P0002';
  END IF;

  v_recovery_n := COALESCE(jsonb_array_length(p_recovery_items), 0);

  IF v_recovery_n > 0 THEN
    IF p_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'Destination location required when recovering materials'
        USING ERRCODE = '22023';
    END IF;
    IF p_destination_location_id = p_location_id THEN
      RAISE EXCEPTION 'Destination cannot be the location being retired'
        USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_recovery_items)
    LOOP
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit,
        from_location_id, to_location_id,
        notes, created_by
      ) VALUES (
        'transfer',
        (v_item->>'part_id')::text,
        v_qty,
        v_item->>'unit',
        p_location_id,
        p_destination_location_id,
        'Location retirement: ' || v_loc.name,
        v_caller_id
      );
    END LOOP;
  END IF;

  UPDATE public.inventory_locations
     SET is_active = false
   WHERE id = p_location_id
   RETURNING * INTO v_loc;

  RETURN v_loc;
END;
$function$;

create or replace function public.decommission_site_with_recovery(
  p_site_id uuid,
  p_recovery_items jsonb default '[]'::jsonb,
  p_destination_location_id uuid default null::uuid
)
returns sites
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
DECLARE
  v_caller_id     uuid;
  v_site          public.sites;
  v_project_bkt   uuid;
  v_item          jsonb;
  v_qty           numeric;
  v_recovery_n    int;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only staff can retire sites' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_site FROM public.sites WHERE id = p_site_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Site % not found', p_site_id USING ERRCODE = 'P0002';
  END IF;

  v_recovery_n := COALESCE(jsonb_array_length(p_recovery_items), 0);

  IF v_recovery_n > 0 THEN
    IF p_destination_location_id IS NULL THEN
      RAISE EXCEPTION 'Destination location required when recovering materials'
        USING ERRCODE = '22023';
    END IF;
    IF v_site.project_id IS NULL THEN
      RAISE EXCEPTION 'Site has no project — cannot resolve source bucket. Map site to a project first.'
        USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_project_bkt
    FROM public.inventory_locations
    WHERE project_id = v_site.project_id
      AND type = 'job_site'
      AND is_active = true
    LIMIT 1;
    IF v_project_bkt IS NULL THEN
      RAISE EXCEPTION 'No active project bucket found for project_id %', v_site.project_id
        USING ERRCODE = 'P0002';
    END IF;
    IF v_project_bkt = p_destination_location_id THEN
      RAISE EXCEPTION 'Destination cannot be the source project bucket'
        USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_recovery_items)
    LOOP
      v_qty := (v_item->>'quantity')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN CONTINUE; END IF;

      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit,
        from_location_id, to_location_id,
        notes, created_by
      ) VALUES (
        'transfer',
        (v_item->>'part_id')::text,
        v_qty,
        v_item->>'unit',
        v_project_bkt,
        p_destination_location_id,
        'Site recovery: ' || v_site.name || ' (decommissioned)',
        v_caller_id
      );
    END LOOP;
  END IF;

  UPDATE public.sites
     SET status = 'decommissioned'
   WHERE id = p_site_id
   RETURNING * INTO v_site;

  RETURN v_site;
END;
$function$;
