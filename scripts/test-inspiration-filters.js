// Unit tests for Class Inspiration categories + member submissions (#33):
//  - ciIdeaMatchesFilters(row, filters) — the pure category match behind
//    the popup's Ages/Category funnel chips (script.js; extracted the same
//    way test-builder-filters.js grabs sbPaletteFilterMatch).
//  - normalizeInspirationIdea(body) — the server-side input whitelist for
//    the now member-open add endpoint (exported by api/curriculum.js).
//
// Usage: node scripts/test-inspiration-filters.js

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

const matchFn = new Function(extract('ciIdeaMatchesFilters') + '\nreturn ciIdeaMatchesFilters;')();

console.log('ciIdeaMatchesFilters (#33 popup category filter)');

t('cat "all" matches everything, including untagged rows', () => {
  assertEq(matchFn({ categories: [] }, { cat: 'all' }), true);
  assertEq(matchFn({ categories: ['art'] }, { cat: 'all' }), true);
  assertEq(matchFn({}, { cat: 'all' }), true);
});

t('missing/empty filters object behaves like "all"', () => {
  assertEq(matchFn({ categories: [] }, null), true);
  assertEq(matchFn({ categories: ['science'] }, {}), true);
});

t('a tagged row matches its own category only', () => {
  const row = { categories: ['science', 'kitchen'] };
  assertEq(matchFn(row, { cat: 'science' }), true);
  assertEq(matchFn(row, { cat: 'kitchen' }), true);
  assertEq(matchFn(row, { cat: 'art' }), false);
});

t('"other" folds in untagged legacy rows', () => {
  assertEq(matchFn({ categories: [] }, { cat: 'other' }), true, 'untagged');
  assertEq(matchFn({}, { cat: 'other' }), true, 'no categories field');
  assertEq(matchFn({ categories: ['other'] }, { cat: 'other' }), true, 'explicit other');
  assertEq(matchFn({ categories: ['art'] }, { cat: 'other' }), false, 'tagged non-other');
});

t('untagged rows do NOT match a specific category', () => {
  assertEq(matchFn({ categories: [] }, { cat: 'art' }), false);
});

// ── Server-side normalizer ──
const api = require(path.resolve(__dirname, '..', 'api', 'curriculum.js'));
const norm = api.normalizeInspirationIdea;

console.log('normalizeInspirationIdea (#33 member-open add endpoint)');

t('exported from api/curriculum.js', () => {
  assertEq(typeof norm, 'function');
  assertEq(api.INSPIRATION_CATEGORIES.length, 10, 'category list');
  assertEq(api.INSPIRATION_GROUPS.length, 8, 'group list');
});

t('happy path: trims, canonicalises group casing, lowercases categories', () => {
  const out = norm({
    idea: '  Clay play ', note: ' messy fun ',
    group_names: ['saplings', 'OAKS'],
    categories: ['Art', 'KITCHEN']
  });
  assertDeepEq(out, { groups: ['Saplings', 'Oaks'], idea: 'Clay play', note: 'messy fun', categories: ['art', 'kitchen'] });
});

t('legacy single group_name still accepted', () => {
  const out = norm({ idea: 'Bird walks', group_name: 'willows' });
  assertDeepEq(out.groups, ['Willows']);
  assertEq(out.note, '');
  assertDeepEq(out.categories, []);
});

t('unknown groups/categories are dropped; dupes collapse', () => {
  const out = norm({
    idea: 'Chess', group_names: ['Cedars', 'cedars', 'Klingons'],
    categories: ['games', 'games', 'nonsense']
  });
  assertDeepEq(out.groups, ['Cedars']);
  assertDeepEq(out.categories, ['games']);
});

t('missing idea → error', () => {
  assertEq(norm({ group_names: ['Oaks'] }).error, 'idea required');
  assertEq(norm({ idea: '   ', group_names: ['Oaks'] }).error, 'idea required');
});

t('no valid group → error', () => {
  assertEq(norm({ idea: 'X' }).error, 'Pick at least one age group.');
  assertEq(norm({ idea: 'X', group_names: ['Klingons'] }).error, 'Pick at least one age group.');
});

t('length caps: idea 200, note 300', () => {
  const out = norm({ idea: 'a'.repeat(300), note: 'b'.repeat(400), group_names: ['Birch'] });
  assertEq(out.idea.length, 200);
  assertEq(out.note.length, 300);
});

t('empty body → error, not crash', () => {
  assertEq(!!norm(null).error, true);
  assertEq(!!norm(undefined).error, true);
});

console.log('  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
