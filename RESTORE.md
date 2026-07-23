# RESTORE.md — Bringing the Roots & Wings site back from a backup

This runbook assumes **no prior context**: you have the printed DR binder, the
sealed passphrase envelope, and a laptop. It walks from "the database is gone"
to "the site is back up on a fresh database."

Printable Disaster Recovery Plan (systems map, scenarios, who-to-call): on the
members site → Workspace → **Admin Consoles & Sources** → 🛟 Disaster Recovery
Plan (Communications Director role). A printed copy belongs in the binder next
to this file.

---

## 1. What the backups are

- A **full PostgreSQL dump** of the production Neon database, taken **nightly
  at 08:10 UTC** (~4:10am Indianapolis) by the GitHub Action
  `.github/workflows/db-backup.yml`.
- Encrypted with **gpg (symmetric AES256)**. The passphrase is in the sealed
  envelope in the DR binder (and in the GitHub secret `BACKUP_PASSPHRASE`).
  The binder with the envelope lives in the **R&W supply cabinet**; a second
  binder (no envelope) is kept at the **Communications Director's home**.
- Stored in the co-op's **Google Drive** in the Backups folder
  (**Shared Drives → Communications → Backups**),
  named `rw-backup-YYYY-MM-DD.dump.gpg` with a sidecar
  `rw-backup-YYYY-MM-DD.manifest.json` recording row counts at backup time.
- Retention: the job keeps the **last 30 dailies** plus the **first backup of
  each month for 12 months** and deletes the rest.
- If a nightly backup **fails**, communications@rootsandwingsindy.com gets an
  email from the workflow (via Resend), and GitHub also emails the repo owner.

## 2. Prerequisites

- A machine with **PostgreSQL 17 client tools** (`pg_restore`, `psql`) and
  **gpg**. On Windows, install "PostgreSQL 17" from postgresql.org (client
  tools only is fine) and Gpg4win — or use any Linux/Mac with
  `postgresql-client-17` + `gnupg`.
- Access to the co-op Google Drive (any board account that can see the
  Backups folder).
- The **backup passphrase** (sealed envelope in the binder, or the
  `BACKUP_PASSPHRASE` secret at github.com → repo → Settings → Secrets).
- Access to one of: the Neon account, or the ability to create a new free
  Neon account (console.neon.tech). Neon login: communications@
  (recovery info: see the DR plan's key-accounts table).

## 3. Get and decrypt the newest backup

1. In Google Drive, open the Backups folder and download the newest
   `rw-backup-YYYY-MM-DD.dump.gpg` (and its `.manifest.json` if you want to
   verify counts afterwards).
2. Decrypt it:

   ```bash
   gpg --batch --decrypt --pinentry-mode loopback \
     --passphrase "PASTE_PASSPHRASE_HERE" \
     --output rw-backup.dump rw-backup-YYYY-MM-DD.dump.gpg
   ```

3. Sanity check — this should print a long table of contents, not an error:

   ```bash
   pg_restore --list rw-backup.dump | head
   ```

## 4. Restore onto a fresh Neon database

1. Log in at **console.neon.tech** (or create a new project if the old
   account/project is unrecoverable — a new free/Launch project is fine).
2. Create a project/branch and copy its **direct (unpooled) connection
   string** — Neon dashboard → Connect → uncheck "Connection pooling". It
   looks like `postgresql://USER:PASS@ep-xxx.aws.neon.tech/neondb?sslmode=require`.
3. Restore (this creates all tables and data; `--no-owner` because the Neon
   role differs from the original):

   ```bash
   pg_restore --no-owner --no-privileges \
     --dbname "postgresql://...direct-connection-string..." rw-backup.dump
   ```

4. Verify row counts against the manifest:

   ```bash
   psql "postgresql://...direct..." -c "SELECT
     (SELECT count(*) FROM registrations)     AS registrations,
     (SELECT count(*) FROM people)            AS people,
     (SELECT count(*) FROM kids)              AS kids,
     (SELECT count(*) FROM kid_enrollments)   AS kid_enrollments,
     (SELECT count(*) FROM waiver_signatures) AS waiver_signatures;"
   ```

   Compare with the numbers in `rw-backup-YYYY-MM-DD.manifest.json`.

## 5. Point the site at the restored database

The site is on Vercel (account: communications@; project `roots-and-wings`).

1. Vercel dashboard → the project → **Settings → Environment Variables**
   (Production environment).
2. Update `DATABASE_URL` to the new **pooled** connection string (Neon →
   Connect → WITH connection pooling; host contains `-pooler`). Also update
   `DATABASE_URL_UNPOOLED` (and the `POSTGRES_*`/`PG*` variants if present —
   search the env list for the old hostname to catch them all).
3. **Redeploy**: Deployments → newest production deployment → ⋯ → Redeploy
   (env-var changes only take effect on a new deployment). If Vercel itself
   was the disaster, re-import the GitHub repo
   (`communications-arch/roots-and-wings`, `master` branch) into a new
   project and set the env vars fresh.
4. Note: the build runs `scripts/run-migration.js` (applies
   `scripts/migrate.sql`), which is idempotent (`IF NOT EXISTS` guards) and
   safe on a restored database.

## 6. Verify the site

- [ ] https://www.rootsandwingsindy.com loads.
- [ ] Sign in with a member Google account (members.html portal).
- [ ] Directory shows families; a kid's schedule looks right.
- [ ] Workspace loads for a board role; Membership Report opens with data.
- [ ] Submit nothing destructive — browse only — until counts look sane.
- [ ] Check the waivers report shows signatures.

## 7. If the restore was into a scratch/test database

The workflow's `restore-test` job (Actions → "DB backup" → Run workflow →
job: `restore-test`) does all of the above automatically into a scratch
database `rw_restore_test` on the prod server, checks row counts against the
manifest, prints PASS/FAIL, and drops the scratch DB. Run it after any big
schema change, and record the date + result here:

| Date | Result | Notes |
|------|--------|-------|
| 2026-07-20 | PASS | Full pipeline proven locally against the DEV database (postgres:17 + gpg): dump → encrypt → decrypt (byte-identical) → `pg_restore --list` → full restore into scratch DB `rw_restore_test` on the Neon dev branch → all 5 row counts matched the manifest → scratch dropped. First CI run against prod still pending secrets. |
| 2026-07-22 | PASS | **First live CI run against PROD** (Erin + Claude, run 29962164270): nightly backup `rw-backup-2026-07-22.dump.gpg` uploaded to the Shared Drive Backups folder, then restore-test downloaded it, decrypted with the binder passphrase, listed 574 archive entries, fully restored into `rw_restore_test`, all 5 row counts matched, scratch dropped. Failure alerts verified reaching communications@ (Resend). Nightly cron live from tonight. |
| _(record restore-test runs here)_ | | |

## 8. Who to call

- Communications Director (runs this system): **Erin Bogan, 317-941-0468**
- Backup contact who knows where the binder lives: **[name + phone]**
- Erin's technical contact for the site build: **[name/handle]**
- Neon support: https://neon.tech/docs/introduction/support (Launch plan)
- Vercel support: https://vercel.com/help

## Out of scope

Photos / Vercel Blob files are **not** backed up by this pipeline (decided in
issue #49). Google Drive/Docs content is under the co-op's Google Workspace
and covered by Google's own retention.
