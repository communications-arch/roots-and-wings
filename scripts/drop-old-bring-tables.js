// One-off (2026-07-28): drop the superseded per-item bring tables on the
// DEV DB (they never reached prod; auto-migration is additive-only so the
// drop happens here by hand). Safe to re-run.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  await sql`DROP TABLE IF EXISTS group_bring_signups`;
  await sql`DROP TABLE IF EXISTS group_bring_items`;
  console.log('dropped (dev):', JSON.stringify(await sql`SELECT to_regclass('group_bring_items') AS gone`));
})().catch(e => { console.error(e.message); process.exit(1); });
