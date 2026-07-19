// One-time backfill mapping the name-keyed afternoon pick tables onto real
// kids.id (enrollment re-key phase — companion to
// scripts/backfill-kid-enrollments.js, same matching rules). Two steps:
//
//   STEP 1 — class_signup_picks rows for the season with kid_id IS NULL:
//            map each (family_email, kid_first_name) group onto kids.id,
//            matching by exact (family_email, first name) first, then via
//            the registration-derived Workspace email fallback for families
//            whose rows were keyed on a derived email that differs from the
//            real family_email (compound-surname cases).
//   STEP 2 — class_lottery_bumps rows with kid_id IS NULL: same mapping.
//
// A registration "matches" a family when EITHER its STORED family_email,
// its derived Workspace email (firstParentFirst + familyLastInitial +
// @rootsandwingsindy.com — same rule as deriveWorkspaceEmail in script.js /
// api/sheets.js parseDirectory) equals kids.family_email, OR its derived
// family name equals the family's member_profiles.family_name
// (case-insensitive).
//
// Ambiguous (2+ candidate kids) and unmatched groups are reported and left
// UNTOUCHED — re-run after fixing the data.
//
// DRY-RUN by default — prints the exact plan and changes NOTHING. Add --apply
// to commit (single transaction; any error rolls the whole thing back).
// Emails are masked so member PII stays out of terminals/transcripts.
//
//   node --env-file=<env> scripts/backfill-pick-kid-ids.js [--season=YYYY-YYYY] [--apply]
//
// Default season: 2026-2027.
const { neon } = require('@neondatabase/serverless');

function mask(email) {
  const e = String(email || '');
  if (!e) return '';
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}

// Family name: existing_family_name if the registrant supplied one, else the
// last word of the Main LC's full name (api/tour.js deriveFamilyName).
function deriveFamilyName(mainLcName, existingFamilyName) {
  const existing = String(existingFamilyName || '').trim();
  if (existing) return existing;
  const words = String(mainLcName || '').trim().split(/\s+/);
  return words[words.length - 1] || '';
}

