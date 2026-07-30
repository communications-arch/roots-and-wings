// DEV-ONLY seed for issue #171: a board tester (e.g. Colleen) exists in the
// Directory sheet (which feeds FAMILIES on every environment) but has no
// member_profiles row in the DEV database — so ownership gates like the
// absence POST's canActAs() 403 her even for her own family.
//
// This copies ONE family from the Directory sheet into dev member_profiles,
// with the tester's workspace email in additional_emails so canActAs links.
// HARD-GUARDED to the dev Neon branch — refuses any other DATABASE_URL host.
//
//   node scripts/seed-dev-tester-family.js <family-name> <workspace-email> [--dry]
//   e.g. node scripts/seed-dev-tester-family.js Raymont colleenr@rootsandwingsindy.com --dry
//
// Reads env from .env.local.dev via dotenv (Node's --env-file mangles the
// multi-line GOOGLE_SERVICE_ACCOUNT_KEY — same reason as seed-profiles-from-sheet).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');
const { parseDirectory, fetchSheet } = require('../api/sheets.js');

const DEV_DB_HOST = 'ep-shiny-recipe-ampdvcs2';

function mask(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}

// Newline-tolerant service-account key loader (same as seed-profiles-from-sheet).
function loadServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  let out = '', inString = false, escaped = false;
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

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  const famArg = process.argv[2];
  const wsEmail = String(process.argv[3] || '').trim().toLowerCase();
  if (!famArg || !wsEmail || !wsEmail.includes('@')) {
    console.error('Usage: node scripts/seed-dev-tester-family.js <family-name> <workspace-email> [--dry]');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.includes(DEV_DB_HOST)) {
    console.error('REFUSING: DATABASE_URL is not the dev branch (' + DEV_DB_HOST + '). This script only ever writes to dev.');
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const auth = new google.auth.GoogleAuth({
    credentials: loadServiceAccountKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const tabs = await fetchSheet(sheets, process.env.DIRECTORY_SHEET_ID);
  const { families } = parseDirectory(tabs['Directory'], tabs['Classlist'] || null, tabs['Allergies'] || null);
  const want = famArg.toLowerCase();
  const matches = families.filter(f => String(f.name || '').toLowerCase() === want);
  if (matches.length !== 1) {
    console.error('Expected exactly 1 sheet family named "' + famArg + '", found ' + matches.length + '. Nothing done.');
    process.exit(1);
  }
  const fam = matches[0];
  const key = String(fam.email || '').toLowerCase();
  if (!key) { console.error('Sheet family has no email. Nothing done.'); process.exit(1); }

  const parents = String(fam.parents || '').split(/\s*&\s*/).map(s => s.trim()).filter(Boolean)
    .map(n => ({ name: n, pronouns: '', photo_url: '' }));
  const kids = (fam.kids || []).map(k => ({
    name: k.name || '', birth_date: '', pronouns: k.pronouns || '',
    allergies: k.allergies || '', schedule: k.schedule || 'all-day',
    photo_url: '', photo_consent: true
  }));

  console.log((DRY_RUN ? '[DRY] ' : '') + 'Seeding dev family "' + fam.name + '" key=' + mask(key)
    + ' parents=' + parents.length + ' kids=' + kids.length
    + ' additional_emails=[' + mask(wsEmail) + ']');

  if (!DRY_RUN) {
    await sql`
      INSERT INTO member_profiles (
        family_email, family_name, phone, address, parents, kids,
        additional_emails, placement_notes, updated_by
      ) VALUES (
        ${key}, ${fam.name}, ${fam.phone || ''}, '',
        ${JSON.stringify(parents)}::jsonb, ${JSON.stringify(kids)}::jsonb,
        ${[wsEmail]}, '', 'seed-dev-tester-family (#171)'
      )
      ON CONFLICT (family_email) DO UPDATE SET
        additional_emails = (
          SELECT ARRAY(SELECT DISTINCT e FROM unnest(
            COALESCE(member_profiles.additional_emails, ARRAY[]::text[]) || ${[wsEmail]}
          ) AS e)
        ),
        updated_at = NOW(),
        updated_by = 'seed-dev-tester-family (#171)'
    `;
    console.log('Done. canActAs on dev can now link ' + mask(wsEmail) + ' -> ' + mask(key));
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
