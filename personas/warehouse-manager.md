# Persona: Warehouse Manager (non-owner)

**Who:** A newly-hired manager who runs the warehouse but is NOT an owner. Exercises
the June-2026 change that opened three formerly owner-only inventory toggles to all
managers, while confirming the owner/manager boundary (owner-account minting) still
holds. Also the first persona to see the merged `fiber_construction` crew type.

**Login:** a test account with **role = manager** (NOT owner). The operator pauses
for the human to log in in the visible window. If no non-owner manager test account
exists, record "requires human — need a manager (non-owner) test login" and stop;
do not fall back to the owner account (that would not test the change).

**Primary goal:** Confirm a non-owner manager now has the three opened capabilities
and the merged crew label, and confirm owner-minting is still blocked.

**Believable path:**
1. Land in the manager portal and confirm the **Admin** tab is visible (it used to
   be owner-only — its presence for a manager is itself the first signal).
2. **Inventory pause toggle** — go to Admin → AdminPanel. Confirm the pause/resume
   button is **enabled** (no longer greyed with an "Owner only" tooltip).
   ⚠️ GUARDRAIL: this is an **org-wide** setting affecting all ~20 live users — do
   NOT actually click it. Verify it is enabled/reachable only, and record that.
3. **Load destinations** — Admin → Users → open a CLEARLY-LABELED test user (e.g. the
   "QA Test User" the admin-provisioner persona creates; never a real crew member).
   Confirm the "Load destinations" add/remove controls are enabled (not "Owner
   only"). Add one destination, verify it sticks, then remove it (reversible).
4. **Location retire** — Inventory → Locations. Confirm a **Retire** button now
   appears on warehouse + bin rows for a manager. ⚠️ GUARDRAIL: do NOT retire a real
   location. Either retire only a clearly-labeled test bin you created this run, or
   just confirm the control is present/enabled and record that.
5. **Owner-minting still locked** — Admin → Users → Add user. Confirm the **Owner**
   role option is disabled / not selectable for a manager (the boundary that keeps a
   manager "not an owner"). Record what you observe.
6. **Merged crew type** — in the Add-user / edit-user crew-type dropdown, confirm it
   shows **"Fiber construction"** and that **"Aerial"** and **"Underground"** are
   GONE as separate options. Glance at the crew roster / CrewStatus and confirm any
   merged user reads **"Fiber construction"**, not a raw `fiber_construction`.

**Features this persona must cover:** Admin-tab access for managers, inventory
pause-toggle reachability, load-destinations edit, location-retire reachability,
owner-minting block, `fiber_construction` label rendering.

**Guardrail (overall):** verify-reachable beats commit. Never fire the org-wide
inventory pause, never retire/decommission a real location, never touch real users —
constrained-prod run. Anything that would write to a real shared resource: record it
as "verified enabled, not committed (prod safety)" instead of doing it.

**What the manager cares about (capture in `felt`):** does it feel like a full
warehouse manager can just do their job now, are any of the newly-opened controls
confusingly still styled as disabled, is it obvious which actions are org-wide vs
scoped, does "Fiber construction" read cleanly everywhere.
