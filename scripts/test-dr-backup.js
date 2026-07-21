// Unit tests for the disaster-recovery build (#49):
//   scripts/backup/drive-backup.js — retention policy, db-name swap, and
//     manifest comparison (the pure helpers the backup workflow leans on)
//   .github/workflows/db-backup.yml — structural sanity (jobs + secrets wired)
//   script.js drBinderCurrentWindow — the "Refresh the printed DR binder"
//     To Do's session-start cadence derivation (extraction approach, same as
//     test-helpers.js)
//
// Usage: node scripts/test-dr-backup.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const lib = require('./backup/drive-backup.js');

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

console.log('DR backup helpers (#49)');

// ── chooseBackupsToDelete ────────────────────────────────────────────────

function dailyDates(fromStr, n) {
  const out = [];
  const d = new Date(fromStr + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

t('30 or fewer backups: nothing deleted', () => {
  assertEq(lib.chooseBackupsToDelete(dailyDates('2026-07-01', 30), '2026-07-30'), []);
  assertEq(lib.chooseBackupsToDelete([], '2026-07-30'), []);
});

t('60 dailies: keeps last 30 + first-of-month keepers, deletes the rest', () => {
  // 2026-06-01 .. 2026-07-30 (60 days), today = 2026-07-30.
  const dates = dailyDates('2026-06-01', 60);
  const doomed = lib.chooseBackupsToDelete(dates, '2026-07-30');
  // Last 30 = 2026-07-01..2026-07-30 kept. 2026-06-01 is June's
  // first-of-month keeper. So doomed = 2026-06-02..2026-06-30 (29 days).
  assertEq(doomed.length, 29);
  assert(doomed.indexOf('2026-06-01') === -1, 'June keeper must survive');
  assert(doomed.indexOf('2026-06-02') !== -1, 'June 2 should be pruned');
  assert(doomed.indexOf('2026-07-01') === -1, 'recent dailies survive');
});

t('monthly keepers expire after 12 months', () => {
  // A lone keeper from 13 months ago plus 31 recent dailies.
  const dates = ['2025-06-01'].concat(dailyDates('2026-07-01', 31));
  const doomed = lib.chooseBackupsToDelete(dates, '2026-07-31');
  assert(doomed.indexOf('2025-06-01') !== -1, '13-month-old keeper should be pruned');
  // 2026-07-01 falls out of the last-30 window (31 dailies) but survives as
  // July's first-of-month keeper.
  assert(doomed.indexOf('2026-07-01') === -1, 'first-of-current-month survives as keeper');
});

t('keeper is the EARLIEST backup in each month, not necessarily day 1', () => {
  // August starts on the 3rd (job was down Aug 1-2).
  const dates = dailyDates('2025-08-03', 5).concat(dailyDates('2026-07-01', 30));
  const doomed = lib.chooseBackupsToDelete(dates, '2026-07-30');
  assert(doomed.indexOf('2025-08-03') === -1, 'earliest August backup survives');
  assert(doomed.indexOf('2025-08-04') !== -1, 'later August dailies pruned');
});

t('duplicate dates are collapsed', () => {
  const doomed = lib.chooseBackupsToDelete(['2026-07-01', '2026-07-01', '2026-07-02'], '2026-07-02');
  assertEq(doomed, []);
});

// ── swapDbName ───────────────────────────────────────────────────────────

t('swapDbName preserves credentials, host and query string', () => {
  const out = lib.swapDbName(
    'postgresql://user:p%40ss@ep-plain-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
    'rw_restore_test'
  );
  assertEq(out, 'postgresql://user:p%40ss@ep-plain-123.us-east-2.aws.neon.tech/rw_restore_test?sslmode=require');
});

t('swapDbName handles ports and extra params', () => {
  const out = lib.swapDbName('postgres://u:p@host:5433/db_one?sslmode=require&x=1', 'scratch');
  assertEq(out, 'postgres://u:p@host:5433/scratch?sslmode=require&x=1');
});

// ── compareManifest ──────────────────────────────────────────────────────

const GOOD = { backup_date: '2026-07-20', registrations: 19, people: 34, kids: 42, kid_enrollments: 42, waiver_signatures: 30 };

t('compareManifest passes when every count matches', () => {
  const { pass, lines } = lib.compareManifest(GOOD, GOOD);
  assert(pass, 'should pass');
  assertEq(lines.length, lib.MANIFEST_TABLES.length);
});

t('compareManifest fails on a mismatch and names the table', () => {
  const bad = Object.assign({}, GOOD, { kids: 41 });
  const { pass, lines } = lib.compareManifest(GOOD, bad);
  assert(!pass, 'should fail');
  assert(lines.some((l) => l.indexOf('kids') !== -1 && l.indexOf('✗') !== -1), 'kids line flagged');
});

t('compareManifest fails when a count is missing entirely', () => {
  const { pass } = lib.compareManifest(GOOD, { registrations: 19 });
  assert(!pass, 'missing tables must fail');
});

// ── workflow file structural sanity ──────────────────────────────────────

t('db-backup.yml exists and wires all five secrets', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'db-backup.yml'), 'utf8');
  for (const s of ['BACKUP_DATABASE_URL', 'BACKUP_PASSPHRASE', 'BACKUP_GDRIVE_SA_KEY', 'BACKUP_GDRIVE_FOLDER_ID', 'BACKUP_RESEND_KEY']) {
    assert(wf.indexOf('secrets.' + s) !== -1, 'missing secret wiring: ' + s);
  }
  assert(/cron:\s*'10 8 \* \* \*'/.test(wf), 'nightly cron missing/changed');
  assert(wf.indexOf('restore-test:') !== -1, 'restore-test job missing');
  assert(wf.indexOf('--format=custom') !== -1, 'pg_dump custom format expected');
  assert(wf.indexOf('AES256') !== -1, 'gpg AES256 expected');
  assert(wf.indexOf('rw_restore_test') !== -1, 'scratch DB name expected');
  assert(wf.indexOf('if: failure()') !== -1, 'failure alert step expected');
});

