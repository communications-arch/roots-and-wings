// Regression guard for the afternoon class sign-up rank dropdowns and the
// 2-hour ('both') class reservation (Erin, 2026-07-15; prominence pass
// 2026-08-10 after #279/#280).
//
// Design: a 2-hour class is ranked under PM Hour 1 and — because it runs
// both hours — RESERVES the same choice number in PM Hour 2, so that hour's
// dropdowns offer only the other slot. #279/#280 (Colleen) turned out to be
// user error: she hadn't noticed her pick was a 2-hour class. So the
// reservation stays; what changed is that 2-hour classes now wear a loud
// badge (.signup-2hr-tag) and a tinted card (.signup-class-2hr) so nobody
// misses them, and the PM Hour 2 pinned banner spells out the "one choice
// number" reason.
//
// These tests lock in BOTH the reservation (so a future refactor can't
// silently drop it) and the prominence (so the badge can't quietly vanish).
//
// Same extraction approach as test-schedules-byclass.js (script.js is a
// browser IIFE): grep the function out and re-hydrate with light stubs.
//
// Usage: node scripts/test-signup-ranks.js

const fs = require('fs');
const path = require('path');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

function extractFn(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract function ' + fnName);
  return m[0];
}

// signupHourHtml + rankedIdsFrom, with the closure deps it touches stubbed.
const factory = new Function(
  'escapeHtml', 'signupAgeText', 'fitsKid', 'brandIconImg', '_signup',
  extractFn('signupHourHtml') + '\n' +
  extractFn('rankedIdsFrom') + '\n' +
  'return { signupHourHtml: signupHourHtml, rankedIdsFrom: rankedIdsFrom };'
);

// Count <option value="N"> occurrences in the rendered HTML.
function optionCount(html, val) {
  const re = new RegExp('<option value="' + val + '"', 'g');
  return (html.match(re) || []).length;
}

// A kid with an empty PM2 map, so the rank dropdowns render fresh.
function makeApi(pm2Map) {
  const _signup = { working: { Kid: { PM1: {}, PM2: pm2Map || {} } }, workingAssist: {}, workingNotes: {} };
  return factory(
    function (s) { return String(s == null ? '' : s); },   // escapeHtml
    function () { return ''; },                              // signupAgeText
    function () { return null; },                            // fitsKid (unknown)
    function () { return ''; },                              // brandIconImg
    _signup
  );
}

const PM2_CLASSES = [
  { id: 40, name: 'Art', hour: 'PM2' },
  { id: 41, name: 'Clay', hour: 'PM2' },
];
const PM1_WITH_BOTH = [
  { id: 30, name: 'Epic Play', hour: 'both' },
  { id: 31, name: 'Woodworking', hour: 'PM1' },
];
const PINNED_BOTH = [{ name: 'Epic Play', rank: 1 }];

console.log('  afternoon sign-up rank dropdowns + 2-hour reservation');

t('reservation: a 2-hour class pinned at rank 1 hides choice "1" in PM Hour 2 (offers only "2")', function () {
  const api = makeApi({});
  // excludeRanks {1:true} = choice 1 is claimed by the 2-hour class.
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, PINNED_BOTH, { 1: true });
  assert(optionCount(html, 1) === 0, 'choice 1 must be reserved (hidden), got ' + optionCount(html, 1));
  assert(optionCount(html, 2) === 2, 'choice 2 must be offered on both classes, got ' + optionCount(html, 2));
});

t('reservation: a 2-hour class pinned at rank 2 hides choice "2" instead', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, [{ name: 'Epic Play', rank: 2 }], { 2: true });
  assert(optionCount(html, 2) === 0, 'choice 2 must be reserved, got ' + optionCount(html, 2));
  assert(optionCount(html, 1) === 2, 'choice 1 must be offered, got ' + optionCount(html, 1));
});

t('no 2-hour class: PM Hour 2 offers choice 1 and 2 freely (baseline)', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, [], undefined);
  assert(optionCount(html, 1) === 2, 'expected choice 1 offered');
  assert(optionCount(html, 2) === 2, 'expected choice 2 offered');
});

t('prominence: a 2-hour class in the PM1 list wears the loud badge + tinted card', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM1', PM1_WITH_BOTH, true, null, false, [], undefined);
  assert(/signup-2hr-tag/.test(html), 'the 2-hour class must carry the .signup-2hr-tag badge');
  assert(/signup-class-2hr/.test(html), 'the 2-hour class card must carry the .signup-class-2hr tint');
  // The plain PM1 class must NOT get the badge.
  const plainOnly = api.signupHourHtml('Kid', 'PM1', [{ id: 31, name: 'Woodworking', hour: 'PM1' }], true, null, false, [], undefined);
  assert(!/signup-2hr-tag/.test(plainOnly), 'a 1-hour class must not wear the 2-hour badge');
});

t('#281: a REQUIRED 2-hour class reads "both hours required"; an OPTIONAL one reads "one or both hours"', function () {
  const api = makeApi({});
  const required = api.signupHourHtml('Kid', 'PM1', [{ id: 30, name: 'Epic Play', hour: 'both' }], true, null, false, [], undefined);
  assert(/both hours required/.test(required), 'required-both must be labeled "both hours required"');
  assert(!/one or both/.test(required), 'required-both must not read "one or both"');
  const optional = api.signupHourHtml('Kid', 'PM1', [{ id: 30, name: 'Open Studio', hour: 'both', bothOptional: true }], true, null, false, [], undefined);
  assert(/one or both hours/.test(optional), 'optional-both must be labeled "one or both hours"');
  assert(/signup-2hr-optional/.test(optional), 'optional-both must carry the .signup-2hr-optional modifier');
});

t('prominence: the PM Hour 2 pinned banner explains the single choice number and fronts the badge', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, PINNED_BOTH, { 1: true });
  assert(/signup-2hr-tag/.test(html), 'the pinned banner should front the 2-hour badge');
  assert(/both/.test(html) && /backup/.test(html), 'the banner should explain both-hours + remaining backup');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
