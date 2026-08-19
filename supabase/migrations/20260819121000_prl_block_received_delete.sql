-- Block deleting purchase_request_lines that have received stock.
--
-- replacePurchaseRequestLines (delete-all + reinsert) guards on
-- received_qty client-side, but that's check-then-act: manager A can pass
-- the check while manager B's receive_pr_line commits at the dock, and A's
-- delete then wipes the received_qty counters — leaving the header stuck on
-- 'partial' over all-zero lines that can be received AGAIN (double-booked
-- stock, while the movement ledger keeps the originals). This trigger makes
-- the guard authoritative at the row level: any received line survives, so
-- the race aborts A's replace instead of corrupting the counters. Same
-- posture as the #47c delete guard, enforced server-side.
--
-- Fires on cascaded deletes from the header too, which matches
-- deletePurchaseRequest's client-side refusal.

create or replace function public.prl_block_received_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if coalesce(old.received_qty, 0) > 0 then
    raise exception 'Line "%" has received stock — it can''t be deleted or replaced',
      coalesce(nullif(old.description, ''), old.part_id, old.id::text);
  end if;
  return old;
end $$;

drop trigger if exists trg_prl_block_received_delete on public.purchase_request_lines;
create trigger trg_prl_block_received_delete
  before delete on public.purchase_request_lines
  for each row execute function public.prl_block_received_delete();
