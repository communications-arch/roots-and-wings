// Guard test for the public-form content scorer (api/tour.js, 2026-08-15):
//   spamScore()          — pure additive scorer → { score, hits }
//   spamScoreScreen()    — reason string at/over SPAM_JUNK_THRESHOLD, else null
//   classifyScreenReason — free-text screen_reason → stats class
//   turnstileScreen      — MUST fail OPEN (null) when the env vars are unset
// The scorer is CONSERVATIVE by design: every legit sample below must
// score under the threshold (a false positive hides a real family's
// request), and every spam sample must reach it.
//
// Usage: node scripts/test-spam-score.js

delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;

const tour = require('../api/tour.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
const T = tour.SPAM_JUNK_THRESHOLD;

console.log('public-form content scorer (threshold ' + T + ')');

// ── Real families: every one of these must PASS ──
const LEGIT = [
  { name: 'Erin Brockovich-O\'Connor', email: 'erin.oconnor@gmail.com',
    message: 'Hi! We homeschool two kids (7 and 9) and would love to learn more about the co-op.' },
  { name: 'Maria de la Cruz', email: 'mdlc1985@yahoo.com',
    message: 'I came across your website and would love to schedule a tour. Do you have openings for fall? Our kids are 5 and 8.' },
  { name: 'Josh Miller', email: 'jmiller@millerfamilyfarm.com',
    message: 'Do you offer a free trial day before we commit? We are interested in the afternoon classes.' },
  { name: 'Priya Ramaswamy', email: 'info@ramaswamyfamily.com',
    message: 'Hello, we just moved to Fishers and are looking for a co-op community for our 4 year old. What does a typical Wednesday look like?' },
  { name: 'Katie', email: 'katie2020@outlook.com',
    message: 'Please unsubscribe me from the newsletter — we moved out of state. Thanks for everything!' },
  { name: 'Mary-Kate O\'Neil', email: 'mkoneil@aol.com',
    message: 'WE ARE SO EXCITED TO VISIT!! Our team of three kids can\'t wait. Can we come the first Wednesday of the session?' },
  { name: 'José Álvarez', email: 'jose.alvarez@gmail.com',
    message: 'Buenos días — we would like a tour for our niños, ages 6 and 10.' },
  { name: 'Sam Chen', email: 'sam.chen@familyname.xyz',
    message: 'I noticed your website mentions morning enrichment classes. Are those open to 3 year olds?' },
  { name: 'Ashley W', email: 'ashleyw@gmail.com', message: 'Interested in a tour.' },
  { name: 'Erin ', email: 'dsjfk@jdlkfj.com', message: '', ages: '4, 7, and 10' },
  { name: 'Dana Whitfield', email: 'dana.w@gmail.com', message: '', ages: 'toddler and a preschooler' },
  { name: 'Ben Ortiz', email: 'ben.ortiz@icloud.com', message: '', ages: 'six and eight' }
];
LEGIT.forEach(function (s, i) {
  t('legit #' + (i + 1) + ' passes (' + s.name.trim() + ')', function () {
    const r = tour.spamScore(s);
    assert(r.score < T, 'scored ' + r.score + ' [' + r.hits.join(', ') + ']');
    assert(tour.spamScoreScreen(s) === null, 'screen should be null');
  });
});

// ── Spam that clears the mechanical layers: every one must be JUNKED ──
const SPAM = [
  { name: 'David', email: 'david@seo-growth-agency.com',
    message: 'Hi, I came across your website and noticed it isn\'t ranking on Google. We offer affordable SEO services to increase your traffic. Would you be interested in a free audit?' },
  { name: 'Crypto Wealth', email: 'invest@wealthdaily.top',
    message: 'Earn 10% daily with our bitcoin investment plan. Limited time offer — reply now to secure your spot.' },
  { name: 'Emily Carter', email: 'emily.carter@contentpros.co',
    message: 'Hello Roots & Wings team, I hope this message finds you well. I\'m a content specialist and I\'d love to contribute a guest post to your blog. Let me know if you\'re interested.' },
  { name: 'Mike', email: 'mike@webdevstudio.site',
    message: 'We are a web design and development agency. Our team helps businesses like yours with a modern website. Book a call: https://example.com/book' },
  { name: 'Wxyz9384', email: 'wxyz9384@mail.ru', message: 'Hello, please contact me regarding your business listing and google reviews.' },
  { name: 'Anna', email: 'anna@promo-mailers.click',
    message: 'Great site! We can generate more leads for your co-op with email marketing. Free trial available. To stop receiving these, reply STOP.' },
  { name: 'John', email: 'john@example.com',
    message: '<a href="https://spam.example">Click here</a> for cheap viagra and pharmacy deals — special offer!' },
  { name: 'Ptr Wlmsn', email: 'a7b3k9x2q@mail.ru',
    message: '', ages: 'lorem ipsum dolor sit' }
];
SPAM.forEach(function (s, i) {
  t('spam #' + (i + 1) + ' is junked (' + s.name + ')', function () {
    const r = tour.spamScore(s);
    assert(r.score >= T, 'scored only ' + r.score + ' [' + r.hits.join(', ') + ']');
    const reason = tour.spamScoreScreen(s);
    assert(typeof reason === 'string' && /^content score \d+ \(/.test(reason), 'reason shape: ' + reason);
    assert(reason.indexOf(s.message.slice(0, 20)) === -1 || !s.message, 'reason must not echo visitor text');
  });
});

t('empty / missing fields score 0', function () {
  assert(tour.spamScore({}).score === 0);
  assert(tour.spamScore({ name: '', email: '', message: '' }).score === 0);
});

// ── classifyScreenReason ──
t('classifyScreenReason buckets every layer', function () {
  const c = tour.classifyScreenReason;
  assert(c('turnstile failed (invalid-input-response)') === 'turnstile');
  assert(c('turnstile: no token from browser') === 'turnstile');
  assert(c('honeypot filled') === 'honeypot');
  assert(c('rate limited (4 in 10 min from this IP)') === 'rate');
  assert(c('form_ts reused') === 'replay');
  assert(c('form_token reused') === 'replay');
  assert(c('content score 7 (pitch, opener)') === 'content');
  assert(c('gibberish name (no vowels)') === 'content');
  assert(c('link-stuffed message') === 'content');
  assert(c('disposable email domain (mailinator.com)') === 'content');
  assert(c('duplicate message (same text from 2 other emails in 7 days)') === 'content');
  assert(c('missing form_token (direct API post)') === 'timing');
  assert(c('submitted 1200ms after token issue') === 'timing');
  assert(c('stale form_ts (400 min old)') === 'timing');
  assert(c('') === 'none');
  assert(c('something new') === 'other');
});

// ── Turnstile fails OPEN without config ──
t('turnstileEnabled() is false with no env vars', function () {
  assert(tour.turnstileEnabled() === false);
});
t('turnstileEnabled() stays false when only ONE key is set (half-config)', function () {
  process.env.TURNSTILE_SITE_KEY = 'x';
  assert(tour.turnstileEnabled() === false);
  delete process.env.TURNSTILE_SITE_KEY;
});
// Async: with no env vars the screen must resolve null (skip) even when
// the browser sent no token at all — that is the fail-open contract.
tour.turnstileScreen('', '1.2.3.4', 'contact').then(function (r) {
  if (r !== null) { console.log('  ✗ turnstileScreen should fail open (got ' + JSON.stringify(r) + ')'); failed++; }
  else { console.log('  ✓ turnstileScreen fails open (null) when unconfigured, even with no token'); passed++; }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
