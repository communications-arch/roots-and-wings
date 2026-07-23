// Unit tests for the Schedules Report "By class" grouping (#37):
// schedByClassSections(rep) — the pure fold from the schedules-report
// payload into per-hour sections of classes with leader / assistants /
// student rosters.
//
// Same extraction approach as test-helpers.js (script.js is a browser
// IIFE): grep the function + its var dependencies out and re-hydrate.
//
// Usage: node scripts/test-schedules-byclass.js

const fs = require('fs');
const path = require('path');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'assert') + ': expected ' + e + ', got ' + a);
}

const src = fs.readFileSync(SCRIPT_JS, 'utf8');
function extractFn(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract function ' + fnName);
  return m[0];
}
function extractVar(varName, closer) {
  const re = new RegExp('^  var ' + varName + ' = [\\s\\S]*?' + closer, 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract var ' + varName);
  return m[0];
}

const factory = new Function(
  extractVar('AGE_GROUP_LABELS', '\\};') + '\n' +
  extractVar('MORNING_GROUP_ORDER', '\\];') + '\n' +
  extractVar('SCHED_BLOCK_LABELS', '\\};') + '\n' +
  extractFn('signupAgeText') + '\n' +
  extractFn('ageSpanOf') + '\n' +
  extractFn('widenRangeToSpan') + '\n' +
  extractFn('schedByClassSections') + '\n' +
  'return schedByClassSections;'
);
const sections = factory();

// A small but representative payload: one whole-morning Saplings class,
// one Oaks group with kids but NO placed class, one PM1 class, one
// 2-hour 'both' class, one PM2 class.
const rep = {
  classes: [
    { id: 10, class_name: 'Saplings Storytime', class_period: 'AM', scheduled_hour: '', room: '',
      ageRange: '', ageGroups: ['saplings'], teacher: 'Amy Lead', max: 0, signed_up: 0,
      assistants_wanted: 1,
      helpers: [{ name: 'Hank Helper', block: 'AM1' }] },
    { id: 20, class_name: 'Woodworking', class_period: 'PM', scheduled_hour: 'PM1', room: 'Barn',
      ageRange: '', ageGroups: ['oaks', 'maples'], teacher: 'Wes Wood', max: 3, signed_up: 2,
      assistants_wanted: 2, helpers: [{ name: 'Ada Assist', block: '' }] },
    { id: 30, class_name: 'Epic Play', class_period: 'PM', scheduled_hour: 'both', room: 'Pavilion',
      ageRange: '7–10', ageGroups: [], teacher: 'Bella Both', max: 10, signed_up: 1,
      assistants_wanted: 1, helpers: [{ name: 'Hour Two Only', block: 'PM2' }] },
    { id: 40, class_name: 'Art', class_period: 'PM', scheduled_hour: 'PM2', room: '',
      ageRange: '', ageGroups: ['all-ages'], teacher: '', max: 0, signed_up: 0,
      assistants_wanted: 1, helpers: [] }
  ],
  kids: [
    { name: 'Sam Small (nick)', age: 4, am_applicable: true, pm_eligible: false,
      am: { group: 'Saplings', finalized: true }, pm1: null, pm2: null },
    { name: 'Olive Oaks', age: 8, am_applicable: true, pm_eligible: true,
      am: { group: 'Oaks', finalized: false },
      pm1: { class_id: 20, class_name: 'Woodworking', both: false }, pm2: null },
    { name: 'Bo Bothhours', age: 9, am_applicable: true, pm_eligible: true,
      am: { group: 'Oaks', finalized: true },
      pm1: { class_id: 30, class_name: 'Epic Play', both: true }, pm2: null },
    { name: 'Afternoon Annie', age: 10, am_applicable: false, pm_eligible: true,
      am: null, pm1: null, pm2: { class_id: 40, class_name: 'Art', both: false } }
  ]
};

console.log('schedByClassSections (#37 By class view)');

const out = sections(rep);

t('four per-hour sections in day order', () => {
  assertEq(out.map(s => s.block), ['AM1', 'AM2', 'PM1', 'PM2']);
  assertEq(out[0].label, 'AM Hour 1');
});

t('whole-morning class appears in BOTH AM sections with its group roster', () => {
  const am1 = out[0].entries.find(e => e.id === 10);
  const am2 = out[1].entries.find(e => e.id === 10);
  if (!am1 || !am2) throw new Error('Saplings Storytime missing from an AM hour');
  assertEq(am1.students, [{ name: 'Sam Small (nick)', age: 4 }]);
  assertEq(am1.leader, 'Amy Lead');
  assertEq(am1.ages, 'Saplings (3–5)', 'ages via AGE_GROUP_LABELS, roster in band');
});

t('hour-scoped AM helper only counts in its own hour (and gets a tag)', () => {
  const am1 = out[0].entries.find(e => e.id === 10);
  const am2 = out[1].entries.find(e => e.id === 10);
  assertEq(am1.assistants, [{ name: 'Hank Helper', tag: 'Hour 1' }]);
  assertEq(am2.assistants, []);
  assertEq(am1.needs_assistants, 0);
  assertEq(am2.needs_assistants, 1, 'AM2 still needs its assistant');
});

t('group with kids but no placed class still shows (Oaks)', () => {
  const oaks1 = out[0].entries.find(e => e.group === 'oaks');
  if (!oaks1) throw new Error('Oaks entry missing from AM1');
  assertEq(oaks1.no_class, true);
  assertEq(oaks1.name, 'Oaks');
  // Oaks is typically 7–8 but Bo is 9, so the printed range stretches to
  // cover the roster listed right under it (Erin, 2026-07-23).
  assertEq(oaks1.ages, '7–9', 'MORNING_GROUP_ORDER range widened to the roster');
  assertEq(oaks1.students.map(s => s.name), ['Bo Bothhours', 'Olive Oaks']);
});

t('AM entries sort youngest group first', () => {
  const groups = out[0].entries.map(e => e.group);
  assertEq(groups, ['saplings', 'oaks']);
});

t('PM1 class carries its roster, room, and open spots', () => {
  const w = out[2].entries.find(e => e.id === 20);
  assertEq(w.students, [{ name: 'Olive Oaks', age: 8 }]);
  assertEq(w.room, 'Barn');
  assertEq(w.needs_assistants, 1, '2 wanted − 1 whole-class helper');
  assertEq(w.open_seats, 2, 'max 3 − 1 enrolled');
});

t('2-hour class appears in BOTH PM sections; its kids ride into PM2', () => {
  const p1 = out[2].entries.find(e => e.id === 30);
  const p2 = out[3].entries.find(e => e.id === 30);
  if (!p1 || !p2) throw new Error('Epic Play missing from a PM hour');
  assertEq(p1.students.map(s => s.name), ['Bo Bothhours']);
  assertEq(p2.students.map(s => s.name), ['Bo Bothhours'], 'both-class kid covers PM2');
  assertEq(p1.ages, '7–10', 'reviewer ageRange override wins');
});

t('2-hour class hour-scoped helper tags + scopes correctly', () => {
  const p1 = out[2].entries.find(e => e.id === 30);
  const p2 = out[3].entries.find(e => e.id === 30);
  assertEq(p1.assistants, []);
  assertEq(p2.assistants, [{ name: 'Hour Two Only', tag: 'Hour 2' }]);
});

t('leaderless PM2 class shows with empty leader + its kid', () => {
  const art = out[3].entries.find(e => e.id === 40);
  assertEq(art.leader, '');
  assertEq(art.students, [{ name: 'Afternoon Annie', age: 10 }]);
  assertEq(art.ages, 'All ages');
});

t('empty payload → four empty sections', () => {
  const empty = sections({ classes: [], kids: [] });
  assertEq(empty.map(s => s.entries.length), [0, 0, 0, 0]);
});

console.log('  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
