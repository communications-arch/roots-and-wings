// Seed member_profiles.kids and .parents with pronouns / allergies from the
// Google Directory sheet. We're flipping the source-of-truth for those fields
// from the sheet to the DB, so this one-time migration copies the current
// sheet values into member_profiles.
//
// Idempotent. Preserves any DB values a family has already self-edited in the
// portal — the member_profiles row always wins. Sheet values only fill gaps.
//
// Run with: node scripts/seed-profiles-from-sheet.js
// Add --dry to preview without writing.
//
// Uses the `dotenv` package instead of Node's --env-file flag — Node's
// built-in parser mangles multi-line JSON values, which breaks the
// GOOGLE_SERVICE_ACCOUNT_KEY containing embedded \n in the private key.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');
const { parseDirectory, fetchSheet } = require('../api/sheets.js');

// parseDirectory no longer reads pronouns / allergies from the sheet (they
// live in member_profiles now). This script is the migration that fills the
// DB the first time, so it needs the legacy parse logic duplicated here.
function parseLegacyPronounsAndAllergies(dirRows, allergyRows) {
  const parentPronounsByFamily = {};   // familyName (lower) -> { firstNameLower: pronouns }
  const kidPronounsByFamily = {};      // familyName (lower) -> { firstNameLower: pronouns }
  const kidAllergies = {};             // "firstname lastinitial" -> allergy  AND  "firstname" -> allergy

  const cell = (row, col) => (row && col < row.length && row[col] != null) ? String(row[col]).trim() : '';

  if (dirRows && dirRows.length > 1) {
    for (let r = 1; r < dirRows.length; r++) {
      const parentStr = cell(dirRows[r], 0);
      if (!parentStr) continue;

      // Family name = last word of cleaned parent string
      const parentClean = parentStr.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
      const parentWords = parentClean.split(/\s+/);
      const familyName = (parentWords[parentWords.length - 1] || '').toLowerCase();
      if (!familyName) continue;

      // Parent pronouns — same regex as the old parser.
      parentPronounsByFamily[familyName] = parentPronounsByFamily[familyName] || {};
      const pronRe = /(\S+)\s+\(([^)]+)\)/g;
      let pMatch;
      while ((pMatch = pronRe.exec(parentStr)) !== null) {
        const before = parentStr.substring(0, pMatch.index + pMatch[1].length)
          .replace(/\s*\([^)]*\)\s*/g, ' ').trim();
        const segments = before.split(/\s*&\s*/);
        const lastSeg = segments[segments.length - 1].trim();
        const firstName = lastSeg.split(/\s+/)[0];
        if (firstName) parentPronounsByFamily[familyName][firstName.toLowerCase()] = pMatch[2].trim();
      }

      // Kid pronouns — scan cols 2+
      kidPronounsByFamily[familyName] = kidPronounsByFamily[familyName] || {};
      for (let c = 2; c < (dirRows[r] ? dirRows[r].length : 0); c++) {
        const kidStr = cell(dirRows[r], c);
        if (!kidStr) continue;
        const pronMatch = kidStr.match(/\(([^)]+)\)/);
        const pronouns = pronMatch ? pronMatch[1].trim() : '';
        let kidFirst = kidStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
        // Strip family surname if included in kid cell
        if (kidFirst.toLowerCase().endsWith(' ' + familyName)) {
          kidFirst = kidFirst.substring(0, kidFirst.length - familyName.length - 1).trim();
        }
        if (kidFirst && pronouns) {
          kidPronounsByFamily[familyName][kidFirst.toLowerCase().split(/\s+/)[0]] = pronouns;
        }
      }
    }
  }

  if (allergyRows && allergyRows.length > 1) {
    for (let c = 0; c < (allergyRows[0] ? allergyRows[0].length : 0); c += 2) {
      for (let r = 1; r < allergyRows.length; r++) {
        const kidNameCell = cell(allergyRows[r], c);
        const allergy = cell(allergyRows[r], c + 1);
        if (!kidNameCell || !allergy) continue;
        const key = kidNameCell.toLowerCase();
        kidAllergies[key] = allergy;
        // Also index by first-name-only for fuzzier matching
        const first = key.split(/\s+/)[0];
        if (first && !kidAllergies[first]) kidAllergies[first] = allergy;
      }
    }
  }

  return { parentPronounsByFamily, kidPronounsByFamily, kidAllergies };
}

