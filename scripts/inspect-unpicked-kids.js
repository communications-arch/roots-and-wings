// #134 diagnostic: which afternoon-eligible "enrolled" kids belong to
// withdrawn / not-returning families? DEV DB only.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'member_profiles' ORDER BY ordinal_position`;
  console.log('member_profiles cols:', cols.map(c => c.column_name).join(', '));
  const kids = await sql`
    SELECT k.first_name, e.season, e.status AS enroll_status, e.schedule,
           LOWER(e.family_email) AS fam, mp.family_name, mp.withdrawn_at
    FROM kid_enrollments e
    JOIN kids k ON k.id = e.kid_id
    LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(e.family_email)
    WHERE e.status = 'enrolled' AND e.schedule IN ('all-day', 'afternoon')
    ORDER BY e.season, mp.family_name`;
  kids.forEach(r => console.log(`${r.season} | ${r.fam} ${r.family_name || '?'} | ${r.first_name} | withdrawn:${r.withdrawn_at ? 'YES' : 'no'}`));
})().catch(e => { console.error(e.message); process.exit(1); });
