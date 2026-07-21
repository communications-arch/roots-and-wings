// Unit tests for the #45 inquiry anti-spam screens (api/tour.js):
//   botScreen()            — legacy screen kept as-is for the tour form
//   inquiryTimingScreen()  — tightened Contact-Us fill-time / staleness
//   inquiryContentScreen() — content heuristics (URLs in name, gibberish,
//                            disposable inboxes, all-link bodies)
// All three are pure — no DB, no env.
//
// Usage: node scripts/test-inquiry-screen.js

const tour = require('../api/tour.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

console.log('inquiry anti-spam screens (#45)');

// ── inquiryTimingScreen ──
const NOW = 1750000000000;
t('timing: missing stamp is screened', function () {
  assert(tour.inquiryTimingScreen(undefined, NOW) !== null, 'undefined should trip');
  assert(tour.inquiryTimingScreen('', NOW) !== null, 'empty should trip');
  assert(tour.inquiryTimingScreen(0, NOW) !== null, 'zero should trip');
  assert(tour.inquiryTimingScreen('garbage', NOW) !== null, 'NaN should trip');
});
t('timing: sub-8s fill is screened (was 4s)', function () {
  assert(tour.inquiryTimingScreen(NOW - 3000, NOW) !== null, '3s should trip');
  assert(tour.inquiryTimingScreen(NOW - 7999, NOW) !== null, '7.999s should trip');
});
t('timing: plausible human fill passes', function () {
  assert(tour.inquiryTimingScreen(NOW - 8001, NOW) === null, '8s should pass');
  assert(tour.inquiryTimingScreen(NOW - 20 * 60 * 1000, NOW) === null, '20 min should pass');
});
t('timing: stale stamp (>3h) is screened (was 24h)', function () {
  assert(tour.inquiryTimingScreen(NOW - 3 * 3600 * 1000 - 1, NOW) !== null, '>3h should trip');
  assert(tour.inquiryTimingScreen(NOW - 2 * 3600 * 1000, NOW) === null, '2h should pass');
});
t('timing: future stamp is screened', function () {
  assert(tour.inquiryTimingScreen(NOW + 60000, NOW) !== null, 'future should trip');
});

// ── inquiryContentScreen ──
t('content: clean real-family submission passes', function () {
  assert(tour.inquiryContentScreen({
    name: 'Erin Brockovich-O\'Connor',
    email: 'erin@example.com',
    message: 'Hi! We homeschool two kids (7 and 9) and would love to learn more about the co-op.'
  }) === null, 'clean submission should pass');
});
t('content: URL in name is screened', function () {
  assert(tour.inquiryContentScreen({ name: 'https://spam.example', email: 'a@b.co', message: 'hi' }) !== null);
  assert(tour.inquiryContentScreen({ name: 'Buy www.pills.example now', email: 'a@b.co', message: 'hi' }) !== null);
});
t('content: gibberish names are screened, real tricky names pass', function () {
  assert(tour.inquiryContentScreen({ name: 'XKJFDQPWZ Bot', email: 'a@b.co', message: 'hi' }) !== null, 'no-vowel run should trip');
  assert(tour.inquiryContentScreen({ name: 'qwrtpsdfghjklzx', email: 'a@b.co', message: 'hi' }) !== null, 'consonant run should trip');
  assert(tour.inquiryContentScreen({ name: 'Krzysztof Szymczyk', email: 'a@b.co', message: 'hi' }) === null, 'y-vowel Polish name should pass');
  assert(tour.inquiryContentScreen({ name: 'Schmidt', email: 'a@b.co', message: 'hi' }) === null, 'Schmidt should pass');
});
t('content: disposable email domains are screened', function () {
  assert(tour.inquiryContentScreen({ name: 'Real Name', email: 'bot@mailinator.com', message: 'hi' }) !== null);
  assert(tour.inquiryContentScreen({ name: 'Real Name', email: 'bot@sub.yopmail.com', message: 'hi' }) !== null, 'subdomain should trip');
  assert(tour.inquiryContentScreen({ name: 'Real Name', email: 'family@gmail.com', message: 'hi' }) === null, 'gmail should pass');
});
t('content: link-stuffed and all-link bodies are screened', function () {
  assert(tour.inquiryContentScreen({ name: 'A B', email: 'a@b.co', message: 'http://x.example http://y.example http://z.example' }) !== null, '3 links should trip');
  assert(tour.inquiryContentScreen({ name: 'A B', email: 'a@b.co', message: 'https://only-a-link.example/promo' }) !== null, 'all-link body should trip');
  assert(tour.inquiryContentScreen({ name: 'A B', email: 'a@b.co', message: 'Our family blog is https://example.com/family — we have two kids and love nature study.' }) === null, 'one link with real text should pass');
});
t('content: empty message passes (message is optional)', function () {
  assert(tour.inquiryContentScreen({ name: 'A Family', email: 'a@b.co', message: '' }) === null);
});

// ── botScreen (tour form — unchanged behavior) ──
t('botScreen: honeypot trips, 4s dwell still the tour threshold', function () {
  assert(tour.botScreen({ website: 'x', form_ts: Date.now() - 60000 }) !== null, 'honeypot should trip');
  assert(tour.botScreen({ website: '', form_ts: Date.now() - 3000 }) !== null, 'sub-4s should trip');
  assert(tour.botScreen({ website: '', form_ts: Date.now() - 5000, name: 'A', message: '' }) === null, '5s should pass (tour form unchanged)');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
