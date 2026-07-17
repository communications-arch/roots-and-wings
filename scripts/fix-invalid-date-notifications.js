// Repairs coverage notifications whose stored title/body reads "Invalid Date"
// — created before the 2026-07-17 notifyCoverageNeeded fix (the neon driver
// returns DATE columns as Date objects, and String(Date) wasn't an ISO day).
// The underlying absence still has the right date, so this recomputes the
// label from related_absence_id and swaps "Invalid Date" for it in place —
// the coverage request stays visible, just with the correct date.
//
// PII-safe output: prints only notification ids + the corrected date label,
// never the member name in the title/body.
//
// Inspect (default):  node --env-file=.env.local scripts/fix-invalid-date-notifications.js
// Apply the fix:      node --env-file=.env.local scripts/fix-invalid-date-notifications.js --apply
const { neon } = require('@neondatabase/serverless');

function isoDay(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
}
function labelFor(absDate) {
  const iso = isoDay(absDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

(async () => {
  const apply = process.argv.includes('--apply');
  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql`
    SELECT n.id, n.related_absence_id, a.absence_date
    FROM notifications n
    LEFT JOIN absences a ON a.id = n.related_absence_id
    WHERE n.title LIKE '%Invalid Date%' OR n.body LIKE '%Invalid Date%'
    ORDER BY n.id
  `;
  if (rows.length === 0) { console.log('No "Invalid Date" notifications found.'); return; }

  console.log(rows.length + ' notification(s) with "Invalid Date":');
  let fixable = 0, unfixable = 0;
  for (const r of rows) {
    const label = r.absence_date ? labelFor(r.absence_date) : '';
    if (label) {
      fixable++;
      console.log('  notif ' + r.id + ' → "' + label + '"');
      if (apply) {
        await sql`
          UPDATE notifications
          SET title = REPLACE(title, 'Invalid Date', ${label}),
              body  = REPLACE(body,  'Invalid Date', ${label})
          WHERE id = ${r.id}
        `;
      }
    } else {
      unfixable++;
      // No linked absence (or its date is gone) — can't recompute; leave it,
      // or delete manually. Reported so nothing is silently skipped.
      console.log('  notif ' + r.id + ' → NO linked absence date (left as-is)');
    }
  }
  console.log((apply ? 'FIXED ' : 'Would fix ') + fixable + ' notification(s); ' + unfixable + ' had no absence to recompute from.');
  if (!apply) console.log('(inspect only — re-run with --apply to write the fix)');
})().catch(e => { console.error(e); process.exit(1); });
