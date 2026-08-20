# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, infrastructure-crew, install techs, and managers across multiple BEAD-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

> **Need the full end-to-end inventory walk-through?** See [docs/INVENTORY_FLOW.md](docs/INVENTORY_FLOW.md) — covers every crew workflow, every manager entry point, and the Sage export at the end of the line.
>
> **Need a deep dive on the Inventory tab specifically?** See [docs/INVENTORY_TAB.md](docs/INVENTORY_TAB.md) — every sub-tab, every action sheet, and how they fit into the daily/weekly/monthly cadence.
>
> **The crew-facing how-to (bilingual EN/ES)?** See [docs/CREW_GUIDE.md](docs/CREW_GUIDE.md) — rewritten July 2026 for the is_closed multi-passdown model.
>
> **Receiving a delivery or returned equipment?** See [docs/SOP_RECEIVING.md](docs/SOP_RECEIVING.md) — the staff-facing SOP for the Receive PO sheet (vendor delivery, inline part create, field returns, and how to correct a mis-receipt).
>
> **Onboarding someone new?** See [docs/TRAINING.md](docs/TRAINING.md) — role-based training modules (everyone / crew / manager / warehouse) with live-app practice exercises, safety rules, and the trainer's cleanup checklist. A presentable web version (EN/ES toggle on the crew module) is linked at the top of that doc.

---

## North star

**FiberLog is the single source of truth for inventory consumption across all field crews.** Materials flow from vendor → warehouse → personal truck → project (region). Each project's consumption becomes the permanent record used for accounting export (Sage) and BEAD reimbursement reporting.

We can't integrate directly with Sonar (CRM) or Sage (accounting). The strategy is:
- **Eliminate manual dual-logging wherever possible** (infrastructure crew should not be entering work in both FiberLog and Sonar)
- **Use FiberLog as the consumption ledger** — what was used, by whom, on which project
- **Export cleanly** — Sage gets a CSV per period; future Sonar export will go back the other way once we have the data we need

**Who owns what, FiberLog vs Sage (Aug 2026).** Purchase orders are received **directly into Sage**, then entered into FiberLog. So Sage is the accounting book (it already holds the purchase from the AP side; only a few people have access), and FiberLog is the **inventory-provenance** system — how stock got here and where it went. Consequence: the Sage export is consumption-only and deliberately **excludes `receive` movements** (exporting them would double-count the purchase), alongside `adjust` (Sage runs its own physical-inventory reconciliation). Receives stay in FiberLog as the provenance record and are what the Parts tab's per-part History panel reads. See `isExportableMovement` in `lib/inventory.js`.

---

## The three crew workflows

| Crew | Workflow shape | System | Status |
|---|---|---|---|
| **Fiber construction** (aerial / underground / splice / drop / locator) | Project → Phase → Task → Daily passdown | FiberLog only | ✅ Shipped |
| **Infrastructure** (towers, sites, business installs) | Project → **Site** → Task → Daily passdown (sites-shaped shell) | FiberLog only | 🚧 Shell shipped — onboarding next |
| **Field tech** (Calix/UBNT installs, Wave/wireless) | Customer install ticket (Sonar-scheduled) | Sonar for scheduling + logging; FiberLog imports daily | ✅ Routing unblocked Aug 2026 — Sonar tags jobs with a project |

**Why this split:** Fiber and infrastructure crews work plan-driven jobs against geographic projects — they know which project they're on. Field techs work ticket-driven jobs against customer addresses and don't reliably know which fiber region a customer falls into. That used to make their consumption unroutable; it no longer does — Sonar now stamps a `Project` on each fiber job and FiberLog maps every one of those tags to a phase (see "Field tech — routing" below). Field tech intake still lives in Sonar; FiberLog imports the daily report.

---

## Infrastructure crew — sites shell

