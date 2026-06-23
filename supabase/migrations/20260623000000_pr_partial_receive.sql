-- Purchase Request: per-line + partial receiving.
--
-- Adds received tracking to PR lines so a manager can receive items
-- individually and in partial quantities (3 of 10 today, the rest later),
-- and introduces a 'partial' PR status for the in-between state.
--
-- Idempotent. Apply via Supabase MCP `apply_migration` or `supabase db push`.

-- 1. Per-line received tracking (running counter; null/0 = not received).
alter table public.purchase_request_lines
  add column if not exists received_qty numeric not null default 0,
  add column if not exists received_at  timestamptz;

-- 2. Allow the 'partial' status. The original CHECK constraint name isn't
--    assumed — drop whichever check on the table references `status`, then
--    re-add the expanded set.
do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.purchase_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';
  if c is not null then
    execute format('alter table public.purchase_requests drop constraint %I', c);
  end if;
end $$;

alter table public.purchase_requests
  add constraint purchase_requests_status_check
  check (status in ('pending','ordered','partial','received','cancelled'));

-- 3. Backfill: PRs already marked 'received' pre-date per-line tracking, so
--    treat each of their lines as fully received for a consistent display.
update public.purchase_request_lines pl
set received_qty = pl.quantity
from public.purchase_requests pr
where pl.request_id = pr.id
  and pr.status = 'received'
  and coalesce(pl.received_qty, 0) = 0;
