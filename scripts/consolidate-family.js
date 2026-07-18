// Consolidate duplicate/split family profiles into ONE keeper. Moves the other
// matching profiles' adults, kids, and registrations onto the keeper, folds
// their login emails into the keeper's additional_emails, then deletes the now
// -empty duplicate profiles. Handles the compound-surname split (e.g. two
// derived emails for "Aimee O'Connor Gading").
//
// DRY-RUN by default — prints the exact plan and changes nothing. Add --apply
// to commit (runs in a single transaction). Emails are printed UNMASKED, so
// run it in YOUR terminal, not in a shared transcript.
//
//   node scripts/consolidate-family.js <fragment>              # list profiles with [index]
//   node scripts/consolidate-family.js <fragment> --keep <n>   # dry-run the merge plan
//   node scripts/consolidate-family.js <fragment> --keep <n> --apply
//
// Guards: an adult/kid is only MOVED if the keeper doesn't already have one
// with the same email (adults) or same first name (kids) — otherwise it's
// reported as a would-be duplicate and skipped, so nothing collides. Dedupe a
// leftover doubled kid separately with delete-orphan-person.js --delete-kid.
const { neon } = require('@neondatabase/serverless');

async function main() {
  const frag = process.argv[2];
  const keepFlag = process.argv.indexOf('--keep');
  const keepIdx = keepFlag !== -1 ? parseInt(process.argv[keepFlag + 1], 10) : null;
  const apply = process.argv.includes('--apply');
  if (!frag) {
    console.error('Usage: node scripts/consolidate-family.js <fragment> [--keep <n>] [--apply]');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  const like = '%' + frag + '%';

  const fams = await sql`
    SELECT family_email, family_name, additional_emails, alt_logins
    FROM member_profiles
    WHERE family_name ILIKE ${like} OR family_email ILIKE ${like}
       OR EXISTS (SELECT 1 FROM unnest(additional_emails) ae WHERE ae ILIKE ${like})
       OR EXISTS (SELECT 1 FROM unnest(alt_logins) al WHERE al ILIKE ${like})
    ORDER BY family_email`;
  if (fams.length === 0) { console.log('No member_profiles match', JSON.stringify(frag)); return; }

  // Count contents per profile so the list is meaningful.
  for (let i = 0; i < fams.length; i++) {
    const f = fams[i];
    const c = await sql`
      SELECT
        (SELECT COUNT(*) FROM people WHERE LOWER(family_email)=LOWER(${f.family_email}))::int AS adults,
        (SELECT COUNT(*) FROM kids   WHERE LOWER(family_email)=LOWER(${f.family_email}))::int AS kids,
        (SELECT COUNT(*) FROM registrations WHERE LOWER(family_email)=LOWER(${f.family_email}) OR LOWER(email)=LOWER(${f.family_email}))::int AS regs`;
    console.log(`[${i + 1}] ${f.family_name}  <${f.family_email}>  adults=${c[0].adults} kids=${c[0].kids} regs=${c[0].regs}`);
  }

  if (!keepIdx || keepIdx < 1 || keepIdx > fams.length) {
    console.log('\nPick the keeper: re-run with  --keep <index from the list above>');
    return;
  }
  const keeper = fams[keepIdx - 1];
  const others = fams.filter((_, i) => i !== keepIdx - 1);
  if (others.length === 0) { console.log('\nOnly one profile — nothing to consolidate.'); return; }

  console.log(`\nKEEPER: [${keepIdx}] ${keeper.family_name} <${keeper.family_email}>`);
  const keepPeople = await sql`SELECT LOWER(email) e, LOWER(first_name) fn FROM people WHERE LOWER(family_email)=LOWER(${keeper.family_email})`;
  const keepKidNames = new Set((await sql`SELECT LOWER(first_name) fn FROM kids WHERE LOWER(family_email)=LOWER(${keeper.family_email})`).map(k => k.fn));
  const keepEmails = new Set(keepPeople.map(p => p.e).filter(Boolean));
  const extraLogins = new Set();

  const ops = [];
  for (const o of others) {
    console.log(`\n  Merging [${fams.indexOf(o) + 1}] <${o.family_email}> into keeper:`);
    const oPeople = await sql`SELECT id, first_name, last_name, role, email FROM people WHERE LOWER(family_email)=LOWER(${o.family_email})`;
    for (const p of oPeople) {
      const dup = (p.email && keepEmails.has(String(p.email).toLowerCase()));
      if (dup) { console.log(`    - adult ${p.first_name} (${p.email}) already on keeper → SKIP move (would duplicate)`); }
      else { console.log(`    - move adult ${p.first_name} ${p.last_name || ''} (people.id=${p.id})`); ops.push(() => sql`UPDATE people SET family_email=${keeper.family_email} WHERE id=${p.id}`); }
    }
    const oKids = await sql`SELECT id, first_name FROM kids WHERE LOWER(family_email)=LOWER(${o.family_email})`;
    for (const k of oKids) {
      if (keepKidNames.has(String(k.first_name).toLowerCase())) { console.log(`    - kid ${k.first_name} (kids.id=${k.id}) already on keeper → SKIP move (would duplicate)`); }
      else { console.log(`    - move kid ${k.first_name} (kids.id=${k.id})`); ops.push(() => sql`UPDATE kids SET family_email=${keeper.family_email} WHERE id=${k.id}`); }
    }
    const oRegs = await sql`SELECT id, season FROM registrations WHERE LOWER(family_email)=LOWER(${o.family_email}) OR LOWER(email)=LOWER(${o.family_email})`;
    for (const r of oRegs) {
      console.log(`    - move registration reg.id=${r.id} (${r.season}) → family_email=keeper`);
      ops.push(() => sql`UPDATE registrations SET family_email=${keeper.family_email} WHERE id=${r.id}`);
    }
    // Its login emails should still resolve to the keeper.
    extraLogins.add(String(o.family_email).toLowerCase());
    (o.additional_emails || []).forEach(e => extraLogins.add(String(e).toLowerCase()));
    (o.alt_logins || []).forEach(e => extraLogins.add(String(e).toLowerCase()));
    console.log(`    - delete empty profile <${o.family_email}>`);
    ops.push(() => sql`DELETE FROM member_profiles WHERE LOWER(family_email)=LOWER(${o.family_email})`);
  }

  // Fold the other profiles' emails into the keeper (minus the keeper's own).
  const mergedAdditional = Array.from(new Set([...(keeper.additional_emails || []).map(e => e.toLowerCase()), ...extraLogins]))
    .filter(e => e && e !== String(keeper.family_email).toLowerCase());
  console.log(`\n  Keeper additional_emails → ${JSON.stringify(mergedAdditional)}`);
  ops.push(() => sql`UPDATE member_profiles SET additional_emails=${mergedAdditional}::text[] WHERE LOWER(family_email)=LOWER(${keeper.family_email})`);

  if (!apply) { console.log('\nDRY-RUN — nothing changed. Re-run with --apply to commit.'); return; }
  // Thunks are only invoked here, so the dry-run above never touches the DB.
  await sql.transaction(ops.map(function (op) { return op(); }));
  console.log('\n✅ Applied. Consolidated into <' + keeper.family_email + '>.');
}
main().catch(e => { console.error('consolidate-family failed:', e.message); process.exit(1); });
