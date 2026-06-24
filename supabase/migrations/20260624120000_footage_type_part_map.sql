-- footage_type_part_map: maps a crew footage "type" pick (fiber strand count or
-- conduit size) to the canonical parts_catalog SKU that footage should consume.
-- Sibling-table conventions mirrored from sonar_fiber_value_map / sonar_city_bucket_map:
--   * auth read (using true), staff ALL-write (is_staff()), updated_at bumped by trigger.
-- Idempotent; safe to rerun. NOT added to realtime publication (not needed). No seed rows.

create table if not exists public.footage_type_part_map (
  kind        text not null check (kind in ('fiber','conduit')),
  type_value  text not null,
  part_id     text not null references public.parts_catalog(id),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.users(id),
  primary key (kind, type_value)
);

alter table public.footage_type_part_map enable row level security;

-- updated_at bump trigger (mirrors scbm_touch_updated_at pattern)
create or replace function public.ftpm_touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_ftpm_touch_updated_at on public.footage_type_part_map;
create trigger trg_ftpm_touch_updated_at
  before update on public.footage_type_part_map
  for each row execute function public.ftpm_touch_updated_at();

-- RLS: authenticated read, staff write (insert/update/delete via ALL)
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.footage_type_part_map'::regclass
      and polname = 'ftpm_read'
  ) then
    create policy ftpm_read on public.footage_type_part_map
      for select to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.footage_type_part_map'::regclass
      and polname = 'ftpm_staff_write'
  ) then
    create policy ftpm_staff_write on public.footage_type_part_map
      for all to authenticated
      using (public.is_staff())
      with check (public.is_staff());
  end if;
end $$;
