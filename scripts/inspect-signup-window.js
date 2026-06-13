// Verify that the columns added by the 2026-06-02 migration exist on
// whatever DB the dotenv path points at. Schema-only — no row reads.
// Run prod: node --env-file=.env.local scripts/inspect-signup-window.js

const { neon } = require('@neondatabase/serverless');

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  const match = process.env.DATABASE_URL.match(/@([^\/:]+)/);
  console.log('DATABASE_URL host:', match ? match[1] : '(unknown)');

  const sessCols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'co_op_sessions'
      AND column_name IN ('approved_at', 'approved_by')
    ORDER BY column_name
  `;
  console.log('\nco_op_sessions new columns:');
  sessCols.forEach(c => console.log('  ', c.column_name, '(' + c.data_type + ')'));

  const winCols = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'class_signup_windows'
      AND column_name IN ('signup_start_date', 'signup_end_date')
    ORDER BY column_name
  `;
  console.log('\nclass_signup_windows new columns:');
  winCols.forEach(c => console.log('  ', c.column_name, '(' + c.data_type + ')'));

  if (sessCols.length === 2 && winCols.length === 2) {
    console.log('\nAll 4 new columns present.');
  } else {
    console.log('\nMISSING — expected 4 new columns total, got',
      sessCols.length + winCols.length);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
