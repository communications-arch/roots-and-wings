// Unit tests for api/_family.js (Phase 3 of directory→DB migration).
//
// Validates the resolveFamily / canActAs helpers without hitting a real DB.
// We mock the `sql` template tag with an in-memory store and assert against
// the function behavior.
//
// Run with: node scripts/test-coparent-auth.js

const assert = require('assert');
const family = require('../api/_family');

let passed = 0;
let failed = 0;

function t(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); passed++; })
    .catch((err) => {
      console.log('  ✗ ' + name);
      console.log('      ' + err.message);
      failed++;
    });
}

// Mock sql tag: pattern-matches the two query shapes used by _family.js
// against an in-memory rows array. Lower-cases everything for comparison
// (the real Postgres queries do the same via LOWER()).
function mockSql(rows) {
  return function tag(strings, ...values) {
    const sqlText = strings.join('?').replace(/\s+/g, ' ').toLowerCase();
    if (sqlText.includes('select family_email, family_name')) {
      // resolveFamily: values = [email, email]
      const email = String(values[0] || '').toLowerCase();
      const hits = rows.filter(r =>
        String(r.family_email || '').toLowerCase() === email ||
        (r.additional_emails || []).some(ae => String(ae).toLowerCase() === email)
      );
      return Promise.resolve(hits.slice(0, 1));
    }
    if (sqlText.includes('select 1 from member_profiles')) {
      // canActAs: values = [targetFamilyEmail, userEmail]
      const target = String(values[0] || '').toLowerCase();
      const user = String(values[1] || '').toLowerCase();
      const hits = rows.filter(r =>
        String(r.family_email || '').toLowerCase() === target &&
        (r.additional_emails || []).some(ae => String(ae).toLowerCase() === user)
      );
      return Promise.resolve(hits.slice(0, 1));
    }
    return Promise.resolve([]);
  };
}

const fixture = [
  {
    family_email: 'jessicas@rootsandwingsindy.com',
    family_name: 'Shewan',
    parents: [{ name: 'Jessica' }, { name: 'Jay' }],
    kids: [],
    additional_emails: ['jays@rootsandwingsindy.com']
  },
  {
    family_email: 'jessicar@rootsandwingsindy.com',
    family_name: 'Richter',
    parents: [{ name: 'Jessica' }, { name: 'Brian' }],
    kids: [],
    additional_emails: ['brianr@rootsandwingsindy.com']
  },
  {
    family_email: 'erinb@rootsandwingsindy.com',
    family_name: 'Bogan',
    parents: [{ name: 'Erin' }],
    kids: [],
    additional_emails: []
  }
];

(async function () {
  console.log('\nresolveFamily');

  const sql = mockSql(fixture);

  t('primary email resolves to its family', async () => {
    const r = await family.resolveFamily(sql, 'jessicas@rootsandwingsindy.com');
    assert(r, 'expected a row');
    assert.strictEqual(r.family_name, 'Shewan');
  });

  t('co-parent secondary email resolves to the same family', async () => {
    const r = await family.resolveFamily(sql, 'jays@rootsandwingsindy.com');
    assert(r, 'expected a row');
    assert.strictEqual(r.family_email, 'jessicas@rootsandwingsindy.com');
    assert.strictEqual(r.family_name, 'Shewan');
  });

  t('case-insensitive on the user email side', async () => {
    const r = await family.resolveFamily(sql, 'JAYS@RootsAndWingsIndy.com');
    assert(r, 'expected a row');
    assert.strictEqual(r.family_name, 'Shewan');
  });

  t('different family\'s secondary email resolves to its own family', async () => {
    const r = await family.resolveFamily(sql, 'brianr@rootsandwingsindy.com');
    assert(r, 'expected a row');
    assert.strictEqual(r.family_name, 'Richter');
  });

  t('unknown email returns null', async () => {
    const r = await family.resolveFamily(sql, 'stranger@rootsandwingsindy.com');
    assert.strictEqual(r, null);
  });

  t('empty email returns null', async () => {
    assert.strictEqual(await family.resolveFamily(sql, ''), null);
    assert.strictEqual(await family.resolveFamily(sql, null), null);
    assert.strictEqual(await family.resolveFamily(sql, undefined), null);
  });

  t('family with empty additional_emails still resolves via primary', async () => {
    const r = await family.resolveFamily(sql, 'erinb@rootsandwingsindy.com');
    assert(r, 'expected a row');
    assert.strictEqual(r.family_name, 'Bogan');
  });

  console.log('\ncanActAs');

  t('primary email can act on its own family', async () => {
    const ok = await family.canActAs(sql, 'jessicas@rootsandwingsindy.com', 'jessicas@rootsandwingsindy.com');
    assert.strictEqual(ok, true);
  });

  t('co-parent can act on the family they\'re aliased to', async () => {
    const ok = await family.canActAs(sql, 'jays@rootsandwingsindy.com', 'jessicas@rootsandwingsindy.com');
    assert.strictEqual(ok, true);
  });

  t('co-parent CANNOT act on a different family', async () => {
    const ok = await family.canActAs(sql, 'jays@rootsandwingsindy.com', 'jessicar@rootsandwingsindy.com');
    assert.strictEqual(ok, false);
  });

  t('stranger CANNOT act on any family', async () => {
    const ok = await family.canActAs(sql, 'stranger@rootsandwingsindy.com', 'jessicas@rootsandwingsindy.com');
    assert.strictEqual(ok, false);
  });

  t('empty user rejected', async () => {
    assert.strictEqual(await family.canActAs(sql, '', 'jessicas@rootsandwingsindy.com'), false);
    assert.strictEqual(await family.canActAs(sql, null, 'jessicas@rootsandwingsindy.com'), false);
  });

  t('empty target rejected', async () => {
    assert.strictEqual(await family.canActAs(sql, 'jessicas@rootsandwingsindy.com', ''), false);
    assert.strictEqual(await family.canActAs(sql, 'jessicas@rootsandwingsindy.com', null), false);
  });

  t('case-insensitive on both sides', async () => {
    const ok = await family.canActAs(sql, 'JAYS@RootsAndWingsIndy.com', 'JESSICAS@RootsAndWingsIndy.com');
    assert.strictEqual(ok, true);
  });

  // Wait for all the deferred t() promises before reporting.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
