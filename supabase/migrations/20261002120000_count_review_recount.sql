-- Cycle-count review: recount / book-as-transfer instead of approve-or-discard.
--
-- Oct 2026. During the warehouse + truck count the owner found that the only
-- two review options (approve the variance as an adjust, or discard it) piled
-- adjustments on top of miscounts: a bin counted wrong got adjusted, then
-- re-adjusted when someone noticed, and a part that was simply on the wrong
-- shelf became an adjust-down here plus an adjust-up there. Two new RPCs give
-- the reviewer the missing options:
--
--   resolve_count_resolution  — settle a PENDING net_gain / net_loss with
--     (a) a fresh recount: "I just went and looked, there are N" — the
--         adjustment is N minus what the books say is in that bin RIGHT NOW
--         (not the stale expected_qty from count time, so stock that moved
--         since the count is not double-booked), and/or
--     (b) a counter-location: book the difference as a TRANSFER from/to the
--         place the stock really came from / went to, instead of an adjust.
--     A recount that matches the books closes the variance with no movement.
--
--   recount_count_location — the same recount for a (part, location) that
--     has NO pending variance in the run: an auto-reconciled transfer that
--     turned out wrong, or an already-approved line. Posts one correcting
--     adjust tagged with the run (count_run_id) so it shows up with the run.
--
-- Both are staff-gated SECURITY DEFINER like the rest of the count RPCs.

ALTER TABLE public.count_resolutions
  ADD COLUMN IF NOT EXISTS recount_qty numeric,
  ADD COLUMN IF NOT EXISTS recount_system_qty numeric;

COMMENT ON COLUMN public.count_resolutions.recount_qty IS
  'Reviewer''s recount at review time (resolve_count_resolution). NULL = settled as originally counted.';
COMMENT ON COLUMN public.count_resolutions.recount_system_qty IS
  'Book quantity at the bin when the recount was entered — the recount is compared against this, not expected_qty.';

-- Shared counter-location rule: stock can only come from / go to a place that
-- physically holds stock. Regions (job_site) are the consumption ledger,
-- vendor/scrap aren't shelves.
CREATE OR REPLACE FUNCTION public.count_counter_location_ok(p_location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.inventory_locations
    WHERE id = p_location_id
      AND is_active
      AND type IN ('warehouse', 'bin', 'truck', 'group')
  );
$$;

CREATE OR REPLACE FUNCTION public.resolve_count_resolution(
  p_resolution_id uuid,
  p_counted_now numeric DEFAULT NULL,
  p_counter_location_id uuid DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_expected_system numeric DEFAULT NULL
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
  v_notes text;
  v_pending_count int;
  v_note text := NULLIF(btrim(p_note), '');
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

  SELECT location_id INTO v_location_id FROM public.count_sessions
  WHERE id = CASE WHEN v_res.resolution_type = 'net_gain' THEN v_res.to_session_id ELSE v_res.from_session_id END;

  IF p_counter_location_id IS NOT NULL THEN
    IF p_counter_location_id = v_location_id THEN
      RAISE EXCEPTION 'Pick a different location than the bin being counted' USING ERRCODE = '22023';
    END IF;
    IF NOT public.count_counter_location_ok(p_counter_location_id) THEN
      RAISE EXCEPTION 'Stock can only move to/from an active warehouse, bin, truck or group' USING ERRCODE = '22023';
    END IF;
  END IF;

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

    IF p_counter_location_id IS NOT NULL THEN
      -- Book it as the move it really was. Gain here = it came FROM the
      -- counter-location; loss here = it went TO the counter-location.
      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit, from_location_id, to_location_id,
        notes, count_run_id, created_by
      ) VALUES (
        'transfer', v_res.part_id, abs(v_diff), v_unit,
        CASE WHEN v_diff > 0 THEN p_counter_location_id ELSE v_location_id END,
        CASE WHEN v_diff > 0 THEN v_location_id ELSE p_counter_location_id END,
        v_notes, v_res.run_id, v_caller_id
      ) RETURNING id INTO v_movement_id;
    ELSE
      INSERT INTO public.inventory_movements (
        movement_type, part_id, quantity, unit, from_location_id, to_location_id,
        notes, count_run_id, created_by
      ) VALUES (
        'adjust', v_res.part_id, abs(v_diff), v_unit,
        CASE WHEN v_diff < 0 THEN v_location_id END,
        CASE WHEN v_diff > 0 THEN v_location_id END,
        v_notes, v_res.run_id, v_caller_id
      ) RETURNING id INTO v_movement_id;
    END IF;

    UPDATE public.count_resolutions SET
      status = 'approved',
      movement_id = v_movement_id,
      reviewed_by = v_caller_id,
      reviewed_at = now(),
      recount_qty = p_counted_now,
      recount_system_qty = v_system,
      manager_notes = v_note
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

