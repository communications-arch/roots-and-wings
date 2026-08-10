// Regression guard for #279/#280 (Colleen, 2026-08-10): afternoon class
// sign-up rank dropdowns.
//
//  #279 — PM Hour 2 sometimes offered only "2" and never "1".
//  #280 — the lone "2" collapsed to choice 1 when the picker was closed.
//
// Root cause: a 2-hour ('both') class ranked under PM Hour 1 "reserved" its
// choice number in PM Hour 2 by HIDING that option from the dropdown. But
// picks are stored as array position (rank = index), and the both-class is
// never in the PM2 array (the server models it as PM1-only, filling PM2 at
// lottery) — so hiding "1" left a lone "2" that rankedIdsFrom() collapsed
// back to rank 1. The fix makes PM Hour 2 rank independently: always offer
// 1..N regardless of any pinned 2-hour class.
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
const PINNED_BOTH = [{ name: 'Epic Play', rank: 1 }];

console.log('  afternoon sign-up rank dropdowns (#279/#280)');

t('#279: PM Hour 2 offers BOTH choice 1 and choice 2 even when a 2-hour class is pinned at rank 1', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, PINNED_BOTH);
  // Two PM2 classes → two rank selects; each must offer 1 AND 2.
  assert(optionCount(html, 1) === 2, 'expected two "1" options (one per class), got ' + optionCount(html, 1));
  assert(optionCount(html, 2) === 2, 'expected two "2" options (one per class), got ' + optionCount(html, 2));
});

t('#279: choice 1 is offered with NO pinned 2-hour class too (baseline)', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, []);
  assert(optionCount(html, 1) === 2, 'expected choice 1 offered');
  assert(optionCount(html, 2) === 2, 'expected choice 2 offered');
});

t('#280: a class picked at rank 2 in PM2 round-trips as rank 2, not collapsed to 1', function () {
  // The bug was the dropdown hiding "1", so the only pick was "2" and it
  // collapsed. With independent ranking a real rank-1 pick can coexist, so
  // rankedIdsFrom keeps a 1-then-2 ordering intact.
  const api = makeApi({});
  // Simulate a saved map where Art is 1st choice and Clay is 2nd.
  const ordered = api.rankedIdsFrom({ 40: 1, 41: 2 });
  assert(JSON.stringify(ordered) === JSON.stringify([40, 41]), 'expected [40,41], got ' + JSON.stringify(ordered));
});

t('the pinned 2-hour note reassures without claiming to reserve a choice number', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, PINNED_BOTH);
  assert(/covers PM Hour 2/.test(html), 'expected reassurance text about covering PM Hour 2');
  assert(!/also your choice/.test(html), 'the old reservation wording must be gone');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
