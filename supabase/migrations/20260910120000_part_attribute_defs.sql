-- part_attribute_defs — owner-defined attributes that apply to every part.
--
-- Until now parts_catalog.attributes was a free-form key/value bag typed by
-- hand, one part at a time, in the Parts tab. Nothing constrained the keys, so
-- nothing was comparable across parts: the live catalog had 627 active parts
-- and exactly two hand-typed attributes between them ("Nickname", which
-- duplicated the real column, and "Part number"). This table is the registry
-- that makes the bag standard — the owner defines an attribute once here and
-- every part-editing surface renders it as a labeled, typed field.
--
-- Values still live in parts_catalog.attributes, keyed by `key`, so adding an
-- attribute is a row here and never a schema migration. Consequences of that
-- choice, encoded below:
--   * `key` is immutable (trg_pad_key_immutable). Renaming it would orphan
--     every stored value; the label is the editable display name instead.
--   * `created_via` is reserved — it's the system creation stamp written by
--     Receive PO / Sonar / PR / CSV import, and it lives in the same bag.
--     A def may not claim it, and the two RPCs below refuse to touch it.
--
-- Sibling-table conventions mirrored from footage_type_part_map:
-- auth read, staff ALL-write via is_staff(), updated_at bumped by trigger,
-- idempotent, NOT in the realtime publication. No seed rows — the owner
-- defines their own list in Admin -> Part attributes.

create table if not exists public.part_attribute_defs (
  id            uuid primary key default gen_random_uuid(),
  -- Storage key inside parts_catalog.attributes. Lowercase snake so it reads
  -- cleanly as a CSV header and can never collide by case.
  key           text not null unique
                  check (key ~ '^[a-z][a-z0-9_]{0,39}$' and key <> 'created_via'),
  label         text not null check (length(btrim(label)) > 0),
  input_type    text not null default 'text'
                  check (input_type in ('text','number','boolean','select')),
  -- Pick-list for input_type='select'. This is where standardization actually
  -- comes from: "Corning" vs "corning" vs "Corning Inc" stops being possible.
  options       text[] not null default '{}',
  required      boolean not null default false,
  -- Scope. Empty = every part. Otherwise only parts in these departments,
  -- the same axis crew_type_part_restrictions already uses. Fiber count on a
  -- cable is useful; on a router it's noise.
  applies_to_departments text[] not null default '{}',
  help_text     text,
  -- Opt-in extra line on the printed SKU label.
  show_on_label boolean not null default false,
  sort_order    integer not null default 0,
  -- Retire instead of delete: hides the field from forms, keeps stored values.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.users(id),
  -- A pick-list with nothing to pick is a broken field, not an empty one.
  constraint pad_select_needs_options
    check (input_type <> 'select' or coalesce(array_length(options, 1), 0) >= 1)
);

create index if not exists part_attribute_defs_sort_idx
  on public.part_attribute_defs (sort_order, label);

alter table public.part_attribute_defs enable row level security;

-- updated_at bump (mirrors ftpm_touch_updated_at)
create or replace function public.pad_touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_pad_touch_updated_at on public.part_attribute_defs;
create trigger trg_pad_touch_updated_at
  before update on public.part_attribute_defs
  for each row execute function public.pad_touch_updated_at();

-- The key is the join to every stored value. Changing it would silently orphan
-- all of them, so it can't be changed at all — edit the label instead.
create or replace function public.pad_key_immutable()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.key is distinct from old.key then
    raise exception 'part_attribute_defs.key is immutable (% -> %); stored values on parts_catalog.attributes are keyed by it. Delete the attribute and add a new one instead.', old.key, new.key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pad_key_immutable on public.part_attribute_defs;
create trigger trg_pad_key_immutable
  before update on public.part_attribute_defs
  for each row execute function public.pad_key_immutable();

-- RLS: authenticated read (crew part search reads attribute values, and the
-- labels belong with them), staff write.
do $$
begin
  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.part_attribute_defs'::regclass and polname = 'pad_read'
  ) then
    create policy pad_read on public.part_attribute_defs
      for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policy
    where polrelid = 'public.part_attribute_defs'::regclass and polname = 'pad_staff_write'
  ) then
    create policy pad_staff_write on public.part_attribute_defs
      for all to authenticated
      using (public.is_staff()) with check (public.is_staff());
  end if;
end $$;

-- ─── Bulk value writes ──────────────────────────────────────────────────────
-- Filling an attribute across hundreds of existing parts is the whole point of
-- defining one, and a JSONB merge is a read-modify-write. Doing it in SQL keeps
-- it atomic per row, so a concurrent Receive PO stamping created_via on the
-- same part can't lose either write.

create or replace function public.set_part_attribute(
  p_part_ids text[],
  p_key      text,
  p_value    jsonb default null,
  p_clear    boolean default false
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer;
begin
  if not public.is_staff() then
    raise exception 'Only staff can set part attributes' using errcode = '42501';
  end if;
  if p_key = 'created_via' then
    raise exception 'created_via is a reserved system stamp' using errcode = '42501';
  end if;
  if p_part_ids is null or array_length(p_part_ids, 1) is null then
    return 0;
  end if;

  if p_clear then
    update public.parts_catalog
       set attributes = coalesce(attributes, '{}'::jsonb) - p_key
     where id = any(p_part_ids);
  else
    update public.parts_catalog
       set attributes = coalesce(attributes, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
     where id = any(p_part_ids);
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Used when an attribute definition is deleted and the owner opts to drop the
-- values with it, rather than leaving them behind as unlabeled leftovers.
create or replace function public.purge_part_attribute(p_key text)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer;
begin
  if not public.is_staff() then
    raise exception 'Only staff can purge part attributes' using errcode = '42501';
  end if;
  if p_key = 'created_via' then
    raise exception 'created_via is a reserved system stamp' using errcode = '42501';
  end if;

  update public.parts_catalog
     set attributes = attributes - p_key
   where attributes ? p_key;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_part_attribute(text[], text, jsonb, boolean) from public;
revoke all on function public.purge_part_attribute(text) from public;
grant execute on function public.set_part_attribute(text[], text, jsonb, boolean) to authenticated;
grant execute on function public.purge_part_attribute(text) to authenticated;

-- ─── Repair: created_via flattened to "[object Object]" ─────────────────────
-- The Parts tab's old free-form editor read every attribute value through
-- String(value), so opening and saving a part whose created_via was an object
-- destroyed the stamp. Three parts were hit. The text carries no information,
-- so drop the key rather than keep a lie; the typed editor replacing that form
-- leaves reserved keys untouched, so it can't happen again.
update public.parts_catalog
   set attributes = attributes - 'created_via'
 where jsonb_typeof(attributes -> 'created_via') = 'string'
   and attributes ->> 'created_via' = '[object Object]';

comment on table public.part_attribute_defs is
  'Owner-defined part attributes. Values live in parts_catalog.attributes keyed by `key` (immutable). Empty applies_to_departments = applies to every part. created_via is reserved for the system creation stamp.';
