# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, infrastructure-crew, install techs, and managers across multiple BEAD-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

> **Need the full end-to-end inventory walk-through?** See [docs/INVENTORY_FLOW.md](docs/INVENTORY_FLOW.md) — covers every crew workflow, every manager entry point, and the Sage export at the end of the line.
>
> **Need a deep dive on the Inventory tab specifically?** See [docs/INVENTORY_TAB.md](docs/INVENTORY_TAB.md) — every sub-tab, every action sheet, and how they fit into the daily/weekly/monthly cadence.
>
> **The crew-facing how-to (bilingual EN/ES)?** See [docs/CREW_GUIDE.md](docs/CREW_GUIDE.md) — rewritten July 2026 for the is_closed multi-passdown model.

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
- Phase actuals still increment only when `phase_id IS NOT NULL` (no "site actuals" concept). The crew_type guard is `{fiber_construction, field_service, infrastructure}` (plus legacy `aerial`/`underground`/`splice`/`fiber_tech` still in the IN-list for back-compat).
- All 7 infra projects (Fixed Wireless, Gigwave, Heber, Ogden Valley, Park City, Wasatch Front, West Mountain) have project buckets. Wasatch Front + West Mountain were backfilled when the auto-deduct path was wired — they pre-dated `trg_ensure_project_job_site` and never got auto-created. The backfill migration is idempotent so it's safe to rerun.

**Per-site attributes the owner cares about:** name / type / category / address / status. Tower height, power source, etc. are intentionally NOT stored.

