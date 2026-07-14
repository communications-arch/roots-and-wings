// Unit tests for the registration-link invite funnel helpers (script.js).
//   regInviteStatus(inv): 'registered' | 'dismissed' | 'opened' | 'sent'
//     — registered wins over dismissed (if the family registered anyway,
//     that's the truth that matters), opened over plain sent.
//   regInviteAwaiting(inv): drives the "Awaiting Registration" To Do count
//     (sent or opened, i.e. not yet registered and not dismissed).
//   regInviteBucket(inv): filter-pill bucket — sent+opened collapse to
//     'waiting'.
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
const { regInviteStatus, regInviteAwaiting, regInviteBucket } = new Function(
  extract('regInviteStatus') + '\n' + extract('regInviteAwaiting') + '\n' +
  extract('regInviteBucket') + '\n' +
  'return { regInviteStatus, regInviteAwaiting, regInviteBucket };'
)();

console.log('Registration-link invite funnel');
t('freshly sent invite is status sent, bucket waiting, awaiting', () => {
  const inv = { last_sent_at: '2026-07-14T00:00:00Z' };
  assert.strictEqual(regInviteStatus(inv), 'sent');
  assert.strictEqual(regInviteBucket(inv), 'waiting');
  assert.strictEqual(regInviteAwaiting(inv), true);
});
t('opened but not registered is status opened, still waiting/awaiting', () => {
  const inv = { opened_at: '2026-07-15T00:00:00Z' };
  assert.strictEqual(regInviteStatus(inv), 'opened');
  assert.strictEqual(regInviteBucket(inv), 'waiting');
  assert.strictEqual(regInviteAwaiting(inv), true);
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
