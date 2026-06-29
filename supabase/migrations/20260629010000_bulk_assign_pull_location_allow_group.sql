-- Allow group locations (not just personal trucks) as a pull-location target.
-- The Members editor on a group location assigns members via this RPC; the
-- pre-group guard rejected any non-truck target, so adding a member to a
-- group raised "Pull location must be a truck-type location (got group)".
-- Only the type guard changes; the rest is the existing function verbatim.
-- Applied to the remote DB via MCP (apply_migration); kept here for parity.

CREATE OR REPLACE FUNCTION public.bulk_assign_pull_location(p_user_ids uuid[], p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_id   uuid;
  v_user_id     uuid;
  v_truck       public.inventory_locations;
  v_loc         public.inventory_locations;
  v_user        public.users;
  v_transfers   int := 0;
  v_assigned    int := 0;
  v_cleared     int := 0;
  v_reactivated int := 0;
  v_skipped     int := 0;
BEGIN
  v_caller_id := auth.uid();
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can assign pull locations'
      USING ERRCODE = '42501';
  END IF;

  IF p_location_id IS NOT NULL THEN
    SELECT * INTO v_loc FROM public.inventory_locations WHERE id = p_location_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Location % not found', p_location_id USING ERRCODE = 'P0002';
    END IF;
    -- Pull location may be a personal truck OR a shared group location.
    IF v_loc.type NOT IN ('truck','group') THEN
      RAISE EXCEPTION 'Pull location must be a truck or group location (got %)', v_loc.type
        USING ERRCODE = '22023';
    END IF;
    IF v_loc.is_active = false THEN
      RAISE EXCEPTION 'Location % is inactive', p_location_id USING ERRCODE = '22023';
    END IF;
  END IF;

  FOREACH v_user_id IN ARRAY p_user_ids
  LOOP
    SELECT * INTO v_user FROM public.users WHERE id = v_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'User % not found', v_user_id USING ERRCODE = 'P0002';
    END IF;

    -- Clear path
    IF p_location_id IS NULL THEN
      IF v_user.default_pull_location_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      UPDATE public.inventory_locations
      SET is_active = true, updated_at = now()
      WHERE assigned_to = v_user_id
        AND type = 'truck'
        AND is_active = false;
      IF FOUND THEN
        v_reactivated := v_reactivated + 1;
      END IF;

      UPDATE public.users
      SET default_pull_location_id = NULL
      WHERE id = v_user_id;
      v_cleared := v_cleared + 1;
      CONTINUE;
    END IF;

    -- Assign path
    IF v_user.default_pull_location_id = p_location_id THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_user.default_pull_location_id IS NULL THEN
      SELECT * INTO v_truck
      FROM public.inventory_locations
      WHERE assigned_to = v_user_id
        AND type = 'truck'
        AND is_active = true
      ORDER BY created_at ASC LIMIT 1;

      IF FOUND AND v_truck.id != p_location_id THEN
        INSERT INTO public.inventory_movements (
          movement_type, part_id, quantity, unit,
          from_location_id, to_location_id,
          notes, created_by
        )
        SELECT
          'transfer', s.part_id, s.quantity, pc.unit,
          v_truck.id, p_location_id,
          'Bulk-assigned to ' || v_loc.name || ' — auto-migrated personal-truck stock',
          v_caller_id
        FROM public.inventory_stock s
        LEFT JOIN public.parts_catalog pc ON pc.id = s.part_id
        WHERE s.location_id = v_truck.id AND s.quantity != 0;

        GET DIAGNOSTICS v_transfers = ROW_COUNT;

        UPDATE public.inventory_locations
        SET is_active = false, updated_at = now()
        WHERE id = v_truck.id;
      END IF;
    END IF;

    UPDATE public.users
    SET default_pull_location_id = p_location_id
    WHERE id = v_user_id;
    v_assigned := v_assigned + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'assigned',    v_assigned,
    'cleared',     v_cleared,
    'reactivated', v_reactivated,
    'skipped',     v_skipped,
    'transfers',   v_transfers
  );
END;
$function$;
