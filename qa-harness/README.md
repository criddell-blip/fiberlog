# FiberLog QA Harness

A two-agent setup for exercising FiberLog like real users and getting honest,
evidence-based feedback on what works, what's slow, and what's broken.

- **Operator** (`.claude/agents/fiberlog-operator.md`) — drives the real browser as
  a persona, pursues a realistic goal, writes a structured trace to disk.
- **Auditor** (`.claude/agents/fiberlog-auditor.md`) — never touches the app; reads
  the traces and grades them against a fixed rubric.

The separation is the point: the thing that drives the app does not grade the app,
so the feedback can't quietly mark its own homework.

```
fiberlog-react/                     <- your existing project root
├─ .claude/agents/                  <- the two agent files live here
│  ├─ fiberlog-operator.md
│  └─ fiberlog-auditor.md
├─ personas/                        <- one file per user type
│  ├─ clint-quartermaster.md
│  ├─ field-tech-truck.md
│  ├─ amber-accounting.md
│  ├─ spanish-crew.md
│  └─ admin-provisioner.md
├─ traces/<run-id>/<persona>/       <- created by the Operator each run
└─ reports/<run-id>/audit.md        <- created by the Auditor
```

## One-time setup

1. **Node 18+** (you already have it for Vite). `node --version` to confirm.
2. **Add the Playwright MCP server to Claude Code, project-scoped** so it lives in
   `.mcp.json` and travels with the repo:
   ```
   claude mcp add --scope project playwright npx @playwright/mcp@latest
   ```
   (Use the official Microsoft package `@playwright/mcp` — not the
   `@executeautomation` community one.)
3. **Install the browser binaries** if you haven't: `npx playwright install`
4. **Verify**: `claude mcp list` should show `playwright`. Inside Claude Code,
   `/mcp` lists its tools (the `browser_*` ones).
5. **Restart Claude Code** — subagents are loaded at session start, so files added
   on disk aren't picked up until you restart (or create them via `/agents`).
6. **Make a dedicated test account / ideally point at a staging Supabase.** The
   personas write real records (counts, approvals, a test user). Don't run them
   against production data, and don't use your own login — the Operator will pause
   and let you log in yourself in the visible browser window.

## Running it

Start your dev server (`npm run dev`, usually `http://localhost:5173`), then in
Claude Code give the orchestration prompt. The first time, **say "playwright mcp"
explicitly** so it doesn't fall back to running Playwright through Bash:

```
Run the FiberLog QA harness against http://localhost:5173 using playwright mcp.
Use run-id 20260625-1400. For each persona in personas/, invoke the
fiberlog-operator subagent to run that persona, waiting for me to log in when the
browser opens. After all personas finish, invoke the fiberlog-auditor subagent to
audit run 20260625-1400 and show me the report.
```

What happens:
1. The orchestrator runs the Operator once per persona. A visible Chrome window
   opens; when it reaches a login screen it pauses for you to sign in (cookies
   persist for the rest of the session, so you log in once).
2. Each Operator run appends to `traces/<run-id>/<persona>/trace.jsonl`, drops
   screenshots, and writes a first-person `summary.md`.
3. The Auditor reads the whole run and writes `reports/<run-id>/audit.md`:
   verdict per persona, 🔴 broken / 🟡 slow / 🟢 works, coverage gaps, and the
   top 3 fixes by impact.

Run a single persona while iterating:
```
Use the fiberlog-operator subagent to run the spanish-crew persona against
http://localhost:5173, run-id 20260625-1400.
```

Point it at the live build instead of local by swapping the URL for
`https://criddell-blip.github.io/fiberlog`.

## Feature coverage matrix

So you can see "try all features" is actually distributed across the roster:

| Feature                          | Clint | Field Tech | Amber | Spanish | Admin |
|----------------------------------|:-----:|:----------:|:-----:|:-------:|:-----:|
| Bin / sub-location navigation    |   ●   |     ●      |       |    ●    |   ●   |
| Count entry                      |   ●   |     ●      |       |    ●    |       |
| Count correction / edit          |   ●   |     ●      |       |         |       |
| Cycle-count CSV export           |   ●   |            |       |         |       |
| BoxHero stock sync / reconcile   |   ●   |            |       |         |       |
| Submit + save confirmation       |       |     ●      |       |    ●    |       |
| Task / approval workflow         |       |            |   ●   |         |       |
| Review detail + approve/reject   |       |            |   ●   |         |       |
| User management (create/assign)  |       |            |       |         |   ●   |
| Role assignment                  |       |            |       |         |   ●   |
| Sub-location create / edit       |       |            |       |         |   ●   |
| Language toggle + i18n           |       |            |       |    ●    |       |
| Validation / error strings       |       |            |       |    ●    |       |
| Mobile / narrow layout           |       |     ●      |       |         |       |
| Data integrity (in == out)       |   ●   |            |   ●   |         |   ●   |

Empty columns = gaps to add personas for. Add a feature, add a persona (or extend
one) — the Auditor's "coverage gap" section will also nag you when a listed feature
never gets reached.

## Guardrails baked in

- Operator drives the **real UI only** (no direct Supabase/API), so latency and
  friction findings reflect what users feel.
- **No schema changes** and **no editing FiberLog's source** — consistent with the
  testing-phase freeze.
- **No credentials typed by the agent**, no account creation with real identities,
  no destructive ops; it pauses for you on anything sensitive.
- Auditor is **read-only** (`Read, Grep, Glob, Write`-to-reports) and never opens a
  browser, so its judgment is independent of the run.

## Tuning

- **Operator going through Bash instead of the browser?** Say "playwright mcp"
  in the prompt; it sometimes defaults to Bash otherwise.
- **Thin/vague audit?** That means thin traces. Have the Operator capture more in
  the `felt` field and tighten its expected/observed notes — the Auditor can only
  be as sharp as the evidence.
- **Headless overnight runs:** add `--headless` to the Playwright MCP args in
  `.mcp.json` once you're past the interactive-login phase (use stored session
  state so it doesn't need you to log in).
- **Cost:** Operator runs on Sonnet (lots of tool calls), Auditor on Opus (one
  reasoning-heavy pass). Flip either in the agent frontmatter `model:` field.
