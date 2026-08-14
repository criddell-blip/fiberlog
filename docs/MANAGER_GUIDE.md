# FiberLog — Manager Guide

For owners and managers — running approvals, inventory, projects, and crew administration.

> 🌐 https://criddell-blip.github.io/fiberlog/
> Works on laptop, tablet, and phone. Most of what you'll do is laptop-comfortable.

If you're looking for what your crew sees: **[CREW_GUIDE.md](./CREW_GUIDE.md)**.

---

## The daily flow

1. **Morning** — open Submissions, approve or flag yesterday's passdowns
2. **As needed during the day** — receive POs / mark PRs received as deliveries arrive, apply the morning's Sonar reports, answer crew questions, check the Crew tab to see who's working what
3. **End of day** — quick scan of the queue, anything not yet submitted; close out tasks whose work is finished
4. **Weekly / monthly** — run the Sage CSV export, reconcile counts where audits surfaced drift

Most of your daily activity is in **Submissions** and **Inventory**. Everything else is occasional.

---

## The portal at a glance

The sidebar (or top bar on phone) has these tabs:

| Tab | What's there | How often you'll touch it |
|---|---|---|
| **Submissions** | Queue of daily passdowns from crew. Approve, flag, archive. | Daily |
| **Crew** | Live view of who's logging what today, with hours + parts | Daily glance |
| **Projects** | Add/edit projects, phases, sites, tasks, targets | Weekly |
| **Reports** | CSV export, Stock levels (BoxHero), Progress PDFs, Sage export | Weekly / on demand |
| **Assemblies** | Author the kits crew tap when logging work | One-off setup, occasional tweaks |
| **Inventory** | Stock, Locations, Parts, Activity, Purchase Reqs, Found, Audit, Cycle Count + action sheets | Daily-ish |
| **Admin** | Users, passwords, BoxHero sync, crew permissions | One-off setup, monthly check |

At the top of the sidebar you've got:
- ☀️ / 🌙 **Theme toggle** *(currently hidden — the dark palette is dormant pending a fix)*
- 🔧 **Crew mode** pill (working-managers toggle — see "Acting as crew" below)
- Your initials + name + sign-out

Which tabs you see depends on your **access scope** (see "Access scopes" below). A full manager or owner sees all of them; a warehouse or accounting manager sees a narrower set.

---

## Approving submissions

This is your #1 daily action. Submissions is the first tab.

**The queue:**
- Submissions group by project, then sort by submission time (newest first)
- A row shows: crew member, time, hours, totals (strand ft, fiber ft, etc.)
- Status pill on each: Pending / Approved / Flagged

**To approve:**
1. Tap a pending row → details slide out
2. You see: who, when, what task (project › phase/site › task name), totals, parts logged, any crew notes
3. Optional: add a manager note (gets stored with the submission)
4. Hit **Approve**

**What happens on approve:**
- Submission status → `approved`
- Phase actuals increment (phase-anchored fiber tasks only — infra tasks are anchored to a **site** and have no phase actuals)
- **Materials auto-deduct** from the submitter's truck → the project's bucket
  - Fires for `crew_type` in {`fiber_construction`, `field_service`, `infrastructure`} (plus the legacy values `aerial` / `underground` / `splice` / `fiber_tech`, still honored for back-compat)
  - `install` and `contractor` crew log work but don't auto-transfer materials
  - The transfer is **submission-scoped** — it aggregates only the parts on *this* submission, so two passdowns on the same task the same day never double-deduct each other
- The transfer movements show up under the project bucket's stock

> **On the task itself:** approving a submission **no longer closes the task**. A task stays in the crew's active list across as many daily passdowns as the work takes, and only leaves when a manager closes it. (The task lifecycle now runs on a manager-controlled `is_closed` flag, decoupled from submission approval — the DB and the approval RPC are in place. Approval still mirrors the task's *display* status to "approved" for now; the dedicated close-task control and the last of the status→`is_closed` rendering swaps are in progress. See CLAUDE.md backlog #2.)

