# FiberLog — Inventory Tab Reference

Deep dive on every component inside Manager portal → **📦 Inventory**: what each does, when to reach for it, how they fit together end-to-end.

> Companion docs: **[INVENTORY_FLOW.md](./INVENTORY_FLOW.md)** (the ledger from vendor → Sage) · **[MANAGER_GUIDE.md](./MANAGER_GUIDE.md)** (manager portal overview) · **[CREW_GUIDE.md](./CREW_GUIDE.md)** (crew side).

Last updated: 2026-06-01.

---

## At a glance

The Inventory tab is the manager's command center for everything stock-related. Layout:

```
┌─────────────────────────────────────────────────────────────────────┐
│  📦 Inventory          [+ Record movement]  📥  🔄  ⚡  🧾  [⋯ More] │
├─────────────────────────────────────────────────────────────────────┤
│  📦 Stock  🏭 Locations  🔧 Parts  📜 Activity  🔍 Audit  🔢 Count  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                       (sub-tab content)                             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- **Sub-tabs (6)**: read views into the inventory state — Stock, Locations, Parts, Activity, Audit, Count
- **Header buttons (7)**: action sheets that write new movements or export data — Record movement, Receive PO, Reconcile, Sonar import, Sage export, Import CSV, Bulk-add Sonar projects
- **Mobile**: secondary actions collapse behind a `⋯ More` popover; primary `+ Record movement` stays inline

Restricted-to-inventory managers (warehouse-only) see ONLY this tab. See [Permissions](#permissions) below.

---

## The 6 sub-tabs

### 📦 Stock

Source: [InventoryStockTab.jsx](../src/components/manager/InventoryStockTab.jsx)

**Purpose**: "What's where right now?" The canonical view of on-hand quantities per (part, location).

**What you see**:
- Filterable table of `inventory_stock` rows: SKU, name, location, qty, unit
- Filter controls: location picker (warehouse / bin / truck / job_site), search by SKU/name, type filter (truck only, bucket only, etc.)
- Warehouse "rollup" mode aggregates bin-level stock under the parent warehouse; drill into a specific bin or "Unbinned" for bin-level granularity

**Common actions**:
- Click a row → bulk-select for moving (use the Bulk Move sheet that opens)
- Tap a column header → sort
- **🏷 Labels** → opens [SkuLabelSheet](#sku-label-sheet) seeded with the selected parts

**Gotchas**:
- **Bins as audit sources for bulk-move**: bulk-select is disabled in warehouse rollup mode because the source bin is ambiguous. Drill into a specific bin or "Unbinned" first.
- Stock is derived from `inventory_movements` via the `update_inventory_stock_on_movement` trigger. If movements get manipulated outside the normal path (rare), stock can drift — Reconcile fixes that.
- No realtime subscription on `inventory_stock` — when a manager applies a Sonar import or auto-deduct, crew screens (MyStockView) won't see the change until manual refresh.

### 🏭 Locations

Source: [InventoryLocationsTab.jsx](../src/components/manager/InventoryLocationsTab.jsx)

**Purpose**: Add/edit warehouses, bins, trucks, and project buckets. Per-location detail drill-in.

**What you see**:
- Grouped list: Warehouses (with bin counts) · Trucks (assigned to crew) · Job-site buckets (per project) · Vendors / Scrap (rare)
- Per-warehouse expansion shows the bins underneath
- Each row has buttons: **📋 Details**, **🏷 Labels**, **+ Add bin** (warehouses only), **✏ Edit**, **🛑 Retire**

**Common actions**:
- **+ Add warehouse**: top-of-section button. Single name field.
- **+ Add bin**: appears under each warehouse row. Bin form has an **aisle picker** (existing aisles pre-fill, or type a new one) + a **shelf** field. Name displays as "Aisle 2, Shelf B-3".
- **📋 Details** → opens [Location detail panel](#location-detail-panel) with stock, count, export, label actions
- **🏷 Labels** on a warehouse → opens [BinLabelSheet](#bin-label-sheet) for all bins under that warehouse
- **Aisle signs** → big-print full-page signs auto-parsed from bin names ("Aisle 4" sign at 180pt with bay range sub-line). Source: [AisleSignSheet.jsx](../src/components/manager/AisleSignSheet.jsx)

**Constraints**:
- **Single-level nesting only**: bins can't contain sub-bins. Encode deep shelving in the bin name ("Aisle 5, Rack 2, Shelf C").
- A bin's `parent_location_id` must point to a `type='warehouse'` row. Enforced by trigger `trg_inv_location_validate_parent`.
- Locations are FK targets for inventory_movements — never hard-deleted. Use **🛑 Retire** (sets `is_active=false`).

### 🔧 Parts

Source: [InventoryPartsTab.jsx](../src/components/manager/InventoryPartsTab.jsx)

**Purpose**: Browse and edit the parts catalog. Bulk operations for category/department cleanup.

**What you see**:
- Filterable table: SKU, name, unit, department, material group, status (active/draft)
- **Drafts** sub-filter: parts auto-created with `is_active=false` by CSV imports or Receive PO when an unknown SKU shows up. These need metadata cleanup before they show up everywhere else.
- Bulk-select rows → bulk-edit department / material group / unit / activate
- **🏷 Labels** button → opens [SkuLabelSheet](#sku-label-sheet) for the selected parts

**Common actions**:
- **+ Add part** (one-off): a SKU you typed that doesn't exist yet
- **Bulk activate drafts**: select all drafts → "Activate"
- **Edit a part**: name, unit, department, material group, barcode, BoxHero ID. `category` is computed from `department + material_group` — don't edit it directly.

**Gotcha**: `parts_catalog.id` is the SKU itself (text PK). You can't rename a SKU after creation without breaking every movement that references it. If a SKU is wrong, retire it (`is_active=false`) and create a new one.

### 📜 Activity

Source: [InventoryMovementsTab.jsx](../src/components/manager/InventoryMovementsTab.jsx)

**Purpose**: Audit log of every inventory_movement. The system's chronological ledger.

**What you see**:
- Reverse-chronological list: timestamp, type, part, qty, from → to, who, notes
- Filters: date range, movement type, location, part, user
- Each row shows the rich identifiers: `task_id`, `submission_id`, `consumed_by_user_id`, `phase_id`, `export_batch_id` — visible when relevant

**Common actions**:
- Verify a recent auto-deduct landed correctly
- Trace consumption back to a specific submission or task
- Confirm a Sonar import or Receive PO before approving the next batch

**Gotcha**: movements are **immutable**. There's no edit/delete. The `prevent_movement_modification` + `prevent_movement_delete` triggers enforce this. If a movement is wrong, create a counter-movement (e.g., a `transfer` back).

### 🔍 Audit

Source: [InventoryAuditTab.jsx](../src/components/manager/InventoryAuditTab.jsx)

**Purpose**: Generate audit CSVs for physical-count round-trips. Pairs with the [Reconcile sheet](#-reconcile).

**What you see**:
- Scope picker: which warehouse(s), which bins, which part filters (department, material group, stock level, staleness)
- Preview of how many rows the CSV would contain
- **Generate CSV** button → downloads a CSV with a blank `Actual Qty` column and a `Variance = =J<row>-I<row>` formula in the Variance column

**Workflow**:
1. Generate CSV here
2. Print or load on tablet, walk the warehouse, fill in `Actual Qty`
3. Upload via [Reconcile sheet](#-reconcile) to apply `adjust` movements

**Gotcha**: the round-trip uses location **names**, not IDs. Two trucks with the same first name (rare) would collide. Warning only, not blocker.

### 🔢 Count

Source: [CountTab.jsx](../src/components/cycleCount/CountTab.jsx)

**Purpose**: Live cycle counting via scanner or phone camera. Pairs of variances auto-reconcile within a warehouse; leftovers go to manager review.

**What you see**:
- **Start a new run** button + list of pending-review runs + completed history
- A run scopes the count to a single warehouse (or cross-warehouse) and an optional "First-binning mode" for the one-time warehouse → bin stock migration

**Workflow**:
1. Counter starts a run → opens [CountRunScreen](../src/components/cycleCount/CountRunScreen.jsx)
2. Scans a bin QR (`BIN:<uuid>`) → session opens for that bin
3. Scans part QRs (each scan = +1 qty) or picks parts from a search; can also create new SKUs inline if the warehouse surfaces a part not yet in the catalog
4. Submits each bin session → counter sees variances per part (expected vs counted)
5. End of run → `end_count_run_and_reconcile` RPC:
   - Pairs offsetting variances within the warehouse as internal `transfer` movements
   - Leftovers go to `count_resolutions` for manager review

**First-binning mode**: special flag for the initial migration. Counts become direct warehouse → bin transfers instead of variance reconciliation. One-time, no review queue.

**Gotcha**: cycle count writes `inventory_movements` with `count_run_id` set, which links those movements back to the originating run. If you delete a count run, you must clear `count_resolutions` first (FK chain).

---

## The 7 action sheets

These all live in the header. On desktop they spread across the action bar; on mobile, secondary actions collapse behind `⋯ More`.

### ➕ Record movement

Source: [RecordMovementSheet.jsx](../src/components/manager/RecordMovementSheet.jsx)

**Purpose**: One-off manual movement. Covers all 6 movement types.

**When to use**: ad-hoc adjustments. Stock moved between bins manually. Scrap when something's broken. Manual issue when no other path fits. Not the right tool for bulk operations — use Bulk Move or Reconcile instead.

**Permissions**: staff-only; no per-user permission filter applied (those gate crew-initiated movements via the `record_crew_movement` RPC, which this sheet bypasses).

**Movement-type validation**: the `validateMovement()` helper in `lib/inventory.js` mirrors the DB's `movement_endpoints_valid` CHECK constraint, so bad from/to combinations fail fast with a friendly error.

### 📥 Receive PO

Source: [ReceivePOSheet.jsx](../src/components/manager/ReceivePOSheet.jsx)

**Purpose**: Multi-line vendor delivery. Creates `receive` movements: NULL → warehouse/bin.

**Workflow**:
1. Vendor name + invoice ref + destination warehouse
2. Per-line: SKU + qty + unit + unit_cost
3. Inline part creation: if a SKU doesn't exist, type it and a "create + add" affordance appears. Auto `is_active=true`.
4. Submit → one `receive` movement per line, all sharing the same `vendor_invoice`
5. Post-save: prompt to print labels for the newly-received parts via [SkuLabelSheet](#sku-label-sheet)

**Gotcha**: inline-create doesn't refresh the catalog search index in the same session. If you create a new SKU then type it again in a later line of the same PO, the autocomplete won't find it. Workaround: close and reopen the sheet.

### 🔄 Reconcile

Source: [ReconcileSheet.jsx](../src/components/manager/ReconcileSheet.jsx)

**Purpose**: Apply the audit CSV round-trip — turn physical counts into `adjust` movements.

**Workflow**:
1. Upload the filled-in audit CSV (from the [Audit tab](#-audit))
2. System computes `Actual - System = Variance` per row
3. Preview shows per-location variance counts + total adjustment quantity
4. Confirm → one `adjust` movement per variance row (positive = "found more", negative = "missing")

**Pairing**: this is the standard go-live + monthly cleanup tool. Pre go-live: generate audit CSV with no system stock, walk warehouse, upload to seed opening balances. Monthly: same flow to true-up drift.

### ⚡ Sonar import

Source: [SonarImportSheet.jsx](../src/components/manager/SonarImportSheet.jsx)

**Purpose**: Apply Sonar's daily install report. Creates `transfer` movements: crew truck → project bucket, with `phase_id` stamped for Sage cost-center grouping.

**Pending deliveries banner**: webhook-delivered reports (from the `sonar-webhook` edge function) show up at the top as "📥 Auto-delivered from Sonar". Tap **Review** to load one as if uploaded manually.

**Workflow**:
1. Manual upload OR click a pending delivery
2. Manage three mapping sections (each persisted across imports):
   - **Crew mappings**: Sonar source → FiberLog user (auto-matched by name in parens)
   - **Part mappings + routing policy**: Sonar model → FiberLog SKU + routing (`region` / `gigwave` / `none` / `ask`)
   - **Sonar project mappings**: Sonar Project column → FiberLog phase (saved to `sonar_project_phase_map`). When set, this overrides part-level routing.
3. **Intra-delivery dedup**: rows sharing the same item ID in `Model Field Data | Value List` collapse into one (Looker emits each install at multiple aggregation levels). Each preview row shows `× N` when duplicates were collapsed.
4. **Inter-delivery dedup**: rows whose `[sonar:<itemId>]` marker already exists in `inventory_movements.notes` (last 90 days) flag as `already-imported` (gray pill, skipped).
5. **Audit panel**: toggle "▸ Show recent webhook deliveries (audit)" to see processed + auto-discarded deliveries. Useful for confirming Sonar's nightly push actually fired.
6. Submit → one `transfer` movement per ready row + the pending row marks itself imported

Bonus button at the top: **📦 Bulk-add projects** opens [BulkSonarProjectsSheet](#-bulk-add-sonar-projects).

### 🧾 Sage export

Source: [SageExportSheet.jsx](../src/components/manager/SageExportSheet.jsx)

**Purpose**: Build the Sage Intacct Inventory Transactions CSV and mark movements exported.

**Workflow**:
1. Pick date range (default: last 7 days)
2. Toggle "Include already exported" if re-issuing a corrected batch
3. Preview shows movements that'll export — skips `truck → truck` (internal staging, no Sage relevance)
4. Stats summarize counts by movement type
5. Click **Download CSV + mark X exported**:
   - Inserts a parent row in `inventory_export_batches` capturing `exported_by` + `movement_count`
   - Updates every included movement's `exported_at` + `export_batch_id`
   - Builds the CSV and triggers browser download

**CSV columns** (18, in this order): `TRANSACTIONTYPE, DATE, REFERENCENO, LINE, ITEMID, ITEMDESC, QUANTITY, UNIT, PRICE, FROM_WAREHOUSE, TO_WAREHOUSE, TO_BIN, PROJECTID, CLASSID, DEPARTMENTID, VENDORID, MEMO, FIBERLOG_MOVEMENT_ID`.

- `PROJECTID` = phase's parent project (Heber, Park City, etc.)
- `CLASSID` = phase name (Center Creek, Snyderville, etc.)
- `FIBERLOG_MOVEMENT_ID` = `inventory_movements.id`, kept so Sage's audit can back-reference any line

Next export skips already-exported movements automatically via the partial index `WHERE exported_at IS NULL`.

### ⇪ Import CSV (BoxHero seed)

Source: [InventoryImportSheet.jsx](../src/components/manager/InventoryImportSheet.jsx)

**Purpose**: Bulk-import from BoxHero's CSV export. Used for initial parts catalog seeding AND for post-seed catalog top-ups when BoxHero gets new SKUs.

**Workflow**:
1. Upload BoxHero CSV — file picker auto-detects the per-location quantity columns (`Qty(<location>)`)
2. Stage 1 (parse): catalog index built; unmatched SKUs (in CSV but NOT in `parts_catalog`) flagged
3. Stage 2 (mapping): per-Qty-column picker — map to existing FiberLog location OR set to "skip"
4. **Auto-create drafts** toggle: creates unmatched SKUs as `is_active=false` so the import succeeds. Manager cleans them up in the [Parts tab](#-parts) afterward.
5. Stage 3 (import): one `adjust` movement per row+column combo OR drafts-only if all columns skipped

**Catalog-only sync mode**: set every Qty column to "skip" to use this just as a parts catalog sync (catches new SKUs, doesn't touch stock). Useful for periodic re-imports against the current BoxHero list.

**Gotcha**: inline-create during the same session doesn't refresh the catalog search. Same pattern as Receive PO.

### 📦 Bulk-add Sonar projects

Source: [BulkSonarProjectsSheet.jsx](../src/components/manager/BulkSonarProjectsSheet.jsx)

**Purpose**: Bootstrap (or top-up) the `sonar_project_phase_map` from a Sonar project list. Triggered from a button inside [SonarImportSheet](#-sonar-import).

**Workflow**:
1. Paste or upload a CSV with a `Project` column
2. Auto-suggestions: exact phase-name match → "auto-picked" status. Contains-either-way match → suggested.
3. Already-mapped Sonar projects show as "already mapped" (skipped by default)
4. **Assign all pending to…** shortcut for bulk same-region picks
5. Submit → creates phases under picked regions + upserts `sonar_project_phase_map` entries

**Bonus**: same UI will eventually serve as the review queue for a weekly Sonar projects webhook (when set up — see `sonar-webhook` pattern).

### 🛠 Bulk move

Source: [BulkMoveSheet.jsx](../src/components/manager/BulkMoveSheet.jsx)

**Purpose**: Move multiple parts between locations in one operation. Opens from the Stock tab's bulk-select.

**Workflow**:
1. Bulk-select rows in Stock tab → "Move selected" button → this sheet opens
2. Pick destination location
3. Confirm — creates one `transfer` movement per selected row

**Gotcha**: source must be unambiguous. Won't open from warehouse rollup mode; drill into a specific bin first.

---

## Supporting sheets (not in the header)

### Location detail panel

Source: [LocationDetailPanel.jsx](../src/components/manager/LocationDetailPanel.jsx)

**Purpose**: Drill-in panel for a single location. Opens from the **📋 Details** button on Locations tab.

**What you see**:
- Stock list at this location (parts + qty)
- Action buttons:
  - **🔢 Count this bin** — auto-detects active count run (or starts new), jumps to that bin's session in CountTab
  - **📥 Export CSV** — downloads stock at this location as CSV (per-location audit)
  - **📦 View in Stock** — jumps to Stock tab filtered to this location
  - **🏷 Labels** — opens [SkuLabelSheet](#sku-label-sheet) for parts here, OR [BinLabelSheet](#bin-label-sheet) if it's a bin/warehouse
  - **✏ Edit** / **🛑 Retire** — modify the location

**Why this matters**: location-level drill-in is the natural entry point for "I want to know everything about THIS bin". Without it the manager would bounce between 3 tabs.

### Bin label sheet

Source: [BinLabelSheet.jsx](../src/components/cycleCount/BinLabelSheet.jsx)

**Purpose**: Print QR labels for bins. Each label encodes `BIN:<uuid>` so cycle counts and scan-mode loadouts can identify the bin.

**Four presets**:
- **Label — 4/page** (default, stick-on): bin name + warehouse + big QR
- **Label — 8/page** (denser stick-on)
- **Scan sheet — 30/page** (reference clipboard sheet)
- **Scan sheet — 60/page** (max density; clip to a board, scan from anywhere)

**Triggered from**: Locations tab (per warehouse, all its bins) OR LocationDetailPanel (single bin's labels).

**Print mechanics**: rendered via React Portal directly to body so multi-page output flows naturally. Print-only CSS hides everything except the portal. See [SKU label sheet](#sku-label-sheet) for the same pattern.

### SKU label sheet

Source: [SkuLabelSheet.jsx](../src/components/manager/SkuLabelSheet.jsx)

**Purpose**: Print QR labels for parts. Each label encodes the SKU. Sticks on packaging at receive time so cycle counts confirm "yes, this is Part X" without typing.

**Five presets**:
- **Label — US Letter, 4/page** (plain paper, peel-as-you-go)
- **Label — Avery 5163** (10/page, 2×4 in pre-cut)
- **Label — Avery 5160** (30/page, 1×2 5/8 in pre-cut, smaller parts)
- **Scan sheet — 60/page** (reference sheet, name + SKU)
- **Scan sheet — 120/page** (max density, SKU + QR only)

**Triggered from**: Parts tab (bulk), Receive PO (post-save offer for new SKUs), Stock tab, LocationDetailPanel.

### Aisle sign sheet

Source: [AisleSignSheet.jsx](../src/components/manager/AisleSignSheet.jsx)

**Purpose**: Big-print full-page aisle signs for warehouse navigation. Auto-parses bin names ("Aisle 4, Shelf B-3" → groups under "Aisle 4").

**Output**: 180pt aisle header + bay-range sub-line ("Bays B1 – B12") per page. Print, laminate, hang at the end of the aisle.

**Triggered from**: Locations tab (per warehouse) — separate button from bin labels.

---

## How they fit together — typical operations cadence

### Daily

1. **Morning** — Activity tab quick-scan: anything weird from overnight (Sonar auto-deliveries, edge-case auto-deducts)?
2. **As deliveries arrive** — Receive PO. Print SKU labels for new arrivals if needed.
3. **As crews report odd stock** — Stock tab → search → confirm system says what they say
4. **Approvals queue** (separate tab) drives most auto-deduct movements — those show up in Activity without you touching Inventory

### Weekly

1. **Sonar daily reports** — Sonar import sheet handles automatic webhook delivery; manager confirms unmapped projects/cities/parts, then applies. Audit panel under Sonar import confirms every delivery is accounted for.
2. **End-of-period or monthly Sage export** — Sage export sheet pulls all un-exported movements in the period and stamps them exported.

### Monthly / quarterly

1. **Cycle count** — pick a section of the warehouse, generate audit CSV from the Audit tab OR run a live cycle count via the Count tab
2. **Reconcile** — upload the filled CSV via Reconcile sheet. Variances get applied as `adjust` movements.
3. **Drafts cleanup** — Parts tab → Drafts filter → bulk-activate or set proper metadata on drafts created from inline-creates during the month

### Quarterly / one-time

1. **BoxHero re-import** — Import CSV with all Qty columns set to "skip" to catch new SKUs without touching stock
2. **Bulk-add Sonar projects** — when Sonar adds new projects, this sheet maps them to phases (or you wait for the weekly projects webhook once that's wired up)
3. **Bin labels reprint** — if a section gets relabeled, print fresh bin scan sheets

---

## Permissions

`role='owner'` or `role='manager'` is required to reach this tab at all (router gate in `App.jsx`).

For inventory mutations specifically:
- All movement INSERTs go through either `record_crew_movement` (gated by `crew_operation_permissions` + `crew_type_part_restrictions`) or directly via staff-write RLS on `inventory_movements`
- Staff are gated by `public.is_staff()` (returns true for owner + manager roles)
- The `inventory_movements` table has 3 protective triggers: `prevent_movement_delete`, `prevent_movement_modification` (only `exported_at` and `export_batch_id` are mutable post-create), and `update_inventory_stock_on_movement` (auto-syncs stock)

### Warehouse-only manager

A `role='manager'` user with `restricted_to_inventory=true` sees ONLY the Inventory tab — no Approvals, Crew, Projects, Reports, or Assemblies. They keep full manager-level DB access (so `is_staff()` returns true and every RPC/RLS check works normally), but the manager portal's nav filters them down. Use it for warehouse-only managers who don't need approval or project visibility.

Set the flag in **Admin → Users → edit user** → check **📦 Warehouse-only manager** (only visible when role = Manager).

---

## Common gotchas

- **Stock isn't realtime**: crew screens don't auto-refresh when manager applies a Sonar import or Reconcile. Crew needs to manually pull-to-refresh.
- **Movements are immutable**: no edit/delete. Create a counter-movement instead. The protective triggers enforce this at the DB level.
- **Bins can't nest**: single-level only. Encode shelving depth in the bin name.
- **`parts_catalog.id` is the SKU**: no renaming. Retire and recreate if needed.
- **`parts_catalog.category` is computed**: update `department` and/or `material_group`, not `category` directly.
- **Receive PO inline-create doesn't refresh search in-session**: close + reopen if you need to re-reference a freshly-created SKU.
- **Receive PO + Sonar sheets aren't phone-responsive**: `maxWidth: 760` — work on tablet+. Assumed manager-on-laptop environment.
- **Audit round-trip uses location *names***: rare collision risk if two trucks share a first name. Warning only.
- **Movements with `notes LIKE '%[sonar:%'` are the dedup signal**: don't manually edit those notes or the next Sonar import will re-import.
- **Sage export skips truck→truck**: those are internal handoffs, not Sage-relevant. Confirmed by the export's "skipped (truck→truck)" stat.
- **Project buckets auto-create**: `trg_ensure_project_job_site` creates a `job_site` location when a project becomes active. Don't manually create it.

---

## Cross-references

- The ledger end-to-end (vendor → Sage): **[INVENTORY_FLOW.md](./INVENTORY_FLOW.md)**
- Crew side of inventory (Load / Return / MyStockView): **[CREW_GUIDE.md](./CREW_GUIDE.md)**
- Manager portal at large: **[MANAGER_GUIDE.md](./MANAGER_GUIDE.md)**
- Database schema + RPCs + RLS: see CLAUDE.md "Database schema highlights" + "Database RPCs"
