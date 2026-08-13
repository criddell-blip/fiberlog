# Infrastructure crew — sites shell

> Moved out of CLAUDE.md (Aug 2026) to keep always-loaded memory lean. This is the full reference; the summary lives in CLAUDE.md.

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
