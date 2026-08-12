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
// #297 added the grove filter — signupHourHtml now calls signupClassPassesGrove
// (which reads _signupGroveSel) and groupTagHtml, so both ride along here.
const factory = new Function(
  'escapeHtml', 'signupAgeText', 'fitsKid', 'brandIconImg', '_signup', 'groupTagHtml', '_signupGroveSel',
  extractFn('signupClassPassesGrove') + '\n' +
  extractFn('signupRequestsHtml') + '\n' +
  extractFn('afternoonCardBody') + '\n' +
  extractFn('signupHourHtml') + '\n' +
  extractFn('rankedIdsFrom') + '\n' +
  'return { signupHourHtml: signupHourHtml, rankedIdsFrom: rankedIdsFrom, signupRequestsHtml: signupRequestsHtml };'
);

// Count <option value="N"> occurrences in the rendered HTML.
function optionCount(html, val) {
  const re = new RegExp('<option value="' + val + '"', 'g');
  return (html.match(re) || []).length;
}

// A kid with an empty PM2 map, so the rank dropdowns render fresh.
function makeApi(pm2Map, groveSel) {
  const _signup = { working: { Kid: { PM1: {}, PM2: pm2Map || {} } }, workingAssist: {}, workingNotes: {} };
  return factory(
    function (s) { return String(s == null ? '' : s); },   // escapeHtml
    function () { return ''; },                              // signupAgeText
    function () { return null; },                            // fitsKid (unknown)
    function () { return ''; },                              // brandIconImg
    _signup,
    function () { return ''; },                              // groupTagHtml
    groveSel || []                                           // _signupGroveSel
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

t('#281/#301: a REQUIRED 2-hour class reads "(mandatory)"; an OPTIONAL one reads "(optional)"', function () {
  const api = makeApi({});
  const required = api.signupHourHtml('Kid', 'PM1', [{ id: 30, name: 'Epic Play', hour: 'both' }], true, null, false, [], undefined);
  assert(/2-hour class \(mandatory\)/.test(required), 'required-both must be labeled "(mandatory)"');
  assert(!/\(optional\)/.test(required), 'required-both must not read "(optional)"');
  const optional = api.signupHourHtml('Kid', 'PM1', [{ id: 30, name: 'Open Studio', hour: 'both', bothOptional: true }], true, null, false, [], undefined);
  assert(/2-hour class \(optional\)/.test(optional), 'optional-both must be labeled "(optional)"');
  assert(/signup-2hr-optional/.test(optional), 'optional-both must carry the .signup-2hr-optional modifier');
});

t('prominence: the PM Hour 2 pinned banner explains the single choice number and fronts the badge', function () {
  const api = makeApi({});
  const html = api.signupHourHtml('Kid', 'PM2', PM2_CLASSES, true, null, false, PINNED_BOTH, { 1: true });
  assert(/signup-2hr-tag/.test(html), 'the pinned banner should front the 2-hour badge');
  assert(/both/.test(html) && /backup/.test(html), 'the banner should explain both-hours + remaining backup');
});

// ── #297: grove filter narrows the shown cards, but never hides a ranked pick ──
const GROVE_CLASSES = [
  { id: 50, name: 'Pottery', hour: 'PM2', ageGroups: ['willows'] },
  { id: 51, name: 'Chess', hour: 'PM2', ageGroups: ['sassafras'] },
  { id: 52, name: 'Open Gym', hour: 'PM2', ageGroups: [] } // open to all
];
t('#297: no grove selected → every class card shows', function () {
  const api = makeApi({}, []);
  const html = api.signupHourHtml('Kid', 'PM2', GROVE_CLASSES, true, null, false, [], undefined);
  assert(/Pottery/.test(html) && /Chess/.test(html) && /Open Gym/.test(html), 'all classes show with no filter');
});
t('#297: selecting a grove shows only its classes (+ open-to-all)', function () {
  const api = makeApi({}, ['willows']);
  const html = api.signupHourHtml('Kid', 'PM2', GROVE_CLASSES, true, null, false, [], undefined);
  assert(/Pottery/.test(html), 'Willows class shows');
  assert(!/Chess/.test(html), 'a non-Willows class is filtered out');
  assert(/Open Gym/.test(html), 'a class open to all ages always shows');
});
t('#297: a filtered-out class stays visible if it is already ranked', function () {
  const api = makeApi({}, ['willows']); // filter to Willows, but Chess (sassafras) is ranked
  const html = api.signupHourHtml('Kid', 'PM2', [
    { id: 60, name: 'Pottery', hour: 'PM2', ageGroups: ['willows'] },
    { id: 61, name: 'Chess', hour: 'PM2', ageGroups: ['sassafras'] }
  ], true, null, false, [], undefined);
  // With no ranked pick, Chess would be hidden — but PM2 map is empty here, so
  // it IS hidden; assert the filter is actually active.
  assert(!/Chess/.test(html), 'baseline: Chess is filtered out when not ranked');
  const api2 = makeApi({ 61: 1 }, ['willows']); // rank Chess #1
  const html2 = api2.signupHourHtml('Kid', 'PM2', [
    { id: 60, name: 'Pottery', hour: 'PM2', ageGroups: ['willows'] },
    { id: 61, name: 'Chess', hour: 'PM2', ageGroups: ['sassafras'] }
  ], true, null, false, [], undefined);
  assert(/Chess/.test(html2), 'a ranked class stays visible even when its grove is filtered out');
});

// ── #297: shared "kids signed up so far" block (both afternoon surfaces) ──
t('#297: signupRequestsHtml splits first choice from backup, tags assistants', function () {
  const api = makeApi({});
  const html = api.signupRequestsHtml(
    [{ name: 'Ava', rank: 1 }, { name: 'Ben', rank: 1, assistant: true }, { name: 'Cara', rank: 2 }], 12);
  assert(/Kids requests \(3 of 12\)/.test(html), 'one-line label with count-of-max, got ' + html);
  assert(/First choice:<\/span> Ava, Ben \(assistant\)/.test(html), 'first choices listed, assistant tagged');
  assert(/Backup:<\/span> Cara/.test(html), 'backups listed separately');
});
t('#297: signupRequestsHtml empty → bare "Kids requests" label, no count when max 0', function () {
  const api = makeApi({});
  const html = api.signupRequestsHtml([], 0);
  assert(/Kids requests/.test(html), 'label present');
  assert(!/\(/.test(html), 'no count/max parens when empty and max 0');
});

// ── #291: coverage duties must not occupy an hour for volunteer sign-up ──
const mfDutyOccupiesBlock = new Function(extractFn('mfDutyOccupiesBlock') + '\n return mfDutyOccupiesBlock;')();

console.log('\n  coverage vs volunteer-slot occupancy (#291)');

t('#291: a COVERAGE duty (isCoverage) does NOT occupy its hour — the picker stays available', function () {
  assert(mfDutyOccupiesBlock({ block: 'PM2', isCoverage: true }, 'PM2') === false, 'PM2 coverage must not occupy PM2');
  assert(mfDutyOccupiesBlock({ block: 'AM', isCoverage: true }, 'AM1') === false, 'AM coverage must not occupy AM1');
});

t('#291: a real classroom/support duty DOES occupy its hour', function () {
  assert(mfDutyOccupiesBlock({ block: 'PM2' }, 'PM2') === true, 'a non-coverage PM2 duty occupies PM2');
  assert(mfDutyOccupiesBlock({ block: 'PM2' }, 'PM1') === false, 'a PM2 duty does not occupy PM1');
});

t('#291: a legacy whole-morning "AM" duty occupies BOTH morning twins', function () {
  assert(mfDutyOccupiesBlock({ block: 'AM' }, 'AM1') === true, 'AM occupies AM1');
  assert(mfDutyOccupiesBlock({ block: 'AM' }, 'AM2') === true, 'AM occupies AM2');
  assert(mfDutyOccupiesBlock({ block: 'AM' }, 'PM1') === false, 'AM does not occupy PM1');
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
