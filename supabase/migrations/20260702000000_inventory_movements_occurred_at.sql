-- inventory_movements.occurred_at: the real work/job date, distinct from
-- created_at (the import/insert timestamp). Phase 1 of consumption reporting.
--
-- Nullable, NO default. Import families embed the true date in `notes`; crew +
-- auto-deduct rows leave it NULL because for them created_at ≈ work date.
-- Consumers COALESCE(occurred_at, created_at).
--
-- Safety: the BEFORE UPDATE trigger trg_inv_movement_immutable
-- (fn prevent_movement_modification) is column-scoped and guards 13 core fields
-- INCLUDING notes, but NOT occurred_at (brand new). The backfill sets occurred_at
-- ONLY — parsing the date from notes in-place in the SET expression — so it passes
-- with the trigger LEFT ENABLED. Do NOT disable the trigger; do NOT touch notes
-- (or any core field) in the same UPDATE.
--
-- Nullable + no default → no table rewrite (brief metadata lock only). Table is
-- NOT in the realtime publication, so this is metadata-only DDL. Idempotent.

alter table public.inventory_movements
  add column if not exists occurred_at timestamptz;

-- Backfill from both import families. A single \d{4}-\d{2}-\d{2} token catches:
--   * fiber-jobs import: marker [sonar_jobs:<acct>_YYYY-MM-DD_<jobtype>]
--   * field-tech import: prose prefix "Sonar install · YYYY-MM-DD HH:MM · …"
-- Exactly one date token per row (verified). occurred_at-only update.
update public.inventory_movements
   set occurred_at = (substring(notes from '\d{4}-\d{2}-\d{2}'))::timestamptz
 where notes ~ '\d{4}-\d{2}-\d{2}'
   and occurred_at is null;
