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
| The Newcomer | mollyw@ (reset: `scripts/seed-dev-newcomer.js`) | Weasley — recast 2026-08-21; newbiel@ now leads a class |
| The Half-Day | morning@ (verify a morning-only kid; else recast) | Joy Anderson |
| The Age-Edge Family | erinb@ (Padme Amidala — kids in Willows + Maples) | Amidala/Skywalker |
| The Reviewer | vp@ (or the ACL login afternoon@) | Swan (Park) |
| The President | president@ | Flynn-Fletcher |
| The Board Desk (template) | Communications erinb@ · Membership membership@ · Secretary secretary@ · Sustaining averyl@ | Amidala · Heeler · Miller · Simpson |
| The Treasurer | treasurer@ | Dunphy |
| The Grove Liaison (template ×9) | Saplings waterg@ · Willows crtest-sanders@ · Maples afternoon@ · Cedars registern@ · other groves: recast via View-As | Mathews · Ming Lee · Park · Eleanor Little |
| The Operations Crew (template) | Special Events Liaison mem@ · Supply Coordinator / Cleaning Crew Liaison / Building Opener-Closer: recast via View-As to the Roles & Committees holder | Potter |
| The Coordinator (template) | Gratitude morning@ · Yearbook registern@ · other coordinators: recast via View-As | Joy Anderson · Eleanor Little |
| The Welcomer | undot@ | Gilmore |
| The Coverage Claimer | member@ (verify duties on dev; else recast — undot@ Alice Gilmore holds a PM1 prep + PM2 lead) | Pickles |
| The Merch Manager | the dev Merchandise Manager holder; if unfilled, erinb@ (Comms passes merch_manage) | — |

Full bench (2026-08-15): the four member shapes above + nine role-holder
personas — `persona-president.md`, `persona-board-desk.md`,
`persona-treasurer.md`, `persona-grove-liaison.md`,
`persona-operations-crew.md`, `persona-coordinator.md`,
`persona-welcomer.md`, `persona-coverage-claimer.md`,
`persona-merch-manager.md`. Templates say which seat to run as; note the
seat and any recast in the sweep summary.

## Phase 2 (2026-08-21): one command

```
/persona-sweep reviewer half-day          # named personas, in this order
/persona-sweep --since v20260820b         # pick the 3–4 personas the range touches
/persona-sweep --list                     # casting table + every "Run me when"
/persona-sweep merch-manager --dry-run    # walk + log, file nothing
```

The skill lives in `.claude/skills/persona-sweep/SKILL.md` and enforces this
README: preflight (dev build matches the repo's `?v=`, Chrome connected,
labels exist, open-issue list pulled for duplicate checks), one persona at a
time (journeys → charter ≤10 min → UX notes), filing through the dev
portal's own bug form (`/bugs.html`, screenshot included) then labelling
with `gh`, the 5-defects-per-persona cap, and ONE end-of-sweep issue.

- `qa/personas/pick.js` — `node qa/personas/pick.js --since <ref>` (or
  free-text keywords) ranks personas by their "Run me when" lines + an alias
  table; the skill's `--since` uses it. Heuristic, not a gate.
- `qa/personas/sweeps/` — one log per sweep from `SWEEP-TEMPLATE.md`;
  the only file a sweep may commit (to `dev`, no `?v=` bump).
- Labels: `qa-persona` (defect) · `ux-suggestion` (one batched issue per
  persona) · `sweep-summary` (the end-of-sweep report). A sweep never
  applies `fixed-on-dev` / `verified` / `shipped-prod` — those are the
  fixer's.
- Still needs Erin's Chrome (the extension is the driver). Phase 3 adds
  "run affected personas" to the major-feature ship checklist and looks at a
  headless driver so sweeps stop borrowing her machine.

## Sweep after major merch/spam changes (2026-08-15)

Suggested first full-bench sweep, in this order: **The Newcomer** (public
form → portal week-one path, phone), **The Half-Day** (nothing merch- or
afternoon-shaped leaks onto a morning-only family), **The Merch Manager**
(Orders / Catalog & Stock / Quick Sale, the screened bucket + Not spam, the
homepage Order Merch → Heads-up round trip), then **The Treasurer** (money
numbers reconcile; Cash / Check / PayPal only — no Venmo on any new-payment
chip). ~45–60 min of one driver's Chrome; end with the usual summary.
