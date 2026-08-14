# The Persona Bench — QA persona sweeps (issue #352)

AI tester personas that walk the DEV portal like real members after major
features land. Each persona file defines who they are, their dev login, their
device, scripted journeys, an exploratory charter, and reporting rules.

## Hard rules (every persona, every sweep)

1. **DEV ONLY.** https://rw-dev.vercel.app — never the production site. All
   families are fake; screenshots are safe to attach.
2. **File, don't fix.** Personas report findings as GitHub issues; they never
   change code, data-fix via SQL, or use admin tools to "clean up."
3. **Search before filing.** Check open issues for the same defect first.
   Comment "seen again by <persona> sweep <date>" instead of duplicating.
4. **Volume cap.** Max 5 defect issues per persona per sweep; overflow goes in
   the sweep-summary issue as a findings list.
5. **Labels:** defects → `qa-persona`; UI/UX recommendations → `ux-suggestion`
   (recommendations are batched into ONE issue per persona per sweep, not one
   issue each).
6. **Stay in character for judgment, not for access.** Use the persona's own
   login. View-As is allowed only where the persona file says so.

## Running a sweep

1. Pick the 3–4 personas whose worlds the feature touched (each file has a
   "Run me when" line).
2. One persona at a time (the browser extension supports one driver).
   Phone personas: Chrome device emulation, iPhone-ish viewport (~390×844).
3. Per persona: journeys first (each has an expected outcome — a miss is a
   defect), then the exploratory charter (~10 min), then UX notes.
4. End the sweep with one summary comment or issue: personas run, journeys
   passed/failed, issues filed, what was NOT covered.

## Casting (dev fake-family logins — verify on dev before relying on details;
   full login map lives in Erin's notes)

| Persona | Login | Family |
|---|---|---|
| The Newcomer | newbiel@ | Cuthbert |
| The Half-Day | morning@ (verify a morning-only kid; else recast) | Joy Anderson |
| The Age-Edge Family | erinb@ (Padme Amidala — kids in Willows + Maples) | Amidala/Skywalker |
| The Reviewer | vp@ | Swan |

Phase 2 (planned): one-command sweeps. Phase 3: full bench — see issue #352
for the roster (President, Board Desk, Grove Liaison ×9, Operations Crew,
Coordinator templates, Treasurer, Welcomer, Coverage Claimer, Merch Manager).