CREATE OR REPLACE FUNCTION public.recount_count_location(
  p_run_id uuid,
  p_part_id text,
  p_location_id uuid,
  p_counted_now numeric,
  p_note text DEFAULT NULL,
  p_expected_system numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id uuid := auth.uid();
  v_run public.count_runs;
  v_unit text;
  v_system numeric;
  v_diff numeric;
  v_movement_id uuid;
  v_notes text;
  v_note text := NULLIF(btrim(p_note), '');
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can recount' USING ERRCODE = '42501';
  END IF;
  IF p_counted_now IS NULL OR p_counted_now < 0 THEN
    RAISE EXCEPTION 'Enter the quantity you counted (0 or more)' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM public.count_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run % not found', p_run_id USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status NOT IN ('pending_review', 'closed') THEN
    RAISE EXCEPTION 'Recount is only available once the run has ended (status is %)', v_run.status USING ERRCODE = '22023';
  END IF;

  -- Only a part the run actually counted at that location — this is a
  -- correction to the run, not a free-form adjust tagged with it.
  IF NOT EXISTS (
    SELECT 1 FROM public.count_sessions cs
    JOIN public.count_lines cl ON cl.session_id = cs.id
    WHERE cs.run_id = p_run_id AND cs.location_id = p_location_id AND cl.part_id = p_part_id
  ) THEN
    RAISE EXCEPTION 'That part was not counted at that location in this run' USING ERRCODE = '22023';
  END IF;

  -- A pending variance for the same part + bin must be settled through
  -- resolve_count_resolution, or approving it afterwards would book the
  -- difference a second time.
  IF EXISTS (
    SELECT 1 FROM public.count_resolutions cr
    JOIN public.count_sessions cs
      ON cs.id = CASE WHEN cr.resolution_type = 'net_gain' THEN cr.to_session_id ELSE cr.from_session_id END
    WHERE cr.run_id = p_run_id AND cr.part_id = p_part_id AND cr.status = 'pending'
      AND cs.location_id = p_location_id
  ) THEN
    RAISE EXCEPTION 'This part has a pending variance at that bin — recount it from the variance instead' USING ERRCODE = '22023';
  END IF;

  SELECT quantity INTO v_system FROM public.inventory_stock
  WHERE part_id = p_part_id AND location_id = p_location_id
  FOR UPDATE;
  v_system := COALESCE(v_system, 0);
  IF p_expected_system IS NOT NULL AND p_expected_system <> v_system THEN
    RAISE EXCEPTION 'Books changed since you opened this (now %) — check the number and try again', v_system
      USING ERRCODE = 'P0001', HINT = 'stale_books';
  END IF;
  v_diff := p_counted_now - v_system;

  IF v_diff <> 0 THEN
    SELECT unit INTO v_unit FROM public.parts_catalog WHERE id = p_part_id;
    v_notes := format('Count review recount — counted %s, system had %s', p_counted_now, v_system);
    IF v_note IS NOT NULL THEN v_notes := v_notes || ' · ' || v_note; END IF;
    INSERT INTO public.inventory_movements (
      movement_type, part_id, quantity, unit, from_location_id, to_location_id,
      notes, count_run_id, created_by
    ) VALUES (
      'adjust', p_part_id, abs(v_diff), v_unit,
      CASE WHEN v_diff < 0 THEN p_location_id END,
      CASE WHEN v_diff > 0 THEN p_location_id END,
      v_notes, p_run_id, v_caller_id
    ) RETURNING id INTO v_movement_id;
  END IF;

  RETURN jsonb_build_object(
    'movement_id', v_movement_id,
    'system_qty', v_system,
    'counted_qty', p_counted_now,
    'diff', v_diff
  );
END;
$$;

REVOKE ALL ON FUNCTION public.count_counter_location_ok(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_count_resolution(uuid, numeric, uuid, text, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recount_count_location(uuid, text, uuid, numeric, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_count_resolution(uuid, numeric, uuid, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recount_count_location(uuid, text, uuid, numeric, text, numeric) TO authenticated;
