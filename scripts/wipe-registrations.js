// ⚠️ DESTRUCTIVE — was a one-shot pre-launch reset (April 2026). The site is
// now LIVE with real registrations, soft-deletes, invite pipelines, AND
// waiver_signatures now has `registration_id ... ON DELETE CASCADE`, so a
// TRUNCATE ... CASCADE here would ALSO wipe every signed waiver (TRUNCATE
// CASCADE empties the whole referencing table, not just linked rows).
//
// Kept only as a break-glass tool. It now REFUSES to run without an explicit
// flag and prints every FK-cascade target first so the blast radius is
// visible. Recovery after an accidental run is Neon PITR only — slow + manual.
//
// Run (only if you truly mean it):
//   node --env-file=.env.local scripts/wipe-registrations.js --yes-wipe-everything
const { neon } = require('@neondatabase/serverless');

(async () => {
  const sql = neon(process.env.DATABASE_URL);

  const [before] = await sql`
    SELECT
      (SELECT count(*)::int FROM registrations)        AS registrations,
      (SELECT count(*)::int FROM waiver_signatures)    AS waiver_signatures,
      (SELECT count(*)::int FROM one_off_waivers)      AS one_off_waivers
  `;
  console.log('current row counts:', before);

  // Show everything a TRUNCATE ... CASCADE on registrations would empty.
  const cascades = await sql`
    SELECT c.conrelid::regclass::text AS referencing_table
    FROM pg_constraint c
    WHERE c.confrelid = 'registrations'::regclass AND c.contype = 'f'
    ORDER BY 1
  `;
  console.log('TRUNCATE CASCADE would ALSO empty these tables:',
    cascades.map(r => r.referencing_table).join(', ') || '(none)');

  if (!process.argv.includes('--yes-wipe-everything')) {
    console.error('\nRefusing to run. This wipes registrations + every table that');
    console.error('references it (see list above), including signed waivers.');
    console.error('Re-run with --yes-wipe-everything ONLY if that is truly intended.');
    process.exit(1);
  }

  await sql`TRUNCATE TABLE registrations RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE TABLE one_off_waivers RESTART IDENTITY`;

  const [after] = await sql`
    SELECT
      (SELECT count(*)::int FROM registrations)        AS registrations,
      (SELECT count(*)::int FROM waiver_signatures)    AS waiver_signatures,
      (SELECT count(*)::int FROM one_off_waivers)      AS one_off_waivers
  `;
  console.log('after: ', after);
})();
