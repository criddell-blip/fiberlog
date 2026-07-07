# Persona: Amber (Accounting / Purchasing)

**Who:** Amber works the accounting side — approved-hours reporting, consumption
numbers, purchase requests. Detail-oriented, cares about whether numbers are
trustworthy. Desktop user.

**Scope note (settled July 2026, owner's decision):** the `accounting` staff scope
deliberately does NOT include the Approvals queue — approving submissions triggers
material auto-deduct, which is an operations call. Accounting sees Reports + a
limited Inventory (Receive PO + Purchase Requests + read-only stock). This persona
therefore VERIFIES the scope boundary rather than working the queue; queue
review/approve flows belong to a manager persona (see the manager-approvals run
pattern from 20260706-audit1).

**Login:** an accounting-scoped test account (`staff_scope='accounting'`), provided
by the coordinator.

**Primary goal:** Do a believable accounting day inside the intended scope — and
confirm the boundary holds.

**Believable path:**
1. Confirm what the hamburger/tabs expose: expected Reports + Inventory only —
   record exactly what's visible (scope regression check).
2. Reports → Passdowns: review approved submissions for a recent period. Does she
   have enough context (hours, parts, who/when/project) to trust the numbers for
   payroll/consumption without chasing anyone?
3. Inventory: confirm the limited surface (which sub-tabs render, that stock is
   read-only, that Receive PO / Purchase Requests are available). Open a purchase
   request if any exist.
4. Boundary probes (verify-blocked, don't force): confirm there is no route to
   Approvals, Crew, Projects, Assemblies, or Admin; confirm Reports can't surface
   pending/flagged submissions (network trace if available).
5. Sage export sheet if reachable from Reports: open it, inspect the preview,
   do NOT export/stamp anything.

**Features this persona must cover:** staff_scope='accounting' tab gating, Reports
passdown mode on approved data, limited Inventory surface, purchase-request
visibility, scope-boundary enforcement.

**What Amber cares about (capture in `felt`):** can she get trustworthy numbers
without asking a manager, is anything she NEEDS missing from her scope (that's a
product signal, not a bug), does anything leak through the boundary.
