# FiberLog — Inventory Flow

End-to-end map of how materials move through FiberLog: from vendor delivery to Sage export. Covers every crew workflow, every manager entry point, and every place a movement gets created.

> Companion docs: **[CREW_GUIDE.md](./CREW_GUIDE.md)** (what crews see) · **[MANAGER_GUIDE.md](./MANAGER_GUIDE.md)** (manager portal operations).

Last updated: 2026-05-29.

---

## North star

FiberLog is the consumption ledger for every part the company buys. The chain is always:

```
Vendor → Warehouse → Truck (or shared trailer) → Project bucket → Sage export
```

Every step is an `inventory_movement` row. Together those rows tell you, per part per project per period, exactly what got used and by whom. That's the data Sage Intacct ingests for accounting and the data BEAD reports pull from for reimbursement.

There are **6 movement types**, **5 crew types that consume**, and **8 entry points that create movements**. The whole rest of this doc is just expanding those numbers.

---

## The 6 movement types

| Type | What it does | From | To | Common origin |
|---|---|---|---|---|
| `receive` | Vendor delivery lands in stock | NULL | Warehouse / bin | Receive PO sheet |
| `transfer` | Move stock between two real locations | required | required (different) | Crew load, Crew Return (sometimes), auto-deduct, bin moves |
| `return` | Crew returns unused parts to warehouse | Truck | Warehouse / bin | Crew Return sheet |
| `issue` | Stock leaves the system (issued to a non-FiberLog destination) | required | NULL | Sonar import (legacy path), manual issue |
| `scrap` | Stock written off (broken, lost, etc.) | required | NULL (or scrap loc) | Manual scrap |
| `adjust` | Reconciliation against a physical count | one of from/to | the other | Reconcile sheet, Cycle count |

`movement_endpoints_valid` CHECK constraint on the table enforces correct from/to per type; the JS `validateMovement()` helper mirrors it client-side so we fail early with a friendly message.

Every movement automatically triggers an update to `inventory_stock` (via `update_inventory_stock_on_movement` trigger), so stock-on-hand stays correct without app-layer juggling.

---

## The 3 destination types (where consumption "lands")

| Location type | Purpose | Example |
|---|---|---|
| `warehouse` | Physical storage; can have child `bin` rows for sub-locations | Main Warehouse |
| `bin` | Shelf-level sub-location under a warehouse | "Aisle 2, Shelf B-3" |
| `truck` | Personal vehicle assigned to a crew member, OR a shared trailer | "Joseph's Truck", "Aerial/UG Shared Trailer" |
| `job_site` | The **consumption sink** — one per FiberLog region project | Heber, Park City, Wasatch Front, Ogden Valley, West Mountain |

`job_site` rows are the regional cost-center buckets. They're auto-created by a DB trigger (`trg_ensure_project_job_site`) whenever a new active project appears, so you never have to set one up by hand.

**Phases under each region** (Center Creek, Snyderville, etc.) are NOT separate buckets — they're tags on the movement (`inventory_movements.phase_id`) for Sage cost-center grouping. This keeps the location picker from getting overrun with 100+ sub-buckets while still giving accounting per-cost-center rollup.

---

## The 8 entry points (what creates movements)

| # | Entry point | Movement type(s) | Who triggers | Notes |
|---|---|---|---|---|
| 1 | **Crew Load** (CrewMovementSheet) | `transfer` | Crew | Warehouse/bin → caller's truck/trailer. Permission-checked. |
| 2 | **Crew Return** | `return` | Crew | Caller's truck → warehouse/bin. Permission-checked. |
| 3 | **Auto-deduct on submission approval** | `transfer` × N | Manager | Truck/trailer → project bucket. Stamps `phase_id` from task's phase. Gated on crew_type ∈ {aerial, underground, splice, infrastructure, fiber_tech}. |
| 4 | **Manager Record Movement** | any | Manager | Free-form, no permission filter. For one-off adjustments. |
| 5 | **Receive PO** (vendor delivery) | `receive` × N (`receipt_kind='purchase'`) | Manager | NULL → destination. Multi-line; can create new parts inline. |
| 5b | **Field return** (Receive PO → *Returned from field*, or crew *Pulled from customer* → intake approval) | `receive` × N (`receipt_kind='field_return'`) | Manager / Crew (approved) | NULL → `Returns – to test` bin, booked onto the part's refurbished twin (`-R`, Sage `_R`). See "Field returns → refurbished twins" below. |
| 6 | **Reconcile** (audit CSV round-trip) | `adjust` × N | Manager | One-sided adjustments to align system stock with physical count. |
| 7 | **Sonar daily install import** | `transfer` × N | Manager | Truck → project bucket. Stamps `phase_id` from Sonar Project column via `sonar_project_phase_map`. |
| 8 | **Cycle count reconciliation** | `transfer` × N (or `adjust` if discrepancy) | Manager / Crew counter | Bin-level discovery; pairs of variances auto-reconcile, leftovers go to manager review. |

