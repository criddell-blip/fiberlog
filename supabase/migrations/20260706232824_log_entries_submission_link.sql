-- Backlog #2 follow-up: same-day second passdown must not clobber the first.
--
-- Under the is_closed model a task stays open across multiple passdowns, so a
-- session can legitimately carry MULTIPLE submissions. But log_entries were
-- only linked to the SESSION, which caused two bugs:
--   1. TaskWorkspace.handleSubmit deleted prior pending/flagged submissions
--      per-session, destroying the first same-day submission + its entries.
--   2. approve_submission's auto-deduct aggregated entry_parts scoped by
--      session — approving each of two coexisting submissions would deduct
--      the UNION of both (double-deduct).
--
-- Fix: log_entries.submission_id (CASCADE — deleting a flagged submission in
-- the flag-fix replace flow must take its entries with it), backfill where
-- unambiguous, and make approve_submission's auto-deduct submission-scoped
-- with a legacy session-scoped fallback for pre-fix rows.

-- 1) Column (idempotent; inline FK only created when the column is new)
alter table public.log_entries
  add column if not exists submission_id uuid
  references public.submissions(id) on delete cascade;

-- 2) Index
create index if not exists idx_log_entries_submission_id
  on public.log_entries(submission_id);

-- 3) Backfill: link every unlinked entry whose session has EXACTLY ONE
--    submission. Ambiguous multi-submission sessions stay NULL (they keep
--    working via the legacy session fallback in approve_submission).
update public.log_entries le
set submission_id = s.id
from public.submissions s
where s.session_id = le.session_id
  and le.submission_id is null
  and (select count(*) from public.submissions s2
       where s2.session_id = le.session_id) = 1;

-- 4) approve_submission: auto-deduct WHERE clause becomes linked-preferred.
--    Linked entries always win; the legacy session-scoped path only fires
--    when the submission has NO linked entries at all — so pre-fix rows keep
--    working and linked entries can never leak into another submission's
--    deduct. Everything else is byte-identical to the live definition.
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
        INSERT INTO public.inventory_movements (
          movement_type, part_id, quantity, unit,
          from_location_id, to_location_id,
          notes, task_id, submission_id, created_by,
          consumed_by_user_id, phase_id
        )
        SELECT
          'transfer',
          ep.part_id,
          SUM(ep.quantity),
          pc.unit,
          v_truck,
          v_bucket,
          'Auto-deduct on submission approval',
          v_task_id,
          p_submission_id,
          v_caller_id,
          v_sub.user_id,
          v_phase_id
        FROM public.entry_parts ep
        JOIN public.log_entries le ON le.id = ep.entry_id
        LEFT JOIN public.parts_catalog pc ON pc.id = ep.part_id
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
        GROUP BY ep.part_id, pc.unit
        HAVING SUM(ep.quantity) > 0;
      END IF;
    END IF;
  END IF;

  RETURN v_sub;
END;
$function$;

-- 5) Grants: re-assert the existing posture (authenticated + service_role
--    execute; anon/public do not). CREATE OR REPLACE preserves the ACL, but
--    keep this explicit for the migration record.
revoke all on function public.approve_submission(uuid, text) from public, anon;
grant execute on function public.approve_submission(uuid, text) to authenticated, service_role;
