// #207 signed form tokens — issue/parse/screen round-trips.
// Pure helpers from api/tour.js; no DB or network.
process.env.FORM_TOKEN_SECRET = 'test-secret-abc';

const { issueFormToken, parseFormToken, formTokenScreen } = require('../api/tour.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++; console.log('  ✓ ' + name);
  } catch (e) {
    failed++; console.error('  ✗ ' + name + ' — ' + e.message);
  }
}
function eq(got, want, label) {
  if (got !== want) throw new Error((label || 'value') + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

const MIN = 8000, MAX = 3 * 3600 * 1000;

t('round-trip: parse recovers the issued ts', () => {
  const now = 1750000000000;
  eq(parseFormToken(issueFormToken(now)), now);
});

t('tampered ts fails the signature', () => {
  const tok = issueFormToken(1750000000000);
  const forged = '1750000000001.' + tok.split('.')[1];
  eq(parseFormToken(forged), null);
});

t('tampered signature fails', () => {
  const tok = issueFormToken(1750000000000);
  const parts = tok.split('.');
  const flipped = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');
  eq(parseFormToken(parts[0] + '.' + flipped), null);
});

t('garbage shapes parse to null', () => {
  eq(parseFormToken(''), null);
  eq(parseFormToken('abc'), null);
  eq(parseFormToken('12345.short'), null);
  eq(parseFormToken(null), null);
  eq(parseFormToken(1750000000000), null);
});

t('secret change invalidates old tokens', () => {
  const tok = issueFormToken(1750000000000);
  process.env.FORM_TOKEN_SECRET = 'rotated';
  eq(parseFormToken(tok), null);
  process.env.FORM_TOKEN_SECRET = 'test-secret-abc';
  eq(parseFormToken(tok), 1750000000000);
});

t('screen: missing token', () => {
  eq(formTokenScreen('', MIN, MAX), 'missing form_token (direct API post)');
  eq(formTokenScreen(undefined, MIN, MAX), 'missing form_token (direct API post)');
});

t('screen: invalid signature named as such', () => {
  eq(formTokenScreen('1750000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', MIN, MAX), 'invalid form_token signature');
});

t('screen: too-fast submit trips the fill window', () => {
  const now = 1750000000000;
  const r = formTokenScreen(issueFormToken(now), MIN, MAX, now + 500);
  eq(/^submitted 500ms after token issue$/.test(String(r)), true, 'reason shape');
});

t('screen: plausible fill time passes', () => {
  const now = 1750000000000;
  eq(formTokenScreen(issueFormToken(now), MIN, MAX, now + 45000), null);
});

t('screen: stale token trips', () => {
  const now = 1750000000000;
  const r = formTokenScreen(issueFormToken(now), MIN, MAX, now + MAX + 60000);
  eq(/^stale form_token/.test(String(r)), true, 'reason shape');
});

t('screen: future token trips', () => {
  const now = 1750000000000;
  eq(formTokenScreen(issueFormToken(now + 60000), MIN, MAX, now), 'future form_token');
});

t('screen: tour windows (4s / 24h) behave', () => {
  const now = 1750000000000;
  const DAY = 24 * 3600 * 1000;
  eq(formTokenScreen(issueFormToken(now), 4000, DAY, now + 5000), null);
  eq(/^submitted /.test(String(formTokenScreen(issueFormToken(now), 4000, DAY, now + 3000))), true);
  eq(/^stale /.test(String(formTokenScreen(issueFormToken(now), 4000, DAY, now + DAY + 1000))), true);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
