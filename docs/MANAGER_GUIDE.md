# FiberLog — Manager Guide

For owners and managers — running approvals, inventory, projects, and crew administration.

> 🌐 https://criddell-blip.github.io/fiberlog/
> Works on laptop, tablet, and phone. Most of what you'll do is laptop-comfortable.

If you're looking for what your crew sees: **[CREW_GUIDE.md](./CREW_GUIDE.md)**.

---

## The daily flow

1. **Morning** — open Submissions, approve or flag yesterday's passdowns
2. **As needed during the day** — Receive POs as they arrive, answer crew questions, check the Crew tab to see who's working what
3. **End of day** — quick scan of the queue, anything not yet submitted
4. **Weekly / monthly** — run Sage CSV export, reconcile counts where audits surfaced drift

Most of your daily activity is in **Submissions** and **Inventory**. Everything else is occasional.

---

## The portal at a glance

The sidebar (or top bar on phone) has these tabs:

| Tab | What's there | How often you'll touch it |
|---|---|---|
| **📥 Submissions** | Queue of daily passdowns from crew. Approve, flag, archive. | Daily |
| **👥 Crew** | Live view of who's logging what today, with hours + parts | Daily glance |
| **📂 Projects** | Add/edit projects, phases, sites, tasks, targets | Weekly |
| **📊 Reports** | CSV export, Stock levels (BoxHero), Progress PDFs | Weekly / on demand |
| **🧰 Assemblies** | Author the kits crew tap when logging work | One-off setup, occasional tweaks |
| **📦 Inventory** | Stock, Locations, Parts, Activity, Audit + 5 action sheets | Daily-ish |
| **⚙️ Admin** *(owner only)* | Users, passwords, BoxHero sync, crew permissions | One-off setup, monthly check |

At the top of the sidebar you've got:
- ☀️ / 🌙 **Theme toggle**
- 🔧 **Crew mode** pill (working-managers toggle — see "Acting as crew" below)
- Your initials + name + sign-out

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
4. Hit **✅ Approve**

**What happens on approve:**
- Status → `approved`
- Task status → `approved`
- Phase actuals increment (fiber crews only — infra has no phase actuals)
- **Materials auto-deduct** from the crew member's truck → the project's bucket
  - Only fires for `crew_type` in {aerial, underground, splice, infrastructure}
  - Other crew types (drop, locator, install, contractor) log work but don't auto-transfer
- The transfer movements show up under the project bucket's stock

**To flag:**
1. Add a note explaining what's wrong (gets surfaced to the crew)
2. Hit **🚩 Flag**

**What happens on flag:**
- Status → `flagged`
- Task status reverts → `open` so the crew sees it back in their active sidebar
- Crew opens it, sees your flag note, fixes counts, resubmits
- Resubmit replaces the prior submission cleanly (no duplicate parts in your view)

**To archive:**
After approval you'll see an **📦 Archive** button. Archives drop out of the default view but stay queryable in Reports. Useful to keep the queue clean.

**Filters at the top:** Pending / Approved / Flagged / All + an Archived toggle.

---

## Crew status

The Crew tab is a real-time grid of every active crew member, color-coded by session status:

- 🟢 **In progress** — actively logging
- 🔵 **Started** — opened a task but hasn't submitted
- ⚪ **Submitted** — finished, waiting for your review
- 🔴 **Not started** — no session today

Each row shows their current project + task + footage. Useful first-thing-morning to see who's already in the field, and end-of-day to see who's wrapping.

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

