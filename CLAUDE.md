# Roots & Wings Indy — house rules for Claude sessions

Members portal for a homeschool co-op. LIVE at https://www.rootsandwingsindy.com
(real families depend on it — treat prod with care). Static HTML + one big
`script.js` + 12 Vercel serverless functions + Neon Postgres. Branches:
`dev` (work here) → `master` (prod, Erin-approved ships only).

## Getting started (new person / new Claude session on a fresh machine)

1. **Get access from Erin:** a GitHub collaborator invite to
   `communications-arch/roots-and-wings`, and the `.env.local.dev` file sent
   privately (it holds the DEV database connection — never commit it; the
   repo's `.gitignore` already excludes it). You do NOT need `.env.local`
   (that's Erin's prod-side file) or any Vercel access to fix bugs.
2. `git clone https://github.com/communications-arch/roots-and-wings.git`
   → drop `.env.local.dev` in the repo root → `npm install`.
3. `git checkout dev` — all work happens on `dev`. Never push to `master`.
4. `npm test` — the regression suite must be green before you touch
   anything (and the pre-push hook re-runs it for you).
5. Open a Claude Code session in the repo folder; this file loads
   automatically. Read the "Working the bug list" section below before
   your first fix. Open bugs live at
   https://github.com/communications-arch/roots-and-wings/issues.
6. Dev-DB reads/scripts: `node --env-file=.env.local.dev scripts/<script>.js`.
   Migrations: `node --env-file=.env.local.dev scripts/run-migration.js`
   (runs `scripts/migrate.sql` against DEV — additive statements only).
7. Pushing to `dev` builds a Vercel preview automatically, but re-pointing
   the stable dev URL (https://rw-dev.vercel.app) needs `npm run deploy:dev`
   from a machine whose Vercel CLI is logged into the co-op's Vercel account.
   Unless Erin has added you to that Vercel team, comment on the issue after
   pushing and ask Erin (or her Claude) to deploy dev for verification.
   Portal-side verification uses the dev portal's fake families (Erin has
   the login map).

## Hard rules (no exceptions)

1. **NEVER read or write the production database directly.** Local DB access
   is the DEV database only, via `.env.local.dev`. All prod data/schema
   changes go through `scripts/migrate.sql`, which auto-runs on every deploy.
2. **The migration runner REJECTS destructive SQL** (DELETE FROM, DROP,
   TRUNCATE, ALTER…TYPE, RENAME). Additive/idempotent statements only.
   Destructive repairs go in `scripts/migrate-destructive.sql` (manual,
   coordinated) — or restructure as an UPDATE the live code can act on.
3. **Dev first.** Commit to `dev`, deploy with `npm run deploy:dev` (run it
   FOREGROUND — backgrounding truncates before the alias is set), verify on
   https://rw-dev.vercel.app. **Only Erin approves prod ships** (master =
   fast-forward of dev, then `vercel --prod --yes`, then curl-verify the
   `?v=` on www — the master-push webhook may NOT auto-build).
4. **12-function ceiling:** exactly 12 non-underscore files in `api/`.
   New endpoints ride an existing file as a new `action`.
5. **Cache-bust every `script.js`/`styles.css` change:** bump the `?v=`
   token in ALL FIVE html files (bugs, index, members, quickstart, support)
   in the SAME commit. Next letter in the date-letter sequence.
6. **`npm test` (full regression suite) must pass before every push.**
   The pre-push hook enforces it; never bypass hooks.

## Working the bug list with other Claudes

Multiple Claudes share this repo (Erin's sessions, Colleen's sessions, and a
7am ET cloud triage routine that commits to dev on its own).

- **Claim before you fix:** comment "working on this" on the GitHub issue
  (repo `communications-arch/roots-and-wings`) before touching code, and
  don't take issues someone else has claimed within the last day.
- **`git fetch` + rebase onto `origin/dev` before every push** — the other
  sessions' commits (and the ?v= bumps) land constantly.
- Small commits, one issue per commit where possible; reference `#NNN`.
- Labels: `fixed-on-dev` when it's deployed to dev → Erin/Colleen verify →
  `shipped-prod` when it rides a prod ship → close as `verified`.

## Code idioms that bite

- `script.js` is ONE ~40k-line IIFE. Top-level code runs ~26k lines before
  the data loaders — an unguarded dereference at boot kills the WHOLE portal
  for everyone. Exercise changes in a browser on dev; "parses OK" is not
  tested. (Guard pattern: `typeof X === 'function' && X(...)`.)
- **Enrollment reads are transition-tolerant:** any query reading class
  sign-up picks counts a kid UNLESS they have an explicit non-enrolled row —
  `NOT EXISTS (… status <> 'enrolled')`, never strict
  `EXISTS (… status = 'enrolled')`. Several bugs came from strict filters.
- **Family identity = `family_email`** (the R&W alias). Never join or match
  on family_name. People with emails match by email ONLY (no name fallback
  that could hand a duty to a same-named stranger); name matching uses
  first+last tokens (`personNamesMatch`), not exact strings.
- **Dates:** the server's "today" is America/Indianapolis. Any string
  comparison against an API date field must `slice(0, 10)` BOTH sides
  (full ISO timestamps sort wrong against bare dates — this shipped a
  launch-day outage). Parse date-only strings as local days.
- **Escape every sink.** All user text through `escapeHtml`/`escapeAttr`
  before `innerHTML`. A stored-XSS reached prod once.
- **Icons:** `ICON_SVG` (purple outline SVGs) = actions; `BRAND_ICONS`
  accents = meanings — ONE mark per meaning site-wide, no emoji icons,
  discuss new assignments with Erin. `ageGroupIconHtml` needs the
  Capitalized grove name (lowercase silently renders nothing).
- **Styles:** check the catalog at the top of `styles.css` and reuse
  existing classes (`sc-btn` chips, `renderReportModal`, the print-modal
  `openPrintIframe` pattern) before writing new CSS. Gold = action CTAs,
  purple = identity.
- **Age bands overlap BY DESIGN** (Sassafras 3–6 etc.). Do not reconcile
  display ranges with `groupForAge()` — `scripts/test-age-ranges.js` guards.
- Class sign-up windows: status `open` → `closed` → `locked`. Reviewers
  (VP + Afternoon Class Liaison) are exempt from every window gate;
  members are gated server-side — mirror gates client-side for UX only.

## Dev environment

- Dev portal: https://rw-dev.vercel.app — fake families only (login map in
  Erin's notes; ask her). Super-user View-As works for any dev family.
- If dev data looks stale after a DB change: sign out/in + hard refresh
  before concluding anything is broken (`rw_sheets_cache` localStorage).
- The Class Builder's dev-only "Reset sign-ups (testing)" button clears a
  session's picks; it is hard-disabled on prod.
- A missing file or empty-looking data is not proof of a bug — search and
  reproduce before theorising or "confessing" to something you didn't verify.

## When in doubt

Diagnose and comment on the issue rather than guessing at prod data (which
you cannot read). Behavior/policy changes (who can do what, when) are
Erin's call — propose on the issue, don't ship them unilaterally.
