# Field tech — routing + backlog

> Moved out of CLAUDE.md (Aug 2026) to keep always-loaded memory lean. Current state first; the original (stale-premise) plan is kept below for history.

## Current state (Aug 2026) — routing UNBLOCKED

> **This doc previously read "backlog — blocked, waiting on Sonar polygon data." That was stale.** Verified against real data Aug 14 2026: Option 3 (dispatcher tags the project at job creation) is **live in Sonar**, and FiberLog already consumes it. Nobody noticed it had landed. Don't re-plan this epic on the old premise.

**How field-tech consumption routes today (Option 3, as designed):**
- Sonar's daily field-tech report ("Field tech asset consumption") carries a **`Project` column**, stamped per job.
- `SonarImportSheet.jsx` resolves each row's destination bucket; the job's project tag flows through `sonar_project_phase_map` to a phase → project.
- Manager approves the batch → materials transfer crew truck → project bucket → Sage export picks it up keyed by project, alongside fiber + infrastructure.

**Coverage (measured, not assumed):** `sonar_project_phase_map` holds **53 mappings covering 53/53 distinct Sonar project tags** — 100% of the 8,289 addresses in the owner's Aug 2026 "Fiber project addresses" export. The last gap (`COLDER SPRINGS`, 283 Lehi addresses) was mapped onto the existing Cold Springs phase Aug 14 2026.

**The ~51% of report rows with a BLANK `Project` are not a gap — they're wireless.** Checked by equipment model: tagged rows are fiber gear (GP1100X, GP4200XH, UFiber, Wave-Fiber-ONU); untagged rows are wireless (Wave LR / Nano / Pico, PowerBeam, NanoStation). Wireless installs correctly have no fiber project and route by the **wireless part policy** (`gigwave`/`none` → Gigwave / Fixed Wireless), which deliberately outranks any project tag — see the Sonar routing precedence in CLAUDE.md's interconnect table. Across all of Q2 only **6 fiber rows** had a blank tag; the per-row destination picker covers those.

**Do NOT build an address → project lookup table.** The original decision to reject one still holds, and is now backed by evidence: cross-checking the owner's address export against the daily report, on the 759 rows where both had a value the address book and Sonar's job tag **agreed 759/759, zero disagreements**. A FiberLog-maintained address table would add maintenance burden and change no routing decision. The serviceable-address list is real, but it lives in Sonar and FiberLog already consumes the useful half of it.

**Two empty placeholders make it *look* like address data was loaded here — it never was.** `sites.address` / `lat` / `lng` are NULL on all 198 rows, and `projects.vetro_project_id` is NULL on all 7 projects. Both are unused. Populating site addresses would help dispatch/navigation but routes nothing — infra material routes on `sites.project_id`.

**`sonar_city_bucket_map` (3 rows) is the weak legacy fallback.** City granularity is wrong for Provo, which spans Osprey / Aspen Summit / Alpine Brook (Wasatch Front) *and* West Mountain Fiber (West Mountain). The per-job project tag outranks it, so the city map only matters when a tag is missing.

**What's actually still open** (workflow, not data): per-line `project_id` on `log_entries` for multi-cost-center allocation (backlog #5) and the field-tech UI surface (backlog #6). Field techs continue to log in Sonar by design — that's the intake split, not a blocker.

## Original plan + history (pre-Aug-2026 — stale premise, kept for context)

**Why backlogged (original, now-stale rationale):** Field techs install at customer addresses. Sonar tracks customers but does not currently tag each customer with which fiber region (Heber / Park City / etc.) they fall under. Without that, when we import Sonar's daily report, we can't reliably route consumed materials to the right project — and routing to a generic "Wave" or "FW" bucket forces a manual reconciliation step downstream that defeats the purpose.

**Unblocks when:** Sonar gets polygon-to-customer address mapping (in progress — tied to BEAD/reconnect address requirements). The polygons already exist from the developer side; they haven't propagated to Sonar yet.

**Approach when unblocked (Option 3 — dispatcher tags at job creation):**
- Dispatcher (or system, once polygons land) adds a `project` field to Sonar jobs at scheduling time
- Sonar daily CSV export includes that field
- FiberLog's Sonar import sheet (already shipped — `SonarImportSheet.jsx`) reads the `project` field and ties each imported submission to that project
- Manager approves the batch → materials auto-deduct truck → project
- Sage export includes field tech consumption alongside fiber + infrastructure, all keyed by project

**Why Option 3 over an address lookup table:** A FiberLog-maintained address → project lookup is another manual process. The polygon data exists at the developer level and is moving toward Sonar; building our own lookup would compete with the real source of truth.

**Until then:** Field techs continue logging in Sonar. Their material consumption isn't tracked in FiberLog. Manual Sage entry for field tech materials continues (status quo, pending the unblock). *(Superseded — see "Current state" above: the tagging landed and imports route on it today.)*
