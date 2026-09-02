-- Per-line asset tags on passdown materials (infra crew).
--
-- Infrastructure crews install serialized gear (radios, switches, routers) and
-- the site record needs to know WHICH unit went in — the asset tag / serial —
-- not just "1 × Rocket 5AC". entry_parts.line_note is a free-text note per
-- part line ("AT-1042, AT-1043" for a qty-2 line); the crew types it on the
-- submit sheet and approval copies it onto the auto-deduct movement as
-- inventory_movements.line_note so the ledger — the site's View-materials
-- drilldown, Activity, the raw-history CSV — carries the tag forever.
--
-- Deliberately NOT appended to inventory_movements.notes: that column is the
-- fixed 'Auto-deduct on submission approval' string that the occurred_at
-- backfill (20260828) keys on, and it sits inside the immutable-guard list.
-- line_note is a separate nullable column outside the guard (same posture as
-- sonar_account_id / purchase_request_line_id) so a typo can be corrected
-- later with a plain UPDATE.
--
-- The merge identity for part lines stays (part_id, source_location_id) —
-- a note never splits a line into a second movement. Where two lines with
-- the same identity collapse (replace_submission_parts, approve_submission)
-- their notes concatenate with ', '.
--
-- NULL everywhere today; every writer that omits the key behaves exactly as
-- before, so this ships ahead of the UI.

-- ─── 1) Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.entry_parts
  ADD COLUMN IF NOT EXISTS line_note text;

COMMENT ON COLUMN public.entry_parts.line_note IS
  'Free-text per-line note from the crew — asset tags / serials for infra gear. Copied onto the auto-deduct movement at approval.';

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS line_note text;

COMMENT ON COLUMN public.inventory_movements.line_note IS
  'Asset tags / serials carried from entry_parts.line_note by approve_submission (string_agg per part+source). Nullable; deliberately outside prevent_movement_modification so a typo stays correctable.';

-- ─── 2) save_log_entry — write the note through ─────────────────────────────

CREATE OR REPLACE FUNCTION public.save_log_entry(p_session_id uuid, p_user_id uuid, p_task_id uuid, p_entry_type text, p_assembly_id text DEFAULT NULL::text, p_assembly_qty integer DEFAULT 1, p_footage_amt numeric DEFAULT NULL::numeric, p_note_text text DEFAULT NULL::text, p_parts jsonb DEFAULT '[]'::jsonb)
 RETURNS log_entries
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entry public.log_entries;
BEGIN
  -- A non-null source must be an active truck or group. Reject the whole
  -- entry rather than silently nulling — a wrong source corrupts whose
  -- truck gets deducted at approval.
  PERFORM 1
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) AS p
  WHERE COALESCE(p->>'source_location_id', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_locations il
      WHERE il.id = (p->>'source_location_id')::uuid
        AND il.type IN ('truck', 'group')
        AND il.is_active = true
    );
  IF FOUND THEN
    RAISE EXCEPTION 'source_location_id must reference an active truck or group location'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.log_entries (
    session_id, user_id, task_id, entry_type,
    assembly_id, assembly_qty, footage_amt, note_text
  ) VALUES (
    p_session_id, p_user_id, p_task_id, p_entry_type,
    p_assembly_id, p_assembly_qty, p_footage_amt, p_note_text
  )
  RETURNING * INTO v_entry;

  -- Skip rows missing part_id or with non-positive quantity. Anything
  -- worse (FK violation, type cast failure) raises and rolls back the
  -- parent insert too. line_note: blank → NULL so "" never lands.
  INSERT INTO public.entry_parts (entry_id, part_id, quantity, is_extra, source_location_id, line_note)
  SELECT
    v_entry.id,
    (p->>'part_id')::text,
    (p->>'quantity')::numeric,
    COALESCE((p->>'is_extra')::boolean, false),
    NULLIF(p->>'source_location_id', '')::uuid,
    NULLIF(btrim(p->>'line_note'), '')
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) AS p
  WHERE (p->>'part_id') IS NOT NULL
    AND COALESCE((p->>'quantity')::numeric, 0) > 0;

  RETURN v_entry;
