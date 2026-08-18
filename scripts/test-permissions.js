// Unit tests for api/_permissions.js (Phase B — DB-backed).
//
// Run with: node scripts/test-permissions.js
//
// These tests do NOT hit Postgres or Google. They validate:
//   1. isSuperUser — communications@ + vicepresident@ + vp@
//   2. canEditAsRole short-circuits — super user + board mailbox
//   3. canEditAsRole fail-closed when DATABASE_URL is missing
//   4. getRoleHolderEmail / getRoleHolderEmails fallbacks
//   5. activeSchoolYear date logic
//   6. canonicalTitle alias resolution

const assert = require('assert');
const perms = require('../api/_permissions');

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { console.log('  ✓ ' + name); passed++; })
        .catch(err => { console.log('  ✗ ' + name); console.log('      ' + err.message); failed++; });
    }
    console.log('  ✓ ' + name);
    passed++;
  } catch (err) {
    console.log('  ✗ ' + name);
    console.log('      ' + err.message);
    failed++;
  }
}

(async () => {

// ── 1. isSuperUser ─────────────────────────────────────────────────────
console.log('\nisSuperUser');

t('communications@ is super user', () => {
  assert.strictEqual(perms.isSuperUser('communications@rootsandwingsindy.com'), true);
});

t('vicepresident@ is super user', () => {
  assert.strictEqual(perms.isSuperUser('vicepresident@rootsandwingsindy.com'), true);
});

t('vp@ alias is super user', () => {
  assert.strictEqual(perms.isSuperUser('vp@rootsandwingsindy.com'), true);
});

t('case-insensitive', () => {
  assert.strictEqual(perms.isSuperUser('Communications@RootsAndWingsIndy.com'), true);
});

t('regular member is not super user', () => {
  assert.strictEqual(perms.isSuperUser('jodyw@rootsandwingsindy.com'), false);
});

t('empty/null rejected', () => {
  assert.strictEqual(perms.isSuperUser(''), false);
  assert.strictEqual(perms.isSuperUser(null), false);
  assert.strictEqual(perms.isSuperUser(undefined), false);
});

// ── 2. canonicalTitle ──────────────────────────────────────────────────
console.log('\ncanonicalTitle');

t('"Vice President" → "Vice-President"', () => {
  assert.strictEqual(perms._canonicalTitle('Vice President'), 'Vice-President');
});

t('"vice president" → "Vice-President" (case-insensitive)', () => {
  assert.strictEqual(perms._canonicalTitle('vice president'), 'Vice-President');
});

t('untouched titles pass through trimmed', () => {
  assert.strictEqual(perms._canonicalTitle('  Treasurer  '), 'Treasurer');
});

t('empty/null returns empty', () => {
  assert.strictEqual(perms._canonicalTitle(''), '');
  assert.strictEqual(perms._canonicalTitle(null), '');
});

// ── 3. activeSchoolYear ────────────────────────────────────────────────
console.log('\nactiveSchoolYear');

t('Mar 31 returns prior fall year', () => {
  assert.strictEqual(perms.activeSchoolYear(new Date(2026, 2, 31)), '2025-2026');
});

t('Apr 1 flips to upcoming year', () => {
  assert.strictEqual(perms.activeSchoolYear(new Date(2026, 3, 1)), '2026-2027');
});

t('Aug returns current school year', () => {
  assert.strictEqual(perms.activeSchoolYear(new Date(2026, 7, 15)), '2026-2027');
});

t('Dec returns the in-progress year', () => {
  assert.strictEqual(perms.activeSchoolYear(new Date(2026, 11, 15)), '2026-2027');
});

// ── 4. canEditAsRole — super-user is NOT a shortcut ───────────────────
// Per the 2026-05-15 scoping change: super-user-the-login is just an
// impersonation gate. canEditAsRole follows the BOARD_ROLE_EMAILS map
// + role_holders_v2 lookup for every user (including super users).
console.log('\ncanEditAsRole (no super-user shortcut)');

await t('communications@ can act as Communications Director (board mailbox)', async () => {
  const ok = await perms.canEditAsRole('communications@rootsandwingsindy.com', 'Communications Director');
  assert.strictEqual(ok, true);
});

await t('communications@ CANNOT act as Supply Coordinator (out of scope)', async () => {
  // No DB → no role_holders_v2 fallback either. Pure board-mailbox check.
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const ok = await perms.canEditAsRole('communications@rootsandwingsindy.com', 'Supply Coordinator');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(ok, false);
});

await t('vicepresident@ can act as Vice President', async () => {
  const ok = await perms.canEditAsRole('vicepresident@rootsandwingsindy.com', 'Vice President');
  assert.strictEqual(ok, true);
});

await t('vicepresident@ CANNOT act as President', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const ok = await perms.canEditAsRole('vicepresident@rootsandwingsindy.com', 'President');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(ok, false);
});

await t('case-insensitive on email', async () => {
  const ok = await perms.canEditAsRole('Communications@RootsAndWingsIndy.com', 'Communications Director');
  assert.strictEqual(ok, true);
});

await t('empty email rejected', async () => {
  assert.strictEqual(await perms.canEditAsRole('', 'Supply Coordinator'), false);
});

await t('null email rejected', async () => {
  assert.strictEqual(await perms.canEditAsRole(null, 'Supply Coordinator'), false);
});

// ── 5. canEditAsRole — board mailbox short-circuit ────────────────────
console.log('\ncanEditAsRole (board mailbox path)');

await t('treasurer@ passes Treasurer role without DB', async () => {
  const ok = await perms.canEditAsRole('treasurer@rootsandwingsindy.com', 'Treasurer');
  assert.strictEqual(ok, true);
});

await t('membership@ passes Membership Director role', async () => {
  const ok = await perms.canEditAsRole('membership@rootsandwingsindy.com', 'Membership Director');
  assert.strictEqual(ok, true);
});

await t('president@ passes President role', async () => {
  const ok = await perms.canEditAsRole('president@rootsandwingsindy.com', 'President');
  assert.strictEqual(ok, true);
});

await t('treasurer@ does NOT pass Membership Director', async () => {
  // Without DB the board map only matches the right role.
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const ok = await perms.canEditAsRole('treasurer@rootsandwingsindy.com', 'Membership Director');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(ok, false);
});

// ── 6. canEditAsRole — fail-closed when DB unconfigured ──────────────
console.log('\ncanEditAsRole (fail-closed without DB)');

await t('non-super, non-board email rejected without DATABASE_URL', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const ok = await perms.canEditAsRole('jodyw@rootsandwingsindy.com', 'Supply Coordinator');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(ok, false);
});

