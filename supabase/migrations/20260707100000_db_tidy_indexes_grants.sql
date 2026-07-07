-- DB tidy from the July 6 audit (backlog #36 quick wins):
--   1. FK indexes on the hot submission-flow paths (all verified unindexed against pg_indexes)
--   2. Drop the duplicate unexported-movements index (two byte-identical partial indexes)
--   3. Revoke anon EXECUTE on 5 internally-guarded SECURITY DEFINER RPCs
-- Idempotent throughout; safe to rerun.

-- ─── 1. FK INDEXES (submission flow) ─────────────────────────────────────────
-- log_entries(submission_id) already has idx_log_entries_submission_id — intentionally not repeated.
-- work_sessions has work_sessions_user_date_task_unique (user_id, session_date, task_id) but
-- task-scoped lookups (getTaskSummary's work_sessions!inner(task_id)) need a task_id-leading index.
create index if not exists idx_submissions_session_id on public.submissions (session_id);
create index if not exists idx_submissions_user_id    on public.submissions (user_id);
create index if not exists idx_log_entries_session_id on public.log_entries (session_id);
create index if not exists idx_log_entries_task_id    on public.log_entries (task_id);
create index if not exists idx_work_sessions_task_id  on public.work_sessions (task_id);
create index if not exists idx_entry_parts_entry_id   on public.entry_parts (entry_id);
-- Mostly-NULL FKs on the big append-only table: partial indexes, matching the house
-- pattern of idx_inventory_movements_consumed_by / _count_run.
create index if not exists idx_inventory_movements_task_id
  on public.inventory_movements (task_id) where task_id is not null;
create index if not exists idx_inventory_movements_submission_id
  on public.inventory_movements (submission_id) where submission_id is not null;

-- ─── 2. DUPLICATE INDEX DROP ─────────────────────────────────────────────────
-- idx_inv_movements_unexported and inventory_movements_unexported_idx are both
-- btree (created_at) WHERE (exported_at IS NULL). Keep the house-named one; drop the
-- other ONLY if both exist and the definitions are identical modulo the name.
do $$
declare
  v_house text;
  v_dup   text;
begin
  select indexdef into v_house from pg_indexes
   where schemaname = 'public' and indexname = 'idx_inv_movements_unexported';
  select indexdef into v_dup from pg_indexes
   where schemaname = 'public' and indexname = 'inventory_movements_unexported_idx';

  if v_house is not null and v_dup is not null
     and replace(v_dup, 'inventory_movements_unexported_idx', 'idx_inv_movements_unexported') = v_house
  then
    execute 'drop index public.inventory_movements_unexported_idx';
  end if;
end $$;

-- ─── 3. REVOKE anon EXECUTE ON GUARDED RPCS ──────────────────────────────────
-- All five are SECURITY DEFINER with internal auth guards (is_staff() / auth.uid()),
-- but anon has no business reaching them at all. Signature-agnostic: resolve via
-- pg_proc so arg-list drift never breaks the revoke. Also strip the PUBLIC grant
-- (record_crew_movement carried one, which would otherwise keep anon executable).
-- authenticated + service_role keep their explicit EXECUTE grants.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in (
         'record_crew_movement',
         'approve_intake_request',
         'reject_intake_request',
         'deactivate_location_with_recovery',
         'decommission_site_with_recovery')
  loop
    execute format('revoke execute on function %s from public', r.sig);
    execute format('revoke execute on function %s from anon', r.sig);
  end loop;
end $$;
