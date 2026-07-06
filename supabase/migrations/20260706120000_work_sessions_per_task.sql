-- Backlog #2 (is_closed model) follow-up: work_sessions become one-per-(user, day, task).
--
-- Why: under the new is_closed task model a crew member works several open tasks in
-- one day. The old unique key (user_id, session_date) forced all of a day's work onto
-- ONE session row: its task_id got overwritten to the latest task, and handleSubmit's
-- session-scoped submission cleanup then deleted earlier tasks' pending submissions.
-- Widening the key to (user_id, session_date, task_id) isolates each task's session.
-- (JS startSession already upserts onConflict 'user_id,session_date,task_id'.)

-- ─── Change 1 — swap the unique index ────────────────────────────────────────
-- Existing one-per-day rows already satisfy the wider key (it's a superset), so no
-- backfill is needed. task_id is nullable; Postgres treats NULLs as distinct in a
-- unique index, which is fine — crew flows always pass task_id. Do NOT add NOT NULL.
-- The old key is a UNIQUE *constraint* (index can't be dropped directly); find it
-- name-agnostically by its definition and drop the constraint.
do $$
declare c text;
begin
  select conname into c from pg_constraint
  where conrelid = 'public.work_sessions'::regclass and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (user_id, session_date)';
  if c is not null then
    execute format('alter table public.work_sessions drop constraint %I', c);
  end if;
end $$;

create unique index if not exists work_sessions_user_date_task_unique
  on public.work_sessions (user_id, session_date, task_id);

-- ─── Change 2 — crew_activity_today: one row per crew user ────────────────────
-- With per-task sessions a crew user can have multiple work_sessions rows today; the
-- old LEFT JOIN would emit one row per session and break CrewStatus (keys on user_id).
-- Collapse to exactly one row per crew user: the LATEST session's task/status as the
-- "current" activity, and the SUMMED day totals for entry_count / footage / hours.
-- CREATE OR REPLACE preserves the view's existing security posture (definer) + grants.
create or replace view public.crew_activity_today as
select
  u.id            as user_id,
  u.name,
  u.initials,
  u.crew_type,
  u.is_contractor,
  latest.id       as session_id,
  latest.status   as session_status,
  agg.entry_count,
  agg.footage_total,
  latest.updated_at as last_activity,
  latest.task_id,
  t.name          as current_task,
  coalesce(ph.name, si.name) as current_phase,
  p.name          as current_project,
  agg.hours_worked,
  latest.session_date
from public.users u
left join lateral (
  select ws.* from public.work_sessions ws
  where ws.user_id = u.id and ws.session_date = current_date
  order by ws.updated_at desc nulls last
  limit 1
) latest on true
left join lateral (
  select sum(ws.entry_count)::int as entry_count,
         sum(ws.footage_total)    as footage_total,
         sum(ws.hours_worked)     as hours_worked
  from public.work_sessions ws
  where ws.user_id = u.id and ws.session_date = current_date
) agg on true
left join public.tasks t     on latest.task_id = t.id
left join public.phases ph   on t.phase_id = ph.id
left join public.sites si    on t.site_id = si.id
left join public.projects p  on p.id = coalesce(ph.project_id, si.project_id)
where u.role = 'crew' and u.is_active = true;
