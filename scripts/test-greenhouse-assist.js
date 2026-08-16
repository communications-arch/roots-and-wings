// Greenhouse (0–2) adult assistants via the morning sign-ups (Erin,
// 2026-08-16 — replaces the Greenhouse Host card, #350).
//
// Guards the ADULT-side lift and the KID-side exclusions that must stay:
//  - isGreenhouseAssistClass(row): the marker is age_groups=['greenhouse']
//    on an AM row — never the class name.
//  - normalizeSubmission: a NEW morning submission for the Greenhouse is
//    still rejected; only the edit path's opts.allowGreenhouseAM lifts it
//    (so the VP can save an assistant count on the standing row). PM never.
//  - script.js: the Greenhouse Host loader/section is gone; the edit form
//    keeps 'greenhouse' selectable only when editing the standing row;
//    MORNING_PROGRAM_GROUPS (kid-side) still excludes Greenhouse.
//  - api/coverage.js: no greenhouse-host actions remain.
//  - scripts/migrate.sql: the standing-class seed is additive + guarded.
//
// Usage: node scripts/test-greenhouse-assist.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const api = require(path.join(ROOT, 'api', 'curriculum.js'));
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const coverageSrc = fs.readFileSync(path.join(ROOT, 'api', 'coverage.js'), 'utf8');
const migrateSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate.sql'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assert') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}
function throwsWith(fn, re) {
  let msg = null;
  try { fn(); } catch (e) { msg = e.message; }
  if (msg === null) throw new Error('expected a throw matching ' + re);
  if (!re.test(msg)) throw new Error('threw, but message ' + JSON.stringify(msg) + ' does not match ' + re);
}

console.log('isGreenhouseAssistClass — marker is age_groups, not the name');
t('AM + [greenhouse] → true', () => {
  eq(api.isGreenhouseAssistClass({ class_period: 'AM', age_groups: ['greenhouse'] }), true);
  eq(api.isGreenhouseAssistClass({ class_period: 'AM', age_groups: ['Greenhouse'] }), true, 'case-insensitive');
});
t('PM + [greenhouse] → false (greenhouse is never an afternoon thing)', () => {
  eq(api.isGreenhouseAssistClass({ class_period: 'PM', age_groups: ['greenhouse'] }), false);
});
t('AM + another grove → false, even when the NAME says Greenhouse', () => {
  eq(api.isGreenhouseAssistClass({ class_period: 'AM', age_groups: ['saplings'], class_name: 'Greenhouse (0–2 room) — assistants' }), false);
});
t('multi-grove / empty / null → false', () => {
  eq(api.isGreenhouseAssistClass({ class_period: 'AM', age_groups: ['greenhouse', 'saplings'] }), false);
  eq(api.isGreenhouseAssistClass({ class_period: 'AM', age_groups: [] }), false);
  eq(api.isGreenhouseAssistClass(null), false);
});

console.log('normalizeSubmission — greenhouse AM lifted ONLY via opts.allowGreenhouseAM');
const amGreenhouse = {
  class_period: 'AM', class_name: 'Greenhouse (0–2 room) — assistants', description: '',
  session_preferences: ['1'], hour_preference: ['both'], assistant_count: [2],
  age_groups: ['greenhouse']
};
t('new morning submission for the Greenhouse is still rejected (kid-side rule)', () => {
  throwsWith(() => api.normalizeSubmission(amGreenhouse), /No morning programming is offered for the Greenhouse/);
  throwsWith(() => api.normalizeSubmission(amGreenhouse, {}), /No morning programming is offered for the Greenhouse/);
  throwsWith(() => api.normalizeSubmission(amGreenhouse, { allowGreenhouseAM: false }), /No morning programming/);
});
t('edit of the standing row passes with allowGreenhouseAM and keeps the grove + count', () => {
  const clean = api.normalizeSubmission(amGreenhouse, { allowGreenhouseAM: true });
  eq(clean.class_period, 'AM');
  eq(JSON.stringify(clean.age_groups), '["greenhouse"]');
  eq(JSON.stringify(clean.assistant_count), '[2]');
  eq(JSON.stringify(clean.hour_preference), '["both"]');
});
t('allowGreenhouseAM never opens the afternoon (greenhouse is morning-only)', () => {
  const pm = Object.assign({}, amGreenhouse, { class_period: 'PM', hour_preference: ['first'], space_request: ['any'], max_students: 12 });
  throwsWith(() => api.normalizeSubmission(pm, { allowGreenhouseAM: true }), /Greenhouse is a morning-only grove/);
});
t('other AM rules unchanged under the flag (exactly one grove; all-ages rejected)', () => {
  throwsWith(() => api.normalizeSubmission(Object.assign({}, amGreenhouse, { age_groups: ['greenhouse', 'saplings'] }), { allowGreenhouseAM: true }), /exactly one grove/);
  throwsWith(() => api.normalizeSubmission(Object.assign({}, amGreenhouse, { age_groups: ['all-ages'] }), { allowGreenhouseAM: true }), /exactly one grove/);
});

