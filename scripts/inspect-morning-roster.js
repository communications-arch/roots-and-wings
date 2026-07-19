// READ-ONLY dev diagnostic: mirrors handleMorningBuilderGet's roster logic and
// prints anomalies — "age ?" kids (NULL birth_date), assignment rows whose kid
// is no longer morning-enrolled, blank/odd names, recent schedule flips.
// Run: node --env-file=.env.local.dev <this file>   (from the repo root)
const { neon } = require('@neondatabase/serverless');

function mask(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}

(async () => {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) { console.error('No DATABASE_URL — run with --env-file=.env.local.dev'); process.exit(1); }
  const sql = neon(url);
  const season = process.argv[2] || '2026-2027';

  const enr = await sql`
    SELECT e.kid_id, e.family_email, e.schedule, e.status, e.updated_at, e.source,
           k.first_name, k.nickname, k.birth_date
    FROM kid_enrollments e
    JOIN kids k ON k.id = e.kid_id
    WHERE e.season = ${season}
    ORDER BY e.family_email, k.first_name`;

  const assigns = await sql`
    SELECT id, family_email, kid_first_name, class_group, finalized, kid_id, updated_at, updated_by
    FROM morning_class_assignments
    WHERE school_year = ${season}
    ORDER BY family_email, kid_first_name`;

  const enrByKidId = new Map(enr.map(e => [e.kid_id, e]));
  const morningSet = new Set(enr.filter(e => e.status === 'enrolled' && (e.schedule === 'all-day' || e.schedule === 'morning')).map(e => e.kid_id));

  console.log('Season ' + season + ': ' + enr.length + ' enrollment rows, ' + assigns.length + ' morning assignments\n');

  console.log('── Morning-pool kids with NULL birth_date ("age ?") ──');
  let n = 0;
  enr.forEach(e => {
    if (!morningSet.has(e.kid_id)) return;
    if (!e.birth_date) { n++; console.log('  ' + e.first_name + ' @ ' + mask(e.family_email) + '  (kid_id ' + e.kid_id + ', schedule ' + e.schedule + ')'); }
  });
  if (!n) console.log('  none');

  console.log('\n── Assignment rows whose kid is NOT morning-enrolled (builder "preservation" chips) ──');
  n = 0;
  for (const a of assigns) {
    const e = a.kid_id ? enrByKidId.get(a.kid_id) : null;
    const stillMorning = a.kid_id ? morningSet.has(a.kid_id) : null;
    if (a.kid_id && stillMorning) continue;
    n++;
    console.log('  "' + a.kid_first_name + '" @ ' + mask(a.family_email)
      + '  group=' + (a.class_group || '(unplaced)')
      + '  kid_id=' + (a.kid_id || 'NULL')
      + (e ? ('  → enrollment: ' + e.status + '/' + e.schedule + ' (updated ' + String(e.updated_at).slice(0, 19) + ')') : '  → no enrollment row for this kid_id')
      + '  [assignment updated ' + String(a.updated_at).slice(0, 19) + ' by ' + mask(a.updated_by) + ']');
  }
  if (!n) console.log('  none');

  console.log('\n── Assignment rows with kid_id NULL (name-keyed legacy) ──');
  n = 0;
  for (const a of assigns) {
    if (a.kid_id) continue;
    n++;
    console.log('  "' + a.kid_first_name + '" @ ' + mask(a.family_email) + '  group=' + (a.class_group || '(unplaced)'));
  }
  if (!n) console.log('  none');

  console.log('\n── Enrollment rows changed in the last 24h ──');
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  n = 0;
  enr.forEach(e => {
    if (new Date(e.updated_at).getTime() < dayAgo) return;
    n++;
    const a = assigns.find(x => x.kid_id === e.kid_id);
    console.log('  ' + e.first_name + ' @ ' + mask(e.family_email)
      + '  ' + e.status + '/' + e.schedule + '  source=' + e.source
      + '  assignment=' + (a ? (a.class_group || '(unplaced)') : 'none'));
  });
  if (!n) console.log('  none');

  console.log('\n── Kids rows with blank/whitespace first_name ──');
  const blanks = await sql`SELECT id, family_email FROM kids WHERE TRIM(COALESCE(first_name,'')) = ''`;
  if (!blanks.length) console.log('  none');
  blanks.forEach(b => console.log('  kid_id ' + b.id + ' @ ' + mask(b.family_email)));
})();
