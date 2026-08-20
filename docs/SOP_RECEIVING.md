# SOP — Receiving stock into FiberLog (Receive PO / vendor delivery)

**Who this is for:** the warehouse manager and the accounting person. Anyone with
Inventory access can do this, but these two roles own it.

**What it covers:** every way stock *enters* FiberLog through the **📥 Receive PO**
sheet — a vendor delivery, a part that isn't in the catalog yet, equipment pulled back
from a customer or site, and recovering gear from a decommissioned site — plus how to
fix a mistake.

**What it does NOT cover (yet):** receiving against a PO entered in FiberLog, the
**↩ Reverse** button, and the Purchase Reqs tab. Those are hidden behind
**Admin → Purchasing**, which is **Off** by owner decision (Aug 20 2026). When it's
switched on, this doc gets a new section.

---

## 0. Where this SOP sits — the whole chain

Material moves through six steps. Three happen in Sage, three in FiberLog. **This SOP is
step 3.** The Sage steps are shown for reference only — they're done by accounting in
Sage, and FiberLog neither replaces nor duplicates them.

| # | Step | System | Who | What happens | Where it's documented |
|---|---|---|---|---|---|
| 1 | **Sage PO** | Sage *(reference)* | Accounting | The order is placed in Sage. The PO number, vendor, item IDs and quantities created here are what you'll work from in step 3. | Sage |
| 2 | **Sage Receiver** | Sage *(reference)* | Accounting | When the delivery arrives, it's received against the PO in Sage. This is the accounting receipt — cost lives here. | Sage |
| 3 | **FiberLog qty update** | FiberLog | Warehouse / Accounting | The same delivery is entered with **📥 Receive PO** so FiberLog's stock goes up at the **Receiving dock**. Quantities only, no cost. | **This SOP** (§3–§6) |
| 4 | **FiberLog warehouse transfer** | FiberLog | Warehouse, then crew | Put-away: **Record movement → Transfer** from the Receiving dock to the shelf bin. Then crews **Load** onto their trucks from **My Stock**. | [INVENTORY_TAB.md](INVENTORY_TAB.md) · [CREW_GUIDE.md](CREW_GUIDE.md) |
| 5 | **FiberLog project allocation** | FiberLog | Crew, then manager | The crew logs parts used on a task and submits the passdown; the manager approves and the parts auto-transfer truck → **project bucket**. Field-tech installs reach the same bucket via the Sonar import. | [MANAGER_GUIDE.md](MANAGER_GUIDE.md) · [INVENTORY_FLOW.md](INVENTORY_FLOW.md) |
| 6 | **Sage asset allocation** | Sage *(reference)* | Accounting | At period end the manager runs **🧾 Sage export** — the CSV of consumption per project — and accounting books it in Sage. Receipts (step 3) are never in this file; Sage already has them from step 2. | [INVENTORY_TAB.md](INVENTORY_TAB.md) → *Export for Sage* |

```
Sage PO → Sage Receiver → FiberLog qty update → FiberLog warehouse transfer → FiberLog project allocation → Sage asset allocation
  (1)          (2)              (3) ← you            (4)                          (5)                              (6)
```

The one rule that ties it together: **every quantity that enters FiberLog in step 3 must
eventually leave through step 5.** Stock that never gets allocated to a project is either
still on a shelf or a truck (fine) or was entered wrong (see §7).

---

## 1. Why we do this in FiberLog

Purchases are received **in Sage first** — Sage is the accounting book. FiberLog is the
**inventory book**: it records *where the stock physically landed* so crews can load it
onto trucks and the consumption later lands on the right project.

Consequences you should know:

- A receive in FiberLog **never** goes to the Sage export. You are not double-booking.
- What you type here is what crews see in **My Stock → Load** ten minutes later. A wrong
  qty here becomes a wrong truck load tomorrow.
- Every line you receive becomes one permanent `receive` movement in the Activity tab,
  stamped with your name and the time you entered it.