`BoxHero CSV import` is a #8.5 — used for initial seeding only, writes `adjust` baselines.

---

## Per-crew flows

### 1. Fiber construction (aerial / underground / splice / drop / locator)

**Shape:** Project → Phase → Task → Daily passdown.

```
Crew Load (#1) → Daily work → Submit passdown → Manager approves → Auto-deduct (#3)
```

**Step-by-step:**

1. **Crew Load** (morning): tap "My Stock" in CrewApp → "Load parts" → pick warehouse/bin → pick parts → quantities → submit. Creates `transfer` movements: warehouse/bin → personal truck (or shared trailer if `users.default_pull_location_id` is set).
   - Permission check: `crew_operation_permissions` (per-user deny list) + `crew_type_part_restrictions` (per-crew-type whitelist) both run in `record_crew_movement` RPC.

2. **Work the task**: crew opens a phase, then a task, then the workspace. Tally parts used (PartsTally), enter daily totals (footage, splices, etc.), add notes/photos. None of this writes to inventory yet — it lives in `working_counts` JSON on the task row until submission.

3. **Submit passdown**: crew taps "Submit" in TaskWorkspace. `save_log_entry` RPC atomically inserts `log_entries` + `entry_parts` rows and creates a `submissions` row with `status='pending'`. Task flips to `pending_review`.

4. **Manager reviews + approves**: in Submissions queue, manager either Approve, Flag (with reason), or Discard. On approve, `approve_submission` RPC fires:
   - Increments phase actuals (strand_ft_actual, fiber_ft_actual, etc.) on the task's phase
   - Flips submission to `approved` and task to `approved`
   - **Auto-deduct**: creates `transfer` movements (truck → project bucket) per part consumed, stamped with `phase_id` from the task's phase
   - All inside a single transaction; idempotent

5. **End state**: each part now sits in the regional bucket (Heber, Park City, etc.) with `phase_id` pointing to the cost-center sub-phase (Center Creek, Snyderville, etc.) and `consumed_by_user_id` pointing to the submitting crew member.

**Variations:**
- **Drop / Locator** crews follow the same flow but auto-deduct is gated on crew_type, so drop/locator submissions log work but DON'T auto-deduct materials. By design (manager handles their consumption via Sonar import or manual movement).
- **Shared pull location**: if a crew has `users.default_pull_location_id` set (e.g., to a shared aerial/UG trailer), Crew Load and auto-deduct both source from that location instead of the personal truck. `consumed_by_user_id` still records who used what — so the Reports tab can show "Grady's consumption from the shared trailer" cleanly.

### 2. Infrastructure crew

**Shape:** Project → **Site** → Task → Daily passdown.

Same flow as fiber, just with sites instead of phases in the middle layer. The task carries `site_id` (not `phase_id`), and `approve_submission` derives the project bucket from `sites.project_id` instead of `phases.project_id`. `phase_id` on the resulting movement stays NULL (no Sage cost-center sub-grouping for infra — Sage rolls up at the project level).

The auto-deduct gate includes `infrastructure` so movements get written normally.

### 3. Field tech (Sonar-driven) — the new flow

**Shape:** Tech does customer installs in **Sonar** (not FiberLog). FiberLog ingests Sonar's daily report and creates movements.

```
Tech installs at customer address (Sonar) →
Sonar fires daily webhook to FiberLog →
Manager reviews + applies via SonarImportSheet →
Auto-transfer (#7) creates one movement per install
```

**Step-by-step:**

1. **Field tech logs install in Sonar**: customer address, equipment model, item ID. Sonar's "Field tech asset Consumption" report captures this with one row per install (with duplicates — see dedup below).

2. **Daily webhook fires** (Sonar → `sonar-webhook` edge function at 06:00 America/Denver): the function:
   - Verifies a long URL-secret (Sonar has no native HMAC)
   - Unzips Looker's CSV-zip payload
   - Stores raw CSV in `sonar_pending_imports` with `status='pending'`

