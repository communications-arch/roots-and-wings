// Apply migrate.sql to the Postgres database pointed at by DATABASE_URL.
// Run locally:   node --env-file=.env.local scripts/run-migration.js
// Runs on Vercel via the `vercel-build` npm script — every deploy reconciles
// schema before the new code goes live. Safe to re-run (all statements use
// IF NOT EXISTS).
//
// Destructive operations (DROP TABLE/COLUMN, ALTER COLUMN TYPE, RENAME,
// TRUNCATE, DELETE FROM, ALTER COLUMN SET NOT NULL) are REJECTED before any
// statement runs. Auto-migrate-on-deploy is only safe for additive changes;
// destructive ones can lose data or break in-flight requests and must be
// applied by hand with a planned downtime window, not at deploy time. Put
// those in `scripts/migrate-destructive.sql` (not auto-run) and apply
// manually after coordinating with anyone on the site.
//
// DROP CONSTRAINT IF EXISTS is whitelisted because the existing migration
// uses drop-then-add pairs to redefine CHECK constraints idempotently —
// that's structural, not data-destructive.

const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

// Regexes match against a single normalized statement (whitespace collapsed,
// uppercased). Order matters only for the error message — first hit wins.
const DESTRUCTIVE_PATTERNS = [
  { re: /\bDROP\s+TABLE\b/,                                label: 'DROP TABLE' },
  { re: /\bDROP\s+SCHEMA\b/,                               label: 'DROP SCHEMA' },
  { re: /\bDROP\s+DATABASE\b/,                             label: 'DROP DATABASE' },
  { re: /\bDROP\s+COLUMN\b/,                               label: 'DROP COLUMN' },
  { re: /\bTRUNCATE\b/,                                    label: 'TRUNCATE' },
  { re: /\bDELETE\s+FROM\b/,                               label: 'DELETE FROM' },
  { re: /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/,                 label: 'ALTER COLUMN ... TYPE' },
  { re: /\bALTER\s+COLUMN\b[^;]*\bSET\s+NOT\s+NULL\b/,     label: 'ALTER COLUMN ... SET NOT NULL' },
  { re: /\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/,             label: 'RENAME' }
];

function findDestructive(stmt) {
  const norm = stmt.replace(/\s+/g, ' ').toUpperCase();
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.re.test(norm)) return p.label;
  }
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local scripts/run-migration.js');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const migrationPath = path.join(__dirname, 'migrate.sql');
  const schema = fs.readFileSync(migrationPath, 'utf8');

  // Strip SQL line-comments, then split on semicolons. Statements here are
  // simple enough that a plain split works — revisit if we add functions or
  // DO blocks that contain semicolons.
  const stripped = schema
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  const statements = stripped
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Pre-flight: scan EVERY statement for destructive patterns before touching
  // the DB. Either all of them pass or none of them run.
  const offenders = [];
  for (let i = 0; i < statements.length; i++) {
    const label = findDestructive(statements[i]);
    if (label) {
      offenders.push({ idx: i + 1, label, preview: statements[i].split('\n')[0].slice(0, 80) });
    }
  }
  if (offenders.length > 0) {
    console.error('Refusing to run — migrate.sql contains destructive operation(s):');
    offenders.forEach(o => {
      console.error(`  [${o.idx}] ${o.label}: ${o.preview}`);
    });
    console.error('\nAuto-migrate-on-deploy is additive-only. Move destructive');
    console.error('changes to scripts/migrate-destructive.sql and apply them');
    console.error('by hand with planned downtime, not at deploy time.');
    process.exit(1);
  }

  console.log(`Running ${statements.length} statements against database...`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.split('\n')[0].slice(0, 60);
    try {
      await sql.query(stmt);
      console.log(`  [${i + 1}/${statements.length}] ok: ${preview}`);
    } catch (err) {
      console.error(`  [${i + 1}/${statements.length}] FAILED: ${preview}`);
      console.error(`    ${err.message}`);
      process.exit(1);
    }
  }

  console.log('Migration complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
