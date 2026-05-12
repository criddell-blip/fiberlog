# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, install techs, and managers across multiple BEAD-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

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
      workspace/          ← logging-specific subviews
    manager/              ← UI for owner/manager users
      ManagerApp.jsx      ← entry, top-level nav (Approvals / Crew / Projects / Reports / Assemblies / Inventory / Admin)
      AdminPanel.jsx      ← admin home
      AdminUsersView.jsx  ← user CRUD (add/edit/deactivate/reset password)
      InventoryView.jsx   ← inventory section (5 sub-tabs)
      InventoryStockTab.jsx, InventoryLocationsTab.jsx, InventoryPartsTab.jsx,
      InventoryMovementsTab.jsx, InventoryAuditTab.jsx
      RecordMovementSheet.jsx, BulkMoveSheet.jsx, InventoryImportSheet.jsx
      AssemblyEditor.jsx  ← assembly templates (kits crew can pre-fill from)
      ReportsView.jsx, SubmissionsQueue.jsx, ProjectManager.jsx
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
- A trigger updates `inventory_stock` automatically when a movement is inserted

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
npm run deploy                                 # deploy to gh-pages
npx supabase functions deploy <name>           # deploy an edge function
npx supabase login                             # auth supabase CLI (first time)
```

---

## Backlog (rough priority order)

1. **Reconcile workflow** — paste actual counts from an audit CSV back, auto-generate adjust movements
2. **Onboard new infrastructure + field tech crew** — schema is ready, do via the Users admin
3. **Sonar transaction CSV importer** — daily install transactions → bulk `issue` movements off truck stock. Sample format at `C:\Users\admin\Desktop\Claude stuff\West field tech report (6).csv`
4. **Crew inventory UI + permissions framework** — backend complete, UI pending. **Decisions locked, ready to build next session:**

    **Backend (done):**
    - 16 personal trucks auto-created (one per active crew/contractor user, named `<FirstName>'s Truck`, assigned via `inventory_locations.assigned_to`).
    - Trigger `trg_ensure_crew_truck` auto-creates a truck on new crew/contractor user insert OR role/is_active flip.
    - RPC `public.record_crew_movement(operation, part_id, quantity, other_location_id, unit, notes, vendor_invoice, unit_cost, task_id)` — single entry point for all five ops (load, return, issue, scrap, transfer). SECURITY DEFINER, auth.uid()-guarded, EXECUTE granted only to authenticated.
    - 7 legacy "rollup buckets" (`Crew - Drop`, `Crew - Splice`, `Contractor - RNS`, etc.) are untouched — they hold ~97K units of imported stock and now function as additional "load from" sources.

    **Phase 1 — crew UI for Load + Return** (start here):
    - **Nav placement:** top of crew sidebar above the projects tree (and a dedicated bottom-tab on narrow screens).
    - **Scope this session:** only Load + Return. Issue/Scrap/Transfer deferred to a follow-up — the RPC already supports them, just no UI yet.
    - **New files:**
      - `src/components/crew/MyStockView.jsx` — read-only stock list scoped to the caller's truck. Search, group by category. Realtime subscription on `inventory_movements` filtered to `from_location_id=my_truck OR to_location_id=my_truck`.
      - `src/components/crew/CrewMovementSheet.jsx` — unified overlay sheet with a `mode` prop ('load' | 'return'). Reuse the existing overlay-sheet pattern from `manager/RecordMovementSheet.jsx`.
    - **Modifications:**
      - `src/components/crew/CrewApp.jsx` — add "📦 My Stock" entry at the top of the sidebar (wide) and bottom-nav (narrow). New screen state `'mystock'`.
      - `src/lib/inventory.js` — add `getMyTruck()`, `getMyTruckStock()`, `recordCrewMovement({ operation, partId, quantity, otherLocationId, notes, ... })` wrapping the RPC.
    - **Reusable patterns:** `searchPartsCatalog` (supabase.js), `getLocations`/`getStockByLocation` (inventory.js), overlay sheet shell from `RecordMovementSheet`, stock-row rendering from `InventoryStockTab`.

    **Phase 2 — per-user operation overrides** (½ session after Phase 1):
    - **Migration:** new table `crew_operation_permissions(user_id, operation, allowed bool, reason, updated_at)` with PK on `(user_id, operation)`. Empty rows = default allow. RLS: auth SELECT, staff write.
    - **RPC update:** in `record_crew_movement`, before the operation case, check the table — if a `allowed=false` row exists for `(auth.uid(), p_operation)`, raise `42501`.
    - **JS/UI:**
      - `src/lib/admin.js` — `getUserPermissions(userId)`, `setUserOperationPermission(userId, op, allowed, reason)`.
      - `src/components/manager/AdminUsersView.jsx` — add a "Permissions" section in the user-edit sheet with 5 toggles. Shows all 5 ops even though UI only exposes 2 — future-proof.
      - `src/components/crew/MyStockView.jsx` — on mount, load caller's permissions; hide the Load/Return buttons that are denied. RPC is the authority; UI is a courtesy.

    **Phase 3 — crew_type × part-department restrictions** (½–1 session after Phase 2):
    - **Migration:** new table `crew_type_part_restrictions(crew_type, department)` — whitelist, PK on both. Empty rows for a crew_type = no restriction. RLS same pattern.
    - **RPC update:** in `record_crew_movement`, lookup `parts_catalog.department` for `p_part_id`. If the caller's `crew_type` has any rows in the table, the part's department must be in the allowed set. **Parts with `department IS NULL` are allowed for all crew types** (lenient default for BoxHero drafts).
    - **Current departments:** `Fiber Construction` (155), `Drop Installation` (17), `Underground construction` (13), `Splice` (3), `Customer Installation` (1). New departments can be added later as the part taxonomy stabilizes (e.g., when Infrastructure crew is onboarded).
    - **JS/UI:**
      - `src/lib/admin.js` — `getCrewTypePartRestrictions()`, `setCrewTypePartRestriction(crewType, department, allowed)`.
      - New: `src/components/manager/CrewTypePermissionsView.jsx` — checkbox-grid matrix (rows: 8 crew_types, columns: N departments). Accessed from AdminPanel.
      - `MyStockView` Load picker hides parts whose department is blocked for the caller's crew_type.

    **Future follow-ups (deferred):**
    - Issue / Scrap / Transfer UI flows (RPC already supports them; just need sheets and buttons).
    - Migrate stock from the 7 legacy rollup buckets to specific crew trucks (manual work — managers do this via the existing Bulk Move sheet whenever they want).
    - Auto-deduct on submission approval for `aerial`/`underground`/`splice`/`infrastructure` crews (backlog item #9 — depends on Phase 1 being shipped).
5. **Sage daily export** — Edge Function pattern, stamps `exported_at` + `export_batch_id` on included movements
6. **Per-line `project_id` on `log_entries`** — schema change for field-tech multi-cost-center allocation (Wave / Gigwave / general). Pending field-tech UI workflow decisions (per-customer vs per-day)
7. **Field tech UI surface** — flatter "today's installs" list with one-tap into per-customer materials log
8. **Locations tab UX** — "View stock" jump-link + stock summary counts on each location card
9. **Phase 2 auto-deduct on submission approval** — create `issue` movements from assigned truck for parts the crew logged
10. **BoxHero drafts cleanup** — 476 placeholder drafts with `unit='ea'`. Cable items need `unit='ft'`. Use Bulk edit on Parts tab → Drafts → search "cable" → bulk edit unit=ft.
11. **Security & DB hygiene from Supabase advisor scan** — RLS rewrite + view/function hardening complete. Five lints remain, all intentional or out-of-band:
    - `tasks_insert` and `tasks_update` are wide-open by design (crew need to create tasks and auto-save `working_counts`; the "Continued from X" handoff depends on any-crew updates). Documented exception.
    - `approve_submission` and `is_staff()` are reachable by `authenticated`, intentionally. `approve_submission` is the manager UI's approval RPC and has an `auth.uid()`+role guard inside. `is_staff()` is called by RLS policies and must be executable in the user's context.
    - ~~Leaked-password protection toggle~~ — gated behind Supabase Pro plan. Not worth a plan upgrade for FiberLog's risk profile (no public signup, synthetic emails, admin-set passwords). Free-tier alternative if desired: in Auth → Sign In / Providers → Email, bump minimum password length from 6 → 8 and set a password-requirements rule. Both apply only to new passwords, don't invalidate existing.
    - Performance lints (64 of them, all INFO/WARN, none urgent at current scale): 32 unindexed FKs, 24 duplicate permissive policies, 5 unused indexes, 3 `auth_rls_initplan` cases. Revisit if/when query latency becomes noticeable.

    Helper installed: `public.is_staff()` returns true iff `auth.uid()`'s role is `owner` or `manager`. Used by every staff-write RLS policy.

    Migrations applied: `tighten_rls_policies`, `harden_views_functions_execute_grants`, `users_staff_update_policy` (fixup — the original RLS rewrite assumed user updates would go through an Edge Function, but `updateUserMetadata` in `lib/admin.js` is direct JS, so a staff UPDATE policy was needed on `public.users`).

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

## Recent major work (in case it helps)

- **Bins:** Sub-locations under warehouses, schema + full UI rollout (Locations / Stock / RecordMovement / BulkMove). Single-level nesting only. Bin creation lives on each warehouse card via `+ Bin`.
- **Audit export:** New `🔍 Audit` sub-tab in Inventory. Filter by scope / part status / stock level / department / material group / staleness. Generates CSV with `Actual Qty` blank column and `Variance = =J<row>-I<row>` formula.
- **User management:** Full add/edit/deactivate/reset-password from the manager Admin panel via the new Users view.
- **Theme + login:** Dark/light theme persists. Login is username + password with auto-domain append.