3. **Manager opens SonarImportSheet**, sees pending deliveries at the top, clicks "Review". The sheet:
   - **Dedupes** rows by first numeric token in `Model Field Data | Value List` (Looker emits each install at multiple aggregation levels)
   - **Skips re-imports** by checking notes for existing `[sonar:<itemId>]` markers in the last 90 days
   - **Routes by Project column** via `sonar_project_phase_map`: Sonar's project name → FiberLog phase → bucket derived from phase's region
   - Falls back to part-level routing (region by city / Gigwave / None) if Project is empty

4. **Manager applies**: creates one `transfer` movement per unique install. Truck → regional bucket, with `phase_id` tagged so the consumption lands in the right Sage cost center. The `[sonar:<itemId>]` marker in notes prevents future re-import.

**Crew gating:** Field techs have `crew_type = 'fiber_tech'`, included in the auto-deduct gate. Their submissions also work for direct FiberLog logging when needed.

### 4. Working manager (acting as crew)

A staff user with a field `crew_type` can flip into crew mode via the "🔧 Crew mode" pill. Everything works as if they were that crew type — same auto-deduct gate, same permission framework, same submission flow. Identity stays the same `user_id`; no account sprawl.

Caveat: if the manager's `crew_type` is something the auto-deduct gate doesn't recognize (e.g., `drop`, `locator`), their submissions log work but don't auto-deduct.

### 5. Contractor

Treated like a crew user with `role='contractor'`. Personal truck auto-created via `trg_ensure_crew_truck`. Same Crew Load / Return / submission flow. Their crew_type determines auto-deduct behavior.

---

## Manager cross-feature flows

### Receive PO (vendor delivery)

Manager opens **Inventory → 📥 Receive PO**:
- Vendor name + invoice ref + destination warehouse
- Per-line: SKU + qty + unit + unit_cost
- Can create new parts inline (auto `is_active=true`)
- On submit: one `receive` movement per line, all sharing the same `vendor_invoice`
- Optional: print SKU labels for newly-received parts

Stock immediately updates in `inventory_stock` via the trigger. Lands in the warehouse-level stock (or a specific bin if picked).

**Receiving against a PO (Aug 2026):** the sheet now lists open POs (ordered/partial purchase_requests) at the top — tapping one opens that PR's detail sheet and its per-line receive panel (partial quantities, optional bin destination, atomic `receive_pr_line` RPC) instead of re-typing lines. The manual flow above remains for PO-less deliveries. POs are created either as a PR marked ordered, or directly via **＋ New PO** in the PRs sub-tab or **＋ Create a PO** inside the Receive PO sheet (born `ordered` with Sage's typed PO number — accounting enters it when the purchase is placed, warehouse receives at the dock).

### Field returns → refurbished twins (Aug 2026)

Sage gives a returned/refurbished unit its own item ID (`UB000531_R` beside `UB000531`). FiberLog mirrors that with a **refurbished twin part** — `<sku>-R`, `parts_catalog.refurb_of = <parent sku>`, `sage_id = <parent sage_id>_R` — and a **receipt kind** on the movement so purchases and returns never mix:

- **Lifecycle of a Wave LR:** PO → Receive PO (`receive`, `receipt_kind='purchase'`, part `Wave-LR-US`) → crew load → install (auto-deduct exports as `UB000531`) → months later a tech pulls it. In FiberLog that unit was consumed, so the pull is a *new inflow*: a `receive` with `receipt_kind='field_return'` on **`Wave-LR-US-R`** (`UB000531_R`), landing in the **`Returns – to test`** bin (Main Warehouse). A manager bin-moves good units to shelf stock and scraps dead ones; reissuing a refurb is then an ordinary load/consume/export of the `-R` part.
- **Two doors, same booking.** (1) Warehouse manager: **Receive PO → Returned from field** — no PO ref required (optional ticket/RMA), "Returned from" instead of Vendor, no unit cost, destination defaults to the returns bin; picking the parent swaps the line to its twin, and a parent with no twin gets an inline **Create `<sku>-R`** button. (2) Crew/field tech: **My Stock → Pulled from customer** (beside *Report found inventory*) files a pending intake request (`intake_kind='field_return'`); the manager's Found queue shows a **FIELD RETURN** pill + "will be booked as <twin>", and `approve_intake_request` swaps to the twin server-side.
- **Separation everywhere:** Activity tab → Receive chip → *Purchases / Field returns / Found* sub-chips + a `Receipt kind` CSV column; the feed's source reads "Field return" not "Vendor". Sage export keeps excluding receipts, with an opt-in **Include field returns** checkbox (exports as `Inventory Receipt` on `UB…_R`, VENDORID blank) — OFF until accounting says how they want these booked.
- **Crew load returns (truck → warehouse, `return` type) are unchanged** — an unused new unit coming back off a truck is still new stock.

