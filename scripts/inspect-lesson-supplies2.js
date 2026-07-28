// One-off diagnostic part 2: compare duplicate plans' lessons + supplies.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  for (const id of [9, 10, 5, 6, 8, 11]) {
    const ls = await sql`
      SELECT l.lesson_number, l.title, LENGTH(COALESCE(l.overview,'')) AS ov_len,
             COALESCE(json_agg(cs.item_name) FILTER (WHERE cs.id IS NOT NULL), '[]'::json) AS supplies
      FROM lessons l LEFT JOIN curriculum_supplies cs ON cs.lesson_id = l.id
      WHERE l.curriculum_id = ${id}
      GROUP BY l.id ORDER BY l.lesson_number`;
    console.log('curr', id, JSON.stringify(ls));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
