// Seed the role_holders table from the current Google volunteer sheet.
// Phase A of the sheet→DB role-holder migration: read-only display
// only; _permissions.js and the participation tracker still read the
// sheet directly until Phase B.
//
// Idempotent: wipes + re-inserts rows for the specified school year.
// The default year comes from env (ROLE_HOLDERS_SEED_YEAR) or falls
// back to '2025-2026'.
//
// Run with:
//   node --env-file=.env.local scripts/seed-role-holders.js
//   node --env-file=.env.local scripts/seed-role-holders.js 2026-2027

const { neon } = require('@neondatabase/serverless');
const { google } = require('googleapis');

const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

// Abbreviations the volunteer sheet uses for long titles — canonicalise
// before matching against role_descriptions.title. Mirrors the map in
// api/_permissions.js so the seed and the runtime lookup agree.
const TITLE_NORMALIZATIONS = {
  'communications dir.': 'Communications Director',
  'membership dir.': 'Membership Director',
  'sustaining dir.': 'Sustaining Director',
  'afternoon class liaisons': 'Afternoon Class Liaison',
  'vice-president': 'Vice-President',
  'vice president': 'Vice-President'
};

function normalizeTitle(title) {
  if (!title) return title;
  const key = String(title).trim().toLowerCase();
  return TITLE_NORMALIZATIONS[key] || String(title).trim();
}

function cell(row, col) {
  if (!row || col >= row.length) return '';
  const v = row[col];
  return (v === undefined || v === null) ? '' : String(v).trim();
}

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

// Directory: parent name → { email, family_name }. Mirrors the email
// derivation in api/sheets.js parseDirectory + _permissions.js:
//   <first parent first name> + <family last initial> @ domain
// Stores a lookup by full "First Last" and by family last name alone
// so chair rows (single first name) can still be resolved.
function buildDirectoryLookup(dirRows) {
  const byFullName = {};
  const byFamily = {};
  if (!dirRows || dirRows.length < 2) return { byFullName, byFamily };

  for (let r = 1; r < dirRows.length; r++) {
    const parentStr = cell(dirRows[r], 0);
    if (!parentStr) continue;

    // Strip pronoun parens: "Amber Furnish (she/her)" -> "Amber Furnish"
    const parentClean = parentStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (!parentClean) continue;

    // Everyone listed in this cell shares the family last name (= last
    // word of the whole string).
    const allWords = parentClean.split(/\s+/);
    if (allWords.length < 2) continue;
    const familyName = allWords[allWords.length - 1];

    // Parent first names: split on " & " / "/" / "," and drop the
    // family name from each part. "Amber & Bobby Furnish" → ["Amber","Bobby"].
    const parentChunks = parentClean.split(/\s*[&\/,]\s*/).map(s => s.trim()).filter(Boolean);
    const firstNames = parentChunks.map(chunk => chunk.split(/\s+/)[0]);

    const lastInitial = familyName.charAt(0).toLowerCase();
    const firstParentFirst = firstNames[0].toLowerCase().replace(/[^a-z]/g, '');
    const sharedEmail = firstParentFirst + lastInitial + '@' + ALLOWED_DOMAIN;

    // One entry per person with their individual name. Each individual
    // gets their own derived email (their first name + family initial).
    firstNames.forEach(first => {
      const firstLc = first.toLowerCase().replace(/[^a-z]/g, '');
      if (!firstLc) return;
      const email = firstLc + lastInitial + '@' + ALLOWED_DOMAIN;
      byFullName[(first + ' ' + familyName).toLowerCase()] = {
        email,
        person_name: first + ' ' + familyName,
        family_name: familyName
      };
    });

    // Family-only fallback (for sheet rows that list just a family
    // name): use the first parent's email as the shared contact.
    if (!byFamily[familyName.toLowerCase()]) {
      byFamily[familyName.toLowerCase()] = {
        email: sharedEmail,
        person_name: parentClean,
        family_name: familyName
      };
    }
  }
  return { byFullName, byFamily };
}

// Parse the volunteer-roles tab — same shape as _permissions.js but
// returns { committeeName, title, person } so we preserve enough
// context to skip chair/role rows that didn't match a name.
function parseVolunteerRoles(rows) {
  const out = [];
  if (!rows || rows.length < 2) return out;

  let currentCommittee = '';
  for (let r = 0; r < rows.length; r++) {
    const label = cell(rows[r], 1);
    const value = cell(rows[r], 2);
    if (!label) continue;

    if (label.match(/Committee\s*$/i)) { currentCommittee = label.trim(); continue; }

    // "Chair: <title>-<person>" — all in col 1.
    if (label.match(/^Chair:/i)) {
      const parts = label.replace(/^Chair:\s*/i, '');
      const dashIdx = parts.lastIndexOf('-');
      if (dashIdx <= -1) continue;
      const rawTitle = parts.substring(0, dashIdx).trim();
      const person = parts.substring(dashIdx + 1).trim();
      if (rawTitle && person) {
        out.push({ committee: currentCommittee, title: normalizeTitle(rawTitle), person });
      }
      continue;
    }

    // Filler rows, liaison chart, etc.
    if (label.match(/^(Morning Class|See chart|>)/i)) continue;
    if (!value) continue;
    out.push({ committee: currentCommittee, title: normalizeTitle(label), person: value });
  }
  return out;
}

