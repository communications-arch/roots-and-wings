// Unit tests for new-member detection (Directory 🌱 indicator + filter,
// membership report isNewMember).
//
// Server side (api/sheets.js):
//   seasonToYearLabel — normalizes '25_26' and '2026-2027' season formats
//                       to the long label; '' for garbage. This is what
//                       fixes the membership report's isNewMember, which
//                       used to compare the two formats raw and never match.
//
// Client side (script.js, extracted like test-helpers.js does):
//   lastCompletedYearLabel — Field-Day boundary: during the school year the
//                            last completed year is the prior one; during
//                            summer break the just-ended year counts.
//   isNewMemberPerson      — person.firstSeason ('' = pre-portal/returning,
//                            never new) is newer than the last completed year.
//
// Usage: node scripts/test-new-member.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { seasonToYearLabel } = require('../api/sheets.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

console.log('\nseasonToYearLabel (api/sheets.js)');

t('passes long form through unchanged', () => {
  assert.strictEqual(seasonToYearLabel('2026-2027'), '2026-2027');
});

t("converts participationCurrentSeason short form ('25_26')", () => {
  assert.strictEqual(seasonToYearLabel('25_26'), '2025-2026');
});

t('trims whitespace', () => {
  assert.strictEqual(seasonToYearLabel(' 2026-2027 '), '2026-2027');
});

t("returns '' for garbage, null, undefined", () => {
  assert.strictEqual(seasonToYearLabel('fall 2026'), '');
  assert.strictEqual(seasonToYearLabel(''), '');
  assert.strictEqual(seasonToYearLabel(null), '');
  assert.strictEqual(seasonToYearLabel(undefined), '');
});

// ── Extract the client-side helpers from script.js ─────────────────────────
const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

// Re-hydrate with ACTIVE_SESSION_YEAR + isSummerBreak as injectable state.
const factory = new Function(
  'ACTIVE_SESSION_YEAR',
  'isSummerBreak',
  extract('lastCompletedYearLabel') + '\n' +
  extract('isNewMemberPerson') + '\n' +
  'return { lastCompletedYearLabel: lastCompletedYearLabel, isNewMemberPerson: isNewMemberPerson };'
);

console.log('\nlastCompletedYearLabel (script.js)');

t('during the school year, last completed year is the prior one', () => {
  const fns = factory('2026-2027', false);
  assert.strictEqual(fns.lastCompletedYearLabel(), '2025-2026');
});

t('during summer break, the just-ended year counts as completed', () => {
  const fns = factory('2025-2026', true);
  assert.strictEqual(fns.lastCompletedYearLabel(), '2025-2026');
});

t("returns '' when ACTIVE_SESSION_YEAR is malformed (fail-safe)", () => {
  const fns = factory('TBD', false);
  assert.strictEqual(fns.lastCompletedYearLabel(), '');
});

console.log('\nisNewMemberPerson (script.js)');

t('first-year family is new during their first school year', () => {
  const fns = factory('2026-2027', false);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '2026-2027' }), true);
});

t('newly-registered family is new during the summer before their first year', () => {
  // June 2026: 25-26 just completed (summer break), 26-27 registrants are new.
  const fns = factory('2025-2026', true);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '2026-2027' }), true);
});

t('family stops being new once their first year completes at Field Day', () => {
  const fns = factory('2026-2027', true);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '2026-2027' }), false);
});

t('mid-year (not summer), prior-year joiners are not new', () => {
  const fns = factory('2026-2027', false);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '2025-2026' }), false);
});

t('pre-portal / returning families (empty firstSeason) are never new', () => {
  const fns = factory('2026-2027', false);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '' }), false);
  assert.strictEqual(fns.isNewMemberPerson({}), false);
  assert.strictEqual(fns.isNewMemberPerson(null), false);
});

t('fail-safe: malformed ACTIVE_SESSION_YEAR flags nobody', () => {
  const fns = factory('TBD', false);
  assert.strictEqual(fns.isNewMemberPerson({ firstSeason: '2026-2027' }), false);
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
