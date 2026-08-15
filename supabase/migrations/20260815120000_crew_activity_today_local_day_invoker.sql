-- crew_activity_today: Utah-local "today" + security_invoker (backlog #45 + #46)
--
-- #45: the view filtered ws.session_date = CURRENT_DATE, which is the SERVER
-- (UTC) date — it rolls to tomorrow at ~5pm MST / 6pm MDT, exactly when the
-- client-side startSession stamp used to roll too. startSession now writes the
-- LOCAL date (lib/format.js isoLocalDate), so the view must define "today" the
-- same way: (now() AT TIME ZONE 'America/Denver')::date. America/Denver tracks
-- MST/MDT automatically.
--
-- #46: the July 2026 rewrite (20260706120000_work_sessions_per_task.sql)
-- recreated the view without security_invoker, tripping the Supabase advisor's
-- ERROR-level security_definer_view lint. Set it here; the consumer
-- (getTodaySessions → CrewStatus, staff-only UI) reads tables authenticated
-- users can already read, and the JS wrapper degrades to [] on failure.
--
-- CREATE OR REPLACE (not DROP) so existing grants survive. Same column list —
-- OR REPLACE requires it anyway.

CREATE OR REPLACE VIEW public.crew_activity_today
WITH (security_invoker = on) AS
 SELECT u.id AS user_id,
    u.name,
    u.initials,
    u.crew_type,
    u.is_contractor,
    latest.id AS session_id,
    latest.status AS session_status,
    agg.entry_count,
    agg.footage_total,
    latest.updated_at AS last_activity,
    latest.task_id,
    t.name AS current_task,
    COALESCE(ph.name, si.name) AS current_phase,
    p.name AS current_project,
    agg.hours_worked,
    latest.session_date
   FROM users u
     LEFT JOIN LATERAL ( SELECT ws.id,
            ws.created_at,
            ws.updated_at,
            ws.user_id,
            ws.task_id,
            ws.session_date,
            ws.status,
            ws.entry_count,
            ws.footage_total,
            ws.hours_worked,
            ws.submitted_at,
            ws.notes
           FROM work_sessions ws
          WHERE ws.user_id = u.id
            AND ws.session_date = (now() AT TIME ZONE 'America/Denver')::date
          ORDER BY ws.updated_at DESC NULLS LAST
         LIMIT 1) latest ON true
     LEFT JOIN LATERAL ( SELECT sum(ws.entry_count)::integer AS entry_count,
            sum(ws.footage_total) AS footage_total,
            sum(ws.hours_worked) AS hours_worked
           FROM work_sessions ws
          WHERE ws.user_id = u.id
            AND ws.session_date = (now() AT TIME ZONE 'America/Denver')::date) agg ON true
     LEFT JOIN tasks t ON latest.task_id = t.id
     LEFT JOIN phases ph ON t.phase_id = ph.id
     LEFT JOIN sites si ON t.site_id = si.id
     LEFT JOIN projects p ON p.id = COALESCE(ph.project_id, si.project_id)
  WHERE u.role = 'crew'::text AND u.is_active = true;
