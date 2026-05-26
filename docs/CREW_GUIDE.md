# FiberLog — Crew Guide

For field crews logging their daily work. **Manager** features are in a separate guide.

> 🌐 Open in your browser: **https://criddell-blip.github.io/fiberlog/**
> Works on phone, tablet, and laptop. Saves as you go — you won't lose work if your signal drops.

---

## The whole day in 5 steps

1. **Sign in** with your username (firstname.lastname) and password
2. **Load parts** from the warehouse onto your truck (📦 *My Stock*)
3. **Pick your task** (Project → Phase → Task, or Project → Site → Task for infra crew)
4. **Log what you used and how many hours** during the day — it auto-saves
5. **Submit your day** when you're done

That's it. Manager reviews it, approves it, and the parts you logged transfer from your truck into the project's bucket automatically.

---

## Signing in

`[screenshot: Login screen]`

1. Tap **Sign in**
2. Username is your **firstname.lastname** (no spaces — e.g. `chad.sperry`)
3. Password — first time is whatever your manager set
4. Tap **Sign in**

If it doesn't work:
- Wrong password → ask your manager to reset it
- "Could not connect" → check your phone signal, then tap **Retry**

> 💡 Your username gets remembered next time. Only the password is asked.

---

## 📦 My Stock — loading parts onto your truck

Tap **My Stock** in the sidebar (or the 📦 button on phone) to see everything currently on your personal truck.

`[screenshot: My Stock page]`

**To load parts** (warehouse → your truck):

1. Tap **＋ Load parts**
2. Search the part you want (SKU, name, or scan barcode)
3. Type a quantity
4. Pick the warehouse it's coming from
5. Tap **Load**

The part now shows on your truck and is yours to use.

**To return unused parts** (your truck → warehouse):

1. On any part row, tap **Return**
2. Type how many you're returning
3. Pick the warehouse
4. Tap **Return**

> ⚠️ **Don't forget to return unused parts at end of day.** Anything you "have" but didn't use needs to go back to the warehouse, or your truck inventory drifts away from reality.

---

## Finding your work

The sidebar shows your projects. Tap a project to expand it.

### If you're fiber crew

You see: **Project → Phase → Task**

Example: `Heber → Phase 2 → Set new pole 1247`

### If you're infra crew

You see: **Project → Site → Task**

Example: `Fixed Wireless → Alexis Tower → Replace UPS battery`

Sites have type icons: 📡 = wireless, 🏢 = fiber-served building.

### Creating a new task

If you're starting work that isn't already on the list, tap **＋ New task** (inside a phase or site) and fill in:
- **Name** — what you're doing
- **Type** — pick the closest job type
- **Scope notes** (optional) — anything the manager should know about the job

---

## Logging your day in a task

Tap a task to open it. This is your workspace for the day.

`[screenshot: Task workspace]`

### Counting kits (assemblies)

The tabs at the top group **kits** of parts that go together (e.g. "Down guy kit" pulls a specific set of bolts, washers, anchor).

- Tap the **＋** next to a kit to count one
- Tap **−** to remove one
- The kit pulls all its parts onto your day's tally automatically

> 💡 Footage kits (fiber, strand, conduit) take a number instead of tapping ＋ — type how many feet.

### Adding a part not in any kit

Sometimes you use something that isn't part of a standard kit (e.g. a replacement antenna, an unusual bracket).

1. Scroll to the bottom and tap **＋ Add part not in list**
2. Search and pick the part
3. Type a quantity

It shows in your day's tally just like kit parts do.

### Hours worked

The bottom of the workspace has hours. Default is 8. Use **＋** / **−** to adjust.

### Notes (optional)

Anything the manager should know? Damage, weird site conditions, parts you couldn't find, etc. — drop a note. Shows up with the submission.

> 🔄 **It auto-saves.** You can close the app, restart your phone, or hand off to another crew — your counts are saved against the task. The next time you (or whoever takes over) opens the task, everything's there.

---

## Submitting your day

When you're done for the day:

1. Tap **Submit day** (orange button at the bottom)
2. Review the summary — adjust any quantities or remove anything by mistake
3. Tap **Submit day ✓** again to confirm

`[screenshot: Submit-day summary]`

After submitting:
- The task disappears from your "active" list and moves to **Submitted (awaiting approval)**
- The manager sees it in their queue and either approves or flags it
- When approved, the parts you logged transfer from your truck → the project's bucket automatically

---

## Seeing what you already submitted

Pending and completed tasks are still visible — just tap them to see a **read-only summary** of what you turned in:

- Hours
- Parts used (each one with quantity)
- Notes you wrote
- Status (Pending / Approved / Flagged)
- Manager's note if any

You can't edit a submitted task. If you need to change something, ask the manager to flag it (see below).

---

## If your manager flags your submission

A flag means the manager needs you to fix something — wrong part qty, missing piece, etc.

When this happens:
- The task reappears in your active list (the sidebar)
- Open it and you'll see what was off — usually in the manager's flag note
- Fix the counts (or add the missing parts)
- **Submit day** again

It goes back to the manager's queue, hopefully approved this time.

---

## Sign out and theme

Tap your **initials circle** at the top of the sidebar (or the avatar in the top bar on phone) to bring up the sign-out screen.

From there you can also:
- 🌙 / ☀️ — toggle dark / light mode

---

## Quick troubleshooting

| Problem | Fix |
|---|---|
| Submitted task isn't showing in my sidebar | Sidebar hides submitted tasks. Look in the project → phase/site task list, in the "Submitted (awaiting approval)" section. |
| I added a part via "Add part not in list" but it didn't save | Make sure you tapped **Submit day ✓** to confirm. If you only tapped "Submit day" once you saw the review screen, that opens the summary — you need to confirm with the second tap. |
| My truck shows wrong stock numbers | If the manager just ran a Sonar import or approved someone's day, refresh the page — My Stock doesn't update in real-time yet. |
| I can't find my project | Maybe it was archived. Ask your manager. |
| Wrong project showed up — task should be under a different project | Open the task → there's a project picker in the workspace header. Pick the right one and submit. Manager-side approval will route materials to the right bucket. |
| App is slow / acting weird | Hard refresh (Ctrl+Shift+R or pull-to-refresh on mobile). Then sign back in. |

---

## Who to ask

- **Trouble with the app, password, or seeing the wrong stuff:** Chris (or your manager)
- **Question about which kit to use, what parts to grab:** your lead crew member

---

*Last updated: May 2026*
