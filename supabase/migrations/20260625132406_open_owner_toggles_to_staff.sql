-- Open the previously owner-only inventory write-toggles to all staff (owner + manager).
--
-- ⚠️ ALREADY APPLIED to production on 2026-06-25 via the Supabase MCP
-- (recorded in the remote migration history as version 20260625132406).
-- This file exists for repo ↔ prod history parity / fresh-rebuild fidelity.
-- It is idempotent; `supabase db push` skips it because the version is already
-- recorded remotely.
--
-- Two RLS write policies flip from owner-only to is_staff():
--   • app_settings (inventory qty-display pause switch)
--   • crew_load_destinations (per-user Load-target whitelist)
-- SELECT/read policies are untouched. is_staff() = role IN ('owner','manager').
-- The third toggle in this change (location retire) has no RLS — it was UI-only,
-- so there is no DB change for it here.

-- ─── app_settings: owner → staff ────────────────────────────────────────────
drop policy if exists app_settings_owner_write_ui_flags on public.app_settings;
drop policy if exists app_settings_staff_write_ui_flags on public.app_settings;

create policy app_settings_staff_write_ui_flags
  on public.app_settings
  as permissive
  for all
  to authenticated
  using ((key = 'inventory_qty_display_mode') and is_staff())
  with check ((key = 'inventory_qty_display_mode') and is_staff());

-- ─── crew_load_destinations: owner → staff ──────────────────────────────────
drop policy if exists cld_owner_write on public.crew_load_destinations;
drop policy if exists cld_staff_write on public.crew_load_destinations;

create policy cld_staff_write
  on public.crew_load_destinations
  as permissive
  for all
  to authenticated
  using (is_staff())
  with check (is_staff());
