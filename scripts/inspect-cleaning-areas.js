// READ-ONLY: list cleaning_areas rows (issue: split "Kitchen Annex & FH").
const { neon } = require('@neondatabase/serverless');
async function main() {
  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`SELECT id, floor_key, area_name, tasks, sort_order FROM cleaning_areas ORDER BY sort_order, id`;
  rows.forEach(r => console.log(`[${r.id}] ${r.floor_key} · ${r.area_name} · sort ${r.sort_order}\n    tasks: ${String(r.tasks || '').slice(0, 300)}`));
  console.log('(Read-only — nothing was changed.)');
}
main().catch(e => { console.error(e.message); process.exit(1); });
