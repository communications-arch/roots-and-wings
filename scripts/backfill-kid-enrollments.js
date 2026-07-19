// One-time backfill for the per-season kid_enrollments table (and the new
// morning_class_assignments.kid_id column). Three steps:
//
//   STEP 1 — dedupe kids rows that share (family_email, first_name): keep the
//            row with a non-empty class_group if exactly one has it, else the
//            newest updated_at; DELETE the losers.
//   STEP 2 — seed kid_enrollments for the season: every surviving kid gets a
//            row — status 'enrolled' if their family has a non-declined
//            registration for the season, else 'not_returning'. Upserts are
//            ON CONFLICT (kid_id, season) DO NOTHING, so rows the live app
//            already wrote are never clobbered.
//   STEP 3 — map morning_class_assignments rows for the season (kid_id IS
//            NULL) onto real kids.id, matching by (family_email, first name)
//            first, then via the registration-derived Workspace email for
//            families whose Builder rows were keyed on a derived email that
//            differs from the real family_email (compound-surname cases).
//
// A registration "matches" a family when EITHER its derived Workspace email
// (firstParentFirst + familyLastInitial + @rootsandwingsindy.com — same rule
// as deriveWorkspaceEmail in script.js / api/sheets.js parseDirectory) equals
// kids.family_email, OR its derived family name equals the family's
// member_profiles.family_name (case-insensitive).
//
// DRY-RUN by default — prints the exact plan and changes NOTHING. Add --apply
// to commit (single transaction; any error rolls the whole thing back).
// Emails are masked so member PII stays out of terminals/transcripts.
//
//   node --env-file=<env> scripts/backfill-kid-enrollments.js [--season=YYYY-YYYY] [--apply]
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

