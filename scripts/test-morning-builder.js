// Unit tests for the Morning Class Builder pure helpers.
//   - ageAsOfFall / fallYearOf (api/tour.js): a kid's age at Sept 1 of the
//     school year's fall, so grouping reflects class-time age.
//   - mcbGroupAgeRange / mcbCountFlags (script.js): the auto-derived age
//     range per group + the soft "balance" flags.
// Extracted from source the same way test-members-summary.js does.
//
// Usage: node scripts/test-morning-builder.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const ROOT = path.resolve(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const tourSrc = fs.readFileSync(path.join(ROOT, 'api', 'tour.js'), 'utf8');

function extractIndented(src, fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' (indented)');
  return m[0];
}
function extractTop(src, fnName) {
  const re = new RegExp('^function ' + fnName + '\\b[\\s\\S]*?^\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' (top-level)');
  return m[0];
}

const client = new Function(
  extractIndented(scriptSrc, 'mcbGroupAgeRange') + '\n' +
  extractIndented(scriptSrc, 'mcbCountFlags') + '\n' +
  'return { mcbGroupAgeRange, mcbCountFlags };'
)();

const server = new Function(
  extractTop(tourSrc, 'fallYearOf') + '\n' +
  extractTop(tourSrc, 'ageAsOfFall') + '\n' +
  extractTop(tourSrc, 'morningKidDisplayName') + '\n' +
  'return { fallYearOf, ageAsOfFall, morningKidDisplayName };'
)();

function extractConstArray(src, name) {
  const re = new RegExp('^const ' + name + ' = \\[[\\s\\S]*?^\\];', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract const ' + name);
  return m[0];
}
const seedHelpers = new Function(
  extractConstArray(tourSrc, 'MORNING_GROUP_RANGES') + '\n' +
  extractTop(tourSrc, 'groupForAge') + '\n' +
  'return { groupForAge };'
)();

console.log('Morning Class Builder helpers');

// ── ageAsOfFall: age at Sept 1 of the fall year (2026-2027 -> Sept 1 2026) ──
t('birthday before Sept 1 -> full age', () =>
  assert.strictEqual(server.ageAsOfFall('2020-03-15', '2026-2027'), 6));
t('birthday after Sept 1 -> not yet had it', () =>
  assert.strictEqual(server.ageAsOfFall('2020-12-15', '2026-2027'), 5));
t('birthday exactly Sept 1 counts that year', () =>
  assert.strictEqual(server.ageAsOfFall('2020-09-01', '2026-2027'), 6));
t('next school year shifts the reference', () =>
  assert.strictEqual(server.ageAsOfFall('2020-03-15', '2027-2028'), 7));
t('born after the fall start clamps to 0', () =>
  assert.strictEqual(server.ageAsOfFall('2027-01-01', '2026-2027'), 0));
t('empty / invalid birth date -> null', () => {
  assert.strictEqual(server.ageAsOfFall('', '2026-2027'), null);
  assert.strictEqual(server.ageAsOfFall('not-a-date', '2026-2027'), null);
});

// ── mcbGroupAgeRange: derived from the kids placed in a group ──
t('empty group -> no range', () => assert.strictEqual(client.mcbGroupAgeRange([]), ''));
t('single age -> "Age N"', () => assert.strictEqual(client.mcbGroupAgeRange([{ age: 7 }]), 'Age 7'));
t('spread -> "Ages lo–hi"', () =>
  assert.strictEqual(client.mcbGroupAgeRange([{ age: 7 }, { age: 9 }, { age: 8 }]), 'Ages 7–9'));
t('ignores null ages', () =>
  assert.strictEqual(client.mcbGroupAgeRange([{ age: null }, { age: 5 }]), 'Age 5'));

// ── mcbCountFlags: soft balance flags (only once >=3 groups populated) ──
t('fewer than 3 populated groups -> no flags', () =>
  assert.deepStrictEqual(client.mcbCountFlags([4, 4, 0, 0]), ['', '', '', '']));
t('group well above the mean flagged big', () =>
  assert.strictEqual(client.mcbCountFlags([10, 2, 2, 2])[0], 'mcb-count-big'));
t('group well below the mean flagged small', () =>
  assert.strictEqual(client.mcbCountFlags([8, 8, 8, 1])[3], 'mcb-count-small'));
t('empty groups are never flagged', () =>
  assert.strictEqual(client.mcbCountFlags([6, 6, 6, 0])[3], ''));

// ── groupForAge: age → brand group, first-match on overlapping ranges ──
t('toddler → Greenhouse', () => {
  assert.strictEqual(seedHelpers.groupForAge(0), 'Greenhouse');
  assert.strictEqual(seedHelpers.groupForAge(2), 'Greenhouse');
});
t('boundary 5 → Saplings (first match), 6 → Sassafras', () => {
  assert.strictEqual(seedHelpers.groupForAge(3), 'Saplings');
  assert.strictEqual(seedHelpers.groupForAge(5), 'Saplings');
  assert.strictEqual(seedHelpers.groupForAge(6), 'Sassafras');
});
t('boundary 8 → Oaks (first match), 9 → Maples, 10 → Birch, 11 → Willows', () => {
  assert.strictEqual(seedHelpers.groupForAge(7), 'Oaks');
  assert.strictEqual(seedHelpers.groupForAge(8), 'Oaks');
  assert.strictEqual(seedHelpers.groupForAge(9), 'Maples');
  assert.strictEqual(seedHelpers.groupForAge(10), 'Birch');
  assert.strictEqual(seedHelpers.groupForAge(11), 'Willows');
});
t('teens → Cedars then Pigeons', () => {
  assert.strictEqual(seedHelpers.groupForAge(12), 'Cedars');
  assert.strictEqual(seedHelpers.groupForAge(13), 'Cedars');
  assert.strictEqual(seedHelpers.groupForAge(14), 'Pigeons');
  assert.strictEqual(seedHelpers.groupForAge(18), 'Pigeons');
});
t('null/unknown age → empty (left unplaced)', () => {
  assert.strictEqual(seedHelpers.groupForAge(null), '');
});

// ── morningKidDisplayName: chips must always show a last name ──
const mkdn = server.morningKidDisplayName;
t('explicit first + last -> "First Last"', () =>
  assert.strictEqual(mkdn({ name: 'Robert Kielma', first_name: 'Robert', last_name: 'Kielma' }, 'Kielma'), 'Robert Kielma'));
t('explicit compound last preserved (not truncated)', () =>
  assert.strictEqual(mkdn({ first_name: 'Robert', last_name: 'Van Kielma' }, 'Kielma'), 'Robert Van Kielma'));
t('bare first + no explicit last -> append family surname', () =>
  assert.strictEqual(mkdn({ name: 'Robert' }, 'Kielma'), 'Robert Kielma'));
t('explicit first, empty last -> fall back to family surname', () =>
  assert.strictEqual(mkdn({ first_name: 'Robert', last_name: '' }, 'Kielma'), 'Robert Kielma'));
t('legacy combined name with surname kept verbatim', () =>
  assert.strictEqual(mkdn({ name: 'Robert Van Kielma' }, 'Kielma'), 'Robert Van Kielma'));
t('bare first with no family surname -> first only (no crash)', () =>
  assert.strictEqual(mkdn({ name: 'Robert' }, ''), 'Robert'));
t('empty kid -> empty string', () =>
  assert.strictEqual(mkdn({}, 'Kielma'), ''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
