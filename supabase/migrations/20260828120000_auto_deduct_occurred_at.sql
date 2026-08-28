-- Auto-deduct movements: stamp occurred_at with the passdown's submit time.
--
-- The Reports tab dates Passdowns by submissions.created_at (when the crew
-- submitted) but Consumption by movementEffectiveDate = occurred_at ?? created_at
-- — and approve_submission never set occurred_at, so crew consumption was dated
-- by APPROVAL time. Whenever a manager approved across a week/month boundary the
-- two views disagreed (Aug 2026: "This week" showed 936 ft of strand in
-- Passdowns vs 7,966 ft in Consumption — three passdowns submitted Aug 20–21
-- were approved Aug 24–28). The Sage export reads the same effective date, so
-- month-end approvals were sliding work into the next accounting period too.
--
-- Fix: the auto-deduct INSERT stamps occurred_at = the submission's created_at.
-- v_sub is re-read via RETURNING * after the status UPDATE, but created_at is
-- untouched by that UPDATE so it still carries the original submit time.
-- Backfill covers every existing auto-deduct row that carries submission_id
-- (198 rows / 42 submissions as of Aug 28 2026). 24 June rows predate both
-- submission_id and task_id stamping and cannot be linked — left NULL; they
-- keep dating by created_at, which is within days of the submit time anyway.
--
-- Safety: occurred_at-only UPDATE — the column-scoped trg_inv_movement_immutable
-- trigger does not guard occurred_at (see 20260702000000). Idempotent.

-- ─── 1) approve_submission — stamp occurred_at on the auto-deduct ────────────