**Onboarding remaining:**
1. Add infra users via Users admin with `crew_type = 'infrastructure'` (each auto-gets a personal truck via `trg_ensure_crew_truck`). Chad Sperry done; rest of infra crew to follow.
2. Fix the 1 unmapped site (Prestige II / "Fiber - Mdu") — currently `project_id IS NULL`.
3. Sites admin shipped — embedded in ProjectManager's project detail view. Add / edit (rename, change type, address, notes) / decommission (soft delete via status='decommissioned'). Search + type pills render when ≥8 sites. Per-site task count badges. Decommission confirm hints to log physical equipment recovery as a PO with a "Site decommissioned" note. No hard-delete; sites are FK targets for tasks. The "Tasks at site" drilldown also has **"+ Add task"** (July 2026) — until then `addInfraTask`'s only caller was `SiteTaskList` inside the crew shell, so putting work on an infra site's board meant asking a crew member to create it from their phone. Job-type ids must stay in sync with `SiteTaskList.jsx`.
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
- `App.jsx` router: when `isStaff && viewMode === 'crew' && canActAsCrew(currentUser)`, routes to `CrewApp` (or `InfraCrewApp` if `crew_type === 'infrastructure'`) instead of `ManagerApp`. `VALID_FIELD_CREW_TYPES` (`fiber_construction | field_service | install | infrastructure`) lives in **`src/lib/crewTypes.js` only** — it is no longer duplicated in `App.jsx`/`ManagerApp.jsx`; both go through `canActAsCrew()`.
- **Owner can also be a field worker (July 2026).** `ACCESS_TYPES.owner` is `needsCrew: true`, so the Users admin shows an *optional* crew-type picker for owners (and working managers) — `accessTypeToFields` does `crewType || null`, so "None" is a valid save. Before this, Owner forced `crew_type = NULL` on every save, so `canActAsCrew()` could never be satisfied for an owner and the crew-mode pill was permanently disabled with **no admin escape hatch** — the exact trap the owner hit. The staff picker deliberately omits `contractor` (a legal `crew_type` that `canActAsCrew` rejects, which silently produced staff who couldn't enter crew mode); it's still offered for the `crew`/`contractor` access types and in the bulk-assign filter.
- ManagerApp sidebar: `🔧 Crew mode` pill — **one render site** (`ConsoleSidebar`, shared by the desktop rail and the phone drawer; the narrow top bar has only the hamburger). It's a two-part pill: the body enters crew mode using the crew_type on the row, the chevron opens an **"Enter crew mode as…"** sheet that persists a different `crew_type` and enters in one action (`updateUserMetadata` → `await refreshUsers()` → `enterCrewMode()`; the refresh re-points `currentUser`, which is what makes `App.jsx` re-route — no page reload). When `crew_type` is NULL the whole pill opens that sheet instead of sitting disabled. Warehouse/accounting still get the plain disabled pill — `canActAsCrew` rejects them on *scope*, so a picker would only let them write a value they could never use. The sheet renders at `zIndex: 300` because the phone drawer is `200` and `.overlay` is `100`.
- **Two known gaps, deliberately unfixed:** `crew_activity_today` filters `u.role = 'crew'`, so an owner/manager acting as crew never appears on the Crew Status board (the one-line fix would also surface every working manager + contractor there). And `ensure_crew_truck()` fires `ON INSERT OR UPDATE OF role, is_active` only, so a user who gains a `crew_type` *after* creation gets no auto-truck — pre-existing for working managers.
- CrewApp + InfraCrewApp sidebar footers + SignOutConfirm overlays: `⚙️ Manager` pill (only rendered when `isStaffActingAsCrew`). User chip subtitle picks up an "· acting as crew" callout in teal so the manager remembers which mode they're in.

**Same identity, same truck.** No account sprawl. All inventory, audit trail, and approval flows use the same `user_id`.

**Auto-deduct caveat:** `approve_submission` still requires `crew_type ∈ {fiber_construction, field_service, infrastructure}` (plus legacy `aerial`/`underground`/`splice`/`fiber_tech`) for the truck → project bucket transfer to fire. A manager with `crew_type = 'install'` or `'contractor'` (or legacy `'drop'`/`'locator'`) can log work in crew mode but their approvals won't auto-deduct. Documented; not enforced in the router because the manager might legitimately want to log non-deducting work.

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
- **Supabase anon key:** in `.env` as `VITE_SUPABASE_ANON_KEY`. Hardcoded fallback in `src/lib/supabase.js` for safety. The key is public by design — RLS in the DB is the access boundary (tightened May 2026; see backlog #12 for the remaining intentional exceptions).
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
  Login.jsx               ← username + password login (auto-domain append, remembered username)
  styles/global.css       ← CSS variables + shared classes (pill, banner, metric, avatar, etc.) for both light + dark theme
  lib/
    supabase.js           ← Supabase client + DB helpers (projects, users, tasks, sites, etc.)
    inventory.js          ← all inventory operations (locations, stock, movements, parts, audit, consumption ledger, Sage export, purchase requests, intake requests)
    admin.js              ← user management ops (create/update/deactivate/reset password/set email)
    access.js             ← staff_scope / named-access-type single source of truth (staffScope, visibleManagerTabs, canActAsCrew, inventoryIsLimited)
    crewTypes.js          ← crewTypeLabel() display map + VALID_FIELD_CREW_TYPES
    cycleCount.js         ← cycle-count RPC wrappers + BIN:<uuid> barcode helpers
    backStack.js          ← Back-button coordinator + useBackClose hook
    i18n.js               ← en/es strings for the crew shells (~290 keys; crew lang toggle reads/writes localStorage.fiberlog_lang)
    csvImport.js          ← shared CSV parse/read utilities (byte-level)
    useCsvImport.js (+ .test.js) ← import-wizard hooks: useCsvFile / useSonarPendingQueue / useEffectiveMap / useAlreadyImportedMarkers + pure extractMarkerKeys
    shared.js (+ .test.js) ← extracted money-path helpers: mergePartsById (submit), matchesAllTokens (search)
    format.js             ← fmtWhen(iso, lang) shared date formatter
    useRealtimeQueue.js   ← subscribe + try/catch + auto-reconnect hook for review queues
    inventory.test.js     ← validateMovement matrix, buildSageCsv + exclusions, movementEffectiveDate
    footageTypes.js       ← footage "type" option lists (fiber counts, conduit sizes)
    recencyPill.js, scanFeedback.js ← small shared UI helpers
    useIsWide.js          ← shared 768px-breakpoint hook (used by both CrewApp and ManagerApp)
  components/
    shared/               ← Icon.jsx (line icon set), PausedBanner.jsx, ScanInput.jsx (USB scanner + phone camera), QrLabelSheet.jsx (config-driven QR label chassis + PrintPortal — the ONE home of the Chrome print-CSS)
    crew/                 ← UI for non-manager users (logging work, parts used, etc.)
      CrewApp.jsx         ← fiber-crew entry: Project → Phase → Task → Workspace
      ProjectList.jsx, PhaseList.jsx, TaskList.jsx, TaskWorkspace.jsx
      taskState.js        ← single source for isReadOnlyTask/isActiveCrewTask/isCompletedTask (all is_closed-based — never gate on tasks.status)
      SignOutConfirm.jsx  ← shared sign-out sheet (language toggle, change password, manager pill) used by both shells
      PassdownList.jsx    ← shared passdown-card list (status/hours/parts/notes) for TaskSummaryView + TaskWorkspace's history overlay; exports fmtWhen
      TaskSummaryView.jsx ← read-only inspection of CLOSED tasks — lists ALL passdowns; both crew shells route here when isReadOnlyTask(task)
      MyStockView.jsx     ← crew's personal-truck inventory view (Load + Return UI)
      CrewMovementSheet.jsx ← unified overlay for load/return (other ops are RPC-supported, UI deferred); over-load warn-but-allow + crew-type whitelist badges live here
      FoundInventorySheet.jsx ← crew "report found inventory" → pending intake request (backlog #19)
      workspace/          ← PartSearch.jsx (catalog search overlay — the only file left here; the workspace tab bodies live inline in TaskWorkspace.jsx)
      infra/              ← sites-shaped shell for crew_type='infrastructure'
        InfraCrewApp.jsx  ← entry: loads getInfraTree(), runs its own task realtime sub
        SitesList.jsx     ← project's sites, type-filterable (wireless / fiber)
        SiteTaskList.jsx  ← site's tasks + New-task overlay (infra job types)
    cycleCount/           ← scanner-driven cycle counting (count_runs/sessions/lines/resolutions)
      CountTab.jsx        ← Inventory → Cycle Count sub-tab (takes over the full panel)
      CountStartSheet.jsx, CountRunScreen.jsx, CountRunReviewSheet.jsx, CountRunHistorySheet.jsx
      BinLabelSheet.jsx   ← printable BIN:<uuid> QR labels
    manager/              ← UI for owner/manager users
      ManagerApp.jsx      ← entry, top-level nav (Approvals / Crew / Projects / Reports / Assemblies / Inventory / Admin)
      AdminPanel.jsx      ← admin home — wires Users, Reset-password, BoxHero sync, Crew×Dept permissions
      AdminUsersView.jsx  ← user CRUD + per-user movement permission toggles
      CrewTypePermissionsView.jsx ← crew_type × department matrix (whitelist UI)
      InventoryView.jsx   ← inventory section (8 sub-tabs: Stock / Locations / Parts / Activity / Purchase Reqs / Found / Audit / Cycle Count; toolbar "Record movement" button + an 8-item Actions strip: Move stock / Receive PO / Reconcile / Sonar / Fiber jobs / Import CSV / Sage export / Footage map — collapses to a bottom sheet on phone)
      InventoryStockTab.jsx, InventoryLocationsTab.jsx, InventoryPartsTab.jsx,
      InventoryMovementsTab.jsx, InventoryAuditTab.jsx
      PurchaseRequestsTab.jsx, PurchaseRequestSheet.jsx ← FiberLog-originated PRs (compose, cost history, CSV/email export, lifecycle)
      ReviewQueue.jsx     ← config-driven review-queue chassis (header/filter/list/detail overlay) + ReviewActions/InitialsAvatar/StatusPill — both queues build on it (backlog #22)
      IntakeRequestsQueue.jsx ← "Found" sub-tab — approve/reject crew intake requests (on ReviewQueue)
      importShared.jsx    ← shared import-wizard chrome: Section/MappingRow/StatusBadge/SourceLocationSelect/webhook panels (Sonar + FiberJobs + InventoryImport)
      chrome.jsx          ← shared manager styling tokens: chipStyle / cardSurface / LoadingBlock / EmptyState
      LocationDetailPanel.jsx ← location drill-in (view stock / count / export / labels / edit)
      LocationWithBinPicker.jsx ← shared warehouse→bin destination picker
      RecordMovementSheet.jsx ← arbitrary single-movement entry
      MoveStockSheet.jsx  ← scan-driven stock relocation (transfer)
      ReceivePOSheet.jsx  ← multi-line vendor delivery (creates new parts inline, edits attrs)
      ReconcileSheet.jsx  ← audit CSV round-trip → adjust movements
      SonarImportSheet.jsx ← field-tech install report → bulk transfer movements
      FiberJobsImportSheet.jsx ← fiber-jobs report → bulk transfer movements
      BulkSonarProjectsSheet.jsx ← bulk Sonar project → phase mapping
      SageExportSheet.jsx ← Sage Intacct CSV export (see backlog #4 — shipped prototype)
      FootageMapSheet.jsx ← footage type → SKU mapping admin (footage_type_part_map)
      SkuLabelSheet.jsx, AisleSignSheet.jsx ← printable part QR labels / aisle signs
      BulkMoveSheet.jsx, InventoryImportSheet.jsx
      AssemblyEditor.jsx  ← assembly templates (kits crew can pre-fill from)
      ReportsView.jsx, SubmissionsQueue.jsx, ProjectManager.jsx, CrewStatus.jsx
supabase/
  functions/
    admin-set-password/index.ts   ← reset another user's password (owners/managers only)
    admin-create-user/index.ts    ← create a new user (creates auth.users + public.users)
    admin-set-email/index.ts      ← change a user's login email (auth.users + public.users mirror)
    sonar-webhook/index.ts        ← receives Sonar's scheduled CSV-zip delivery → sonar_pending_imports
```

---

## Database schema highlights

### Auth & users
- Each user has a row in `auth.users` (Supabase) AND a matching row in `public.users` with the same UUID
- Login uses synthetic emails: `firstname.lastname@fiberlog.utahbroadband.com`
- `public.users.email` mirrors `auth.users.email`; **don't change it** after creation (it's the auth identity)
- `public.users.role` CHECK: `owner | manager | crew | contractor` (the RLS/security primitive).
- `public.users.crew_type` CHECK (nullable). **Assignable values: `fiber_construction | field_service | install | infrastructure | contractor`.** Legacy values `aerial | underground | splice | drop | locator | fiber_tech` are kept VALID for back-compat but no longer assignable (June 2026 merges: aerial+underground → `fiber_construction`; splice+drop+locator+fiber_tech → `field_service`; see Recent major work). Render via `crewTypeLabel()` in `lib/crewTypes.js`, never raw. Only **Crew** and **Working manager** access types carry a crew_type; every other staff type persists `crew_type = NULL`.
- **`public.users.staff_scope`** CHECK: `full | warehouse | accounting` (nullable; NULL = full). Manager-portal UI scope, supersedes the legacy `restricted_to_inventory` boolean (kept as a fallback in the helper). `full` → all tabs; `warehouse` → Inventory(full ops) + Reports + Admin; `accounting` → Reports + a **limited** Inventory (Receive PO + Purchase Requests + read-only stock). **`src/lib/access.js` is the single source of truth** — `staffScope()`, `visibleManagerTabs()`, `canActAsCrew()` (only full-scope + a field crew_type can flip into the crew shell), `inventoryIsLimited()`, plus `ACCESS_TYPES` / `accessTypeForUser` / `accessTypeToFields`. The Users admin picks a **named access type** (Owner / Full manager / Working manager / Warehouse manager / Accounting / Crew / Contractor) which maps to `{role, staff_scope, crew_type}`. UI-scoping only — RLS still governs the API (same posture as restricted_to_inventory).
- `users_login_picker` RLS policy allows anon `SELECT` WHERE `is_active = true` (so the login screen can show the user list)

### Inventory locations & bins
- `inventory_locations.type` CHECK: `warehouse | truck | group | job_site | vendor | scrap | bin`
- **Group** locations are shared/multi-member buckets (Contractor - RNS, Crew - Construction Underground/Aerial) — distinct from personal trucks, with their own section in the Locations admin. A group's "members" are the users whose `default_pull_location_id` points at it (so `getMyTruck` resolves the group as their My-Stock with full load/return access). Manage members via the Locations admin **Members** editor (`GroupMembersSheet` in `InventoryLocationsTab.jsx`): Add reuses `bulkAssignPullLocation` (consolidates the user's personal-truck stock into the group + retires that truck); Remove clears the pointer + restores a personal truck. Helpers: `getGroupMembers`, `getMemberCountsByLocation`, `removeUserFromGroup` in `lib/inventory.js`. All shared (assigned_to-null) trucks were migrated to this type June 2026.
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
- `inventory_movements.occurred_at timestamptz` (nullable, no default) — the real **work/job date**, distinct from `created_at` (import/insert timestamp). Backfilled from the date token in `notes` for the two import families (fiber-jobs `[sonar_jobs:<acct>_YYYY-MM-DD_<type>]`, field-tech prose `Sonar install · YYYY-MM-DD HH:MM · …`) — migration `20260702000000_inventory_movements_occurred_at.sql` (487 rows). Consumers (reporting / Sage) should `COALESCE(occurred_at, created_at)`. Crew load/return + auto-deduct rows leave it NULL because for them `created_at ≈ work date`. Backfilling it is an `occurred_at`-only UPDATE — safe past the column-scoped `trg_inv_movement_immutable` trigger, which guards `notes` (and 12 other core fields) but not `occurred_at`; never set `notes` in the same UPDATE.
- A trigger updates `inventory_stock` automatically when a movement is inserted
- **CHECK constraint `movement_endpoints_valid`** enforces correct from/to per type (e.g., `receive` requires `to NOT NULL, from NULL`; `transfer`/`return` require both and different). The JS `validateMovement()` in `lib/inventory.js` mirrors this so we fail fast.

### Accounting destinations (`type='job_site'`)
- **Project destinations** — one per active project, `project_id` set, auto-created by trigger `trg_ensure_project_job_site` on project insert/activation. Names match the project name. Receive auto-deduct transfers from approval AND `region`-routed Sonar imports.
- **Gigwave + Fixed Wireless destinations** — these are now first-class projects (created in migration `sites_table_and_wireless_projects`) with their own auto-created project buckets. The pre-existing standalone `Gigwave` bucket from the Sonar work was reconciled to point at the new Gigwave project, so existing Sonar `gigwave` routing keeps working. Same consumption-ledger semantics as fiber regions.
- **None destination** — RETIRED June 2026 (`is_active=false`). Fixed Wireless took over: Sonar `none`-routing now resolves the **Fixed Wireless** project bucket (the `none` token is kept internally to avoid a `sonar_routing` CHECK change; the routing option is labeled "Always Fixed Wireless"). None's residual stock was transferred to Fixed Wireless. The empty `Region None` / `Region Gigwave` buckets were retired at the same time.
- Project destinations are the permanent record of consumption per project. Sage export pulls from them per period; they are not "drained" in the bucket sense — they are the consumption ledger keyed by project.

### Sites (infra crew's unit of work)
- `sites(id, name, type fiber|wireless, project_id, address, lat, lng, status active|decommissioned, notes)` — each site belongs to one project (Gigwave / Fixed Wireless / a fiber region). Auto `updated_at` via trigger. RLS: auth read, staff write.
- `tasks.site_id` (nullable) — infra tasks anchor here. Consumed by `getInfraTree()` + `InfraCrewApp`.
- `tasks.phase_id` is now **nullable** (was NOT NULL). CHECK `tasks_anchor_present` ensures every task has at least one of `{phase_id, site_id}` — never both NULL.
- `tasks.is_closed boolean NOT NULL DEFAULT false` + `tasks.closed_at timestamptz` + `tasks.closed_by uuid → users(id)` — the **manager-controlled lifecycle gate** (backlog #2). Decoupled from submission approval: a task stays open across multiple daily passdowns and only leaves crew active lists when a manager explicitly closes it (`is_closed=true`). `tasks.status` is now just a display mirror. Backfilled `is_closed=true` for existing `approved`/`done` tasks (migration `20260706000000_tasks_is_closed_lifecycle.sql`).
- **Tasks are SHARED across crew by design** (handoffs, multi-crew passdowns) — anyone can open/log against any open task. Guardrails (July 2026): opening a task holding someone else's non-empty unsubmitted draft pops a confirm (decline = zero trace), an amber "Editing X's UNSUBMITTED draft" banner shows while inside it, and the passdown-history strip names other contributors. Submitted passdowns are per-submitter and immutable to others. Escalation option if crews still collide: per-user drafts (working_counts keyed by user).
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

### Manager edit-then-approve (fix materials in place)
The common reason to flag a passdown is "the materials aren't right." Rather than bouncing it back to the crew (flag → rework → resubmit), a manager can correct a **pending** submission's parts (qty / add / remove) and hours directly in the `SubmissionsQueue` detail overlay via **"Edit materials & hours"**, then Approve — `approve_submission` reads the live `entry_parts`, so the deduction reflects the edits. Backed by the `replace_submission_parts` RPC (staff-guarded, pending-only, submission-scoped — see RPC table). Save leaves the submission pending (Approve is a separate, deliberate step that posts the irreversible deduction); dirty edits confirm on Back/Cancel (`useBackClose`). Flag stays available for genuine send-backs (wrong task, redo the day) — and when a flag *is* used, `TaskWorkspace` now restores the flagged passdown's materials into the crew's editable draft on reopen (July 2026). Editing parts changes only the material deduction, not phase actuals (those come from `submissions.total_*`); hours writes `submissions.hours_worked` (the authoritative field — `work_sessions.hours_worked` is unused). The same overlay's edit mode now also exposes the **footage/count rollups** (`total_strand_ft` / `total_fiber_ft` / `total_conduit_ft` / `total_poles` / `total_mst_hst` / `total_splice_cases` / `total_handholes` / `total_vaults`) as editable number fields — these are NOT `entry_parts`, so `replace_submission_parts` leaves them alone; SubmissionsQueue writes them with a direct `db.from('submissions').update(...)` guarded on `actuals_applied_at IS NULL` (pending-only) and recomputes `total_footage = strand + fiber`. `approve_submission` reads these columns straight for phase actuals, so a wrong strand/fiber number can be corrected in place instead of flagged back (July 2026). Reference docs live in [docs/HISTORY.md](docs/HISTORY.md).

### Footage type → part mapping
- `footage_type_part_map(kind, type_value, part_id, updated_at, updated_by)` — PK `(kind, type_value)`. Maps a crew footage "type" pick to the canonical `parts_catalog` SKU that footage should consume. `kind text CHECK in ('fiber','conduit','strand')`; `type_value` is the picked value (e.g. `'144ct'` fiber count, `'2"'` conduit size, `'1/4"'` strand size); `part_id text NOT NULL → parts_catalog(id)`. RLS: auth read, staff write (mirrors `sonar_city_bucket_map` / `sonar_fiber_value_map`). Bump trigger `trg_ftpm_touch_updated_at` on `updated_at`. NOT in the realtime publication. Curated via the manager **Footage map** sheet (`FootageMapSheet.jsx`); 11 mappings as of July 2026. Migrations `20260624120000_footage_type_part_map.sql`, `20260731180000_footage_strand_kind.sql`.
- **Kinds are a registry, not ternaries.** `FOOTAGE_TYPE_VALUES` / `FOOTAGE_HEADING_KEYS` / `FOOTAGE_KIND_LABELS` in `src/lib/footageTypes.js` plus `footageKind(asm)` in `src/lib/footageLines.js` are the single enumeration — the crew picker, the manager map editor and the consumption path all key off them, so a new kind is one registry entry plus one `assemblies.is_*` flag. Assembly flags: `is_fiber` / `is_conduit` / `is_strand`. **`replace_assembly` enumerates every flag in three places** (INSERT columns, VALUES, `ON CONFLICT DO UPDATE SET`) — a flag missing from any of them is silently dropped on every Assembly-editor save.
- **Strand (July 2026)** moved off its old mechanism — a hardcoded `per_ft` assembly part on `strand-ft` — onto the map, so all three footage kinds now work identically. `STRAND_SIZES` is deliberately length 1 (`'1/4"'`, the only strand cable SKU): a kind with exactly one chip is auto-picked when feet are first entered (`autoPickType`), because otherwise strand would regress from "type feet, done" to "type feet AND tap the only chip, or nothing deducts". Adding a strand size turns that auto-pick off — there's a test tripwire on it.
- **The collision guard in `linesToParts` is per-assembly, never app-wide.** It drops a footage row only when *that same assembly* already derives the mapped SKU. `down-guy` consumes 20 ft of the same strand SKU per guy; an app-wide skip would let one down guy silently delete an entire day of strand footage. Two assemblies consuming one SKU is additive consumption.
- **Multi-type footage (July 2026).** The crew's fiber-count / conduit-size chips are **multi-select** — a crew pulling 144ct and 288ct on the same span logs each with its own footage, and each consumes its own SKU. The breakdown lives in `tasks.working_counts.footageLines` (`{ [assemblyId]: [{ type, ft }] }`); `counts[assemblyId]` remains the authoritative total feet that feeds `summary` and the `submissions.total_*_ft` rollups, and the invariant is `counts[id] === sum(lines[id].ft)` — the pure logic (and that invariant) is in `src/lib/footageLines.js` with tests, because it decides which SKU leaves the truck. Legacy drafts carrying the old scalar `fiberCount` / one-size-per-slot `conduitSizes` are migrated on load by `migrateLegacyFootage`; the autosave still writes those two keys as a **rollback mirror** that should be deleted a week after deploy. No schema change was needed — `entry_parts` has no uniqueness on `(entry_id, part_id)` and `approve_submission` aggregates `GROUP BY part_id`.

### Parts catalog
- `parts_catalog.id` is the SKU (text PK)
- `parts_catalog.is_active = false` means it's a **draft** (auto-created during CSV imports for SKUs not yet in catalog)
- `parts_catalog.category` is computed as `Department / Material Group` automatically — **don't update it manually**, instead update `department` and/or `material_group` and let the helpers in `lib/inventory.js` rebuild it

### Realtime publication
The following tables broadcast changes via Supabase Realtime: `app_settings`, `emergency_logs`, `inventory_intake_requests`, `log_entries`, `submissions`, `tasks`, `work_sessions`. Subscriptions are scattered:
- `tasks` — subscribed globally in `AppContext` (keeps the project tree in sync everywhere) AND per-phase in `TaskList` (manages local phase state).
- `submissions` — `SubmissionsQueue` subscribes for INSERT/UPDATE.
- `work_sessions` — `CrewStatus` subscribes for all events.
- `emergency_logs`, `log_entries` — published but no JS subscriber yet.

---

## Edge functions

Four are deployed and active:

- `admin-set-password` — owner/manager resets another user's password. Verifies caller via JWT, uses service_role to update `auth.users`.
- `admin-create-user` — owner/manager creates a new user. Creates `auth.users` row, then `public.users` with matching UUID. Rolls back the auth row if profile insert fails. Only owners can create owners.
- `admin-set-email` — owner/manager changes another user's login email (updates `auth.users` AND mirrors into `public.users`). Built for migrating accounts off the synthetic `*.fiberlog.utahbroadband.com` addresses so password-reset emails deliver.
- `sonar-webhook` — receives Sonar's scheduled "Schedule Delivery" webhook (CSV-zip; handles raw zip / multipart / JSON-URL / raw-CSV shapes). Auth is a `?key=` URL secret vs `SONAR_WEBHOOK_KEY` (no JWT — `verify_jwt=false`). Stores rows in `sonar_pending_imports` for the import sheets to consume.

Pattern for new edge functions: copy `admin-set-password` as the template. JWT verification + service_role for privileged ops.

Deploy: `npx supabase functions deploy <name>` (you may need `supabase login` first).

---

## Database RPCs (canonical list)

All `SECURITY DEFINER`, all with `SET search_path = public, pg_temp`. EXECUTE on the trigger-only functions is revoked from `anon`/`authenticated`/`PUBLIC`.

| RPC | Called from JS | Purpose |
|---|---|---|
| `approve_submission(p_submission_id, p_note)` | `lib/supabase.js` → `approveSubmission` | Atomic + idempotent submission approval. Increments phase actuals when phase is set, mirrors task `status='approved'`, auto-deducts materials (truck → project bucket) for fiber_construction/field_service/infrastructure crews (legacy aerial/underground/splice/fiber_tech still in the guard). Bucket lookup: `submissions.project_id_override` → `phases.project_id` → `sites.project_id`. **Backlog #2:** no longer clears `working_counts`/`last_worked_by`/`last_worked_at` — the task stays open across passdowns until a manager closes it via `tasks.is_closed`. **Auto-deduct is submission-scoped** (migration `20260706232824_log_entries_submission_link.sql`): aggregates `entry_parts` for entries with `log_entries.submission_id = p_submission_id`; falls back to the legacy session-scoped WHERE only when the submission has NO linked entries (pre-fix rows). Two coexisting same-day submissions can never double-deduct each other's parts. |
| `replace_submission_parts(p_submission_id, p_parts, p_hours)` | `lib/supabase.js` → `saveSubmissionParts` | Manager edit-then-approve (July 2026). Atomically replaces a **pending** submission's parts (consolidated onto ONE linked `log_entry`) and optionally corrects `hours_worked`, so a manager can fix wrong materials in place instead of flagging back to the crew. SECURITY DEFINER, `is_staff()`-guarded, **pending-only** (raises `42501` once `actuals_applied_at` is set — immutable after approval). Submission-scoped: every write keys on this submission's linked entries, so a same-session sibling passdown is never touched; branches cover part-less and legacy-unlinked entries. Only `entry_parts` change — `log_entries`/footage/`total_*` rollups are untouched, so approve stays consistent (it reads the live edited `entry_parts`). |
| `record_crew_movement(operation, part_id, quantity, other_location_id, ...)` | `lib/inventory.js` → `recordCrewMovement` | Single entry point for crew load/return/issue/scrap/transfer. Checks per-user permission, crew_type×department whitelist, then inserts the movement. |
| `approve_intake_request(p_request_id, p_note)` | `lib/inventory.js` → `approveIntakeRequest` | Backlog #19. Idempotent (anchors on `booked_at`/`movement_id`). Staff-guarded via `is_staff()`. Validates the target is a warehouse, materializes a draft part (`is_active=false`) when the request has no `part_id`, books a `receive` movement (truck-less, into the warehouse → trigger updates stock), flips the request to `approved`. |
| `reject_intake_request(p_request_id, p_note)` | `lib/inventory.js` → `rejectIntakeRequest` | Backlog #19. Staff-guarded. Flips a pending intake request to `rejected` with a reason; no stock moves. |
| `save_log_entry(...)` | `lib/supabase.js` → `saveEntry` | Atomic insert of `log_entries` + `entry_parts`. |
| `replace_assembly(p_assembly jsonb, p_parts jsonb)` | `lib/supabase.js` → `saveAssembly` | Atomic upsert of assembly + replace of `assembly_parts`. |
| `start_count_run(p_warehouse_id, p_notes, p_is_first_binning)` | `lib/cycleCount.js` → `startCountRun` | Cycle counting. Opens a count run for a warehouse. All cycle-count RPCs are staff-gated (`is_staff()`, 42501 for crew). |
| `start_or_resume_count_session(p_run_id, p_bin_id)` / `record_count_line(p_session_id, p_part_id, p_counted_qty)` / `delete_count_line(p_line_id)` / `submit_count_session(p_session_id)` | `lib/cycleCount.js` | Per-bin counting session lifecycle: open/resume a session, record a counted line, hard-delete an unexpected (expected_qty=0) line, submit the session. |
| `end_count_run_and_reconcile(p_run_id)` | `lib/cycleCount.js` → `endCountRunAndReconcile` | Closes a run: books offsetting bin↔bin `transfer` movements for paired variances and creates pending `count_resolutions` for net gains/losses. |
| `approve_count_resolution(p_resolution_id, p_note)` / `discard_count_resolution(p_resolution_id, p_reason)` / `discard_count_run(p_run_id, p_reason)` | `lib/cycleCount.js` | Manager review of net_gain/net_loss resolutions — approve books an `adjust` movement; discard carries a reason. `discard_count_run` abandons a whole run. |
| `deactivate_location_with_recovery(p_location_id, p_recovery_items, p_destination_location_id)` | `lib/inventory.js` | Retire a location, optionally moving its residual stock to a destination first. Staff-guarded via `is_staff()` (July 2026 — was owner-only, backlog #30). |
| `decommission_site_with_recovery(p_site_id, p_recovery_items, p_destination_location_id)` | `lib/supabase.js` | Site decommission + optional physical-equipment recovery movements. Staff-guarded via `is_staff()` (July 2026 — was owner-only, backlog #30). |
| `bulk_assign_pull_location(p_user_ids, p_location_id)` | `lib/inventory.js` → `bulkAssignPullLocation` | Points users' `default_pull_location_id` at a group location, consolidating their personal-truck stock into it (group membership add). |
| `next_pr_number()` | `lib/inventory.js` | Mints the next purchase-request number (`PR-YYYY-####` from `purchase_requests_seq`). |
| `is_staff()` | RLS policies | Returns true if `auth.uid()`'s role is owner/manager. STABLE. |
| `is_owner()` | RLS/RPC guards | Returns true if `auth.uid()`'s role is owner. |
| `cascade_task_terminal_to_session()` | Trigger only | When task status → pending/approved/done, flips matching `started` work_sessions to `submitted`. |
| `ensure_crew_truck()` | Trigger only | Auto-creates a personal truck for new crew/contractor users. crew_type IN-list includes the merged `fiber_construction`/`field_service` (July 2026, backlog #28). Trigger fires on INSERT or UPDATE OF role/is_active only — not on crew_type-only updates. |
| `ensure_project_job_site()` | Trigger only | Auto-creates a job_site bucket for new active projects. |
| `update_inventory_stock_on_movement()` | Trigger only | Maintains `inventory_stock` from `inventory_movements` inserts. |
| `validate_inventory_location_parent()` | Trigger only | Enforces bin parent rules (only warehouses can be parents, single-level only). |
| `validate_count_session_bin()` | Trigger only | Guards count-session bin validity. |
| `increment_phase_actuals(...)` | (legacy, kept for compatibility — `approve_submission` does the work inline now) | |
| `crew_op_perms_touch_updated_at()`, `app_settings_touch_updated_at()`, `purchase_requests_touch_updated_at()`, `sites_touch_updated_at()`, `ftpm_touch_updated_at()`, `scbm_touch_updated_at()`, `sonar_project_map_touch_updated_at()` | Trigger only | `updated_at` bump triggers for their respective tables. |
| `increment_session_counts(...)`, `update_session_timestamp()`, `update_updated_at_column()`, `prevent_movement_modification()`, `prevent_movement_delete()` | Triggers / legacy | |

---

## Tests

`npm test` (one-shot) or `npm run test:watch`. Vitest configured via `package.json` only — no separate config file.

**79 tests across 4 suites** (re-pointed July 2026 — the old `calculations.js` + its 34 tests were DELETED after the audit proved the module unreachable from the app; the suite was guarding dead code). Note `npm test` from the repo root also scans `.claude/worktrees/*`, so a checkout with sibling worktrees reports a multiple of these numbers — the real count is what a clean clone runs:
- `src/lib/inventory.test.js` — `validateMovement`'s full endpoint matrix (mirrors the DB `movement_endpoints_valid` CHECK), `buildSageCsv` (18-column order, movement-type → Sage mapping, effective dates, CSV escaping), `isExportableMovement` exclusion rules, `movementEffectiveDate`.
- `src/lib/shared.test.js` — `mergePartsById` (the submit-path dedupe) and `matchesAllTokens` (multi-word search semantics).
- `src/lib/useCsvImport.test.js` — `extractMarkerKeys` (the double-import guard's marker parser, incl. `sonar` vs `sonar_jobs` prefix isolation).
- `src/lib/footageLines.test.js` — the multi-type footage breakdown: `linesToParts` (one SKU per picked type, unmapped/zero/assembly-shadowed skips, two-types-one-SKU), the `counts === sum(lines)` invariant across an edit sequence, and `migrateLegacyFootage` (legacy scalar drafts → lines).
- No component tests yet (no jsdom/testing-library in devDeps). The crew workflow + manager sheets are smoke-tested via QA persona runs (see `qa-harness/README.md`) and manually on the deployed app.

---

## Conventions / patterns

### Code style
- Functional components with hooks. No class components.
- Heavy inline styles using CSS variables. No Tailwind, no CSS-in-JS libraries.
- Theme tokens (post-Console redesign, emerald-primary): surfaces `var(--bg)`, `var(--surface)`, `var(--surface2)`, `var(--sidebar)`, `var(--row-divider)`, `var(--text)`, `var(--muted)`, `var(--hint)`, `var(--border)`, `var(--border2)`; the primary is `var(--accent)` / `--accent-dk` / `--accent-lt` / `--accent-mid` (the legacy `--orange*` / `--teal*` tokens are kept as aliases of `--accent*`, so old code still renders correctly); hue families `--amber*`, `--blue*`, `--red*`, `--gray*`, `--purple*`; semantic roles `--accent-bg/fg/border`, `--success-*`, `--warning-*`, `--danger-*`, `--info-*`. Type scale `--fs-xs…--fs-2xl`, weights `--fw-medium…--fw-black`. Radius tokens: `var(--r)`, `var(--r-sm)`, `var(--r-xs)`, `var(--r-pill)`. All defined in `src/styles/global.css` (light `:root` + dormant `[data-theme="dark"]`).
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

Shipped: crew narrow screen stack + sign-out dialog (Phase 1, `CrewApp.jsx`/`InfraCrewApp.jsx`); crew overlays/sheets with unsaved-input confirm (Phase 2a — `PartSearch`, `CrewMovementSheet`, `FoundInventorySheet`, the new-task overlays in `TaskList`/`SiteTaskList`; the redesigned `TaskWorkspace` no longer has separate picker overlays of its own); manager tab navigation (Phase 3 — any non-home tab → Back returns to the home tab); manager sheets + in-view overlays (Phase 2b — all standalone inventory sheets like Record Movement / Receive PO / the CSV importers / Reconcile / Sage / Bulk Move / labels / Purchase Request / Location Detail, plus the inline overlays in ProjectManager / AdminPanel / AdminUsersView / Inventory{Locations,Parts}Tab / SubmissionsQueue / AssemblyEditor). Standalone sheet components register `useBackClose(1, onClose, …)` *inside themselves* (mounted only when open → depth 1); inline overlays register at the owning view keyed on their open-boolean. Data-entry sheets/forms pass `opts.confirm` reading their own dirty state (window.confirm), display/print/confirm overlays close immediately; the coordinator moves a layer to the top of the stack on activation so an overlay opened over a drilled-in screen (or a nested sheet) receives Back first. Manager in-tab drill-ins (Phase 3 cont. — InventoryView sub-tab → Stock, ProjectManager phase/project detail → list, AdminPanel sub-view/project detail → home) and crew wide-layout sidebar selection (Phase 4 — task → phase/site → picker, plus the My Stock toggle) use depth-valued `useBackClose` the same way the narrow screen stack does. **Back-button coverage is now complete across both shells and both layouts.** The only deliberate non-coverage: click-outside popovers (e.g. InventoryView's "⋯ More" menu) are not Back-wired.

### Browser autofill suppression
For any input that's NOT meant to be filled by the browser's saved-credentials list, use `autoComplete="off"` plus a non-standard `name=` like `name="user-search"`. For password reset / new-password fields, use `autoComplete="new-password"`. Past bug: opening the reset-password sheet was autofilling the user's username into the search field below.

### Persistence
- `localStorage.fiberlog_dark_mode_v2` — theme preference (key bumped from `fiberlog_dark_mode` when dark Console shipped; the old key is orphaned — see backlog #23)
- `localStorage.fiberlog_remembered_username` — last login username
- `localStorage.fiberlog_view_mode` — `'manager' | 'crew'` for the working-manager toggle. Reset to `'manager'` on logout in `AppContext.logout()` so a different next-user doesn't inherit it.
- `localStorage.fiberlog_counts_<taskId>` — offline fallback mirror of the crew workspace tally draft (`TaskWorkspace.jsx`; the primary store is `tasks.working_counts` — localStorage is only read when that query fails).
- `localStorage.fiberlog_lang` — crew's per-device language override (`'en' | 'es'`). Resolve order in AppContext: this override → `users.language` (manager-set default) → `'en'`. **Deliberately NOT cleared on logout** (a Spanish speaker's phone stays Spanish; the login screen has its own toggle for shared devices). Crew can't write their own `users` row (RLS), so this is the only self-service persistence.
- `localStorage.fiberlog_expanded_project_<userId>` — which project the crew sidebar auto-expands (last one they opened). Keyed per user so shared devices don't leak; first-ever login starts collapsed. Replaced the old auto-expand-first-project default that opened Heber for everyone.

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

## Backlog

The full backlog (priority order, shipped + open items with rationale) lives in **[docs/BACKLOG.md](docs/BACKLOG.md)** — moved out of this file to keep always-loaded memory lean.

## Gotchas worth knowing

- **Phase/project deletes are FK-blocked once the ledger references them** — `inventory_movements.phase_id` is ON DELETE NO ACTION, and auto-deduct + the importers stamp `phase_id` on movements. Any worked phase can't be deleted from AdminPanel until the FK rule changes (proposed: SET NULL, migration pending owner approval July 2026). AdminPanel's delete chains now surface the real error instead of falsely toasting success — supabase-js returns `{error}`, it doesn't throw, so every step of a destructive chain must check it.
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
| Crew Load (`CrewMovementSheet` → `record_crew_movement` RPC) | `transfer` | warehouse → caller's truck | Permission-checked. **Multi-part:** a line cart lets the crew queue several parts (load can pull from different sources in one go) and submit them together — the sheet loops `record_crew_movement` per line (no crew batch RPC), keeping failed lines in the cart for retry on partial failure. A **review-and-confirm step** precedes the commit for multi-part / any return / any non-truck load (single-part → own truck skips it). |
| Crew Return (same RPC) | `return` | caller's truck → warehouse | Permission-checked. Same multi-part cart (one shared destination warehouse, many truck parts). |
| Crew Issue/Scrap/Transfer | (same RPC, UI not shipped) | caller's truck → (varies) | RPC ready, sheets deferred |
| Manager Record movement (`RecordMovementSheet`) | any of 6 | any → any | Free-form, no permission filter |
| Manager Move stock (`MoveStockSheet`) | `transfer` (× N lines) | any → any | Scan-driven relocation via `recordMovementsBatch` |
| Manager Receive PO (`ReceivePOSheet`) | `receive` (× N lines) | NULL → dest | Can create new parts inline |
| Manager Reconcile (`ReconcileSheet`) | `adjust` (× N lines) | one-sided | Audit CSV round-trip |
| Manager Sonar import (`SonarImportSheet`) | `transfer` (× N lines) | crew truck → routed bucket | Destination via `parts_catalog.sonar_routing` (region / gigwave / Fixed Wireless) + `sonar_city_bucket_map`. Stamps `[sonar:<itemId>]` in notes + `consumed_by_user_id`/`phase_id` when known |
| Manager Fiber-jobs import (`FiberJobsImportSheet`) | `transfer` (× N lines) | crew truck → region bucket | Stamps `[sonar_jobs:…]` marker + `phase_id`/`consumed_by_user_id` |
| **Found-inventory approval** (`approve_intake_request` RPC) | `receive` | NULL → warehouse | Backlog #19 — books the crew's reported find into stock |
| **Cycle count** (`end_count_run_and_reconcile` + `approve_count_resolution` RPCs) | `transfer` (paired variances) / `adjust` (net gain/loss on approval) | bin ↔ bin / one-sided | Staff-gated; resolutions reviewed in `CountRunReviewSheet` |
| **Auto-deduct on approval** (`approve_submission` RPC) | `transfer` (× N parts) | submitter's truck → project bucket | Gated on crew_type ∈ {fiber_construction, field_service, infrastructure} (+ legacy aerial/underground/splice/fiber_tech). Honors `project_id_override`. |
| BoxHero CSV import (`InventoryImportSheet`) | `adjust` baseline + future flows | varies | Initial seed path |

Things to remember when adding a new entry point:
- All inserts to `inventory_movements` need `created_by` (RLS would 0-affect otherwise). Validate `currentUser?.id` exists before building the payload.
- For staff-initiated movements (manager UI), the manager already has `is_staff()` so the `mgr_write` RLS policy permits the insert. For crew-initiated, route through `record_crew_movement` RPC which is SECURITY DEFINER and bypasses RLS once it's verified the caller's role.
- The CHECK constraint `movement_endpoints_valid` will reject bad from/to combos before the trigger runs. `validateMovement()` in `lib/inventory.js` mirrors this — call it before the RPC for friendlier client-side errors.
- None of the import-style sheets (Receive PO, Reconcile, Sonar) set `task_id` — these are standalone movements not tied to a FiberLog task.

## Known cross-feature gaps + tech debt

- **MyStockView (crew) has no realtime subscription** — `inventory_stock` isn't in the realtime publication. When a manager applies Sonar/Reconcile/auto-deduct that affects a crew's truck, the crew won't see the change until they manually refresh. Comment in the file is explicit.
- **`recordMovementsBatch` itself does a single `.insert(payload)`** (no internal chunking) — but the high-volume callers that matter (`BulkMoveSheet`, `InventoryImportSheet`) already chunk at `CHUNK_SIZE = 100` with a single-row fallback before calling it, and the function validates every row up front. So very large reconciles are handled at the call site, not inside the helper.
- **Receive PO inline-create doesn't refresh the catalog search index in the same session** — if the manager creates a new SKU then types it in a later line of the same PO, search won't auto-complete. Workaround: close + reopen the sheet.
- **Responsive status (verified June 2026 at 390px):** the app no longer horizontally overflows on phone anywhere — manager shell + all tabs, all inventory sub-tabs (data tables collapse to cards), the action sheets (Receive PO etc. use flexible `fr` grids that fit), and the crew app are all clean. The only remaining phone weakness: the **Sonar / Fiber-jobs import sheets' transaction tables** are *cramped* (many columns, `width:100%` so contained, not overflowing) on a narrow viewport — still admin-only flows where manager-on-laptop is assumed, so left as-is. Making those two tables phone-friendly (table → cards) is the only outstanding responsive work, and it's low priority.
- **Audit CSV round-trip uses location *names***, not IDs. If two trucks happen to display the same first name (e.g. two crew named "Chris"), reconcile may match to the wrong one. Surface = warning, not blocker.
- **TaskWorkspace submit — empty assemblies path:** `handleSubmit` gates the `saveEntry` call on `(allParts.length > 0 || extraParts.length > 0)`. If you ever change that condition, make sure both paths still create the log_entry — the earlier bug was gating on `allParts` alone, which silently dropped extra-only submissions on the floor. Especially relevant for infra crew while their kit catalog is still empty (they rely on "Add part not in list").

## Recent major work

The change history / record of major work lives in **[docs/HISTORY.md](docs/HISTORY.md)**.
