// Unit tests for the "26/27 Members" summary-card helper (script.js).
//
// The board-facing members-summary card derives its season-aware title
// ("26/27 Members") from seasonShortLabel(), which turns a long season
// label like '2026-2027' into '26/27'. The card title + heading re-derive
// from the live data's season so the report rolls over automatically when
// next year's registration opens. Extracted from script.js the same way
// test-org-structure.js / test-helpers.js do.
//
// Usage: node scripts/test-members-summary.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(
  extract('seasonShortLabel') + '\n' +
  'return { seasonShortLabel };'
);
const { seasonShortLabel } = factory();

console.log('Members summary helpers');

// ── Season short label: '2026-2027' -> '26/27' for the card title ──
t('long label -> short', () => assert.strictEqual(seasonShortLabel('2026-2027'), '26/27'));
t('next year rolls over', () => assert.strictEqual(seasonShortLabel('2027-2028'), '27/28'));
t('century boundary', () => assert.strictEqual(seasonShortLabel('2099-2100'), '99/00'));
t('non-standard label passes through', () => assert.strictEqual(seasonShortLabel('Summer'), 'Summer'));
t('empty -> empty string', () => assert.strictEqual(seasonShortLabel(''), ''));
t('null/undefined -> empty string', () => {
  assert.strictEqual(seasonShortLabel(null), '');
  assert.strictEqual(seasonShortLabel(undefined), '');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
