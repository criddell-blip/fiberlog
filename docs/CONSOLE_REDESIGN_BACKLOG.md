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
| (back button) | Desktop top-level tab Back enabled in the new shell |

The whole manager app already navigates + looks like Console; un-redesigned screens are recolored (token cascade) but keep their old layouts until their turn.

---

## ⏭️ Next up (ordered — each inherits the Stock recipe)

### A. Remaining inventory sub-tabs (content still old inside the new chrome)
1. **Locations** — warehouse → bin tree (the heaviest; nested disclosure). `InventoryLocationsTab.jsx`
2. **Parts** — catalog + drafts cleanup. `InventoryPartsTab.jsx`
3. **Activity** — movement history + filters. `InventoryMovementsTab.jsx`
4. **Purchase Requests** — queue + status pills. `PurchaseRequestsTab.jsx`
5. **Audit** — CSV generator (scope + filters). `InventoryAuditTab.jsx`

### B. Cycle count
6. Full-screen scanner flow — its own chrome. `cycleCount/CountTab.jsx` (+ `cycleCount/*`)

### C. Action / detail sheets (~12) — restyle on a shared Console sheet look
7. Record movement, Receive PO, Reconcile, Sonar, Fiber jobs, Import CSV, Sage export, Bulk move, PR composer, SKU/bin labels, Location detail, Aisle signs. (All are already Back-wired + functional; this is visual only.)

### D. The rest of the manager app (per the rollout tracker)
8. **Submissions / Approvals** (`SubmissionsQueue.jsx`) — #1 daily action
9. **Crew status** (`CrewStatus.jsx`)
10. **Projects** (`ProjectManager.jsx`) — fiber phases + infra sites + edit/decommission
11. **Reports** (`ReportsView.jsx`)
12. **Assemblies** (`AssemblyEditor.jsx`)
13. **Admin** (`AdminPanel.jsx`, `AdminUsersView.jsx`, `CrewTypePermissionsView.jsx`)

### E. Crew app (field) — biggest chunk, currently only recolored
14. Crew shell + My Stock (`CrewApp.jsx`, `MyStockView.jsx`, `CrewMovementSheet.jsx`)
15. Task workspace (`TaskWorkspace.jsx` + `workspace/*`)
16. Submit-day flow + read-only summaries (`TaskSummaryView.jsx`)
17. Infra crew shell + workspace variant (`infra/*`)

### F. Polish & QA (whole app)
18. Responsive sweep · empty/loading/error states · accessibility (focus/labels/contrast)
19. **Dark mode** decision (see below)

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
