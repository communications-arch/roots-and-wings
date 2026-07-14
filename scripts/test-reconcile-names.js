// Unit tests for reconcileNameCandidates (api/tour.js) — the surname
// candidate list used to match a registration against the Treasurer's
// Family Payment Tracking rows. Born from a real prod miss (2026-07-14):
// a family whose Main Learning Coach and backup coach have different
// last names was marked Paid in the sheet under the backup coach's name
// and never auto-reconciled.
//
// Usage: node scripts/test-reconcile-names.js

const assert = require('assert');
const { reconcileNameCandidates } = require('../api/tour.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

console.log('reconcileNameCandidates');
t('MLC surname leads (how the Treasurer keys the sheet)', () => {
  const c = reconcileNameCandidates({ main_learning_coach: 'Jane Baumgartner' });
  assert.strictEqual(c[0], 'Baumgartner');
});
t('backup-coach surname included for mixed-surname households', () => {
  const c = reconcileNameCandidates(
    { main_learning_coach: 'Jane Smith' },
    [{ name: 'John Baumgartner' }]
  );
  assert.ok(c.indexOf('Smith') === 0);
  assert.ok(c.indexOf('Baumgartner') !== -1);
});
t('accepts waiver_signatures shape ({person_name}) and plain strings', () => {
  const a = reconcileNameCandidates({ main_learning_coach: 'Jane Smith' }, [{ person_name: 'John Doe' }]);
  const b = reconcileNameCandidates({ main_learning_coach: 'Jane Smith' }, ['John Doe']);
  assert.ok(a.indexOf('Doe') !== -1);
  assert.ok(b.indexOf('Doe') !== -1);
});
t('kid last names included', () => {
  const c = reconcileNameCandidates({
    main_learning_coach: 'Jane Smith',
    kids: [{ name: 'Kid Jones', last_name: 'Jones' }]
  });
  assert.ok(c.indexOf('Jones') !== -1);
});
t('existing_family_name still a candidate (returning families)', () => {
  const c = reconcileNameCandidates({
    main_learning_coach: 'Jane Smith',
    existing_family_name: 'Smith-Jones'
  });
  assert.ok(c.indexOf('Smith-Jones') !== -1);
});
t('dedupes case-insensitively and drops blanks', () => {
  const c = reconcileNameCandidates(
    { main_learning_coach: 'Jane Smith', existing_family_name: 'smith', kids: [{ last_name: '' }] },
    ['Bob SMITH', null]
  );
  assert.deepStrictEqual(c.map(s => s.toLowerCase()), ['smith']);
});
t('empty registration yields empty list (no wild matches)', () => {
  assert.deepStrictEqual(reconcileNameCandidates({}), []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
