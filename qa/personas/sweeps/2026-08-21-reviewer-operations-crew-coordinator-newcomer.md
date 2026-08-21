# Persona sweep — 2026-08-21 — reviewer, operations-crew, coordinator, newcomer

- **Dev build:** rw-dev `script.js?v=20260821a` · dev commit `ea8a4cd`+ (phase-2 commit)
- **Trigger:** `--since 46bf6a9` (08-19 hotfix → today): #363–#372, To Do notifications (#368), lottery undo (#370), Welcome List, Collaboration polls (#360), Persona Bench phase 2
- **Driver:** Erin's Chrome (Browser 1), Claude (Fable 5) at the wheel · **Mode:** full
- **Personas (in order):** The Reviewer (vp@) · The Operations Crew (seat TBD) · The Coordinator (seat TBD) · The Newcomer (newbiel@, phone)

## Journeys

| Persona | # | Journey | Result | Evidence / issue |
|---|---|---|---|---|
| The Reviewer (vp@, recast via dev View-As from erinb@) | 1 | Schedules grid truth | PASS (partial) | pills = rows (2 unplaced = 1 no-picks + 1 missing-1st; NO 2ND 12/12); assist-leaf marks only, no false ⚠; no 2-hour class in S1 to check the 2hr-optional rule |
| The Reviewer | 2 | Window exemption | BLOCKED | only closed session (S4) has no classes scheduled |
| The Reviewer | 3 | Placement round-trip | PASS | Eloise Bridgerton → Potions PM2 saved, panel auto-closed (#365), pills updated live, persisted after reload; reverted |
| The Reviewer | 4 | Reset tool (dev-only) | PASS | "Reset sign-ups (testing)" present in Builder sign-ups panel (not clicked) |
| The Reviewer | 5 | Phone spot-check | PASS | grid scrolls sideways, sticky name column; ~2 rows visible (UX #375) |
| The Reviewer | 6 | Greenhouse assistants | PASS | tile in Morning lane; assistants 2→3→2 saved; Everyone's sign-ups shows Greenhouse H1 (Wilma, needs 1 more) + H2 (needs 2 more); no Greenhouse Host in Ways to Help |
| The Operations Crew — SEL (mem@ via View-As, desktop) | 3 | Seats + spaces | PASS (partial) | To Do "New special-event sign-ups" = 1 = review modal rows; Dance space: added a Poll section (#360) → rendered, vote open; test poll removed via dev DB afterwards; binoculars visibility toggle NOT exercised (native confirm risk) |
| The Operations Crew — Supply Coordinator (luisar@, desktop not phone) | 1 | Closet admin / restock To Do | FAIL | To Do hidden + pill 0 while item 116 flagged → #376 (loader reads grouped API as array) |
| The Operations Crew — Cleaning Crew Liaison / Opener-Closer | 4–5 | — | SKIPPED | seats unfilled on dev |
| The Operations Crew — SEL | 2 | Event lifecycle | NOT RUN | time |
| The Newcomer (newbiel@ via View-As, phone 390px) | 1 | First sign-in → orientation | PASS | responsibilities warning → sign-up dropdowns; kid schedule on first screen; Billing copy misleading (UX #378) |
| The Newcomer | 2 | Sign the waiver | BLOCKED | no waiver pending for this family |
| The Newcomer | 3 | Find my kids' schedule | PASS | Kid Schedule card on My Family: grove + class + teacher, afternoon picks with 1ST/BACKUP chips and "pending lottery" |
| The Newcomer | 4 | Afternoon sign-ups | PASS (read-only) | window open; per-class "Sign up Anne as 1st choice / Backup / Save" present; existing picks shown with ✕; not re-saved |
| The Coordinator | — | — | NOT RUN | time (sweep ran ~75 min) |

## Defects filed (qa-persona)

- #373 — Schedules S4 Kids: tab badge "83 UNPLACED" vs all-zero pills; "+ Fill" opens an empty picker (The Reviewer)
- #374 — Schedules kid picker N/max counts ALL ranks (Potions 16/10 vs 8 firsts) — #343 class of bug, reviewer misled (The Reviewer)
- #376 — Supply Coordinator "Buy / restock supplies" To Do can never appear (grouped API vs array loader) (Operations Crew)
- #377 — My Community: 85 kids, 77 in "OTHER", 7 "both" vs Schedules showing ~80 afternoon placements (Newcomer)

## Seen again (commented, not re-filed)

## UX suggestions (one issue per persona)

- #375 — The Reviewer (5 notes: phone modal density; window past end date still Open; stale session banner; #page-workspace deep link; empty To Do card beside 40-unplaced report)
- #378 — Operations Crew + Newcomer (7 notes: review-modal wrap; stray binoculars; "8 votes · sent to 7"; Billing copy to a registered family; empty avatar; phone header stack; recast The Newcomer)

## Not covered

- The Coordinator — not run (time).
- Operations Crew: SEL event lifecycle (J2), Cleaning Crew Liaison + Opener/Closer seats (unfilled on dev), Supply journey run on desktop not phone.
- Reviewer J2 (window exemption) blocked: only closed session has no classes; 2hr-optional rule unverifiable in S1 (no 2-hour class).
- Newcomer waiver journey blocked (no pending waiver); no fresh newcomer family on dev (see recast note in #378).
- Sign-in: Google One Tap can't be driven by the extension — Erin clicked once; all personas were reached via dev View-As from erinb@ (recasts noted per row).
- Seen once, not filed: stale "Your session has expired" banner persisted after sign-in until reload.

## Summary (paste into the `sweep-summary` issue)

First Persona Bench sweep (phase 2 runbook), rw-dev v20260821a, driven in Erin's Chrome. 3 of 4 planned personas ran (Reviewer, Operations Crew ×2 seats, Newcomer); The Coordinator deferred for time. Journeys: 9 PASS (2 partial), 1 FAIL, 2 BLOCKED, 2 skipped/not run.

Defects (qa-persona): #373 Schedules S4 "83 unplaced" vs zero pills + empty picker · #374 Schedules kid picker counts backups as seats (reviewer told Potions is 16/10 when it's 8/10) · #376 Supply Coordinator restock To Do can never show · #377 My Community kid buckets (77 "other").
UX (ux-suggestion): #375 (Reviewer) · #378 (Ops + Newcomer).
Most important: #374 (a reviewer acting on wrong fullness numbers is the #343 failure mode again) and #376 (a role's only To Do is silently dead).
Owed next: run The Coordinator; recast The Newcomer to a genuinely new dev family; fix the sign-in step in the runbook (One Tap needs a human click).
