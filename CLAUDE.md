# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, infrastructure-crew, install techs, and managers across multiple BEAD-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

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
| **Infrastructure** (towers, sites, business installs) | Project → Phase → Task → Daily passdown (same as fiber) | FiberLog only | 🚧 Next up — see below |
| **Field tech** (Calix/UBNT installs, Wave/wireless) | Customer install ticket (Sonar-scheduled) | Sonar for scheduling + logging; FiberLog imports daily | 📋 Backlog (blocked on Sonar polygon data) |

**Why this split:** Fiber and infrastructure crews work plan-driven jobs against geographic projects — they know which project they're on. Field techs work ticket-driven jobs against customer addresses and don't reliably know which fiber region a customer falls into. Until Sonar provides polygon/address → region mapping, field tech intake stays in Sonar; we'll import nightly when the data is good enough to route automatically.

---

## Infrastructure crew — next implementation push

Infrastructure crew is being onboarded into FiberLog using the **same workflow as fiber crews**. No new code path, no new data model.

**Plan:**

1. **Create projects per infrastructure region** (Ogden Valley, Park City, Heber, etc.) via the existing Projects admin. Same projects fiber crews use — infrastructure phases/tasks live alongside fiber phases/tasks under the same project.
2. **Onboard infrastructure users** via the Users admin with `crew_type = 'infrastructure'`. Each new user auto-gets a personal truck (`trg_ensure_crew_truck`).
3. **Infrastructure-specific phases** — within each regional project, create infrastructure phases (e.g. "Tower install — Heber Site 3"). Tasks underneath are the actual work units.
4. **Materials flow:** Infrastructure crew loads parts → truck → uses on task → submits passdown → manager approves → materials auto-deduct from truck → project bucket (`approve_submission` RPC already includes `infrastructure` in the auto-deduct crew_type list).
5. **Export:** Sage CSV pulls from project consumption (no separate path needed — same flow as fiber).

**What this replaces:** Infrastructure crew currently dual-logs in FiberLog AND Sonar. Once they're switched over, Sonar entry for infrastructure work stops. Sonar stays only for field tech scheduling.

**What's already in place to support this:**
- `crew_type = 'infrastructure'` is a valid value (CHECK on `public.users.crew_type`)
- `approve_submission` RPC auto-deducts for `{aerial, underground, splice, infrastructure}` already
- Project bucket auto-creation via `trg_ensure_project_job_site` works for any active project
- Per-user + crew_type × department permissions already cover infrastructure
- Receive PO, Reconcile, Sonar import flows all work the same for any crew

**No new code is required to support infrastructure crew.** This is a data + onboarding push, not a build.

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
- **Styling:** Inline styles + CSS variables (no Tailwind, no CSS modules). Theme tokens live in `src/index.css`.
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
  App.jsx                 ← top-level routing (login → manager OR crew based on role)
  index.css               ← CSS variables for both light + dark theme
  lib/
    supabase.js           ← Supabase client + DB helpers (projects, users, tasks, etc.)
    inventory.js          ← all inventory operations (locations, stock, movements, parts, audit)
    admin.js              ← user management ops (create/update/deactivate/reset password)
    csvImport.js          ← shared CSV import utilities
  components/
    crew/                 ← UI for non-manager users (logging work, parts used, etc.)
      CrewApp.jsx         ← entry point, sidebar + workspace
      ProjectList.jsx, PhaseList.jsx, TaskList.jsx, TaskWorkspace.jsx
      MyStockView.jsx     ← crew's personal-truck inventory view (Load + Return UI)
      CrewMovementSheet.jsx ← unified overlay for load/return (other ops are RPC-supported, UI deferred)
      workspace/          ← logging-specific subviews
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
- `tasks.site_id` (nullable) — infra tasks will point at a site instead of a phase. JS only knows about `phase_id` today; consuming `site_id` requires the infra crew UI build.
- 198 sites bulk-imported from owner's CSV. 197 mapped to a project; 1 ("Prestige II", originally tagged "Fiber - Mdu") landed unmapped — needs manual project assignment via Sites admin (TBD).

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
| `approve_submission(p_submission_id, p_note)` | `lib/supabase.js` → `approveSubmission` | Atomic + idempotent submission approval. Increments phase actuals, flips task to `approved`, clears `working_counts`, auto-deducts materials (truck → project bucket) for aerial/underground/splice/infrastructure crews. Honors `submissions.project_id_override` for bucket routing. |
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

### Browser autofill suppression
For any input that's NOT meant to be filled by the browser's saved-credentials list, use `autoComplete="off"` plus a non-standard `name=` like `name="user-search"`. For password reset / new-password fields, use `autoComplete="new-password"`. Past bug: opening the reset-password sheet was autofilling the user's username into the search field below.

### Persistence
- `localStorage.fiberlog_dark_mode` — theme preference
- `localStorage.fiberlog_remembered_username` — last login username

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

1. **Onboard infrastructure crew** — top priority, no code change required. See "Infrastructure crew — next implementation push" above. Create regional projects, add infrastructure users via Users admin, point them at the existing crew workflow. They auto-deduct to project on approval same as fiber crews. Stop dual-logging in Sonar for infrastructure work once switched over.

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
- **Receive PO + Sonar sheets aren't responsive on phone** — `maxWidth: 760` works on tablet+; on narrow viewports the line grids overflow. These are admin-only flows so manager-on-laptop is the assumed environment.
- **Audit CSV round-trip uses location *names***, not IDs. If two trucks happen to display the same first name (e.g. two crew named "Chris"), reconcile may match to the wrong one. Surface = warning, not blocker.

## Recent major work

- **Inventory framework rebuild (May 2026):** Crew personal trucks, three-layer permission framework (per-user × crew_type×dept × CHECK constraints), project buckets, auto-deduct on approval, Flavor A project routing override, Receive PO, Reconcile, Sonar import, Locations tab counts + jump-link, Vitest tests for `calculations.js`.
- **Security audit (May 2026):** RLS rewrite on 14 tables (was wide-open USING(true)), view + function hardening, EXECUTE grants tightened.
- **Bins:** Sub-locations under warehouses, schema + full UI rollout (Locations / Stock / RecordMovement / BulkMove). Single-level nesting only.
- **Audit export:** New `🔍 Audit` sub-tab in Inventory. Filter by scope / part status / stock level / department / material group / staleness. Generates CSV with `Actual Qty` blank column and `Variance = =J<row>-I<row>` formula. Round-trips into the Reconcile sheet.
- **User management:** Full add/edit/deactivate/reset-password from the manager Admin panel via the new Users view. Per-user movement permission toggles live in the user-edit sheet.
- **Theme + login:** Dark/light theme persists. Login is username + password with auto-domain append.
