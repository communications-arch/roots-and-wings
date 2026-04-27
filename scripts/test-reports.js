// Unit tests for report-related helpers in script.js:
//
//   formatReportDate     — date-only TZ fix (the "signed yesterday" bug)
//   deriveWorkspaceEmail — Member Onboarding suggested email
//   isReadyToOnboard     — gates the onboarding queue
//   renderStatusPill     — shared Paid/Signed/Pending pill renderer
//
// Same extract-from-script.js pattern as test-helpers.js — if any of these
// are renamed or restructured, the extract step fails loudly.
//
// Usage: node scripts/test-reports.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const src = fs.readFileSync(SCRIPT_JS, 'utf8');
function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const sources = [
  extract('escapeHtmlWs'),
  extract('formatReportDate'),
  extract('renderStatusPill'),
  extract('deriveWorkspaceEmail'),
  extract('isReadyToOnboard'),
].join('\n\n');

const helpers = (new Function(
  sources +
  '\nreturn { formatReportDate, renderStatusPill, deriveWorkspaceEmail, isReadyToOnboard };'
))();

const { formatReportDate, renderStatusPill, deriveWorkspaceEmail, isReadyToOnboard } = helpers;

// ── formatReportDate (the TZ fix) ────────────────────────────────────────
//
// Critical regression: date-only strings like "2026-04-27" must render as
// the literal day, not back-shift to "Apr 26" when the viewer is west of
// UTC (the original "signed yesterday" bug). Timestamps with time components
// go through normal Date parsing.
console.log('\nformatReportDate');
{
  t('empty string → empty', () => assert.strictEqual(formatReportDate(''), ''));
  t('null → empty', () => assert.strictEqual(formatReportDate(null), ''));
  t('undefined → empty', () => assert.strictEqual(formatReportDate(undefined), ''));

  // Date-only strings: the literal day must come back regardless of viewer TZ.
  // toLocaleDateString uses the runner's TZ; "Apr 27" is the expected
  // formatted output for 2026-04-27 in en-US. The bug we're guarding
  // against is "Apr 26" (back-shifted from midnight UTC parse).
  t('date-only "2026-04-27" → "Apr 27" (no UTC backshift)', () => {
    assert.strictEqual(formatReportDate('2026-04-27'), 'Apr 27');
  });
  t('date-only "2025-12-31" → "Dec 31" (year boundary)', () => {
    assert.strictEqual(formatReportDate('2025-12-31'), 'Dec 31');
  });
  t('date-only "2026-01-01" → "Jan 1" (DST/year boundary)', () => {
    assert.strictEqual(formatReportDate('2026-01-01'), 'Jan 1');
  });

  // Timestamp with time component: normal Date parsing applies. We assert
  // it returns SOMETHING formatted (not empty), but don't pin to a specific
  // day since it depends on viewer TZ — tests run in CI with various TZs.
  t('TIMESTAMPTZ string returns a formatted date', () => {
    const out = formatReportDate('2026-04-27T15:30:00.000Z');
    assert.ok(/^[A-Z][a-z]{2} \d+$/.test(out), 'expected "Mon DD" got: ' + out);
  });

  t('Date object returns formatted', () => {
    const out = formatReportDate(new Date(2026, 3, 27));
    assert.strictEqual(out, 'Apr 27');
  });

  t('garbage string → empty', () => {
    assert.strictEqual(formatReportDate('not a date'), '');
  });
}

