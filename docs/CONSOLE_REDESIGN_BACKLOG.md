# Console Redesign — Backlog & Status

Working branch: **`redesign/console`** (a *preview* branch — **not deployed**; the live app on `gh-pages` is unaffected until we choose to ship a milestone). Field crews keep today's app the whole time.

Design source of truth: [`docs/design_handoff_console_redesign/`](design_handoff_console_redesign/) (README + mockups + screenshots).

Direction: dark/orange-teal + emoji → **light / emerald-slate + line icons**, with **navigation separated from actions** and **genuinely responsive** (table on desktop, cards on phone). Inventory is the flagship/test bed; the rest of the app follows the same recipe.

---

## ✅ Done (committed on `redesign/console`)

| Phase | What shipped |
|---|---|
| Foundation — tokens + fonts | Re-pointed `global.css` to Console light + emerald (kept token names → cascades app-wide); Public Sans + IBM Plex Mono loaded |
| Foundation — icons | `src/components/shared/Icon.jsx` — ~30 line icons (replaces emoji) |
| Foundation — primitives + depth | `.chip`, `.status`, `.mono`, `.eyebrow`; **card elevation + button motion** (fixes the original "flat" feel) |
| App shell | `ManagerApp.jsx` rebuilt — Console sidebar (desktop) + slide-in drawer (phone), line-icon nav, emerald active state, Back-aware drawer |
| Inventory chrome | `InventoryView.jsx` — toolbar + secondary sub-nav + desktop actions strip / phone actions sheet |
| **Stock flagship** | `InventoryStockTab.jsx` — desktop data table + phone cards, filter chips, search, **dark bulk-select bar**, status badges. Verified on real data (220 parts). |
| Inventory read tabs | **Parts**, **Activity**, **Purchase Requests**, **Audit** — Console list/table + chips + status pills + mono data + dark bulk bar (Parts). Verified live. |
| Locations (chrome) | **Locations** — icon tiles, elevated rows, unified action chips, Add button. Deep bin/aisle sub-rows + form/retire overlays still recolored-only (polish). |
| (back button) | Desktop top-level tab Back enabled in the new shell |

**→ The entire Inventory section is now Console (all 6 sub-tabs).**

| Manager screens | **Submissions/Approvals** (filter pill, chips, group elevation, mono stats, line icons) and **Crew status** (elevated mono stat cards, line icons) — done. |

The whole manager app already navigates + looks like Console; un-redesigned screens are recolored (token cascade) but keep their old layouts until their turn.

---

## ⏭️ Next up (ordered — each inherits the Stock recipe)

### A. Inventory sub-tabs — ✅ COMPLETE (all 6)
Stock · Parts · Activity · Purchase Requests · Audit · Locations all on Console.
Remaining inventory polish (deferred, low priority): Locations' nested bin/aisle
sub-rows + inline form/retire overlays; leftover emoji in collapsed-filter
summary strings; the action/detail **sheets** (see C).

### B. Cycle count
6. Full-screen scanner flow — its own chrome. `cycleCount/CountTab.jsx` (+ `cycleCount/*`)

### C. Action / detail sheets (~12) — ✅ COMPLETE (Phase F)
7. ✅ Record movement, Receive PO, Reconcile, Sonar, Fiber jobs, Import CSV, Sage export, Bulk move, PR composer, SKU/bin labels, Location detail, Aisle signs, Bulk Sonar projects — all emoji → line icons. Added `alert/trash/printer/mail/edit/key/lock/eye` to Icon.jsx. Kept emoji in `<select>` options (native), currency, placeholder strings, loading spinner, prose. Build clean; Record Movement smoke-tested live.

### D. The rest of the manager app (per the rollout tracker)
8. ✅ **Submissions / Approvals** (`SubmissionsQueue.jsx`) — done
9. ✅ **Crew status** (`CrewStatus.jsx`) — done
10. **Projects** (`ProjectManager.jsx`) — ✅ list + **project detail + fiber phases + infra sites + Sites admin + edit/decommission** done (Phase F): site-type pin/warehouse icons, permit→clipboard, caret→chevron, edit/trash/check, drilldowns. Site-type filter pills + pickers converted. Smoke-tested live (PERMIT + PHASE TARGETS render). Form-overlay deep layout still recolored-only (low priority).
11. **Reports** (`ReportsView.jsx`) — ✅ header/chrome done. **Remaining:** the expandable result rows (PartRow/PersonGroup/ProjectGroup) recolored-only.
12. **Assemblies** (`AssemblyEditor.jsx`) — ✅ list + delete-dialog done. Editor form fields recolored-only.
13. **Admin** (`AdminPanel.jsx`, `AdminUsersView.jsx`, `CrewTypePermissionsView.jsx`) — ✅ emoji → line icons done (Phase F): home cards (eye/lock/trash/chevron), users (key/check/x/alert/box/truck), ops map → iconName, permissions matrix check. Build clean, names verified, no Icon warnings. **NOT live-verified — Admin tab is owner-gated; needs owner-eyes pass (Chris).** Direct-reports picker readability already fixed earlier.
13a. **LocationDetailPanel** (`LocationDetailPanel.jsx`) — ✅ done (Phase F): type tiles, count/export/stock/labels/edit buttons. Build+name-verified; live-open resisted scripted clicks — spot-check.

### E. Crew app (field) — biggest chunk
14. ✅ **Fiber list screens** — ProjectList / PhaseList / TaskList (line icons, chevrons, mono stats).
15. ✅ **My Stock** (`MyStockView.jsx`) — Load/Return/Refresh icons, truck/box empty states, mono qty.
16. ✅ **Task workspace** (`TaskWorkspace.jsx`) — Console via cascade + icon cleanup; contrast-verified. *Tally-row sub-components (`workspace/*`) cascade-fine; deep restyle deferred.*
17. ✅ **Infra list screens** — `SitesList` / `SiteTaskList`.
18. ✅ **Crew wide sidebars** (CrewSidebar + InfraSidebar) + infra projects screen — line icons, gear/box/chevrons.
19. ✅ **TaskSummaryView** (status dot) + **CrewMovementSheet** (header/toggle icons; in-`<option>` glyphs kept — native limitation).

