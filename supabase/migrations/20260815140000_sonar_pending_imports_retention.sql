-- sonar_pending_imports retention (backlog #50)
--
-- Every webhook delivery stores the full CSV in raw_csv, and nothing ever
-- pruned it — unbounded growth (2 reports × daily + test fires). The audit
-- panels never read raw_csv for processed rows (the list queries exclude it,
-- and loadPending only targets status='pending', which is never purged), so
-- blanking it on old imported/discarded rows loses nothing: the metadata row
-- (filename, counts, status, diagnostics in notes) stays for the audit trail.
--
-- Weekly pg_cron job, Mondays 09:30 UTC (~02:30/03:30 Denver): blank raw_csv
-- on imported/discarded rows older than 60 days. raw_csv is NOT NULL, so ''
-- is the blanked state. One-time catch-up purge below.
-- cron.schedule(jobname, ...) upserts by name — re-running is safe.

create extension if not exists pg_cron;

select cron.schedule(
  'purge_sonar_raw_csv',
  '30 9 * * 1',
  $$
    update public.sonar_pending_imports
    set raw_csv = ''
    where status in ('imported', 'discarded')
      and received_at < now() - interval '60 days'
      and raw_csv <> ''
  $$
);

-- One-time catch-up for rows already past the window.
update public.sonar_pending_imports
set raw_csv = ''
where status in ('imported', 'discarded')
  and received_at < now() - interval '60 days'
  and raw_csv <> '';
