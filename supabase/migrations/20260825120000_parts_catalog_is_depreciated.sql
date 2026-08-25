-- Depreciated ("no-value") parts tagging — backlog #37.
--
-- Used/recovered equipment (site decommissions, refurb-adjacent gear) must be
-- tracked normally in FiberLog but flagged so accounting doesn't book it as
-- new inventory value. Part-level flag (not per-movement): movements are
-- immutable and mixed stock is indistinguishable at consumption time — a part
-- that exists in both conditions gets a separate "(Used)" SKU by convention.
--
-- Consumers:
--   • Sage export KEEPS flagged lines but appends a [no-value] marker to the
--     MEMO cell (buildSageCsv) so accounting filters in Sage. PRICE and
--     isExportableMovement are untouched.
--   • Parts admin (edit form + badge + CSV column) and Receive PO inline part
--     creation are the tag entry points.
--
-- Inert to the deployed bundle (new column, default false) — safe to apply
-- before the JS deploy, and MUST be live before it.

alter table public.parts_catalog
  add column if not exists is_depreciated boolean not null default false;

comment on column public.parts_catalog.is_depreciated is
  'No-value flag: used/recovered gear tracked normally but marked [no-value] in the Sage export MEMO so accounting does not book it as new inventory value (backlog #37).';
