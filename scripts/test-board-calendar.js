// Unit tests for the Board Calendar pure helpers.
//   - validateBoardCalendarEvent / calDateStr (api/tour.js): payload
//     validation + Neon DATE → YYYY-MM-DD rendering.
//   - boardCalFmtDate / boardCalFmtRange (script.js): friendly date display.
// Functions are extracted from source (not required) so the test doesn't
// pull in the DB / Google libs — same approach as test-morning-builder.js.
//
// Usage: node scripts/test-board-calendar.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const ROOT = path.resolve(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const tourSrc = fs.readFileSync(path.join(ROOT, 'api', 'tour.js'), 'utf8');

function extractIndented(src, fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' (indented)');
  return m[0];
}
function extractTop(src, fnName) {
  const re = new RegExp('^function ' + fnName + '\\b[\\s\\S]*?^\\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' (top-level)');
  return m[0];
}

const server = new Function(
  extractTop(tourSrc, 'calDateStr') + '\n' +
  extractTop(tourSrc, 'validateBoardCalendarEvent') + '\n' +
  extractTop(tourSrc, 'calAddDays') + '\n' +
  extractTop(tourSrc, 'calSnapWed') + '\n' +
  extractTop(tourSrc, 'calSessionsForYear') + '\n' +
  extractTop(tourSrc, 'fieldDayForYear') + '\n' +
  extractTop(tourSrc, 'iceCreamSocialForYear') + '\n' +
  extractTop(tourSrc, 'computeDerivedCalendarEvents') + '\n' +
  'return { calDateStr, validateBoardCalendarEvent, calAddDays, calSnapWed,' +
  ' fieldDayForYear, iceCreamSocialForYear, computeDerivedCalendarEvents };'
)();

const client = new Function(
  extractIndented(scriptSrc, 'boardCalFmtDate') + '\n' +
  extractIndented(scriptSrc, 'boardCalFmtRange') + '\n' +
  'return { boardCalFmtDate, boardCalFmtRange };'
)();

const ok = (p) => server.validateBoardCalendarEvent(p);
const base = { school_year: '2026-2027', title: 'Registration opens', event_date: '2026-08-01' };

console.log('\nvalidateBoardCalendarEvent — valid payloads');
t('minimal valid event passes', () => assert.strictEqual(ok(base), ''));
t('valid event with end_date (window) passes', () =>
  assert.strictEqual(ok(Object.assign({}, base, { end_date: '2026-08-15' })), ''));
t('end_date equal to start passes', () =>
  assert.strictEqual(ok(Object.assign({}, base, { end_date: '2026-08-01' })), ''));
t('note within limit passes', () =>
  assert.strictEqual(ok(Object.assign({}, base, { note: 'x'.repeat(1000) })), ''));

console.log('\nvalidateBoardCalendarEvent — rejected payloads');
t('missing title rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { title: '   ' })), ''));
t('missing date rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { event_date: '' })), ''));
t('malformed date rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { event_date: '2026/08/01' })), ''));
t('end_date before start rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { end_date: '2026-07-01' })), ''));
t('malformed end_date rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { end_date: 'soon' })), ''));
t('bad school_year format rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { school_year: '2026' })), ''));
t('non-consecutive school_year rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { school_year: '2026-2028' })), ''));
t('over-long title rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { title: 'x'.repeat(201) })), ''));
t('over-long note rejected', () =>
  assert.notStrictEqual(ok(Object.assign({}, base, { note: 'x'.repeat(1001) })), ''));

console.log('\ncalDateStr');
t('null → empty string', () => assert.strictEqual(server.calDateStr(null), ''));
t('Date → YYYY-MM-DD', () =>
  assert.strictEqual(server.calDateStr(new Date('2026-08-01T00:00:00Z')), '2026-08-01'));
t('string passthrough sliced to 10', () =>
  assert.strictEqual(server.calDateStr('2026-08-01T00:00:00.000Z'), '2026-08-01'));

console.log('\nboardCalFmtDate / boardCalFmtRange');
t('formats a single date', () =>
  assert.strictEqual(client.boardCalFmtDate('2026-08-01'), 'Aug 1, 2026'));
t('empty date → empty string', () =>
  assert.strictEqual(client.boardCalFmtDate(''), ''));
t('range with end date uses en dash', () =>
  assert.strictEqual(client.boardCalFmtRange('2026-08-01', '2026-08-15'), 'Aug 1, 2026 – Aug 15, 2026'));
t('range without end date is just the start', () =>
  assert.strictEqual(client.boardCalFmtRange('2026-08-01', ''), 'Aug 1, 2026'));

console.log('\ncalAddDays / calSnapWed');
t('calAddDays adds days across month boundary', () =>
  assert.strictEqual(server.calAddDays('2026-05-13', 14), '2026-05-27'));
t('calAddDays subtracts days', () =>
  assert.strictEqual(server.calAddDays('2026-05-13', -28), '2026-04-15'));
const wd = (s) => new Date(s + 'T00:00:00Z').getUTCDay();
t('calSnapWed(+1) lands on a Wednesday strictly after', () => {
  const r = server.calSnapWed('2026-05-13', 1); // 2026-05-13 is a Wednesday
  assert.strictEqual(wd(r), 3);
  assert.ok(r > '2026-05-13', 'should be strictly after');
});
t('calSnapWed(-1) lands on a Wednesday strictly before', () => {
  const r = server.calSnapWed('2025-09-03', -1);
  assert.strictEqual(wd(r), 3);
  assert.ok(r < '2025-09-03', 'should be strictly before');
});

// Fixture mirrors the seeded 2025-2026 sessions in migrate.sql.
const SESSIONS = [
  { school_year: '2025-2026', session_number: 1, name: 'Fall Session 1',   start_date: '2025-09-03', end_date: '2025-10-01' },
  { school_year: '2025-2026', session_number: 2, name: 'Fall Session 2',   start_date: '2025-10-15', end_date: '2025-11-12' },
  { school_year: '2025-2026', session_number: 3, name: 'Winter Session 3', start_date: '2026-01-14', end_date: '2026-02-11' },
  { school_year: '2025-2026', session_number: 4, name: 'Spring Session 4', start_date: '2026-03-04', end_date: '2026-04-01' },
  { school_year: '2025-2026', session_number: 5, name: 'Spring Session 5', start_date: '2026-04-15', end_date: '2026-05-13' },
];

console.log('\nfieldDayForYear / iceCreamSocialForYear');
t('Field Day is a Wednesday after Session 5 end', () => {
  const fd = server.fieldDayForYear(SESSIONS, '2025-2026');
  assert.strictEqual(wd(fd), 3);
  assert.ok(fd > '2026-05-13');
});
t('Field Day empty when year has no sessions', () =>
  assert.strictEqual(server.fieldDayForYear(SESSIONS, '2030-2031'), ''));
t('Ice Cream Social is a Wednesday before Session 1 start', () => {
  const ics = server.iceCreamSocialForYear(SESSIONS, '2025-2026');
  assert.strictEqual(wd(ics), 3);
  assert.ok(ics < '2025-09-03');
});

console.log('\ncomputeDerivedCalendarEvents');
const derived = server.computeDerivedCalendarEvents(SESSIONS, '2025-2026');
const byKey = {};
derived.forEach(e => { byKey[e.id.split(':')[1]] = e; });
const fd = server.fieldDayForYear(SESSIONS, '2025-2026');
const ics = server.iceCreamSocialForYear(SESSIONS, '2025-2026');

t('all derived events are flagged derived + have a derived: id', () =>
  assert.ok(derived.length > 0 && derived.every(e => e.derived === true && /^derived:/.test(e.id))));
t('every derived event has a valid YYYY-MM-DD date', () =>
  assert.ok(derived.every(e => /^\d{4}-\d{2}-\d{2}$/.test(e.event_date))));
t('morning build is June 1 of the fall year', () =>
  assert.strictEqual(byKey.morning.event_date, '2025-06-01'));
t('public registration is Field Day − 14 days', () =>
  assert.strictEqual(byKey.regpublic.event_date, server.calAddDays(fd, -14)));
t('existing-member registration is Field Day − 28 days', () =>
  assert.strictEqual(byKey.regexisting.event_date, server.calAddDays(fd, -28)));
t('Field Day event matches fieldDayForYear', () =>
  assert.strictEqual(byKey.fieldday.event_date, fd));
t('confirm-role-holders is the day after Field Day', () =>
  assert.strictEqual(byKey.roleconfirm.event_date, server.calAddDays(fd, 1)));
t('participation-reset is the day after Field Day (matches the season flip)', () =>
  assert.strictEqual(byKey.participationreset.event_date, server.calAddDays(fd, 1)));
t('participation-reset title names the next school year', () =>
  assert.ok(/2026-2027/.test(byKey.participationreset.title)));
t('remove-members is 3 days before the Ice Cream Social', () =>
  assert.strictEqual(byKey.removemembers.event_date, server.calAddDays(ics, -3)));
t('ice cream social matches iceCreamSocialForYear', () =>
  assert.strictEqual(byKey.icecream.event_date, ics));
t('all five sessions are emitted', () =>
  assert.strictEqual(derived.filter(e => /^derived:session/.test(e.id)).length, 5));
t('set-next-year-dates is 14 days after the last session end', () =>
  assert.strictEqual(byKey.setdates.event_date, '2026-05-27'));
t('a year with no sessions still emits the June-1 morning prompt', () => {
  const d = server.computeDerivedCalendarEvents(SESSIONS, '2030-2031');
  assert.ok(d.some(e => /^derived:morning/.test(e.id)));
  assert.ok(!d.some(e => /^derived:fieldday/.test(e.id)), 'no Field Day without sessions');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
