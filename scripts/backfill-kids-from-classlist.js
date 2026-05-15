// One-time backfill: read the legacy Classlist tab from the Directory
// Google sheet and write each kid's age-group class + AM/PM schedule
// into the kids DB table (kids.class_group + kids.schedule). This is
// the final piece needed before we can retire the Directory sheet —
// once the DB owns this data, /api/sheets stops needing the sheet
// fetch and the Source Google Sheets list drops the Directory entry.
//
// Run with: node scripts/backfill-kids-from-classlist.js
// Add --dry to preview without writing.
//
// Idempotent. Existing kids.class_group / kids.schedule values get
// OVERWRITTEN with the sheet's truth — this is the migration that
// flips the source of truth, so the sheet wins on this one pass.
// After the cutover, the DB is canonical and this script doesn't run
// again.
//
// Uses the dotenv package instead of Node's --env-file because the
// GOOGLE_SERVICE_ACCOUNT_KEY contains \n inside the private key, which
// Node's built-in parser mangles.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');
const { parseDirectory, fetchSheet } = require('../api/sheets.js');

const DRY = process.argv.includes('--dry');

// .env.local typically holds the service-account JSON with the private
// key's newlines as real \n characters (the result of pasting the JSON
// file straight in). JSON.parse rejects those — same trick as
// seed-profiles-from-sheet.js: walk the string and re-escape \n / drop
// \r ONLY inside JSON string literals. Outside strings, leave alone.
function loadServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) { out += c; escaped = false; continue; }
    if (c === '\\') { out += c; escaped = true; continue; }
    if (c === '"') { inString = !inString; out += c; continue; }
    if (inString && c === '\n') { out += '\\n'; continue; }
    if (inString && c === '\r') { continue; }
    out += c;
  }
  return JSON.parse(out);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  if (!process.env.DIRECTORY_SHEET_ID) {
    console.error('DIRECTORY_SHEET_ID not set — nothing to backfill from.');
    process.exit(1);
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.error('GOOGLE_SERVICE_ACCOUNT_KEY not set.');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccountKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Fetching Directory sheet…');
  const tabs = await fetchSheet(sheets, process.env.DIRECTORY_SHEET_ID);
  const dirTab = tabs['Directory'] || null;
  const classTab = tabs['Classlist'] || null;
  if (!dirTab || !classTab) {
    console.error('Directory or Classlist tab missing from the sheet.');
    process.exit(1);
  }

  const { families } = parseDirectory(dirTab, classTab, null);
  console.log(`Parsed ${families.length} families from the sheet.`);

  const sql = neon(process.env.DATABASE_URL);

  // Build family_email lookup from member_profiles. parseDirectory derives
  // each family's email the same way the registration form does
  // (firstParentFirst + lastInitial + '@rootsandwingsindy.com'), which
  // matches member_profiles.family_email for ~all families. Fall back to
  // family_name match for the handful that drift.
  const profileRows = await sql`
    SELECT family_email, family_name FROM member_profiles
  `;
  const familyEmailByEmail = {};
  const familyEmailByName = {};
  profileRows.forEach(p => {
    const fe = String(p.family_email || '').toLowerCase();
    if (!fe) return;
    familyEmailByEmail[fe] = fe;
    const fn = String(p.family_name || '').toLowerCase().trim();
    if (fn) familyEmailByName[fn] = fe;
  });

  let updated = 0;
  let unmatched = 0;
  const unmatchedKids = [];

  for (const fam of families) {
    const guessedEmail = String(fam.email || '').toLowerCase();
    const guessedName = String(fam.name || '').toLowerCase();
    const familyEmail = familyEmailByEmail[guessedEmail] || familyEmailByName[guessedName];

    if (!familyEmail) {
      (fam.kids || []).forEach(k => {
        unmatched++;
        unmatchedKids.push(`${fam.name}/${k.name} (no member_profiles row for email=${guessedEmail} or name=${guessedName})`);
      });
      continue;
    }

    for (const kid of (fam.kids || [])) {
      const firstName = String(kid.name || '').trim();
      if (!firstName) continue;
      const classGroup = String(kid.group || '');
      const schedule = String(kid.schedule || 'all-day');

      if (DRY) {
        console.log(`  [dry] ${familyEmail} / ${firstName} → class_group=${JSON.stringify(classGroup)} schedule=${schedule}`);
      } else {
        const result = await sql`
          UPDATE kids
          SET class_group = ${classGroup},
              schedule = ${schedule},
              updated_at = NOW()
          WHERE family_email = ${familyEmail}
            AND LOWER(first_name) = LOWER(${firstName})
          RETURNING id
        `;
        if (result.length === 0) {
          unmatched++;
          unmatchedKids.push(`${familyEmail} / ${firstName} (no kids row)`);
        } else {
          updated++;
        }
      }
    }
  }

  console.log('');
  console.log(`Updated: ${updated}`);
  console.log(`Unmatched: ${unmatched}`);
  if (unmatchedKids.length) {
    console.log('\nUnmatched kids (likely registered under a different name in the DB):');
    unmatchedKids.slice(0, 30).forEach(line => console.log('  - ' + line));
    if (unmatchedKids.length > 30) console.log(`  ... ${unmatchedKids.length - 30} more`);
  }
  if (DRY) console.log('\n(dry run — no rows written)');
}

main().catch(err => { console.error(err); process.exit(1); });
