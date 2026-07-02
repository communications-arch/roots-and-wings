// Unit tests for the Field-Day participation season resolver (api/sheets.js).
//   - participationResolveSeason: given the co-op sessions + today, returns the
//     current season by the Field-Day boundary (flips the DAY AFTER Field Day),
//     plus the season-start date used to scope year-agnostic tables.
//   - participationSnapWedAfter / participationAddDays: UTC date math.
// Functions are extracted from source (not required) so the test doesn't pull
// in the DB / Google libs — same approach as test-board-calendar.js.
//
// Usage: node scripts/test-participation-season.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const ROOT = path.resolve(__dirname, '..');
const sheetsSrc = fs.readFileSync(path.join(ROOT, 'api', 'sheets.js'), 'utf8');

function extractTop(src, fnName) {
  const re = new RegExp('^function ' + fnName + '\\b[\\s\\S]*?^\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' (top-level)');
  return m[0];
}

const S = new Function(
  extractTop(sheetsSrc, 'participationAddDays') + '\n' +
  extractTop(sheetsSrc, 'participationSnapWedAfter') + '\n' +
  extractTop(sheetsSrc, 'participationResolveSeason') + '\n' +
  'return { participationAddDays, participationSnapWedAfter, participationResolveSeason };'
)();

// Session 5 of 2025-2026 ended Wed 2026-05-13 → Field Day = Wed 2026-05-20.
const Y2526 = [
  { school_year: '2025-2026', end_date: '2025-09-24' },
  { school_year: '2025-2026', end_date: '2026-05-13' }, // latest end
];

console.log('participationSnapWedAfter / participationAddDays');
t('snapWedAfter lands the Wednesday one week after a Wednesday', () => {
  assert.strictEqual(S.participationSnapWedAfter('2026-05-13'), '2026-05-20');
});
t('snapWedAfter from a non-Wednesday lands the next Wednesday', () => {
  assert.strictEqual(S.participationSnapWedAfter('2026-05-14'), '2026-05-20');
});
t('addDays crosses month boundaries (UTC)', () => {
  assert.strictEqual(S.participationAddDays('2026-05-20', 1), '2026-05-21');
  assert.strictEqual(S.participationAddDays('2026-05-31', 1), '2026-06-01');
});

console.log('participationResolveSeason');
t('before Field Day → still the current (2025-2026) season, no date-scoping', () => {
  const r = S.participationResolveSeason(Y2526, '2026-05-01');
  assert.strictEqual(r.seasonLabel, '2025-2026');
  assert.strictEqual(r.seasonShort, '25_26');
  assert.strictEqual(r.seasonStart, ''); // prev year's Field Day unknown
});
t('ON Field Day → not yet reset (still 2025-2026)', () => {
  const r = S.participationResolveSeason(Y2526, '2026-05-20');
  assert.strictEqual(r.seasonLabel, '2025-2026');
});
t('day AFTER Field Day → flips to 2026-2027 and resets', () => {
  const r = S.participationResolveSeason(Y2526, '2026-05-21');
  assert.strictEqual(r.seasonLabel, '2026-2027');
  assert.strictEqual(r.seasonShort, '26_27');
  assert.strictEqual(r.seasonStart, '2026-05-21'); // scope tables from here
});
t('mid-summer (July) → new season 2026-2027', () => {
  const r = S.participationResolveSeason(Y2526, '2026-07-02');
  assert.strictEqual(r.seasonLabel, '2026-2027');
  assert.strictEqual(r.seasonStart, '2026-05-21');
});
t('with next year already scheduled, mid-summer still reads 2026-2027', () => {
  const both = Y2526.concat([
    { school_year: '2026-2027', end_date: '2027-05-12' }, // Field Day 2027-05-19
  ]);
  const r = S.participationResolveSeason(both, '2026-07-02');
  assert.strictEqual(r.seasonLabel, '2026-2027');
  assert.strictEqual(r.seasonStart, '2026-05-21'); // day after 2025-2026 Field Day
});
t('inside a fully-scheduled next year (past Sept) reads that year', () => {
  const both = Y2526.concat([
    { school_year: '2026-2027', end_date: '2027-05-12' },
  ]);
  const r = S.participationResolveSeason(both, '2026-10-15');
  assert.strictEqual(r.seasonLabel, '2026-2027');
});
t('no sessions → null (caller falls back to month heuristic)', () => {
  assert.strictEqual(S.participationResolveSeason([], '2026-07-02'), null);
  assert.strictEqual(S.participationResolveSeason(null, '2026-07-02'), null);
});
t('ignores malformed school_year / empty end dates', () => {
  const messy = [
    { school_year: 'garbage', end_date: '2026-05-13' },
    { school_year: '2025-2026', end_date: '' },
    { school_year: '2025-2026', end_date: '2026-05-13' },
  ];
  const r = S.participationResolveSeason(messy, '2026-07-02');
  assert.strictEqual(r.seasonLabel, '2026-2027');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