// ── renderStatusPill ─────────────────────────────────────────────────────
console.log('\nrenderStatusPill');
{
  t('paid without date → bare Paid pill', () => {
    const html = renderStatusPill('paid', null);
    assert.ok(html.indexOf('ws-wv-ok') !== -1);
    assert.ok(html.indexOf('Paid') !== -1);
    assert.ok(html.indexOf('ws-wv-stamp') === -1, 'no stamp expected');
  });
  t('paid with date → Paid + stamp', () => {
    const html = renderStatusPill('paid', '2026-04-27');
    assert.ok(html.indexOf('Paid') !== -1);
    assert.ok(html.indexOf('Apr 27') !== -1);
  });
  t('signed renders Signed pill', () => {
    const html = renderStatusPill('signed', '2026-04-27');
    assert.ok(html.indexOf('Signed') !== -1);
    assert.ok(html.indexOf('Apr 27') !== -1);
  });
  t('pending → Pending pill, ignores date', () => {
    const html = renderStatusPill('pending', '2026-04-27');
    assert.ok(html.indexOf('ws-wv-pending') !== -1);
    assert.ok(html.indexOf('Pending') !== -1);
    assert.ok(html.indexOf('Apr 27') === -1, 'date should not render on pending');
  });
  t('unknown state defaults to Pending', () => {
    const html = renderStatusPill('whatever', null);
    assert.ok(html.indexOf('Pending') !== -1);
  });
}

// ── deriveWorkspaceEmail ─────────────────────────────────────────────────
//
// Convention used by api/sheets.js parseDirectory + scripts/seed-role-
// holders.js + Member Onboarding's suggested email field. Must agree with
// _permissions.js's expected holder email or the auto-onboard automation
// (Aug 2026 phase 2) won't match the volunteer-sheet derived email.
console.log('\nderiveWorkspaceEmail');
{
  t('"Erin Bogan" → erinb@', () => {
    assert.strictEqual(deriveWorkspaceEmail('Erin Bogan', null), 'erinb@rootsandwingsindy.com');
  });
  t('returning family — uses existing_family_name as the surname', () => {
    // "Erin Smith" with existing_family_name "Bogan" → erinb@ (not erins@)
    assert.strictEqual(deriveWorkspaceEmail('Erin Smith', 'Bogan'), 'erinb@rootsandwingsindy.com');
  });
  t('hyphenated/punctuated first names get punctuation stripped', () => {
    assert.strictEqual(deriveWorkspaceEmail('Mary-Ann Smith', null), 'maryanns@rootsandwingsindy.com');
  });
  t('single-word LC name returns empty (need first + last)', () => {
    assert.strictEqual(deriveWorkspaceEmail('Madonna', null), '');
  });
  t('empty input → empty', () => {
    assert.strictEqual(deriveWorkspaceEmail('', null), '');
  });
  t('lowercases everything', () => {
    assert.strictEqual(deriveWorkspaceEmail('TIFFANY SMITH', null), 'tiffanys@rootsandwingsindy.com');
  });
}

// ── isReadyToOnboard ─────────────────────────────────────────────────────
//
// Filter for the Member Onboarding queue. Must include only:
//   paid + waiver-signed + new family + welcome-email NOT yet sent.
// Returning families (existing_family_name set) are skipped because they
// already have a Workspace account.
console.log('\nisReadyToOnboard');
{
  const baseNew = {
    payment_status: 'paid',
    waiver_member_agreement: true,
    signature_name: 'Jane Doe',
    existing_family_name: null,
    welcome_email_sent_at: null
  };

  t('paid + signed + new + not-yet-emailed → true', () => {
    assert.strictEqual(isReadyToOnboard(baseNew), true);
  });

  t('returning family (existing_family_name set) → false', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      existing_family_name: 'Bogan'
    })), false);
  });

  t('unpaid → false', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      payment_status: 'pending'
    })), false);
  });

  t('not signed (no signature_name) → false', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      signature_name: ''
    })), false);
  });

  t('not signed (waiver_member_agreement false) → false', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      waiver_member_agreement: false
    })), false);
  });

  t('welcome email already sent → false', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      welcome_email_sent_at: '2026-04-27T10:00:00Z'
    })), false);
  });

  t('payment_status casing-insensitive ("Paid" works)', () => {
    assert.strictEqual(isReadyToOnboard(Object.assign({}, baseNew, {
      payment_status: 'Paid'
    })), true);
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
