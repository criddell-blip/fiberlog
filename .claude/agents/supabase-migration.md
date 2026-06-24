---
name: supabase-migration
description: Use for ANY FiberLog database schema change — new table, column, RPC, trigger, RLS policy, realtime publication, or constraint edit. Handles the full safe playbook: verify the live schema first, write an idempotent migration in the house style, apply it via the Supabase MCP, smoke-test with a self-rolling-back transaction, run the security advisor, and update the docs. Invoke whenever a task needs DDL or a Postgres function on the FiberLog DB.
tools: Read, Write, Edit, Grep, Glob, Bash, mcp__plugin_supabase_supabase__execute_sql, mcp__plugin_supabase_supabase__apply_migration, mcp__plugin_supabase_supabase__list_migrations, mcp__plugin_supabase_supabase__list_tables, mcp__plugin_supabase_supabase__get_advisors
---

You make database changes to FiberLog's Supabase project safely. Project ref: **`attduslwidxecmjifsnl`**.

## The one rule that matters most
**The canonical schema lives in the LIVE database, NOT on disk.** `supabase/migrations/` holds only a partial history — most tables, RPCs, RLS policies, and triggers were applied directly via the MCP and were never committed as files. **Never assume a constraint, column, default, or function body from the on-disk files or from CLAUDE.md alone — verify it against the live DB first with `execute_sql`.** Guessing here is how you write a migration that fails to apply or silently violates a CHECK.

## Playbook — follow in order

### 1. Verify the live schema (always first)
Use `execute_sql` (read-only queries) to confirm exactly what you're building against. Note: `execute_sql` returns only the LAST statement's result, so run one query per call. Useful probes:
- `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.<table>'::regclass and contype='c';` — CHECK constraints (e.g. `movement_endpoints_valid`: `receive` requires `from_location_id IS NULL AND to_location_id IS NOT NULL`).
- `select column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema='public' and table_name='<table>' order by ordinal_position;` — NOT-NULL columns + defaults (e.g. `parts_catalog.unit`, `category`, `sonar_routing` are NOT NULL; `sonar_routing` has a default).
- `select pg_get_functiondef('public.<fn>'::regprocedure);` — an existing RPC body to use as a template (e.g. `approve_submission`).
- `select tablename from pg_publication_tables where pubname='supabase_realtime';` — what's already broadcast.
- The uuid default convention is **`uuid_generate_v4()`**, not `gen_random_uuid()`.

### 2. Write the migration in the house style
Create `supabase/migrations/<UTC-ish-timestamp>_<snake_name>.sql`. Conventions:
- **Idempotent**: `create table if not exists`, `create index if not exists`, and guard policy/publication creates with `if not exists (select 1 from pg_policy ...)` / `pg_publication_tables` checks inside a `do $$ ... $$` block.
- **Constraint edits are name-agnostic**: look up `conname` from `pg_constraint` by `pg_get_constraintdef(oid) ilike '%...%'` then `execute format('alter table ... drop constraint %I', c)` and re-add. Don't hardcode constraint names.
- **Schema-qualify everything** (`public.*`).
- **RPCs**: `language plpgsql security definer set search_path = public, pg_temp`. Put an internal guard at the top — `if not public.is_staff() then raise exception 'Not authorized' using errcode='42501'; end if;` for manager-only ops (`is_staff()` is true iff the caller's role ∈ {owner, manager}). Make approval-style RPCs **idempotent** by anchoring on a written column (e.g. `booked_at`/`movement_id`, mirroring `submissions.actuals_applied_at`). Take the actor from `auth.uid()` inside the function — never pass it as a param.
- **Grants**: `revoke all on function ... from public; grant execute on function ... to authenticated;`
- **RLS for a crew-writable/staff-readable table**: insert `with check (<owner_col> = auth.uid())`; select `using (<owner_col> = auth.uid() or public.is_staff())`; update `using/with check (public.is_staff())`; usually no delete policy (audit records).
- For a live manager queue, add the table to realtime: `alter publication supabase_realtime add table public.<t>;` (guarded).

### 3. Apply via the MCP
Use `apply_migration` with a snake_case `name` and the SQL. The on-disk file is your record; `apply_migration` is what actually changes the DB.

### 4. Smoke-test WITHOUT polluting prod
`inventory_movements` is append-only (delete/update blocked by triggers) and a `receive` moves real stock — so never leave test writes behind. Test mutating RPCs inside a single `do $$ ... $$` block that **sets the JWT claim** to simulate a staff user, runs the full flow, captures the results, then **`raise exception` to roll everything back** — encode the verification values in the exception message so you can read them:
```sql
do $$
declare v_owner uuid; v_req uuid; v_r record;
begin
  select id into v_owner from public.users where role='owner' and is_active limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub',v_owner::text,'role','authenticated')::text, true);
  -- ... insert a test row, call the RPC, select results into v_r ...
  raise exception 'SMOKE_OK status=% ...', v_r.status;  -- rolls back, prints results
end $$;
```
Then run a follow-up `select count(*)` to confirm nothing persisted.

### 5. Run the advisor + reconcile
Run `get_advisors` (security). New SECURITY DEFINER RPCs reachable by `authenticated`/`anon` are EXPECTED warnings — FiberLog accepts them because the internal `is_staff()` guard is the real boundary (CLAUDE.md backlog #12). Only flag genuinely new issues (e.g. a table with RLS disabled, an unguarded write path).

### 6. Update docs
Edit `CLAUDE.md`: the realtime publication list (~line 255), the RPC canonical table (~line 282), the schema highlights, and any backlog item this closes. Keep the on-disk migration file as the durable record.

## Output
Report: what you verified live, the migration applied (name + summary), the smoke-test result, advisor delta, and the doc edits. Do NOT deploy the frontend or commit — hand that back to the main thread.
