// Dev-DB read (via .env.local.dev ONLY): morning_class_assignments shape
// for #156 — how many builder placements exist per group, finalized vs not,
// and how many line up with a season registration (the snapshot's join).
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const envPath = path.join(__dirname, '..', '.env.local.dev');
const env = {};
fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
});
const url = env.DATABASE_URL;
if (!url) { console.error('No DATABASE_URL in .env.local.dev'); process.exit(1); }

(async () => {
  const sql = neon(url);
  const byGroup = await sql`
    SELECT school_year, class_group, finalized, COUNT(*)::int AS n
    FROM morning_class_assignments
    GROUP BY school_year, class_group, finalized
    ORDER BY school_year, class_group, finalized`;
  console.log('assignments by group/finalized:');
  console.log(JSON.stringify(byGroup, null, 1));
  const joined = await sql`
    SELECT COUNT(*)::int AS n FROM morning_class_assignments a
    WHERE a.school_year = '2026-2027' AND EXISTS (
      SELECT 1 FROM registrations r
      WHERE r.season = '2026-2027' AND r.declined_at IS NULL
        AND (LOWER(NULLIF(r.family_email, '')) = LOWER(a.family_email)
          OR LOWER(r.email) = LOWER(a.family_email)))`;
  console.log('assignments whose family_email matches a 2026-2027 registration email:', joined[0].n);
})().catch(e => { console.error(e.message); process.exit(1); });
