-- Manager edit-then-approve (parts + hours) for PENDING crew submissions.
--
-- Lets an owner/manager correct a pending submission's materials and hours in
-- place, then approve — instead of flagging the whole passdown back to the crew
-- to rework and resubmit (the common flag reason is "the materials are wrong").
--
-- Atomically replaces the submission's parts (consolidated onto ONE linked
-- log_entry) and optionally corrects hours_worked. Immutable after approval:
-- guarded on status='pending' / actuals_applied_at IS NULL so a manager can
-- never rewrite already-deducted inventory. Submission-scoped: every write is
-- keyed to THIS submission's linked entries, so a same-session sibling passdown
-- is never touched. Mirrors approve_submission's SECURITY DEFINER + is_staff()
-- posture and save_log_entry's jsonb part extraction.
--
-- entry_parts has NO unit column (unit lives in parts_catalog), so the payload
-- carries only part_id + quantity. Only entry_parts are rewritten — log_entries
-- rows (and their footage_amt / assembly_*) are untouched, so submissions.total_*
-- rollups and phases.*_actual stay consistent. Editing parts changes only the
-- material deduction (approve_submission aggregates the live entry_parts at
-- approval time); hours writes submissions.hours_worked (the field every
-- report/summary/pill reads — work_sessions.hours_worked is unused).

CREATE OR REPLACE FUNCTION public.replace_submission_parts(
  p_submission_id uuid,
  p_parts         jsonb DEFAULT '[]'::jsonb,
  p_hours         numeric DEFAULT NULL
)
RETURNS public.submissions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub      public.submissions;
  v_task_id  uuid;
  v_entry_id uuid;
BEGIN
  -- 1) Staff-only.
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can edit submissions'
      USING ERRCODE = '42501';
  END IF;

  -- 2) Lock the submission row.
  SELECT * INTO v_sub FROM public.submissions
   WHERE id = p_submission_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission % not found', p_submission_id
      USING ERRCODE = 'P0002';
  END IF;

  -- 3) Pending-only. After approval the passdown is immutable (movements posted).
  IF v_sub.actuals_applied_at IS NOT NULL OR v_sub.status <> 'pending' THEN
    RAISE EXCEPTION 'Submission % is not editable (status=%, approved_at=%)',
      p_submission_id, v_sub.status, v_sub.actuals_applied_at
      USING ERRCODE = '42501';
  END IF;

  -- 4) Resolve the task for this submission's session.
  SELECT ws.task_id INTO v_task_id
    FROM public.work_sessions ws
   WHERE ws.id = v_sub.session_id;

  -- 5) Resolve the ONE canonical linked entry:
  --    (a) an entry already linked to THIS submission,
  --    (b) else adopt a legacy unlinked session/task entry (stamp submission_id),
  --    (c) else mint a fresh linked material entry (part-less passdown).
  SELECT id INTO v_entry_id
    FROM public.log_entries
   WHERE submission_id = p_submission_id
   ORDER BY created_at NULLS FIRST, id
   LIMIT 1;

  IF v_entry_id IS NOT NULL THEN
    -- Consolidate: wipe entry_parts under ALL of this submission's linked
    -- entries (leaving the log_entries + their footage intact), then re-add
    -- onto the canonical one below. Scoped by submission_id => siblings safe.
    DELETE FROM public.entry_parts ep
     USING public.log_entries le
     WHERE ep.entry_id = le.id
       AND le.submission_id = p_submission_id;
  ELSE
    SELECT id INTO v_entry_id
      FROM public.log_entries
     WHERE session_id = v_sub.session_id
       AND submission_id IS NULL
       AND (task_id IS NULL OR task_id = v_task_id)
     ORDER BY created_at NULLS FIRST, id
     LIMIT 1;

    IF v_entry_id IS NOT NULL THEN
      UPDATE public.log_entries
         SET submission_id = p_submission_id
       WHERE id = v_entry_id;
      DELETE FROM public.entry_parts WHERE entry_id = v_entry_id;
    ELSE
      INSERT INTO public.log_entries
        (session_id, user_id, task_id, entry_type, submission_id)
      VALUES
        (v_sub.session_id, v_sub.user_id, v_task_id, 'material', p_submission_id)
      RETURNING id INTO v_entry_id;
    END IF;
  END IF;

  -- 6) Insert the new parts onto the canonical entry, consolidated per part_id,
  --    skipping null/blank part_id and non-positive quantities.
  INSERT INTO public.entry_parts (entry_id, part_id, quantity, is_extra)
  SELECT
    v_entry_id,
    (p->>'part_id')::text,
    SUM((p->>'quantity')::numeric),
    false
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) AS p
  WHERE (p->>'part_id') IS NOT NULL
    AND (p->>'part_id') <> ''
    AND COALESCE((p->>'quantity')::numeric, 0) > 0
  GROUP BY (p->>'part_id')::text
  HAVING SUM((p->>'quantity')::numeric) > 0;

  -- 7) Optional hours correction (submissions is authoritative for hours).
  IF p_hours IS NOT NULL THEN
    UPDATE public.submissions
       SET hours_worked = p_hours
     WHERE id = p_submission_id
    RETURNING * INTO v_sub;
  END IF;

  RETURN v_sub;
END;
$function$;

REVOKE ALL ON FUNCTION public.replace_submission_parts(uuid, jsonb, numeric) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.replace_submission_parts(uuid, jsonb, numeric) TO authenticated, service_role;