Infra crew (`crew_type = 'infrastructure'`) gets a sites-shaped shell: `App.jsx` routes them to `InfraCrewApp` (project → **site** → task → daily passdown, components under `src/components/crew/infra/`) instead of `CrewApp`; every other crew_type is untouched. Tasks anchor on `tasks.site_id` with `phase_id` NULL (CHECK `tasks_anchor_present` requires one of the two), and `approve_submission` resolves the deduction bucket via override → phase's project → **site's project**, so infra approvals deduct cleanly; phase actuals never increment for infra (no site-actuals concept). Replaces infra dual-logging in Sonar once onboarding finishes (remaining: add infra users, curate `assemblies.crew_type = 'infrastructure'` kits).

> Full reference — schema, components, materials flow, sites admin, onboarding checklist: [docs/INFRA_CREW.md](docs/INFRA_CREW.md)

---

## Working-manager toggle (manager ↔ crew mode)

Staff (`role = owner | manager`) with a field `crew_type` can flip into the crew shell to log their own day's work — `viewMode` (`'manager' | 'crew'`) in `AppContext`, persisted to `localStorage.fiberlog_view_mode` (reset on logout), routed in `App.jsx` through `canActAsCrew()` from `src/lib/access.js`; `VALID_FIELD_CREW_TYPES` lives in `src/lib/crewTypes.js` only. **Same identity, same truck, same audit trail** — no account sprawl. Caveats: auto-deduct fires only for `crew_type ∈ {fiber_construction, field_service, infrastructure}` (+ legacy values), and crew users (`role = 'crew'`) never see any of this — the toggle is staff-only.

> Full reference — pill/sheet mechanics, owner-as-field-worker, the two known deliberate gaps: [docs/WORKING_MANAGER.md](docs/WORKING_MANAGER.md)

---

## Field tech — routing

Field techs log ticket-driven installs in Sonar; FiberLog imports the daily report. **Routing is unblocked (verified Aug 14 2026):** Sonar stamps a `Project` on each fiber job, `sonar_project_phase_map` covers 53/53 distinct tags, and blank-Project rows are wireless (routed by the wireless part policy, which deliberately outranks any tag). **Do NOT build an address → project lookup table** — the owner's address export and Sonar's job tags agreed 759/759 where both had a value.

> Full reference — the measured evidence, the legacy city-map fallback, what's still open (backlog #5/#6), and the pre-Aug-2026 history: [docs/FIELD_TECH.md](docs/FIELD_TECH.md)

---

## Stack

- **Styling:** Inline styles + CSS variables (no Tailwind, no CSS modules). Theme tokens + shared classes live in `src/styles/global.css` (imported from `App.jsx`).
- Dev/build/test/deploy commands are the standard npm scripts in `package.json` (`npm run deploy` ships to GitHub Pages — see the deploy safety notes before using it).

### Important IDs / URLs

