// #206 ICS feed — pure-helper checks (no Google, no DB).
process.env.ICS_FEED_KEY = 'test-ics-key';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}';

const { icsFromEvents, icsEscape, icsFeedKey, icsKeyOk } = require('../api/calendar.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ' — ' + e.message); }
}
function ok(cond, label) { if (!cond) throw new Error(label || 'assertion failed'); }

t('feed key is stable and non-trivial', () => {
  const k = icsFeedKey();
  ok(k === icsFeedKey(), 'stable');
  ok(k.length === 32, 'length 32, got ' + k.length);
  ok(/^[A-Za-z0-9_-]+$/.test(k), 'url-safe');
});

t('key check accepts the real key, rejects others', () => {
  ok(icsKeyOk(icsFeedKey()) === true, 'real key');
  ok(icsKeyOk('') === false, 'empty');
  ok(icsKeyOk(icsFeedKey().slice(0, -1) + '!') === false, 'tampered');
  ok(icsKeyOk(null) === false, 'null');
});

t('escaping: commas, semicolons, newlines, backslashes', () => {
  ok(icsEscape('a,b;c\nd\\e') === 'a\\,b\\;c\\nd\\\\e', icsEscape('a,b;c\nd\\e'));
});

const SAMPLE = [
  { id: 'evt1', summary: 'Co-op Day', start: { date: '2026-09-16' }, end: { date: '2026-09-17' } },
  { id: 'evt2', summary: 'Board Meeting, MPR; bring notes', location: 'First Mennonite Church',
    description: 'Agenda:\nLine two',
    start: { dateTime: '2026-09-18T18:00:00-04:00' }, end: { dateTime: '2026-09-18T19:30:00-04:00' } }
];

t('all-day event renders VALUE=DATE with exclusive end', () => {
  const ics = icsFromEvents(SAMPLE);
  ok(ics.indexOf('DTSTART;VALUE=DATE:20260916') !== -1, 'DTSTART date');
  ok(ics.indexOf('DTEND;VALUE=DATE:20260917') !== -1, 'DTEND date');
});

t('timed event renders UTC instants', () => {
  const ics = icsFromEvents(SAMPLE);
  ok(ics.indexOf('DTSTART:20260918T220000Z') !== -1, 'DTSTART utc');
  ok(ics.indexOf('DTEND:20260918T233000Z') !== -1, 'DTEND utc');
});

t('summary/description escaped, UID carries the gcal id', () => {
  const ics = icsFromEvents(SAMPLE);
  ok(ics.indexOf('SUMMARY:Board Meeting\\, MPR\\; bring notes') !== -1, 'summary escape');
  ok(ics.indexOf('DESCRIPTION:Agenda:\\nLine two') !== -1, 'description escape');
  ok(ics.indexOf('UID:evt1@rootsandwingsindy.com') !== -1, 'uid');
});

t('calendar wrapper + CRLF + calname', () => {
  const ics = icsFromEvents(SAMPLE);
  ok(/^BEGIN:VCALENDAR\r\n/.test(ics), 'starts VCALENDAR');
  ok(/END:VCALENDAR\r\n$/.test(ics), 'ends VCALENDAR');
  ok(ics.indexOf('X-WR-CALNAME:Roots & Wings Indy') !== -1, 'calname');
  ok(ics.split('\r\n').length > 10, 'CRLF separated');
});

t('long lines are folded with leading space', () => {
  const long = [{ id: 'x', summary: 'S'.repeat(200), start: { date: '2026-09-16' }, end: { date: '2026-09-17' } }];
  const ics = icsFromEvents(long);
  const folded = ics.split('\r\n').filter(l => l.startsWith(' '));
  ok(folded.length >= 2, 'has continuation lines');
  ok(!ics.split('\r\n').some(l => l.length > 75), 'no line over 75 chars');
});

t('event without a start is skipped, empty list still valid', () => {
  const ics = icsFromEvents([{ id: 'bad', summary: 'no start' }]);
  ok(ics.indexOf('BEGIN:VEVENT') === -1, 'skipped');
  ok(ics.indexOf('END:VCALENDAR') !== -1, 'still a calendar');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
