// DEV-ONLY: seed a genuinely NEW family for The Newcomer persona (#352,
// Erin 2026-08-21 — newbiel@ Marilla Cuthbert now leads a class and has
// picks, so she no longer reads as a two-week-old family).
//
// Creates the Weasley family exactly as registration + onboarding would
// leave them two days in: member_profiles + people (MLC + BLC) + kids (2) +
// kid_enrollments (all-day) + a paid, signed 2026-2027 registration with
// the welcome email sent (so the Welcome Coordinator's list holds them) +
// ONE pending backup-coach waiver (so the waiver banner journey exists).
// No roles, no class submissions, no picks. Idempotent: re-running removes
// and re-creates the family. HARD-GUARDED to the dev Neon host.
//
//   node --env-file=.env.local.dev scripts/seed-dev-newcomer.js [--remove]

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const DEV_HOST_FRAGMENT = 'ep-shiny-recipe';
const SEASON = '2026-2027';
const FAM = {
  email: 'mollyw@rootsandwingsindy.com',
  last: 'Weasley',
  mlc: { first: 'Molly' },
  blc: { first: 'Arthur' },
  kids: [
    { first: 'Ginny', birth: '2017-08-11', group: 'Maples' },
    { first: 'Ron', birth: '2015-03-01', group: 'Willows' }
  ]
};

(async () => {
  const url = process.env.DATABASE_URL || '';
  if (url.indexOf(DEV_HOST_FRAGMENT) === -1) { console.error('Refusing: DATABASE_URL is not the dev branch.'); process.exit(2); }
  const sql = neon(url);
  const remove = process.argv.includes('--remove');
  const e = FAM.email;

  // ── remove (also the idempotency step) ──
  const regIds = (await sql`SELECT id FROM registrations WHERE LOWER(email) = ${e}`).map(r => r.id);
  if (regIds.length) await sql`DELETE FROM waiver_signatures WHERE registration_id = ANY(${regIds}::int[])`;
  await sql`DELETE FROM welcome_outreach WHERE registration_id = ANY(${regIds}::int[])`.catch(() => {});
  await sql`DELETE FROM registrations WHERE LOWER(email) = ${e}`;
  await sql`DELETE FROM kid_enrollments WHERE LOWER(family_email) = ${e}`;
  await sql`DELETE FROM kids WHERE LOWER(family_email) = ${e}`;
  await sql`DELETE FROM people WHERE LOWER(family_email) = ${e}`;
  await sql`DELETE FROM member_profiles WHERE LOWER(family_email) = ${e}`;
  await sql`DELETE FROM notifications WHERE LOWER(recipient_email) = ${e}`;
  if (remove) { console.log('removed the Weasley family from dev'); process.exit(0); }

  // ── create ──
  const mlcFull = `${FAM.mlc.first} ${FAM.last}`;
  const blcFull = `${FAM.blc.first} ${FAM.last}`;
  await sql`INSERT INTO member_profiles (family_email, family_name, updated_at, updated_by)
    VALUES (${e}, ${FAM.last}, now(), 'seed-dev-newcomer')`;
  await sql`INSERT INTO people (email, family_email, first_name, last_name, role, sort_order, photo_consent, updated_at, updated_by)
    VALUES (${e}, ${e}, ${FAM.mlc.first}, ${FAM.last}, 'mlc', 0, true, now(), 'seed-dev-newcomer')`;
  await sql`INSERT INTO people (email, family_email, first_name, last_name, role, sort_order, photo_consent, updated_at, updated_by)
    VALUES (NULL, ${e}, ${FAM.blc.first}, ${FAM.last}, 'blc', 1, true, now(), 'seed-dev-newcomer')`;
  let si = 0;
  for (const k of FAM.kids) {
    const ins = await sql`INSERT INTO kids (family_email, first_name, last_name, birth_date, schedule, class_group, photo_consent, sort_order, updated_at)
      VALUES (${e}, ${k.first}, ${FAM.last}, ${k.birth}, 'all-day', ${k.group}, true, ${si++}, now()) RETURNING id`;
    await sql`INSERT INTO kid_enrollments (kid_id, family_email, kid_first_name, season, schedule, status, source, updated_by)
      VALUES (${ins[0].id}, ${e}, ${k.first}, ${SEASON}, 'all-day', 'enrolled', 'registration', 'seed-dev-newcomer')`;
  }
  const regKids = FAM.kids.map(k => ({ name: `${k.first} ${FAM.last}`, birth_date: k.birth, photo_consent: true }));
  const reg = await sql`INSERT INTO registrations (season, email, family_email, main_learning_coach, address, phone, track, kids,
      waiver_member_agreement, waiver_photo_consent, waiver_liability, signature_name, signature_date,
      payment_status, created_profile, welcome_email_sent_at, created_at, updated_at)
    VALUES (${SEASON}, ${e}, ${e}, ${mlcFull}, '12 Grimmauld Pl, Indianapolis, IN', '317-555-0199', 'both', ${JSON.stringify(regKids)},
      true, true, true, ${mlcFull}, (now() - interval '2 days')::date,
      'paid', true, now() - interval '1 day', now() - interval '2 days', now() - interval '1 day')
    RETURNING id`;
  // The backup coach's waiver is still unsigned — the newcomer's waiver
  // journey. Registration mints pending_token + sent_at at sign-up time
  // (api/tour.js handleRegistration); the My Family banner keys on the token.
  const token = crypto.randomUUID().replace(/-/g, '');
  await sql`INSERT INTO waiver_signatures (season, role, person_name, person_email, family_email, registration_id, pending_token, sent_at, signed_at, photo_consent)
    VALUES (${SEASON}, 'backup_coach', ${blcFull}, ${e}, ${e}, ${reg[0].id}, ${token}, now() - interval '2 days', NULL, true)`;
  console.log(`seeded ${mlcFull} <${e}> — registration #${reg[0].id}, 2 kids enrolled all-day, 1 pending BLC waiver, welcome email sent yesterday`);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
