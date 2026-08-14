# The Age-Edge Family

**Run me when:** age bands, grove placement, eligibility warnings, class
sign-ups, or assistant flows change. (This persona exists because the
grove-vs-literal-age seam produced #346/#347/#349 — a kid placed in a grove
outside their literal age band tripped warnings everywhere.)

**Who:** A family whose kids sit at the awkward edges: a kid placed UP a
grove (young for the room), a kid placed DOWN (old for the room), a kid
exactly on a boundary birthday (12 → assistant eligibility). They signed up
on time, did nothing wrong, and get flagged anyway — or used to.

**Login:** erinb@ (Padme Amidala — kids across Willows + Maples). Before the
sweep, check the kids' birth dates vs their groves on dev and note which kid
is the edge case; if none is edgy enough, recast via View-As to a family
where a kid's literal age falls outside their assigned grove's typical band.
**Device: DESKTOP.**

## Journeys

1. **Grove-wins picker.** Open afternoon sign-ups; rank a class labeled for
   the kid's ASSIGNED grove where the kid's literal age is outside the class's
   stated range. Expected: highlighted as in-range, NO warning note, saves
   without an out-of-range confirm.
2. **Grove-wins downstream.** Reviewer surfaces aside, check the family-
   visible ones: Kid Schedule and any printed/exported view. Expected: no ⚠
   out-of-range mark, no `(!age)` flag for grove-matched picks.
3. **Assistant boundary.** For a kid in Cedars/Pigeons: the Assistant option
   appears and saves. For a kid NOT in those groves (any literal age, even
   12+): selecting Assistant fires the blocking alert, snaps back to 1st
   choice, and the save carries no assist flag.
4. **No-grove fallback.** Via View-As (allowed for this persona), find or
   note a kid with a birth date but NO grove assignment. Expected: literal
   age still governs their warnings (the fallback path stayed alive).

## Exploratory charter (~10 min)

Hunt other places literal age leaks past the grove: class detail rosters,
classmates modals, CSV exports, submission-form live age spans, anything
showing "(age)" next to a name. Compare a boundary kid (birthday this month)
against these surfaces. Try saving picks, changing the kid's rank order, and
re-opening — warnings should be stable, not appear-on-second-open.

## UX-notes lens

Warnings that state THAT something is out of range without saying WHY or what
to do; any place grove and literal age are shown together without a hierarchy.
