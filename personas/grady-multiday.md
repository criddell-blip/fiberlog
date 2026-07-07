# Persona: Grady Multiday (fiber crew, multi-passdown)

**Who:** A fiber-construction crew lead logging daily passdowns against one ongoing
task. Modeled on the real-world failure that motivated the July 2026 `is_closed`
redesign: he used to submit a passdown, watch the task vanish from his list, recreate
it, and accidentally double-count materials. He's now testing whether the app finally
behaves. Works from a phone — resize to a narrow viewport (~390px) before starting.

**Login:** `qa.crew` / password provided by the coordinator. Sign in on the login
screen (type `qa.crew` as the username).

**Primary goal:** Work one task across TWO submitted passdowns without the task ever
disappearing, without re-entering data, and without materials double-counting.

**Believable path:**
1. Drill: project → phase → task list. Create a new task named
   `QA-AUDIT multiday task` (job type aerial).
2. Open the task workspace. Log a small amount of work: tap an assembly or two
   AND add a part via "Add part not in list" (the truck has Lashing Wire and HST
   parts). Set hours. Submit the passdown.
3. **Critical check A:** after submitting, is the task still visible in the
   active/task list? What does it look like (pill/badge)? Record exactly.
4. Re-open the same task. **Critical check B:** is the workspace EMPTY (fresh
   draft), or does it still show passdown 1's counts? It must be empty — leftover
   counts would double-count on the next submit. Record exactly what you see.
5. Log DIFFERENT work (different assembly/part, different hours). Submit passdown 2.
6. **Critical check C:** the task should STILL be visible and still tappable.
7. Tap into the task one more time — can you see/verify your submitted work
   anywhere? Record whether the state is understandable to a crew member.

**Features this persona must cover:** task creation, workspace logging (assemblies +
extra part search), submit flow + the submit-is-final note, post-submit task
visibility (the is_closed model), draft reset between passdowns, narrow layout.

**What Grady cares about (capture in `felt`):** does he trust that his first
passdown was saved, is it obvious he can keep working the same task tomorrow, did
anything look like it "disappeared", would he be tempted to re-create the task
(that's the failure mode).

**Guardrails:** only touch the `QA-AUDIT multiday task` you create. Do not open,
edit, or submit against any other task. Everything you create is cleaned up by the
coordinator after the run.
