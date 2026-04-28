// Append a co-parent's secondary login email to a family's
// member_profiles.additional_emails array (Phase 3).
//
// After this runs, the named login email resolves to the same family as the
// row's primary family_email — auth/ownership checks across tour.js,
// absences.js, and the client-side FAMILIES match honor the alias via
// api/_family.js (canActAs / resolveFamily) and script.js's
// familyMatchesEmail helper.
//
// Idempotent: if the email is already present (case-insensitive), it's a
// no-op. Refuses to add an email that already lives on a DIFFERENT family
// to prevent ambiguous resolution.
//
// Usage:
//   node scripts/add-coparent-login.js \
//     --family-name=Shewan \
//     --login-email=jays@rootsandwingsindy.com
//
// Add --confirm to actually write. Without --confirm we print what would
// change and exit (dry-run is the default — safer for an auth-adjacent column).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { neon } = require('@neondatabase/serverless');

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--confirm') { out.confirm = true; continue; }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const familyName = String(args['family-name'] || '').trim();
  const loginEmail = String(args['login-email'] || '').trim().toLowerCase();

  if (!familyName || !loginEmail) {
    console.error('Usage: node scripts/add-coparent-login.js --family-name=Shewan --login-email=jays@rootsandwingsindy.com [--confirm]');
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginEmail)) {
    console.error('login-email does not look like an email.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set (expected in .env.local).');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  const matches = await sql`
    SELECT family_email, family_name, additional_emails
    FROM member_profiles
    WHERE LOWER(family_name) = LOWER(${familyName})
  `;
  if (matches.length === 0) {
    console.error(`No member_profiles row found with family_name = "${familyName}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Multiple rows match family_name = "${familyName}":`);
    matches.forEach(r => console.error(`  - ${r.family_email}`));
    console.error('Disambiguate manually before re-running.');
    process.exit(1);
  }
  const row = matches[0];

  // Refuse to alias an email that's the primary OR additional on a different
  // family — would create ambiguous resolution.
  if (String(row.family_email).toLowerCase() === loginEmail) {
    console.log(`No-op: ${loginEmail} is already this family's primary family_email.`);
    return;
  }
  const conflict = await sql`
    SELECT family_email, family_name FROM member_profiles
    WHERE LOWER(family_email) = ${loginEmail}
       OR EXISTS (SELECT 1 FROM unnest(additional_emails) ae WHERE LOWER(ae) = ${loginEmail})
    LIMIT 1
  `;
  if (conflict.length > 0 && String(conflict[0].family_email).toLowerCase() !== String(row.family_email).toLowerCase()) {
    console.error(`Conflict: ${loginEmail} already resolves to family ${conflict[0].family_name} (${conflict[0].family_email}). Refusing to add to ${row.family_name}.`);
    process.exit(1);
  }

  const existing = (row.additional_emails || []).map(e => String(e).toLowerCase());
  if (existing.includes(loginEmail)) {
    console.log(`No-op: ${loginEmail} is already in ${row.family_email}'s additional_emails.`);
    return;
  }

  const next = (row.additional_emails || []).concat([loginEmail]);

  console.log(`Row: ${row.family_email} (${row.family_name})`);
  console.log(`  additional_emails now:  ${JSON.stringify(row.additional_emails || [])}`);
  console.log(`  Action: APPEND ${loginEmail}`);
  console.log(`  additional_emails next: ${JSON.stringify(next)}`);

  if (!args.confirm) {
    console.log('');
    console.log('(dry run — no writes made. Re-run with --confirm to apply.)');
    return;
  }

  await sql`
    UPDATE member_profiles
       SET additional_emails = ${next}::text[],
           updated_at = NOW(),
           updated_by = 'add-coparent-login.js'
     WHERE family_email = ${row.family_email}
  `;
  console.log('');
  console.log(`Wrote. ${row.family_email} additional_emails now has ${next.length} entries.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
