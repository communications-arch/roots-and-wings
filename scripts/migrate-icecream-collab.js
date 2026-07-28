// One-off (2026-07-28, Erin): copy the Ice Cream Social's collab-space
// DATA from the dev DB to production — sections (timeline / sign-ups /
// info / notes / board), their member sign-ups, and the checklist tasks.
// Event people (lead/assistants) are NOT copied; prod owns its own.
//
// Safety rails:
//  - dev URL from .env.local.dev, prod URL from .env.local; aborts if
//    either is missing or if the two hosts match.
//  - aborts if prod's event already has sections or tasks (no dup risk)
//    unless --force is passed (force still never deletes).
//  - prints ONLY counts and event ids — no member data on stdout.
//
// Run: node scripts/migrate-icecream-collab.js [--force]

const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

function urlFrom(file) {
  const txt = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const m = txt.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)/m);
  return m ? m[1].trim() : null;
}
function hostOf(u) { const m = String(u).match(/@([^\/:]+)/); return m ? m[1] : '(unknown)'; }

async function main() {
  const devUrl = urlFrom('.env.local.dev');
  const prodUrl = urlFrom('.env.local');
  if (!devUrl || !prodUrl) { console.error('Missing DATABASE_URL in .env.local.dev or .env.local'); process.exit(1); }
  if (hostOf(devUrl) === hostOf(prodUrl)) { console.error('Dev and prod hosts are IDENTICAL — refusing to run.'); process.exit(1); }
  console.log('dev host :', hostOf(devUrl));
  console.log('prod host:', hostOf(prodUrl));

  const dev = neon(devUrl);
  const prod = neon(prodUrl);

  const YEAR = '2026-2027'; // the Aug 19, 2026 social
  const devEv = await dev`SELECT id, name, school_year FROM special_events WHERE name ILIKE '%ice cream%' AND school_year = ${YEAR} ORDER BY id`;
  if (devEv.length !== 1) { console.error('Dev: expected exactly 1 ice-cream event for ' + YEAR + ', found', devEv.length, devEv.map(e => e.id + ':' + e.name + ':' + e.school_year)); process.exit(1); }
  const prodEv = await prod`SELECT id, name, school_year FROM special_events WHERE name ILIKE '%ice cream%' AND school_year = ${YEAR} ORDER BY id`;
  if (prodEv.length !== 1) { console.error('Prod: expected exactly 1 ice-cream event for ' + YEAR + ', found', prodEv.length, prodEv.map(e => e.id + ':' + e.name + ':' + e.school_year)); process.exit(1); }
  console.log('dev event id:', devEv[0].id, '| prod event id:', prodEv[0].id, '| name:', devEv[0].name);

  const sections = await dev`SELECT * FROM event_sections WHERE special_event_id = ${devEv[0].id} ORDER BY sort_order, id`;
  const secIds = sections.map(s => s.id);
  const signups = secIds.length ? await dev`SELECT * FROM event_section_signups WHERE section_id = ANY(${secIds}) ORDER BY created_at, id` : [];
  const tasks = await dev`SELECT * FROM event_tasks WHERE special_event_id = ${devEv[0].id} ORDER BY sort_order, id`;
  console.log('dev data: sections=' + sections.length, 'signups=' + signups.length, 'tasks=' + tasks.length);

  const existingSecs = await prod`SELECT COUNT(*)::int AS n FROM event_sections WHERE special_event_id = ${prodEv[0].id}`;
  const existingTasks = await prod`SELECT COUNT(*)::int AS n FROM event_tasks WHERE special_event_id = ${prodEv[0].id}`;
  console.log('prod already has: sections=' + existingSecs[0].n, 'tasks=' + existingTasks[0].n);
  const force = process.argv.indexOf('--force') !== -1;
  if ((existingSecs[0].n > 0 || existingTasks[0].n > 0) && !force) {
    console.error('Prod event already has collab data — aborting (re-run with --force to ADD anyway; nothing is ever deleted).');
    process.exit(1);
  }

  let secCopied = 0, suCopied = 0, taskCopied = 0;
  const idMap = {};
  for (const s of sections) {
    const ins = await prod`
      INSERT INTO event_sections (special_event_id, type, title, config, content, is_open, is_public, sort_order, updated_by)
      VALUES (${prodEv[0].id}, ${s.type}, ${s.title}, ${JSON.stringify(s.config)}::jsonb, ${JSON.stringify(s.content)}::jsonb,
              ${s.is_open}, ${s.is_public}, ${s.sort_order}, 'dev-migration 2026-07-28')
      RETURNING id`;
    idMap[s.id] = ins[0].id;
    secCopied++;
  }
  for (const su of signups) {
    if (!idMap[su.section_id]) continue;
    await prod`
      INSERT INTO event_section_signups (section_id, slot_index, person_email, person_name, item_text, note, created_at)
      VALUES (${idMap[su.section_id]}, ${su.slot_index}, ${su.person_email}, ${su.person_name}, ${su.item_text}, ${su.note}, ${su.created_at})`;
    suCopied++;
  }
  for (const t of tasks) {
    await prod`
      INSERT INTO event_tasks (special_event_id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order, updated_by)
      VALUES (${prodEv[0].id}, ${t.title}, ${t.assigned_email}, ${t.assigned_name}, ${t.due_date}, ${t.done_at}, ${t.done_by}, ${t.sort_order}, 'dev-migration 2026-07-28')`;
    taskCopied++;
  }
  console.log('COPIED to prod: sections=' + secCopied, 'signups=' + suCopied, 'tasks=' + taskCopied);
}

main().catch(err => { console.error(err.message); process.exit(1); });
