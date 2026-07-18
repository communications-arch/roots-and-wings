// READ-ONLY diagnostic for a family that looks duplicated / split across two
// profiles, or whose kids show wrong in the Morning Builder / Directory.
// Emails are masked so member PII stays out of terminals/transcripts.
// It changes NOTHING — inspect only.
//
//   node --env-file=<prod env file> scripts/inspect-family.js <name-or-email-fragment>
//
// Shows, for every member_profiles row matching the fragment (by family_name,
// family_email, additional_emails, or alt_logins):
//   - the profile's family_email + alternate/login emails
//   - its adults (people): name, role, email, personal_email
//   - its kids: name, goes-by, SCHEDULE (all-day/morning/afternoon), birthday-on-file
//   - registrations tied to it (by family_email OR the typed email): season,
//     track, declined?, and the kid names in that registration's snapshot
// Use it to see the split (which profile has the kids, which has the login),
// each kid's schedule (stale all-day vs afternoon), and which registrations
// feed the Morning Builder.
const { neon } = require('@neondatabase/serverless');

function mask(email) {
  const e = String(email || '');
  if (!e) return '';
  const at = e.indexOf('@');
  if (at <= 1) return e ? '*@' + e.slice(at + 1) : '';
  return e.slice(0, 2) + '***@' + e.slice(at + 1);
}
function maskList(arr) {
  if (!Array.isArray(arr) || !arr.length) return '—';
  return arr.map(mask).join(', ');
}

async function main() {
  const frag = process.argv[2];
  if (!frag) {
    console.error('Usage: node --env-file=<env> scripts/inspect-family.js <name-or-email-fragment>');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  const like = '%' + frag + '%';

  const fams = await sql`
    SELECT family_email, family_name, additional_emails, alt_logins
    FROM member_profiles
    WHERE family_name ILIKE ${like}
       OR family_email ILIKE ${like}
       OR EXISTS (SELECT 1 FROM unnest(additional_emails) ae WHERE ae ILIKE ${like})
       OR EXISTS (SELECT 1 FROM unnest(alt_logins) al WHERE al ILIKE ${like})
    ORDER BY family_name, family_email
  `;
  if (fams.length === 0) { console.log('No member_profiles match', JSON.stringify(frag)); }

  for (const fam of fams) {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('PROFILE:', fam.family_name, '   family_email:', mask(fam.family_email));
    console.log('  additional_emails:', maskList(fam.additional_emails));
    console.log('  alt_logins (super-user set):', maskList(fam.alt_logins));

    const people = await sql`
      SELECT id, first_name, last_name, nickname, role, email, personal_email, updated_by
      FROM people WHERE LOWER(family_email) = LOWER(${fam.family_email})
      ORDER BY sort_order, id`;
    console.log('  ADULTS (' + people.length + '):');
    for (const p of people) {
      console.log('   people.id=' + p.id, '|', (p.first_name + ' ' + (p.last_name || '')).trim(),
        '| role:', p.role, '| email:', mask(p.email) || '—', '| personal:', mask(p.personal_email) || '—',
        '| by:', p.updated_by || '—');
    }

    const kids = await sql`
      SELECT id, first_name, last_name, nickname, schedule, class_group,
             birth_date IS NOT NULL AS has_bday
      FROM kids WHERE LOWER(family_email) = LOWER(${fam.family_email})
      ORDER BY sort_order, id`;
    console.log('  KIDS (' + kids.length + '):');
    for (const k of kids) {
      console.log('   kids.id=' + k.id, '|', (k.first_name + ' ' + (k.last_name || '')).trim(),
        '| goes-by:', k.nickname || '—', '| schedule:', k.schedule || '(none)',
        '| group:', k.class_group || '—', '| birthday:', k.has_bday ? 'yes' : 'NO');
    }

    const regs = await sql`
      SELECT id, season, track, payment_status, declined_at, email, family_email, kids
      FROM registrations
      WHERE LOWER(family_email) = LOWER(${fam.family_email})
         OR LOWER(email) = LOWER(${fam.family_email})
      ORDER BY season DESC, id`;
    console.log('  REGISTRATIONS (' + regs.length + '):');
    for (const r of regs) {
      const kidNames = Array.isArray(r.kids)
        ? r.kids.map(k => (k && (k.name || k.first_name)) || '?').join(', ') : '—';
      console.log('   reg.id=' + r.id, '| season:', r.season, '| track:', r.track || '—',
        '| pay:', r.payment_status || '—', '| declined:', r.declined_at ? 'YES' : 'no',
        '| typed-email:', mask(r.email), '| family_email:', mask(r.family_email),
        '\n        reg kids:', kidNames);
    }
  }
  console.log('\n(Read-only — nothing was changed.)');
}
main().catch(e => { console.error('inspect-family failed:', e.message); process.exit(1); });