Look different: an **INFRA** chip appears next to the project name. Fiber-target metrics are hidden (they'd all be zero). Instead you get:

- **Sites section** — list of towers, MDU equipment closets, business installs
- Type pill per site: 📡 Wireless / 🏢 Fiber
- Per-site **task count badge** — see at a glance which sites have active work
- **"+ Add site"** opens a sheet (name, type, address, notes)

**Click a site to open the Edit Site overlay:**
- Edit name / type / address / notes
- **Move to project** dropdown — fix mis-assigned sites (e.g. Prestige II got moved to Heber this way)
- 🛠️ **View tasks** — read-only list of tasks at this site with status pills
- 📦 **View materials** — every part summed across all tasks linked to this site. Useful before decommissioning to know what's installed.
- ⊘ **Decommission site** *(owner-only)* — see "Decommissioning sites" below

### Tasks

- Click a phase (fiber) or site (infra) to see tasks
- Tasks open the editable workspace (same as what crew sees) — useful if you need to make a quick correction
- You can also delete tasks here (with confirmation)

---

## Inventory — the big section

Five sub-tabs under Inventory + five action sheets along the top.

### Sub-tabs

#### 📦 Stock
- Two-tier filter ribbon: primary = **All / Warehouses / Trucks / Project buckets** with counts; secondary = the specific locations matching that type
- Search by part name, SKU, or category
- For warehouses with bins: a sub-pill row appears (📦 All rollup / 🟰 Unbinned / individual bins)
- **Bulk-move** when in a specific location: select rows + hit "Move N parts"

#### 🏭 Locations
- Top-level sections (Warehouses / Trucks / Job sites / Vendors / Scrap) are collapsible — click a section header to expand. Default is all collapsed; the header shows the count + rollup of parts/units so you can see what's inside without opening it.
- Warehouses with bins are also collapsible — click the warehouse row to expand. Inside, bins **group by aisle** (parsed from the bin name) and each aisle is its own collapsible header showing bin count + stock rollup. With 165+ bins, this keeps the page navigable.
- Add/edit any location via the "+ Add location" button or the **Edit** button on a row
- Add bins under warehouses via the **+ Bin** button on the warehouse row (single-level nesting only)
- ⊘ **Retire** *(owner-only)* — see "Retiring locations" below

##### Assigning a person to a truck

Two paths:

1. **Automatic (the usual case).** When you create a user with a `crew_type` set (Admin → Users → Add user), the database trigger creates a personal truck for them automatically. No manual step needed.

2. **Manual reassignment.** Each truck row in the Locations tab shows a 👤 chip in its header:
   - **Teal chip with a name** (e.g. `👤 Chad Sperry`) → currently assigned. Click the chip to open the Edit sheet and pick a different person.
   - **Amber chip "Unassigned"** → the truck has no current owner. Click to open Edit and pick someone.

The "Assigned to" dropdown in the Edit sheet only lists crew members who don't already have a truck (prevents accidental double-assignment). The currently-assigned person stays visible in the dropdown so you can change it without first un-assigning.

**Orphan trucks** show up when you deactivate a user — their truck stays around (still has stock, still has history) but the assignment is wiped. You'll see them as **amber Unassigned** chips in the Trucks section, which serves as a punch list for "who needs a new truck assigned, or which truck needs to be retired with recovery."

#### 🔧 Parts
- The catalog: every part with SKU, name, unit, category, department, material group, sonar routing
- Defaults to **Active** view; flip to **Drafts** to clean up CSV-imported placeholder parts
- Single-edit and bulk-edit both available
- Edit unit, category, sonar routing, etc. all here

#### 📜 Activity
- Movement history. Every transfer, receive, return, issue, scrap, adjust.
- Filter by location, date range, type
- See who created the movement and when

#### 🔍 Audit
- Generate a per-location physical-count CSV
- Filter by scope, part status, stock level, department, material group, staleness
- The CSV has an `Actual Qty` blank column + a `Variance` formula — fill it in physically, then round-trip into the Reconcile sheet

### Action sheets

#### ⇪ Import CSV
- Bulk import from a BoxHero or generic stock CSV
- Maps SKUs, creates draft parts for unknowns, sets initial stock

#### 📥 Receive PO
- Multi-line vendor delivery
- Type SKU (or use search), set qty, optionally create the part inline if it doesn't exist
- Posts as `receive` movements into the chosen warehouse
- Notes field gets the vendor name — useful for Sage export later

#### 🔄 Reconcile
- Upload the filled-in Audit CSV from above
- Preview the variances (positive = you have more, negative = less than recorded)
- Apply → writes `adjust` movements to bring system stock in line with physical count

#### ⚡ Sonar
- Upload the daily Sonar install report (when field-tech work runs through Sonar)
- Each row → a `transfer` movement crew truck → routed bucket (Gigwave / regional / etc.)
- Per-part routing rule is set on `parts_catalog.sonar_routing`
- City picker for `region`-routed parts (defaults persist via `sonar_city_bucket_map`)

#### ＋ Record movement
- Free-form single movement
- Pick type (receive/transfer/return/issue/scrap/adjust), from, to, part, qty
- Used for one-off corrections when nothing else fits

---

## Decommissioning sites *(owner-only)*

When you retire a site, you have an integrated option to recover physical equipment back to a warehouse.

1. Open the site → ⊘ **Decommission site**
2. Modal shows the materials list (what was consumed at this site via tasks → auto-deduct movements)
3. Decide what to recover:
   - **Decommission only** — nothing selected. Equipment stays at the site, accounting unchanged. Use this when you're just stopping service and the gear's still there. Site flips to status=decommissioned and disappears from the UI.
   - **Pick parts to recover** — tick checkboxes, adjust qty if you're only recovering some. Pick a destination warehouse. On confirm: transfer movements fire (project bucket → warehouse), THEN the site decommissions. One atomic op — partial failures roll back.
4. The transfer notes are stamped "Site recovery: <name> (decommissioned)" for the audit trail

> 💡 **Most decommissions are accounting-only.** Don't tick parts unless you're physically pulling them. If in doubt, decommission only and use Record Movement separately later.

---

## Retiring locations *(owner-only)*

Same flow as site decommission but for inventory locations (warehouses, trucks, job_sites, bins). Locations tab → row → **Retire**.

The modal loads the location's current stock (`inventory_stock`), offers per-part recovery with destination picker. Amber warning if you try to retire with stock still on hand and didn't pick to move it — won't block, just nudges.

Same atomic guarantee: transfers + retire in one transaction.

---

## Reports

Open **Reports**.

### Filtering
- Date range (presets: this week / last week / this month / last month / all-time + custom)
- Project filter (defaults to All)
- User filter (defaults to All)
- Group by: Part / Person / Project

### Stock levels
**📦 Stock levels** button at the top right fetches live BoxHero stock and annotates the parts list. Red if out, amber if low (< 2× recent usage), teal if healthy.

### CSV export
**Export CSV** writes one row per part used in the filtered range. Columns include date, crew member, crew type, project, phase / site, task, part SKU, BoxHero ID, barcode, department, type, material group, name, qty, unit. This is the file you hand to Sage (or eventually drop into the Go-Live import).

### Progress PDF
Generates a fiber-progress report PDF for the selected project. Only meaningful for fiber projects — disabled for infra-only projects (those have no phase targets to render).

---

## Assemblies (kits)

**Assemblies** tab. These are pre-built kits crew tap when logging — saves them from picking individual parts.

- Tabs across the top group by crew type: Aerial / Footage / Splice / Underground / Infrastructure / Install
- Each kit has: label, sub-label, included parts (with default qty), behavior flags (is_footage, is_fiber, is_mst, etc.)
- "+ New" to create one; pick crew_type, add parts from the catalog, set quantities
- Active flag controls whether crews see it

### Authoring infra kits

The Infrastructure tab is empty by default. Author kits crew tap for tower installs, antenna swaps, UPS replacements, business installs, etc. Pull parts from the **Network Infrastructure** and **Infrastructure Construction** departments in the catalog.

---

## Admin *(owner only)*

The **Admin** tab has four sections:

### Users
- Add new users (name, crew type, role, email, initial password ≥ 8 chars)
- Edit existing — name, role, crew_type, active flag, per-user movement-operation permissions
- Reset password (owner / manager only — owner of owners only)
- Soft-deactivate (`is_active=false`) — hard-delete is blocked because users are FK targets for movements/submissions

### Crew × Dept Permissions
- Matrix of which crew_types can touch which part departments
- Empty = unrestricted (a crew_type with no rows can use any part)
- Used by `record_crew_movement` RPC to enforce — crew can't load a part outside their whitelist

### BoxHero sync
- Pulls live stock counts from BoxHero
- Shown in Reports when you tap "Stock levels"

### Reset password
- Same UI as in Users; surfaced separately for quick access

---

## Working-manager toggle ("Acting as crew")

If you also do field work, you don't need a second account.

1. Set your `crew_type` on your user (Admin → Users → Edit → pick aerial/underground/splice/infrastructure)
2. Click the **🔧 Crew mode** pill at the top of the manager sidebar
3. You're now in the crew shell — log work, load parts to your truck, submit your day, all under your own user_id
4. Click **⚙️ Manager** in the crew sidebar to flip back

Choice persists across reloads via `localStorage.fiberlog_view_mode`. Resets to manager on sign-out (so the next user can't inherit your preference).

**Auto-deduct caveat:** the `approve_submission` RPC still gates auto-deduct on crew_type ∈ {aerial, underground, splice, infrastructure}. If you set yourself to `drop`/`locator`/`install`/`contractor`, you can log work but your approved submissions won't transfer materials. Fine for tracking time/notes, just know.

---

## Common gotchas

| Problem | Cause / fix |
|---|---|
| **Submitted task shows "Unknown" project** | The task was created with no phase/site assigned. Open the task in your manager view and check its anchor. |
| **Submission lists 0 parts even though crew said they used some** | If the only kit on the task has 0 parts (empty template), the saveEntry path may have skipped. Have them re-submit with the "+ Add part not in list" search. The submit flow now handles this correctly. |
| **My Stock on crew side shows wrong numbers** | `inventory_stock` isn't in the realtime publication — crew sees a snapshot from page load. After you run a Sonar / Reconcile / auto-deduct, the crew needs to refresh manually. |
| **Receive PO inline-create doesn't show up in the search dropdown on later lines** | Known. Close + reopen the sheet, the new SKU will be in the catalog index. |
| **Audit CSV reconcile matched the wrong truck** | Round-trip uses location *names*. If two trucks share a first name (we renamed Tyler trucks to fix this), you get a possible mis-match. Rename so display names are unique. |
| **Progress PDF for Gigwave / Fixed Wireless renders empty** | These are infra projects — no phases means no progress to render. Use the per-site Materials view in Sites admin instead. |
| **Approved task still shows as "open" somewhere** | Look at the *task* status (which is what the sidebar uses) vs the *submission* status. The two were coupled and we're moving toward decoupling (backlog item — the `is_closed` redesign). |
| **Crew can't log to a part** | Check Admin → Crew × Dept Permissions. If the crew_type has a whitelist and the part's department isn't in it, the RPC will reject. |

---

## When something's really broken

- **App won't load / blank screen** → hard refresh (Ctrl+Shift+R). Check browser console for errors. Common cause: a realtime channel name collision (fixed in May 2026 via `nextChannelSuffix`, but worth knowing).
- **Stuck in crew mode, can't switch back** → manually clear `localStorage.fiberlog_view_mode` in DevTools or sign out and back in.
- **Migration / RPC error in a save** → the error toast usually has enough; if not, the Activity tab + browser console give the full picture.
- **Sage CSV looks wrong** → check the filters on Reports. Most "wrong" exports are filter mismatches.

---

## Owner-only at a glance

Things only owners can do (manager users see these buttons hidden):
- Retire locations (Inventory → Locations → Retire button)
- Decommission sites (Projects → Site → Decommission button)
- Reset password on other owners
- Future: the Sage CSV export trigger (recommended; not enforced yet)

Everything else is available to both owner and manager.

---

## Where to learn more

- **Crew side:** [CREW_GUIDE.md](./CREW_GUIDE.md)
- **Developer / data model:** `CLAUDE.md` in the repo root — covers schema, RPCs, edge functions, all the architectural decisions
- **Backlog + open work:** see the "Backlog" section of `CLAUDE.md`

---

*Last updated: May 2026*