console.log('script.js — Greenhouse Host UI removed; kid-side filters intact');
t('no Greenhouse Host loader / section / API calls remain', () => {
  eq(/loadGreenhouseHost|paintGreenhouseHost|ws-greenhouse-host|greenhouse-host/.test(scriptSrc), false, 'stale #350 client code');
});
t('edit form keeps greenhouse selectable only when editing the standing row', () => {
  eq(scriptSrc.indexOf("if (v === 'greenhouse' && amGroupCur !== 'greenhouse') return;") !== -1, true, 'edit-form dropdown guard');
});
t('MORNING_PROGRAM_GROUPS still excludes Greenhouse (kid-side / AM Teaching grid)', () => {
  eq(/var MORNING_PROGRAM_GROUPS = MORNING_GROUP_ORDER\.filter\(function \(g\) \{ return g\.name !== 'Greenhouse'; \}\);/.test(scriptSrc), true);
});
t('Schedule Builder morning grid iterates every grove (MORNING_BUILDER_GROUPS) but skips an unplaced Greenhouse slot', () => {
  eq(scriptSrc.indexOf('MORNING_BUILDER_GROUPS.forEach(function (g) {') !== -1, true, 'builder grid list');
  eq(scriptSrc.indexOf("if (g.name === 'Greenhouse' && !list.length) return;") !== -1, true, 'no empty Greenhouse ask');
});
t('Session schedule morning blocks show Greenhouse only when its class is placed', () => {
  eq(scriptSrc.indexOf("if (g.name === 'Greenhouse' && !placed) return;") !== -1, true);
});
t('"+ New Class" AM grove pickers still exclude greenhouse (no new Greenhouse morning classes)', () => {
  const hits = scriptSrc.match(/if \(v === 'greenhouse'\) return; \/\/ no morning programming for 0–2/g) || [];
  eq(hits.length >= 1, true, 'expected the + New Class picker guard to remain');
});

console.log('api/coverage.js — Greenhouse Host actions retired');
t('no greenhouse-host actions or greenhouse_host_claims reads/writes', () => {
  eq(/ghAction|greenhouse-host-claim|greenhouse-host-release|greenhouseKidsExist|FROM greenhouse_host_claims|INTO greenhouse_host_claims/.test(coverageSrc), false);
});

console.log('scripts/migrate.sql — standing class seed');
const seedIdx = migrateSrc.indexOf("'Greenhouse (0–2 room) — assistants'");
t('seed exists, is an INSERT … SELECT … WHERE NOT EXISTS keyed on age_groups = ARRAY[\'greenhouse\']', () => {
  eq(seedIdx > 0, true, 'seed missing');
  const block = migrateSrc.slice(migrateSrc.lastIndexOf('INSERT INTO class_submissions', seedIdx), migrateSrc.indexOf(';', seedIdx) + 1);
  eq(/WHERE NOT EXISTS/.test(block), true, 'NOT EXISTS guard');
  eq(/c\.age_groups = ARRAY\['greenhouse'\]/.test(block), true, 'greenhouse marker');
  eq(/c\.class_period = 'AM'/.test(block), true, 'AM only');
  eq(/'scheduled'/.test(block) && /'AM',/.test(block), true, 'scheduled whole-morning');
  eq(/generate_series\(1, 5\)/.test(block), true, 'sessions 1–5');
  eq(/DELETE|DROP|TRUNCATE/i.test(block), false, 'additive only');
});
t('greenhouse_host_claims table is left in place (additive rule)', () => {
  eq(/CREATE TABLE IF NOT EXISTS greenhouse_host_claims/.test(migrateSrc), true);
  eq(/DROP TABLE[^;]*greenhouse_host_claims/.test(migrateSrc), false);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
