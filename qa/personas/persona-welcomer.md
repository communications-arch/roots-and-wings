# The Welcomer

**Run me when:** registrations, the new-family pipeline, the Welcome List,
Upcoming Events, the install/quickstart pages, My Community, or anything a
new family sees in week one changes.

**Who:** The Welcome Coordinator — the friendly first call. She works a
short list (who's new, who's been welcomed, who still needs orientation),
shares one link, and wants to know which co-op dates are coming so she can
line up a greeter. Not board: she should see the community snapshot like
everyone else, not the Membership report. Her worst bug is a new family
that never shows on her list.

**Login:** undot@ (Gilmore family) · **Device: PHONE** (she texts families
from it). Journey 2 also on desktop.

## Journeys

1. **To Do → Welcome List.** To Do card shows "To Welcome" and "Orientation"
   counts (hidden at zero). Tap each. Expected: the Welcome List opens
   pre-filtered to that stage; rows shown = the count; the top pills read
   To Welcome / Orientation / Done with the same numbers; earlier stages
   float to the top.
2. **Stage round-trip.** Mark a New family Welcomed, then mark Orientation
   done, then undo both. Expected: badge flips New → Welcomed → Oriented,
   the To Do counts move each step without a reload, and undo restores the
   prior stage (dates shown are the Indianapolis local day).
3. **Help new families get connected.** On the To Do card, the share block:
   the link reads rootsandwingsindy.com/install and "Copy link" copies it
   (paste to verify). Expected: the link points at PROD even on dev (new
   families never open dev), and copy gives visible feedback.
4. **Upcoming Events.** The Upcoming Events card lists real co-op dates
   with the "line up a current member to greet" note. Expected: dates are
   future, in order, and match the members Calendar.
5. **Directory accuracy for a newcomer.** Pick the newest family on the
   list; find them in the Directory and My Community's roster. Expected:
   same family name, kids, and track everywhere; a family that registered
   today already appears (or the list says when it will).

## Exploratory charter (~10 min)

Time the outreach nudge: "Reach out to new families — co-op starts soon"
should show only in the 14 days before Session 1 starts (and vanish after);
if the dev calendar is outside that window, note that it was NOT exercised
rather than calling it broken. Then look for things she should not have:
the Membership report, onboarding tools, waiver actions — a Welcome
Coordinator is a committee role. Try the list with zero new families (the
"No new families this season yet" state) via View-As a season with none, if
dev allows.

## UX-notes lens

Stage words that mean the same thing in two places with different labels
(Welcomed vs Orientation vs Oriented); a copy button with no "Copied!";
anything that makes her scroll past done families to find new ones.