// Local getAuth that tolerates .env.local service-account keys with raw
// newlines embedded inside the JSON string value (the usual result of
// pasting the service-account JSON file straight into .env.local). The prod
// version in api/sheets.js is stricter because Vercel env vars don't have
// this issue.
function loadServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  // Walk the string; inside a JSON string value, convert any raw \n / \r to
  // their escaped \\n / drop \\r. Outside strings we leave everything alone.
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

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: loadServiceAccountKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

const DRY_RUN = process.argv.includes('--dry');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=.env.local scripts/seed-profiles-from-sheet.js');
    process.exit(1);
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    console.error('GOOGLE_SERVICE_ACCOUNT_KEY not set.');
    process.exit(1);
  }
  if (!process.env.DIRECTORY_SHEET_ID) {
    console.error('DIRECTORY_SHEET_ID not set.');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log(DRY_RUN ? '── DRY RUN — no writes ──' : '── Seeding member_profiles from Directory sheet ──');

  const directoryTabs = await fetchSheet(sheets, process.env.DIRECTORY_SHEET_ID);
  const dirTab = directoryTabs['Directory'] || null;
  const classTab = directoryTabs['Classlist'] || null;
  const allergyTab = directoryTabs['Allergies'] || null;
  if (!dirTab) {
    console.error('Directory tab not found in sheet.');
    process.exit(1);
  }

  const { families } = parseDirectory(dirTab, classTab, allergyTab);
  const legacy = parseLegacyPronounsAndAllergies(dirTab, allergyTab);
  console.log(`Parsed ${families.length} families from sheet.`);

  const existing = await sql`
    SELECT family_email, family_name, parents, kids, phone, address, placement_notes
    FROM member_profiles
  `;
  const existingByEmail = {};
  existing.forEach(r => { existingByEmail[String(r.family_email).toLowerCase()] = r; });

  let created = 0, updated = 0, unchanged = 0;

  for (const fam of families) {
    const key = String(fam.email || '').toLowerCase();
    if (!key) continue;
    const existingRow = existingByEmail[key];

    // Parents payload — first names only (matches sanitizeParent shape in tour.js).
    const parentFirstNames = String(fam.parents || '')
      .split(/\s*&\s*/).map(s => s.trim()).filter(Boolean);
    const existingParents = (existingRow && existingRow.parents) || [];
    const parentsByFirst = {};
    existingParents.forEach(p => {
      if (p && p.name) parentsByFirst[String(p.name).trim().split(/\s+/)[0].toLowerCase()] = p;
    });
    const famKey = String(fam.name || '').toLowerCase();
    const legacyParentPronouns = legacy.parentPronounsByFamily[famKey] || {};
    const mergedParents = parentFirstNames.map(n => {
      const existingP = parentsByFirst[n.toLowerCase()] || {};
      const sheetPronoun = legacyParentPronouns[n.toLowerCase()] || '';
      return {
        name: existingP.name || n,
        // DB wins for pronouns; legacy sheet parens fill gaps.
        pronouns: existingP.pronouns || sheetPronoun || '',
        photo_url: existingP.photo_url || ''
      };
    });

    // Kids payload — match by first name, preserve DB edits, fill from sheet.
    const existingKids = (existingRow && existingRow.kids) || [];
    const kidsByFirst = {};
    existingKids.forEach(k => {
      if (k && k.name) kidsByFirst[String(k.name).trim().split(/\s+/)[0].toLowerCase()] = k;
    });
    const legacyKidPronouns = legacy.kidPronounsByFamily[famKey] || {};
    const familyInitial = String(fam.name || '').charAt(0).toUpperCase();
    const mergedKids = (fam.kids || []).map(sheetKid => {
      const first = String(sheetKid.name || '').trim().split(/\s+/)[0].toLowerCase();
      const dbKid = kidsByFirst[first] || {};
      // Try allergy lookup: "firstname lastinitial" first, then firstname only.
      const allergyKey1 = (first + ' ' + familyInitial).toLowerCase();
      const legacyAllergy = legacy.kidAllergies[allergyKey1] || legacy.kidAllergies[first] || '';
      const legacyPronoun = legacyKidPronouns[first] || '';
      return {
        name: dbKid.name || sheetKid.name || '',
        birth_date: dbKid.birth_date || '',
        pronouns: dbKid.pronouns || sheetKid.pronouns || legacyPronoun || '',
        allergies: dbKid.allergies || sheetKid.allergies || legacyAllergy || '',
        schedule: dbKid.schedule || sheetKid.schedule || 'all-day',
        photo_url: dbKid.photo_url || '',
        // Default: photos allowed. The seed never turns opt-out on — families
        // flip this in the registration form or the portal editor.
        photo_consent: dbKid.photo_consent !== false
      };
    });
    // Append any DB-only kids (edited into the portal but not in the sheet).
    existingKids.forEach(dbKid => {
      const first = String(dbKid.name || '').trim().split(/\s+/)[0].toLowerCase();
      if (!first) return;
      const alreadyIn = mergedKids.some(k => String(k.name).trim().split(/\s+/)[0].toLowerCase() === first);
      if (!alreadyIn) mergedKids.push({
        name: dbKid.name || '',
        birth_date: dbKid.birth_date || '',
        pronouns: dbKid.pronouns || '',
        allergies: dbKid.allergies || '',
        schedule: dbKid.schedule || 'all-day',
        photo_url: dbKid.photo_url || '',
        photo_consent: dbKid.photo_consent !== false
      });
    });

    const familyName = (existingRow && existingRow.family_name) || fam.name;
    const phone = (existingRow && existingRow.phone) || fam.phone || '';
    const address = (existingRow && existingRow.address) || '';
    const placementNotes = (existingRow && existingRow.placement_notes) || '';

    // Skip if nothing would change — avoid bumping updated_at needlessly.
    const nextJson = JSON.stringify({ parents: mergedParents, kids: mergedKids });
    const prevJson = existingRow
      ? JSON.stringify({ parents: existingRow.parents || [], kids: existingRow.kids || [] })
      : null;
    if (existingRow && nextJson === prevJson) {
      unchanged++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`WOULD ${existingRow ? 'UPDATE' : 'CREATE'} ${key} (${familyName}) — ${mergedKids.length} kids, ${mergedParents.length} parents`);
      mergedParents.forEach(p => {
        const pron = p.pronouns ? ` (${p.pronouns})` : '';
        console.log(`    parent: ${p.name}${pron}`);
      });
      mergedKids.forEach(k => {
        const pron = k.pronouns ? ` (${k.pronouns})` : '';
        const allergy = k.allergies ? ` ⚠ ${k.allergies}` : '';
        console.log(`    kid: ${k.name}${pron}${allergy}`);
      });
    } else {
      await sql`
        INSERT INTO member_profiles (
          family_email, family_name, phone, address, parents, kids,
          placement_notes, updated_by
        ) VALUES (
          ${key}, ${familyName}, ${phone}, ${address},
          ${JSON.stringify(mergedParents)}::jsonb, ${JSON.stringify(mergedKids)}::jsonb,
          ${placementNotes}, 'seed-profiles-from-sheet'
        )
        ON CONFLICT (family_email) DO UPDATE SET
          family_name = EXCLUDED.family_name,
          phone = EXCLUDED.phone,
          address = EXCLUDED.address,
          parents = EXCLUDED.parents,
          kids = EXCLUDED.kids,
          placement_notes = EXCLUDED.placement_notes,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
      `;
    }

    if (existingRow) updated++; else created++;
  }

  console.log('──────────────────');
  console.log(`Created:   ${created}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  if (DRY_RUN) console.log('(dry run — no writes made)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
