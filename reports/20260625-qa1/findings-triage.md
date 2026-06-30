# FiberLog QA Audit — Findings Triage & Current Status

**Source audit:** `reports/20260625-qa1/audit.md` (run on commit `101e2f0`).
**Triaged against:** branch `redesign/console` head `8175e56`, **2026-06-30**.
**Why this exists:** the audit predates a large block of work this session (staff access-types, crew-type merge, group locations, the RPC pull-location fix, Sonar source overrides). Several findings are already resolved; this document marks each finding **Fixed / Partially fixed / Open / Needs re-test**, with evidence, so the audit becomes an actionable punch-list.

### Status legend
- ✅ **Fixed** — addressed this session; verified in code/DB.
- 🟧 **Partial / changed** — the area was reworked; the specific defect is mitigated but a residual remains or needs re-verify.
- ⬜ **Open** — not touched this session; still stands.
- 🔁 **Needs re-test** — likely a dev-server/test-harness artifact; must be re-checked on the deployed build before acting.

---

## 🔴 Must-fix items

| # | Finding (persona) | Status | Notes / evidence |
|---|---|---|---|
| 1 | **Cycle-count per-save latency 17–23s** (clint 11/13/14) | ⬜ **Open** | Untouched. Still the single biggest blocker to the warehouse-count workflow. Likely a full-warehouse refetch (or N+1) per save; no spinner. **Highest-impact remaining fix.** |
| 2 | **Warehouse-manager role-flip footgun** (whse-mgr 16) | 🟧 **Largely fixed** | The role model was rebuilt (`8b1ba31`): the old **role dropdown + warehouse checkbox** is now a single explicit **Access type** picker (Owner/Full/Working mgr/Warehouse/Accounting/Crew/Contractor) backed by `users.staff_scope`. The *silent* Manager→Crew demote-on-save is gone — choosing "Crew" is now a deliberate, described selection. **Residual:** the Load-destinations editor still only renders for the **Crew/Contractor** access types (`AdminUsersView.jsx:921`), so granting load-dests still implies a crew-type account. Warehouse managers no longer need that path, so the original scenario is largely moot — but worth a sanity re-verify. |
| 3 | **about:blank navigation from a bin button** (clint 17) | 🔁 **Needs re-test** | Confounded by Vite HMR in the dev run. Now that the app is deployed (gh-pages prod build), re-test clicking a bin row button there before treating it as a real bug. |
| 4 | **crew_type silently reverts None→"Fiber construction"** (admin 8) | ✅ **Fixed** | Access-type picker (`8b1ba31`) only shows the crew_type field for **Crew + Working manager**; every other type persists `crew_type = NULL` explicitly, and for Crew the "— None —" option now sends `null`. Confirmed no DB trigger defaults crew_type (only `trg_ensure_crew_truck`). |
| 5 | **Spanish My Stock + Load sheet 100% English; job-type buttons English** (spanish 9/13/14/15) | ⬜ **Open** | `MyStockView.jsx` / `CrewMovementSheet.jsx` still don't call `t()`; job-type translations exist in `i18n.js` but aren't wired into `TaskList.jsx`. Daily-driver path for Spanish crew. |
| 6 | **Archived empty-state copy: "No all submissions"** (amber 8) | ⬜ **Open** | Confirmed still live — `SubmissionsQueue.jsx:306` renders `No {filter} submissions` even on the archived view. Trivial fix (use "archived" when `showArchived`). |

---

## 🟡 Friction / slow

| Finding (persona) | Status | Notes |
|---|---|---|
| **Multi-word search broken** across cycle-count add-part + crew Load (clint 14, field-tech 6/10) | ⬜ **Open** | "lag bolt box" → 0 results; only the first token matches. Warehouse staff don't search single-token. |
| **Amber detail-panel open 43,115ms** (amber 6) | ⬜ **Open (low confidence)** | Single outlier, likely operator dwell; needs network-timing capture to judge. |
| **Language toggle buried 4 levels deep, manager-only** (spanish 4) | ⬜ **Open** | Add a self-service language pill on the profile/sign-out panel. Pairs with #5. |
| **No success confirmations on user/bin create** (admin 7/12) | ⬜ **Open** | Creation closes silently; add a toast. |
| **Crew-mode recovery one tap behind the CR avatar** (amber 1–2) | 🟧 **By design / minor** | The "⚙️ Manager" path exists (proven by spanish 2); it's one tap behind the avatar rather than on the crew home surface. Consider surfacing a top-level pill for staff-acting-as-crew. |
| **Missing guards** — empty "Enviar día" enabled w/ 0 parts (spanish 12); single-part load to own truck skips review-confirm (field-tech 8) | ⬜ **Open** | The single-part fast-path skip is partly intentional (a submit-is-final note shipped per backlog #16), but the zero-part submit guard is a real gap. |
| **Ambiguous "Bin" vs "Bins" buttons** (admin 10) | ⬜ **Open** | Unlabeled add-vs-view. Low. |
| **Bin-level Retire not found** (whse-mgr 7) | ⬜ **Open** | Relates to backlog #24 (recovery-flow bin granularity). |

---

## 🧹 Hygiene — live test artifacts still in production (verified 2026-06-30)

| Item | ID | State | Recommended action |
|---|---|---|---|
| **QA Test User** (role=manager) | `a8f71d23-32cc-4d3d-ba0f-1db4e5882ef5` | active | Deactivate (`is_active=false`). |
| **QA-TEST-BIN-20260625** | `b5002eba-e5e9-4684-aa25-5d37dde74ef3` | active, empty | Retire. |
| **Task "Tramo QA-Test prueba"** | `9c7c6af1-5291-4d2f-9212-9970236b2e95` | open, no movements | Close / delete. |

(There are also a couple of generic "test user" / "Test user-2" manager accounts in the roster worth reviewing.)

---

## ✅ Confirmed working (from the audit, still true)
- Mobile crew shell at 390px — no overflow, My Stock first, instant filtering.
- Cycle-count run resilience — survives reload + nav incidents (server-persisted run state); the "No stock changes happen yet" submit copy is exemplary.
- Non-owner manager permission model — Owner role hard-disabled at the DOM, 0 console errors.
- Crew-type merge complete — and this session extended it (splice/drop/locator/fiber_tech → **field_service**, `2237cda`).

---

## Coverage gaps to close on the next QA run
- **Approve/reject cycle never exercised** (queue had 0 pending). Seed one clearly-labeled pending QA submission and run the full approve → auto-deduct → crew-status-reflection path.
- **Owner-fidelity ceiling:** 4/6 personas ran as owner. The newly-shipped **Accounting** and **Warehouse** access types should be re-audited as *genuine non-owner* logins (Amber/Michelle/Clint) to validate the scoped tabs + limited inventory.
- **Write/mutation half held for prod safety** — crew load commit, submit, end-run reconcile, pause — still unverified on commit; needs a staging env or export-only allowance.

---

## Recommended order of attack (remaining, by impact)
1. **Cycle-count save latency** (#1) — profile the per-save round-trip; add a spinner in the interim. Biggest workflow blocker.
2. **Wire i18n into MyStockView + CrewMovementSheet + job-type buttons** (#5) + the self-service language pill — the Spanish daily path.
3. **Multi-word search** across add-part + crew Load — quick correctness win for warehouse staff.
4. **Quick wins (low effort):** the "No archived submissions" copy fix (#6); clean up the 3 hygiene artifacts; add create-success toasts.
5. **Re-test the about:blank bin-nav** (#3) on the deployed build; act only if it reproduces.