### Reconcile (audit CSV round-trip)

For correcting drift between system stock and physical reality:

1. Manager exports an Audit CSV (Inventory → 🔍 Audit tab → Generate CSV)
2. Walks the warehouse with the CSV, fills in `Actual Qty` column
3. Inventory → 🔄 Reconcile → upload the filled CSV
4. System computes `Actual - System = Variance` per row, shows preview, asks for confirmation
5. On confirm: one `adjust` movement per variance row (positive = receive-style; negative = scrap-style)

Reconciliation is per-warehouse OR per-bin — matched by location name.

### Cycle count

Bin-level rolling count without taking the warehouse offline:

1. Counter (manager or staff) opens **Inventory → 🔢 Count** → starts a run
2. Walks bins, scans bin QR + part QR (or picks from a list), enters counted_qty
3. Counter submits each bin's session as it goes
4. End of run → `end_count_run_and_reconcile` RPC:
   - **Pairs offsetting variances within the same warehouse** as internal `transfer` movements (e.g., 5 extra of SKU-X in bin A + 5 short in bin B = transfer from B to A)
   - **Leftovers** go to manager review queue (`count_resolutions` table); manager approves each as a `transfer` to a "found" pseudo-location or discards

**Bin distribution mode** (DB flag `is_first_binning`): a freely re-runnable mode where counts become direct `transfer` movements (warehouse-level stock → bin stock) instead of variance reconciliation. Use it for the initial warehouse → bin distribution AND any time a new shipment arrives that needs to be sorted into bins. No review queue.

### Sonar import (daily install report)