// Workspace login convention used everywhere in the app: first word of the
// Main LC's name, lowercased alpha-only, + first letter of the family name.
function deriveEmail(mainLcName, existingFamilyName) {
  const parts = String(mainLcName || '').trim().split(/\s+/);
  const first = (parts[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  const famName = deriveFamilyName(mainLcName, existingFamilyName);
  const lastInitial = famName.charAt(0).toLowerCase().replace(/[^a-z]/g, '');
  if (!first || !lastInitial) return '';
  return first + lastInitial + '@rootsandwingsindy.com';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const seasonArg = process.argv.find(a => a.startsWith('--season='));
  const season = seasonArg ? seasonArg.slice('--season='.length) : '2026-2027';
  if (!/^\d{4}-\d{4}$/.test(season)) {
    console.error('Bad --season value ' + JSON.stringify(season) + ' — expected YYYY-YYYY.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);

  console.log((apply ? '*** APPLY MODE ***' : 'DRY RUN (no writes)') + '  season=' + season);

  // Planned DML, executed only under --apply, in one transaction.
  const ops = [];

  // Shared lookups: the kids roster + the season's registrations (for the
  // derived-email fallback) — same matching machinery as
  // backfill-kid-enrollments.js.
  const kids = await sql`
    SELECT id, family_email, first_name FROM kids ORDER BY id`;
  const regs = await sql`
    SELECT id, family_email, main_learning_coach, existing_family_name
    FROM registrations
    WHERE season = ${season} AND declined_at IS NULL`;
  const profiles = await sql`SELECT family_email, family_name FROM member_profiles`;
  const profileNameByEmail = new Map(profiles.map(p =>
    [String(p.family_email || '').toLowerCase(), String(p.family_name || '').trim()]));

  const regDerived = regs.map(r => ({
    id: r.id,
    stored: String(r.family_email || '').toLowerCase(),
    email: deriveEmail(r.main_learning_coach, r.existing_family_name).toLowerCase(),
    famName: deriveFamilyName(r.main_learning_coach, r.existing_family_name).toLowerCase()
  }));

  // For each family (by kids.family_email), the season registrations that
  // match it — supplies the derived emails for the pass-2 fallback.
  const regsByFamily = new Map();
  function matchingRegs(familyEmail) {
    const fe = String(familyEmail || '').toLowerCase();
    if (regsByFamily.has(fe)) return regsByFamily.get(fe);
    const profName = (profileNameByEmail.get(fe) || '').toLowerCase();
    const hits = regDerived.filter(r =>
      (r.stored && r.stored === fe)
      || (r.email && r.email === fe)
      || (r.famName && profName && r.famName === profName));
    regsByFamily.set(fe, hits);
    return hits;
  }

  // Map one table's NULL-kid_id rows (grouped by family_email +
  // kid_first_name — every pick row for the same kid gets the same id).
  // Returns {mapped, unresolved} group counts; pushes UPDATE thunks.
  function mapGroups(label, rows, makeUpdate) {
    const groups = new Map(); // famLower|kidLower → {fam, kid, count}
    for (const r of rows) {
      const fam = String(r.family_email || '').toLowerCase();
      const kid = String(r.kid_first_name || '').toLowerCase();
      const key = fam + '|' + kid;
      if (!groups.has(key)) groups.set(key, { fam: r.family_email, kid: r.kid_first_name, count: 0 });
      groups.get(key).count++;
    }
    let mapped = 0, unresolved = 0;
    const sorted = Array.from(groups.values()).sort((a, b) =>
      (String(a.fam).localeCompare(String(b.fam))) || String(a.kid).localeCompare(String(b.kid)));
    for (const g of sorted) {
      const ge = String(g.fam || '').toLowerCase();
      const gk = String(g.kid || '').toLowerCase();
      // Pass 1: exact (family_email, first_name) match on kids.
      let candidates = kids.filter(k =>
        String(k.family_email || '').toLowerCase() === ge
        && String(k.first_name || '').toLowerCase() === gk);
      // Pass 2: the row was keyed on a registration-DERIVED email that
      // differs from the real family_email — accept a first-name match whose
      // family's matching season registration derives to exactly this email.
      if (candidates.length === 0) {
        candidates = kids.filter(k =>
          String(k.first_name || '').toLowerCase() === gk
          && matchingRegs(k.family_email).some(r => r.email === ge));
      }
      if (candidates.length === 1) {
        const k = candidates[0];
        mapped++;
        const differs = String(k.family_email || '').toLowerCase() !== ge;
        console.log('  ' + label + ': ' + g.kid + ' @ ' + mask(g.fam)
          + ' (' + g.count + ' row' + (g.count === 1 ? '' : 's') + ')'
          + ' → UPDATE SET kid_id=' + k.id
          + (differs ? '  ⚠ row email differs from kid family_email ' + mask(k.family_email) + ' (email left as-is)' : ''));
        ops.push(makeUpdate(k.id, g.fam, g.kid));
      } else {
        unresolved++;
        console.log('  ' + label + ': ' + g.kid + ' @ ' + mask(g.fam)
          + ' (' + g.count + ' row' + (g.count === 1 ? '' : 's') + ')'
          + ' → UNRESOLVED (' + (candidates.length === 0 ? 'no matching kid' : candidates.length + ' candidate kids — ambiguous') + ') — untouched');
      }
    }
    return { mapped, unresolved, groups: groups.size, rows: rows.length };
  }

  // ══ STEP 1 — class_signup_picks (season, kid_id IS NULL) ═════════════════
  console.log('\n════════ STEP 1 — map class_signup_picks (' + season + ') to kid_id ════════');
  const pickRows = await sql`
    SELECT id, family_email, kid_first_name
    FROM class_signup_picks
    WHERE school_year = ${season} AND kid_id IS NULL
    ORDER BY family_email, kid_first_name`;
  const pickStats = mapGroups('picks', pickRows, (kidId, fam, kid) => () => sql`
    UPDATE class_signup_picks SET kid_id = ${kidId}
    WHERE school_year = ${season} AND kid_id IS NULL
      AND LOWER(family_email) = ${String(fam || '').toLowerCase()}
      AND LOWER(kid_first_name) = ${String(kid || '').toLowerCase()}`);
  if (pickRows.length === 0) console.log('  No ' + season + ' pick rows with NULL kid_id.');

  // ══ STEP 2 — class_lottery_bumps (season, kid_id IS NULL) ════════════════
  console.log('\n════════ STEP 2 — map class_lottery_bumps (' + season + ') to kid_id ════════');
  const bumpRows = await sql`
    SELECT id, family_email, kid_first_name
    FROM class_lottery_bumps
    WHERE school_year = ${season} AND kid_id IS NULL
    ORDER BY family_email, kid_first_name`;
  const bumpStats = mapGroups('bumps', bumpRows, (kidId, fam, kid) => () => sql`
    UPDATE class_lottery_bumps SET kid_id = ${kidId}
    WHERE school_year = ${season} AND kid_id IS NULL
      AND LOWER(family_email) = ${String(fam || '').toLowerCase()}
      AND LOWER(kid_first_name) = ${String(kid || '').toLowerCase()}`);
  if (bumpRows.length === 0) console.log('  No ' + season + ' bump rows with NULL kid_id.');

  // ══ Summary ══════════════════════════════════════════════════════════════
  console.log('\n════════ SUMMARY ════════');
  console.log('  picks: ' + pickStats.rows + ' rows in ' + pickStats.groups + ' kid groups → '
    + pickStats.mapped + ' mapped, ' + pickStats.unresolved + ' UNRESOLVED (left untouched)');
  console.log('  bumps: ' + bumpStats.rows + ' rows in ' + bumpStats.groups + ' kid groups → '
    + bumpStats.mapped + ' mapped, ' + bumpStats.unresolved + ' UNRESOLVED (left untouched)');
  console.log('  total planned statements:    ' + ops.length);

  if (!apply) {
    console.log('\nDRY-RUN — nothing changed. Re-run with --apply to commit.');
    return;
  }
  // Thunks are only invoked here, so the dry-run above never touches the DB.
  // sql.transaction is all-or-nothing: any failure rolls everything back.
  try {
    await sql.transaction(ops.map(function (op) { return op(); }));
  } catch (e) {
    console.error('\n❌ APPLY FAILED — transaction rolled back, nothing was changed:', e.message);
    process.exit(1);
  }
  console.log('\n✅ Applied ' + ops.length + ' statements for ' + season + '.');
}
main().catch(e => { console.error('backfill-pick-kid-ids failed:', e.message); process.exit(1); });
