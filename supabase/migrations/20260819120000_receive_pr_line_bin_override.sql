-- receive_pr_line: optional bin destination override (Create-PO / receive-PO work)
--
-- The PR receive flow always landed stock at the header's target_location_id
-- (warehouse-level). With the bin-first direction, the dock crew should be
-- able to put a delivery straight into a bin without a second bin-move.
-- New defaulted arg p_to_location_id:
--   NULL                      -> target_location_id (unchanged behavior)
--   = target_location_id      -> same as NULL
--   a bin under the target    -> receive lands at the bin
--   anything else             -> rejected (receiving into an unrelated
--                                location stays impossible)
--
-- Grants are per-signature, so the 3-arg function is dropped and recreated
-- with the defaulted 4th arg. Old 3-named-arg PostgREST calls still resolve,
-- so this deploys safely before the JS that passes the new arg.

drop function if exists public.receive_pr_line(uuid, numeric, text);

create or replace function public.receive_pr_line(
  p_line_id        uuid,
  p_quantity       numeric,
  p_part_id        text default null,
  p_to_location_id uuid default null
) returns public.purchase_requests
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_line         public.purchase_request_lines;
  v_pr           public.purchase_requests;
  v_part_id      text;
  v_unit         text;
  v_remaining    numeric;
  v_all_received boolean;
  v_dest         uuid;
  v_loc          public.inventory_locations;
begin
  if not public.is_staff() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than 0' using errcode = '22023';
  end if;

  select * into v_line
  from public.purchase_request_lines
  where id = p_line_id
  for update;
  if not found then
    raise exception 'PR line not found';
  end if;

  select * into v_pr
  from public.purchase_requests
  where id = v_line.request_id
  for update;
  if not found then
    raise exception 'PR not found';
  end if;
  if v_pr.status = 'cancelled' then
    raise exception 'PR is cancelled';
  end if;
  if v_pr.target_location_id is null then
    raise exception 'PR has no "Deliver to" location set — open the PR and pick one before receiving';
  end if;

  -- Resolve destination: the PR's target, or a bin directly under it.
  v_dest := v_pr.target_location_id;
  if p_to_location_id is not null and p_to_location_id <> v_pr.target_location_id then
    select * into v_loc from public.inventory_locations where id = p_to_location_id;
    if not found or v_loc.type <> 'bin'
       or v_loc.parent_location_id is distinct from v_pr.target_location_id then
      raise exception 'Destination must be the PR''s "Deliver to" location or a bin inside it';
    end if;
    v_dest := p_to_location_id;
  end if;

  -- A movement needs a real catalog part. Freeform lines must bring one in.
  v_part_id := coalesce(v_line.part_id, p_part_id);
  if v_part_id is null then
    raise exception 'This freeform line has no catalog part — link or create one before receiving';
  end if;
  select unit into v_unit from public.parts_catalog where id = v_part_id;
  if not found then
    raise exception 'Part "%" is not in the catalog', v_part_id;
  end if;

  v_remaining := coalesce(v_line.quantity, 0) - coalesce(v_line.received_qty, 0);
  if v_remaining <= 0 then
    raise exception 'This line is already fully received';
  end if;
  if p_quantity - v_remaining > 1e-9 then
    raise exception 'Can only receive up to % more on this line', v_remaining;
  end if;

  -- Book the receive (trigger updates inventory_stock).
  insert into public.inventory_movements
    (movement_type, part_id, quantity, unit,
     from_location_id, to_location_id,
     vendor_invoice, unit_cost, notes, created_by)
  values
    ('receive', v_part_id, p_quantity, coalesce(v_unit, 'ea'),
     null, v_dest,
     nullif(v_line.vendor, ''), v_line.unit_cost,
     'Received from ' || v_pr.pr_number
       || coalesce(' · ' || nullif(v_line.project_reason, ''), ''),
     auth.uid());

  -- Advance the counter (and persist a freeform line's resolved part_id).
  update public.purchase_request_lines
  set part_id      = v_part_id,
      received_qty = coalesce(received_qty, 0) + p_quantity,
      received_at  = now()
  where id = p_line_id;

  -- Recompute header status from the full (now-updated) line set.
  select bool_and(coalesce(received_qty, 0) >= coalesce(quantity, 0))
    into v_all_received
  from public.purchase_request_lines
  where request_id = v_pr.id;

  if coalesce(v_all_received, false) then
    update public.purchase_requests
    set status = 'received', received_at = coalesce(received_at, now())
    where id = v_pr.id;
  elsif v_pr.status in ('pending', 'ordered') then
    -- Something (this line) is received but not everything — partial.
    update public.purchase_requests set status = 'partial' where id = v_pr.id;
  end if;

  select * into v_pr from public.purchase_requests where id = v_pr.id;
  return v_pr;
end $$;

revoke execute on function public.receive_pr_line(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.receive_pr_line(uuid, numeric, text, uuid) to authenticated, service_role;