**To flag:**
1. Add a note explaining what's wrong (gets surfaced to the crew)
2. Hit **Flag**

**What happens on flag:**
- Submission status → `flagged`, your note surfaced to the crew
- The task stays active for the crew — they open it, see your flag note, fix counts, and resubmit
- A resubmit replaces the prior submission cleanly (no duplicate parts in your view)

**To archive:**
After approval you'll see an **Archive** button. Archives drop out of the default view but stay queryable in Reports. Useful to keep the queue clean.

**Filters at the top:** Pending / Approved / Flagged / All + an Archived toggle.

---

## Crew status

The Crew tab is a real-time grid of every active crew member, color-coded by session status:

- 🟢 **In progress** — actively logging
- 🔵 **Started** — opened a task but hasn't submitted
- ⚪ **Submitted** — finished, waiting for your review
- 🔴 **Not started** — no session today

Each row shows their current project + task + footage, and sums the day's hours/parts across all of that member's tasks (a member can work several tasks in a day). Useful first-thing-morning to see who's already in the field, and end-of-day to see who's wrapping.

---

## Projects, phases, sites

Open **Projects** in the sidebar.

**Project cards** show progress at a glance. Tap one to open it.

### Fiber projects (Heber, Park City, etc.)

Inside: **Phases** with targets (strand ft, fiber ft, conduit ft, MST/HST, splice cases, handholes, vaults).
- Tap any target value to edit
- "+ Add phase" to create a new one
- Tap a phase to see/edit its tasks

Each phase has a "Permit URL" field — paste a Google Drive link or similar so crews can find the permit doc.

### Infra projects (Gigwave, Fixed Wireless, regional infra)

