-- Service projects: a non-grant sibling per BEAD project.
--
-- Each project's Region bucket (inventory_locations.type='job_site') is the
-- consumption ledger behind the Sage export and BEAD reimbursement. The grant
-- reimburses material on installs, not repairs — but nothing in the ledger
-- separated the two (West Mountain Aug 2026: 4 fix-job ONTs + 8 fix-job drop
-- units sat in the grant bucket looking exactly like install material).
--
-- Model (owner decision Sep 3 2026): a sibling project "<name> - Service"
-- points at its grant parent via service_for_project_id. It gets its own
-- trigger-created Region bucket (ensure_project_job_site fires on the INSERT
-- below) and one phase "Service". The importers route any Sonar job type
-- containing the word "Fix" to the sibling (src/lib/serviceRouting.js), crews
-- log repair days against the Service phase, and every reader that keys on
-- project (Reports, Sage PROJECTID, Parts history) separates the two ledgers
-- with no further change. "Has a sibling" IS the grant-restricted flag.

alter table public.projects
  add column if not exists service_for_project_id uuid
    references public.projects(id) on delete set null;

-- No self-reference; at most one sibling per parent (serviceProjectFor()
-- would otherwise be nondeterministic).
alter table public.projects
  drop constraint if exists projects_service_not_self;
alter table public.projects
  add constraint projects_service_not_self
    check (service_for_project_id is null or service_for_project_id <> id);

create unique index if not exists projects_service_for_project_uniq
  on public.projects (service_for_project_id)
  where service_for_project_id is not null;

comment on column public.projects.service_for_project_id is
  'Set on a non-grant "Service" sibling: the BEAD project whose fix-job material this project absorbs. NULL on every ordinary project. A project with a sibling is grant-restricted.';

-- ─── Reclass provenance on movements ────────────────────────────────────────
-- Moving consumption between two Regions after the fact is a Region→Region
-- transfer (counter-movement — inventory_movements core fields are immutable,
-- see prevent_movement_modification). reclass_of names the row being moved so
-- Activity / Reports can show "reclassed" state and cap the quantity at what
-- remains, without parsing notes (the fail-open marker pattern).
--
-- Insert-only enrichment, deliberately OUTSIDE the immutable-guard column
-- list — same posture as line_note / sonar_account_id / occurred_at.
alter table public.inventory_movements
  add column if not exists reclass_of uuid
    references public.inventory_movements(id);

create index if not exists inventory_movements_reclass_of_idx
  on public.inventory_movements (reclass_of)
  where reclass_of is not null;

comment on column public.inventory_movements.reclass_of is
  'For a Region→Region reclass transfer: the consumption movement being moved. NULL otherwise. Set on insert only; outside prevent_movement_modification.';

-- ─── Seed: West Mountain - Service ──────────────────────────────────────────
-- Only West Mountain is grant-restricted today (owner, Sep 8 2026). Other BEAD
-- projects get a sibling from the Projects admin ("Create Service sibling")
-- when the owner decides. Idempotent on name; ASCII hyphen on purpose — the
-- bucket name and the Sage PROJECTID are this string verbatim.
insert into public.projects (name, region, status, service_for_project_id)
select 'West Mountain - Service', p.region, 'active', p.id
  from public.projects p
 where p.id = 'a1b2c3d4-0001-0001-0001-000000000001'
   and not exists (select 1 from public.projects s where s.name = 'West Mountain - Service');

insert into public.phases (project_id, name, sequence_order)
select s.id, 'Service', 1
  from public.projects s
 where s.name = 'West Mountain - Service'
   and not exists (select 1 from public.phases ph where ph.project_id = s.id);
