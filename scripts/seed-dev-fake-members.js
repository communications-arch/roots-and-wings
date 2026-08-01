// ⚠️ DEV-ONLY DESTRUCTIVE RESET + RESEED (Lyndsey's ask, 2026-08-01).
// Wipes the dev database's member data + member activity, then seeds the
// 41 fictional families from "Website 101 Fake Members" CSV:
//   - member_profiles / people (MLC + BLC) / kids (grove via placement bands)
//   - one paid 2026-2027 registration per family
//   - role_holders_v2 assignments straight from the CSV Role(s) column
//   - class_submissions are KEPT and randomly reassigned to the new roster
//     (Erin: "Leave class submissions only, you can assign them randomly")
// Login mapping: role-named workspace accounts get the CSV family holding
// that role (president@ → Flynn-Fletcher, …); erinb@ stays Padme Amidala;
// families already on dev by name keep their login; remaining real test
// accounts are handed out in CSV order; everyone else gets a synthesized
// firstname+lastinitial@ address (View-As works either way).
//
// Guards: refuses on any non-dev host; requires --yes-reseed.
//   node --env-file=.env.local.dev scripts/seed-dev-fake-members.js "<csv path>" --yes-reseed
const fs = require('fs');
const { neon } = require('@neondatabase/serverless');

const DEV_HOST_FRAGMENT = 'ep-shiny-recipe';
const SEASON = '2026-2027';
const DOMAIN = 'rootsandwingsindy.com';

// api/tour.js MORNING_GROUP_RANGES (placement bands — narrow by design).
const GROUP_RANGES = [
  { name: 'Greenhouse', min: 0, max: 2 }, { name: 'Saplings', min: 3, max: 5 },
  { name: 'Sassafras', min: 5, max: 6 }, { name: 'Oaks', min: 7, max: 8 },
  { name: 'Maples', min: 8, max: 9 }, { name: 'Birch', min: 9, max: 10 },
  { name: 'Willows', min: 10, max: 11 }, { name: 'Cedars', min: 12, max: 13 },
  { name: 'Pigeons', min: 14, max: 200 }
];
function groupForAge(age) {
  if (age == null) return '';
  for (const g of GROUP_RANGES) if (age >= g.min && age <= g.max) return g.name;
  return '';
}
function ageOn(dateStr, birthIso) {
  const t = new Date(dateStr), b = new Date(birthIso);
  let a = t.getFullYear() - b.getFullYear();
  if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
  return a;
}

// CSV role → workspace login (CSV Role(s) column is the source of truth).
const ROLE_LOGIN = {
  'President': `president@${DOMAIN}`,
  'Vice President': `vp@${DOMAIN}`,
  'Treasurer': `treasurer@${DOMAIN}`,
  'Secretary': `secretary@${DOMAIN}`,
  'Membership Director': `membership@${DOMAIN}`,
  'Communications Director': `erinb@${DOMAIN}`,     // Erin's dev login = Padme
  'Afternoon Class Liaison': `afternoon@${DOMAIN}`,
  'Sustaining Director': `averyl@${DOMAIN}`,        // no sustaining@ acct on dev
  'Special Events Liaison': `mem@${DOMAIN}`
};
// Families already on dev by name keep their existing login.
const NAME_LOGIN = {
  'Bridgerton': `morganl@${DOMAIN}`, 'Cuthbert': `newbiel@${DOMAIN}`,
  'Pickles': `member@${DOMAIN}`, 'Bucket': `testr@${DOMAIN}`, 'Addams': `devtestb@${DOMAIN}`
};
// Freed real tester accounts, handed to remaining families in CSV order.
const FREE_POOL = ['devtestd', 'morning', 'registern', 'undot', 'erino', 'memberf', 'waterg', 'crtest-smith', 'crtest-sanders']
  .map(u => `${u}@${DOMAIN}`);

// CSV role title → roles-table title.
const ROLE_TITLE_FIX = { 'Vice President': 'Vice-President', 'Yearbook': 'Yearbook Coordinator' };

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function parseBirth(s) {
  let v = String(s || '').trim();
  if (!v) return null;
  if (v === '11/112011') v = '11/11/2011'; // known CSV typo (Laura Ingalls)
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) { console.warn('  ⚠ unparseable birthdate:', s); return null; }
  return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}
function splitName(full, famLast) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { first: parts[0], last: famLast };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