Look different: an **INFRA** treatment appears (a project with sites and no phases). Fiber-target metrics are hidden (they'd all be zero). Instead you get:

- **Sites section** — list of towers, MDU equipment closets, business installs
- Type pill per site: Wireless / Fiber
- Per-site **task count badge** — see at a glance which sites have active work
- **"+ Add site"** opens a sheet (name, type, address, notes)
- Search + type-filter pills appear once a project has ≥8 sites

**Click a site to open the Edit Site overlay:**
- Edit name / type / address / notes
- **Move to project** dropdown — fix mis-assigned sites (e.g. Prestige II was reassigned to Heber this way)
- **View tasks** — read-only list of tasks at this site with status pills
- **View materials** — every part summed across all tasks linked to this site. Useful before decommissioning to know what's installed.
- **Decommission site** — see "Decommissioning sites" below

### Tasks

- Click a phase (fiber) or site (infra) to see tasks
- Tasks open the editable workspace (same as what crew sees) — useful if you need to make a quick correction
- You can also delete tasks here (with confirmation). Deleting cascades through the task's sessions, entries, and submissions.

---

## Inventory — the big section

**Eight sub-tabs** under Inventory, plus a **Record movement** button and an actions strip (which collapses to a **⋯ More** sheet on phone).

### Sub-tabs

#### Stock
- Two-tier filter ribbon: primary = **All / Warehouses / Trucks / Project buckets** with counts; secondary = the specific locations matching that type
- Search by part name, SKU, or category (tokenized — multi-word searches AND their terms)
- For warehouses with bins: a sub-pill row appears (All rollup / Unbinned / individual bins)
- **Bulk-move** when in a specific location: select rows + hit "Move N parts". Disabled in a warehouse's rollup view (the source bin is ambiguous — drill into "Unbinned" or a specific bin first)

#### Locations
- Top-level sections (Warehouses / Trucks / Groups / Job sites / Vendors / Scrap) are collapsible — the header shows the count + rollup so you can see what's inside without opening it
- **Groups** are shared/multi-member buckets (Contractor - RNS, Crew - Construction, etc.) — distinct from personal trucks, with their own **Members** editor. Adding a member consolidates their personal-truck stock into the group and retires that truck; removing restores a personal truck
- Warehouses with bins are collapsible; inside, bins **group by aisle** (parsed from the bin name), each aisle its own collapsible header — keeps 165+ bins navigable
- Add/edit any location via "+ Add location" or the **Edit** button on a row; add bins via **+ Bin** on the warehouse row (single-level nesting only)
- **Retire** a location (with optional stock recovery) — see "Retiring locations" below

##### Assigning a person to a truck

Two paths:

1. **Automatic (the usual case).** When you create a user with a `crew_type` set (Admin → Users → Add user), a database trigger creates a personal truck for them automatically. No manual step needed.

2. **Manual reassignment.** Each truck row shows a 👤 chip in its header:
   - **Teal chip with a name** (e.g. `👤 Chad Sperry`) → currently assigned. Click the chip to open Edit and pick a different person.
   - **Amber chip "Unassigned"** → the truck has no current owner. Click to open Edit and pick someone.

The "Assigned to" dropdown only lists crew members who don't already have a truck (prevents accidental double-assignment); the currently-assigned person stays visible so you can change it without un-assigning first.

**Orphan trucks** appear when you deactivate a user — their truck stays around (still has stock, still has history) but the assignment is wiped. You'll see them as **amber Unassigned** chips, which serves as a punch list for "who needs a new truck, or which truck to retire with recovery."

#### Parts
- The catalog: every part with SKU, name, unit, category, department, material group, sonar routing
- Defaults to **Active** view; flip to **Drafts** to clean up CSV-imported / webhook-created placeholder parts (set unit + department, then bulk-activate)
- Single-edit and bulk-edit both available
- `category` is computed from department + material group — edit those, not category directly

#### Activity
- Movement history. Every receive, transfer, return, issue, scrap, adjust.
- Filter by location, date range, type
- See who created the movement and when. Movements are **immutable** — to fix one, record a counter-movement (the wrong one stays in the trail, by design)

#### Purchase Reqs
- FiberLog-originated purchase requests — the queue between "we need this" and "it arrived," replacing the spreadsheet-emailed-to-purchasing workflow
- Start one from **+ New PR**, or bulk-select rows in Stock / Parts → **Create PR** to pre-fill
- Vendor is **per line** (one PR can span suppliers); save as draft, or Save & CSV / PDF / copy-email
- Lifecycle pills: **All / Active / Pending / Ordered / Received / Cancelled** (default **Active**)
- When a delivery lands, open the PR → **Mark received** and it writes the `receive` movements for you (no re-entry via Receive PO)

#### Found
- The review queue for crew-reported found inventory (a crew member reports stock they found on their truck; it lands here as a pending request — no stock moves until you act)
- **Approve** books a `receive` movement into the chosen warehouse (materializing a draft part if the crew added a new one); **Reject** carries a reason
- Realtime, mirrors the Submissions queue's shape

#### Audit
- Generate a per-location physical-count CSV
- Filter by scope, part status, stock level, department, material group, staleness
- The CSV has an `Actual Qty` blank column + a `Variance` formula — fill it in physically, then round-trip into the Reconcile sheet

#### Cycle Count
- Live, scanner-driven counting (bin QR + part QR, or manual entry) — faster than the audit-CSV flow for a focused area
- **"None"** on a still-missing row records a count of 0 (one tap). Wrong tap? Open the part's row in Found (✏️) and **Clear count** to put it back to not-counted
- **Reopen** a submitted bin from the bin list to fix counts — available until the run is ended; after end-of-run the counts are final
- End a run → offsetting variances within a warehouse auto-pair as internal transfers; net gains/losses go to a manager-review queue
- **Bin distribution mode** turns counts into direct warehouse→bin transfers — use it for initial binning and any time a fresh shipment needs sorting into bins

### The actions strip

A **Record movement** button plus these sheets (on phone, everything except Record movement collapses behind **⋯ More**). Record movement defaults to **Transfer** and deliberately has no Receive option — vendor deliveries always go through **Receive PO** so every receipt carries vendor + cost metadata. (The old scan-driven **Move stock** sheet was removed Aug 2026; Record movement's Transfer type covers relocation.)

#### Receive PO
- Multi-line vendor delivery: vendor + invoice + destination, then SKU + qty + unit cost per line
- Can create new parts inline; posts as `receive` movements. Notes carry the vendor name for Sage later

#### Reconcile
- Upload the filled-in Audit CSV; preview the variances (positive = more on hand than recorded, negative = less)
- Apply → writes `adjust` movements to bring system stock in line with the physical count

#### Sonar (assets)
- Apply Sonar's daily **serialized-equipment** install report (routers, ONTs, etc. — one row per device)
- Each row → a `transfer` movement crew truck → routed bucket. Routing rule per part on `parts_catalog.sonar_routing`; city picker for `region`-routed parts

#### Fiber jobs
- Apply Sonar's daily **fiber-jobs** report (pushable cable, drops, splice trays — quantitative, no serial numbers)
- Same review-and-apply shape as the assets sheet, with its own mappings

#### Import CSV
- Bulk import from a BoxHero or generic stock CSV — maps SKUs, creates draft parts for unknowns, sets initial stock. Initial-seed path

#### Sage export
- Build the Sage Intacct CSV for a date range and stamp the included movements as exported (see "Reports → Sage export" below for the detail)

#### Footage map
- Admin for the footage-type → SKU mapping (which canonical part a crew's fiber/conduit "type" pick consumes)

---

## Decommissioning sites

When you retire a site, you have an integrated option to recover physical equipment back to a warehouse. **Available to owners and managers** (staff-guarded as of July 2026 — no longer owner-only).

1. Open the site → **Decommission site**
2. Modal shows the materials list (what was consumed at this site via tasks → auto-deduct movements)
3. Decide what to recover:
   - **Decommission only** — nothing selected. Equipment stays at the site, accounting unchanged. Use this when you're just stopping service and the gear's still there. Site flips to `status=decommissioned` and disappears from the UI.
   - **Pick parts to recover** — tick checkboxes, adjust qty if you're only recovering some. Pick a destination warehouse. On confirm: transfer movements fire (project bucket → warehouse), THEN the site decommissions. One atomic op — partial failures roll back.
4. The transfer notes are stamped "Site recovery … (decommissioned)" for the audit trail

> 💡 **Most decommissions are accounting-only.** Don't tick parts unless you're physically pulling them. If in doubt, decommission only and use Record Movement separately later.

---

## Retiring locations

Same flow as site decommission but for inventory locations (warehouses, trucks, groups, job_sites, bins). Locations tab → row → **Retire**. **Available to owners and managers** (staff-guarded as of July 2026).

The modal loads the location's current stock, offers per-part recovery with a destination picker. Amber warning if you try to retire with stock still on hand and didn't pick to move it — won't block, just nudges. Same atomic guarantee: transfers + retire in one transaction.

---

## Reports

Open **Reports**.

### Filtering
- Date range (presets: this week / last week / this month / last month / all-time + custom). On phone the filters collapse behind a **▾ Filters** toggle
- Project filter (defaults to All)
- User filter (defaults to All)
- Group by: Part / Person / Project

### Stock levels
**Stock levels** fetches live BoxHero stock and annotates the parts list. Red if out, amber if low, teal if healthy. *(Note: "low" currently means zero/negative — there's no reorder-threshold field yet.)*

### CSV export
**Export CSV** writes one row per part used in the filtered range. Columns include date, crew member, crew type, project, phase / site, task, part SKU, BoxHero ID, barcode, department, type, material group, name, qty, unit. This is the file you hand to Sage, or the input to the Consumption view's Sage export.

### Progress PDF
Generates a fiber-progress report PDF for the selected project. Only meaningful for fiber projects — disabled for infra-only projects (no phase targets to render).

### Sage export
The Consumption view has an **Export to Sage** button (also reachable as the Inventory → Sage export action) that opens the export sheet with the current date range pre-filled:

1. Pick the date range (default: last 7 days)
2. Optionally turn on **strict-consumption mode** — the default already excludes receipts (Sage books those from the PO), all `adjust` rows, and internal truck-to-truck / warehouse-internal moves; strict mode *additionally* drops crew loadouts + returns, keeping only true consumption
3. Preview shows what will export and what's skipped (with reasons)
4. **Download CSV + mark X exported** — stamps every included movement with `exported_at` + a batch ID; future exports skip them automatically. A toggle re-issues an already-exported batch if Sage rejected one

The CSV is the Sage Intacct Inventory Transactions template (18 columns). `PROJECTID` = the phase's project (or the bucket name); `CLASSID` = phase name (Sage cost-center sub-grouping). Still labeled "prototype" because the Sage-side code mappings aren't wired yet — see CLAUDE.md backlog #4.

---

## Assemblies (kits)

**Assemblies** tab. These are pre-built kits crew tap when logging — saves them from picking individual parts.

- Tabs across the top group kits by work type (aerial / footage / splice / underground / infrastructure / install)
- Each kit has: label, sub-label, included parts (with default qty), behavior flags (is_footage, is_fiber, is_mst, etc.)
- "+ New" to create one; pick the work type, add parts from the catalog, set quantities
- Active flag controls whether crews see it

> **Note:** the kit tabs are the **work-logging** axis (aerial / footage / splice / underground), which is *separate* from a user's `crew_type` classification. Fiber crews still see the same 4-tab strip regardless of whether they're classified `fiber_construction` or `field_service`.

### Authoring infra kits

The Infrastructure tab is empty by default. Author kits crew tap for tower installs, antenna swaps, UPS replacements, business installs, etc. Pull parts from the **Network Infrastructure** and **Infrastructure Construction** departments in the catalog. They appear immediately in an infra crew member's workspace.

---

## Admin

The **Admin** tab is visible to all non-restricted staff (owner + manager). It has these sections:

### Users
- Add new users. You pick a **named access type** (Owner / Full manager / Working manager / Warehouse manager / Accounting / Crew / Contractor), which sets the underlying `role`, `staff_scope`, and `crew_type` for you
- Edit existing — name, access type, active flag, per-user movement-operation permissions, load-destination whitelist
- Reset password (owner / manager; resetting *another owner's* password is owner-only)
- Soft-deactivate (`is_active=false`) — hard-delete is blocked because users are FK targets for movements/submissions
- A role change on save pops an explicit confirm (with a "loses manager portal" warning on demotions)

### Crew × Dept Permissions
- Matrix of which `crew_type`s can touch which part departments
- Empty = unrestricted (a crew_type with no rows can use any part)
- Enforced by the `record_crew_movement` RPC — crew can't load a part outside their whitelist. In the crew pickers, restricted parts stay visible but greyed with a "Not loadable for your crew" badge

### BoxHero sync
- Pulls live stock counts from BoxHero; shown in Reports when you tap "Stock levels"

### Reset password
- Same UI as in Users; surfaced separately for quick access

---

## Access scopes

FiberLog scopes the manager portal by `staff_scope` (set for you when you pick a named access type in Users). This is UI-scoping — the database's RLS is the real security boundary.

| Access type | Sees | Notes |
|---|---|---|
| **Owner** | Everything | Only role that can mint other owner accounts |
| **Full manager** | Everything | Standard manager |
| **Working manager** | Everything + can flip into crew mode | Needs a field `crew_type` set |
| **Warehouse manager** | Inventory (full ops) + Reports + Admin | For an inventory clerk who doesn't approve passdowns. No Submissions/Crew |
| **Accounting** | Reports + a **limited** Inventory (Receive PO + Purchase Requests + read-only stock) | **No Approvals by design** — approvals drive material auto-deduct, which is an operations decision, not accounting's |
| **Crew / Contractor** | Not the manager portal at all | Crew shell only |

`src/lib/access.js` is the single source of truth for what each scope sees (`visibleManagerTabs`, `canActAsCrew`, `inventoryIsLimited`).

---

## Working-manager toggle ("Acting as crew")

If you also do field work, you don't need a second account.

1. Set a field `crew_type` on your user (Admin → Users → pick the **Working manager** access type, then a crew_type)
2. Click the **🔧 Crew mode** pill at the top of the manager sidebar
3. You're now in the crew shell — log work, load parts to your truck, submit your day, all under your own user_id (infra crew_type routes you into the sites-shaped shell instead)
4. Click **⚙️ Manager** in the crew sidebar to flip back

Only a **full-scope** user with a field `crew_type` can flip (`canActAsCrew` in `access.js`). Choice persists across reloads via `localStorage.fiberlog_view_mode`; resets to manager on sign-out so the next user can't inherit it.

**Auto-deduct caveat:** the approval RPC gates auto-deduct on `crew_type` ∈ {`fiber_construction`, `field_service`, `infrastructure`} (+ legacy `aerial`/`underground`/`splice`/`fiber_tech`). If your crew_type is `install` or `contractor`, you can log work but your approved submissions won't transfer materials. Fine for tracking time/notes — just know.

---

## Common gotchas

| Problem | Cause / fix |
|---|---|
| **Submitted task shows "Unknown" project** | The task was created with no phase/site assigned. Open it in your manager view and check its anchor (every task must have a phase or a site). |
| **Submission lists 0 parts even though crew said they used some** | If the only kit on the task is an empty template, have them re-submit using "+ Add part not in list." The submit flow handles empty-kit + extra-only submissions correctly now. |
| **My Stock on crew side shows wrong numbers** | `inventory_stock` isn't in the realtime publication — crew sees a snapshot from page load. After a Sonar / Reconcile / auto-deduct, the crew needs to refresh manually. |
| **Receive PO inline-create doesn't show up in later lines' search** | Known. Close + reopen the sheet; the new SKU will be in the catalog index. |
| **Audit CSV reconcile matched the wrong truck** | Round-trip uses location *names*. If two locations share a display name you can get a mis-match — rename so display names are unique. |
| **Progress PDF for an infra project renders empty** | Infra projects have no phases → no progress to render. Use the per-site Materials view in Sites admin instead. |
| **A part won't load for a crew member** | Check Admin → Crew × Dept Permissions. If that crew_type has a whitelist and the part's department isn't in it, the RPC rejects it (and it shows greyed in their picker). |
| **Stock tab looked like it was under-reporting** | Fixed July 2026 — un-paginated reads were silently capped at 1,000 rows. All large stock reads now page. If you see it again, re-report. |

---

## When something's really broken

- **App won't load / blank screen** → hard refresh (Ctrl+Shift+R). Check the browser console. A realtime channel-name collision was a past cause (fixed via `nextChannelSuffix`).
- **Stuck in crew mode, can't switch back** → clear `localStorage.fiberlog_view_mode` in DevTools, or sign out and back in.
- **Migration / RPC error in a save** → the error toast usually has enough; if not, the Activity tab + console give the full picture. (Destructive chains now surface the real error instead of falsely reporting success.)
- **Sage CSV looks wrong** → check the filters on Reports. Most "wrong" exports are filter mismatches.

---

## Owner-only at a glance

After the July 2026 staff-access work, the owner/manager boundary is narrow. Owner-only actions:

- **Create owner accounts** (both the UI and the `admin-create-user` server function stay owner-locked)
- **Reset another owner's password**

Everything else in this guide — including retiring locations, decommissioning sites, pausing/resuming inventory, and the load-destination whitelist — is available to managers as well.

---

## Where to learn more

- **Crew side:** [CREW_GUIDE.md](./CREW_GUIDE.md)
- **Inventory tab deep-dive:** [INVENTORY_TAB.md](./INVENTORY_TAB.md)
- **End-to-end material flow:** [INVENTORY_FLOW.md](./INVENTORY_FLOW.md)
- **Developer / data model:** `CLAUDE.md` in the repo root — schema, RPCs, edge functions, all the architectural decisions, and the live backlog

---

*Last updated: July 2026*
