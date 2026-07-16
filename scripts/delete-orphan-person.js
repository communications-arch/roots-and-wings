// Inspect and delete an orphan/duplicate people row (e.g. the 2026-07-16
// "Cam/Cammie Goodnight" duplicate created by the legal-first-name-only
// matcher, fixed in api/tour.js the same day).
//
// Inspect (lists the family's people rows + loose-reference counts,
// emails partially masked so PII stays out of terminals/transcripts):
//   node --env-file=.env.local scripts/delete-orphan-person.js <family-fragment>
// Delete one row by id (also removes its loose references):
//   node --env-file=.env.local scripts/delete-orphan-person.js <family-fragment> --delete <people.id>
//
// Loose references cleaned on delete (nothing cascades from people):
// waiver_signatures / role_holders_v2 / class_assignment_helpers /
// volunteer_signups / special_event_people by the row's email(s);
// name-keyed tables (absences.absent_person) are reported, not deleted.
const { neon } = require('@neondatabase/serverless');

function mask(email) {
  const e = String(email || '');
  if (!e) return '';
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}

async function main() {
  const frag = process.argv[2];
  const delFlag = process.argv.indexOf('--delete');
  const deleteId = delFlag !== -1 ? parseInt(process.argv[delFlag + 1], 10) : null;
  if (!frag) {
    console.error('Usage: node --env-file=.env.local scripts/delete-orphan-person.js <family-fragment> [--delete <people.id>]');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);

  const fams = await sql`
    SELECT family_email, family_name FROM member_profiles
    WHERE family_name ILIKE ${'%' + frag + '%'} OR family_email ILIKE ${'%' + frag + '%'}
  `;
  if (fams.length === 0) { console.log('No family matches', JSON.stringify(frag)); return; }

  for (const fam of fams) {
    console.log('\n=== Family:', fam.family_name, '(' + mask(fam.family_email) + ') ===');
    const people = await sql`
      SELECT id, first_name, last_name, nickname, role, email, personal_email,
             sort_order, updated_by, updated_at
      FROM people WHERE LOWER(family_email) = LOWER(${fam.family_email})
      ORDER BY sort_order, id
    `;
    for (const p of people) {
      console.log(
        ' people.id=' + p.id,
        '| ' + p.first_name + ' ' + (p.last_name || ''),
        '| goes-by:', p.nickname || '—',
        '| role:', p.role,
        '| email:', mask(p.email) || '—',
        '| personal:', mask(p.personal_email) || '—',
        '| sort:', p.sort_order,
        '| by:', p.updated_by,
        '| at:', p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 10) : '—'
      );
      const emails = [p.email, p.personal_email].filter(Boolean).map(e => String(e).toLowerCase());
      if (emails.length) {
        const refs = await sql`
          SELECT
            (SELECT COUNT(*) FROM waiver_signatures WHERE LOWER(person_email) = ANY(${emails}))::int AS waivers,
            (SELECT COUNT(*) FROM role_holders_v2 WHERE LOWER(person_email) = ANY(${emails}))::int AS role_holders,
            (SELECT COUNT(*) FROM class_assignment_helpers WHERE LOWER(person_email) = ANY(${emails}))::int AS class_helpers,
            (SELECT COUNT(*) FROM volunteer_signups WHERE LOWER(person_email) = ANY(${emails}))::int AS vol_signups,
            (SELECT COUNT(*) FROM special_event_people WHERE LOWER(person_email) = ANY(${emails}))::int AS event_people
        `;
        console.log('   refs:', JSON.stringify(refs[0]));
      }
      const absCount = await sql`
        SELECT COUNT(*)::int AS n FROM absences
        WHERE LOWER(absent_person) LIKE ${(p.first_name || '').toLowerCase() + '%'}
          AND LOWER(family_email) = LOWER(${fam.family_email})
      `;
      if (absCount[0].n > 0) console.log('   absences rows matching first name:', absCount[0].n, '(NOT auto-deleted)');
    }

    // Kids too — the duplicate may be a kid row rather than an adult.
    const kids = await sql`
      SELECT id, first_name, last_name, nickname, birth_date IS NOT NULL AS has_bday, sort_order
      FROM kids WHERE LOWER(family_email) = LOWER(${fam.family_email})
      ORDER BY sort_order, id
    `;
    for (const k of kids) {
      console.log(
        ' kids.id=' + k.id,
        '| ' + k.first_name + ' ' + (k.last_name || ''),
        '| goes-by:', k.nickname || '—',
        '| birth date on file:', k.has_bday ? 'yes' : 'NO',
        '| sort:', k.sort_order,
        '  (kids: delete manually if this is the orphan — pass nothing here)'
      );
    }

    if (deleteId) {
      const target = people.find(p => p.id === deleteId);
      if (!target) { console.log('\n--delete id', deleteId, 'is not a people row in this family — nothing deleted.'); continue; }
      const emails = [target.email, target.personal_email].filter(Boolean).map(e => String(e).toLowerCase());
      if (emails.length) {
        const d1 = await sql`DELETE FROM waiver_signatures WHERE LOWER(person_email) = ANY(${emails}) RETURNING id`;
        const d2 = await sql`DELETE FROM role_holders_v2 WHERE LOWER(person_email) = ANY(${emails}) RETURNING id`;
        const d3 = await sql`DELETE FROM class_assignment_helpers WHERE LOWER(person_email) = ANY(${emails}) RETURNING id`;
        const d4 = await sql`DELETE FROM volunteer_signups WHERE LOWER(person_email) = ANY(${emails}) RETURNING id`;
        const d5 = await sql`DELETE FROM special_event_people WHERE LOWER(person_email) = ANY(${emails}) RETURNING id`;
        console.log('\n Deleted refs — waivers:', d1.length, 'role_holders:', d2.length,
          'class_helpers:', d3.length, 'vol_signups:', d4.length, 'event_people:', d5.length);
      }
      const gone = await sql`DELETE FROM people WHERE id = ${deleteId} RETURNING id, first_name`;
      console.log(' Deleted people row:', JSON.stringify({ id: gone[0].id, first_name: gone[0].first_name }));
    }
  }
  if (!deleteId) console.log('\n(inspect only — re-run with --delete <people.id> to remove the orphan)');
}

main().catch(e => { console.error(e); process.exit(1); });