(async () => {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) { console.error('Usage: node --env-file=.env.local.dev scripts/seed-dev-fake-members.js "<csv>" --yes-reseed'); process.exit(1); }
  const url = process.env.DATABASE_URL || '';
  if (!url.includes(DEV_HOST_FRAGMENT)) { console.error('REFUSING: DATABASE_URL is not the dev branch (host must contain "' + DEV_HOST_FRAGMENT + '").'); process.exit(1); }
  const sql = neon(url);

  // ── Parse CSV ──
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const rows = lines.slice(1).map(parseCsvLine);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indianapolis' }).format(new Date());
  const fams = rows.map(cols => {
    const mlc = splitName(cols[0], '');
    if (!mlc) return null;
    const famLast = mlc.last || mlc.first;
    const roles = String(cols[1] || '').split(',').map(s => s.trim()).filter(Boolean);
    const blc = cols[2] ? splitName(cols[2], famLast) : null;
    const kids = [];
    for (let i = 3; i + 1 < cols.length; i += 2) {
      if (!cols[i]) continue;
      const kn = splitName(cols[i], famLast);
      const birth = parseBirth(cols[i + 1]);
      kids.push({ ...kn, birth, group: birth ? groupForAge(ageOn(today, birth)) : '' });
    }
    return { mlc, famLast, roles, blc, kids };
  }).filter(Boolean);
  console.log(`CSV parsed: ${fams.length} families, ${fams.reduce((n, f) => n + f.kids.length, 0)} kids`);

  // ── Assign emails ──
  const taken = new Set();
  const pool = FREE_POOL.slice();
  fams.forEach(f => {
    for (const r of f.roles) { if (ROLE_LOGIN[r] && !taken.has(ROLE_LOGIN[r])) { f.email = ROLE_LOGIN[r]; break; } }
    if (!f.email && NAME_LOGIN[f.famLast] && !taken.has(NAME_LOGIN[f.famLast])) f.email = NAME_LOGIN[f.famLast];
    if (f.email) taken.add(f.email);
  });
  fams.forEach(f => {
    if (f.email) return;
    while (pool.length && taken.has(pool[0])) pool.shift();
    if (pool.length) { f.email = pool.shift(); }
    else {
      let base = (f.mlc.first.split(/\s+/)[0] + f.famLast[0]).toLowerCase().replace(/[^a-z0-9]/g, '');
      let e = `${base}@${DOMAIN}`, n = 2;
      while (taken.has(e)) e = `${base}${n++}@${DOMAIN}`;
      f.email = e;
    }
    taken.add(f.email);
  });

  if (!process.argv.includes('--yes-reseed')) {
    console.log('\nPLAN (dry run — re-run with --yes-reseed to execute):');
    fams.forEach(f => console.log(`  ${f.mlc.first} ${f.famLast} <${f.email}> roles=[${f.roles.join('; ')}] blc=${f.blc ? f.blc.first : '—'} kids=${f.kids.map(k => k.first + (k.group ? ':' + k.group : '')).join(', ')}`));
    process.exit(0);
  }

  // ── Wipe (children → parents; each table logged) ──
  const wipe = [
    'coverage_slots', 'absences', 'waiver_signatures', 'backup_coach_waivers', 'one_off_waivers',
    'class_signup_picks', 'class_lottery_bumps', 'kid_enrollments', 'morning_class_assignments',
    'am_class_assignments', 'class_assignment_helpers', 'volunteer_signups', 'group_section_signups',
    'event_section_signups', 'event_seat_interest', 'special_event_people', 'event_tasks',
    'notifications', 'push_subscriptions', 'todo_confirmations', 'liaison_kid_notes',
    'participation_exemptions', 'welcome_outreach', 'registration_invites', 'enrollment_change_requests',
    'merch_orders', 'payments', 'supply_loans', 'lending_request_pledges', 'lending_requests',
    'facility_bookings', 'role_holder_confirmations', 'role_interest', 'tours', 'role_holders_v2',
    'registrations', 'kids', 'people', 'member_profiles'
  ];
  for (const t of wipe) {
    try {
      const r = await sql.query(`WITH d AS (DELETE FROM ${t} RETURNING 1) SELECT count(*)::int AS n FROM d`);
      console.log(`wiped ${t}: ${r[0].n}`);
    } catch (e) { console.warn(`  ⚠ ${t}: ${e.message}`); }
  }
  try {
    const r = await sql`WITH d AS (DELETE FROM supply_closet WHERE category = 'member_lending' RETURNING 1) SELECT count(*)::int AS n FROM d`;
    console.log(`wiped supply_closet member_lending items: ${r[0].n}`);
  } catch (e) { console.warn('  ⚠ supply_closet lending:', e.message); }

  // ── Seed ──
  const roleRows = await sql`SELECT id, title FROM roles WHERE status = 'active'`;
  const roleByTitle = {};
  roleRows.forEach(r => { roleByTitle[String(r.title).toLowerCase()] = r.id; });
  const unmatchedRoles = [];

  for (const f of fams) {
    const mlcFull = `${f.mlc.first} ${f.famLast}`.trim();
    // parents/kids jsonb columns on member_profiles are legacy sheet blobs —
    // the people + kids TABLES are authoritative, so leave them NULL.
    await sql`INSERT INTO member_profiles (family_email, family_name, updated_at, updated_by)
      VALUES (${f.email}, ${f.famLast}, now(), 'seed-script')`;
    await sql`INSERT INTO people (email, family_email, first_name, last_name, role, sort_order, photo_consent, updated_at, updated_by)
      VALUES (${f.email}, ${f.email}, ${f.mlc.first}, ${f.famLast}, 'mlc', 0, true, now(), 'seed-script')`;
    if (f.blc) {
      // email NULL, not '' — people_email_lc_idx is unique on lower(email)
      // and empty strings collide across families.
      await sql`INSERT INTO people (email, family_email, first_name, last_name, role, sort_order, photo_consent, updated_at, updated_by)
        VALUES (NULL, ${f.email}, ${f.blc.first}, ${f.blc.last}, 'blc', 1, true, now(), 'seed-script')`;
    }
    let si = 0;
    for (const k of f.kids) {
      await sql`INSERT INTO kids (family_email, first_name, last_name, birth_date, schedule, class_group, photo_consent, sort_order, updated_at)
        VALUES (${f.email}, ${k.first}, ${k.last}, ${k.birth}, 'all-day', ${k.group}, true, ${si++}, now())`;
    }
    const regKids = f.kids.map(k => ({ name: `${k.first} ${k.last}`.trim(), birth_date: k.birth, photo_consent: true }));
    await sql`INSERT INTO registrations (season, email, family_email, main_learning_coach, address, phone, track, kids,
        waiver_member_agreement, waiver_photo_consent, waiver_liability, signature_name, signature_date,
        payment_status, created_profile, created_at, updated_at)
      VALUES (${SEASON}, ${f.email}, ${f.email}, ${mlcFull}, '101 Fake Members Ln, Indianapolis, IN', '317-555-0101', 'both', ${JSON.stringify(regKids)},
        true, true, true, ${mlcFull}, ${today}, 'paid', true, now(), now())`;
    for (const r of f.roles) {
      const title = ROLE_TITLE_FIX[r] || r;
      const rid = roleByTitle[title.toLowerCase()];
      if (!rid) { unmatchedRoles.push(`${r} (${mlcFull})`); continue; }
      await sql`INSERT INTO role_holders_v2 (role_id, person_email, school_year, started_at, created_at, updated_at, updated_by)
        VALUES (${rid}, ${f.email}, ${SEASON}, now(), now(), now(), 'seed-script')`;
    }
    console.log(`seeded ${mlcFull} <${f.email}> kids=${f.kids.length} roles=${f.roles.length}`);
  }
  if (unmatchedRoles.length) console.warn('\n⚠ roles with no match in the roles table (NOT assigned):\n  ' + unmatchedRoles.join('\n  '));

  // ── Reassign class submissions randomly across the new roster ──
  const subs = await sql`SELECT id FROM class_submissions`;
  for (const s of subs) {
    const f = fams[Math.floor(Math.random() * fams.length)];
    await sql`UPDATE class_submissions SET submitted_by_email = ${f.email}, submitted_by_name = ${f.mlc.first + ' ' + f.famLast} WHERE id = ${s.id}`;
  }
  console.log(`\nreassigned ${subs.length} class submissions randomly across ${fams.length} families`);

  const [after] = await sql`SELECT
    (SELECT count(*)::int FROM member_profiles) AS profiles,
    (SELECT count(*)::int FROM people) AS people,
    (SELECT count(*)::int FROM kids) AS kids,
    (SELECT count(*)::int FROM registrations) AS registrations,
    (SELECT count(*)::int FROM role_holders_v2) AS role_assignments`;
  console.log('final counts:', JSON.stringify(after));
})();
