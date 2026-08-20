-- Field returns + refurbished twin parts (Sage `_R` items).
--
-- Sage gives returned/refurbished CPE its own item ID (UB000531_R beside
-- UB000531). FiberLog had one SKU per item and ONE kind of receipt, so a Wave
-- LR pulled off a customer's wall came back into stock looking brand new and
-- nothing downstream (Activity, reports, Sage export) could tell a purchase
-- from a field return. Owner, Aug 20 2026: new units are received under the
-- normal ID; once used and returned they must come back as `_R`, logged by
-- crew/field techs AND by the warehouse manager, and the manager's receipt
-- must be labelled differently from new-purchase receipts so the transactions
-- can be separated.
--
-- Two additions:
--   1. inventory_movements.receipt_kind — WHY stock arrived. Until now that
--      was sniffed out of `notes` ('[intake:…]', 'Vendor: …', 'BoxHero seed')
--      by two helpers that already disagreed. Only meaningful on `receive`
--      rows; a BEFORE INSERT trigger defaults it to 'purchase' so every
--      existing writer (Receive PO, receive_pr_line, imports) is covered
--      without being touched, and forces NULL on non-receives.
--   2. parts_catalog.refurb_of — the refurbished twin's pointer at its parent
--      SKU. A refurb is a real part (sage_id = parent's + '_R'), so load /
--      consume / export need no special handling at all.
--
-- Backfill of receipt_kind is a receipt_kind-only UPDATE, which passes the
-- column-scoped immutability trigger with it ENABLED (same pattern as
-- occurred_at, migration 20260702). receipt_kind is then ADDED to that
-- trigger's guard list — it is semantic and must be as immutable as notes.

-- ── 1. receipt_kind ──────────────────────────────────────────────────────────

alter table public.inventory_movements
  add column if not exists receipt_kind text;

alter table public.inventory_movements
  drop constraint if exists inventory_movements_receipt_kind_check;
alter table public.inventory_movements
  add constraint inventory_movements_receipt_kind_check
  check (receipt_kind is null
         or receipt_kind in ('purchase', 'field_return', 'found', 'decommission', 'seed'));

-- Only receives carry a kind.
alter table public.inventory_movements
  drop constraint if exists inventory_movements_receipt_kind_only_on_receive;
alter table public.inventory_movements
  add constraint inventory_movements_receipt_kind_only_on_receive
  check (receipt_kind is null or movement_type = 'receive');

comment on column public.inventory_movements.receipt_kind is
  'Why stock arrived (receive rows only): purchase = vendor/PO, field_return = pulled from a customer/site and booked onto the refurb twin, found = crew-reported found inventory, decommission = site teardown, seed = one-time BoxHero baseline. Defaulted to purchase by trigger; immutable.';

-- Backfill existing receives. receipt_kind-only UPDATE → passes
-- trg_inv_movement_immutable as it stands today. Order matters: specific
-- markers first, then everything else is a purchase.
update public.inventory_movements
   set receipt_kind = 'found'
 where movement_type = 'receive' and receipt_kind is null
   and notes ~ '\[intake:';

update public.inventory_movements
   set receipt_kind = 'seed'
 where movement_type = 'receive' and receipt_kind is null
   and notes ilike 'BoxHero seed%';

update public.inventory_movements
   set receipt_kind = 'purchase'
 where movement_type = 'receive' and receipt_kind is null;

-- Default going forward, so no writer can leave a receive unkinded and no
-- non-receive can carry a stray kind.
create or replace function public.inv_movement_receipt_kind_default()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.movement_type = 'receive' then
    if new.receipt_kind is null then
      new.receipt_kind := 'purchase';
    end if;
  else
    new.receipt_kind := null;
  end if;
  return new;
end $$;

drop trigger if exists trg_inv_movement_receipt_kind_default on public.inventory_movements;
create trigger trg_inv_movement_receipt_kind_default
  before insert on public.inventory_movements
  for each row execute function public.inv_movement_receipt_kind_default();

-- Make it immutable alongside the other core fields.
create or replace function public.prevent_movement_modification()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.movement_type     is distinct from new.movement_type
  or old.part_id           is distinct from new.part_id
  or old.quantity          is distinct from new.quantity
  or old.unit              is distinct from new.unit
  or old.from_location_id  is distinct from new.from_location_id
  or old.to_location_id    is distinct from new.to_location_id
  or old.task_id           is distinct from new.task_id
  or old.submission_id     is distinct from new.submission_id
  or old.vendor_invoice    is distinct from new.vendor_invoice
  or old.unit_cost         is distinct from new.unit_cost
  or old.notes             is distinct from new.notes
  or old.created_by        is distinct from new.created_by
  or old.created_at        is distinct from new.created_at
  or old.receipt_kind      is distinct from new.receipt_kind
  then
    raise exception 'inventory_movements core fields are immutable. Create a counter-movement instead.'
      using hint = 'Only exported_at and export_batch_id can change after creation.';
  end if;
  return new;
end $$;

-- ── 2. refurb_of ─────────────────────────────────────────────────────────────

alter table public.parts_catalog
  add column if not exists refurb_of text references public.parts_catalog(id);

alter table public.parts_catalog
  drop constraint if exists parts_catalog_refurb_of_not_self;
alter table public.parts_catalog
  add constraint parts_catalog_refurb_of_not_self
  check (refurb_of is null or refurb_of <> id);

-- One refurbished twin per parent.
create unique index if not exists parts_catalog_refurb_of_idx
  on public.parts_catalog (refurb_of)
  where refurb_of is not null;

comment on column public.parts_catalog.refurb_of is
  'Set on a refurbished twin part: the parent (new-unit) SKU. Field returns are booked onto the twin, whose sage_id is the parent''s with an _R suffix.';

-- ── 3. intake requests: kind ─────────────────────────────────────────────────

alter table public.inventory_intake_requests
  add column if not exists intake_kind text not null default 'found';
alter table public.inventory_intake_requests
  drop constraint if exists inventory_intake_requests_intake_kind_check;
alter table public.inventory_intake_requests
  add constraint inventory_intake_requests_intake_kind_check
  check (intake_kind in ('found', 'field_return'));

-- approve_intake_request: same signature (grants are per-signature). Changes:
--   • stamps receipt_kind from intake_kind
--   • field returns may target a BIN (the "Returns – to test" bin), not just
--     a warehouse; found inventory keeps its warehouse-only rule
--   • field returns resolve to the part's refurb twin when one exists, so a
--     crew picking "Wave LR" books "Wave LR (Refurbished)" / UB000531_R
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
  v_twin_id  text;
  v_unit     text;
  v_mid      uuid;
  v_kind     text;
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

  if v_req.booked_at is not null then
    return v_req;
  end if;
  if v_req.status = 'rejected' then
    raise exception 'Request was already rejected';
  end if;

  v_kind := case when v_req.intake_kind = 'field_return' then 'field_return' else 'found' end;

  -- Returned gear is by definition an existing catalog part; a draft field
  -- return would mint an inactive part with no twin to land on. The crew UI
  -- already forbids this — make the server agree.
  if v_kind = 'field_return' and v_req.part_id is null then
    raise exception 'A field return must reference an existing catalog part';
  end if;

  select type into v_loc_type
  from public.inventory_locations
  where id = v_req.target_location_id;
  if v_kind = 'field_return' then
    if v_loc_type not in ('warehouse', 'bin') then
      raise exception 'Destination must be a warehouse or bin';
    end if;
  elsif v_loc_type is distinct from 'warehouse' then
    raise exception 'Destination must be a warehouse';
  end if;

  v_part_id := v_req.part_id;

  if v_part_id is null then
    if not v_req.is_draft or v_req.draft_name is null then
      raise exception 'Request has no part and no draft details';
    end if;
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

  -- Field return: book onto the refurbished twin when the catalog has one
  -- (a request that already names the twin passes through unchanged).
  if v_kind = 'field_return' then
    select id into v_twin_id from public.parts_catalog
     where refurb_of = v_part_id and is_active limit 1;
    if v_twin_id is not null then
      v_part_id := v_twin_id;
    end if;
  end if;

  select unit into v_unit from public.parts_catalog where id = v_part_id;

  insert into public.inventory_movements
    (movement_type, part_id, quantity, unit, from_location_id, to_location_id, notes, created_by, receipt_kind)
  values (
    'receive',
    v_part_id,
    v_req.quantity,
    coalesce(v_unit, 'ea'),
    null,
    v_req.target_location_id,
    trim(both ' ' from coalesce(v_req.reason, '') || ' [intake:' || v_req.id || ']'),
    auth.uid(),
    v_kind
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

-- ── 4. Seed: the 8 refurb twins accounting already has _R items for, and the
--        returns bin. Idempotent.

insert into public.parts_catalog
  (id, name, unit, department, material_group, item_type, category, sonar_routing, is_active, refurb_of, sage_id, attributes)
select
  p.id || '-R',
  p.name || ' (Refurbished)',
  p.unit, p.department, p.material_group, p.item_type, p.category, p.sonar_routing,
  true,
  p.id,
  p.sage_id || '_R',
  jsonb_build_object('created_via', jsonb_build_object('source', 'migration', 'detail', 'refurb twin seed 2026-08-21'))
from public.parts_catalog p
where p.id in ('GP1100X','GP4200XH','100-06034','100-06062','SKU-X5KIIVQE','Wave-Pico-US','Wave-LR-US','Wave-Nano')
  and p.sage_id is not null
on conflict (id) do nothing;

insert into public.inventory_locations (name, type, parent_location_id, is_active)
select 'Returns – to test', 'bin', w.id, true
from public.inventory_locations w
where w.id = 'c5e35d66-4c31-4a5d-b857-93e9270d6b24'   -- Main Warehouse locations
  and not exists (
    select 1 from public.inventory_locations b
    where b.parent_location_id = w.id and b.name = 'Returns – to test'
  );
