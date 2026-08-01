// One-time cleanup for bug #197 (Colleen): the client reconciler used to
// backfill coverage slots onto absences whose reporter had said "No, my
// backup learning coach is covering me" (coverage_needed = false) — putting
// them back on the Coverage Board. The reconciler + server now refuse; this
// removes the slots it already created, plus the stale Coverage-Needed
// notifications for those absences.
//
// Dry-run by default. Usage:
//   node --env-file=.env.local.dev scripts/cleanup-blc-coverage-slots.js        (list only)
//   node --env-file=.env.local.dev scripts/cleanup-blc-coverage-slots.js --yes  (delete)

const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local.dev scripts/cleanup-blc-coverage-slots.js');
    process.exit(1);
  }
  const doIt = process.argv.includes('--yes');
  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql`
    SELECT cs.id AS slot_id, cs.block, cs.role_description, cs.claimed_by_name,
           a.id AS absence_id, a.absent_person, a.absence_date, a.blc_name
    FROM coverage_slots cs
    JOIN absences a ON a.id = cs.absence_id
    WHERE a.coverage_needed = false
    ORDER BY a.id, cs.id
  `;
  if (rows.length === 0) {
    console.log('No coverage slots found on backup-coach-covered absences. Nothing to do.');
    return;
  }
  console.log(rows.length + ' slot(s) on coverage_needed=false absences:');
  rows.forEach(r => {
    console.log('  absence #' + r.absence_id + ' (' + r.absent_person + ', '
      + String(r.absence_date).slice(0, 10) + ', BLC: ' + (r.blc_name || '—') + ') → slot #'
      + r.slot_id + ' [' + r.block + '] ' + r.role_description
      + (r.claimed_by_name ? ' (claimed by ' + r.claimed_by_name + '!)' : ''));
  });
  if (!doIt) {
    console.log('\nDry run — re-run with --yes to delete these slots (and their stale Coverage-Needed bells).');
    return;
  }
  const absenceIds = [...new Set(rows.map(r => r.absence_id))];
  const delSlots = await sql`
    DELETE FROM coverage_slots
    WHERE absence_id = ANY(${absenceIds})
      AND absence_id IN (SELECT id FROM absences WHERE coverage_needed = false)
    RETURNING id
  `;
  const delNotifs = await sql`
    DELETE FROM notifications
    WHERE type = 'coverage_needed' AND related_absence_id = ANY(${absenceIds})
    RETURNING id
  `;
  console.log('\nDeleted ' + delSlots.length + ' slot(s) and ' + delNotifs.length + ' stale notification(s).');
}

main().catch(e => { console.error(e); process.exit(1); });
