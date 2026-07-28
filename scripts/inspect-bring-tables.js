// Quick check: did the #139 migration create the bring tables on dev?
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local.dev') });
const { neon } = require('@neondatabase/serverless');
neon(process.env.DATABASE_URL)`SELECT to_regclass('group_bring_items') AS t1, to_regclass('group_bring_signups') AS t2`
  .then(r => console.log(JSON.stringify(r[0])))
  .catch(e => { console.error(e.message); process.exit(1); });