// ── 7. getRoleHolderEmails ─────────────────────────────────────────────
console.log('\ngetRoleHolderEmails');

await t('returns {} for empty input', async () => {
  assert.deepStrictEqual(await perms.getRoleHolderEmails([]), {});
  assert.deepStrictEqual(await perms.getRoleHolderEmails(null), {});
  assert.deepStrictEqual(await perms.getRoleHolderEmails(undefined), {});
});

await t('returns {} when DB unconfigured', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const out = await perms.getRoleHolderEmails(['President', 'Treasurer']);
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.deepStrictEqual(out, {});
});

// ── 8. getRoleHolderEmail board fallback ──────────────────────────────
console.log('\ngetRoleHolderEmail (board fallback)');

await t('falls back to board mailbox when DB unconfigured', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const email = await perms.getRoleHolderEmail('Treasurer');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(email, 'treasurer@rootsandwingsindy.com');
});

await t('returns null for unknown role with no DB', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const email = await perms.getRoleHolderEmail('Made Up Role');
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.strictEqual(email, null);
});

// ── 9. notification identities (#363) ─────────────────────────────────
console.log('\nidentityResolverFromRows (#363 — two R&W emails)');

const idRes = perms._identityResolverFromRows({
  people: [
    { email: 'colleenr@rootsandwingsindy.com', family_email: 'raymont@rootsandwingsindy.com' },
    { email: 'jane@rootsandwingsindy.com', family_email: 'smith@rootsandwingsindy.com' },
    { email: 'bob@rootsandwingsindy.com', family_email: 'smith@rootsandwingsindy.com' },
    { email: 'solo@rootsandwingsindy.com', family_email: 'solo@rootsandwingsindy.com' }
  ],
  holders: [
    { person_email: 'colleenr@rootsandwingsindy.com', title: 'Vice-President', role_email: 'vicepresident@rootsandwingsindy.com' },
    { person_email: 'jane@rootsandwingsindy.com', title: 'Afternoon Class Liaison', role_email: 'afternoon@rootsandwingsindy.com' }
  ]
});
const has = (arr, x) => arr.indexOf(x) !== -1;

t('person login → own + family alias + role mailboxes', () => {
  const ids = idRes.identitiesFor('ColleenR@rootsandwingsindy.com');
  assert.ok(has(ids, 'colleenr@rootsandwingsindy.com'));
  assert.ok(has(ids, 'raymont@rootsandwingsindy.com'));
  assert.ok(has(ids, 'vicepresident@rootsandwingsindy.com'));
  assert.ok(has(ids, 'vp@rootsandwingsindy.com'));
  assert.ok(!has(ids, 'smith@rootsandwingsindy.com'));
});
t('role mailbox login → sibling aliases + current holder', () => {
  const ids = idRes.identitiesFor('vp@rootsandwingsindy.com');
  assert.ok(has(ids, 'vicepresident@rootsandwingsindy.com'));
  assert.ok(has(ids, 'colleenr@rootsandwingsindy.com'));
  assert.ok(!has(ids, 'raymont@rootsandwingsindy.com'), 'mailbox does not reach into the holder family alias');
});
t('roles.role_email counts as a mailbox alias', () => {
  const ids = idRes.identitiesFor('afternoon@rootsandwingsindy.com');
  assert.ok(has(ids, 'jane@rootsandwingsindy.com'));
  assert.ok(has(idRes.identitiesFor('jane@rootsandwingsindy.com'), 'afternoon@rootsandwingsindy.com'));
});
t('family alias login → every adult login in the household', () => {
  const ids = idRes.identitiesFor('smith@rootsandwingsindy.com');
  assert.ok(has(ids, 'jane@rootsandwingsindy.com') && has(ids, 'bob@rootsandwingsindy.com'));
});
t('a person does NOT see a co-parent’s personal notifications', () => {
  const ids = idRes.identitiesFor('bob@rootsandwingsindy.com');
  assert.ok(!has(ids, 'jane@rootsandwingsindy.com'));
  assert.ok(has(ids, 'smith@rootsandwingsindy.com'));
});
t('single-address member and unknown emails map to themselves only', () => {
  assert.deepStrictEqual(idRes.identitiesFor('solo@rootsandwingsindy.com'), ['solo@rootsandwingsindy.com']);
  assert.deepStrictEqual(idRes.identitiesFor('nobody@example.com'), ['nobody@example.com']);
  assert.deepStrictEqual(idRes.identitiesFor(''), []);
});
await t('buildIdentityResolver fails soft without a DB (login only)', async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  const r = await perms.buildIdentityResolver(null);
  if (prev !== undefined) process.env.DATABASE_URL = prev;
  assert.deepStrictEqual(r.identitiesFor('x@rootsandwingsindy.com'), ['x@rootsandwingsindy.com']);
});

// ── Wrap-up ────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);

})();
