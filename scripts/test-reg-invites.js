// Unit tests for the registration-link invite funnel helpers (script.js).
//   regInviteStatus(inv, nowMs?): 'registered' | 'dismissed' | 'expired' |
//     'opened' | 'sent' — registered wins over dismissed (if the family
//     registered anyway, that's the truth that matters); expired (14 days
//     past the last send) outranks opened.
//   regInviteAwaiting(inv): drives the "Awaiting Registration" To Do count
//     (sent, opened, or expired — not yet registered and not dismissed).
//   regInviteBucket(inv): filter-pill bucket — sent+opened collapse to
//     'waiting'; expired is its own bucket.
// Extracted from script.js the same way test-welcome-lifecycle.js does.
//
// Usage: node scripts/test-reg-invites.js

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
const { regInviteStatus, regInviteAwaiting, regInviteBucket, regInviteExpired } = new Function(
  extract('regInviteExpired') + '\n' + extract('regInviteStatus') + '\n' +
  extract('regInviteAwaiting') + '\n' + extract('regInviteBucket') + '\n' +
  'return { regInviteStatus, regInviteAwaiting, regInviteBucket, regInviteExpired };'
)();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-07-14T12:00:00Z');
const daysAgo = n => new Date(NOW - n * DAY).toISOString();

console.log('Registration-link invite funnel');
t('freshly sent invite is status sent, bucket waiting, awaiting', () => {
  const inv = { last_sent_at: daysAgo(1) };
  assert.strictEqual(regInviteStatus(inv, NOW), 'sent');
  assert.strictEqual(regInviteBucket(inv), 'waiting');
  assert.strictEqual(regInviteAwaiting(inv), true);
});
t('opened but not registered is status opened, still waiting/awaiting', () => {
  const inv = { last_sent_at: daysAgo(1), opened_at: daysAgo(0) };
  assert.strictEqual(regInviteStatus(inv, NOW), 'opened');
  assert.strictEqual(regInviteBucket(inv), 'waiting');
  assert.strictEqual(regInviteAwaiting(inv), true);
});
t('link expires 14 days after the last send (13d fresh, 15d expired)', () => {
  assert.strictEqual(regInviteExpired({ last_sent_at: daysAgo(13) }, NOW), false);
  assert.strictEqual(regInviteExpired({ last_sent_at: daysAgo(15) }, NOW), true);
  assert.strictEqual(regInviteStatus({ last_sent_at: daysAgo(15) }, NOW), 'expired');
});
t('expired outranks opened, gets its own bucket, still counts as awaiting', () => {
  const inv = { last_sent_at: daysAgo(20), opened_at: daysAgo(18) };
  assert.strictEqual(regInviteStatus(inv, NOW), 'expired');
  assert.strictEqual(regInviteBucket(inv), 'expired');
  assert.strictEqual(regInviteAwaiting(inv), true);
});
t('registered and dismissed both win over expired', () => {
  assert.strictEqual(regInviteStatus({ last_sent_at: daysAgo(20), registered_at: daysAgo(16) }, NOW), 'registered');
  assert.strictEqual(regInviteStatus({ last_sent_at: daysAgo(20), dismissed_at: daysAgo(2) }, NOW), 'dismissed');
});
t('a resend restarts the clock (last_sent_at recent → not expired)', () => {
  const inv = { first_sent_at: daysAgo(30), last_sent_at: daysAgo(2), send_count: 2 };
  assert.strictEqual(regInviteExpired(inv, NOW), false);
  assert.strictEqual(regInviteStatus(inv, NOW), 'sent');
});
t('registered invite is done — not awaiting, bucket registered', () => {
  const inv = { opened_at: 'x', registered_at: '2026-07-16T00:00:00Z' };
  assert.strictEqual(regInviteStatus(inv), 'registered');
  assert.strictEqual(regInviteBucket(inv), 'registered');
  assert.strictEqual(regInviteAwaiting(inv), false);
});
t('dismissed invite drops out of the awaiting count', () => {
  const inv = { opened_at: 'x', dismissed_at: '2026-07-20T00:00:00Z' };
  assert.strictEqual(regInviteStatus(inv), 'dismissed');
  assert.strictEqual(regInviteBucket(inv), 'dismissed');
  assert.strictEqual(regInviteAwaiting(inv), false);
});
t('registered wins over dismissed (family signed up anyway)', () => {
  const inv = { dismissed_at: 'x', registered_at: 'y' };
  assert.strictEqual(regInviteStatus(inv), 'registered');
  assert.strictEqual(regInviteBucket(inv), 'registered');
});
t('null/undefined invite is status empty-string', () => {
  assert.strictEqual(regInviteStatus(null), '');
  assert.strictEqual(regInviteStatus(undefined), '');
});
t('awaiting count math: only sent/opened rows count', () => {
  const invites = [
    { },                                        // sent      → counts
    { opened_at: 'x' },                         // opened    → counts
    { registered_at: 'x' },                     // registered
    { dismissed_at: 'x' },                      // dismissed
    { opened_at: 'x', registered_at: 'y' },     // registered
  ];
  assert.strictEqual(invites.filter(regInviteAwaiting).length, 2);
});

// ── tourDisplayStatus: the pipeline's derived workflow stages ─────────
// Depends on the regInviteForEmail cache lookup — stubbed per test. The
// extracted regInviteStatus runs with the real clock here, so fixtures
// use dates relative to actual now.
const realDaysAgo = n => new Date(Date.now() - n * DAY).toISOString();
function makeDisplayStatus(invByEmail) {
  return new Function(
    'var regInviteForEmail = function (e) { return (' + JSON.stringify(invByEmail) + ')[String(e).toLowerCase()] || null; };\n' +
    extract('regInviteExpired') + '\n' + extract('regInviteStatus') + '\n' + extract('tourDisplayStatus') + '\n' +
    'return tourDisplayStatus;'
  )();
}

console.log('\ntourDisplayStatus (pipeline workflow stages)');
t('toured with no invite stays toured', () => {
  const ds = makeDisplayStatus({});
  assert.strictEqual(ds({ status: 'toured', family_email: 'a@x.com' }), 'toured');
});
t('toured + fresh link → link_sent; 20-day-old link → reg_expired', () => {
  const ds = makeDisplayStatus({
    'fresh@x.com': { last_sent_at: realDaysAgo(2) },
    'stale@x.com': { last_sent_at: realDaysAgo(20) }
  });
  assert.strictEqual(ds({ status: 'toured', family_email: 'fresh@x.com' }), 'link_sent');
  assert.strictEqual(ds({ status: 'followed_up', family_email: 'stale@x.com' }), 'reg_expired');
});
t('registered invite falls back to base status (Joined is the explicit close-out)', () => {
  const ds = makeDisplayStatus({ 'reg@x.com': { last_sent_at: realDaysAgo(2), registered_at: realDaysAgo(1) } });
  assert.strictEqual(ds({ status: 'toured', family_email: 'reg@x.com' }), 'toured');
});
t('stages only apply post-tour; terminal statuses win', () => {
  const ds = makeDisplayStatus({ 'a@x.com': { last_sent_at: realDaysAgo(2) } });
  assert.strictEqual(ds({ status: 'scheduled', family_email: 'a@x.com' }), 'scheduled');
  assert.strictEqual(ds({ status: 'joined', family_email: 'a@x.com' }), 'joined');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
