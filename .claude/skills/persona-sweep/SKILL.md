---
name: persona-sweep
description: Run a Persona Bench QA sweep of the DEV portal (issue #352) — one or more tester personas from qa/personas/ walk rw-dev in the user's Chrome, file defects via the dev bug form, and post one sweep summary. Usage - /persona-sweep reviewer half-day  ·  /persona-sweep --since v20260820b  ·  /persona-sweep --list
---

# /persona-sweep — one-command Persona Bench sweep

You are about to play QA tester personas against the **DEV** portal. Read
`qa/personas/README.md` first (hard rules), then the persona files named
below. Everything in this skill is subordinate to the README's hard rules:
**DEV ONLY · file, don't fix · search before filing · volume caps · labels.**

## 0. Parse the arguments

- `--list` → print the casting table from the README and the `Run me when`
  line of every `qa/personas/persona-*.md`, then stop.
- `--since <git-ref>` → run `node qa/personas/pick.js --since <ref>` and take
  its top 3–4 personas (show the user the ranking and which you chose).
- Otherwise each argument is a persona slug (`reviewer`, `half-day`,
  `merch-manager`… = `qa/personas/persona-<slug>.md`). Unknown slug → list
  the valid ones and stop.
- Optional `--phone-only` / `--desktop-only` restrict device passes;
  `--dry-run` does everything except filing issues (findings go in the
  summary only).
- No arguments → ask which personas (or suggest `--since <last prod tag>`).

## 1. Preflight (stop on any failure — tell the user what to fix)

1. `git fetch` and confirm the working tree is clean of *your* edits —
   personas never change code; if the user has uncommitted work that is
   fine, just don't touch it.
2. Confirm rw-dev is serving the commit under test: `curl -sL
   https://rw-dev.vercel.app/members.html | grep -o 'script.js?v=[0-9a-z]*'`
   and compare with the `?v=` in the repo's `members.html`. Mismatch →
   say so and ask whether to `npm run deploy:dev` first (foreground).
3. Browser: load the Chrome tools in ONE ToolSearch call
   (`tabs_context_mcp, navigate, computer, read_page, find, form_input,
   get_page_text, resize_window, gif_creator, tabs_create_mcp,
   tabs_close_mcp, read_console_messages, list_connected_browsers,
   select_browser`). Call `list_connected_browsers` → `select_browser` if
   needed → `tabs_context_mcp`. If no browser is connected, tell the user
   to enable the "Claude in browser" tab and stop.
4. `gh auth status` works and labels `qa-persona`, `ux-suggestion`,
   `sweep-summary` exist (`gh label list`). Create a missing label rather
   than filing without it.
5. Pull the open-issue list once: `gh issue list --state open --limit 200
   --json number,title,labels` — this is your duplicate check for the whole
   sweep (refresh it before filing if the sweep runs long).
6. Create `qa/personas/sweeps/<YYYY-MM-DD>-<slugs>.md` from
   `qa/personas/sweeps/SWEEP-TEMPLATE.md` and keep it updated as you go — if
   the session dies mid-sweep the log is the record.

## 2. Run each persona, one at a time, in the order given

For each persona file:

1. **Become them.** Read the whole file. Note login, family, device, and any
   recast/View-As permission. Open a NEW tab for the persona (close the
   previous persona's tabs). Device: desktop personas keep the window as is;
   phone personas `resize_window` to ~390×844 and stay there for the whole
   persona (except where a journey says "repeat on desktop").
2. **Sign in.** Google One Tap / the Google button is an iframe the
   extension cannot click and you never type credentials — ask the user to
   click "Sign in as …" once (learned 2026-08-21), then continue. Personas
   are then reached with the dev **View-As** dropdown (canImpersonate is
   everyone on dev); record "via View-As from <login>" in the log row.
   Verify the header greets the right family before doing anything else —
   a wrong identity invalidates every finding.
3. **Journeys first, in order.** Each journey has an *Expected* outcome.
   Record PASS / FAIL / BLOCKED per journey in the sweep log with one line of
   evidence. A miss is a defect → go to §3. Never "fix" state to make a
   journey pass; if dev data makes a journey impossible (e.g. no open
   window), mark BLOCKED and say what data it needed.
4. **Exploratory charter (~10 min cap).** Follow the charter's prompts; use
   weird orders of operations, back button, resize, double-submit, reload
   mid-flow. Note surprises. Stop at 10 minutes even if you're enjoying it.
5. **UX-notes lens.** Collect recommendations (not defects) as you go — they
   are batched into ONE `ux-suggestion` issue per persona at the end of that
   persona (skip the issue if there are none).
6. **Record the GIF** of the journeys with `gif_creator` named
   `sweep-<date>-<slug>.gif` when the journeys are more than a couple of
   clicks — attach nothing from prod, ever (you are on dev; still, check the
   URL bar before every screenshot).

## 3. Filing a defect (the moment you confirm one)

1. **Reproduce it once more** from a clean state (reload, redo). If it does
   not reproduce, it goes in the summary as "seen once, not reproduced" —
   not as an issue.
2. **Duplicate check** against the open-issue list (title words + where).
   If it exists: `gh issue comment <n> -b "Seen again by <Persona> sweep
   <date> on rw-dev v<stamp>: <one line of what you saw>"` and move on.
3. **Volume cap:** max **5** defect issues per persona per sweep. The 6th+
   go into the summary's findings list only.
4. **File through the dev portal's own bug form** while signed in as the
   persona: https://rw-dev.vercel.app/bugs.html → "What happened" (steps →
   expected → actual, 3–6 lines, start with the persona tag, e.g.
   `[The Half-Day] …`), "Where", attach the screenshot. The form uploads
   the screenshot and opens the GitHub issue with a "Reported by … via dev
   portal" footer. (If the form is itself broken, file with
   `gh issue create --label qa-persona` and say the form was broken in the
   summary — that is a defect too.)