CREATE OR REPLACE FUNCTION public.approve_submission(p_submission_id uuid, p_note text DEFAULT NULL::text)
 RETURNS submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller_id    uuid;
  v_caller_role  text;
  v_sub          public.submissions;
  v_phase_id     uuid;
  v_site_id      uuid;
  v_task_id      uuid;
  v_project_id   uuid;
  v_submitter_ct text;
  v_truck        uuid;
  v_pull_loc     uuid;
  v_bucket       uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_caller_role FROM public.users WHERE id = v_caller_id;
  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile row' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'Only owners and managers can approve submissions'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub FROM public.submissions
   WHERE id = p_submission_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission % not found', p_submission_id
      USING ERRCODE = 'P0002';
  END IF;
  IF v_sub.actuals_applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'Submission % was already approved at %',
      p_submission_id, v_sub.actuals_applied_at
      USING ERRCODE = '23505';
  END IF;

  SELECT ws.task_id, t.phase_id, t.site_id
    INTO v_task_id, v_phase_id, v_site_id
  FROM public.work_sessions ws
  LEFT JOIN public.tasks t ON t.id = ws.task_id
  WHERE ws.id = v_sub.session_id;

  IF v_phase_id IS NOT NULL THEN
    UPDATE public.phases SET
      strand_ft_actual   = COALESCE(strand_ft_actual,   0) + COALESCE(v_sub.total_strand_ft,    0),
      fiber_ft_actual    = COALESCE(fiber_ft_actual,    0) + COALESCE(v_sub.total_fiber_ft,     0),
      conduit_ft_actual  = COALESCE(conduit_ft_actual,  0) + COALESCE(v_sub.total_conduit_ft,   0),
      mst_hst_actual     = COALESCE(mst_hst_actual,     0) + COALESCE(v_sub.total_mst_hst,      0),
      splice_case_actual = COALESCE(splice_case_actual, 0) + COALESCE(v_sub.total_splice_cases, 0),
      handhole_actual    = COALESCE(handhole_actual,    0) + COALESCE(v_sub.total_handholes,    0),
      vault_actual       = COALESCE(vault_actual,       0) + COALESCE(v_sub.total_vaults,       0)
    WHERE id = v_phase_id;
  END IF;

  UPDATE public.submissions SET
    status             = 'approved',
    reviewed_by        = v_caller_id,
    manager_notes      = p_note,
    reviewed_at        = now(),
    actuals_applied_at = now()
  WHERE id = p_submission_id
  RETURNING * INTO v_sub;

  -- Backlog #2: mirror status only. Do NOT clear working_counts /
  -- last_worked_by / last_worked_at — the task stays open across multiple
  -- passdowns; the manager closes it explicitly via tasks.is_closed.
  IF v_task_id IS NOT NULL THEN
    UPDATE public.tasks SET status = 'approved' WHERE id = v_task_id;
  END IF;

  IF v_task_id IS NOT NULL THEN
    SELECT crew_type, default_pull_location_id INTO v_submitter_ct, v_pull_loc
    FROM public.users WHERE id = v_sub.user_id;

    IF v_submitter_ct IN ('aerial','underground','splice','infrastructure','fiber_tech','fiber_construction','field_service') THEN
      IF v_sub.project_id_override IS NOT NULL THEN
        v_project_id := v_sub.project_id_override;
      ELSIF v_phase_id IS NOT NULL THEN
        SELECT project_id INTO v_project_id FROM public.phases WHERE id = v_phase_id;
      ELSIF v_site_id IS NOT NULL THEN
        SELECT project_id INTO v_project_id FROM public.sites WHERE id = v_site_id;
      END IF;

      IF v_pull_loc IS NOT NULL THEN
        v_truck := v_pull_loc;
      ELSE
        SELECT id INTO v_truck
        FROM public.inventory_locations
        WHERE assigned_to = v_sub.user_id
          AND type = 'truck'
          AND is_active = true
        ORDER BY created_at ASC LIMIT 1;
      END IF;

      SELECT id INTO v_bucket
      FROM public.inventory_locations
      WHERE project_id = v_project_id
        AND type = 'job_site'
        AND is_active = true
      LIMIT 1;

      IF v_truck IS NOT NULL AND v_bucket IS NOT NULL THEN
        -- One transfer per (part, source truck). Untagged lines
        -- (source_location_id NULL) deduct from the submitter's truck and
        -- keep the submitter as consumed_by — exactly the pre-source
        -- behavior. Tagged lines deduct from the tagged truck/group and
        -- attribute consumption to that truck's owner (falling back to the
        -- submitter for groups, which have no assigned_to).
        --
        -- occurred_at = the passdown's submit time, NOT now(): approval can
        -- lag the work by days, and Consumption / Sage date by occurred_at.
        INSERT INTO public.inventory_movements (
          movement_type, part_id, quantity, unit,
          from_location_id, to_location_id,
          notes, task_id, submission_id, created_by,
          consumed_by_user_id, phase_id, occurred_at
        )
        SELECT
          'transfer',
          ep.part_id,
          SUM(ep.quantity),
          pc.unit,
          COALESCE(ep.source_location_id, v_truck),
          v_bucket,
          'Auto-deduct on submission approval',
          v_task_id,
          p_submission_id,
          v_caller_id,
          CASE WHEN ep.source_location_id IS NOT NULL
               THEN COALESCE(src.assigned_to, v_sub.user_id)
               ELSE v_sub.user_id END,
          v_phase_id,
          v_sub.created_at
        FROM public.entry_parts ep
        JOIN public.log_entries le ON le.id = ep.entry_id
        LEFT JOIN public.parts_catalog pc ON pc.id = ep.part_id
        LEFT JOIN public.inventory_locations src ON src.id = ep.source_location_id
        WHERE (
            le.submission_id = p_submission_id
            OR (
              le.submission_id IS NULL
              AND le.session_id = v_sub.session_id
              AND (le.task_id IS NULL OR le.task_id = v_task_id)
              AND NOT EXISTS (
                SELECT 1 FROM public.log_entries le2
                WHERE le2.submission_id = p_submission_id
              )
            )
          )
          AND ep.quantity > 0
        GROUP BY ep.part_id, pc.unit, ep.source_location_id, src.assigned_to
        HAVING SUM(ep.quantity) > 0;
      END IF;
    END IF;
  END IF;

  RETURN v_sub;
END;
$function$;

-- ─── 2) Backfill existing auto-deduct rows from their submission ────────────

UPDATE public.inventory_movements m
   SET occurred_at = s.created_at
  FROM public.submissions s
 WHERE s.id = m.submission_id
   AND m.occurred_at IS NULL
   AND m.notes = 'Auto-deduct on submission approval';
