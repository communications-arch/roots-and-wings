// Unit tests for the Welcome Coordinator lifecycle-stage helpers (script.js).
//   welcomeStage(f): 0 = new (not welcomed), 1 = welcomed (needs Meet &
//     Greet), 2 = met & greeted (done). Drives row sort, icon, and the
//     next-action button; welcomeInProgress = stage < 2 drives the To Do count.
// Extracted from script.js the same way test-members-summary.js does.
//
// Usage: node scripts/test-welcome-lifecycle.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', 'script.js'), 'utf8');
function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}
const { welcomeStage, welcomeInProgress } = new Function(
  extract('welcomeStage') + '\n' + extract('welcomeInProgress') + '\n' +
  'return { welcomeStage, welcomeInProgress };'
)();

console.log('Welcome lifecycle stages');
t('a brand-new family (no welcome, no meet) is stage 0', () => {
  assert.strictEqual(welcomeStage({}), 0);
  assert.strictEqual(welcomeStage({ welcomed_at: null, met_at: null }), 0);
});
t('welcomed but not met is stage 1', () => {
  assert.strictEqual(welcomeStage({ welcomed_at: '2026-09-01T00:00:00Z', met_at: null }), 1);
});
t('met & greeted is stage 2 (done)', () => {
  assert.strictEqual(welcomeStage({ welcomed_at: '2026-09-01T00:00:00Z', met_at: '2026-09-10T00:00:00Z' }), 2);
});
t('met_at present without welcomed_at still reads as done (stage 2)', () => {
  // Server upserts welcomed_at when logging a meet, but guard the ordering.
  assert.strictEqual(welcomeStage({ welcomed_at: null, met_at: '2026-09-10T00:00:00Z' }), 2);
});
t('welcomeInProgress true for stages 0 and 1, false for stage 2', () => {
  assert.strictEqual(welcomeInProgress({}), true);
  assert.strictEqual(welcomeInProgress({ welcomed_at: 'x' }), true);
  assert.strictEqual(welcomeInProgress({ welcomed_at: 'x', met_at: 'y' }), false);
});
t('sort order: earlier stages sort first (ascending stage)', () => {
  const fams = [
    { id: 1, welcomed_at: 'x', met_at: 'y' }, // 2
    { id: 2 },                                // 0
    { id: 3, welcomed_at: 'x' },              // 1
  ];
  fams.sort((a, b) => welcomeStage(a) - welcomeStage(b));
  assert.deepStrictEqual(fams.map(f => f.id), [2, 3, 1]);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
