// Unit tests for the Class Builder's available-classes palette filters
// (#28): sbPaletteFilterMatch(submission, filters) — the pure, AND-
// combined match behind the Session / Hour / Ages / Room funnel chips.
//
// script.js is a big browser IIFE, so we can't require() it directly —
// same extraction approach as test-helpers.js: grep the function source
// out and re-hydrate it. If someone renames or reshapes the helper,
// this fails loudly at the extraction step.
//
// Usage: node scripts/test-builder-filters.js

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
  if (actual !== expected) throw new Error((msg || 'assert') + ': expected ' + expected + ', got ' + actual);
}

const src = fs.readFileSync(SCRIPT_JS, 'utf8');
function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(extract('sbPaletteFilterMatch') + '\nreturn sbPaletteFilterMatch;');
const match = factory();

const ALL = { session: 'all', hour: 'all', age: 'all', room: 'all' };
function f(over) { return Object.assign({}, ALL, over); }

// A representative PM submission.
const pm = {
  class_period: 'PM',
  session_preferences: ['2', '3'],
  hour_preference: ['first'],
  age_groups: ['oaks', 'maples'],
  space_request: ['outside'],
  space_request_other: ''
};

console.log('sbPaletteFilterMatch (#28 palette filters)');

t('all-filters "all" matches everything', () => {
  assertEq(match(pm, ALL), true);
  assertEq(match({}, ALL), true, 'empty submission');
});

t('session: explicit preference matches its sessions only', () => {
  assertEq(match(pm, f({ session: '2' })), true);
  assertEq(match(pm, f({ session: '4' })), false);
});

t('session: flexible or no preference fits every session', () => {
  assertEq(match({ session_preferences: ['flexible'] }, f({ session: '5' })), true);
  assertEq(match({ session_preferences: [] }, f({ session: '1' })), true);
  assertEq(match({}, f({ session: '1' })), true, 'missing array');
});

t('hour: "first" fits PM1, not PM2', () => {
  assertEq(match(pm, f({ hour: 'PM1' })), true);
  assertEq(match(pm, f({ hour: 'PM2' })), false);
});

t('hour: "last" fits PM2, not PM1', () => {
  const s = { hour_preference: ['last'] };
  assertEq(match(s, f({ hour: 'PM2' })), true);
  assertEq(match(s, f({ hour: 'PM1' })), false);
});

t('hour: flexible / no preference fits either hour', () => {
  assertEq(match({ hour_preference: ['flexible'] }, f({ hour: 'PM1' })), true);
  assertEq(match({ hour_preference: ['flexible'] }, f({ hour: 'PM2' })), true);
  assertEq(match({ hour_preference: [] }, f({ hour: 'PM1' })), true);
});

t('hour: 2-hour requests fit both single hours AND the 2-hour filter', () => {
  ['2hr-required', '2hr-optional'].forEach(v => {
    const s = { hour_preference: [v] };
    assertEq(match(s, f({ hour: 'PM1' })), true, v + ' PM1');
    assertEq(match(s, f({ hour: 'PM2' })), true, v + ' PM2');
    assertEq(match(s, f({ hour: 'both' })), true, v + ' both');
  });
});

t('hour: single-hour classes never match the 2-hour filter', () => {
  assertEq(match(pm, f({ hour: 'both' })), false);
  assertEq(match({ hour_preference: ['flexible'] }, f({ hour: 'both' })), false);
  assertEq(match({ hour_preference: [] }, f({ hour: 'both' })), false, 'no pref is not a 2-hour class');
});

t('age: matches any checked bucket', () => {
  assertEq(match(pm, f({ age: 'oaks' })), true);
  assertEq(match(pm, f({ age: 'maples' })), true);
  assertEq(match(pm, f({ age: 'saplings' })), false);
});

t('age: all-ages classes serve every group filter', () => {
  const s = { age_groups: ['all-ages'] };
  assertEq(match(s, f({ age: 'oaks' })), true);
  assertEq(match(s, f({ age: 'pigeons' })), true);
  assertEq(match(s, f({ age: 'all-ages' })), true);
});

t('age: "all-ages" filter only matches true all-ages classes', () => {
  assertEq(match(pm, f({ age: 'all-ages' })), false);
});

t('room: matches a checked space request', () => {
  assertEq(match(pm, f({ room: 'outside' })), true);
  assertEq(match(pm, f({ room: 'kitchen' })), false);
});

t('room: "other" matches only write-in requests', () => {
  assertEq(match(pm, f({ room: 'other' })), false);
  assertEq(match({ space_request: [], space_request_other: 'the barn loft' }, f({ room: 'other' })), true);
});

t('filters AND together', () => {
  assertEq(match(pm, f({ session: '2', hour: 'PM1', age: 'oaks', room: 'outside' })), true);
  assertEq(match(pm, f({ session: '2', hour: 'PM2', age: 'oaks', room: 'outside' })), false, 'one miss fails');
});

console.log('  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