t('drive-backup.js passes supportsAllDrives in every Drive helper', () => {
  const src = fs.readFileSync(path.join(__dirname, 'backup', 'drive-backup.js'), 'utf8');
  for (const fn of ['driveList', 'driveUpload', 'driveDelete', 'driveDownload']) {
    const m = src.match(new RegExp('async function ' + fn + '\\b[\\s\\S]*?\\n\\}', 'm'));
    assert(m, 'could not extract ' + fn);
    assert(m[0].indexOf('supportsAllDrives=true') !== -1, fn + ' missing supportsAllDrives');
  }
  assert(src.indexOf('includeItemsFromAllDrives=true') !== -1, 'list missing includeItemsFromAllDrives');
});

// ── drBinderCurrentWindow (client cadence derivation) ────────────────────

const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
function extractFn(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = scriptSrc.match(re);
  if (!m) throw new Error('could not extract function ' + fnName);
  return m[0];
}

const harness = new Function(`
  ${extractFn('welcomeDaysBefore')}
  ${extractFn('drBinderCurrentWindow')}
  return { drBinderCurrentWindow: drBinderCurrentWindow };
`);

const SESSIONS = [
  { school_year: '2026-2027', session_number: 1, start_date: '2026-09-08', end_date: '2026-10-16' },
  { school_year: '2026-2027', session_number: 2, start_date: '2026-11-02', end_date: '2026-12-11' },
  { school_year: '2026-2027', session_number: 3, start_date: '2027-01-11', end_date: '2027-02-19' },
];

t('drBinderCurrentWindow: nothing before the first window opens', () => {
  const { drBinderCurrentWindow } = harness();
  assertEq(drBinderCurrentWindow(SESSIONS, '2026-08-15'), null);
});

t('drBinderCurrentWindow: opens 7 days before a session start', () => {
  const { drBinderCurrentWindow } = harness();
  const w = drBinderCurrentWindow(SESSIONS, '2026-09-01');
  assert(w && w.kind === 'drbinder-s1', 'expected s1, got ' + JSON.stringify(w));
  assertEq(w.school_year, '2026-2027');
});

t('drBinderCurrentWindow: the latest opened session wins (stays until next)', () => {
  const { drBinderCurrentWindow } = harness();
  assertEq(harness().drBinderCurrentWindow(SESSIONS, '2026-10-20').kind, 'drbinder-s1');
  assertEq(drBinderCurrentWindow(SESSIONS, '2026-10-26').kind, 'drbinder-s2'); // s2 start −7
  assertEq(drBinderCurrentWindow(SESSIONS, '2027-06-01').kind, 'drbinder-s3');
});

t('drBinderCurrentWindow: tolerates junk rows', () => {
  const { drBinderCurrentWindow } = harness();
  const w = drBinderCurrentWindow([{ foo: 1 }, null, SESSIONS[0]], '2026-09-08');
  assertEq(w.kind, 'drbinder-s1');
});

// ── summary ──────────────────────────────────────────────────────────────
console.log('  ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
