-- Purchasing UI flag: app_settings.purchasing_ui_enabled ('on' | 'off')
--
-- Owner decision Aug 20 2026: purchase requests / POs will NOT live in
-- FiberLog for now, but the code stays so it can be switched on later. The
-- manager UI hides everything PR/PO-shaped (Purchase Reqs sub-tab, New PR /
-- New PO, "Receiving against a PO?" + "Create a PO" in Receive PO, the
-- Create-PR bulk actions) while the flag is 'off'. Manual Receive PO and
-- field returns are unaffected. Existing PR/PO rows are untouched and
-- reappear when the flag flips to 'on' (Admin → Purchasing toggle).
--
-- The app treats a missing row / failed read as 'off' (fail-closed).
--
-- RLS: both app_settings policies are deliberately scoped to literal keys
-- because the same table holds boxhero_api_key (a secret). Widen them to the
-- new key only — never open the table.

insert into public.app_settings (key, value)
values ('purchasing_ui_enabled', 'off')
on conflict (key) do nothing;

drop policy if exists app_settings_auth_read_public_keys on public.app_settings;
create policy app_settings_auth_read_public_keys
  on public.app_settings
  as permissive for select to authenticated
  using (key in ('inventory_qty_display_mode', 'purchasing_ui_enabled'));

drop policy if exists app_settings_staff_write_ui_flags on public.app_settings;
create policy app_settings_staff_write_ui_flags
  on public.app_settings
  as permissive for all to authenticated
  using ((key in ('inventory_qty_display_mode', 'purchasing_ui_enabled')) and is_staff())
  with check ((key in ('inventory_qty_display_mode', 'purchasing_ui_enabled')) and is_staff());
