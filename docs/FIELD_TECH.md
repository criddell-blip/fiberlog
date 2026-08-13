# Field tech (backlog — blocked)

> Moved out of CLAUDE.md (Aug 2026) to keep always-loaded memory lean. This is the full reference; the summary lives in CLAUDE.md.

**Why backlogged:** Field techs install at customer addresses. Sonar tracks customers but does not currently tag each customer with which fiber region (Heber / Park City / etc.) they fall under. Without that, when we import Sonar's daily report, we can't reliably route consumed materials to the right project — and routing to a generic "Wave" or "FW" bucket forces a manual reconciliation step downstream that defeats the purpose.

**Unblocks when:** Sonar gets polygon-to-customer address mapping (in progress — tied to BEAD/reconnect address requirements). The polygons already exist from the developer side; they haven't propagated to Sonar yet.

**Approach when unblocked (Option 3 — dispatcher tags at job creation):**
- Dispatcher (or system, once polygons land) adds a `project` field to Sonar jobs at scheduling time
- Sonar daily CSV export includes that field
- FiberLog's Sonar import sheet (already shipped — `SonarImportSheet.jsx`) reads the `project` field and ties each imported submission to that project
- Manager approves the batch → materials auto-deduct truck → project
- Sage export includes field tech consumption alongside fiber + infrastructure, all keyed by project

**Why Option 3 over an address lookup table:** A FiberLog-maintained address → project lookup is another manual process. The polygon data exists at the developer level and is moving toward Sonar; building our own lookup would compete with the real source of truth.

**Until then:** Field techs continue logging in Sonar. Their material consumption isn't tracked in FiberLog. Manual Sage entry for field tech materials continues (status quo, pending the unblock).
