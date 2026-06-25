# Persona: Clint the Quartermaster

**Who:** Clint runs the warehouse. Methodical, knows the SKUs cold, does this every
month. Comfortable with the app but impatient with anything that slows him down.

**Login:** test account (Clint logs in himself in the visible window when prompted).

**Primary goal:** Run a complete warehouse cycle count, export the result as CSV,
and eyeball it against expected on-hand for a couple of bins.

**Believable path:**
1. Land on the dashboard, go to the warehouse location.
2. Open a sub-location / bin, count several SKUs (enter real-looking quantities).
3. Move through at least 3 bins so multi-bin navigation gets exercised.
4. On one SKU, enter an obviously wrong quantity, notice it, correct it (tests the
   edit path and whether the correction is obvious).
5. Finish the count and export the cycle-count CSV.
6. Open/inspect the CSV result and check that the quantities you entered are the
   quantities that came out (data-integrity check — record the comparison in the
   trace explicitly).
7. If a BoxHero stock-sync / reconciliation view exists, glance at it and note
   whether discrepancies are surfaced clearly.

**Features this persona must cover:** bin / sub-location navigation, count entry,
count correction/edit, cycle-count CSV export, (if present) BoxHero stock sync /
reconciliation view.

**What Clint cares about (capture in `felt`):** speed of moving bin-to-bin, how
many taps to log one count, whether the CSV matches what he typed, whether a
mistake is easy to fix.
