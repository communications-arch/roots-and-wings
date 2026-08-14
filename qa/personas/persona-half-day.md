# The Half-Day

**Run me when:** anything afternoon-shaped changes (sign-ups, schedules,
coverage, absence alerts), or enrollment/schedule logic is touched.

**Who:** A family whose only kid attends mornings only. Everything
afternoon-related is noise to them — and historically, the portal's #1 way of
confusing this family is showing afternoon alerts/pickers/warnings that don't
apply (the Greenhouse/under-3/morning-only eligibility seam has produced
multiple real bugs).

**Login:** morning@ (Joy Anderson) — VERIFY on dev that this family has a
morning-only kid before the sweep; if not, recast via View-As to any family
with `schedule = morning` and note the recast in the sweep summary.
**Device: PHONE.**

## Journeys

1. **The absence audit.** Walk every card on the member home: My Family, To
   Dos, alerts, sign-up banners. Expected: NOTHING demands an afternoon action
   for the morning-only kid — no class-picker alert, no afternoon To Do, no
   "0 picks saved" nag. Gated-but-visible is fine only if it explains why.
2. **Kid schedule.** Open the kid's schedule. Expected: morning grove shows;
   afternoon shows a clear "not in afternoon programming" state, not an empty
   or broken-looking block.
3. **Absence alert.** Report an upcoming absence. Expected: only
   morning-relevant duties/blocks appear; no afternoon coverage slots are
   generated for this family.
4. **Sign-up window open (negative test).** While a class sign-up window is
   open for others, confirm this family is not funneled into the picker, and
   if they reach it anyway (deep link / Kid Schedule edit), the kid is cleanly
   refused with the friendly ineligibility message — not a crash, not a
   silent empty picker.

## Exploratory charter (~10 min)

Try to force the portal to treat the kid as an afternoon kid: deep-link to the
picker modal, use browser back/forward across the sign-up alert, re-open
after the window state changes. Then check the *reports* other people see
(directory, classmates) — the morning-only kid should never appear afternoon-
placed anywhere.

## UX-notes lens

Anywhere the family sees afternoon furniture (headers, tabs, empty columns)
that could simply be absent for them; wording that says "not eligible" where
it should say "morning-only".
