# FiberLog — Training

Role-based training for onboarding anyone onto FiberLog, with hands-on practice exercises that are
safe to run against the live app (there is no sandbox — the safety rules below matter).

> **Presentable web version** (same content, slide-style, with an EN/ES toggle on the crew module and
> progress checkboxes): https://claude.ai/code/artifact/06ebfcc9-97be-4bda-9f5f-2cf677c955aa
>
> Source guides this training is built from: [CREW_GUIDE.md](./CREW_GUIDE.md) (bilingual) ·
> [MANAGER_GUIDE.md](./MANAGER_GUIDE.md) · [INVENTORY_TAB.md](./INVENTORY_TAB.md) ·
> [INVENTORY_FLOW.md](./INVENTORY_FLOW.md)

**How to use this:** everyone starts with Module 1 (~15 min), then jumps to their role's module.
Practice blocks are marked **ZERO IMPACT** (safe, nothing to undo) or **CREATES REAL DATA**
(a manager must clean up afterward — see the [session runbook](#trainers-runbook--cleanup)).

---

## Module 1 — Orientation (everyone, ~15 min)

### 1.1 What FiberLog is, and why we use it

FiberLog is a field logging and inventory app used daily by our fiber crews, infrastructure crews,
and managers across the BEAD-funded buildout sites (Heber, Park City, Wasatch Front, Ogden Valley,
West Mountain, and the wireless projects).

It exists to answer one question with certainty: **what materials were used, by whom, on which
project?** That record feeds accounting (Sage) and BEAD reimbursement reporting. If work isn't
logged in FiberLog, the company can't bill for the material — "log it in FiberLog" is not optional
paperwork; it's how the work gets paid for.

### 1.2 The mental model: parts, locations, movements

- **Parts** — anything we stock. Each has a SKU, a name, and a unit (`ea` counted, `ft` measured).
- **Locations** — anywhere stock can sit: warehouses (with bins inside), each crew member's personal
  truck, shared trailers, and one **project bucket** per project.
- **Movements** — the *only* way stock changes. A load, a return, a vendor receipt, a count
  correction: each is a movement from one location to another; on-hand numbers update automatically.

> **The most important thing to internalize:** you never edit a stock number directly. You record
> *what happened*, and stock updates itself. Movements can't be edited or deleted afterward — a
> mistake is fixed with a counter-movement, so the audit trail stays intact for Sage and BEAD.

### 1.3 One day in the life of a part

```
Vendor → Warehouse → Truck → Project bucket → Sage
```

1. A vendor delivery lands; the warehouse books it in with **Receive PO**.
2. A crew member **Load**s it onto their truck in the morning.
3. They use it on a task and log it in their daily passdown.
4. They **Submit day ✓**; the passdown lands in the manager's queue.
5. The manager approves → the part automatically transfers truck → **project bucket** (the permanent
   consumption record — nothing drains it).
6. At period end, the Sage export pulls the bucket's movements into the accounting CSV.

### 1.4 Signing in

- Username is **firstname.lastname** (no spaces) or your company email.
- First-time password is whatever your manager set — change it: initials circle → **Change password**.
- **¿Español?** Tap **EN · ES** on the login screen, or initials → 🌐 Language once inside.
- Wrong password → ask your manager for a reset. "Could not connect" → check signal, retry.

### 1.5 Who sees what

| Access type | What they see |
|---|---|
| Crew / Contractor | The crew shell only. Never the manager portal. |
| Owner / Full manager | Everything: Submissions, Crew, Projects, Reports, Assemblies, Inventory, Admin. |
| Working manager | Everything, plus a **🔧 Crew mode** pill to flip into the crew shell. |
| Warehouse manager | Inventory (full ops) + Reports + Admin. No approvals. |
| Accounting | Reports + limited Inventory (Receive PO, PRs, read-only stock). No approvals by design. |

### 🔧 Practice — everyone · ZERO IMPACT

- [ ] Sign in on your own phone.
- [ ] Switch the language to Español and back (or the reverse).
- [ ] Change your first-time password.
- [ ] Look around your home view, find **Sign out**, and sign back in.

---

## Module 2 — Field crew (~45 min)

> Bilingual delivery: teach from this module in English, or from the matching Spanish sections in
> [CREW_GUIDE.md](./CREW_GUIDE.md) — the web version of this training has a live EN/ES toggle.

> **The golden rule:** a task stays in your **Active** list until a manager closes it — even after
> you submit. One task = one stretch of work, with as many daily passdowns as the job takes.
> **Never re-create a task.**

### 2.1 The whole day in 5 steps

1. **Sign in.**
2. **Load parts** from the warehouse onto your truck (📦 My Stock).
3. **Pick your task** — Project → Phase → Task (infra crew: Project → Site → Task).
4. **Log what you used and your hours** — it auto-saves.
5. **Submit your day** — the task stays put for tomorrow.

The manager approves it and the parts transfer truck → project automatically. Those five steps are
95% of crew use of the app.

### 2.2 My Stock — loading and returning

- **Load** (warehouse → truck): **Load** → find the part (search-first or location-first) → quantity
  → **＋ Add another part** to build a list → **Load**, review, confirm.
- **Return** (truck → warehouse): **Return** on any part row (quantity pre-fills to everything —
  dial it down if keeping some) → destination → review → confirm.
- **Amber "…will go negative" warning** — you asked for more than the system shows. You *can*
  proceed, but only when the material is truly in your hands and the count is wrong.
- **Greyed part, "Not loadable for your crew"** — that department isn't on your crew type's list.
- **Red negative numbers** on your truck — tell your manager so it gets reconciled.
- **Found material not in the system** — **My Stock → Report found inventory**; a manager approves
  it before it counts.

⚠️ **Return unused parts at end of day**, or your truck inventory drifts from reality.

### 2.3 Finding your work

- Fiber crew: Project → Phase → Task. Infra crew: Project → Site → Task (📡 wireless / 🏢 fiber).
- **Active tasks** — pills show the latest passdown's state: Submitted (amber), Approved (green),
  Flagged (red). A task with a pill is still open — keep working it.
- **Completed** (collapsed at bottom) — tasks a manager closed; read-only.
- Create a new task **only when the work isn't already on the list**: **＋ Add task**, named after
  the section/location.

### 2.4 Logging your day

- **Kits (assemblies):** the tabs group kits of parts that go together. **＋** counts one, **−**
  removes one. Footage kits take feet, and you can pick more than one type on the same span.
- **A part not in any kit:** **＋ Add part not in list** → search, pick, quantity.
- **Hours** default to 8; add a **note** for anything the manager should know.
- 🔄 **It auto-saves** — close the app, restart the phone, hand off to another crew; the counts stay
  on the task.
- **Shared tasks:** the "N passdowns submitted · view ›" strip shows what's already turned in
  (immutable). A warning about someone's **UNSUBMITTED** work means continuing edits *their* draft —
  only do it if you're taking over their day.

### 2.5 Submitting — and after

1. **Wrap up day →** — check parts, set hours, add a note.
2. **Submit day ✓** (or **Keep logging** to back out).

🔒 A submitted passdown is **final**. After submitting, the task **stays in Active** with an amber
*Submitted* pill — tomorrow you open the same task and log a new passdown. When the whole job is
done, the *manager* closes the task.

**If your manager flags your passdown:** red banner with their reason + your original numbers. The
form is blank on purpose — re-enter the day correctly and **Submit day ✓**; the new passdown
replaces the flagged one.

### 2.6 Quick troubleshooting

| Problem | Fix |
|---|---|
| "My task disappeared!" | Check **Completed** (a manager closed it) or look for the *Submitted* pill. **Never re-create it.** |
| Submitted wrong numbers | Tell your manager — they fix or flag it, and you re-submit. |
| Search finds nothing | Multi-word search works; check spelling. Greyed = department not on your crew's list. |
| Truck shows wrong stock | Refresh — My Stock doesn't live-update. Still wrong? Tell your manager. |
| Task belongs to a different project | Use the **"Routing materials to:"** picker in the workspace. |
| App slow / weird | Hard refresh, sign back in. |

### 🔧 Practice A — load & return · ZERO IMPACT

- [ ] **My Stock → Load** — search the cheap part the trainer names.
- [ ] Load **1 unit** to your truck; confirm it appears.
- [ ] **Return** the same 1 unit to the same warehouse; confirm My Stock is back to what it was.

*Net stock change is zero. The two movements stay in the activity trail (by design); no cleanup.*

### 🔧 Practice B — a full passdown · CREATES REAL DATA

- [ ] Open the practice task the trainer created (`TRAINING – <your name> – DELETE ME`). Don't
  create your own.
- [ ] Count 1 of any kit, set hours to 1, note `training — ignore`.
- [ ] **Wrap up day →** and **Submit day ✓**.
- [ ] Notice the task stays in Active with the *Submitted* pill — the golden rule in action.
- [ ] Wait for the trainer to flag it, read the red banner, and re-submit once.

**Cleanup required:** a manager must **flag — never approve** — this passdown, then delete the
practice task. See the [runbook](#trainers-runbook--cleanup).

---

## Module 3 — Managers (~45 min)

Approvals are the heartbeat: every approval posts real material consumption to a project's ledger.

### 3.1 The daily rhythm

- **Morning** — Submissions: approve or flag yesterday's passdowns. Glance at Crew.
- **During the day** — receive deliveries, apply the morning's Sonar reports, answer questions.
- **End of day** — scan the queue; **close tasks whose work is finished**.
- **Weekly / monthly** — Sage export; reconcile counts where audits surfaced drift.

### 3.2 Approving submissions — your #1 action

Tap a pending row → detail slides out (who, when, task, totals, parts, notes). Three moves:

- **Approve** — phase actuals increment (fiber tasks) and **materials auto-deduct** from the
  submitter's truck into the project bucket. Submission-scoped: two same-day passdowns on one task
  never double-deduct each other.
- **Edit, then approve** — when "the materials aren't right," use **Edit materials & hours** to fix
  quantities, parts, hours, or footage rollups in place, then Approve. The deduction reflects your
  edits. Beats bouncing a typo back to the crew.
- **Flag** — for genuine send-backs (wrong task, redo the day). Your note + their original numbers
  surface to the crew; a resubmit replaces the flagged one cleanly.

⚠️ **Approval is irreversible** — the submission becomes immutable and the transfer is posted. When
in doubt, edit or flag first. Note: `install` and `contractor` crew types log work but don't
auto-deduct.

**Archive** after approval keeps the queue clean; archived rows stay queryable in Reports.

### 3.3 Closing tasks — approval ≠ done

Approving a passdown does **not** close the task. A task stays in the crew's Active list across as
many passdowns as the work takes, and only leaves when *you* close it — this killed the old
re-create-and-double-count failure mode. Make closing part of your end-of-day pass. "My task
vanished" = it's closed (reopen it) or just showing a Submitted pill.

### 3.4 Crew status board

Live grid of every active crew member: 🟢 in progress · 🔵 started · ⚪ submitted · 🔴 not started,
with current project/task/footage and the day's summed hours and parts.

### 3.5 Projects, phases, and sites

- **Fiber projects** hold **phases** with targets (strand/fiber/conduit ft, MST/HST, splice cases,
  handholes, vaults). Tap a target to edit; each phase has a Permit URL field.
- **Infra projects** hold **sites** (towers, MDU closets, business installs) with per-site task
  badges. Click a site to edit, move to another project, view tasks, or view materials consumed.
- **Decommissioning a site** is accounting-only (no movements). Gear you physically pull back
  is logged as a field return: Inventory → Receive PO → **Returned from field**.

### 3.6 Assemblies, users, and permissions

- **Assemblies** are the kits crews tap — keep them curated, especially the Infrastructure tab.
- **Users** (Admin → Users): pick a named access type; the system sets role/scope. New crew users
  auto-get a personal truck.
- **Crew × Dept permissions**: which crew types can load which part departments. Empty =
  unrestricted. First place to look when "a part won't load."
- **Deactivate, never delete.** An ex-user's truck stays as an amber "Unassigned" chip in Locations
  until reassigned or retired.

### 3.7 Working managers — acting as crew

With the *Working manager* access type + a field crew type, the **🔧 Crew mode** pill flips you into
the crew shell — same identity, same truck. **⚙️ Manager** flips back. Resets to manager on sign-out.

### 🔧 Practice — review, flag, and clean up · CREATES REAL DATA

Pairs with the crew module's Practice B — you are the manager side.

- [ ] **Before the session:** create one task per trainee named `TRAINING – <name> – DELETE ME`.
- [ ] When trainee passdowns arrive, open one in Submissions and walk the detail view.
- [ ] Try **Edit materials & hours**: change a quantity, save — it stays pending. **Do not approve.**
- [ ] **Flag** the passdown with note `training — ignore`. Watch the trainee get the banner and
  re-submit.
- [ ] Flag the re-submission too, then delete the TRAINING task in Projects (deletion cascades its
  sessions, entries, and submissions).
- [ ] Check Crew status during the session — trainees appear as live sessions.

**Never approve a training passdown** — approval posts a real truck → project transfer and bumps
phase actuals; both are irreversible without counter-movements.

---

## Module 4 — Warehouse & inventory (~45 min)

Sub-tabs are for *looking things up*; the action buttons are for *changing something*.

### 4.1 The lay of the land

| Sub-tab | The question it answers |
|---|---|
| 📦 Stock | "What's where right now?" The most-used tab. |
| 🏭 Locations | "What warehouses, bins, trucks, groups, buckets exist?" Truck assignment lives here. |
| 🔧 Parts | "What's in the catalog? Any drafts to clean up?" |
| 📜 Activity | "What just happened?" Every movement ever — first stop when something looks off. |
| 📋 Purchase Reqs | The queue between "we need this" and "it arrived." | *(Hidden while Admin → Purchasing is Off — the default since Aug 20 2026.)*
| 🔍 Found | Crew-reported found inventory awaiting approve/reject. |
| 🔍 Audit | Generates the physical-count CSV. |
| 🔢 Cycle Count | Live scanner-driven counting, bin by bin. |

Actions: **＋ Record movement** (transfer / return / issue / scrap / adjust — deliberately no
receive; vendor deliveries go through **Receive PO** so every receipt carries vendor + cost
metadata), plus Receive PO, Reconcile, Sonar, Fiber jobs, Import CSV, Sage export, Footage map.

### 4.2 Receiving deliveries

- **Has a PR** — open it in Purchase Reqs → **Mark received**. Done; receive movements are written
  for you.
- **No PR** — **Receive PO**: vendor, invoice, destination, then SKU + qty + unit cost per line.
  New part? Type its SKU and use **+ create** — a draft part is created on the spot. QR labels
  offered at the end.
- **PRs** start from **＋ New PR** or bulk-select in Stock/Parts → **Create PR**. Vendor is per
  *line*. Lifecycle: pending → ordered → received.

### 4.3 The Sonar morning reports

Two auto-delivered CSVs (~6 AM): **⚡ Sonar** (serialized equipment) and **🧵 Fiber jobs**
(quantitative material). Same routine for both: open the sheet → **Review** the newest delivery →
glance at the mappings (most persist) → resolve anything red → **Apply** (one transfer per install,
crew truck → routed bucket).

💡 "Already imported" skips are a feature — the dedup guard working as intended.

### 4.4 Counting stock: two tools, pick by size

- **Focused area** — 🔢 **Cycle Count**, live with scanner/phone camera. Start a run, scan a bin QR,
  scan/type counts, submit the bin, move on. **None** records a zero in one tap; a submitted bin can
  be reopened until the run is ended.
- **Whole warehouse** — 🔍 **Audit** CSV → walk and fill in Actual Qty → upload via **Reconcile**.
  Each variance books as an adjustment (or a transfer when you know where the stock really
  came from/went).

Ending a count run pairs offsetting variances within the warehouse as internal transfers; net
gains/losses go to a manager review queue. **Bin distribution mode** turns counts into direct
warehouse→bin transfers — initial binning and fresh unbinned shipments.

### 4.5 Fixing mistakes

Movements are immutable. Fix with a **counter-movement**: Record movement → Transfer with reversed
endpoints and the same quantity, with a note saying what you're reversing and why. Both movements
stay in the trail — that's what accounting needs. **Adjust** is the only one-sided type, for stock
that must simply appear or vanish at one location.

### 4.6 Sage export & the cadence

**Sage export** → date range → review the preview (what exports, what's skipped, why) →
**Download CSV + mark X exported**. Exported movements are stamped so future exports skip them;
a toggle re-issues a rejected batch. Crew loads and returns (warehouse ↔ truck or group) are
skipped by default — they're staging, not consumption; a checkbox opts them back in.

| Cadence | What to do |
|---|---|
| Daily (5 min) | Scan Activity for 24h. Review + Apply Sonar and Fiber-jobs. Mark received arrived PRs. Check Found. |
| Weekly | Clean up draft parts (unit + department, bulk-activate). Chase stale Ordered PRs. |
| Monthly | Sage export. Cycle-count a section of the warehouse. |

### 🔧 Practice — lookups and safe dry-runs · ZERO IMPACT

- [ ] **Bin lookup:** Locations → warehouse → aisle → bin **Details**. What's in it?
- [ ] **Truck lookup:** Stock → filter to a crew member's truck.
- [ ] **Trace a movement:** Activity → last 24h → pick any row, explain aloud what happened.
- [ ] **Audit CSV:** Audit → small scope → Generate CSV. (Download only — changes nothing.)
- [ ] **PR dry-run:** ＋ New PR → fill a line → Save draft → reopen and **cancel** it.
- [ ] **Count dry-run:** Cycle Count → start a run → count one bin honestly → **discard the run**
  instead of ending it. (Discarding books nothing.)

**Do not** practice Receive PO or Reconcile with made-up numbers — both post real stock. Walk
through them on screen with a real delivery instead.

---

## Trainer's runbook & cleanup

There is no sandbox — training runs against the live app.

### Before

- Confirm every trainee has an account with the right access type and knows their first password.
- Create one practice task per crew trainee: `TRAINING – <name> – DELETE ME`, under any phase/site.
- Pick one cheap, plentiful part for the load/return exercise and tell trainees its name.
- Run the manager side live on a laptop — watching a flag arrive on their own phone is the moment
  the workflow clicks for crews.

### During — the three safety rules

1. **Never approve a training passdown.** Approval posts an irreversible truck → project transfer
   and bumps phase actuals. Flag instead — flagging moves no stock.
2. **Never practice Receive PO, Reconcile, or Record movement with made-up numbers.** All three
   post real stock. Demonstrate on screen, or wait for a real delivery.
3. **Keep practice quantities at 1** and always note `training — ignore`, so anything that slips
   through is easy to spot in Activity later.

### After — cleanup checklist

- [ ] Every TRAINING passdown is **flagged** (Submissions → Flagged filter) — none approved.
- [ ] Every `TRAINING – … – DELETE ME` task is **deleted** in Projects (cascades sessions, entries,
  submissions).
- [ ] Practice found-inventory reports **rejected** in Inventory → Found (reason: `training`).
- [ ] Practice cycle-count runs **discarded**, not ended.
- [ ] Practice PR drafts **cancelled**.
- [ ] Trainees' trucks show **zero** of the practice part (Stock → filter by truck).
- [ ] Skim Activity for the session window — any stray movement gets a counter-movement noted
  `training reversal`.

---

## Quick reference

### The six movement types

| Type | Meaning | Example |
|---|---|---|
| Receive | New stock arrives | Vendor delivery into a warehouse |
| Transfer | Stock moves between two locations | Warehouse → truck (load); truck → bucket (consumption) |
| Return | Stock comes back to a warehouse | Truck → warehouse at end of day |
| Issue | Stock leaves the system | Consumed with no FiberLog destination |
| Scrap | Damaged stock written off | Broken router, with a reason |
| Adjust | Count correction (one-sided) | "Counted 50, system said 52 → −2" |

### Who to ask

- **App trouble, passwords, wrong data** — Chris (or your manager).
- **Which kit to use, what parts to grab** — your lead crew member.
- **The app** — https://criddell-blip.github.io/fiberlog/ (phone, tablet, laptop; crew logging
  auto-saves, so a dropped signal loses nothing).

---

*Created August 2026, from the July 2026 guides. When the source guides change, update this and the
web version together.*
