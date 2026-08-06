-- Backlog #39 — cycle-count false-zero fix (DB side).
-- 1) record_count_line: p_counted_qty IS NULL is now a deliberate "un-count" —
--    clears counted_qty on an EXPECTED line (back to "not yet counted") instead of
--    silently upserting a ghost expected=0/counted=NULL row. Ad-hoc (expected_qty=0)
--    lines must be removed via delete_count_line; clearing a line that doesn't exist
--    is an error. Non-NULL behavior unchanged.
-- 2) reopen_count_session: flips a 'submitted' bin session back to 'in_progress'
--    while the parent run is still open, so a manager can fix a bad count before
--    the run is ended. Idempotent. Deliberately does NOT roll back the bin's
--    inventory_locations.last_counted_at stamp (submit re-stamps on resubmit;
--    a stale stamp is a harmless recency hint).

-- ─── 1. record_count_line — NULL = explicit un-count ─────────────────────────

CREATE OR REPLACE FUNCTION public.record_count_line(p_session_id uuid, p_part_id text, p_counted_qty numeric)
 RETURNS public.count_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_session public.count_sessions;
  v_line public.count_lines;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can record counts' USING ERRCODE = '42501';
  END IF;

  IF p_counted_qty < 0 THEN
    RAISE EXCEPTION 'Counted qty cannot be negative' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_session FROM public.count_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session % not found', p_session_id USING ERRCODE = 'P0002';
  END IF;
  IF v_session.status != 'in_progress' THEN
    RAISE EXCEPTION 'Session % status is %, cannot edit', p_session_id, v_session.status USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.parts_catalog WHERE id = p_part_id) THEN
    RAISE EXCEPTION 'Part % not found in catalog', p_part_id USING ERRCODE = 'P0002';
  END IF;

  -- NULL = deliberate "un-count": restore an expected line to "not yet counted".
  -- Never inserts — the naive upsert used to create a ghost expected=0/counted=NULL line.
  IF p_counted_qty IS NULL THEN
    SELECT * INTO v_line
    FROM public.count_lines
    WHERE session_id = p_session_id AND part_id = p_part_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Nothing to clear — part has no count line in this session' USING ERRCODE = '22023';
    END IF;

    IF v_line.expected_qty = 0 THEN
      -- Un-counting an ad-hoc/unexpected line means removing it entirely
      RAISE EXCEPTION 'Line is an unexpected find (expected 0) — use delete_count_line to remove it' USING ERRCODE = '22023';
    END IF;

    UPDATE public.count_lines
    SET counted_qty = NULL,
        updated_at = now()
    WHERE id = v_line.id
    RETURNING * INTO v_line;

    RETURN v_line;
  END IF;

  -- UPSERT — existing expected line OR new "found unexpected" line (expected_qty=0)
  INSERT INTO public.count_lines (session_id, part_id, expected_qty, counted_qty)
  VALUES (p_session_id, p_part_id, 0, p_counted_qty)
  ON CONFLICT (session_id, part_id) DO UPDATE
    SET counted_qty = EXCLUDED.counted_qty,
        updated_at = now()
  RETURNING * INTO v_line;

  RETURN v_line;
END;
$function$;

-- ─── 2. reopen_count_session — flip a submitted bin back while the run is open ─

CREATE OR REPLACE FUNCTION public.reopen_count_session(p_session_id uuid)
 RETURNS public.count_sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_session public.count_sessions;
  v_run public.count_runs;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can reopen count sessions' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_session FROM public.count_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session % not found', p_session_id USING ERRCODE = '22023';
  END IF;

  IF v_session.status = 'in_progress' THEN
    RETURN v_session;  -- idempotent
  END IF;

  -- status CHECK is 2-valued (in_progress|submitted), so here status='submitted'.
  -- The parent run must still be open — once reconciliation starts, the submitted
  -- counts have been read and the session is frozen.
  SELECT * INTO v_run FROM public.count_runs WHERE id = v_session.run_id;
  IF v_run.status != 'in_progress' THEN
    RAISE EXCEPTION 'Run is % — bins can only be reopened before the run is ended', v_run.status USING ERRCODE = '22023';
  END IF;

  UPDATE public.count_sessions SET
    status = 'in_progress',
    completed_at = NULL
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  -- Deliberately NOT clearing inventory_locations.last_counted_at:
  -- submit re-stamps it on resubmit, and a stale stamp is only a recency hint.

  RETURN v_session;
END;
$function$;

-- ─── Grants — match the other cycle-count RPCs (authenticated + service_role, no anon/PUBLIC) ─

REVOKE ALL ON FUNCTION public.record_count_line(uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_count_line(uuid, text, numeric) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.reopen_count_session(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_count_session(uuid) TO authenticated, service_role;