**Where the button is:** Manager portal → **Inventory** → the actions strip → first
button **📥 Receive PO** (sub-label *Vendor delivery*). On a phone it's behind
**⋯ Actions**. If your account is the Accounting type, this is the *only* action button
you'll see — that's by design.

---

## 2. Before you open the sheet

- [ ] Have the **Sage PO** open (printed or on screen). It is your source document:
      the PO number is the ref, the vendor is on the header, and each PO line gives you
      the Sage item ID, description, quantity ordered — everything the
      sheet asks for, in order.
- [ ] Have the vendor's **packing slip** too. The PO tells you what was *ordered*; the
      slip and the boxes tell you what *arrived*. You receive what arrived.
- [ ] **Count the boxes / reels / feet against the PO lines.** Short-shipped? Receive
      the short quantity and write the rest in the Vendor field (e.g. `Acme — 2 of 5
      reels, balance to follow`). Something on the slip that isn't on the PO? Receive it
      on its own line and flag it to accounting.
- [ ] **Enter it the day it arrives.** The sheet has no date field — the movement is
      dated by the moment you press Receive. If you're catching up on a late entry, put
      the real arrival date in the **Vendor** field text (`Acme (arrived 08/18)`).
- [ ] Know which kind of receipt this is *before* you start typing lines:
      **Purchase order** (anything bought from a vendor — the default) or
      **Returned from field** (a used unit coming back from a customer or site).
      Switching the pill **clears every line**, so decide first.
- [ ] One sheet per Sage PO. A PO that arrives in two shipments = two sheets with the same ref; two POs on one truck = two sheets.

> ⚠️ **Never practice on this sheet with made-up numbers.** It posts real stock. Walk
> through it on screen with a real delivery instead.

---

## 3. SOP 1 — Standard vendor delivery

### Header

1. Tap **📥 Receive PO**. The sheet opens titled **Receive PO / vendor delivery** with the
   **Purchase order** pill already selected. Leave it.
2. **PO / invoice ref \*** (required) — the **Sage PO number**, typed exactly as Sage
   shows it. Same number every time, no prefixes or notes: the Activity tab groups lines
   by this value and it's how accounting will tie the FiberLog receipt back to the Sage
   PO. (Only if there genuinely is no Sage PO — a walk-in purchase — fall back to the
   invoice or packing-slip number.)
3. **Vendor (optional)** — the vendor name off the PO header (`Graybar`, `Clearfield`, …).
   Fill it in; "optional" just means the sheet won't block you. This is also the only
   free-text spot on the header, so short-ship / late-entry notes go here too.
4. **Destination \*** — pre-filled with the warehouse that owns the **Receiving dock**
   bin. Leave it unless the stock genuinely went somewhere else (a truck or a crew
   group is allowed — e.g. a crew took the whole delivery straight off the freight
   truck). Job sites and Scrap are deliberately not in this list.
5. **Bin (optional)** — pre-filled with **📥 Receiving dock**. Leave it. Put-away to the
   real shelf bin is a separate step (see §3 "Afterwards"). If you *know* it's going
   straight to its shelf and you're walking it there now, you may pick that bin instead.

### Line items

Work **down the PO, one PO line = one sheet line**, in the same order — it makes the
check at the end trivial.

6. **Search part name or SKU…** — type a distinctive word from the PO line's
   description, or the Sage item ID itself (`UB000011` — most parts carry their Sage ID
   and search finds it). Pick the part from the dropdown (name on top, SKU underneath;
   the picked chip shows `Sage <id>` so you can confirm it matches the PO). Read the
   SKU, not just the name — several parts have near-identical names (reel lengths, `-R`
   refurbished twins). PO line not in the catalog at all → SOP 2.
7. **Qty** — the number that **arrived**, in the **unit shown under the box** (`ea`,
   `ft`, `roll`, …). Start from the PO quantity and reduce it if the count is short.
   Watch for unit mismatches between Sage and FiberLog — Sage may order *1 reel*, the
   FiberLog part counts **ft**; enter the feet. If the unit shown is wrong for the part,
   see SOP 2 → *Fix a part's unit*.