See [Field tech flow](#3-field-tech-sonar-driven--the-new-flow) above. Manager-driven step is Review + Apply via SonarImportSheet, but the data comes in via webhook automatically.

### Manual record movement

For ad-hoc adjustments: stock moved between bins, scrap, manual issues, etc. RecordMovementSheet covers transfer (the default) / return / issue / scrap / adjust — NOT receive, which is Receive PO's job so every receipt carries vendor + cost metadata. No permission filter (staff-only entry point already).

### Project routing override

On the Manager Submissions queue (and in TaskWorkspace pre-submit), you can set `submissions.project_id_override` to redirect a submission's auto-deduct to a different project than the task's natural phase project. Useful when a crew worked across regions on a single ticket.

---

## End of the line: Sage Intacct export

**Inventory → 🧾 Sage** opens SageExportSheet:

1. Pick date range (default: last 7 days)
2. Toggle "Include exported" if re-issuing a corrected batch
3. Preview shows movements that will export — skips all `receive` and `adjust` rows plus `truck → truck` and warehouse-internal staging (no Sage relevance)
4. Stats summarize counts by movement type
5. Click "Download CSV + mark X exported":
   - Inserts a parent row in `inventory_export_batches` (captures `exported_by` + `movement_count`)
   - Updates each included movement's `exported_at` + `export_batch_id`
   - Builds the CSV and triggers browser download

**CSV format** (Sage Intacct Inventory Transactions template, 18 columns):

```
TRANSACTIONTYPE, DATE, REFERENCENO, LINE, ITEMID, ITEMDESC,
QUANTITY, UNIT, PRICE, FROM_WAREHOUSE, TO_WAREHOUSE, TO_BIN,
PROJECTID, CLASSID, DEPARTMENTID, VENDORID, MEMO,
FIBERLOG_MOVEMENT_ID
```

- `TRANSACTIONTYPE` = Sage's standard transaction type per movement_type (Inventory Transfer / Issue / Adjustment). Inventory Receipt never appears — receipts are booked in Sage from the PO, so FiberLog doesn't export them
- `PROJECTID` = phase's parent project (Heber, Park City, etc.)
- `CLASSID` = phase name (Center Creek, Snyderville, etc.) — Sage's cost-center sub-grouping
- `FIBERLOG_MOVEMENT_ID` = `inventory_movements.id`, useful for back-referencing in Sage

The next export skips already-exported rows automatically via the partial index on `(created_at) WHERE exported_at IS NULL`. Toggle "include exported" to re-issue (e.g., if Sage rejected a batch and needs a corrected one).

**Prototype defaults** (easy to swap if Sage rejects):
- Sage transaction type names are Sage Intacct defaults — config customizable per company
- Warehouse + project codes use FiberLog names directly (no code mapping table yet)
- VENDORID kept for column-layout stability but always blank — vendors only attach to receives, which aren't exported (Sage has the vendor from the PO)
- Receives and adjusts are always filtered; trucks are filtered when both endpoints are trucks; truck→bucket consumption + warehouse→truck loadouts kept
- Known gap: strict-consumption mode tests only `type='truck'`, so loadouts/handoffs through **group** locations (Contractor - RNS, Crew - Construction …) still export in strict mode — 24 rows today. Pre-existing; fixing it changes what accounting receives, so it needs its own sign-off

---

## Audit + traceability

Every movement carries a rich set of identifiers:

| Column | Set by | Use case |
|---|---|---|
| `task_id` | Auto-deduct, crew flows | "What movements came from this task?" |
| `submission_id` | Auto-deduct | "What movements approved this submission?" |
| `consumed_by_user_id` | Auto-deduct, Sonar import | "What did this crew member consume?" — works even when source location is a shared trailer |
| `phase_id` | Auto-deduct, Sonar import | Sage cost-center grouping |
| `export_batch_id` + `exported_at` | Sage export | "Has this been reported to accounting yet?" — note that on a `receive`, `exported_at IS NULL` means *never will be*, not *pending* |
| `vendor_invoice` | Receive PO | "What PO did this part come from?" |
| `notes` | All entry points | Free-text rationale; Sonar bookkeeps `[sonar:<itemId>]` marker here |
| `created_by` | All entry points | "Who recorded this movement?" |
| `created_at` | All entry points | Timestamp |

Combined, you can query:

```sql
-- "How much of part X went to Heber in May 2026, by phase?"
SELECT phase.name, SUM(m.quantity), part.unit
FROM inventory_movements m
JOIN parts_catalog part ON part.id = m.part_id
JOIN inventory_locations to_loc ON to_loc.id = m.to_location_id
JOIN phases phase ON phase.id = m.phase_id
WHERE part.id = 'SKU-X'
  AND to_loc.name = 'Heber'
  AND m.created_at BETWEEN '2026-05-01' AND '2026-06-01'
GROUP BY phase.name, part.unit
ORDER BY 2 DESC;
```

```sql
-- "Show me an exported batch and what's in it"
SELECT b.id, b.exported_at, b.movement_count, u.name AS exported_by
FROM inventory_export_batches b
LEFT JOIN users u ON u.id = b.exported_by
ORDER BY b.exported_at DESC LIMIT 5;

SELECT m.* FROM inventory_movements m WHERE m.export_batch_id = '<batch-id>';
```

---

## Realtime + dependencies

- **Realtime publication** includes `tasks`, `submissions`, `work_sessions`, `emergency_logs`, `log_entries`. Not `inventory_movements` or `inventory_stock`. So when a manager applies Sonar/Reconcile/auto-deduct, crew screens (MyStockView) won't auto-update — crew needs to manually refresh.
- **`approve_submission` RPC** is the single source of truth for the fiber-crew consumption path. Don't add another entry point that does the same thing — extend this RPC.
- **`record_crew_movement` RPC** is the single source of truth for crew-initiated movements (Load/Return). Permission-gated; bypasses RLS via SECURITY DEFINER.

---

## Gotchas worth remembering

- **Bin source ambiguity**: when viewing a warehouse's rollup stock (vs drilling into a specific bin), bulk-move and audit-CSV operations can't tell you which bin to pull from. Drill into "Unbinned" or a specific bin first.
- **Sonar dedup**: only protects against re-imports within the **last 90 days**. If you re-import a CSV from 6 months ago you'd duplicate. (Not a real risk in practice; rolling weekly windows are the actual use case.)
- **PostgREST embedded FK syntax**: always use the full constraint name (`!inventory_movements_from_location_id_fkey`), not the column-name shorthand. The shorthand silently fails to resolve and looks like "no rows" instead of throwing.
- **Phase actuals are fiber-only**: `approve_submission` only updates `phases.*_actual` when phase_id is set. Infra tasks (with `site_id` instead) skip this block. That's by design.
- **Auto-deduct gate**: crew_type must be in `{aerial, underground, splice, infrastructure, fiber_tech}` for materials to flow. Drop / locator / install crews can submit but their consumption isn't auto-tracked.
