# The Coverage Claimer

**Run me when:** absences, the Coverage Board, coverage notifications,
duty derivation (api/_duties.js), points/participation, or My
Responsibilities change.

**Who:** A regular member with real duties (a class to lead or assist, a
cleaning area) who is generous with her Wednesdays. She both files absences
and picks up other people's slots. She's been burned before: a claim that
vanished, a slot claimed twice, a "Covering:" row that made her look busy
when she wasn't (#291). She trusts the bell more than the board.

**Login:** member@ (Pickles) — VERIFY on dev that My Responsibilities shows
at least one lead/assist/cleaning duty for the current session; if not,
recast via View-As to any family with duties (dev notes confirm undot@ Alice
Gilmore holds a PM1 prep + PM2 lead) and note the recast. **Device: PHONE.**
Use a second family via View-As for the two-party journeys.

## Journeys

1. **As the absent person.** My Responsibilities → "I'll Be Out" (or the
   Coverage Board header's "Absence Alert"). Pick a co-op day; the modal
   pre-lists her actual duties per block; leave one slot blank and name a
   replacement for another. Expected: the named person's slot is created
   already covered (they get a bell/push); the blank one appears under
   "Needs Coverage" on the Coverage Board; her own slots show no "I'll Cover
   This" button for her; the badge count on the board matches open slots.
2. **As a claimer.** View-As a second family. Coverage Board → the day tab
   with the badge → "I'll Cover This". Expected: the slot moves to "Covered
   (N)" with her name, the tab badge drops, her My Responsibilities gains a
   "Covering:" row for that day only, and the bell shows the slot_claimed
   notification to the absent family.
3. **Release, then re-claim.** As the claimer, Cancel the claim; as a third
   family (or the same one), claim it again immediately. Expected: the slot
   is back under "Needs Coverage" with the tab badge up by one; no ghost
   claim, no double "Covered by"; the second claim sticks after reload.
   (A release sends no fresh notification today — that is current
   behavior; a UX note, not a defect.)
4. **Points.** Ways to Help → "Your year so far". Expected: "Covered N slots
   for others" reflects the claim; the note that coverage isn't in the
   weighted total holds (the number doesn't jump the milestone track).
5. **Not occupied.** As the claimer, on the covered day check the volunteer
   sign-up panel. Expected: covering one week does not mark her hour as
   occupied for the session (#291).
6. **Assist the Greenhouse.** Session schedule (or Everyone's sign-ups) →
   the Greenhouse (0–2 room) block → "needs N more — sign up" on Hour 1.
   Expected: it books ONLY Hour 1 (Hour 2 stays open), My Responsibilities
   gains "Assisting “Greenhouse (0–2 room) — assistants”", the Leader
   column stays "—" (assistants only, no lead), and the same "you're
   already with…" clash rules apply as any other morning class.

## Exploratory charter (~10 min)

Race it: open the same open slot in two View-As sessions and claim from
both — exactly one wins and the loser gets "Slot already claimed", not a
silent success.
Edit an absence after a slot was claimed (claims must survive the edit —
#179); cancel an absence with claims (the "Covering:" row must leave the
claimer's My Responsibilities); claim a "Board only"
opener/closer slot as a non-board member (button absent; deep-link refused).
Then check summer-break rules: the board hides with no absences but shows
when next season's rows exist.

## UX-notes lens

Board days that don't say which session they belong to; "Covered by" with
no way to message that person; a Cancel that doesn't say the slot goes back
to open for everyone.
