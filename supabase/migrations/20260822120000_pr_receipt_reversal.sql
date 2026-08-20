-- PO receipt reversal ("credit a mis-receipt back to the PO")
--
-- Receipts were one-way: received_qty only grew, and a line with any receipt
-- locked the PR. When the dock received 10 but 8 arrived, or booked the wrong
-- part, the only fix was a hand adjust that left the PO saying "received" and
-- lost the outstanding balance. This adds the counter-path:
--
--   1. inventory_movements.purchase_request_line_id — provenance link from a
--      movement to the PR line it booked (stamped by receive_pr_line and by
--      the reversal). Lets the UI show "received into <bin>" and default the
--      reversal's source to wherever the goods actually landed. Insert-only:
--      not in the immutable-guard column list (that list is explicit), and
--      nullable so every existing writer is unaffected.
--   2. receive_pr_line re-created (same 4-arg signature) to stamp the link.
--   3. reverse_pr_line_receipt — staff-gated, atomic: books an `adjust` OUT of
--      the chosen location, lowers the line's received_qty, recomputes the
--      header status (all lines back to 0 -> 'ordered', so the PR unlocks).
--
-- Why `adjust`: quantity must be > 0 so a negative receive is impossible;
-- issue/scrap would export to Sage as consumption. `adjust` is already dropped
-- by isExportableMovement exactly like the receive it cancels — Sage sees
-- neither (accounting corrects the PO in Sage directly). Scoped to purchase
-- receipts only; field returns / found intake have no PO to credit.

alter table public.inventory_movements
  add column if not exists purchase_request_line_id uuid
    references public.purchase_request_lines(id) on delete set null;

create index if not exists inventory_movements_pr_line_idx
  on public.inventory_movements (purchase_request_line_id)
  where purchase_request_line_id is not null;

-- ─── receive_pr_line: stamp the provenance link ──────────────────────────────

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

  v_dest := v_pr.target_location_id;
  if p_to_location_id is not null and p_to_location_id <> v_pr.target_location_id then
    select * into v_loc from public.inventory_locations where id = p_to_location_id;
    if not found or v_loc.type <> 'bin'
       or v_loc.parent_location_id is distinct from v_pr.target_location_id then
      raise exception 'Destination must be the PR''s "Deliver to" location or a bin inside it';
    end if;
    v_dest := p_to_location_id;
  end if;

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

  insert into public.inventory_movements
    (movement_type, part_id, quantity, unit,
     from_location_id, to_location_id,
     vendor_invoice, unit_cost, notes, created_by,
     purchase_request_line_id)
  values
    ('receive', v_part_id, p_quantity, coalesce(v_unit, 'ea'),
     null, v_dest,
     nullif(v_line.vendor, ''), v_line.unit_cost,
     'Received from ' || v_pr.pr_number
       || coalesce(' · ' || nullif(v_line.project_reason, ''), ''),
     auth.uid(),
     p_line_id);

  update public.purchase_request_lines
  set part_id      = v_part_id,
      received_qty = coalesce(received_qty, 0) + p_quantity,
      received_at  = now()
  where id = p_line_id;

  select bool_and(coalesce(received_qty, 0) >= coalesce(quantity, 0))
    into v_all_received
  from public.purchase_request_lines
  where request_id = v_pr.id;

  if coalesce(v_all_received, false) then
    update public.purchase_requests
    set status = 'received', received_at = coalesce(received_at, now())
    where id = v_pr.id;
  elsif v_pr.status in ('pending', 'ordered') then
    update public.purchase_requests set status = 'partial' where id = v_pr.id;
  end if;

  select * into v_pr from public.purchase_requests where id = v_pr.id;
  return v_pr;
end $$;

