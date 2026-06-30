-- Fix: record_crew_movement resolved the caller's stock location ONLY via an
-- active personal truck (assigned_to + type='truck' + is_active), ignoring
-- users.default_pull_location_id. Members of a shared group location (whose
-- personal truck is deactivated when they're assigned to the group) therefore
-- hit "You do not have a personal stock location yet" on every load/return.
--
-- Resolve the pull location first (mirrors getMyTruck() in the app), then fall
-- back to the personal truck. Applied to the remote DB via MCP; kept here for
-- parity. Only the location-resolution block changed (+ v_pull declare).

CREATE OR REPLACE FUNCTION public.record_crew_movement(p_operation text, p_part_id text, p_quantity numeric, p_other_location_id uuid DEFAULT NULL::uuid, p_unit text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_vendor_invoice text DEFAULT NULL::text, p_unit_cost numeric DEFAULT NULL::numeric, p_task_id uuid DEFAULT NULL::uuid, p_destination_location_id uuid DEFAULT NULL::uuid)
 RETURNS inventory_movements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_id        uuid;
  v_caller_role      text;
  v_caller_crew_type text;
  v_my_truck         uuid;
  v_pull             uuid;
  v_part_dept        text;
  v_has_restrictions boolean;
  v_movement_type    text;
  v_from             uuid;
  v_to               uuid;
  v_row              public.inventory_movements;
  v_deny_reason      text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_part_id IS NULL OR p_part_id = '' THEN
    RAISE EXCEPTION 'part_id required' USING ERRCODE = '22023';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be > 0' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = v_caller_id;

  IF v_caller_role IS DISTINCT FROM 'owner' THEN

    SELECT reason INTO v_deny_reason
    FROM public.crew_operation_permissions
    WHERE user_id = v_caller_id
      AND operation = p_operation
      AND allowed = false;
    IF FOUND THEN
      RAISE EXCEPTION 'You are not permitted to %: %', p_operation,
        COALESCE(v_deny_reason, 'no reason given')
        USING ERRCODE = '42501';
    END IF;

    SELECT crew_type INTO v_caller_crew_type FROM public.users WHERE id = v_caller_id;
    SELECT department INTO v_part_dept       FROM public.parts_catalog WHERE id = p_part_id;

    IF v_part_dept IS NOT NULL AND v_caller_crew_type IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.crew_type_part_restrictions
        WHERE crew_type = v_caller_crew_type
      ) INTO v_has_restrictions;

      IF v_has_restrictions AND NOT EXISTS (
        SELECT 1 FROM public.crew_type_part_restrictions
        WHERE crew_type = v_caller_crew_type
          AND department = v_part_dept
      ) THEN
        RAISE EXCEPTION 'Part % (department: %) is not in the % crew''s allowed list',
          p_part_id, v_part_dept, v_caller_crew_type
          USING ERRCODE = '42501';
      END IF;
    END IF;

  END IF;  -- end non-owner permission block

  -- Resolve the caller's stock location. Prefer an explicit shared pull
  -- location (group / shared trailer) when it points at an active location;
  -- otherwise fall back to the caller's active personal truck. Mirrors
  -- getMyTruck() in the app.
  SELECT default_pull_location_id INTO v_pull FROM public.users WHERE id = v_caller_id;
  IF v_pull IS NOT NULL THEN
    SELECT id INTO v_my_truck
    FROM public.inventory_locations
    WHERE id = v_pull AND is_active = true;
  END IF;

  IF v_my_truck IS NULL THEN
    SELECT id INTO v_my_truck
    FROM public.inventory_locations
    WHERE assigned_to = v_caller_id
      AND type = 'truck'
      AND is_active = true
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;

  IF v_my_truck IS NULL THEN
    RAISE EXCEPTION 'You do not have a personal stock location yet. Ask your manager to set one up.'
      USING ERRCODE = '42501';
  END IF;

  CASE p_operation
    WHEN 'load' THEN
      IF p_other_location_id IS NULL THEN
        RAISE EXCEPTION 'Load needs a source location' USING ERRCODE = '22023';
      END IF;
      v_movement_type := 'transfer';
      v_from := p_other_location_id;

      IF p_destination_location_id IS NULL
         OR p_destination_location_id = v_my_truck THEN
        v_to := v_my_truck;
      ELSE
        IF v_caller_role IS DISTINCT FROM 'owner' THEN
          IF NOT EXISTS (
            SELECT 1 FROM public.crew_load_destinations
            WHERE user_id = v_caller_id
              AND location_id = p_destination_location_id
          ) THEN
            RAISE EXCEPTION 'You are not permitted to load to this location'
              USING ERRCODE = '42501';
          END IF;
        END IF;
        v_to := p_destination_location_id;
      END IF;
    WHEN 'return' THEN
      IF p_other_location_id IS NULL THEN
        RAISE EXCEPTION 'Return needs a destination warehouse' USING ERRCODE = '22023';
      END IF;
      v_movement_type := 'return';
      v_from := v_my_truck;
      v_to   := p_other_location_id;
    WHEN 'transfer' THEN
      IF p_other_location_id IS NULL THEN
        RAISE EXCEPTION 'Transfer needs a destination crew member' USING ERRCODE = '22023';
      END IF;
      IF p_other_location_id = v_my_truck THEN
        RAISE EXCEPTION 'Cannot transfer to yourself' USING ERRCODE = '22023';
      END IF;
      v_movement_type := 'transfer';
      v_from := v_my_truck;
      v_to   := p_other_location_id;
    WHEN 'issue' THEN
      v_movement_type := 'issue';
      v_from := v_my_truck;
      v_to   := NULL;
    WHEN 'scrap' THEN
      v_movement_type := 'scrap';
      v_from := v_my_truck;
      v_to   := NULL;
    ELSE
      RAISE EXCEPTION 'Unknown crew operation: %', p_operation USING ERRCODE = '22023';
  END CASE;

  INSERT INTO public.inventory_movements (
    movement_type, part_id, quantity, unit,
    from_location_id, to_location_id,
    vendor_invoice, unit_cost, notes,
    task_id, created_by
  ) VALUES (
    v_movement_type, p_part_id, p_quantity, p_unit,
    v_from, v_to,
    p_vendor_invoice, p_unit_cost, p_notes,
    p_task_id, v_caller_id
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;
