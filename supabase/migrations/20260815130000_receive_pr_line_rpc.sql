-- receive_pr_line: atomic per-line PR receiving (backlog #47b)
--
-- The JS receivePurchaseRequestLine was a non-atomic read-modify-write: the
-- receive movement booked BEFORE received_qty advanced, so a failure between
-- the two left stock received with the line still "outstanding" (re-receiving
-- double-books), and two managers receiving the same line concurrently both
-- passed the remaining check. This RPC does the whole sequence in one
-- transaction with the line + header row-locked:
--   lock line -> lock header -> validate (not cancelled, has target, part
--   resolved, remaining >= qty) -> insert receive movement -> advance
--   received_qty -> recompute header status (received / partial).
--
-- p_part_id resolves a freeform line (no catalog part) at receive time — it
-- is persisted onto the line, same as the old JS. Movement fields mirror the
-- old JS exactly: vendor_invoice = line.vendor, unit_cost = line.unit_cost,
-- notes = 'Received from <PR> · <reason>', created_by = auth.uid().
--
-- Staff-gated (42501) like the sibling approve_* RPCs; accounting scope is
-- role=manager so is_staff() covers it. Grants match the house pattern
-- (authenticated + service_role, no anon/PUBLIC).

create or replace function public.receive_pr_line(
  p_line_id  uuid,
  p_quantity numeric,
  p_part_id  text default null
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
     null, v_pr.target_location_id,
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

revoke execute on function public.receive_pr_line(uuid, numeric, text) from public, anon;
grant execute on function public.receive_pr_line(uuid, numeric, text) to authenticated, service_role;
