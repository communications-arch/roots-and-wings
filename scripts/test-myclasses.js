// Unit tests for the My Family "My Classes" card (#38):
//  - myClassesForSession(subs, sess, activeYear) — which of the family's
//    submissions count as approved classes for a session, and their order.
//  - myClassLinkKey(s) — the class_curriculum_links key convention (AM
//    classes key on their capitalised age group, PM on 'PM:' + name),
//    which must stay in step with loadClassLinks / the dbClass popup.
//
// Same extraction approach as test-builder-filters.js: script.js is a big
// browser IIFE, so the helpers are grepped out and re-hydrated.
//
// Usage: node scripts/test-myclasses.js

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
  if (actual !== expected) throw new Error((msg || 'assert') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function assertDeepEq(actual, expected, msg) {
  assertEq(JSON.stringify(actual), JSON.stringify(expected), msg);
}

const src = fs.readFileSync(SCRIPT_JS, 'utf8');
function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const forSession = new Function(extract('myClassesForSession') + '\nreturn myClassesForSession;')();
const linkKey = new Function(extract('myClassLinkKey') + '\nreturn myClassLinkKey;')();

const YEAR = '2026-2027';
const subs = [
  { id: 1, status: 'scheduled', scheduled_session: 2, school_year: YEAR, class_period: 'PM', scheduled_hour: 'PM2', class_name: 'Watercolor' },
  { id: 2, status: 'scheduled', scheduled_session: 2, school_year: YEAR, class_period: 'AM', scheduled_hour: 'AM1', class_name: 'Nature Journals', age_groups: ['oaks'] },
  { id: 3, status: 'scheduled', scheduled_session: 2, school_year: YEAR, class_period: 'PM', scheduled_hour: 'PM1', class_name: 'Chess Club' },
  { id: 4, status: 'submitted', scheduled_session: 2, school_year: YEAR, class_period: 'PM', class_name: 'Not yet reviewed' },
  { id: 5, status: 'scheduled', scheduled_session: 3, school_year: YEAR, class_period: 'PM', scheduled_hour: 'PM1', class_name: 'Other session' },
  { id: 6, status: 'scheduled', scheduled_session: 2, school_year: '2025-2026', class_period: 'PM', scheduled_hour: 'PM1', class_name: 'Last year' },
  { id: 7, status: 'withdrawn', scheduled_session: 2, school_year: YEAR, class_period: 'PM', class_name: 'Withdrawn' },
  { id: 8, status: 'declined', scheduled_session: 2, school_year: YEAR, class_period: 'PM', class_name: 'Declined' }
];

console.log('myClassesForSession (#38 My Classes card)');

t('only scheduled classes for the selected session + year', () => {
  const out = forSession(subs, 2, YEAR);
  assertDeepEq(out.map(s => s.id), [2, 3, 1]);
});

t('AM sorts before PM; PM sorts PM1 before PM2', () => {
  const out = forSession(subs, 2, YEAR);
  assertDeepEq(out.map(s => s.class_name), ['Nature Journals', 'Chess Club', 'Watercolor']);
});

t('other session pulls its own class only', () => {
  assertDeepEq(forSession(subs, 3, YEAR).map(s => s.id), [5]);
});

t('a session with nothing approved is empty', () => {
  assertDeepEq(forSession(subs, 4, YEAR), []);
});

t('no activeYear → year guard off (legacy rows show)', () => {
  assertDeepEq(forSession(subs, 2, '').map(s => s.id), [2, 3, 6, 1]);
});

t('rows without a school_year pass the year guard', () => {
  const out = forSession([{ status: 'scheduled', scheduled_session: 1, class_period: 'PM', class_name: 'X' }], 1, YEAR);
  assertEq(out.length, 1);
});

t('null/empty input → empty list, no crash', () => {
  assertDeepEq(forSession(null, 2, YEAR), []);
  assertDeepEq(forSession([], 2, YEAR), []);
});

console.log('myClassLinkKey (#38 link resolution)');

t('AM class keys on its capitalised age group', () => {
  assertEq(linkKey({ class_period: 'AM', age_groups: ['oaks'], class_name: 'Nature Journals' }), 'Oaks');
});

t('AM class with no age group → empty key (no accidental match)', () => {
  assertEq(linkKey({ class_period: 'AM', age_groups: [], class_name: 'X' }), '');
});

t('PM class keys on PM: + name', () => {
  assertEq(linkKey({ class_period: 'PM', class_name: 'Chess Club' }), 'PM:Chess Club');
});

console.log('  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
