// Round-trip a fake PM class submission through the DB to verify the
// class_submissions schema matches what the API expects. Cleans up after
// itself so the table stays empty. Run:
//   node --env-file=.env.local scripts/smoke-class-submissions.js
const { neon } = require('@neondatabase/serverless');
(async () => {
  const sql = neon(process.env.DATABASE_URL);

  const fake = {
    submitted_by_email: 'smoke-test@rootsandwingsindy.com',
    submitted_by_name: 'Smoke Test',
    school_year: '2026-2027',
    class_name: 'Smoke Test Class',
    session_preferences: ['1', '3', 'flexible'],
    hour_preference: ['first', 'flexible'],
    assistant_count: [1, 2],
    co_teachers: 'Nobody yet',
    space_request: ['any', 'larger-open'],
    space_request_other: '',
    max_students: 12,
    max_students_other: '',
    age_groups: ['7-9', '10-12'],
    age_groups_other: '',
    pre_enroll_kids: 'My own kids',
    prerequisites: 'Bring a notebook',
    description: 'A smoke-test class to verify the round trip.',
    other_info: 'Delete me after verification.'
  };

  console.log('INSERT…');
  const inserted = await sql`
    INSERT INTO class_submissions (
      submitted_by_email, submitted_by_name, school_year,
      class_name, session_preferences, hour_preference, assistant_count,
      co_teachers, space_request, space_request_other,
      max_students, max_students_other, age_groups, age_groups_other,
      pre_enroll_kids, prerequisites, description, other_info
    )
    VALUES (
      ${fake.submitted_by_email}, ${fake.submitted_by_name}, ${fake.school_year},
      ${fake.class_name}, ${fake.session_preferences}, ${fake.hour_preference}, ${fake.assistant_count},
      ${fake.co_teachers}, ${fake.space_request}, ${fake.space_request_other},
      ${fake.max_students}, ${fake.max_students_other}, ${fake.age_groups}, ${fake.age_groups_other},
      ${fake.pre_enroll_kids}, ${fake.prerequisites}, ${fake.description}, ${fake.other_info}
    )
    RETURNING *
  `;
  const row = inserted[0];
  console.log('  inserted id:', row.id);
  console.log('  arrays came back as:', {
    session_preferences: row.session_preferences,
    hour_preference: row.hour_preference,
    assistant_count: row.assistant_count,
    space_request: row.space_request,
    age_groups: row.age_groups
  });
  console.log('  scalars:', {
    class_name: row.class_name,
    max_students: row.max_students,
    status: row.status,
    created_at: row.created_at
  });

  console.log('\nSELECT by submitter (mimics list-mine query)…');
  const mine = await sql`
    SELECT id, class_name, status FROM class_submissions
    WHERE LOWER(submitted_by_email) = LOWER(${fake.submitted_by_email})
    ORDER BY created_at DESC
  `;
  console.log('  rows:', mine);

  console.log('\nDELETE test row…');
  await sql`DELETE FROM class_submissions WHERE id = ${row.id}`;

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM class_submissions`;
  console.log('  class_submissions count after cleanup:', n);

  if (n !== 0) {
    console.error('WARN: rows still present — inspect manually');
    process.exit(1);
  }
  console.log('\nSmoke test passed.');
})();
