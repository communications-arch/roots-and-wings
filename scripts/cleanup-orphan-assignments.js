// Clean up morning_class_assignments rows left with kid_id IS NULL after
// backfill-kid-enrollments.js (pre-refactor rows keyed on nicknames or on
// kids since deleted). For each orphan row, within the same family:
//
//   REMAP  — exactly one kid whose first name prefix-matches the row's name
//            (junie → Juniper) AND who has no assignment row of their own
//            for the season: UPDATE SET kid_id (placement preserved).
//   DELETE — the prefix-matched kid ALREADY has their own assignment row
//            (maggie next to a mapped magnolia row = stale duplicate), or
//            no kid in the family matches at all (deleted kid, e.g. a
//            family that removed a child before re-registering).
//   SKIP   — anything ambiguous (two candidate kids, etc.) is printed and
//            left untouched for a human.
//
// DRY-RUN by default — prints the plan and changes NOTHING. Add --apply to
// commit (single transaction). Emails masked, same as the backfills.
//
//   node --env-file=<env> scripts/cleanup-orphan-assignments.js [--season=YYYY-YYYY] [--apply]
const { neon } = require('@neondatabase/serverless');

function mask(email) {
  const e = String(email || '');
  if (!e) return '';
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}

function norm(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// junie/Juniper, maggie/Magnolia: same first 3+ letters one way or the other.
function prefixMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y || x.length < 3 || y.length < 3) return false;
  return x.startsWith(y.slice(0, 3)) && y.startsWith(x.slice(0, 3));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set. Run with: node --env-file=<env> scripts/cleanup-orphan-assignments.js');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const seasonArg = args.find(a => a.startsWith('--season='));
  const season = seasonArg ? seasonArg.split('=')[1] : '2026-2027';
  const sql = neon(process.env.DATABASE_URL);

  console.log((apply ? '*** APPLY MODE ***' : 'DRY RUN (no writes)') + '  season=' + season + '\n');

  const orphans = await sql`
    SELECT id, family_email, kid_first_name, class_group
    FROM morning_class_assignments
    WHERE school_year = ${season} AND kid_id IS NULL
    ORDER BY family_email, kid_first_name`;
  if (orphans.length === 0) {
    console.log('No orphan assignment rows — nothing to do.');
    return;
  }

  const plan = []; // { action: 'remap'|'delete', id, kidId? , why }
  for (const o of orphans) {
    const fam = String(o.family_email || '').toLowerCase();
    const label = `assignment.id=${o.id} (${o.kid_first_name} @ ${mask(fam)}${o.class_group ? ', ' + o.class_group : ', unplaced'})`;
    const kids = await sql`
      SELECT id, first_name FROM kids WHERE LOWER(family_email) = ${fam}`;
    const candidates = kids.filter(k => prefixMatch(k.first_name, o.kid_first_name));
    if (candidates.length === 0) {
      plan.push({ action: 'delete', id: o.id });
      console.log(`  ${label} → DELETE (no kid in family matches — deleted kid)`);
      continue;
    }
    if (candidates.length > 1) {
      console.log(`  ${label} → SKIP (ambiguous: ${candidates.map(k => k.first_name).join(', ')})`);
      continue;
    }
    const kid = candidates[0];
    const existing = await sql`
      SELECT id FROM morning_class_assignments
      WHERE school_year = ${season} AND kid_id = ${kid.id}`;
    if (existing.length > 0) {
      plan.push({ action: 'delete', id: o.id });
      console.log(`  ${label} → DELETE (duplicate: ${kid.first_name} already has assignment.id=${existing[0].id})`);
    } else {
      plan.push({ action: 'remap', id: o.id, kidId: kid.id });
      console.log(`  ${label} → REMAP to ${kid.first_name} (kid_id=${kid.id})`);
    }
  }

  const remaps = plan.filter(p => p.action === 'remap');
  const deletes = plan.filter(p => p.action === 'delete');
  console.log(`\n════════ SUMMARY ════════`);
  console.log(`  remap:  ${remaps.length}`);
  console.log(`  delete: ${deletes.length}`);
  console.log(`  skip:   ${orphans.length - plan.length}`);

  if (!apply) {
    console.log('\nDRY-RUN — nothing changed. Re-run with --apply to commit.');
    return;
  }

  await sql.transaction(txn => {
    const stmts = [];
    for (const p of remaps) stmts.push(txn`UPDATE morning_class_assignments SET kid_id = ${p.kidId} WHERE id = ${p.id}`);
    for (const p of deletes) stmts.push(txn`DELETE FROM morning_class_assignments WHERE id = ${p.id}`);
    return stmts;
  });
  console.log(`\n✅ Applied: ${remaps.length} remapped, ${deletes.length} deleted.`);
}

main().catch(err => { console.error(err); process.exit(1); });
