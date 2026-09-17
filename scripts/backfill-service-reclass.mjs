#!/usr/bin/env node
// Emit the SQL that reclasses already-booked fix-job consumption from a grant
// project's Region into its Service sibling (service projects, Sep 2026).
//
// Same posture as backfill-sonar-accounts.mjs: this script never touches the
// DB. It prints one transaction to stdout; review it, dry-run it with the
// trailing ROLLBACK, then run it for real via the Supabase SQL editor / MCP.
//
//   node scripts/backfill-service-reclass.mjs \
//       --list scripts/service-reclass/west-mountain-2026-09.csv \
//       --service "West Mountain - Service" \
//       --created-by <owner user uuid> \
//       [--reverse <movement id>:<reason>]...      # plain Region → source-truck reversals
//
// The list CSV has two columns: movement_id,reason. Each row becomes ONE
// Region→Region transfer that mirrors the original (buildReclassPayload's
// shape, expressed in SQL so the DB copies every field itself):
//   part / qty / unit / work date / phase = Service / installer / account /
//   asset tag, from = the original's Region, to = the sibling's Region,
//   reclass_of = the original. Idempotent: a row that already has a reclass
//   child is skipped, so re-running emits zero inserts.
//
// --reverse rows are NOT reclasses: they undo a double-booked unit by
// transferring it from the Region back to the truck the original pulled it
// from (reclass_of stays NULL — the material was never consumed twice).

import fs from 'node:fs'

const args = process.argv.slice(2)
function opt(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const listPath = opt('--list')
const serviceName = opt('--service')
const createdBy = opt('--created-by')
const reversals = []
for (let i = 0; i < args.length; i++) if (args[i] === '--reverse') reversals.push(args[i + 1])

if (!listPath || !serviceName || !createdBy) {
  console.error('usage: --list <csv> --service "<Service project name>" --created-by <uuid> [--reverse id:reason]...')
  process.exit(1)
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID.test(createdBy)) { console.error('--created-by must be a uuid'); process.exit(1) }

const q = s => `'${String(s).replace(/'/g, "''")}'`

const rows = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
const header = rows.shift()
if (!/^movement_id\s*,\s*reason$/i.test(header)) { console.error('CSV header must be: movement_id,reason'); process.exit(1) }
const items = rows.map(l => {
  const i = l.indexOf(',')
  const id = l.slice(0, i).trim(), reason = l.slice(i + 1).trim().replace(/^"|"$/g, '')
  if (!UUID.test(id)) { console.error('bad movement id:', id); process.exit(1) }
  if (!reason) { console.error('missing reason for', id); process.exit(1) }
  return { id, reason }
})
const seen = new Set()
for (const it of items) { if (seen.has(it.id)) { console.error('duplicate id', it.id); process.exit(1) } seen.add(it.id) }

const out = []
out.push(`-- Service-project reclass backfill · ${serviceName} · ${items.length} reclass row(s) + ${reversals.length} reversal(s)`)
out.push(`-- Generated ${new Date().toISOString()} by scripts/backfill-service-reclass.mjs`)
out.push(`-- Dry-run first (leave the ROLLBACK), then swap it for COMMIT.`)
out.push(`begin;`)
out.push(``)
out.push(`-- The sibling's Region + its routing phase (lowest sequence_order).`)
out.push(`create temp table svc on commit drop as
select l.id as bucket_id, ph.id as phase_id, p.id as project_id
  from public.projects p
  join public.inventory_locations l on l.project_id = p.id and l.type = 'job_site' and l.is_active
  left join lateral (select id from public.phases where project_id = p.id order by sequence_order limit 1) ph on true
 where p.name = ${q(serviceName)};`)
out.push(`do $$ begin if (select count(*) from svc) <> 1 then raise exception 'Service project % not found or has no active Region', ${q(serviceName)}; end if; end $$;`)
out.push(``)
for (const it of items) {
  out.push(`insert into public.inventory_movements
  (movement_type, part_id, quantity, unit, from_location_id, to_location_id, notes, created_by,
   occurred_at, phase_id, consumed_by_user_id, sonar_account_id, line_note, reclass_of)
select 'transfer', m.part_id, m.quantity, m.unit, m.to_location_id, svc.bucket_id,
       ${q('Reclass: ' + it.reason + ' — backfill [reclass:' + it.id + ']')}, ${q(createdBy)},
       coalesce(m.occurred_at, m.created_at), svc.phase_id, m.consumed_by_user_id, m.sonar_account_id, m.line_note, m.id
  from public.inventory_movements m, svc
 where m.id = ${q(it.id)}
   and m.movement_type = 'transfer'
   and m.to_location_id <> svc.bucket_id
   and exists (select 1 from public.inventory_locations l where l.id = m.to_location_id and l.type = 'job_site')
   and not exists (select 1 from public.inventory_movements r where r.reclass_of = m.id);`)
}
for (const r of reversals) {
  const i = r.indexOf(':')
  const id = r.slice(0, i).trim(), reason = r.slice(i + 1).trim()
  if (!UUID.test(id) || !reason) { console.error('bad --reverse value:', r); process.exit(1) }
  out.push(``)
  out.push(`-- Reversal (not a reclass): send the double-booked unit back to the truck it came off.`)
  out.push(`insert into public.inventory_movements
  (movement_type, part_id, quantity, unit, from_location_id, to_location_id, notes, created_by, occurred_at, sonar_account_id)
select 'transfer', m.part_id, m.quantity, m.unit, m.to_location_id, m.from_location_id,
       ${q('Reversal: ' + reason + ' [reversal:' + id + ']')}, ${q(createdBy)}, coalesce(m.occurred_at, m.created_at), m.sonar_account_id
  from public.inventory_movements m
 where m.id = ${q(id)}
   and m.movement_type = 'transfer'
   and not exists (select 1 from public.inventory_movements x where x.notes like ${q('%[reversal:' + id + ']%')});`)
}
out.push(``)
out.push(`-- Verify: one child per listed original, none missing.`)
out.push(`select m.id, m.part_id, m.quantity, (select count(*) from public.inventory_movements r where r.reclass_of = m.id) as reclass_children
  from public.inventory_movements m
 where m.id in (${items.map(i => q(i.id)).join(', ')})
 order by m.occurred_at;`)
out.push(``)
out.push(`rollback;  -- dry run. Replace with: commit;`)
process.stdout.write(out.join('\n') + '\n')