- **Supabase project ID:** `attduslwidxecmjifsnl`
- **Supabase URL:** `https://attduslwidxecmjifsnl.supabase.co`
- **Supabase anon key:** in `.env` as `VITE_SUPABASE_ANON_KEY`. Hardcoded fallback in `src/lib/supabase.js` for safety. The key is public by design — RLS in the DB is the access boundary (tightened May 2026; see backlog #12 for the remaining intentional exceptions).

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
      InventoryView.jsx   ← inventory section (8 sub-tabs — Purchase Reqs only while the **Admin → Purchasing** switch is on, `app_settings.purchasing_ui_enabled`, OFF since Aug 20 2026; the switch also withholds the Receive PO sheet's PO hand-offs + the Create-PR bulk buttons: Stock / Locations / Parts / Activity / Purchase Reqs / Found / Audit / Cycle Count; toolbar "Record movement" button + a 7-item Actions strip: Receive PO / Reconcile / Sonar / Fiber jobs / Import CSV / Sage export / Footage map — collapses to a bottom sheet on phone). Parts tab has a filter-respecting catalog CSV export (filter in the filename); Activity tab has a date-ranged raw-history CSV export (July 2026) — unlike Sage it keeps adjusts / truck→truck / bin moves, and it's the only way full movement history leaves the app. Both use the shared escapeCsvField + downloadTextAsFile from lib/csvImport.js (the BOM-writing download helper) — do NOT add another private CSV escaper, five legacy copies already exist.
      InventoryStockTab.jsx, InventoryLocationsTab.jsx, InventoryPartsTab.jsx,
      InventoryMovementsTab.jsx, InventoryAuditTab.jsx
      PurchaseRequestsTab.jsx, PurchaseRequestSheet.jsx ← FiberLog-originated PRs (compose, cost history, CSV/email export, lifecycle)
      ReviewQueue.jsx     ← config-driven review-queue chassis (header/filter/list/detail overlay) + ReviewActions/InitialsAvatar/StatusPill — both queues build on it (backlog #22)
      IntakeRequestsQueue.jsx ← "Found" sub-tab — approve/reject crew intake requests (on ReviewQueue)
      importShared.jsx    ← shared import-wizard chrome: Section/MappingRow/StatusBadge/SourceLocationSelect/webhook panels (Sonar + FiberJobs + InventoryImport)
      chrome.jsx          ← shared manager styling tokens: chipStyle / cardSurface / LoadingBlock / EmptyState
      LocationDetailPanel.jsx ← location drill-in (view stock / count / export / labels / edit)
      LocationWithBinPicker.jsx ← shared warehouse→bin destination picker
      RecordMovementSheet.jsx ← free-form multi-line movement entry (transfer default; no receive — Receive PO owns receipts)
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
- **Sonar per-job project tagging is LIVE** (confirmed Aug 2026) — fiber jobs arrive pre-tagged, resolved via `sonar_project_phase_map` (53/53 tags mapped). The city lookup below is now only a fallback for the rare untagged fiber row; wireless rows never need it (part policy routes them). See "Field tech — routing" above.

### Submission routing override
- `submissions.project_id_override` — nullable FK to projects. If set, `approve_submission` routes auto-deduct to this project's bucket instead of the task's natural project. Phase actuals stay on the natural phase. Persisted by `TaskWorkspace`'s in-task picker.

### Per-line source truck (Aug 2026)
- `entry_parts.source_location_id` — nullable FK to `inventory_locations`. Names the truck/group a part line physically came from when crews work together and one person logs the day. **NULL = submitter's truck** (the default; nothing stored, behavior identical to before). `approve_submission` groups the auto-deduct by `(part, COALESCE(source, submitter's truck))` → one transfer per source truck, and stamps `consumed_by_user_id` as the source truck's owner for tagged lines (submitter for untagged, even when their pull location is a group). `save_log_entry` / `replace_submission_parts` validate non-null sources are active `truck|group` and carry them through edits.
- **The merge identity for part lines is `(part_id, source_location_id)` everywhere** — `mergePartsById` (submit), `getTaskSummary` (history), SubmissionsQueue aggregation, and React keys. The same SKU from two trucks must stay two lines because it becomes two movements.
- Crew UI (`TaskWorkspace` submit sheet): every part row carries a tappable "from" chip → `SourceTruckSheet` (on-hand per truck, zero dimmed not blocked, same-crew_type filter + Show-all). Sources persist in the draft (`working_counts.partSources` for computed rows, inline `sourceLocationId` on `extraParts`) and survive flag-restore. Over-drawn lines get amber warn-but-allow notes from a point-in-time stock snapshot. "Add parts used" opens `TruckStockSheet` (stock-first browser, From dropdown; `PartSearch` demoted to its catalog fallback link).
- Manager UI (`SubmissionsQueue`): source pills on lines, an amber per-truck deduction preview when any line is tagged, and a per-line truck picker in edit mode ("Submitter's truck" clears the override). `PassdownList` shows the pills read-only.
- Warehouses are deliberately NOT offered as sources — consuming straight off a dock on a passdown would bypass the load→truck flow and its crew whitelist; the honest record is a quick Load first.
- Migration `20260813000000_entry_parts_source_location.sql`.

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
- `parts_catalog.sage_id` (migration `20260820120000_parts_catalog_sage_id.sql`; nullable, partial-unique, stored uppercase) is the **Sage Intacct Item ID** (`UB000011` / `UB_900001`) — a cross-reference ADDED beside the SKU, never a replacement for it (the SKU stays the PK + movement anchor). The Sage export writes `ITEMID = sage_id ?? SKU` (`sageItemId()` in `lib/inventory.js`; preview flags SKU fallbacks amber). Editable in the Parts tab (+ a "No Sage ID" filter chip); backfilled by `scripts/sage-id-backfill.mjs` from accounting's "Sage Inventory Item IDs" workbook, which has NO SKU column — matching is by part name (exact/normalised/token auto, fuzzy → `imports/sage-ids/review.csv`). Sage carries parallel IDs for one item (`UB000024` vs `UB_L024`, different GL groups; `_R` variants) — the canonical `UB000nnn` form wins, alternates are listed in `variants.csv`.
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

The canonical RPC reference (every function, its JS caller, and purpose — all `SECURITY DEFINER` with `SET search_path = public, pg_temp`) lives in **[docs/DB_RPCS.md](docs/DB_RPCS.md)** — moved out of this file to keep always-loaded memory lean. Keep that table updated when adding/changing any Postgres function.

---

## Tests

`npm test` (one-shot) or `npm run test:watch`. Vitest configured via `package.json` only — no separate config file.

The suites live in `src/lib/*.test.js` — every tested module sits on a money path (movement validation, Sage CSV, submit-merge, import markers, footage→SKU lines); read the test files themselves for what each covers. Two things the files can't tell you: `npm test` from the repo root also scans `.claude/worktrees/*`, so a checkout with sibling worktrees reports a multiple of the real count (a clean clone is the truth); and there are deliberately no component tests (no jsdom/testing-library in devDeps) — the crew workflow + manager sheets are smoke-tested via QA persona runs (see `qa-harness/README.md`) and manually on the deployed app.

---

## Conventions / patterns

### Code style
- Functional components with hooks. No class components.
- Heavy inline styles using CSS variables. No Tailwind, no CSS-in-JS libraries.
- Theme tokens: ALL colors/sizes/radii come from the CSS variables defined in `src/styles/global.css` (light `:root` + dormant `[data-theme="dark"]`) — read that file for the palette. Two non-obvious facts: the legacy `--orange*` / `--teal*` tokens are kept as live **aliases** of `--accent*` (post-Console emerald redesign), so old code still renders correctly and new code may use either; and every new color must be a token, never a hex literal, or the dormant dark theme breaks the day it ships.
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
| Manager Record movement (`RecordMovementSheet`) | transfer / return / issue / scrap / adjust (NOT receive — that's Receive PO only, Aug 2026; defaults to transfer) | any → any | Free-form, no permission filter. The former Move-stock pill (`MoveStockSheet`) was removed at the same time — this sheet covers relocation. |
| Manager Receive PO (`ReceivePOSheet`) | `receive` (× N lines) | NULL → dest | Can create new parts inline. Destination defaults to the **Receiving dock** bin (`RECEIVING_BIN_NAME` / `getDefaultReceivingLocation()` in `lib/inventory.js`, resolved by bin name) — so do Create-PO's "Deliver to" and the PR receive panel's bin picker (Aug 2026) |
| **PO receive against a PR line** (`receive_pr_line` RPC) | `receive` | NULL → Deliver-to or a bin under it | Stamps `inventory_movements.purchase_request_line_id` (provenance). |
| **Receipt reversal** (`reverse_pr_line_receipt` RPC, "↩ Reverse" on a received PR line) | `adjust` | Deliver-to/bin → NULL | Aug 2026, backlog #53. Credits a mis-receipt back to the PO: lowers `received_qty`, status recomputes (all lines 0 → `ordered`, lines unlock). Reason required; blocked when on-hand < qty. Activity labels a PR-linked adjust-down "Receipt reversal" (`movementDisplay`). Sage-neutral. PO receipts only — not field returns / found. |
| Manager Reconcile (`ReconcileSheet`) | `adjust` OR `transfer` (× N lines) | one-sided / vs counter-location | Audit CSV round-trip. Each variance books as an adjust (default) or a transfer with a counter-location (batch default + per-row override, Aug 2026) — the honest booking when the manager knows where the stock really came from/went (fixes the negative-truck true-up pattern). Warn-but-allow when transfers overdraw the counter-location. Notes are self-documenting: `Reconcile <date> — counted N, system had M`. **Sage:** transfer-booked variances export like any transfer (deliberate — same physical event as a contemporaneous load); adjust-booked stay internal (`isExportableMovement` drops adjusts) |
| Manager Sonar import (`SonarImportSheet`) | `transfer` (× N lines) | crew truck → routed bucket | Destination via `parts_catalog.sonar_routing` (region / gigwave / Fixed Wireless) + `sonar_city_bucket_map`. Precedence: manual per-row pick → **wireless part policy (gigwave/none — outranks the Sonar project tag, Aug 2026; wireless CPE on "West Mountain Fiber"-tagged tickets was polluting the fiber BEAD ledger)** → `sonar_project_phase_map` → region/city lookup. `ask`-routed rows (GigaSpire adapters) then inherit the destination their same-account siblings agreed on — pure logic + tests in `lib/accountInheritance.js`; phase tag inherited only when donors agree, pre-filled picker as escape hatch; preview table clusters rows by account. When the wireless policy overrides a project tag, `phase_id` is left NULL so Sage cost-centers stay clean. Stamps `[sonar:<itemId>]` in notes + `consumed_by_user_id`/`phase_id` when known |
| Manager Fiber-jobs import (`FiberJobsImportSheet`) | `transfer` (× N lines) | crew truck → region bucket | Stamps `[sonar_jobs:…]` marker + `phase_id`/`consumed_by_user_id` |
| **Found-inventory approval** (`approve_intake_request` RPC) | `receive` (`receipt_kind='found'`) | NULL → warehouse | Backlog #19 — books the crew's reported find into stock |
| **Field return** — Receive PO → *Returned from field* (manager) OR crew *Pulled from customer* → `approve_intake_request` (`intake_kind='field_return'`) | `receive` (`receipt_kind='field_return'`) | NULL → `Returns – to test` bin | Aug 2026. A used unit pulled from a customer/site. Booked onto the part's **refurbished twin** (`parts_catalog.refurb_of` → parent; SKU `<parent>-R`, `sage_id = <parent>_R`) so it never re-enters stock as new; the RPC swaps to the twin server-side, Receive PO swaps on pick and can mint the twin inline (`createRefurbTwin`). `inventory_movements.receipt_kind` (`purchase` default via BEFORE-INSERT trigger · `field_return` · `found` · `decommission` · `seed`; immutable; receive rows only) is the separation every reader uses — Activity sub-chips + CSV column, `movementDisplay` source name, and the Sage export's opt-in **Include field returns** (default OFF pending accounting; purchases never export). Labels print a REFURB band (`refurb_of`) / EXPENSED band (`sage_id LIKE 'UB_9%'`). Migration `20260821120000_field_returns_and_refurb_parts.sql`. |
| **Cycle count** (`end_count_run_and_reconcile` + `approve_count_resolution` RPCs) | `transfer` (paired variances) / `adjust` (net gain/loss on approval) | bin ↔ bin / one-sided | Staff-gated; resolutions reviewed in `CountRunReviewSheet` |
| **Auto-deduct on approval** (`approve_submission` RPC) | `transfer` (× N parts × N source trucks) | per-line source truck (default: submitter's truck) → project bucket | Gated on crew_type ∈ {fiber_construction, field_service, infrastructure} (+ legacy aerial/underground/splice/fiber_tech). Honors `project_id_override`. One movement per `(part, COALESCE(entry_parts.source_location_id, submitter's truck))`; tagged lines attribute `consumed_by` to the source truck's owner. |
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
