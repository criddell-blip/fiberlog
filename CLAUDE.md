# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, infrastructure-crew, install techs, and managers across multiple BEAD-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

> **Need the full end-to-end inventory walk-through?** See [docs/INVENTORY_FLOW.md](docs/INVENTORY_FLOW.md) — covers every crew workflow, every manager entry point, and the Sage export at the end of the line.
>
> **Need a deep dive on the Inventory tab specifically?** See [docs/INVENTORY_TAB.md](docs/INVENTORY_TAB.md) — every sub-tab, every action sheet, and how they fit into the daily/weekly/monthly cadence.

---

## North star

**FiberLog is the single source of truth for inventory consumption across all field crews.** Materials flow from vendor → warehouse → personal truck → project (region). Each project's consumption becomes the permanent record used for accounting export (Sage) and BEAD reimbursement reporting.

We can't integrate directly with Sonar (CRM) or Sage (accounting). The strategy is:
- **Eliminate manual dual-logging wherever possible** (infrastructure crew should not be entering work in both FiberLog and Sonar)
- **Use FiberLog as the consumption ledger** — what was used, by whom, on which project
- **Export cleanly** — Sage gets a CSV per period; future Sonar export will go back the other way once we have the data we need

---

## The three crew workflows

| Crew | Workflow shape | System | Status |
|---|---|---|---|
| **Fiber construction** (aerial / underground / splice / drop / locator) | Project → Phase → Task → Daily passdown | FiberLog only | ✅ Shipped |
| **Infrastructure** (towers, sites, business installs) | Project → **Site** → Task → Daily passdown (sites-shaped shell) | FiberLog only | 🚧 Shell shipped — onboarding next |
| **Field tech** (Calix/UBNT installs, Wave/wireless) | Customer install ticket (Sonar-scheduled) | Sonar for scheduling + logging; FiberLog imports daily | 📋 Backlog (blocked on Sonar polygon data) |

**Why this split:** Fiber and infrastructure crews work plan-driven jobs against geographic projects — they know which project they're on. Field techs work ticket-driven jobs against customer addresses and don't reliably know which fiber region a customer falls into. Until Sonar provides polygon/address → region mapping, field tech intake stays in Sonar; we'll import nightly when the data is good enough to route automatically.

---

## Infrastructure crew — sites shell

Infrastructure crew gets a **sites-shaped shell** — same overall flow as fiber crews (sidebar tree → task list → workspace → daily passdown), but the middle layer is **sites** instead of phases. A tower / business install / MDU closet is one site; tasks are the work units against it.

**Why a separate shell instead of reusing phases:** Phases work for fiber because each region has a handful of phases that span long stretches of work. Infra has ~150 active sites — modeling each as a phase would bury the actual work in a 150-deep phase list per project. Sites are the natural unit; the schema and UI now reflect that.

**Routing:**
- `App.jsx` checks `currentUser.crew_type === 'infrastructure'` and renders `InfraCrewApp` instead of `CrewApp`. Every other crew_type (aerial / underground / splice / drop / locator / contractor / install) routes to the existing `CrewApp` unchanged — zero blast radius for fiber crews.

**Schema:**
- `sites` table — name, type (`wireless` | `fiber`), project_id, address, status. 198 rows imported May 2026.
- `tasks.site_id` — nullable FK to sites. Infra tasks set it; fiber tasks leave it NULL.
- `tasks.phase_id` — was NOT NULL, now nullable. Infra tasks have site_id with phase_id NULL.
- CHECK `tasks_anchor_present` — `phase_id IS NOT NULL OR site_id IS NOT NULL`. Every task must be anchored to one or the other.

