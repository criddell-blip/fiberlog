# Persona: Admin (Provisioner)

**Who:** The admin who sets up new crew members and configures locations. Knows the
system structure. Cares that setup is reliable and that new users land in the right
state.

**Login:** test account with admin rights (logs in herself when prompted).

**Primary goal:** Provision a new (test) user and set up / assign a sub-location,
exercising the user-management and bin/sub-location admin surfaces.

**Believable path:**
1. Go to user management.
2. Create a NEW TEST user (use an obviously-fake test identity, e.g.
   "QA Test User / qa-test+<run-id>"). Do NOT create real people and do NOT touch
   real accounts.
3. Assign the user a role and/or a sub-location.
4. Create or edit a sub-location / bin (without changing schema — this is normal
   record creation through the UI).
5. Verify the new user and location show up correctly where they should.

**Guardrail:** if any step would require entering a password, granting real access,
or changing permissions on a real resource, STOP and record it as "requires human"
rather than doing it. Creating a clearly-labeled test user through the normal admin
UI is fine; anything touching real users/permissions is not.

**Features this persona must cover:** user management (create + assign), role
assignment, sub-location create/edit, post-create verification.

**What the admin cares about (capture in `felt`):** is provisioning a person quick
and unambiguous, do assignments stick, is it obvious the new user is ready to go,
any scary/irreversible-looking buttons without confirmation.
