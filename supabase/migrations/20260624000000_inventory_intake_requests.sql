-- Backlog #19 — crew "found inventory" → manager-approved intake.
--
-- A crew member holding a part the system doesn't show files a PENDING request
-- (no stock moves). A manager approves → approve_intake_request books a
-- `receive` movement into a warehouse and, for a part not yet in the catalog,
-- creates it as a draft (is_active=false) — all inside a SECURITY DEFINER RPC
-- because crew can't write parts_catalog or receive/adjust movements directly.
--
-- Idempotent. Apply via Supabase MCP apply_migration or `supabase db push`.
-- NOTE: confirm against the live DB before applying — verify the
-- movement_endpoints_valid CHECK accepts receive (from NULL / to NOT NULL),
-- parts_catalog.category nullability, and the uuid default convention.

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.inventory_intake_requests (
  id                   uuid primary key default uuid_generate_v4(),
  part_id              text references public.parts_catalog(id),
  is_draft             boolean not null default false,
  draft_name           text,
  draft_unit           text,
  draft_department     text,
  draft_material_group text,
  quantity             numeric not null check (quantity > 0),
  target_location_id   uuid not null references public.inventory_locations(id),
  reason               text,
  status               text not null default 'pending'
                         check (status in ('pending','approved','rejected')),
  requested_by         uuid not null references public.users(id),
  reviewed_by          uuid references public.users(id),
  reviewed_at          timestamptz,
  review_note          text,
  movement_id          uuid references public.inventory_movements(id),
  booked_at            timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists idx_intake_requests_status_created
  on public.inventory_intake_requests (status, created_at desc);
create index if not exists idx_intake_requests_requested_by
  on public.inventory_intake_requests (requested_by);

-- ── RLS — crew write/read own, staff read/update all ─────────────────────────
alter table public.inventory_intake_requests enable row level security;

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'intake_insert_own'
                 and polrelid = 'public.inventory_intake_requests'::regclass) then
    create policy intake_insert_own on public.inventory_intake_requests
      for insert to authenticated
      with check (requested_by = auth.uid());
  end if;

  if not exists (select 1 from pg_policy where polname = 'intake_select_own_or_staff'
                 and polrelid = 'public.inventory_intake_requests'::regclass) then
    create policy intake_select_own_or_staff on public.inventory_intake_requests
      for select to authenticated
      using (requested_by = auth.uid() or public.is_staff());
  end if;

  if not exists (select 1 from pg_policy where polname = 'intake_update_staff'
                 and polrelid = 'public.inventory_intake_requests'::regclass) then
    create policy intake_update_staff on public.inventory_intake_requests
      for update to authenticated
      using (public.is_staff())
      with check (public.is_staff());
  end if;
  -- No delete policy: requests are an audit record.
end $$;

-- ── Realtime — live manager queue ────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_intake_requests'
  ) then
    alter publication supabase_realtime add table public.inventory_intake_requests;
  end if;
end $$;

-- ── RPC: approve ─────────────────────────────────────────────────────────────
create or replace function public.approve_intake_request(
  p_request_id uuid,
  p_note       text default null
)
returns public.inventory_intake_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req      public.inventory_intake_requests;
  v_loc_type text;
  v_part_id  text;
  v_unit     text;
  v_mid      uuid;
begin
  if not public.is_staff() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select * into v_req
  from public.inventory_intake_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Intake request not found';
  end if;

  -- Idempotent: a second approval (double-click) returns the already-booked row.
  if v_req.booked_at is not null then
    return v_req;
  end if;
  if v_req.status = 'rejected' then
    raise exception 'Request was already rejected';
  end if;

  -- Destination must be a warehouse (unbinned, for later put-away).
  select type into v_loc_type
  from public.inventory_locations
  where id = v_req.target_location_id;
  if v_loc_type is distinct from 'warehouse' then
    raise exception 'Destination must be a warehouse';
  end if;

  v_part_id := v_req.part_id;

  -- Materialize a draft part if the request didn't reference an existing SKU.
  if v_part_id is null then
    if not v_req.is_draft or v_req.draft_name is null then
      raise exception 'Request has no part and no draft details';
    end if;
    -- Derive a SKU from the name when none is given. Stays a draft for the
    -- manager to curate (Parts → Drafts). Conflict = SKU already exists → reuse.
    v_part_id := trim(both '-' from upper(regexp_replace(v_req.draft_name, '[^a-zA-Z0-9]+', '-', 'g')));
    if v_part_id is null or v_part_id = '' then
      v_part_id := 'INTAKE-' || replace(v_req.id::text, '-', '');
    end if;
    insert into public.parts_catalog (id, name, unit, department, material_group, category, is_active)
    values (
      v_part_id,
      v_req.draft_name,
      coalesce(nullif(v_req.draft_unit, ''), 'ea'),
      nullif(v_req.draft_department, ''),
      nullif(v_req.draft_material_group, ''),
      coalesce(
        nullif(concat_ws(' / ', nullif(v_req.draft_department, ''), nullif(v_req.draft_material_group, '')), ''),
        'Uncategorized'
      ),
      false
    )
    on conflict (id) do nothing;
  end if;

  select unit into v_unit from public.parts_catalog where id = v_part_id;

  -- Book the receive movement (trigger updates inventory_stock). Tag the note
  -- with [intake:<id>] mirroring the Sonar [sonar:<id>] convention.
  insert into public.inventory_movements
    (movement_type, part_id, quantity, unit, from_location_id, to_location_id, notes, created_by)
  values (
    'receive',
    v_part_id,
    v_req.quantity,
    coalesce(v_unit, 'ea'),
    null,
    v_req.target_location_id,
    trim(both ' ' from coalesce(v_req.reason, '') || ' [intake:' || v_req.id || ']'),
    auth.uid()
  )
  returning id into v_mid;

  update public.inventory_intake_requests
  set status      = 'approved',
      part_id     = v_part_id,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = p_note,
      movement_id = v_mid,
      booked_at   = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end $$;

-- ── RPC: reject ──────────────────────────────────────────────────────────────
create or replace function public.reject_intake_request(
  p_request_id uuid,
  p_note       text default null
)
returns public.inventory_intake_requests
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.inventory_intake_requests;
begin
  if not public.is_staff() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  update public.inventory_intake_requests
  set status      = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_note = p_note
  where id = p_request_id
    and status = 'pending'
  returning * into v_req;

  if not found then
    raise exception 'Request not found or already reviewed';
  end if;

  return v_req;
end $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
revoke all on function public.approve_intake_request(uuid, text) from public;
revoke all on function public.reject_intake_request(uuid, text) from public;
grant execute on function public.approve_intake_request(uuid, text) to authenticated;
grant execute on function public.reject_intake_request(uuid, text) to authenticated;
