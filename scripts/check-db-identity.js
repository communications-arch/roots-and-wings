// Diagnostic — prints which Neon database .env.local is pointing at
// and the current role_holders row count. If this count doesn't match
// what the live /api/cleaning?action=role-holders API returns, the
// seed is writing to a different branch than production reads from.
//
// Run with: node scripts/check-db-identity.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { neon } = require('@neondatabase/serverless');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // Extract the host from the connection string so Erin can confirm
  // whether this matches Vercel's env var without pasting the password.
  const match = process.env.DATABASE_URL.match(/@([^\/:]+)/);
  const host = match ? match[1] : '(unknown)';
  console.log('DATABASE_URL host:', host);

  const sql = neon(process.env.DATABASE_URL);

  const info = await sql`SELECT current_database() AS db, current_user AS usr`;
  console.log('DB:', info[0].db, 'user:', info[0].usr);

  const holders = await sql`SELECT COUNT(*)::int AS n FROM role_holders`;
  console.log('role_holders total:', holders[0].n);

  const perYear = await sql`
    SELECT school_year, COUNT(*)::int AS n
    FROM role_holders GROUP BY school_year ORDER BY school_year
  `;
  console.log('by school_year:', perYear);

  const sample = await sql`
    SELECT id, role_id, email, person_name, school_year
    FROM role_holders
    ORDER BY id DESC
    LIMIT 3
  `;
  console.log('newest 3 rows:', sample);

  const roles = await sql`SELECT COUNT(*)::int AS n FROM role_descriptions`;
  console.log('role_descriptions total:', roles[0].n);

  const firstRoleIds = await sql`
    SELECT id, title FROM role_descriptions
    ORDER BY id ASC LIMIT 3
  `;
  console.log('first 3 role_descriptions ids:', firstRoleIds);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
