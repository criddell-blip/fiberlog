# FiberLog

A field logging + inventory management app for Utah Broadband (FIF Utah LLC). Used daily by ~20 fiber-crew, infrastructure-crew, install techs, and managers across multiple grant-funded buildout sites in Utah (Wasatch County, West Mountain, etc.).

Deployed at https://criddell-blip.github.io/fiberlog/ via GitHub Pages.

> **Need the full end-to-end inventory walk-through?** See [docs/INVENTORY_FLOW.md](docs/INVENTORY_FLOW.md) — covers every crew workflow, every manager entry point, and the Sage export at the end of the line.
>
> **Need a deep dive on the Inventory tab specifically?** See [docs/INVENTORY_TAB.md](docs/INVENTORY_TAB.md) — every sub-tab, every action sheet, and how they fit into the daily/weekly/monthly cadence.
>
> **The crew-facing how-to (bilingual EN/ES)?** See [docs/CREW_GUIDE.md](docs/CREW_GUIDE.md) — rewritten July 2026 for the is_closed multi-passdown model.
>
> **Onboarding someone new?** See [docs/TRAINING.md](docs/TRAINING.md) — role-based training modules (everyone / crew / manager / warehouse) with live-app practice exercises, safety rules, and the trainer's cleanup checklist. A presentable web version (EN/ES toggle on the crew module) is linked at the top of that doc.

---

## North star

**FiberLog is the single source of truth for inventory consumption across all field crews.** Materials flow from vendor → warehouse → personal truck → project (region). Each project's consumption becomes the permanent record used for accounting export (Sage) and grant reimbursement reporting.

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
| **Field tech** (Calix/UBNT installs, Wave/wireless) | Customer install ticket (Sonar-scheduled) | Sonar for scheduling + logging; FiberLog imports daily | ✅ Routing unblocked Aug 2026 — Sonar tags jobs with a project. In-app, `crew_type='install'` is **stock-first**: `CrewApp` opens on My Stock (projects behind a link) with an owner-curated **Common items** tap-to-load strip sourced from `assemblies.crew_type='install'` (`isStockFirstCrew()` in `lib/crewTypes.js`, Aug 21 2026) |

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

## Code map — non-obvious homes

The tree is `ls`-able; these are the single-source-of-truth files and the rules that live in them:

- `src/App.jsx` — top-level routing: owner/manager → `ManagerApp` (unless `viewMode='crew'` + a field crew_type); `crew_type='infrastructure'` → `InfraCrewApp`; everyone else → `CrewApp`.
- `src/lib/access.js` — staff_scope / named-access-type single source of truth (`staffScope`, `visibleManagerTabs`, `canActAsCrew`, `inventoryIsLimited`). `src/lib/crewTypes.js` is the only home of `crewTypeLabel()` + `VALID_FIELD_CREW_TYPES`.
- `src/lib/inventory.js` — all inventory operations (locations, stock, movements, parts, Sage export, purchase + intake requests).
- `src/components/crew/taskState.js` — `isReadOnlyTask` / `isActiveCrewTask` / `isCompletedTask`, all `is_closed`-based — **never gate on `tasks.status`**.
- `src/components/shared/QrLabelSheet.jsx` — config-driven QR label chassis + PrintPortal, the ONE home of the Chrome print-CSS. `PartAttributeFields.jsx` is the ONE renderer for part-attribute fields.
- Shared manager chassis — reuse, don't fork: `ReviewQueue.jsx` (both review queues), `importShared.jsx` (import-wizard chrome), `chrome.jsx` (styling tokens), `LocationWithBinPicker.jsx` (warehouse→bin picker).
- CSV out: always `escapeCsvField` + `downloadTextAsFile` from `lib/csvImport.js` (the BOM-writing helper) — **do NOT add another private CSV escaper**, five legacy copies already exist. The Activity tab's CSV export is the only way full movement history (adjusts, truck→truck, bin moves) leaves the app — Sage drops those.
- Inventory → Purchase Reqs, Receive PO's PO hand-offs and the Create-PR bulk buttons only show while **Admin → Purchasing** (`app_settings.purchasing_ui_enabled`) is on — OFF since Aug 20 2026.
- `RecordMovementSheet` deliberately has no `receive` — Receive PO owns receipts.

---

## Database schema — rules that bite

The full schema reference (tables, columns, migrations, feature deep-dives: Regions + Service projects, Sites, per-line source truck, asset tags, edit-then-approve, footage map, Sonar routing, parts catalog + attributes) lives in **[docs/SCHEMA.md](docs/SCHEMA.md)** — read the relevant section before touching that area. The rules below are the ones that silently corrupt data if missed:

**Users**
- `public.users` shares its UUID with `auth.users`; `email` mirrors the auth identity — **don't change it** directly (use `admin-set-email`). Soft-delete only (`is_active=false`) — hard deletes FK-fail.
- `crew_type` assignable values: `fiber_construction | field_service | install | infrastructure | contractor`; legacy values stay valid but unassignable. Render via `crewTypeLabel()`, never raw.
- `staff_scope` (`full | warehouse | accounting`, NULL = full) is UI-only scoping — RLS still governs the API.