**Components (under `src/components/crew/infra/`):**
- `InfraCrewApp.jsx` — entry point. Mirrors CrewApp's structure (wide + narrow layouts, sign-out, MyStock entry). Loads `getInfraTree()` for the projects-with-sites-with-tasks shape; runs its own realtime subscription on tasks (the global one in AppContext updates the fiber tree only).
- `SitesList.jsx` — middle layer. Searchable, type-filterable (wireless / fiber pills) list of sites for a project.
- `SiteTaskList.jsx` — leaf list of tasks under a site + "New task" overlay. Infra-specific job types: maintenance / build / swap / audit / emergency.
- `TaskWorkspace.jsx` (reused) — the existing fiber workspace is shimmed with `phase={{ id: site.id, name: site.name }}`. It only reads `phase.name` (for display) and `phase.id` (for `setTaskLocal`, a latency-hint that no-ops harmlessly when the fiber tree doesn't contain the task). The tab strip is crew-type-aware: fiber crews see the 4-tab fiber strip (aerial / footage / splice / underground); infra users see a single "Infrastructure" tab backed by `assemblies.crew_type = 'infrastructure'`. Owner authors infra kits in `AssemblyEditor` (manager → Assemblies); they appear immediately in Chad's workspace.

**Materials flow:**
- Crew loads parts → truck → uses on task → submits passdown → manager approves → materials auto-deduct from truck to project bucket.
- `approve_submission` RPC resolves the destination bucket via a three-tier project lookup:
  1. `submission.project_id_override` (manual override from the workspace picker)
  2. `phases.project_id` (fiber path — derive from the task's phase)
  3. `sites.project_id` (infra path — derive from the task's site)
- Phase actuals still increment only when `phase_id IS NOT NULL` (no "site actuals" concept). The crew_type guard `{aerial, underground, splice, infrastructure}` is unchanged.
- All 7 infra projects (Fixed Wireless, Gigwave, Heber, Ogden Valley, Park City, Wasatch Front, West Mountain) have project buckets. Wasatch Front + West Mountain were backfilled when the auto-deduct path was wired — they pre-dated `trg_ensure_project_job_site` and never got auto-created. The backfill migration is idempotent so it's safe to rerun.

**Per-site attributes the owner cares about:** name / type / category / address / status. Tower height, power source, etc. are intentionally NOT stored.

**Onboarding remaining:**
1. Add infra users via Users admin with `crew_type = 'infrastructure'` (each auto-gets a personal truck via `trg_ensure_crew_truck`). Chad Sperry done; rest of infra crew to follow.
2. Fix the 1 unmapped site (Prestige II / "Fiber - Mdu") — currently `project_id IS NULL`.
3. Sites admin shipped — embedded in ProjectManager's project detail view. Add / edit (rename, change type, address, notes) / decommission (soft delete via status='decommissioned'). Search + type pills render when ≥8 sites. Per-site task count badges. Decommission confirm hints to log physical equipment recovery as a PO with a "Site decommissioned" note. No hard-delete; sites are FK targets for tasks.
4. Curate infra assemblies (`assemblies.crew_type = 'infrastructure'`) so the TaskWorkspace tabs are useful instead of showing fiber kits.

**What this replaces:** Infrastructure crew currently dual-logs in FiberLog AND Sonar. Once switched, Sonar entry for infra work stops. Sonar stays only for field tech scheduling.

**Already in place:**
- `crew_type = 'infrastructure'` is a valid value (CHECK on `public.users.crew_type`).
- Project bucket auto-creation via `trg_ensure_project_job_site` works for Fixed Wireless + Gigwave + regional projects.
- Per-user + crew_type × department permissions already cover infrastructure.
- Receive PO, Reconcile, Sonar import flows all work the same for any crew.

---

## Working-manager toggle (manager ↔ crew mode)

Some managers are also field workers. They needed to log their own day's work without juggling two accounts. The toggle lets a single staff user (`role = owner | manager`) flip into the crew shell to log work, then flip back.

**Where it lives:**
- `viewMode` (`'manager' | 'crew'`) in `AppContext`, persisted to `localStorage.fiberlog_view_mode`. Reset to `'manager'` on logout so the next user doesn't inherit a stale preference. Exposed as `enterCrewMode()` + `exitCrewMode()` helpers.
- `App.jsx` router: when `isStaff && viewMode === 'crew' && currentUser.crew_type ∈ VALID_FIELD_CREW_TYPES`, routes to `CrewApp` (or `InfraCrewApp` if `crew_type === 'infrastructure'`) instead of `ManagerApp`. The `VALID_FIELD_CREW_TYPES` list (`aerial | underground | splice | drop | locator | install | infrastructure`) is duplicated in `App.jsx` and `ManagerApp.jsx`'s `SwitchToCrewButton` — keep them in sync.
- ManagerApp sidebar + narrow top bar: `🔧 Crew mode` pill. Disabled with tooltip when no field `crew_type` set.
- CrewApp + InfraCrewApp sidebar footers + SignOutConfirm overlays: `⚙️ Manager` pill (only rendered when `isStaffActingAsCrew`). User chip subtitle picks up an "· acting as crew" callout in teal so the manager remembers which mode they're in.

**Same identity, same truck.** No account sprawl. All inventory, audit trail, and approval flows use the same `user_id`.

**Auto-deduct caveat:** `approve_submission` still requires `crew_type ∈ {aerial, underground, splice, infrastructure}` for the truck → project bucket transfer to fire. A manager with `crew_type = 'drop'` (or `'locator'`/`'install'`/`'contractor'`) can log work in crew mode but their approvals won't auto-deduct. Documented; not enforced in the router because the manager might legitimately want to log non-deducting work.

**What this is NOT:** a unified app shell. Crew users (`role = 'crew'`) never see the manager portal and never interact with `viewMode`. The toggle is staff-only.

---

## Field tech (backlog — blocked)

**Why backlogged:** Field techs install at customer addresses. Sonar tracks customers but does not currently tag each customer with which fiber region (Heber / Park City / etc.) they fall under. Without that, when we import Sonar's daily report, we can't reliably route consumed materials to the right project — and routing to a generic "Wave" or "FW" bucket forces a manual reconciliation step downstream that defeats the purpose.

**Unblocks when:** Sonar gets polygon-to-customer address mapping (in progress — tied to BEAD/reconnect address requirements). The polygons already exist from the developer side; they haven't propagated to Sonar yet.

**Approach when unblocked (Option 3 — dispatcher tags at job creation):**
- Dispatcher (or system, once polygons land) adds a `project` field to Sonar jobs at scheduling time
- Sonar daily CSV export includes that field
- FiberLog's Sonar import sheet (already shipped — `SonarImportSheet.jsx`) reads the `project` field and ties each imported submission to that project
- Manager approves the batch → materials auto-deduct truck → project
- Sage export includes field tech consumption alongside fiber + infrastructure, all keyed by project

**Why Option 3 over an address lookup table:** A FiberLog-maintained address → project lookup is another manual process. The polygon data exists at the developer level and is moving toward Sonar; building our own lookup would compete with the real source of truth.

**Until then:** Field techs continue logging in Sonar. Their material consumption isn't tracked in FiberLog. Manual Sage entry for field tech materials continues (status quo, pending the unblock).

---

## Stack

- **Frontend:** React 18 + Vite + plain JSX (no TypeScript)
- **Backend:** Supabase (Postgres + Auth + Realtime + Edge Functions)
- **Styling:** Inline styles + CSS variables (no Tailwind, no CSS modules). Theme tokens + shared classes live in `src/styles/global.css` (imported from `App.jsx`).
- **Deployment:** `npm run deploy` pushes to `gh-pages` branch
- **Local dev:** `npm run dev` (Vite default port 5173)

### Important IDs / URLs

- **Supabase project ID:** `attduslwidxecmjifsnl`
- **Supabase URL:** `https://attduslwidxecmjifsnl.supabase.co`
- **Supabase anon key:** in `.env` as `VITE_SUPABASE_ANON_KEY`. Hardcoded fallback in `src/lib/supabase.js` for safety. The key is public by design — RLS in the DB is the access boundary (see backlog #11 — RLS is currently permissive on most tables).
- **Repo path on this machine:** `C:\Users\admin\Desktop\fiberlog-react`

### Environments

- **`.env`** (committed) — production defaults. Vite inlines these at build time.
- **`.env.local`** (gitignored) — per-machine overrides. Drop a different `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` here to point local dev at a different Supabase project. Restart `npm run dev` after editing.
- For prod deploys, `npm run build` reads `.env` and inlines the values into the bundle. No runtime env access — Vite is build-time-only.

---

## Folder layout

```
src/
  AppContext.jsx          ← global state, auth, projects, users, realtime subscriptions
  App.jsx                 ← top-level routing: role=owner/manager → ManagerApp (unless viewMode='crew' AND has field crew_type → routes to the appropriate crew shell); crew_type='infrastructure' → InfraCrewApp; everyone else → CrewApp
  styles/global.css       ← CSS variables + shared classes (pill, banner, metric, avatar, etc.) for both light + dark theme
  lib/
    supabase.js           ← Supabase client + DB helpers (projects, users, tasks, etc.)
    inventory.js          ← all inventory operations (locations, stock, movements, parts, audit)
    admin.js              ← user management ops (create/update/deactivate/reset password)
    csvImport.js          ← shared CSV import utilities
  components/
    crew/                 ← UI for non-manager users (logging work, parts used, etc.)
      CrewApp.jsx         ← fiber-crew entry: Project → Phase → Task → Workspace
      ProjectList.jsx, PhaseList.jsx, TaskList.jsx, TaskWorkspace.jsx
      TaskSummaryView.jsx ← read-only inspection of pending/approved/done tasks (parts, hours, notes, status, manager feedback) — both crew shells route here when isReadOnlyTask(task)
      MyStockView.jsx     ← crew's personal-truck inventory view (Load + Return UI)
      CrewMovementSheet.jsx ← unified overlay for load/return (other ops are RPC-supported, UI deferred)
      workspace/          ← logging-specific subviews (used by both shells)
      infra/              ← sites-shaped shell for crew_type='infrastructure'
        InfraCrewApp.jsx  ← entry: loads getInfraTree(), runs its own task realtime sub
        SitesList.jsx     ← project's sites, type-filterable (wireless / fiber)
        SiteTaskList.jsx  ← site's tasks + New-task overlay (infra job types)
    manager/              ← UI for owner/manager users
      ManagerApp.jsx      ← entry, top-level nav (Approvals / Crew / Projects / Reports / Assemblies / Inventory / Admin)
      AdminPanel.jsx      ← admin home — wires Users, Reset-password, BoxHero sync, Crew×Dept permissions
      AdminUsersView.jsx  ← user CRUD + per-user movement permission toggles
      CrewTypePermissionsView.jsx ← crew_type × department matrix (whitelist UI)
      InventoryView.jsx   ← inventory section (5 sub-tabs + 5 sheet buttons: Import / Receive PO / Reconcile / Sonar / Record movement)
      InventoryStockTab.jsx, InventoryLocationsTab.jsx, InventoryPartsTab.jsx,
      InventoryMovementsTab.jsx, InventoryAuditTab.jsx
      RecordMovementSheet.jsx ← arbitrary single-movement entry
      ReceivePOSheet.jsx  ← multi-line vendor delivery (creates new parts inline, edits attrs)
      ReconcileSheet.jsx  ← audit CSV round-trip → adjust movements
      SonarImportSheet.jsx ← daily install report → bulk issue movements
      BulkMoveSheet.jsx, InventoryImportSheet.jsx
      AssemblyEditor.jsx  ← assembly templates (kits crew can pre-fill from)
      ReportsView.jsx, SubmissionsQueue.jsx, ProjectManager.jsx, CrewStatus.jsx
  lib/
    useIsWide.js          ← shared 768px-breakpoint hook (used by both CrewApp and ManagerApp)
supabase/
  functions/
    admin-set-password/index.ts   ← reset another user's password (owners/managers only)
    admin-create-user/index.ts    ← create a new user (creates auth.users + public.users)
```

---

## Database schema highlights

### Auth & users
- Each user has a row in `auth.users` (Supabase) AND a matching row in `public.users` with the same UUID
- Login uses synthetic emails: `firstname.lastname@fiberlog.utahbroadband.com`
- `public.users.email` mirrors `auth.users.email`; **don't change it** after creation (it's the auth identity)
- `public.users.role` CHECK: `owner | manager | crew | contractor`
- `public.users.crew_type` CHECK: `aerial | underground | splice | drop | locator | contractor | install | infrastructure`
- `users_login_picker` RLS policy allows anon `SELECT` WHERE `is_active = true` (so the login screen can show the user list)

### Inventory locations & bins
- `inventory_locations.type` CHECK: `warehouse | truck | job_site | vendor | scrap | bin`
- **Bins** are sub-locations under warehouses. They live in the same table with `parent_location_id` set
- Constraints (enforced by trigger `trg_inv_location_validate_parent`):
  - Only `type='bin'` rows can have a parent (CHECK `inventory_locations_parent_consistency`)
  - Only `type='warehouse'` rows can BE a parent (validated by trigger)
  - Single-level nesting only — bins cannot themselves have children
- `getLocations()` excludes bins by default; pass `{ includeBins: true }` or use `getBinsForWarehouse(warehouseId)` to fetch them

### Inventory stock & movements
- `inventory_stock` — one row per `(part_id, location_id)`. Stock can live at a warehouse OR a bin (warehouse-level stock = "unbinned")
- `inventory_movements.movement_type`: `receive | transfer | return | issue | scrap | adjust`
- Movements with `from_location_id` decrement source stock, `to_location_id` increment destination
- `adjust` is special: positive (to only) or negative (from only)
- `inventory_movements.notes` and `vendor_invoice` are both `text` (no length limit) — Receive PO writes the vendor name into notes, Sonar import writes `[sonar:<itemId>]` for future dedup
- A trigger updates `inventory_stock` automatically when a movement is inserted
- **CHECK constraint `movement_endpoints_valid`** enforces correct from/to per type (e.g., `receive` requires `to NOT NULL, from NULL`; `transfer`/`return` require both and different). The JS `validateMovement()` in `lib/inventory.js` mirrors this so we fail fast.

### Accounting destinations (`type='job_site'`)
- **Project destinations** — one per active project, `project_id` set, auto-created by trigger `trg_ensure_project_job_site` on project insert/activation. Names match the project name. Receive auto-deduct transfers from approval AND `region`-routed Sonar imports.
- **Gigwave + Fixed Wireless destinations** — these are now first-class projects (created in migration `sites_table_and_wireless_projects`) with their own auto-created project buckets. The pre-existing standalone `Gigwave` bucket from the Sonar work was reconciled to point at the new Gigwave project, so existing Sonar `gigwave` routing keeps working. Same consumption-ledger semantics as fiber regions.
- **None destination** — non-project standalone location, still receives Sonar `none`-routed wireless. `project_id` is NULL.
- Project destinations are the permanent record of consumption per project. Sage export pulls from them per period; they are not "drained" in the bucket sense — they are the consumption ledger keyed by project.

### Sites (infra crew's unit of work)
- `sites(id, name, type fiber|wireless, project_id, address, lat, lng, status active|decommissioned, notes)` — each site belongs to one project (Gigwave / Fixed Wireless / a fiber region). Auto `updated_at` via trigger. RLS: auth read, staff write.
- `tasks.site_id` (nullable) — infra tasks anchor here. Consumed by `getInfraTree()` + `InfraCrewApp`.
- `tasks.phase_id` is now **nullable** (was NOT NULL). CHECK `tasks_anchor_present` ensures every task has at least one of `{phase_id, site_id}` — never both NULL.
- `approve_submission` increments phase actuals only when `phase_id IS NOT NULL` (infra has no site actuals concept). Auto-deduct resolves the project bucket via override → phase's project → site's project, so infra approvals deduct cleanly into the site's project bucket.
- 198 sites bulk-imported from owner's CSV. All mapped to a project (the last unmapped one, "Prestige II", was assigned to Heber on May 22). `getInfraTree()` still has a defensive console.warn for any future unmapped sites.
- Sites admin lives in `ProjectManager.jsx`'s project detail view — only renders for infra-style projects (0 phases + ≥1 site). Full CRUD: add / edit (rename, change type, address, notes, **move to different project**) / decommission (soft-delete via status='decommissioned'). Decommission confirm hints to log physical equipment recovery as a Receive PO with a "Site decommissioned" note. Edit Site overlay also exposes two read-only drilldowns: **View tasks** (the site's tasks with name + type + status pill) and **View materials** (parts summed across all task_id-linked inventory_movements). Search + type pills render when ≥8 sites. Per-site task count badges.
- Helpers in `lib/supabase.js`: `getSitesByProject`, `addSite`, `updateSite` (handles project moves), `decommissionSite`, `getTaskCountsBySite`, `getTasksBySite`, `getMaterialsAtSite`.
- Helpers in `lib/supabase.js`: `getInfraTree()` (projects-with-sites-with-tasks shape), `addInfraTask(siteId, ...)`.

### Per-user + per-crew-type permissions
- `crew_operation_permissions(user_id, operation, allowed bool, reason, updated_at)` — explicit deny rows (empty table = default-allow). Checked by `record_crew_movement` RPC.
- `crew_type_part_restrictions(crew_type, department)` — whitelist (empty for a crew_type = unrestricted). Parts with `department IS NULL` bypass. Checked by `record_crew_movement` RPC. **NOT** checked by `approve_submission` auto-deduct (system action).

### Sonar import routing (current state)
- `parts_catalog.sonar_routing text NOT NULL DEFAULT 'ask'` — CHECK in `('region','gigwave','none','ask')`. Determines where a Sonar import row's transfer lands.
- `sonar_city_bucket_map(city PK, location_id, updated_at, updated_by)` — persisted city → bucket mapping for `region`-routed parts. Updated by the SonarImportSheet's city picker. RLS: auth read, staff write. Bump trigger on `updated_at`.
- **Future:** when Sonar provides per-job project tagging (polygon data), this routing simplifies — every job comes in pre-tagged with a project, no city lookup needed.

### Submission routing override
- `submissions.project_id_override` — nullable FK to projects. If set, `approve_submission` routes auto-deduct to this project's bucket instead of the task's natural project. Phase actuals stay on the natural phase. Persisted by `TaskWorkspace`'s in-task picker.

### Parts catalog
- `parts_catalog.id` is the SKU (text PK)
- `parts_catalog.is_active = false` means it's a **draft** (auto-created during CSV imports for SKUs not yet in catalog)
- `parts_catalog.category` is computed as `Department / Material Group` automatically — **don't update it manually**, instead update `department` and/or `material_group` and let the helpers in `lib/inventory.js` rebuild it

### Realtime publication
The following tables broadcast changes via Supabase Realtime: `emergency_logs`, `log_entries`, `submissions`, `tasks`, `work_sessions`. Subscriptions are scattered:
- `tasks` — subscribed globally in `AppContext` (keeps the project tree in sync everywhere) AND per-phase in `TaskList` (manages local phase state).
- `submissions` — `SubmissionsQueue` subscribes for INSERT/UPDATE.
- `work_sessions` — `CrewStatus` subscribes for all events.
- `emergency_logs`, `log_entries` — published but no JS subscriber yet.

---

## Edge functions

Two are deployed and active:

- `admin-set-password` — owner/manager resets another user's password. Verifies caller via JWT, uses service_role to update `auth.users`.
- `admin-create-user` — owner/manager creates a new user. Creates `auth.users` row, then `public.users` with matching UUID. Rolls back the auth row if profile insert fails. Only owners can create owners.

Pattern for new edge functions: copy `admin-set-password` as the template. JWT verification + service_role for privileged ops.

Deploy: `npx supabase functions deploy <name>` (you may need `supabase login` first).

---

## Database RPCs (canonical list)

All `SECURITY DEFINER`, all with `SET search_path = public, pg_temp`. EXECUTE on the trigger-only functions is revoked from `anon`/`authenticated`/`PUBLIC`.

| RPC | Called from JS | Purpose |
|---|---|---|
| `approve_submission(p_submission_id, p_note)` | `lib/supabase.js` → `approveSubmission` | Atomic + idempotent submission approval. Increments phase actuals when phase is set, flips task to `approved`, clears `working_counts`, auto-deducts materials (truck → project bucket) for aerial/underground/splice/infrastructure crews. Bucket lookup: `submissions.project_id_override` → `phases.project_id` → `sites.project_id`. |
| `record_crew_movement(operation, part_id, quantity, other_location_id, ...)` | `lib/inventory.js` → `recordCrewMovement` | Single entry point for crew load/return/issue/scrap/transfer. Checks per-user permission, crew_type×department whitelist, then inserts the movement. |
| `save_log_entry(...)` | `lib/supabase.js` → `saveEntry` | Atomic insert of `log_entries` + `entry_parts`. |
| `replace_assembly(p_assembly jsonb, p_parts jsonb)` | `lib/supabase.js` → `saveAssembly` | Atomic upsert of assembly + replace of `assembly_parts`. |
| `is_staff()` | RLS policies | Returns true if `auth.uid()`'s role is owner/manager. STABLE. |
| `cascade_task_terminal_to_session()` | Trigger only | When task status → pending/approved/done, flips matching `started` work_sessions to `submitted`. |
| `ensure_crew_truck()` | Trigger only | Auto-creates a personal truck for new crew/contractor users. |
| `ensure_project_job_site()` | Trigger only | Auto-creates a job_site bucket for new active projects. |
| `crew_op_perms_touch_updated_at()` | Trigger only | Bumps `updated_at` on `crew_operation_permissions` UPDATE. |
| `update_inventory_stock_on_movement()` | Trigger only | Maintains `inventory_stock` from `inventory_movements` inserts. |
| `validate_inventory_location_parent()` | Trigger only | Enforces bin parent rules (only warehouses can be parents, single-level only). |
| `increment_phase_actuals(...)` | (legacy, kept for compatibility — `approve_submission` does the work inline now) | |
| `increment_session_counts(...)`, `update_session_timestamp()`, `update_updated_at_column()`, `prevent_movement_modification()`, `prevent_movement_delete()` | Triggers / legacy | |

---

## Tests

`npm test` (one-shot) or `npm run test:watch`. Vitest configured via `package.json` only — no separate config file.

- `src/lib/calculations.test.js` — 34 tests covering bolt-size mapping, lashing math (ceil rounding), structure mappings, mergeParts dedupe. Covers the arithmetic most likely to silently regress when SKU maps or per-100ft ratios get tweaked.
- No component tests yet. The crew workflow + manager sheets are smoke-tested manually via the deployed app.

---

## Conventions / patterns

### Code style
- Functional components with hooks. No class components.
- Heavy inline styles using CSS variables. No Tailwind, no CSS-in-JS libraries.
- Theme tokens: `var(--bg)`, `var(--surface)`, `var(--surface2)`, `var(--text)`, `var(--muted)`, `var(--hint)`, `var(--border)`, `var(--border2)`, `var(--orange)`, `var(--orange-lt)`, `var(--orange-dk)`, `var(--teal)`, `var(--teal-lt)`, `var(--teal-mid)`, `var(--amber)`, `var(--amber-lt)`, `var(--red)`, `var(--red-lt)`, `var(--blue)`, `var(--blue-lt)`, `var(--purple)`, `var(--purple-lt)`, `var(--gray-lt)`. Radius tokens: `var(--r)`, `var(--r-sm)`, `var(--r-xs)`.
- Comments explain **why**, not what. Dense at decision points, sparse for obvious code.
- Helper components/functions go at the bottom of the file (e.g., `pillStyle`, `BinFormSheet` at end of `InventoryLocationsTab.jsx`).
- Section dividers: `// ─── SECTION NAME ────────────────...`

### Sheet / modal pattern
Use the existing CSS classes. Wrapper:

```jsx
<div className="overlay open" onClick={e => e.target === e.currentTarget && onClose()}>
  <div className="overlay-sheet">
    {/* form fields */}
    <div className="field"><label>Foo</label><input /></div>
    <div style={{ display: 'flex', gap: 8 }}>
      <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" style={{ flex: 2 }} onClick={onSave}>Save</button>
    </div>
  </div>
</div>
```

### Refresh pattern
Parent components own a `refreshKey` integer that gets bumped (`setRefreshKey(k => k + 1)`) after a mutation. Children include it in a `useEffect` dependency array to refetch.

### Realtime channel names
Always build channel names via `nextChannelSuffix()` (exported from `lib/supabase.js`) — e.g. `db.channel('crew_status_live_' + nextChannelSuffix())`. Two subscribers using `Date.now()` alone (or a static name) can collide in the same tick and supabase-realtime throws "cannot add postgres_changes callbacks after subscribe()", which kills the React render. The helper appends a process-local counter so collision is impossible. Defensively wrap component-level `subscribeToAllTaskChanges` / `db.channel(...)` calls in try/catch so realtime breakage degrades to "no live updates" instead of "blank shell" (see `InfraCrewApp.jsx` for the pattern).

### Browser / hardware Back button
FiberLog has no router — navigation is local `useState`, so the browser/phone Back gesture used to exit the app entirely. `src/lib/backStack.js` fixes this: a central coordinator keeps one synthetic `history.pushState` entry per back-able step, and a single `popstate` listener routes Back to the top-most registered layer. At the root nothing is armed, so Back leaves the app (correct).

Wire a back-closable layer with the `useBackClose(depth, onBack, opts?)` hook:
- `depth` — integer count of back-steps this layer contributes (0 = inactive). Modal: `open ? 1 : 0`. Multi-level screen stack: the current level index (crew narrow uses projects=0, phases/sites=1, tasks=2, workspace=3 — depth, not boolean, so a 3-deep descent owns 3 entries and the 2nd Back doesn't eject the user).
- `onBack` — step this layer back one; reuse the existing `setScreen` / `onClose` / `setShowX` handler.
- `opts.confirm` — optional `() => boolean`; return `false` to veto the Back (e.g. show a "Discard changes?" prompt for unsaved input). The hook re-arms so Back can retry.

Call it unconditionally at the top of the component (Rules of Hooks), before any early return; pass `depth 0` while loading/inactive. Push uses `url=null` so the visible path never changes (GitHub Pages `/fiberlog/` base stays intact). The coordinator tolerates React `<StrictMode>`'s mount→cleanup→mount and swallows its own programmatic `history.back()` via a suppress counter.

Shipped: crew narrow screen stack + sign-out dialog (Phase 1, `CrewApp.jsx`/`InfraCrewApp.jsx`); crew overlays/sheets with unsaved-input confirm (Phase 2a — `PartSearch`, `CrewMovementSheet`, the new-task overlays in `TaskList`/`SiteTaskList`, `AerialWorkspace`'s MST/add-pole pickers); manager tab navigation (Phase 3 — any non-home tab → Back returns to the home tab); manager sheets + in-view overlays (Phase 2b — all standalone inventory sheets like Record Movement / Receive PO / the CSV importers / Reconcile / Sage / Bulk Move / labels / Purchase Request / Location Detail, plus the inline overlays in ProjectManager / AdminPanel / AdminUsersView / Inventory{Locations,Parts}Tab / SubmissionsQueue / AssemblyEditor). Standalone sheet components register `useBackClose(1, onClose, …)` *inside themselves* (mounted only when open → depth 1); inline overlays register at the owning view keyed on their open-boolean. Data-entry sheets/forms pass `opts.confirm` reading their own dirty state (window.confirm), display/print/confirm overlays close immediately; the coordinator moves a layer to the top of the stack on activation so an overlay opened over a drilled-in screen (or a nested sheet) receives Back first. Manager in-tab drill-ins (Phase 3 cont. — InventoryView sub-tab → Stock, ProjectManager phase/project detail → list, AdminPanel sub-view/project detail → home) and crew wide-layout sidebar selection (Phase 4 — task → phase/site → picker, plus the My Stock toggle) use depth-valued `useBackClose` the same way the narrow screen stack does. **Back-button coverage is now complete across both shells and both layouts.** The only deliberate non-coverage: click-outside popovers (e.g. InventoryView's "⋯ More" menu) are not Back-wired.

### Browser autofill suppression
For any input that's NOT meant to be filled by the browser's saved-credentials list, use `autoComplete="off"` plus a non-standard `name=` like `name="user-search"`. For password reset / new-password fields, use `autoComplete="new-password"`. Past bug: opening the reset-password sheet was autofilling the user's username into the search field below.

### Persistence
- `localStorage.fiberlog_dark_mode` — theme preference
- `localStorage.fiberlog_remembered_username` — last login username
- `localStorage.fiberlog_view_mode` — `'manager' | 'crew'` for the working-manager toggle. Reset to `'manager'` on logout in `AppContext.logout()` so a different next-user doesn't inherit it.

---

## Common commands

```bash
npm run dev                                    # local dev (port 5173)
npm run build                                  # production build
npm run test                                   # run vitest once
npm run test:watch                             # vitest in watch mode
npm run deploy                                 # deploy to gh-pages
npx supabase functions deploy <name>           # deploy an edge function
npx supabase login                             # auth supabase CLI (first time)
```

---

## Backlog (rough priority order)

0. **Usability consolidation + Location drill-in** — 12-item sprint covering (a) a location-detail drill-in panel that turns the Locations tab into a hub for view-stock / count / export / labels / edit, and (b) a survey-style audit of pill/button consolidations across the manager portal (Inventory header → ⋯ Actions menu, warehouse row buttons grouped, SubmissionsQueue status pills → dropdown, etc.). Plus carry-overs: bulk-assign UI for pull-locations, Reports "By consumer" filter using the new `consumed_by_user_id` column, cross-crew assignment warning. Full design + sequencing + per-item file refs in `~/.claude/plans/usability-consolidation-and-location-drillin.md`. Total effort ~2 days; all items independent and shippable piecemeal.

0a. ✅ ~~**Rework ReportsView header chrome for mobile**~~ — shipped (commit `125adf9`). Filters now collapse behind a "▾ Filters" toggle; defaults expanded on desktop, collapsed on phone. Status line summarizes active filters when collapsed.

1. **Onboard infrastructure crew** — substantially shipped (May 2026). Sites table + 198-row import (all mapped to a project), InfraCrewApp shell, crew-aware TaskWorkspace tab strip, `TaskSummaryView` for read-only inspection of submitted tasks, `approve_submission` auto-deducts via `sites.project_id` fallback, project buckets backfilled for Wasatch Front + West Mountain, SubmissionsQueue + ReportsView coalesce phase/site, Sites admin (add / edit including move-to-project / decommission / search / task-count + per-site materials and tasks drilldowns) embedded in ProjectManager. Remaining: (a) author real infra kits in AssemblyEditor (Chris's call), (b) onboard more infra users beyond Chad. Stop dual-logging in Sonar for infrastructure work once switched over.

2. **Task status redesign** (the `is_closed` model) — separately discussed. Decouple task lifecycle from submission approval:
   - Tasks get an `is_closed` boolean only (manager-controlled)
   - Submissions keep their own `pending → approved → rejected` lifecycle
   - Approving a submission no longer mutates task status
   - Crew can submit multiple passdowns against the same open task (multi-day work)
   - Manager closes tasks explicitly when the work is done
   - Fixes the "approved tasks still show open" bug we kept chasing; the bug was structural, not cosmetic
   - Implementation: add `tasks.is_closed`, `tasks.closed_at`, `tasks.closed_by`. Remove `tasks.status` writes from the submission flow (leave column for now). Update crew + manager rendering to filter by `is_closed`.

3. **Field tech Sonar import → project routing** — backlogged behind Sonar polygon/address data landing in their export. See "Field tech (backlog — blocked)" above. Until then, field techs continue in Sonar standalone.

4. **Sage Intacct daily export** — Edge Function pattern, stamps `exported_at` + `export_batch_id` on included movements. Format spec gathered:

    Target format: standard Sage Intacct **Inventory Transactions** import template (the comprehensive one — covers transfers, receipts, issues, adjustments via the `TRANSACTIONTYPE` column). Sample template the owner provided was 46 columns; the columns we'd actually populate from FiberLog data:

    | Sage column | FiberLog source | Notes |
    |---|---|---|
    | `TRANSACTIONTYPE` | constant per `movement_type` | needs the owner's exact Sage template names |
    | `DATE` | `inventory_movements.created_at` | YYYY-MM-DD |
    | `STATE` | `Draft` (safe default) or `Post` | configurable |
    | `LINE` | row index per document | 1, 2, 3… |
    | `ITEMID` | `parts_catalog.id` | likely matches Sage if both are BoxHero-driven |
    | `WAREHOUSEID` | `inventory_locations.name` → Sage code | **needs a mapping table** |
    | `QUANTITY` | `inventory_movements.quantity` | direct |
    | `UNIT` | `parts_catalog.unit` | Sage values: Count / Length / Time / Volume / Weight |
    | `PRICE` | `inventory_movements.unit_cost` | optional |
    | `REFERENCENO` | `inventory_movements.id` or `submission_id` | for Sage→FiberLog traceback |
    | `MESSAGE` / `MEMO` | `inventory_movements.notes` | auto-deduct text, vendor info |
    | `INVDOCUMENTENTRY_PROJECTID` | `projects.name` → Sage project code | for project-bucket transfers |
    | `INVDOCUMENTENTRY_VENDORID` | parsed from receive notes (`Vendor: X`) | optional |
    | `BINID` | bin name when destination is a bin | optional |
    | `DEPARTMENTID` | `parts_catalog.department` → Sage code | optional |

    Movement-type mapping:
    - `receive` → `Inventory Receipt`
    - `transfer` (incl. crew load + project-bucket auto-deduct) → `Inventory Transfer`
    - `return` → also `Inventory Transfer` (or a separate "Stock Return" template)
    - `issue` → `Inventory Issue`
    - `scrap` → `Inventory Adjustment` (or `Scrap`)
    - `adjust` → `Inventory Adjustment`

    Open questions before building:
    1. Sage transaction template names (Sage Intacct lets these be customized per company)
    2. Do `parts_catalog.id` SKUs match Sage's `ITEMID`? Probably yes (both BoxHero-rooted) but confirm
    3. Warehouse code mapping (FiberLog uses full names; Sage uses codes)
    4. Project code mapping (same question for project buckets → Sage project codes)
    5. Personal trucks: skip or map? Filter them out at export time, or map them all to a single "Crew" warehouse in Sage
    6. Cadence — daily? Manual button per export?
    7. `BASECURR` — USD assumed; the field exists for multi-currency setups

5. **Per-line `project_id` on `log_entries`** — schema change for field-tech multi-cost-center allocation. Pending field-tech UI workflow decisions (per-customer vs per-day).

6. **Field tech UI surface** — flatter "today's installs" list with one-tap into per-customer materials log. Blocked by backlog #3.

7. ✅ ~~**Reconcile workflow**~~ — shipped.

8. ✅ ~~**Locations tab UX**~~ — shipped.

9. ✅ ~~**Auto-deduct on submission approval**~~ — shipped as the project-bucket variant.

10. **BoxHero drafts cleanup** — handled manually by owner via Parts tab → Drafts → bulk edit. ~476 placeholder drafts with `unit='ea'`; cable items need `unit='ft'`.

11. ✅ ~~**Receive materials via vendor PO**~~ — shipped (MVP + inline part create/edit).

    Bigger version (later, if needed):
    - `purchase_orders` table with status (`open` | `partial` | `closed`) and per-line expected qty
    - Partial receipts
    - Vendor catalog
    - "What's on order?" / overdue PO reports
    - PO PDF upload + parser

12. **Security & DB hygiene from Supabase advisor scan** — RLS rewrite + view/function hardening complete. Five lints remain, all intentional or out-of-band:
    - `tasks_insert` and `tasks_update` are wide-open by design (crew need to create tasks and auto-save `working_counts`; the "Continued from X" handoff depends on any-crew updates). Documented exception.
    - `approve_submission` and `is_staff()` are reachable by `authenticated`, intentionally. `approve_submission` is the manager UI's approval RPC and has an `auth.uid()`+role guard inside. `is_staff()` is called by RLS policies and must be executable in the user's context.
    - ~~Leaked-password protection toggle~~ — gated behind Supabase Pro plan. Not worth a plan upgrade for FiberLog's risk profile.
    - Performance lints (64 of them, all INFO/WARN, none urgent at current scale): 32 unindexed FKs, 24 duplicate permissive policies, 5 unused indexes, 3 `auth_rls_initplan` cases. Revisit if/when query latency becomes noticeable.

    Helper installed: `public.is_staff()` returns true iff `auth.uid()`'s role is `owner` or `manager`. Used by every staff-write RLS policy.

    Migrations applied: `tighten_rls_policies`, `harden_views_functions_execute_grants`, `users_staff_update_policy`.

13. **Scan mode in CrewMovementSheet (Load + Return)** — opt-in `📷 Scan mode` pill at the top of the crew load/return sheet. Toggle on → scan bin QR to set source, scan part QRs to add lines (each scan = +1 qty for that part; long-press or "edit qty" tap to override). Reuses `ScanInput` from cycle counting (handles both USB scanners + phone camera via ZXing). Bigger payoff than it looks: morning loadouts of 8-15 parts collapse from ~3 min of scrolling/typing to ~30 sec of scanning. Adjacent wins for free: same toggle in Return flow + a "📷 Verify" mode on `MyStockView` that scans truck stock against system state. Gating concern: until label coverage is broad (Receive PO already prints QR; legacy stock needs scan-sheet posting), only a fraction of stock is scannable — toggle stays opt-in so the existing picker remains the default.

14. **Per-Sonar-Project pull-location override (contractor routing)** — contractor fiber jobs get entered in Sonar by various in-house users (cparisi, etc.); the materials should source from the existing `Contractor - RNS` truck (a shared trailer) regardless of which user logged the job. Same transaction process as any other fiber job — only the source changes. Implementation: add `pull_location_override_id` (nullable FK → inventory_locations) to `sonar_project_phase_map`. The fiber-jobs import sheet (and asset import sheet, for symmetry) checks the mapping's override before falling back to the consuming user's `default_pull_location_id` or personal truck. Project mapping picker gets a second dropdown ("source override: [— use user's truck —] / [Contractor - RNS] / ..."). Waiting on a real contractor delivery with materials to confirm what Sonar Project value identifies contractor jobs before building — when a real delivery lands and the column reveals a stable value like `Contractor RNS`, this becomes ~30 min of work. Test with a job that actually has materials (zero-material rows correctly produce no movement under current `no-materials` filter).

15. ✅ ~~**Part-first Crew Load mode**~~ — shipped (commit `ca1fffd`). Default is "🔍 Find a part"; toggle to "📍 Pick a location" for the original flow. `getAllStockGrouped({excludeLocationId})` powers the search across active stock; per-sheet-open mode state.

16. **Submit-is-permanent warning on task submission** — add a small inline note/warning in the submit confirmation (crew `TaskWorkspace` submit flow) telling the crew that submitting is permanent / can't be edited afterward. Low effort. NOTE: relates to backlog #2 (the `is_closed` task-status redesign) — if multi-submit-per-open-task lands, the "permanent" framing softens to "this passdown is final once submitted." Word it so it's still accurate under either model (the *submission* is the permanent record either way).

17. **Allow loading more than available stock (over-load override).** When loading the truck (crew **Load** flow), the app caps the quantity at what's on hand at the source and won't let you move more. During the transition to the new system the source stock numbers aren't yet trustworthy, so the owner wants the ability to load past available (which drives source stock negative — `inventory_stock` already tolerates negative on-hand; MyStockView renders qty < 0 in red). **This is a transitional need** — likely want it as an override/toggle, not the permanent default. Where the cap lives: check the qty validation in `CrewMovementSheet.jsx` (client-side max) AND `record_crew_movement` RPC / `validateMovement()` in `lib/inventory.js` (server + shared check) — all three may need to permit over-draw. Decide whether to gate the override (manager permission? global "transition mode" switch?) so it's not a silent footgun once the data settles.

18. **Default the Hours field on task submission** — pre-fill the crew `TaskWorkspace` hours input instead of starting blank, so the common case is one tap. **Open question — default value:** a flat standard workday (8?) vs. remember the crew member's last-entered hours vs. per-crew-type default. Lowest-friction is probably 8 with the field still editable.

19. **Crew "found inventory" → manager-approved request** — when a crew member is physically holding a part the system doesn't show on their truck and wants it booked into the warehouse. Design agreed (June 2026): a **request-and-confirm** flow, NOT a direct crew write (chosen for inventory integrity). Crew, from My Stock / Return, taps "Report found inventory" → searches the catalog for the part (common case = known SKU); if it's genuinely not in the catalog, **creates a draft part inline** (`is_active=false`, reusing the existing draft pattern); enters qty + destination warehouse + reason. This creates a **pending request** — no stock moves yet. A manager review queue confirms it → approval books the movement into the warehouse (as `receive`/positive `adjust`, unbinned for later put-away) and, for drafts, prompts to activate/merge the part; reject carries a reason. New pieces: one small table (e.g. `inventory_intake_requests`: part_id, is_draft, qty, target_location_id, note, requested_by, status pending/approved/rejected), one approval RPC, a crew entry UI (extend `MyStockView`/`CrewMovementSheet`), and a manager queue UI (mirror SubmissionsQueue + reuse the Parts → Drafts queue). Note: `record_crew_movement` supports load/return/transfer/issue/scrap only — NOT `adjust`/`receive` — and only managers can `createPart` today, which is *why* this is routed through manager approval rather than a direct crew op. Related: #17 (over-draw on the truck side) and #10 (draft cleanup).

---

## Gotchas worth knowing

- **MCP `create_directory` was unreliable** in past sessions (timed out). Not your problem in Claude Code, but if you see it elsewhere, retry usually works.
- **Self-deactivation is blocked client-side** in `AdminUsersView`. Server doesn't enforce, but adding a server check is on the someday list.
- **Hard-deleting users from `public.users` will fail** because of FK references in `inventory_movements`, `log_entries`, `submissions`, etc. Use soft-delete (`is_active = false`) only. The new Users admin UI does not expose hard-delete.
- **Bins as audit sources for bulk-move:** the StockTab disables bulk-select in warehouse "rollup" mode because the source bin is ambiguous. Drill into a specific bin or "Unbinned" to bulk-move.
- **Realtime subscriptions** can be flaky during long sessions. AppContext re-subscribes on reload but if you see stale UI, a hard-refresh fixes it.
- **`build v3` marker** is in `InventoryImportSheet.jsx` from earlier debugging — leave it for now, it's a cache-bust signal.

---

## Key crew members (reference for testing)

- Francisco Molina, Edgar Molina, Leo Tamayo (fiber crew)
- Brian Tyler, Ashton Hanks (other crew)
- Chris Riddell (owner — primary user of the manager portal)

---

## How the inventory flows interconnect (cross-feature map)

The inventory side has many entry points that all write to `inventory_movements`. The trigger on that table updates `inventory_stock` automatically. Knowing which flow touches what:

| Entry point | Writes movement type | From → To | Notes |
|---|---|---|---|
| Crew Load (`CrewMovementSheet` → `record_crew_movement` RPC) | `transfer` | warehouse → caller's truck | Permission-checked |
| Crew Return (same RPC) | `return` | caller's truck → warehouse | Permission-checked |
| Crew Issue/Scrap/Transfer | (same RPC, UI not shipped) | caller's truck → (varies) | RPC ready, sheets deferred |
| Manager Record movement (`RecordMovementSheet`) | any of 6 | any → any | Free-form, no permission filter |
| Manager Receive PO (`ReceivePOSheet`) | `receive` (× N lines) | NULL → dest | Can create new parts inline |
| Manager Reconcile (`ReconcileSheet`) | `adjust` (× N lines) | one-sided | Audit CSV round-trip |
| Manager Sonar import (`SonarImportSheet`) | `issue` (× N lines) | crew truck → NULL | Mapped per-unique-value, not per-row |
| **Auto-deduct on approval** (`approve_submission` RPC) | `transfer` (× N parts) | submitter's truck → project bucket | Gated on crew_type ∈ {aerial, underground, splice, infrastructure}. Honors `project_id_override`. |
| BoxHero CSV import (`InventoryImportSheet`) | `adjust` baseline + future flows | varies | Initial seed path |

Things to remember when adding a new entry point:
- All inserts to `inventory_movements` need `created_by` (RLS would 0-affect otherwise). Validate `currentUser?.id` exists before building the payload.
- For staff-initiated movements (manager UI), the manager already has `is_staff()` so the `mgr_write` RLS policy permits the insert. For crew-initiated, route through `record_crew_movement` RPC which is SECURITY DEFINER and bypasses RLS once it's verified the caller's role.
- The CHECK constraint `movement_endpoints_valid` will reject bad from/to combos before the trigger runs. `validateMovement()` in `lib/inventory.js` mirrors this — call it before the RPC for friendlier client-side errors.
- None of the import-style sheets (Receive PO, Reconcile, Sonar) set `task_id` — these are standalone movements not tied to a FiberLog task.

## Known cross-feature gaps + tech debt

- **MyStockView (crew) has no realtime subscription** — `inventory_stock` isn't in the realtime publication. When a manager applies Sonar/Reconcile/auto-deduct that affects a crew's truck, the crew won't see the change until they manually refresh. Comment in the file is explicit.
- **`recordMovementsBatch` does no chunking** — single `.insert(payload)` for all rows. Fine up to a few hundred; very large reconciles (5K+ rows) could hit request size limits. No fallback split yet.
- **Receive PO inline-create doesn't refresh the catalog search index in the same session** — if the manager creates a new SKU then types it in a later line of the same PO, search won't auto-complete. Workaround: close + reopen the sheet.
- **Responsive status (verified June 2026 at 390px):** the app no longer horizontally overflows on phone anywhere — manager shell + all tabs, all inventory sub-tabs (data tables collapse to cards), the action sheets (Receive PO etc. use flexible `fr` grids that fit), and the crew app are all clean. The only remaining phone weakness: the **Sonar / Fiber-jobs import sheets' transaction tables** are *cramped* (many columns, `width:100%` so contained, not overflowing) on a narrow viewport — still admin-only flows where manager-on-laptop is assumed, so left as-is. Making those two tables phone-friendly (table → cards) is the only outstanding responsive work, and it's low priority.
- **Audit CSV round-trip uses location *names***, not IDs. If two trucks happen to display the same first name (e.g. two crew named "Chris"), reconcile may match to the wrong one. Surface = warning, not blocker.
- **TaskWorkspace submit — empty assemblies path:** `handleSubmit` gates the `saveEntry` call on `(allParts.length > 0 || extraParts.length > 0)`. If you ever change that condition, make sure both paths still create the log_entry — the earlier bug was gating on `allParts` alone, which silently dropped extra-only submissions on the floor. Especially relevant for infra crew while their kit catalog is still empty (they rely on "Add part not in list").

## Recent major work

- **Working-manager toggle + crew read-only view (May 2026):** `viewMode` in AppContext + `App.jsx` router lets staff users flip into the crew shell to log their own work; `🔧 Crew mode` / `⚙️ Manager` pills in both portals, "acting as crew" badge on the crew user chip. `TaskSummaryView` gives crews a read-only inspection of pending/approved/done tasks (parts, hours, scope notes, status banner, flag reasons / manager notes); both `CrewApp` and `InfraCrewApp` route to it via a shared `isReadOnlyTask` check. Completed tasks made tappable in both crew shells, dates rendered on completed rows, dark-mode toggle ported into both crew shells. Password min length corrected 6 → 8 in admin UI to match Supabase Auth's enforcement. Last unmapped site (Prestige II) mapped to Heber.
- **Sites admin polish (May 2026):** Edit Site overlay gained move-to-project (project picker), View tasks drilldown, View materials drilldown (parts summed across all task_id-linked movements). Decommission confirm hints to log physical equipment recovery as a Receive PO with a "Site decommissioned" note. Search + type-pill filtering renders when ≥8 sites. Per-site active task count badge. Helpers added to `lib/supabase.js`: `updateSite`, `decommissionSite`, `getTaskCountsBySite`, `getTasksBySite`, `getMaterialsAtSite`, `getTaskSummary`.
- **Infrastructure crew end-to-end (May 2026):** `sites` table + 198-row CSV import, `tasks.phase_id` nullable with `tasks_anchor_present` CHECK, `InfraCrewApp` shell (Project → Site → Task), crew-type-aware `TaskWorkspace` tab strip, `approve_submission` auto-deducts via `sites.project_id` fallback, project buckets backfilled for Wasatch Front + West Mountain. Manager-side polish: `SubmissionsQueue` + `ReportsView` coalesce phase/site, `crew_activity_today` view rewritten, `ProjectManager` surfaces an embedded Sites admin (add / edit / decommission / search / task-count). Realtime channel collision fix (`nextChannelSuffix()`). Extra-parts-dropped-on-submit fix in `TaskWorkspace`.
- **Inventory framework rebuild (May 2026):** Crew personal trucks, three-layer permission framework (per-user × crew_type×dept × CHECK constraints), project buckets, auto-deduct on approval, Flavor A project routing override, Receive PO, Reconcile, Sonar import, Locations tab counts + jump-link, Vitest tests for `calculations.js`.
- **Security audit (May 2026):** RLS rewrite on 14 tables (was wide-open USING(true)), view + function hardening, EXECUTE grants tightened.
- **Bins:** Sub-locations under warehouses, schema + full UI rollout (Locations / Stock / RecordMovement / BulkMove). Single-level nesting only.
- **Audit export:** New `🔍 Audit` sub-tab in Inventory. Filter by scope / part status / stock level / department / material group / staleness. Generates CSV with `Actual Qty` blank column and `Variance = =J<row>-I<row>` formula. Round-trips into the Reconcile sheet.
- **User management:** Full add/edit/deactivate/reset-password from the manager Admin panel via the new Users view. Per-user movement permission toggles live in the user-edit sheet.
- **Theme + login:** Dark/light theme persists. Login is username + password with auto-domain append.