revoke execute on function public.receive_pr_line(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.receive_pr_line(uuid, numeric, text, uuid) to authenticated, service_role;

-- ─── reverse_pr_line_receipt ─────────────────────────────────────────────────

create or replace function public.reverse_pr_line_receipt(
  p_line_id          uuid,
  p_quantity         numeric,
  p_from_location_id uuid,
  p_reason           text
) returns public.purchase_requests
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_line         public.purchase_request_lines;
  v_pr           public.purchase_requests;
  v_loc          public.inventory_locations;
  v_unit         text;
  v_on_hand      numeric;
  v_total_recv   numeric;
  v_all_received boolean;
  v_label        text;
begin
  if not public.is_staff() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than 0' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required to reverse a receipt' using errcode = '22023';
  end if;
  if p_from_location_id is null then
    raise exception 'Pick the location the stock is coming back out of' using errcode = '22023';
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

  if coalesce(v_line.received_qty, 0) <= 0 then
    raise exception 'Nothing has been received on this line';
  end if;
  if p_quantity - coalesce(v_line.received_qty, 0) > 1e-9 then
    raise exception 'Only % received on this line — can''t reverse more than that', v_line.received_qty;
  end if;
  if v_line.part_id is null then
    raise exception 'This line has no catalog part — nothing to reverse';
  end if;

  -- Source must be the PR's Deliver-to or a bin under it (mirror of receive).
  select * into v_loc from public.inventory_locations where id = p_from_location_id;
  if not found then
    raise exception 'Location not found';
  end if;
  if p_from_location_id <> v_pr.target_location_id
     and (v_loc.type <> 'bin' or v_loc.parent_location_id is distinct from v_pr.target_location_id) then
    raise exception 'Stock must come back out of the PR''s "Deliver to" location or a bin inside it';
  end if;

  -- Block rather than drive a bin negative: a reversal says the goods are
  -- leaving (or never arrived). If they aren't here, something else moved
  -- them and that's the record to follow. (Best-effort: inventory_stock is
  -- not row-locked here, so a concurrent issue from the same bin in the
  -- same instant can still slip under — acceptable for a staff-only
  -- correction; the line/PR locks serialize reversals against each other.)
  select coalesce(quantity, 0) into v_on_hand
  from public.inventory_stock
  where part_id = v_line.part_id and location_id = p_from_location_id;
  v_on_hand := coalesce(v_on_hand, 0);
  if p_quantity - v_on_hand > 1e-9 then
    raise exception 'Only % on hand at % — the rest was already moved. Pick the location it''s in, or move it back first.',
      v_on_hand, v_loc.name;
  end if;

  select unit into v_unit from public.parts_catalog where id = v_line.part_id;

  v_label := case when nullif(v_pr.po_number, '') is not null
                  then 'PO ' || v_pr.po_number || ' (' || v_pr.pr_number || ')'
                  else v_pr.pr_number end;

  insert into public.inventory_movements
    (movement_type, part_id, quantity, unit,
     from_location_id, to_location_id,
     vendor_invoice, unit_cost, notes, created_by,
     purchase_request_line_id)
  values
    ('adjust', v_line.part_id, p_quantity, coalesce(v_unit, 'ea'),
     p_from_location_id, null,
     nullif(v_line.vendor, ''), v_line.unit_cost,
     'Reversed receipt on ' || v_label || ' — ' || btrim(p_reason),
     auth.uid(),
     p_line_id);

  update public.purchase_request_lines
  set received_qty = greatest(coalesce(received_qty, 0) - p_quantity, 0),
      received_at  = case when coalesce(received_qty, 0) - p_quantity <= 1e-9 then null else received_at end
  where id = p_line_id;

  select coalesce(sum(coalesce(received_qty, 0)), 0),
         bool_and(coalesce(received_qty, 0) >= coalesce(quantity, 0))
    into v_total_recv, v_all_received
  from public.purchase_request_lines
  where request_id = v_pr.id;

  if v_pr.status in ('ordered', 'partial', 'received') then
    if v_total_recv <= 1e-9 then
      -- Everything reversed: back to the pre-receipt state. A PR that was
      -- never ordered (receive_pr_line doesn't gate on status) goes back to
      -- pending, not ordered.
      update public.purchase_requests
      set status = case when approved_by is null and nullif(po_number, '') is null
                        then 'pending' else 'ordered' end,
          received_at = null
      where id = v_pr.id;
    elsif coalesce(v_all_received, false) then
      update public.purchase_requests set status = 'received' where id = v_pr.id;
    else
      update public.purchase_requests
      set status = 'partial', received_at = null
      where id = v_pr.id;
    end if;
  end if;

  select * into v_pr from public.purchase_requests where id = v_pr.id;
  return v_pr;
end $$;

revoke execute on function public.reverse_pr_line_receipt(uuid, numeric, uuid, text) from public, anon;
grant execute on function public.reverse_pr_line_receipt(uuid, numeric, uuid, text) to authenticated, service_role;
