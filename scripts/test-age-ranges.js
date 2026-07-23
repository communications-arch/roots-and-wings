// Unit tests for the roster-aware age-group range helpers in script.js
// (Erin, 2026-07-23): in the members portal a group's printed range
// stretches to cover the kids actually placed in it, so a Saplings roster
// holding a 6-year-old reads "3–6" instead of "3–5". The public site is
// untouched — its age cards always show the typical band.
//
//   ageTodayLocal     — whole-year age from a date-only string, LOCAL day
//   ageSpanOf         — {lo, hi} over a list of ages
//   widenRangeToSpan  — stretches a printed range to cover a span (pure)
//
// script.js is a browser IIFE, so we grep the helpers out and re-hydrate
// them the same way test-helpers.js does.
//
// Usage: node scripts/test-age-ranges.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(
  [extract('ageTodayLocal'), extract('ageSpanOf'), extract('widenRangeToSpan')].join('\n\n') +
  '\nreturn { ageTodayLocal, ageSpanOf, widenRangeToSpan };'
);
const { ageTodayLocal, ageSpanOf, widenRangeToSpan } = factory();

// ── ageTodayLocal ─────────────────────────────────────────────────────────
console.log('ageTodayLocal');
{
  // Build a birthday exactly N years ago so the test never goes stale.
  function nYearsAgo(n, dayShift) {
    const d = new Date();
    d.setFullYear(d.getFullYear() - n);
    if (dayShift) d.setDate(d.getDate() + dayShift);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  t('birthday today → exact age', () => assert.strictEqual(ageTodayLocal(nYearsAgo(8)), 8));
  t('birthday tomorrow → still one younger', () => assert.strictEqual(ageTodayLocal(nYearsAgo(8, 1)), 7));
  t('birthday yesterday → already turned', () => assert.strictEqual(ageTodayLocal(nYearsAgo(8, -1)), 8));

  // The whole reason this exists instead of reusing computeAge(): a missing
  // birthdate must NOT read as age 0, or one kid with no birthday on file
  // drags every group's floor down to zero.
  t('missing birthdate → null, not 0', () => assert.strictEqual(ageTodayLocal(''), null));
  t('null birthdate → null', () => assert.strictEqual(ageTodayLocal(null), null));
  t('garbage birthdate → null', () => assert.strictEqual(ageTodayLocal('not a date'), null));
  t('timestamp form is truncated to the day', () => {
    assert.strictEqual(ageTodayLocal(nYearsAgo(10) + 'T00:00:00.000Z'), 10);
  });
}

// ── ageSpanOf ─────────────────────────────────────────────────────────────
console.log('\nageSpanOf');
{
  t('min/max over known ages', () => assert.deepStrictEqual(ageSpanOf([8, 5, 11, 7]), { lo: 5, hi: 11 }));
  t('single age → lo === hi', () => assert.deepStrictEqual(ageSpanOf([6]), { lo: 6, hi: 6 }));
  t('nulls ignored', () => assert.deepStrictEqual(ageSpanOf([null, 9, null]), { lo: 9, hi: 9 }));
  t('all unknown → null', () => assert.strictEqual(ageSpanOf([null, null]), null));
  t('empty → null', () => assert.strictEqual(ageSpanOf([]), null));
  t('missing arg → null', () => assert.strictEqual(ageSpanOf(), null));
}

// ── widenRangeToSpan ──────────────────────────────────────────────────────
console.log('\nwidenRangeToSpan');
{
  const span = (lo, hi) => ({ lo: lo, hi: hi });

  t('roster inside the band leaves the range alone', () => {
    assert.strictEqual(widenRangeToSpan('3–5', span(4, 5)), '3–5');
  });
  t('older kid stretches the top', () => {
    assert.strictEqual(widenRangeToSpan('3–5', span(4, 6)), '3–6');
  });
  t('younger kid stretches the bottom', () => {
    assert.strictEqual(widenRangeToSpan('7–8', span(5, 8)), '5–8');
  });
  t('stretches both ends at once', () => {
    assert.strictEqual(widenRangeToSpan('9–10', span(8, 12)), '8–12');
  });
  t('en-dash is preserved', () => {
    assert.strictEqual(widenRangeToSpan('7–8', span(7, 9)), '7–9');
  });
  t('plain hyphen is preserved (sheet-era AM_CLASSES ages)', () => {
    assert.strictEqual(widenRangeToSpan('3-6', span(2, 6)), '2-6');
  });
  t('spaced dash keeps its spacing', () => {
    assert.strictEqual(widenRangeToSpan('7 – 8', span(7, 9)), '7 – 9');
  });

  t('open-ended "14+" only ever widens downward', () => {
    assert.strictEqual(widenRangeToSpan('14+', span(13, 17)), '13+');
    assert.strictEqual(widenRangeToSpan('14+', span(15, 19)), '14+');
  });

  t('parenthetical label widens inside the parens', () => {
    assert.strictEqual(widenRangeToSpan('Saplings (3–5)', span(3, 6)), 'Saplings (3–6)');
  });
  t('parenthetical label in band is untouched', () => {
    assert.strictEqual(widenRangeToSpan('Saplings (3–5)', span(4, 5)), 'Saplings (3–5)');
  });
  t('multi-group label is left alone (which paren would we widen?)', () => {
    const multi = 'Oaks (7–8), Maples (8–9)';
    assert.strictEqual(widenRangeToSpan(multi, span(6, 11)), multi);
  });

  t('no span (nobody placed, or no birthdays known) → unchanged', () => {
    assert.strictEqual(widenRangeToSpan('3–5', null), '3–5');
  });
  t('non-numeric text is left alone', () => {
    assert.strictEqual(widenRangeToSpan('All ages', span(3, 14)), 'All ages');
    assert.strictEqual(widenRangeToSpan('', span(3, 14)), '');
  });
  t('reviewer free-text override is left alone', () => {
    assert.strictEqual(widenRangeToSpan('7 and up, siblings welcome', span(5, 12)), '7 and up, siblings welcome');
  });
  t('a bare single age becomes a range when the roster spreads', () => {
    assert.strictEqual(widenRangeToSpan('8', span(7, 9)), '7–9');
    assert.strictEqual(widenRangeToSpan('8', span(8, 8)), '8');
  });
  t('null/undefined input → empty string', () => {
    assert.strictEqual(widenRangeToSpan(null, span(3, 5)), '');
    assert.strictEqual(widenRangeToSpan(undefined, span(3, 5)), '');
  });
}

// ── refreshDirectoryGroupPills load-order safety ──────────────────────────
// This one is a REGRESSION GUARD, not a feature test. script.js is one big
// IIFE: renderDirectory() is invoked at top level around line 4400, but
// `var MORNING_GROUP_ORDER` isn't assigned until ~line 30750. On that first
// call the var is declared-but-undefined, so an unguarded .forEach threw a
// TypeError that killed the entire IIFE — the whole members portal failed to
// load. Shipped that on 2026-07-23; caught in the browser, not here.
console.log('\nrefreshDirectoryGroupPills (load-order safety)');
{
  const pillFn = extract('refreshDirectoryGroupPills');

  function runWith(groupOrder) {
    // Minimal shim: a filters wrapper that finds no matching pill, so the
    // only thing under test is whether the function survives being called.
    const wrap = { querySelector: () => null };
    const document = {
      getElementById: id => (id === 'directoryFilters' ? wrap : null),
      createElement: () => ({ appendChild() {} }),
      createTextNode: () => ({})
    };
    const fn = new Function('document', 'MORNING_GROUP_ORDER', 'widenRangeForGroup',
      pillFn + '\nreturn refreshDirectoryGroupPills;');
    fn(document, groupOrder, () => '3–5')();
  }

  t('does not throw when MORNING_GROUP_ORDER is not yet assigned', () => {
    runWith(undefined); // the exact state during IIFE setup
  });
  t('does not throw when the group list is assigned', () => {
    runWith([{ name: 'Saplings', range: '3–5', min: 3, max: 5 }]);
  });
  t('guards the group list before iterating it', () => {
    const guardPos = pillFn.indexOf('Array.isArray(MORNING_GROUP_ORDER)');
    const usePos = pillFn.indexOf('MORNING_GROUP_ORDER.forEach');
    assert.ok(guardPos !== -1, 'the Array.isArray guard is gone — see the comment above');
    assert.ok(guardPos < usePos, 'the guard must come before the forEach');
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
