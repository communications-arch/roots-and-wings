// Unit tests for parseBillingSheet (api/sheets.js) against both Treasurer
// workbook generations:
//   - "Treasurer 26-27" (new, linked 2026-07): Fall Deposit for the
//     workbook's own year lives in col B; rates are label cells
//     ("Semester 1 Rate") with the amount to the right — Morning Classes
//     N/O, Afternoons H/I.
//   - Legacy "Treasurer 25-26" shape: bare rate values in H2/H3, next
//     year's deposits in col F ("Fall Deposit (Next Year)").
// The column choice is self-describing: the workbook's register tab is
// named after its school year ("2026-2027"), and requesting a LATER year
// flips fall.deposit to col F. Fixture rows below are copied from the
// real sheets.
//
// Usage: node scripts/test-billing-parse.js

const assert = require('assert');
const { parseBillingSheet } = require('../api/sheets.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

// ── Fixtures ──────────────────────────────────────────────────────────
const NEW_TABS = {
  '2026-2027': [
    ['Date', 'Type', 'Check #', 'TRUE', 'Category', 'Family Tracking', 'Description/notes', 'Fund', 'Credits', 'Debits'],
    ['', '', '', '', 'Fall Deposit', 'Baumgartner', 'see prior spreadsheet for details', '', '$40.00'],
  ],
  'Family Payment Tracking': [
    ['Family Name', 'Fall Deposit', 'Fall Fees', 'Spring Deposit', 'Spring Fees', 'Fall Deposit (Next Year)', '', 'Family Name', 'Camp Deposit', 'Camp Fees'],
    ['Baumgartner', 'Paid', '', '', '', '', '', 'Baumgartner'],
    ['Nextyearson', '', '', '', '', 'Paid'],
  ],
  'Morning Classes': [
    [],
    ['', 'Saplings', '', '', 'Sassafras', '', '', 'Oaks', '', '', 'Maples', '', '', 'Semester 1 Rate', '$20.00'],
    ['', 'Semester 1', '', '', 'Semester 1', '', '', 'Semester 1', '', '', 'Semester 1', '', '', 'Semester 2 Rate', '$30.00'],
  ],
  'Afternoons': [
    [],
    ['', 'Afternoon S1', '', '', 'Afternoon S2', '', '', 'Semester 1 Rate', '$20.00'],
    ['', '# of students', '', '', '# of students', '', '', 'Semester 2 Rate', '$30.00'],
  ],
};

// No year-named tab — exercises the legacy fallback that keeps the old
// workbook safe while it's still the linked BILLING_SHEET_ID.
const LEGACY_TABS = {
  'Family Payment Tracking': [
    ['Family Name', 'Fall Deposit', 'Fall Fees', 'Spring Deposit', 'Spring Fees', 'Fall Deposit (Next Year)'],
    ['Oldfam', 'Paid', 'Paid', '', '', 'Paid'],
  ],
  'Morning Classes': [
    [],
    ['', '', '', '', '', '', '', '$15.00'],
    ['', '', '', '', '', '', '', '$25.00'],
  ],
  'Afternoons': [
    [],
    ['', '', '', '', '', '', '', '$20.00'],
    ['', '', '', '', '', '', '', '$30.00'],
  ],
};

// ── New workbook (Treasurer 26-27) ────────────────────────────────────
console.log('parseBillingSheet — Treasurer 26-27 workbook');
t("workbook's own year reads Fall Deposit from col B", () => {
  const p = parseBillingSheet(NEW_TABS, '2026-2027');
  assert.strictEqual(p.families['baumgartner'].fall.deposit, 'Paid');
  assert.strictEqual(p.families['nextyearson'].fall.deposit, '');
});
t('a LATER year reads the "Fall Deposit (Next Year)" col F instead', () => {
  const p = parseBillingSheet(NEW_TABS, '2027-2028');
  assert.strictEqual(p.families['nextyearson'].fall.deposit, 'Paid');
  assert.strictEqual(p.families['baumgartner'].fall.deposit, '');
});
t('label-scanned rates: Morning N/O and Afternoons H/I both found', () => {
  const p = parseBillingSheet(NEW_TABS, '2026-2027');
  assert.strictEqual(p.rates.fall.amRate, 20);
  assert.strictEqual(p.rates.spring.amRate, 30);
  assert.strictEqual(p.rates.fall.pmRate, 20);
  assert.strictEqual(p.rates.spring.pmRate, 30);
});

// ── Legacy workbook (Treasurer 25-26 shape) ───────────────────────────
console.log('\nparseBillingSheet — legacy 25-26 workbook shape');
t('legacy (no year tab): requesting 2026-2027 still reads col F', () => {
  const p = parseBillingSheet(LEGACY_TABS, '2026-2027');
  assert.strictEqual(p.families['oldfam'].fall.deposit, 'Paid');
  assert.strictEqual(p.families['oldfam'].fall.classFee, '');
});
t('legacy: sheet-year request reads B-E', () => {
  const p = parseBillingSheet(LEGACY_TABS, '2025-2026');
  assert.strictEqual(p.families['oldfam'].fall.deposit, 'Paid');
  assert.strictEqual(p.families['oldfam'].fall.classFee, 'Paid');
});
t('legacy: bare H2/H3 rates still read via the fallback', () => {
  const p = parseBillingSheet(LEGACY_TABS, '2025-2026');
  assert.strictEqual(p.rates.fall.amRate, 15);
  assert.strictEqual(p.rates.spring.amRate, 25);
  assert.strictEqual(p.rates.fall.pmRate, 20);
  assert.strictEqual(p.rates.spring.pmRate, 30);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