// Resolve a "First Last" string against the directory lookups. Returns
// null if there's no Workspace email we can match.
function resolvePerson(personStr, dir) {
  if (!personStr) return null;
  const cleaned = personStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
  if (!cleaned) return null;
  const lc = cleaned.toLowerCase();

  // First try a full-name match — strongest signal.
  if (dir.byFullName[lc]) return dir.byFullName[lc];

  // Maybe the sheet abbreviates a name ("Molly" where directory has
  // "Molly Bellner"). Scan byFullName for a prefix match.
  const words = cleaned.split(/\s+/);
  if (words.length === 1) {
    const prefix = words[0].toLowerCase();
    const matches = Object.keys(dir.byFullName).filter(k => k.startsWith(prefix + ' '));
    if (matches.length === 1) return dir.byFullName[matches[0]];
  }

  // Last resort — family surname match.
  const last = words[words.length - 1].toLowerCase();
  if (dir.byFamily[last]) return dir.byFamily[last];

  return null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local scripts/seed-role-holders.js');
    process.exit(1);
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.error('GOOGLE_SERVICE_ACCOUNT_KEY not set.');
    process.exit(1);
  }
  if (!process.env.MASTER_SHEET_ID || !process.env.DIRECTORY_SHEET_ID) {
    console.error('MASTER_SHEET_ID / DIRECTORY_SHEET_ID not set.');
    process.exit(1);
  }

  const schoolYear = process.argv[2] || process.env.ROLE_HOLDERS_SEED_YEAR || '2025-2026';
  const sql = neon(process.env.DATABASE_URL);
  const sheets = getSheetsClient();

  console.log(`Seeding role_holders for school year ${schoolYear}...`);

  // ── Load sheets.
  const [masterMeta, dirMeta] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: process.env.MASTER_SHEET_ID, fields: 'sheets.properties.title' }),
    sheets.spreadsheets.get({ spreadsheetId: process.env.DIRECTORY_SHEET_ID, fields: 'sheets.properties.title' })
  ]);
  const volTab = masterMeta.data.sheets.map(s => s.properties.title).find(t => /Year.*Volunteer/i.test(t));
  if (!volTab) throw new Error('Volunteer roles tab not found in master sheet');
  const dirTab = dirMeta.data.sheets.map(s => s.properties.title).find(t => /Directory/i.test(t))
    || dirMeta.data.sheets[0].properties.title;

  const [volData, dirData] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.MASTER_SHEET_ID,
      range: "'" + volTab + "'",
      valueRenderOption: 'UNFORMATTED_VALUE'
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: process.env.DIRECTORY_SHEET_ID,
      range: "'" + dirTab + "'",
      valueRenderOption: 'UNFORMATTED_VALUE'
    })
  ]);

  const dir = buildDirectoryLookup(dirData.data.values || []);
  const entries = parseVolunteerRoles(volData.data.values || []);
  console.log(`  Parsed ${entries.length} (title, person) entries from the volunteer sheet.`);

  // ── Build title → role_id lookup (case-insensitive) from role_descriptions.
  const roles = await sql`SELECT id, title FROM role_descriptions WHERE category IN ('board','committee_role')`;
  const roleByTitle = {};
  roles.forEach(r => { roleByTitle[r.title.trim().toLowerCase()] = r.id; });
  console.log(`  ${roles.length} board/committee role_descriptions rows available.`);

  // Wipe prior rows for this year so the run is a clean snapshot.
  const wiped = await sql`DELETE FROM role_holders WHERE school_year = ${schoolYear} RETURNING id`;
  console.log(`  Cleared ${wiped.length} prior holder rows for ${schoolYear}.`);

  const unresolvedTitles = [];
  const unresolvedPeople = [];
  let inserted = 0;

  for (const { title, person } of entries) {
    const roleId = roleByTitle[title.toLowerCase()];
    if (!roleId) { unresolvedTitles.push(title + ' (person: ' + person + ')'); continue; }

    // Split a "John & Jane" or "John / Jane" person cell into multiple holders.
    const personChunks = String(person).split(/\s*[&\/,]\s*/).map(s => s.trim()).filter(Boolean);
    for (const p of personChunks) {
      const resolved = resolvePerson(p, dir);
      if (!resolved) { unresolvedPeople.push(title + ': ' + p); continue; }
      try {
        await sql`
          INSERT INTO role_holders (role_id, email, person_name, family_name, school_year, updated_by)
          VALUES (${roleId}, ${resolved.email}, ${resolved.person_name}, ${resolved.family_name}, ${schoolYear}, 'seed-role-holders')
          ON CONFLICT (role_id, (LOWER(email)), school_year) DO NOTHING
        `;
        inserted++;
      } catch (err) {
        console.warn(`  ! insert failed for ${title} → ${p}: ${err.message}`);
      }
    }
  }

  console.log(`\nInserted ${inserted} role_holders rows.`);
  if (unresolvedTitles.length) {
    console.log(`\nUnmatched titles (no role_descriptions row — add or rename):`);
    unresolvedTitles.forEach(t => console.log('  ' + t));
  }
  if (unresolvedPeople.length) {
    console.log(`\nUnresolved people (no directory match — check spelling):`);
    unresolvedPeople.forEach(p => console.log('  ' + p));
  }

  // Sanity summary.
  const summary = await sql`
    SELECT rd.category, COUNT(*)::int AS n
    FROM role_holders rh
    JOIN role_descriptions rd ON rd.id = rh.role_id
    WHERE rh.school_year = ${schoolYear}
    GROUP BY rd.category
    ORDER BY rd.category
  `;
  console.log(`\nHolders by role category:`);
  summary.forEach(s => console.log(`  ${s.category}: ${s.n}`));

  console.log('\nDone.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
