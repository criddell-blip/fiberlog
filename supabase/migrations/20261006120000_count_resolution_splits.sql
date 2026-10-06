-- Cycle-count review: split one variance across several counter-locations.
--
-- Oct 2026. resolve_count_resolution could book a variance as a transfer to
-- ONE other location, all or nothing. Real case from the owner's run: Wave LR
-- refurbished was −16 at the bin, and Jaco's truck sat at −3 and Taryn's at −1
-- — the units had gone out on trucks without a load being booked. The honest
-- booking is 3 → Jaco, 1 → Taryn, and the other 12 as a loss.
--
-- New p_splits jsonb: [{ "location_id": uuid, "qty": n }, ...]. Each entry is
-- a transfer (gain: counter → bin, loss: bin → counter); the splits may cover
-- part of the difference, and whatever is left over books as the usual
-- one-sided adjust at the bin. They may not exceed it.
--
-- p_counter_location_id still works (old clients): it is the single-split
-- case for the whole difference.
--
-- count_resolutions.movement_id keeps pointing at ONE movement: the remainder
-- adjust when there is one (getCountRunDetail relies on that to tell a
-- variance's own adjust from a standalone recount), else the first transfer.
-- Every movement carries count_run_id, and manager_notes records the split so
-- the run history shows where the stock went.

DROP FUNCTION IF EXISTS public.resolve_count_resolution(uuid, numeric, uuid, text, numeric);

CREATE OR REPLACE FUNCTION public.resolve_count_resolution(
  p_resolution_id uuid,
  p_counted_now numeric DEFAULT NULL,
  p_counter_location_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_expected_system numeric DEFAULT NULL,
  p_splits jsonb DEFAULT NULL
)
RETURNS public.count_resolutions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_res public.count_resolutions;
  v_location_id uuid;
  v_unit text;
  v_system numeric;
  v_diff numeric;
  v_movement_id uuid;
  v_first_transfer_id uuid;
  v_adjust_id uuid;
  v_notes text;
  v_pending_count int;
  v_note text := NULLIF(btrim(p_note), '');
  v_splits jsonb := COALESCE(p_splits, '[]'::jsonb);
  v_split jsonb;
  v_split_loc uuid;
  v_split_qty numeric;
  v_split_total numeric := 0;
  v_remainder numeric;
  v_summary text[] := ARRAY[]::text[];
  v_loc_name text;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can resolve count variances' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_res FROM public.count_resolutions WHERE id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Resolution % not found', p_resolution_id USING ERRCODE = 'P0002';
  END IF;
  IF v_res.status != 'pending' THEN
    RAISE EXCEPTION 'This variance was already %', v_res.status USING ERRCODE = '23505';
  END IF;
  IF v_res.resolution_type NOT IN ('net_gain', 'net_loss') THEN
    RAISE EXCEPTION 'Only gains/losses can be resolved (this is %)', v_res.resolution_type USING ERRCODE = '22023';
  END IF;
  IF p_counted_now IS NOT NULL AND p_counted_now < 0 THEN
    RAISE EXCEPTION 'Recount cannot be negative' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(v_splits) <> 'array' THEN
    RAISE EXCEPTION 'Splits must be a list' USING ERRCODE = '22023';
  END IF;
  IF p_counter_location_id IS NOT NULL AND jsonb_array_length(v_splits) > 0 THEN
    RAISE EXCEPTION 'Pass either one counter-location or a split, not both' USING ERRCODE = '22023';
  END IF;

  SELECT location_id INTO v_location_id FROM public.count_sessions
  WHERE id = CASE WHEN v_res.resolution_type = 'net_gain' THEN v_res.to_session_id ELSE v_res.from_session_id END;

  SELECT unit INTO v_unit FROM public.parts_catalog WHERE id = v_res.part_id;

  IF p_counted_now IS NOT NULL THEN
    -- Compare against the books NOW. Lock the stock row so a concurrent
    -- movement can't slip between the read and our insert.
    SELECT quantity INTO v_system FROM public.inventory_stock
    WHERE part_id = v_res.part_id AND location_id = v_location_id
    FOR UPDATE;
    v_system := COALESCE(v_system, 0);
    -- The reviewer confirmed a button that said "post N" against the books
    -- they were shown. If stock moved at this bin since, refuse rather than
    -- post a different number than the one they approved.
    IF p_expected_system IS NOT NULL AND p_expected_system <> v_system THEN
      RAISE EXCEPTION 'Books changed since you opened this (now %) — check the number and try again', v_system
        USING ERRCODE = 'P0001', HINT = 'stale_books';
    END IF;
    v_diff := p_counted_now - v_system;
  ELSE
    v_diff := CASE WHEN v_res.resolution_type = 'net_gain' THEN v_res.quantity ELSE -v_res.quantity END;
  END IF;

  -- The legacy single counter-location = one split for the whole difference.
  IF p_counter_location_id IS NOT NULL AND v_diff <> 0 THEN
    v_splits := jsonb_build_array(jsonb_build_object('location_id', p_counter_location_id, 'qty', abs(v_diff)));
  END IF;

  -- Validate every split before posting anything.
  FOR v_split IN SELECT * FROM jsonb_array_elements(v_splits) LOOP
    BEGIN
      v_split_loc := (v_split->>'location_id')::uuid;
      v_split_qty := (v_split->>'qty')::numeric;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Each split needs a location and a quantity' USING ERRCODE = '22023';
    END;
    IF v_split_loc IS NULL OR v_split_qty IS NULL OR v_split_qty <= 0 THEN
      RAISE EXCEPTION 'Each split needs a location and a quantity above 0' USING ERRCODE = '22023';
    END IF;
    IF v_split_loc = v_location_id THEN
      RAISE EXCEPTION 'Pick a different location than the bin being counted' USING ERRCODE = '22023';
    END IF;
    IF NOT public.count_counter_location_ok(v_split_loc) THEN
      RAISE EXCEPTION 'Stock can only move to/from an active warehouse, bin, truck or group' USING ERRCODE = '22023';
    END IF;
    v_split_total := v_split_total + v_split_qty;
  END LOOP;
  IF (SELECT COUNT(DISTINCT e->>'location_id') FROM jsonb_array_elements(v_splits) e) <> jsonb_array_length(v_splits) THEN
    RAISE EXCEPTION 'The same location is listed twice in the split' USING ERRCODE = '22023';
  END IF;
  IF v_split_total > abs(v_diff) THEN
    RAISE EXCEPTION 'The split adds up to % but the difference is only %', v_split_total, abs(v_diff) USING ERRCODE = '22023';
  END IF;

  IF v_diff = 0 THEN
    -- Recount matches the books: close the variance, no movement.
    UPDATE public.count_resolutions SET
      status = 'discarded',
      reviewed_by = v_caller_id,
      reviewed_at = now(),
      recount_qty = p_counted_now,
      recount_system_qty = v_system,
      manager_notes = concat_ws(' · ', format('Recounted %s — matches the books, no adjustment', p_counted_now), v_note)
    WHERE id = p_resolution_id
    RETURNING * INTO v_res;
  ELSE
    v_notes := CASE
      WHEN p_counted_now IS NOT NULL
        THEN format('Count review recount — counted %s, system had %s', p_counted_now, v_system)
      WHEN v_diff > 0 THEN 'Approved gain from count run'
      ELSE 'Approved loss from count run'
    END;
    IF v_note IS NOT NULL THEN v_notes := v_notes || ' · ' || v_note; END IF;

    -- Book each split as the move it really was. Gain here = it came FROM
    -- the counter-location; loss here = it went TO the counter-location.
    FOR v_split IN SELECT * FROM jsonb_array_elements(v_splits) LOOP
      v_split_loc := (v_split->>'location_id')::uuid;
      v_split_qty := (v_split->>'qty')::numeric;
      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit, from_location_id, to_location_id,
        notes, count_run_id, created_by
      ) VALUES (
        'transfer', v_res.part_id, v_split_qty, v_unit,
        CASE WHEN v_diff > 0 THEN v_split_loc ELSE v_location_id END,
        CASE WHEN v_diff > 0 THEN v_location_id ELSE v_split_loc END,
        v_notes, v_res.run_id, v_caller_id
      ) RETURNING id INTO v_movement_id;
      v_first_transfer_id := COALESCE(v_first_transfer_id, v_movement_id);
      SELECT name INTO v_loc_name FROM public.inventory_locations WHERE id = v_split_loc;
      v_summary := v_summary || format('%s %s %s', v_split_qty, CASE WHEN v_diff > 0 THEN '←' ELSE '→' END, v_loc_name);
    END LOOP;

    v_remainder := abs(v_diff) - v_split_total;
    IF v_remainder > 0 THEN
      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit, from_location_id, to_location_id,
        notes, count_run_id, created_by
      ) VALUES (
        'adjust', v_res.part_id, v_remainder, v_unit,
        CASE WHEN v_diff < 0 THEN v_location_id END,
        CASE WHEN v_diff > 0 THEN v_location_id END,
        v_notes, v_res.run_id, v_caller_id
      ) RETURNING id INTO v_adjust_id;
      IF array_length(v_summary, 1) > 0 THEN
        v_summary := v_summary || format('%s %s', v_remainder, CASE WHEN v_diff > 0 THEN 'found (adjusted)' ELSE 'lost (adjusted)' END);
      END IF;
    END IF;

    UPDATE public.count_resolutions SET
      status = 'approved',
      movement_id = COALESCE(v_adjust_id, v_first_transfer_id),
      reviewed_by = v_caller_id,
      reviewed_at = now(),
      recount_qty = p_counted_now,
      recount_system_qty = v_system,
      -- One-location moves keep the old notes (just the reviewer's note);
      -- a real split records where each piece went.
      manager_notes = CASE
        WHEN array_length(v_summary, 1) > 1 OR (array_length(v_summary, 1) = 1 AND v_adjust_id IS NOT NULL)
          THEN concat_ws(' · ', 'Split: ' || array_to_string(v_summary, ', '), v_note)
        ELSE v_note
      END
    WHERE id = p_resolution_id
    RETURNING * INTO v_res;
  END IF;

  -- Serialise run-closing: without the lock, two reviewers settling the last
  -- two variances at once each still see the other's as pending and neither
  -- closes the run.
  PERFORM 1 FROM public.count_runs WHERE id = v_res.run_id FOR UPDATE;
  SELECT COUNT(*) INTO v_pending_count
  FROM public.count_resolutions
  WHERE run_id = v_res.run_id AND status = 'pending';
  IF v_pending_count = 0 THEN
    UPDATE public.count_runs SET status = 'closed', updated_at = now()
    WHERE id = v_res.run_id AND status = 'pending_review';
  END IF;

  RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_count_resolution(uuid, numeric, uuid, text, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_count_resolution(uuid, numeric, uuid, text, numeric, jsonb) TO authenticated;