**→ The crew app is now Console end-to-end** (all daily screens + chrome). Job-type / pole / infra-job glyphs kept as emoji throughout (deliberate exception). Deep tally-row restyle (`workspace/*`) deferred — cascade-fine + readable.

> **Preview note:** the long-lived preview screenshot tool degraded mid-session; the crew list screens were verified via DOM (render + no errors). Do a fresh `npm run dev` for a clean visual pass.

### F. Polish & QA (whole app)
18. Responsive sweep · empty/loading/error states · accessibility (focus/labels/contrast)
19. **Dark mode** decision (see below)

---

## 🐞 Bugs to investigate

- **Crew Load/Return submit can kick the user out of the app.** Reported live: doing a **Return** (truck → warehouse) — "from Braden to the warehouse" — in `CrewMovementSheet`, then tapping submit, exited the app entirely (browser navigated away, not just closed the sheet).
  - **Leading hypothesis:** the back-button coordinator (`src/lib/backStack.js`). On a successful submit the sheet closes via `onComplete` (a UI-initiated unmount, not a Back press); its `useBackClose` cleanup spends the synthetic history entry via `history.back()`. If the armed-entry accounting is off by one for this flow (sheet opened over the My Stock screen + the load/return mode state), that `history.back()` can over-consume past the app's root → exits the app. Less likely: an unhandled error in the submit path (`recordCrewMovement`) crashing the tree.
  - **Triage update (confirmed): user was running locally (`npm run dev`), so React StrictMode was active.** This is very likely a **dev-only StrictMode artifact** — StrictMode double-invokes the `useBackClose` effects (mount→cleanup→mount), and the synthetic `pushState`/`history.back()` accounting can drift by one across the double-invoke, so the submit-close `history.back()` over-consumes and exits. **Production build does not double-invoke → live crew very likely unaffected.** Still worth fixing so it doesn't disrupt local testing and to remove the latent fragility.
  - **Code-verified (backStack.js):** the `armed`/`suppressPops` accounting is *balanced in production* — every `pushState` (reconcile grow) has a matching `history.back()` (reconcile shrink), `armed` never goes negative, both loops guarded. So production stays in lock-step with the real history stack. StrictMode's mount→cleanup→mount double-invoke of the layer's effects (lines 133-162) + the async-ness of `history.back()` is what desyncs `armed` from the browser's actual entry count in dev; the next real Back then consumes the page-load entry → exit.
  - **Fix direction (deliberate, not a hot-patch — this coordinator is LIVE in prod):** harden so the count is robust to StrictMode (e.g. tie ownership to `history.state` markers instead of a blind counter, or coalesce the double-invoke). **Verify against a production build** (`npm run build && npm run preview`) as the source of truth, since `vite preview` does not double-invoke. Repro path: My Stock → Return → pick warehouse + part(s) → submit; confirm it stays in the app under both dev and preview. Risk note: a careless change here breaks Back for all crew — needs its own focused pass + the Phase-1 back-button regression checklist re-run.
  - **Affects both branches** (`feat/back-button-nav` is live; `redesign/console` inherits the same back-button code).

---

## 🚩 Flagged decisions & known gaps

- **Low-stock status has no data behind it yet.** The schema has no reorder threshold, so the Stock "LOW" badge currently means **zero/negative** (the actionable state). A real LOW needs a reorder-point field on parts + a tweak to `stockStatus()` in `InventoryStockTab.jsx`. *(Presentation-only scope guard: flagged, not built.)*
- **Dark mode is retired for now (light-first).** The theme toggle no-ops visually. Polish-phase decision: design a dark Console palette, or remove the toggle. (Handoff recommends light-first, dark as fast-follow.)
- **Desktop top-level Back** was added on this branch but **not backported to the live app** (`feat/back-button-nav`). Optional: cherry-pick the one-liner to production if you want it before the redesign ships.
- **Stock table has no per-row "Location" column** (the mockup shows one). Our "all locations" view sums across locations, so there's no single per-row location — intentionally omitted (codebase-wins-on-data rule). Location is shown via the filter chips / scope instead.
- **Leftover emoji** in not-yet-redesigned spots: the collapsed-filter summary text in `InventoryStockTab` (`slimScopeText`/`scopeLabel`), the `⚠️` error states, `📦 Archived` in Submissions, etc. These get swept as each screen is redesigned (Polish covers stragglers).
- **Sheets are functional but still old-styled** inside the new chrome — fine to use, just not yet Console-skinned (Phase C).

---

## How to preview / test

```bash
git checkout redesign/console
npm run dev          # http://localhost:5173/fiberlog/
```
- **Desktop:** wide browser → Console sidebar + Inventory → Stock table.
- **Phone:** narrow the window (< 768px) or use browser device mode → drawer nav + Stock cards + bottom actions sheet.
- Flagship to scrutinize: **Inventory → Stock** (table density, chips, search, bulk-select). It's the template for everything else — note any tweaks here first.

Nothing deploys until we run `npm run deploy` on a chosen milestone.

---

## Master backlog reference
The interactive full-app tracker (with day estimates, ~80–110 dev-days total) lives at
[`docs/design_handoff_console_redesign/mockups/Console Rollout Tracker.dc.html`](design_handoff_console_redesign/mockups/Console%20Rollout%20Tracker.dc.html) — open in a browser; it saves status to localStorage.
