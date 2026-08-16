# The Reviewer

**Run me when:** class sign-ups, placement, lottery, sign-up windows, or any
VP / Afternoon Class Liaison surface changes. (Template — run as vp@ or the
ACL login; the two seats share reviewer powers.)

**Who:** The Vice-President mid-season: time-poor, works in short bursts,
lives in the reviewer grids. Trusts the numbers on screen — a wrong count is
worse than a missing feature because she'll act on it (see #343: card counts
vs firsts). Exempt from every window gate and knows it.

**Login:** vp@ (Swan family) · **Device: DESKTOP** (grids). One journey
repeated on phone — reviewers get pinged at the park too.

## Journeys

1. **Schedules grid truth.** Open the reviewer Schedules report during an
   open window. Expected: counts match what drill-downs show; a kid holding
   only Hour-1 of a 2hr-OPTIONAL class shows PM2 as open (not "covered");
   a 2hr-REQUIRED pick still covers both hours; ⚠ marks appear only for
   genuinely out-of-range picks (grove-wins rule) and ineligible assists.
2. **Window exemption.** With the members' window closed, place/edit a pick
   for a family. Expected: reviewer saves succeed; the member-facing state
   doesn't wrongly reopen for members.
3. **Placement round-trip.** Place a kid into a class from the grid, then
   into an Hour-2 slot of a 2hr-optional class. Expected: both save and
   render back correctly after reload.
4. **Reset tool (dev-only button).** Confirm the testing reset button is
   present on dev, works, and states its scope. (On any prod check it must
   be absent — but personas never run on prod; just verify the dev label
   says so.)
5. **Phone spot-check.** Repeat journey 1 on the phone viewport. Expected:
   the grid is scrollable/usable, not clipped under the fixed header.
6. **Greenhouse assistants (standing class).** Class Builder → Morning lens
   → the Greenhouse lane holds "Greenhouse (0–2 room) — assistants" (no
   lead) in every session; open the tile, change "How many assistants" to
   2, save. Expected: the save sticks (no "No morning programming…" error);
   Everyone's sign-ups shows the Greenhouse block in Hour 1 AND Hour 2 with
   "needs 2 more"; Ways to Help has NO "Greenhouse Host" section (retired
   2026-08-16); kids' schedules/pickers still show nothing for Greenhouse.

## Exploratory charter (~10 min)

Stress the exemption seams: View-As a member while a window is closed, mix
reviewer placements with member self-picks for the same kid, run the lottery
path if present on dev, and try the counts everywhere they're summarized
(cards, To Dos, exports) hunting mismatched numbers. Numbers disagreeing
between two surfaces is always a defect — file it even if you can't tell
which one is right.

## UX-notes lens

Anything requiring the reviewer to hold state in her head between screens;
destructive actions (reset, cancel, release) whose confirm doesn't say what
exactly will happen; grids that don't say when data was last refreshed.
