# Inventory tab — a walk-through

This is the manager portal's home for everything inventory. If you've never used FiberLog before, start here.

> Looking for the end-to-end story (vendor → warehouse → truck → project → Sage)? See **[INVENTORY_FLOW.md](./INVENTORY_FLOW.md)**.
> Looking for the manager portal at large? See **[MANAGER_GUIDE.md](./MANAGER_GUIDE.md)**.

Last updated: 2026-06-17.

---

## What is the Inventory tab for?

This tab is where you answer questions about stock, record what happened to stock, and export the record for accounting. Everything material — what we have, where it is, who has it, where it went — lives here. There is no other source of truth.

You'll use it in three modes:

- **Looking things up** — "what does Edgar have on his truck?", "do we have any more bullet connectors?", "where did that drum of cable end up?"
- **Recording activity** — receiving a vendor delivery, applying a daily Sonar install report, fixing a count, scrapping damaged stock
- **Exporting** — Sage every period, audit CSVs for cycle counts, BEAD reporting later

You don't have to think about cycle counts or imports on day one. Most of what you do will be looking things up and confirming activity is being recorded correctly by crews and auto-processes.

---

## The mental model

Three concepts. Once you've got these, the rest is just buttons.

### 1. Parts

A **part** is anything we stock. Bullet fiber connectors, GigaSpire routers, drums of 144ct cable, ladders, ground rods.

Each part has a SKU (a unique code, often from BoxHero), a name, a unit (`ea` for things you count, `ft` for things you measure), and category metadata (department + material group).

You'll find these in the **🔧 Parts** sub-tab.

### 2. Locations

A **location** is anywhere stock can sit. There are five types:

- **Warehouses** — the buildings (Main Warehouse, Fiber product, etc.)
- **Bins** — sub-locations *inside* a warehouse (Aisle 2 Shelf B-3, etc.). A bin always belongs to one warehouse.
- **Trucks** — one per crew member. Each fiber/infra/install crew member automatically gets a personal truck when their user is created. There are also shared trailers (Aerial Crew trailer, Contractor - RNS, etc.).
- **Project buckets** — one per active project (Heber, Wasatch Front, Gigwave, etc.). These are *not* drained — they are the permanent ledger of what was consumed on that project. Sage exports pull from them.
- **Vendor / scrap** — rarely used. Vendor is the "from" side of a receipt; scrap is where damaged stock goes.

You'll find these in the **🏭 Locations** sub-tab.

### 3. Movements

A **movement** is the only way stock changes. There are six types:

| Type | What it means | Example |
|---|---|---|
| Receive | New stock arrives | Vendor delivery into a warehouse |
| Transfer | Stock moves between two locations | Warehouse → truck (a "load") |
| Return | Stock comes back to a warehouse | Truck → warehouse end of day |
| Issue | Stock leaves the system (used) | Truck → nowhere (consumed on a job) |
| Scrap | Damaged stock removed | Truck → nowhere with a reason |
| Adjust | Count correction | "We had 50, system said 52, so −2" |

When a movement is recorded, the system automatically updates the on-hand quantity at each affected location. **You don't update stock counts directly — you record what happened, and stock updates itself.** This is the most important thing to internalize. There is no "edit stock count" button; if a count is wrong, you record an adjust movement.

You'll see every movement that's ever happened in the **📜 Activity** sub-tab.

That's the whole model. Parts live at Locations, change via Movements.

---

## What you see when you open the tab