function normalizeSchedule(v) {
  const s = String(v || '').trim().toLowerCase();
  return (s === 'morning' || s === 'afternoon') ? s : 'all-day';
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

  // ══ STEP 1 — dedupe kids sharing (family_email, first_name) ═════════════
  console.log('\n════════ STEP 1 — dedupe duplicate kids rows ════════');
  const allKids = await sql`
    SELECT id, family_email, first_name, last_name, schedule, class_group, updated_at
    FROM kids ORDER BY id`;
  const groups = new Map();
  for (const k of allKids) {
    const key = String(k.family_email || '').toLowerCase() + '|' + String(k.first_name || '').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(k);
  }
  const deadKidIds = new Set();
  let dupGroups = 0;
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    dupGroups++;
    const withGroup = rows.filter(r => String(r.class_group || '').trim() !== '');
    let keeper;
    if (withGroup.length === 1) keeper = withGroup[0];
    else {
      // Newest updated_at wins (tie → highest id).
      keeper = rows.slice().sort((a, b) =>
        (new Date(b.updated_at || 0) - new Date(a.updated_at || 0)) || (b.id - a.id))[0];
    }
    console.log('  DUP: ' + rows[0].first_name + ' @ ' + mask(rows[0].family_email)
      + '  → keep kids.id=' + keeper.id
      + ' (group:' + (keeper.class_group || '—') + ', updated:' + (keeper.updated_at ? new Date(keeper.updated_at).toISOString().slice(0, 10) : '—') + ')');
    for (const r of rows) {
      if (r.id === keeper.id) continue;
      deadKidIds.add(r.id);
      console.log('    - DELETE FROM kids WHERE id=' + r.id
        + '  (group:' + (r.class_group || '—') + ', schedule:' + (r.schedule || '—') + ')');
      ops.push(() => sql`DELETE FROM kids WHERE id = ${r.id}`);
    }
  }
  if (dupGroups === 0) console.log('  No duplicate kids found.');
  const kids = allKids.filter(k => !deadKidIds.has(k.id));

  // ══ STEP 2 — seed kid_enrollments for the season ═════════════════════════
  console.log('\n════════ STEP 2 — seed kid_enrollments for ' + season + ' ════════');
  const regs = await sql`
    SELECT id, family_email, main_learning_coach, existing_family_name, kids
    FROM registrations
    WHERE season = ${season} AND declined_at IS NULL`;
  const profiles = await sql`SELECT family_email, family_name FROM member_profiles`;
  const profileNameByEmail = new Map(profiles.map(p =>
    [String(p.family_email || '').toLowerCase(), String(p.family_name || '').trim()]));
  // Family-name fallback rule is only safe when the surname is UNIQUE
  // across profiles (ship-gate 2026-07-19: two "Smith" families must not
  // cross-match). Count occurrences.
  const profileNameCounts = new Map();
  for (const name of profileNameByEmail.values()) {
    const n = name.toLowerCase();
    if (n) profileNameCounts.set(n, (profileNameCounts.get(n) || 0) + 1);
  }

  // Per registration: the STORED family_email (authoritative link, set at
  // registration time since 2026-07-17) plus the derived Workspace email +
  // derived family name as legacy fallbacks for older rows. kidFirsts =
  // the first-name tokens the registration actually enrolled.
  const regDerived = regs.map(r => {
    let regKids = r.kids;
    if (typeof regKids === 'string') { try { regKids = JSON.parse(regKids); } catch (e) { regKids = []; } }
    const kidFirsts = new Set((Array.isArray(regKids) ? regKids : [])
      .map(k => String((k && (k.first_name || k.name)) || '').trim().split(/\s+/)[0].toLowerCase())
      .filter(Boolean));
    return {
      id: r.id,
      stored: String(r.family_email || '').toLowerCase(),
      email: deriveEmail(r.main_learning_coach, r.existing_family_name).toLowerCase(),
      famName: deriveFamilyName(r.main_learning_coach, r.existing_family_name).toLowerCase(),
      kidFirsts
    };
  });

  // For each family (by kids.family_email), the season registrations that
  // match it — used both here (enrolled?) and in STEP 3 (derived emails).
  const regsByFamily = new Map();
  function matchingRegs(familyEmail) {
    const fe = String(familyEmail || '').toLowerCase();
    if (regsByFamily.has(fe)) return regsByFamily.get(fe);
    const profName = (profileNameByEmail.get(fe) || '').toLowerCase();
    const nameIsUnique = profName && profileNameCounts.get(profName) === 1;
    const hits = regDerived.filter(r =>
      (r.stored && r.stored === fe)
      || (r.email && r.email === fe)
      || (r.famName && nameIsUnique && r.famName === profName));
    regsByFamily.set(fe, hits);
    return hits;
  }

  const famStats = new Map(); // familyEmailLower → {enrolled, not_returning}
  let plannedInserts = 0;
  for (const k of kids) {
    const fe = String(k.family_email || '').toLowerCase();
    // PER-KID enrollment (ship-gate 2026-07-19): a matching registration
    // makes only the kids it actually CONTAINS 'enrolled' — a dropped
    // sibling in a partially re-registered family stays not_returning
    // (the exact over-count this refactor exists to fix).
    const kidFirst = String(k.first_name || '').trim().split(/\s+/)[0].toLowerCase();
    const famRegs = matchingRegs(fe);
    const inAReg = famRegs.some(r => r.kidFirsts.has(kidFirst));
    const status = inAReg ? 'enrolled' : 'not_returning';
    const schedule = normalizeSchedule(k.schedule);
    if (!famStats.has(fe)) famStats.set(fe, { enrolled: 0, not_returning: 0 });
    famStats.get(fe)[status]++;
    plannedInserts++;
    ops.push(() => sql`
      INSERT INTO kid_enrollments (kid_id, family_email, kid_first_name, season,
                                   schedule, status, source, updated_by)
      VALUES (${k.id}, ${k.family_email || ''}, ${k.first_name || ''}, ${season},
              ${schedule}, ${status}, 'backfill', 'backfill-script')
      ON CONFLICT (kid_id, season) DO NOTHING`);
  }
  const famList = Array.from(famStats.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [fe, s] of famList) {
    console.log('  ' + mask(fe) + '  → ' + s.enrolled + ' enrolled, ' + s.not_returning + ' not_returning');
  }
  console.log('  Planned INSERT ... ON CONFLICT DO NOTHING: ' + plannedInserts
    + ' kid_enrollments rows across ' + famStats.size + ' families'
    + ' (existing rows for the same kid+season are left untouched).');

  // ══ STEP 3 — map morning_class_assignments → kid_id ══════════════════════
  console.log('\n════════ STEP 3 — map morning_class_assignments (' + season + ') to kid_id ════════');
  const assigns = await sql`
    SELECT id, family_email, kid_first_name, class_group
    FROM morning_class_assignments
    WHERE school_year = ${season} AND kid_id IS NULL
    ORDER BY family_email, kid_first_name`;
  let mapped = 0, unresolved = 0;
  for (const a of assigns) {
    const ae = String(a.family_email || '').toLowerCase();
    const afn = String(a.kid_first_name || '').toLowerCase();
    // Pass 1: exact (family_email, first_name) match on surviving kids.
    let candidates = kids.filter(k =>
      String(k.family_email || '').toLowerCase() === ae
      && String(k.first_name || '').toLowerCase() === afn);
    // Pass 2: the assignment was keyed on a registration-DERIVED email that
    // differs from the real family_email — accept a first-name match whose
    // family's matching season registration derives to exactly this email.
    if (candidates.length === 0) {
      candidates = kids.filter(k =>
        String(k.first_name || '').toLowerCase() === afn
        && matchingRegs(k.family_email).some(r => r.email === ae));
    }
    if (candidates.length === 1) {
      const k = candidates[0];
      mapped++;
      const differs = String(k.family_email || '').toLowerCase() !== ae;
      console.log('  assignment.id=' + a.id + ' (' + a.kid_first_name + ' @ ' + mask(a.family_email)
        + ', ' + (a.class_group || 'unplaced') + ') → UPDATE SET kid_id=' + k.id
        + (differs ? '  ⚠ assignment email differs from kid family_email ' + mask(k.family_email) + ' (email left as-is)' : ''));
      ops.push(() => sql`UPDATE morning_class_assignments SET kid_id = ${k.id} WHERE id = ${a.id}`);
    } else {
      unresolved++;
      console.log('  assignment.id=' + a.id + ' (' + a.kid_first_name + ' @ ' + mask(a.family_email)
        + ') → UNRESOLVED (' + (candidates.length === 0 ? 'no matching kid' : candidates.length + ' candidates') + ') — untouched');
    }
  }
  if (assigns.length === 0) console.log('  No ' + season + ' assignments with NULL kid_id.');

  // ══ Summary ══════════════════════════════════════════════════════════════
  console.log('\n════════ SUMMARY ════════');
  console.log('  kids to delete (dupes):      ' + deadKidIds.size + ' (in ' + dupGroups + ' duplicate groups)');
  console.log('  enrollments to seed:         ' + plannedInserts + ' (' + famStats.size + ' families)');
  console.log('  assignments to map:          ' + mapped);
  console.log('  assignments UNRESOLVED:      ' + unresolved + ' (left untouched)');
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
main().catch(e => { console.error('backfill-kid-enrollments failed:', e.message); process.exit(1); });
