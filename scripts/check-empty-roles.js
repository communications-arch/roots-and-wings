// Lists role_descriptions rows that have ZERO role_holders for the
// current school year. Run after seed-role-holders.js to spot rows
// where the volunteer cell had names but the seed couldn't resolve
// any of them.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { neon } = require('@neondatabase/serverless');

(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const year = process.argv[2] || '2025-2026';

  const counts = await sql`
    SELECT rd.id, rd.title, rd.category, rd.status,
           COUNT(rh.id)::int AS n_holders
    FROM role_descriptions rd
    LEFT JOIN role_holders rh
      ON rh.role_id = rd.id AND rh.school_year = ${year}
    WHERE rd.status = 'active'
      AND rd.category IN ('board','committee_role')
    GROUP BY rd.id, rd.title, rd.category, rd.status
    ORDER BY n_holders, rd.category, rd.title
  `;

  console.log(`Role holder counts for ${year}:\n`);
  counts.forEach(r => {
    console.log(`  ${String(r.n_holders).padStart(2)} | ${r.category.padEnd(16)} | ${r.title}`);
  });

  const empty = counts.filter(r => r.n_holders === 0);
  console.log(`\n${empty.length} of ${counts.length} active board/committee roles have no holder.`);
})().catch(e => { console.error(e); process.exit(1); });