END;
$function$;

-- ─── 3) replace_submission_parts — notes survive manager edits ──────────────

CREATE OR REPLACE FUNCTION public.replace_submission_parts(p_submission_id uuid, p_parts jsonb DEFAULT '[]'::jsonb, p_hours numeric DEFAULT NULL::numeric)
 RETURNS submissions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sub      public.submissions;
  v_task_id  uuid;
  v_entry_id uuid;
BEGIN
  IF NOT public.is_staff() THEN
    RAISE EXCEPTION 'Only owners and managers can edit submissions'
      USING ERRCODE = '42501';
  END IF;

  -- Same source validation as save_log_entry: a bad id corrupts whose truck
  -- gets deducted.
  PERFORM 1
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) AS p
  WHERE COALESCE(p->>'source_location_id', '') <> ''
    AND NOT EXISTS (
      SELECT 1 FROM public.inventory_locations il
      WHERE il.id = (p->>'source_location_id')::uuid
        AND il.type IN ('truck', 'group')
        AND il.is_active = true
    );
  IF FOUND THEN
    RAISE EXCEPTION 'source_location_id must reference an active truck or group location'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_sub FROM public.submissions
   WHERE id = p_submission_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission % not found', p_submission_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_sub.actuals_applied_at IS NOT NULL OR v_sub.status <> 'pending' THEN
    RAISE EXCEPTION 'Submission % is not editable (status=%, approved_at=%)',
      p_submission_id, v_sub.status, v_sub.actuals_applied_at
      USING ERRCODE = '42501';
  END IF;

  SELECT ws.task_id INTO v_task_id
    FROM public.work_sessions ws
   WHERE ws.id = v_sub.session_id;

  SELECT id INTO v_entry_id
    FROM public.log_entries
   WHERE submission_id = p_submission_id
   ORDER BY created_at NULLS FIRST, id
   LIMIT 1;

  IF v_entry_id IS NOT NULL THEN
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

  -- Consolidate per (part, source): the same SKU from two trucks stays two
  -- rows because it becomes two movements at approval. Notes on collapsing
  -- lines concatenate — an asset tag must never be dropped by a merge.
  INSERT INTO public.entry_parts (entry_id, part_id, quantity, is_extra, source_location_id, line_note)
  SELECT
    v_entry_id,
    (t.p->>'part_id')::text,
    SUM((t.p->>'quantity')::numeric),
    false,
    NULLIF(t.p->>'source_location_id', '')::uuid,
    NULLIF(string_agg(NULLIF(btrim(t.p->>'line_note'), ''), ', ' ORDER BY t.ord), '')
  FROM jsonb_array_elements(COALESCE(p_parts, '[]'::jsonb)) WITH ORDINALITY AS t(p, ord)
  WHERE (t.p->>'part_id') IS NOT NULL
    AND (t.p->>'part_id') <> ''
    AND COALESCE((t.p->>'quantity')::numeric, 0) > 0
  GROUP BY (t.p->>'part_id')::text, NULLIF(t.p->>'source_location_id', '')::uuid
  HAVING SUM((t.p->>'quantity')::numeric) > 0;

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

-- ─── 4) approve_submission — carry the notes onto the movement ──────────────
-- Body is the 20260828 version plus line_note in the auto-deduct INSERT.

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
        --
        -- line_note = every asset tag the crew typed on the lines that fold
        -- into this movement (string_agg — one SKU can arrive as several
        -- entry_parts rows across the session's entries).
        INSERT INTO public.inventory_movements (
          movement_type, part_id, quantity, unit,
          from_location_id, to_location_id,
          notes, task_id, submission_id, created_by,
          consumed_by_user_id, phase_id, occurred_at, line_note
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
          v_sub.created_at,
          NULLIF(string_agg(NULLIF(btrim(ep.line_note), ''), ', ' ORDER BY ep.created_at, ep.id), '')
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