8. **$ each** — **leave it blank.** Sage already holds the cost; FiberLog doesn't need
   it. (If you do type one, the **Estimated total** strip at the bottom is just a
   sanity check — it is not stored anywhere.)
9. **＋ Add line** for each additional SKU. **×** on the right removes a line (hidden
   when there's only one).
10. Watch the counter next to **Line items** — it reads `N valid · M total`. A line is
    only *valid* when it has both a part and a qty above 0. Invalid lines are silently
    skipped, so if the two numbers differ, find the blank line before you submit.
    Then the final check: **same number of lines as the PO** (minus anything that
    didn't ship). Cost is not part of the check.

### Submit

11. Tap **Receive N items** (it's greyed out until the ref, destination, and at least
    one valid line are in place). The button reads **Receiving…** for a moment.
12. A green card appears: **Received N item(s)**.
    - **🏷 Print labels** — recommended. Prints a QR label per received SKU so you can
      stick them on the boxes as you put them away. Crews scan these at load time.
    - **Skip** if the items are already labelled (repeat stock going onto a labelled
      shelf).
13. You're back in Inventory with a toast **Received N item(s)**. Open the **Activity**
    tab → the **Receive** chip to see your lines, or the **Stock** tab → Receiving dock
    to see the quantities.

### Afterwards — put-away

Stock sits at **Receiving dock** until someone moves it. When you physically shelve it:
**Inventory → ＋ Record movement → Transfer**, from *Receiving dock* to the shelf bin
(or bulk-select the rows in the **Stock** tab while drilled into the Receiving dock bin
and use **Bulk move**). That transfer is an internal move — it doesn't touch Sage either.

### If something goes wrong on submit

A red strip appears above the buttons and **nothing was posted** (the sheet is
all-or-nothing). Fix what it names and press Receive again — your lines are still there.
The one exception: if a *new* part was created before the failure it stays created, and
retrying is fine (the sheet recognises it).

---

## 4. SOP 2 — The part isn't in the catalog

Only for **purchases**. Returned equipment must already be a catalog part (see SOP 3).

1. In the line's search box, type the part's **name** (not a made-up SKU). Check the
   dropdown carefully — the part is usually there under a slightly different name.
   Search by a distinctive word (`GigaSpire`, `144ct`, `ground rod`) before concluding
   it's missing. Creating a duplicate SKU is the #1 catalog mess to avoid.
2. Genuinely missing? Tap **＋ Create new part — "<what you typed>"** at the bottom of the
   dropdown. A teal **＋ Create new part** form opens:
   - **SKU \*** — the vendor's part number / manufacturer SKU, in CAPS, no spaces
     (`ACM-1234`). This becomes the permanent ID; it cannot be changed later.
   - **Part name \*** — pre-filled from what you typed. Make it match the **description
     on the Sage PO line** (that's how accounting will recognise it).
   - Unit — `ea` by default; pick `ft` for cable, `roll`/`box` only if we really count it
     that way.
   - **Department (optional)** — pick from the list (Fiber Construction, Drop
     Installation, Underground construction, Splice, Customer Installation). This drives
     which crews may load the part, so fill it in when you know it.
   - **Material group (optional)** — e.g. `Fiber cable`, `Conduit`, `CPE`.
   - **Sage ID (optional, e.g. UB000011)** — the Sage *item ID* **straight off the PO
     line**. That's the whole point of having the PO in front of you: copy it exactly.
     If the PO line has no item ID (a non-stock / expensed line, or accounting hasn't
     set it up yet), **leave it blank** rather than guess — the Parts tab has a
     "No Sage ID" filter so it can be filled in later. A Sage ID already used by another
     part is rejected when you press Receive — that usually means the part *does* exist
     under a different name; cancel and search by that Sage ID instead.
3. **Save part**. The line now shows the part with a **NEW** badge. Enter **Qty** as
   normal.
4. Finish the sheet (SOP 1 steps 9–13). The part is created *when you press Receive*,
   not before — if you cancel the sheet, no part is made.

**Gotcha:** a part you just created **won't appear in search on later lines of the same
sheet**. Add its qty on the line where you created it. If you need it twice, finish this
sheet and start another — or close and reopen the sheet.

### Fix a part's unit / department / material group

If an existing part's catalog attributes are wrong (wrong unit is the common one), you
can fix them from the line: after picking the part, tap **edit attrs** on its chip → an
orange **✎ Edit attributes** form lets you change unit, department and material group
(SKU and name are locked) → **Save changes**. The chip shows **EDITED**; the change is
written when you press Receive. Don't use this to "fix" a quantity — see §7.

---

## 5. SOP 3 — Equipment returned from the field

A **used** unit (router, ONT, radio, Wave LR…) coming back from a customer or site.
It's been out in the world, so it must **not** go back into stock as new — FiberLog
books it onto the part's **refurbished twin** (`<SKU>-R`, Sage `…_R`), exactly as Sage
does.

> **Which door?** If a tech hands you the unit or it arrives at the dock → **you** do this
> SOP. If the tech is in the field with it on their truck → they use **My Stock →
> Pulled from customer** in the crew app, and you approve it in **Inventory → Found**
> (it books onto the twin automatically). Don't do both for the same unit.

1. Tap **📥 Receive PO**, then the amber **Returned from field** pill. The title changes
   to **Receive returned equipment**. (If you already had lines typed, you'll be asked to
   confirm — they get cleared.)
2. **Ticket / RMA ref (optional)** — the Sonar ticket or RMA number if there is one
   (`Sonar ticket 48213`).
3. **Returned from (customer / site / tech)** — who/where it came from and, briefly, why
   (`123 Main St, Heber — J. Smith, cancelled, unit works`). This is the only record of
   provenance, so fill it in.
4. **Destination / Bin** — pre-filled to the warehouse and the **Returns – to test** bin.
   Leave it. Returned gear waits there until someone tests it.
5. Search and pick the **normal** part (e.g. `Wave-LR-US`). The line briefly says
   *Looking up refurbished twin…* and then swaps to the twin — chip shows a **REFURB**
   badge and *picked as <original>*. That's correct.
   - If instead you see **⚠ No refurbished twin — will receive as the original part.**,
     tap the **Create <SKU>-R** button next to it **once**, wait for the chip to show
     REFURB, then continue. Do **not** receive a return onto the non-R part.
   - Nothing in the dropdown? Returned equipment must already exist in the catalog. If
     it's a genuinely new model, receive one as a **Purchase order** first (SOP 2), then
     come back.
6. **Qty** — usually `1`. There is no unit cost on returns.
7. **＋ Add line** for more units, **Receive N items**, then labels — **print them**:
   the label carries a **REFURB** band so the unit can't be mistaken for new stock on
   the shelf.

**After testing:** a good unit gets bin-moved from *Returns – to test* to shelf stock
(**Record movement → Transfer**) and is reissued as the `-R` part like any other stock.
A dead unit is **Record movement → Scrap** from the returns bin.

---

## 6. SOP 4 — Recovering gear from a decommissioned site

Same as SOP 3 — it's used equipment coming back. Differences:

- **Ticket / RMA ref** → the site name (`Site: Prestige II`).
- **Returned from** → `Site decommissioned — <site name>, <date>`.
- Receive **every** recoverable item (radios, switches, power gear) as separate lines;
  unrecoverable items are not received at all (they were consumed when installed).

When a manager decommissions the site in **Projects → site → Decommission site**, the confirm
box reminds them to do this step. One person does it, once.

---

## 7. Fixing mistakes

Manual receipts have **no Reverse / undo button** (that exists only for PO-linked
receipts, which are switched off). Corrections are made with a second movement so the
history stays honest. Nothing below touches Sage — adjusts and transfers are never
exported.

| What went wrong | Fix |
|---|---|
| **Wrong quantity** (received 50, should be 40) | **＋ Record movement → Adjust → − Found missing**, location = the bin it landed in (Receiving dock), part + the difference (10). Notes: `Correction of receive <ref> — over-keyed`. |
| **Wrong part** (picked the 48ct reel, it was 144ct) | Adjust **− Found missing** the wrong part out (as above), then a fresh **Receive PO** with the same ref for the right part. Notes on both point at each other. |
| **Entered the same delivery twice** | Adjust **− Found missing** every line of the duplicate, notes `Duplicate of receive <ref>`. |
| **Wrong destination or bin** | **＋ Record movement → Transfer** from where it landed to where it should be. (That's a real move — no adjust needed.) |
| **Wrong receipt kind** (booked a field return as a purchase, or vice-versa) | Adjust the wrong part out, re-receive under the right pill. This matters: purchases land on the normal SKU, returns on the `-R` twin, and Sage keeps them separate. |
| **Forgot the vendor / ref** | Leave it. These fields are informational; don't adjust stock to fix text. Tell accounting if they need the number. |
| **Typo in a new part's SKU** | The SKU can't be renamed. Adjust its stock out, ask a manager to retire the part in the **Parts** tab, create the right one. |

Rules of thumb:

- **Always write a note on a correction** that names the original ref. Three months
  from now that's the only way anyone can follow what happened.
- Never edit a part's attributes (unit, department) to compensate for a wrong quantity.
- If you're unsure, stop and ask before adjusting — one wrong adjust is easy to find; a
  correction-of-a-correction isn't.

---

## 8. Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| Work from the Sage PO: its number as the ref, its item IDs to find parts. Skip cost. | Type a ref from memory or a packing-slip number when a PO exists. |
| Count before you type. | Receive the PO quantity when fewer boxes arrived. |
| One sheet per PO, ref typed exactly as Sage shows it. | Lump three POs into one sheet. |
| Leave Destination / Bin on the Receiving dock default. | Receive straight to a job site or Scrap (not offered) — or to a truck unless the crew really drove off with it. |
| Check the **unit** under the Qty box — ft vs ea vs roll. | Type reels when the part counts feet. |
| Search by name before creating a new part. | Create a second SKU for a part that's already there. |
| Print labels and stick them on the boxes. | Skip labels on new stock — crews scan them to load. |
| Use the **Returned from field** pill for anything that's been installed before. | Receive a pulled unit as a purchase (it would re-enter as new). |
| Fix mistakes with **Adjust** + a clear note. | Practice on the live sheet with fake numbers. |

---

## 9. Quick reference — what each field becomes

| On the sheet | In the record |
|---|---|
| **PO / invoice ref** / **Ticket / RMA ref** | `vendor_invoice` on every line's movement — the Activity tab groups by it |
| **Vendor** / **Returned from** | Movement notes, prefixed `Vendor:` or `Returned from:` (the Activity feed reads that prefix as the source name) |
| **Purchase order** / **Returned from field** pill | `receipt_kind = purchase` / `field_return` — Activity sub-chips and CSV column; the Sage export only ever looks at field returns, and only when accounting turns that on |
| **Destination** + **Bin** | `to_location_id` (the bin if picked, else the warehouse) |
| **Qty** / unit under it | `quantity` / `unit` |
| **$ each** | `unit_cost` (blank on returns) |
| Time you pressed Receive | `created_at` — the movement's date |

---

## Related docs

- [INVENTORY_FLOW.md](INVENTORY_FLOW.md) — *Receive PO (vendor delivery)* and *Field returns → refurbished twins*: the why behind the rules above.
- [INVENTORY_TAB.md](INVENTORY_TAB.md) — *The most common things you'll do* (Record movement, Stock, Activity, labels) and *Permissions* (who has Receive PO).
- [TRAINING.md](TRAINING.md) — Module 4 (warehouse), section 4.2 *Receiving deliveries*, and the safety rules.
- [MANAGER_GUIDE.md](MANAGER_GUIDE.md) — *The actions strip → Receive PO*, in the context of the whole manager portal.

*Last updated: August 2026 — written against the Receive PO sheet as deployed Aug 20 2026 (Receiving-dock default, field returns, Sage ID on inline create, Purchasing switch Off).*
