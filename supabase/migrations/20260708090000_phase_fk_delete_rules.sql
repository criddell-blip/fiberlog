-- Phase deletes were FK-blocked once the ledger referenced them:
-- inventory_movements.phase_id was ON DELETE NO ACTION, and auto-deduct +
-- the importers stamp phase_id on movements — so any worked phase could
-- never be deleted from AdminPanel (and the swallowed error produced the
-- "I deleted the phase but it still shows up" report, July 2026).
--
-- Align the delete rules with the ledger's existing task_id/submission_id
-- pattern: history keeps the row, loses the tag. sonar_project_phase_map
-- rows are pure per-phase config, so they go with the phase.
--
-- NOTE for operators: the FK's SET NULL fires an UPDATE on
-- inventory_movements, which trg_inv_movement_immutable blocks — a phase
-- delete with ledger references must run with that trigger suspended for
-- the transaction (AdminPanel's in-app delete will hit this until the
-- trigger whitelist grows a phase_id exception; surgical SQL for now).
--
-- Applied to prod 2026-07-08 via MCP (name: phase_fk_delete_rules).

alter table public.inventory_movements
  drop constraint if exists inventory_movements_phase_id_fkey,
  add constraint inventory_movements_phase_id_fkey
    foreign key (phase_id) references public.phases(id) on delete set null;

alter table public.material_consumption
  drop constraint if exists material_consumption_phase_id_fkey,
  add constraint material_consumption_phase_id_fkey
    foreign key (phase_id) references public.phases(id) on delete set null;

alter table public.sonar_project_phase_map
  drop constraint if exists sonar_project_phase_map_phase_id_fkey,
  add constraint sonar_project_phase_map_phase_id_fkey
    foreign key (phase_id) references public.phases(id) on delete cascade;
