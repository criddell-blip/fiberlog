-- Merge crew types 'aerial' + 'underground' into one 'fiber_construction' class.
--
-- ⚠️ ALREADY APPLIED to production on 2026-06-25 via the Supabase MCP
-- (recorded in the remote migration history as version 20260625132634).
-- This file exists for repo ↔ prod history parity / fresh-rebuild fidelity.
-- It is idempotent; `supabase db push` skips it because the version is already
-- recorded remotely.
--
-- This changes only the WORKER-CLASSIFICATION axis (public.users.crew_type +
-- the crew_type_part_restrictions whitelist). The independent WORK-LOGGING axis
-- (assemblies.crew_type, tasks.task_type, the aerial/footage/splice/underground
-- workspace tabs) is intentionally NOT touched — fiber crews keep the same tabs.
--
-- Legacy 'aerial'/'underground' are kept VALID in both CHECKs for back-compat
-- (no orphaning of any historical row that might still carry them).

-- ─── 1. Widen the two crew_type CHECK constraints ───────────────────────────
-- users.crew_type — add 'fiber_construction' (keep legacy values).
alter table public.users drop constraint if exists users_crew_type_check;
alter table public.users add constraint users_crew_type_check
  check (
    (crew_type is null) or (crew_type = any (array[
      'aerial', 'underground', 'splice', 'drop', 'locator',
      'contractor', 'install', 'infrastructure', 'fiber_tech', 'fiber_construction'
    ]))
  );

-- crew_type_part_restrictions.crew_type — its OWN CHECK must be widened BEFORE
-- inserting fiber_construction rows below (the first apply attempt failed 23514
-- until this was added).
alter table public.crew_type_part_restrictions
  drop constraint if exists crew_type_part_restrictions_crew_type_check;
alter table public.crew_type_part_restrictions
  add constraint crew_type_part_restrictions_crew_type_check
  check (crew_type = any (array[
    'aerial', 'underground', 'splice', 'drop', 'locator',
    'contractor', 'install', 'infrastructure', 'fiber_construction'
  ]));

-- ─── 2. Migrate existing users (8 aerial + 3 underground → 11 fiber_construction) ─
update public.users
   set crew_type = 'fiber_construction'
 where crew_type in ('aerial', 'underground');

-- ─── 3. Re-key the part-restriction whitelist (dedupe) ──────────────────────
-- Insert a fiber_construction row for each distinct department previously keyed
-- to aerial OR underground, then drop the old rows. ON CONFLICT DO NOTHING folds
-- the (aerial X, underground X) pair down to a single (fiber_construction, X).
insert into public.crew_type_part_restrictions (crew_type, department)
select distinct 'fiber_construction', department
  from public.crew_type_part_restrictions
 where crew_type in ('aerial', 'underground')
on conflict do nothing;

delete from public.crew_type_part_restrictions
 where crew_type in ('aerial', 'underground');

-- ─── 4. Add 'fiber_construction' to the approve_submission auto-deduct guard ──
-- Recreated verbatim from the live definition with 'fiber_construction' appended
-- to the crew_type IN-list (everything else unchanged).
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

  -- Phase actuals — fiber-only by design. Infra tasks have phase_id NULL
  -- and skip this block.
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

  IF v_task_id IS NOT NULL THEN
    UPDATE public.tasks SET
      status            = 'approved',
      working_counts    = '{}'::jsonb,
      last_worked_by    = NULL,
      last_worked_at    = NULL
    WHERE id = v_task_id;
  END IF;

  -- Auto-deduct
  IF v_task_id IS NOT NULL THEN
    SELECT crew_type, default_pull_location_id INTO v_submitter_ct, v_pull_loc
    FROM public.users WHERE id = v_sub.user_id;

    IF v_submitter_ct IN ('aerial','underground','splice','infrastructure','fiber_tech','fiber_construction') THEN
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
        WHERE le.session_id = v_sub.session_id
          AND (le.task_id IS NULL OR le.task_id = v_task_id)
          AND ep.quantity > 0
        GROUP BY ep.part_id, pc.unit
        HAVING SUM(ep.quantity) > 0;
      END IF;
    END IF;
  END IF;

  RETURN v_sub;
END;
$function$;
