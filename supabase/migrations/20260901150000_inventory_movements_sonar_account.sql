-- inventory_movements.sonar_account_id — the Sonar "Account | ID" a consumption
-- row belongs to. Both Sonar importers stamp it going forward (asset report +
-- fiber-jobs), which is what lets Reports join the two families into one
-- per-account "full job picture": the fiber-jobs marker already embeds the
-- account, but the asset report's movements recorded only the customer name
-- and the Sonar item id — no account anywhere.
--
-- Insert-only enrichment: deliberately NOT added to the immutable-guard column
-- list in prevent_movement_modification (that list is explicit), and nullable
-- so every existing writer is unaffected. Same posture as
-- purchase_request_line_id (20260822120000) — late enrichment/backfill of this
-- column must stay possible without trigger ceremony.

alter table public.inventory_movements
  add column if not exists sonar_account_id text;

create index if not exists inventory_movements_sonar_account_idx
  on public.inventory_movements (sonar_account_id)
  where sonar_account_id is not null;

comment on column public.inventory_movements.sonar_account_id is
  'Sonar Account | ID this consumption row belongs to (both Sonar import families stamp it). Nullable; deliberately outside prevent_movement_modification so backfill/enrichment stays possible.';

-- ─── Deterministic backfill from each row''s own notes ───────────────────────
-- Guard-safe: only sonar_account_id is written (never notes — that column IS
-- in the immutable-guard list).
--
-- Fiber-jobs rows carry the account inside their dedup marker:
--   [sonar_jobs:<acct>_YYYY-MM-DD_<jobtype>]
update public.inventory_movements
   set sonar_account_id = (regexp_match(notes, '\[sonar_jobs:(\d+)_'))[1]
 where sonar_account_id is null
   and notes like '%[sonar_jobs:%';

-- Asset-report rows that used the composite fallback marker carry it too:
--   [sonar:<acct>-<Date Time>]   (pure item-id markers [sonar:12345] have no
--   dash and don''t match — those need the raw-CSV recovery script,
--   scripts/backfill-sonar-accounts.mjs)
update public.inventory_movements
   set sonar_account_id = (regexp_match(notes, '\[sonar:(\d+)-'))[1]
 where sonar_account_id is null
   and notes ~ '\[sonar:\d+-';
