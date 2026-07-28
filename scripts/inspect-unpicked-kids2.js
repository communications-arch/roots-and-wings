// #134 diagnostic part 2: enrollment statuses + who registered for 26/27.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const st = await sql`SELECT season, status, COUNT(*)::int AS n FROM kid_enrollments GROUP BY season, status ORDER BY season, status`;
  console.log('kid_enrollments by season/status:', JSON.stringify(st));
  const regs = await sql`SELECT season, LOWER(COALESCE(NULLIF(family_email,''), email)) AS fam, payment_status FROM registrations ORDER BY season`;
  console.log('registrations:');
  regs.forEach(r => console.log(' ', r.season, '|', r.fam, '|', r.payment_status));
  const pool = await sql`
    SELECT DISTINCT LOWER(e.family_email) AS fam FROM kid_enrollments e
    WHERE e.status = 'enrolled' AND e.schedule IN ('all-day','afternoon') AND e.season = '2026-2027'`;
  const regSet = new Set(regs.filter(r => r.season === '2026-2027').map(r => r.fam));
  console.log('POOL FAMILIES WITHOUT A 2026-2027 REGISTRATION:');
  pool.forEach(p => { if (!regSet.has(p.fam)) console.log('  ', p.fam); });
})().catch(e => { console.error(e.message); process.exit(1); });