The top of the tab has two rows:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  📦 Inventory   ⇪  📥  🔄  ⚡  🧵  🧾   [+ Record movement]              │
├─────────────────────────────────────────────────────────────────────────┤
│  📦 Stock  🏭 Locations  🔧 Parts  📜 Activity  📋 PRs  🔍 Audit  🔢 Count │
└─────────────────────────────────────────────────────────────────────────┘
```

**The bottom row is what you're looking at** — seven different windows into the inventory state. Pick one.

**The top row is what you're doing** — buttons that change something or export the record. Each opens a sheet that walks you through it.

### The seven sub-tabs (looking things up)

| Tab | The question it answers |
|---|---|
| 📦 **Stock** | "What's where right now?" Quantities per part per location. The most-used tab. |
| 🏭 **Locations** | "What warehouses / bins / trucks / projects do we have?" Manage them here. |
| 🔧 **Parts** | "What's in our catalog? Are there draft parts I need to clean up?" |
| 📜 **Activity** | "What just happened?" Every movement, ever, with filters. |
| 📋 **PRs** | Purchase Requests — originate, track, mark received. The queue between "we need this" and "it arrived". |
| 🔍 **Audit** | Generates a CSV for walking the warehouse and physically counting. |
| 🔢 **Count** | Live scanner-based cycle counting. Faster than the audit-CSV flow. |

### The seven action buttons (changing something)

| Button | What it does |
|---|---|
| ＋ **Record movement** | Manual one-off entry — transfer (default) / return / issue / scrap / adjust. Receiving is deliberately NOT offered here; vendor deliveries go through **Receive PO** so every receipt carries vendor + cost metadata. The primary button. |
| ⇪ **Import CSV** | Bulk import from BoxHero (catalog seed or top-up) |
| 📥 **Receive PO** | Vendor delivery — multi-line, creates `receive` movements |
| 🔄 **Reconcile** | Upload a filled audit CSV — turns variances into adjust movements |
| ⚡ **Sonar** (assets) | Apply Sonar's daily report for serialized equipment installs (routers, ONTs, etc.) |
| 🧵 **Fiber jobs** | Apply Sonar's daily fiber-jobs report (pushable cable, drops, ONT boxes, etc.) |
| 🧾 **Sage export** | Build the Sage CSV for the period and mark movements as exported |

On a phone, every button except **＋ Record movement** collapses behind a **⋯ More** menu — the primary action stays out in the open.

---

## The most common things you'll do

Each section below is a walk-through. The first time you do one, follow it step by step.

### Find what's in a particular bin

1. Open **🏭 Locations**
2. Find the warehouse — click the row to expand
3. Find the aisle group — click to expand
4. Find the bin — click **📋 Details**

You'll see every part in that bin and how many. From there you can drill into the count flow, export the bin's contents as a CSV, print labels, or edit the bin's name.

### Find what's on a specific truck

1. Open **📦 Stock**
2. Filter by **Location** → pick the crew member's truck
3. (Optional) search by SKU to narrow further

If the truck shows stock that doesn't match what the crew member says they have, that's normal-ish — it means there are movements they haven't recorded yet (still loading, or returns from yesterday they haven't entered). If it's wildly off, plan a cycle count of their truck.

### Originate a Purchase Request

PRs are how a need ("we're out of bullet connectors", "Edgar wants another splice kit") becomes an order. The PR feature replaces the spreadsheet-emailed-to-purchasing workflow.

There are three ways to start one:

- **From the PRs sub-tab** → click **＋ New PR**. Best when you're starting from scratch.
- **From the Stock tab** → bulk-select some rows → click **📋 Create PR**. Best when you're already looking at "what we're low on" and want to pre-fill the PR with those parts.
- **From the Parts tab** → same bulk-select → **📋 Create PR**. Best when you're picking from the catalog rather than from current stock.

Then in the composition sheet:

1. Fill the header — title, requested-by, requested-for (department or project)
2. For each line: vendor, qty, item number, description, project/reason, unit price, line total. Vendor is **per line** (not per PR) because one PR often spans multiple suppliers.
3. Save with one of four options:
   - **Save draft** — keeps it in your queue, no export
   - **Save & CSV** — saves and downloads a CSV (the same shape as the old spreadsheet)
   - **Save & PDF** — saves and opens a print-ready PDF
   - **Save & copy email** — saves and copies a pre-formatted email body to your clipboard, ready to paste

The PR lands in the **📋 PRs** sub-tab with status **pending**. When purchasing places the order, change it to **ordered**. When the delivery arrives, open the PR and click **Mark received** — this writes the receive movements for you (no need to re-enter the parts via Receive PO). The PR moves to **received**.

The PRs sub-tab has filter pills: **All / Active / Pending / Ordered / Received / Cancelled**. Default is **Active** (pending + ordered) so you see what's in motion.

### Receive a vendor delivery

This is one of your most common tasks. Two flows depending on whether the delivery has a PR backing it:

- **Has a PR**: open the PR in the **📋 PRs** tab → click **Mark received**. Done — receive movements are written automatically.
- **No PR (vendor just showed up)**: use the **📥 Receive PO** sheet manually, walked through below.

**Manual Receive PO walkthrough:**

1. Click **📥 Receive PO**
2. Fill the header: **Vendor**, **Invoice number**, **Destination warehouse**
3. For each line:
   - Search for the SKU — pick the part
   - Enter quantity, unit (auto-fills from the part), and unit cost if you have it
   - If the part doesn't exist in the catalog yet: type its SKU and click the "+ create" affordance that appears. A draft part is created on the spot.
4. Click **Save** when done
5. The sheet will offer to print labels for any new SKUs — accept if you want fresh QR labels on the boxes

What this does:
- Creates one `receive` movement per line (NULL → destination warehouse)
- Stock at the destination warehouse goes up automatically
- All lines share the same `vendor_invoice`, so the Activity tab will group them

**If you typed a new SKU and want to use it again later in the same PO**, close and reopen the sheet — the search index doesn't refresh mid-session. Cosmetic, not data-losing.

### Handle a Sonar daily report

Sonar pushes two CSVs every morning around 6 AM — one for **serialized equipment** (routers, ONTs, etc.) and one for **fiber jobs** (pushable cable, drops, splice trays). You'll see each at the top of its respective sheet as "📥 Auto-delivered from Sonar".

**Why two sheets?** The two reports describe different kinds of work and need different mappings:

- **⚡ Sonar (assets)** — serial-number-tracked equipment that lands at a customer address. One row per device.
- **🧵 Fiber jobs** — quantitative material consumption (linear feet of cable, count of drops, etc.) that doesn't have serial numbers. One row per job, with material parsed from descriptive columns.

The walkthrough is the same for both:

1. Click **⚡ Sonar** (or **🧵 Fiber jobs**)
2. Find the day you want in the auto-delivered list (newest at top)
3. Click **Review** on that row — the import preview loads
4. Confirm the mapping sections (most are persisted from past imports, so usually just glance):
   - **Crew mappings** — Sonar's "Source" → a FiberLog user
   - **Part mappings + routing** — Sonar's model/description → a FiberLog SKU + where consumption lands (region-based, gigwave, none, or ask each time)
   - **Sonar project mappings** — Sonar's Project column → a FiberLog phase
5. Scroll the preview rows — anything in red needs a decision before you can apply
6. Click **Apply** at the bottom

What this does:
- Creates one `transfer` movement per applied row (crew member's truck → the project bucket)
- Stamps `phase_id` so Sage knows which cost center each consumption belongs to
- Marks the delivery as imported (won't re-import the same rows later)

Skipped rows happen for two reasons: rows that duplicate something already imported (the `[sonar:<itemId>]` marker is how we detect this) and rows without enough info to route. The preview tells you which is which.

There's also a **📦 Bulk-add Sonar projects** button inside the assets sheet for the rare case Sonar introduces new project names — it pre-fills mappings in bulk instead of one-at-a-time. You won't reach for it often.

### Run a cycle count

There are two ways to count stock physically. Pick by warehouse size:

- **Small (a few bins, focused area)**: use the **🔢 Count** tab live with a scanner or phone camera
- **Large (whole warehouse)**: use the **🔍 Audit** tab to generate a CSV, walk the warehouse with a tablet/clipboard, then upload via **🔄 Reconcile**

**Live count walkthrough:**

1. Open **🔢 Count** → **Start a new run**
2. Pick the warehouse (or leave blank for cross-warehouse)
3. Open it on a phone with the camera scanner
4. Scan a bin QR label — the session opens for that bin showing expected parts + counts
5. For each part: scan the part QR (each scan = +1) or type the count manually. If you see something not on the expected list, scan or type it — it adds as an "unexpected" line.
6. Submit the bin → move to the next
7. When you're done with all bins, end the run. The system pairs offsetting variances within the warehouse (e.g. found 2 extra of Part X in Bin A, missing 2 of Part X from Bin B → that's a within-warehouse transfer, no real loss). Leftover variances go to a manager-review queue.

There's also a **"Bin distribution mode"** for the case where stock currently sits at the warehouse-level (unbinned) and you're sorting it into specific bins as you count. Counts become direct transfers from warehouse → bin, no variances. Use it for initial bin setup and any time a fresh shipment lands unbinned and needs to be distributed.

### Reconcile a paper count (the CSV round-trip)

1. Open **🔍 Audit**
2. Pick scope: warehouse, optional bin/department/material-group filters
3. Click **Generate CSV** — downloads a file with each part + system qty + an empty "Actual Qty" column + a Variance formula
4. Walk the warehouse, fill in Actual Qty (paper or tablet)
5. Back in the office, click **🔄 Reconcile**
6. Upload the filled CSV
7. The preview shows per-location variance counts. Confirm.
8. Click **Apply** → one `adjust` movement per non-zero variance

### Add a part that doesn't exist yet

Two ways:

- **During a Receive PO** — type the SKU, click the "+ create" affordance. Fastest if you're already receiving it.
- **Directly in the catalog** — **🔧 Parts** sub-tab → **+ Add part**. Fill SKU, name, unit, department, material group. Use this when you need the part to exist for some other reason (e.g. setting up an assembly).

When parts auto-appear from CSV imports or webhook deliveries, they're created as **drafts** (`is_active=false`) with minimal metadata. You'll want to periodically open the Parts tab, filter by "Drafts", and clean them up: set unit (`ft` for cable, `ea` for things you count), set department, then bulk-activate.

### Fix a wrong movement

Movements are **immutable** — there's no edit or delete button. If a movement is wrong, you create a counter-movement that cancels it out.

Example: someone accidentally recorded a transfer of 50 connectors warehouse → Edgar's truck, but Edgar didn't actually load them.

1. Click **+ Record movement** → pick **Transfer**
2. From: Edgar's truck. To: original warehouse. Quantity: 50.
3. In the notes, write something like "Reversing mistake from movement <id> — Edgar did not actually load these."
4. Save.

Net effect: stock returns to the warehouse. The original wrong movement is still in the audit trail (good — that's what we want), but it's been compensated for. If Sage is asked, both movements appear and cancel.

For one-off correction movements between locations you don't normally connect, you can also use **Record movement** with the **Adjust** type — adjust is the only type that goes one-sided (from-only or to-only), which is useful when stock simply needs to vanish or appear at one location with no counterpart.

### Export for Sage at end of period

1. Click **🧾 Sage export**
2. Pick the date range (defaults to the last 7 days)
3. Decide whether to use **strict-consumption mode**:
   - **Off (default)**: includes everything Sage cares about — project consumption, scrap, returns, inter-warehouse transfers. Excludes **receipts** (POs are received directly into Sage, so exporting them again would double-count the purchase; FiberLog keeps them as the provenance record), count corrections (adjusts), and internal truck-to-truck / warehouse-internal transfers.
   - **On**: also excludes crew loads and returns (warehouse ↔ truck staging). Use this if Sage doesn't want to see staging activity, only true consumption.
4. Review the preview — it tells you how many movements will export and how many are being skipped, with the reason
5. Click **Download CSV + mark X exported**
6. Send the CSV to accounting (or upload to Sage Intacct directly)

What this does:
- Stamps every included movement with `exported_at` + a batch ID
- Future exports skip already-exported movements automatically
- If you need to re-issue a corrected batch, there's a toggle for "Include already exported"

### Decommission a location (retire a bin, scrap a truck, etc.)

Locations are never hard-deleted — they're referenced by every movement that touched them, and we want the audit trail intact forever.

1. Open **🏭 Locations** → find the row
2. Click **🛑 Retire**
3. If there's any stock currently at that location, the sheet prompts you to recover it: pick a destination for each part with stock, and one `transfer` movement is created per part. The location then becomes inactive.
4. Confirm.

Decommissioned locations stop appearing in pickers but stay in Activity history and in past Sage exports.

---

## Cadence — what to do daily / weekly / monthly

### Daily (5 minutes)

- Open **📜 Activity**, scan the last 24 hours. Anything weird? Auto-deducts that don't make sense? Movements with empty notes from accounts that shouldn't be writing?
- Check **⚡ Sonar** and **🧵 Fiber jobs** for the morning's auto-delivered reports. Click **Review**, confirm mappings, **Apply**.
- Check the **📋 PRs** tab (Active filter) for anything that arrived overnight — click **Mark received** so the parts land in stock.

### Weekly

- Address any drafts piling up in **🔧 Parts** → Drafts filter — set unit + department, bulk-activate.
- Glance at **📋 PRs** (Ordered filter) to see what's outstanding. Anything stale should get a follow-up with purchasing.
- If your team uses **Receive PO** heavily, glance at the catalog for SKUs without department/material group set and clean them up.

### Monthly

- Run **🧾 Sage export** for the period. Send to accounting.
- Pick a section of the warehouse and run a **🔢 Count** (or **🔍 Audit** + **🔄 Reconcile** for a bigger area).
- Check **🏭 Locations** for any bin/aisle that's gotten unwieldy — split or consolidate as needed.

### Once a quarter / one-time

- BoxHero catalog re-sync: open **⇪ Import CSV** (on phone: **⋯ More → ⇪ Import CSV**), upload the BoxHero export, set all Qty columns to "skip". This catches new SKUs without touching stock.
- Reprint bin labels for areas that have been relabeled.

---

## Things to know before you act

Short list of "this will trip you up if you didn't know it." Not gotchas — just system facts that aren't obvious from the UI.

- **Stock follows movements automatically.** You never edit stock numbers directly. To change stock, record a movement.
- **Movements can't be edited or deleted.** If you make a mistake, create a counter-movement. This is on purpose — the audit trail must be inviolate for Sage and BEAD reporting.
- **Bins can't be nested.** A bin lives inside one warehouse — bins can't contain other bins. Encode shelf depth in the bin name ("Aisle 5, Rack 2, Shelf C").
- **A SKU can't be renamed.** Once a part is in the catalog, its SKU is permanent (because every past movement references it). If a SKU is wrong, retire it and create a new one with the right SKU.
- **`category` is auto-computed** from department + material group. Don't try to edit category directly — edit department or material group and category updates itself.
- **Sonar imports dedupe by item ID.** Both Sonar sheets (assets and fiber jobs) collapse duplicates within a delivery and refuse to re-import the same item ID across deliveries (90-day window). The Sonar daily report often emits the same install multiple times at different aggregation levels — that's why dedup is necessary. If you ever see "already imported" rows, that's working as intended.
- **Project buckets are the permanent record.** When materials transfer to a project bucket (Heber, Wasatch Front, etc.), they don't get "drained" out by anything. The bucket is the consumption ledger — that's what Sage and BEAD pull from.
- **Crews don't see your changes in real time.** If you apply a Sonar import or a Reconcile, the affected crew member's "My stock" view won't update until they pull-to-refresh. This is rare friction; if it matters, send a text.

---

## Permissions: what you can do depends on your role

- **Owner / Manager** — full access to the Inventory tab and everything in it.
- **Warehouse-only manager** (a Manager with the "Warehouse-only" flag set) — sees ONLY the Inventory tab. No Approvals, no Reports, no Crew status. Use this for an inventory clerk who doesn't approve crew passdowns.
- **Crew** — does not see this tab at all. Crew interact with inventory through the **Load** and **Return** flows on their own truck, and via passdown submissions that auto-deduct after manager approval.

To make someone warehouse-only: **Admin → Users → edit user → check "📦 Warehouse-only manager"** (only visible when their role is Manager).

---

## When something goes wrong

Most issues fall into three buckets:

1. **"Stock doesn't match physical reality"** — run a cycle count (Live or CSV round-trip). Variances become `adjust` movements, system catches up to reality.
2. **"A movement was recorded wrong"** — create a counter-movement (see "Fix a wrong movement" above). The wrong one stays in the audit trail; that's correct.
3. **"Sonar import skipped a row I think it should have imported"** — open the relevant Sonar sheet's "▸ Show recent deliveries (audit)" panel. It tells you whether the row's item ID was duplicated, whether it was already imported in a prior delivery, or whether routing was unmapped. Each has a different fix.

For anything else, **📜 Activity** is the first place to look. Filter by date, location, or user; you'll usually find the moment things diverged from what you expected.

---

## Cross-references

- End-to-end material flow (vendor → warehouse → truck → project → Sage): **[INVENTORY_FLOW.md](./INVENTORY_FLOW.md)**
- Crew side of inventory (Load, Return, MyStock): **[CREW_GUIDE.md](./CREW_GUIDE.md)**
- Manager portal at large: **[MANAGER_GUIDE.md](./MANAGER_GUIDE.md)**
- Database internals (tables, RPCs, triggers, RLS): see **CLAUDE.md** in the repo root — "Database schema highlights" and "Database RPCs" sections