**Locations & movements**
- `inventory_locations.type`: `warehouse | truck | group | job_site | vendor | scrap | bin`. Bins nest one level under a warehouse only (trigger-enforced); `getLocations()` excludes bins by default.
- `job_site` is labeled **Region** in the UI — render via `locationTypeLabel()`, never a private label map. Region qty is **consumed material, not usable stock**: gate every cross-location rollup on `isConsumedLocationType()`.
- Movement types `receive | transfer | return | issue | scrap | adjust`; a trigger updates `inventory_stock`. CHECK `movement_endpoints_valid` is mirrored by `validateMovement()` — call it first.
- Movements are **immutable** (`trg_inv_movement_immutable`): corrections are counter-movements (e.g. Reclassify's `reclass_of` transfer), never UPDATEs. Work date = `COALESCE(occurred_at, created_at)`; an `occurred_at` backfill must **never set `notes` in the same UPDATE**, and `line_note` (asset tags) is never appended to `notes`.

**Tasks & submissions**
- Task lifecycle is `tasks.is_closed` (manager-controlled); `tasks.status` is display-only. Tasks anchor on `phase_id` or `site_id` (infra) — never neither. Tasks are shared across crew by design.
- Part-line merge identity is **`(part_id, source_location_id)` everywhere** (submit merge, history, queue aggregation, React keys) — the same SKU from two trucks is two movements. Warehouses are never valid sources.
- `crew_type_part_restrictions` is checked by `record_crew_movement`, **not** by `approve_submission` auto-deduct.
- Manager edit-then-approve: `replace_submission_parts` edits a pending submission's `entry_parts`; the footage/count rollups are written straight to `submissions` guarded on `actuals_applied_at IS NULL`.

**Service projects (grant vs repair)**
- A project with a `- Service` sibling (`service_for_project_id`) IS grant-restricted — there is no other flag. `src/lib/serviceRouting.js` is the only home of the fix-job rule (word-boundary `fix`, so "Fixed Wireless" never matches).

**Footage → SKU**
- Kinds are a registry (`footageTypes.js` + `footageKind()`), never ternaries. **`replace_assembly` enumerates every `is_*` flag in three places** (INSERT columns, VALUES, `ON CONFLICT DO UPDATE SET`) — miss one and it's silently dropped on every save.
- The `linesToParts` collision guard is **per-assembly, never app-wide** (`down-guy` shares the strand SKU). `STRAND_SIZES` is deliberately length 1 so it auto-picks — test tripwire.

**Parts catalog**
- `id` is the SKU (PK + movement anchor); `sage_id` is a cross-reference beside it, never a replacement. `is_active=false` = draft. Never write `category` directly — it's computed from `department` / `material_group`.
- `attributes` jsonb: `created_via` is reserved — **always merge, never replace**; bulk fill via the `set_part_attribute` RPC; `part_attribute_defs.key` is immutable. Logic lives in `src/lib/partAttributes.js`.

**Realtime:** published tables are `app_settings`, `emergency_logs`, `inventory_intake_requests`, `log_entries`, `submissions`, `tasks`, `work_sessions` — `inventory_stock` is NOT published.

---

## Edge functions

They live in `supabase/functions/`. For a new one, copy `admin-set-password` as the template: JWT verification + service_role for privileged ops. Exception: `sonar-webhook` authenticates with a `?key=` URL secret vs `SONAR_WEBHOOK_KEY` and runs with `verify_jwt=false` (Sonar can't send a JWT) — don't "fix" it. Only owners can create owners (`admin-create-user`).

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
There's no router — navigation is local state, and `src/lib/backStack.js` routes Back to the top-most registered layer. Every new sheet, overlay or drill-in must register with `useBackClose(depth, onBack, opts?)`: call it **unconditionally before any early return** (depth 0 while inactive), use a depth — not a boolean — for multi-level stacks, and pass `opts.confirm` reading the form's dirty state for data-entry sheets. Full mechanics + coverage list: [docs/BACK_BUTTON.md](docs/BACK_BUTTON.md).

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
- **Self-deactivation is blocked client-side** in `AdminUsersView`. Server doesn't enforce, but adding a server check is on the someday list. **Owner grant/removal IS server-enforced** (Sep 2026): `trg_users_owner_role_guard` rejects a role change to/from `owner` unless the caller is an owner — so a manager can't self-promote, and the first owner has to be made by another owner or by direct SQL (no JWT is exempt). The Owner access type keeps an optional crew type (owner-as-field-worker), so the owner never needs to demote to "Working manager" to use crew mode.
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

Every entry point writes to `inventory_movements`, and a trigger updates `inventory_stock`. The per-entry-point map (movement type, from → to, routing precedence, Sage treatment) is in **[docs/INVENTORY_FLOW.md → Cross-feature entry-point map](docs/INVENTORY_FLOW.md#cross-feature-entry-point-map)** — read it before adding or changing an entry point.

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
