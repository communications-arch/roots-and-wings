// One-off diagnostic (2026-07-28): why do lesson-plan supplies vanish?
// Lists curricula, per-curriculum supply counts, and class links on the
// DEV database (.env.local.dev — never prod).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const currs = await sql`SELECT id, title, author_email, lesson_count, updated_at FROM curricula ORDER BY id`;
  console.log('CURRICULA:');
  currs.forEach(c => console.log(` ${c.id} | ${c.title} | ${c.author_email} | lessons:${c.lesson_count} | upd:${c.updated_at.toISOString()}`));
  const counts = await sql`
    SELECT l.curriculum_id, COUNT(cs.id)::int AS supplies
    FROM lessons l LEFT JOIN curriculum_supplies cs ON cs.lesson_id = l.id
    GROUP BY l.curriculum_id ORDER BY l.curriculum_id`;
  console.log('SUPPLY COUNTS BY CURRICULUM:', JSON.stringify(counts));
  const links = await sql`SELECT * FROM class_curriculum_links ORDER BY id`;
  console.log('CLASS LINKS:');
  links.forEach(l => console.log(' ', JSON.stringify(l)));
})().catch(e => { console.error(e.message); process.exit(1); });
