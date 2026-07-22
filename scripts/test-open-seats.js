// Unit tests for the open-committee-seats helpers (#39/#40):
//   collectOpenSeats()      — pure fold over ROLES_DIRECTORY picking the
//                             volunteer-claimable seats with no holder
//   openSeatsListHtml(open) — the modal list body (seat title opens the
//                             role popup; "I'm interested" toggle state)
//
// Same extraction approach as test-helpers.js (script.js is a browser
// IIFE): grep the functions out and re-hydrate with stub deps.
//
// Usage: node scripts/test-open-seats.js

const fs = require('fs');
const path = require('path');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'assert') + ': expected ' + e + ', got ' + a);
}

const src = fs.readFileSync(SCRIPT_JS, 'utf8');
function extractFn(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract function ' + fnName);
  return m[0];
}

// Stub deps + hydrate. escapeHtml/escapeAttr mirror the real ones closely
// enough for assertion purposes.
const harness = new Function('ROLES_DIRECTORY', '_roleInterest', `
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escapeAttr(s) { return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  ${extractFn('collectOpenSeats')}
  ${extractFn('roleDirById')}
  ${extractFn('seatReportingChain')}
  ${extractFn('openSeatsListHtml')}
  return { collectOpenSeats: collectOpenSeats, openSeatsListHtml: openSeatsListHtml, seatReportingChain: seatReportingChain };
`);

const DIR = [
  { id: 1, category: 'committee_role', committee: 'Facilities', title: 'Open Seat A', term_length: 'Year', holders: [], parent_role_id: 3 },
  { id: 2, category: 'committee_role', committee: 'Comms', title: 'Held Seat', term_length: 'Year', holders: [{ name: 'X', email: 'x@rootsandwingsindy.com' }] },
  { id: 3, category: 'board', committee: 'Board', title: 'President', term_length: '2 years', holders: [] },
  { id: 4, category: 'committee_role', committee: '', title: 'Committee-less pseudo role', term_length: 'Year', holders: [] },
  { id: 5, category: 'committee_role', committee: 'Classes', title: 'Classroom Helper', term_length: '1 Session', holders: [] },
  { id: 6, category: 'committee_role', committee: 'Events', title: 'Open Seat B', term_length: '', holders: [] }
];

console.log('open-committee-seats helpers (#39/#40)');

t('collectOpenSeats keeps only holderless committee roles with a committee', () => {
  const { collectOpenSeats } = harness(DIR, null);
  assertEq(collectOpenSeats().map(o => o.id), [1, 6]);
});

t('collectOpenSeats skips 1-session (per-session classroom) roles', () => {
  const { collectOpenSeats } = harness(DIR, null);
  assert(collectOpenSeats().every(o => o.id !== 5), '1 Session role leaked in');
});

t('collectOpenSeats carries id + committee + title for the modal', () => {
  const { collectOpenSeats } = harness(DIR, null);
  assertEq(collectOpenSeats()[0], { id: 1, committee: 'Facilities', title: 'Open Seat A' });
});

t('openSeatsListHtml claims via vp@ (not membership@) — #39 pt 1', () => {
  const h = harness(DIR, null);
  const html = h.openSeatsListHtml(h.collectOpenSeats());
  assert(html.indexOf('vp@rootsandwingsindy.com') !== -1, 'vp@ missing');
  assert(html.indexOf('membership@rootsandwingsindy.com') === -1, 'membership@ still present');
});

t('openSeatsListHtml: every seat expands its description inline — #39 pt 2 / #74', () => {
  const h = harness(DIR, null);
  const html = h.openSeatsListHtml(h.collectOpenSeats());
  // #74: the title toggles an INLINE description (data-resource-action=
  // "open-seat-desc" + a hidden .ws-opp-desc box per seat) — the old
  // popup replaced the modal and stranded the viewer.
  const count = (html.match(/data-resource-action="open-seat-desc"/g) || []).length;
  assertEq(count, 2);
  const boxes = (html.match(/class="ws-opp-desc"/g) || []).length;
  assertEq(boxes, 2);
  assert(html.indexOf('data-role-title="Open Seat A"') !== -1, 'seat A title attr missing');
});

t('openSeatsListHtml: interest buttons reflect my own state — #39 pt 3', () => {
  const h = harness(DIR, { mine: { 1: true } });
  const html = h.openSeatsListHtml(h.collectOpenSeats());
  assert(html.indexOf('ws-opp-interested" data-resource-action="role-interest-toggle" data-role-id="1"') !== -1, 'seat 1 not marked interested');
  assert(html.indexOf('✓ Interested') !== -1, 'no checked label');
  const plain = (html.match(/role-interest-toggle/g) || []).length;
  assertEq(plain, 2, 'one toggle per seat');
});

t('#79: reporting chain walks parents with holder names, cycle-guarded', () => {
  const CHAIN_DIR = [
    { id: 10, category: 'committee_role', committee: 'Communications Committee', title: 'Yearbook', term_length: 'Year', holders: [], parent_role_id: 11 },
    { id: 11, category: 'committee_role', committee: 'Communications Committee', title: 'Energy Branch', term_length: '', holders: [], parent_role_id: 12 },
    { id: 12, category: 'board', committee: 'Board', title: 'Communications Director', term_length: '2 years', holders: [{ name: 'Cam C', email: 'c@x' }], parent_role_id: 12 }
  ];
  const h = harness(CHAIN_DIR, null);
  assertEq(h.seatReportingChain(10), ['Energy Branch', 'Communications Director (Cam C)']);
  // self-referencing parent must not loop or emit duplicates
  assertEq(h.seatReportingChain(12), []);
});

t('#79: seat line carries "under …" chain + interested names', () => {
  const h = harness(DIR, { mine: {}, byRole: { 1: ['Poppy Sun', 'Jody Smith'] } });
  const html = h.openSeatsListHtml(h.collectOpenSeats());
  assert(html.indexOf('under President') !== -1, 'chain missing from seat 1 (parent President)');
  assert(html.indexOf('Interested so far: Poppy Sun, Jody Smith') !== -1, 'raised hands missing');
});

t('openSeatsListHtml escapes titles', () => {
  const h = harness([{ id: 9, category: 'committee_role', committee: 'C<o>', title: 'A & B <chair>', term_length: '', holders: [] }], null);
  const html = h.openSeatsListHtml(h.collectOpenSeats());
  assert(html.indexOf('A &amp; B &lt;chair&gt;') !== -1, 'title not escaped');
  assert(html.indexOf('<chair>') === -1, 'raw title leaked');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