5. Then label it: `gh issue edit <n> --add-label qa-persona`. Add the issue
   number to the sweep log.
6. **Never** label anything `fixed-on-dev`, close issues, or edit other
   people's issues beyond a "seen again" comment.

## 4. End of sweep

1. Finish the sweep log: personas run (with seat/recast), journeys
   PASS/FAIL/BLOCKED table, issues filed (numbers), "seen again" comments,
   UX issues, what was NOT covered and why (skipped personas, blocked
   journeys, data gaps).
2. Post ONE summary issue titled `Persona sweep <date>: <slugs> on
   v<stamp>` with label `sweep-summary`, body = the log's summary section
   (no screenshots needed). If a sweep produced zero findings, still post
   it — a clean sweep is information.
3. Commit the sweep log to `dev` (`qa/personas/sweeps/…`) — that is the only
   file a sweep may commit. No `?v=` bump (no script/style change).
4. Reply to the user with: the summary link, the issue numbers, and the
   three most important findings in plain language. Then stop; fixing is a
   separate session's job (claim-the-issue convention in CLAUDE.md).

## Reminders that bite

- One persona at a time; the extension has one driver.
- `rw-dev` caches aggressively (`rw_sheets_cache`): after any data change by
  the persona, hard-refresh before calling something "not updated".
- A number that disagrees between two surfaces is ALWAYS a defect, even if
  you can't tell which is right.
- Avoid any click that opens a native `alert/confirm` unless the journey
  requires it — dismiss via the page if it happens; note it. Test artifacts
  you created (a poll, a pick) should be reverted through the UI; when the
  only UI path is a native confirm, removing YOUR OWN artifact via the dev
  DB is allowed — say so in the log. Never touch data you did not create.
- Windows: `resize_window` rejects sizes that don't fit the screen — 1024×700
  desktop and 390×700 phone both work on Erin's laptop.
- View-As only where the persona file says so; otherwise stay in your own
  login even when it would be "easier".
