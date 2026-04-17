// Smoke test for the registration endpoint.
// Post-redesign: a registration is only written to the DB AFTER PayPal capture,
// so the handler now requires `paypal_transaction_id` on the initial POST.
//
// Boots api/tour.js directly, mocks req/res, and verifies:
//   1. A valid registration (with txn id) lands in the DB as 'paid'
//   2. A duplicate email/season returns 409
//   3. A missing paypal_transaction_id returns 400
//   4. Invalid email returns 400
//   5. Unknown kind returns 400
//   6. GET ?config=1 returns { googleMapsApiKey: null|string }
// Skips the Resend email (no RESEND_API_KEY needed — error is swallowed).
//
// Usage: node --env-file=.env.local scripts/test-registration.js

const handler = require('../api/tour.js');
const { neon } = require('@neondatabase/serverless');

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(data) { this.body = data; return this; },
    end() { return this; }
  };
}

async function call(req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, data: res.body };
}

async function post(body) {
  return call({ method: 'POST', headers: { origin: 'https://roots-and-wings-topaz.vercel.app' }, body, query: {} });
}

async function get(query) {
  return call({ method: 'GET', headers: { origin: 'https://roots-and-wings-topaz.vercel.app' }, query });
}

const TEST_EMAIL = 'smoketest+' + Date.now() + '@example.com';
const TEST_SEASON = 'smoketest-' + Date.now();

function basePayload(overrides) {
  return Object.assign({
    kind: 'registration',
    season: TEST_SEASON,
    email: TEST_EMAIL,
    main_learning_coach: 'Smoke Test',
    address: '1 Test St, Indianapolis, IN 46220',
    phone: '3175550000',
    track: 'Both',
    kids: [{ name: 'Kid One', birth_date: '2018-05-01' }],
    placement_notes: 'test run',
    waiver_member_agreement: true,
    waiver_liability: true,
    signature_name: 'Smoke Test',
    signature_date: new Date().toISOString().slice(0, 10),
    paypal_transaction_id: 'TEST-TXN-' + Date.now(),
    payment_amount: 50
  }, overrides || {});
}

(async () => {
  const sql = neon(process.env.DATABASE_URL);

  console.log('1. Submitting new (paid) registration…');
  const reg = await post(basePayload());
  console.log('   →', reg.status, reg.data);
  if (reg.status !== 201) throw new Error('Expected 201');
  const id = reg.data.id;

  console.log('2. Verifying DB row is paid…');
  const rows = await sql`SELECT id, email, payment_status, paypal_transaction_id, kids FROM registrations WHERE id = ${id}`;
  console.log('   →', rows[0]);
  if (rows[0].payment_status !== 'paid') throw new Error('Expected paid');
  if (!rows[0].paypal_transaction_id) throw new Error('Expected paypal_transaction_id to be saved');
  if (rows[0].kids.length !== 1) throw new Error('Expected 1 kid');

  console.log('3. Duplicate (same email + season) should 409…');
  const dup = await post(basePayload({ paypal_transaction_id: 'TEST-TXN-DUP-' + Date.now() }));
  console.log('   →', dup.status, dup.data && dup.data.error);
  if (dup.status !== 409) throw new Error('Expected 409');

  console.log('4. Missing paypal_transaction_id should 400…');
  const noTxn = await post(basePayload({ email: 'nopay+' + Date.now() + '@example.com', paypal_transaction_id: '' }));
  console.log('   →', noTxn.status, noTxn.data && noTxn.data.error);
  if (noTxn.status !== 400) throw new Error('Expected 400');

  console.log('5. Invalid email should 400…');
  const badEmail = await post(basePayload({ email: 'not-an-email' }));
  console.log('   →', badEmail.status, badEmail.data && badEmail.data.error);
  if (badEmail.status !== 400) throw new Error('Expected 400');

  console.log('6. Unknown kind should 400…');
  const unknown = await post({ kind: 'bogus' });
  console.log('   →', unknown.status, unknown.data && unknown.data.error);
  if (unknown.status !== 400) throw new Error('Expected 400');

  console.log('7. GET ?config=1 returns public config…');
  const cfg = await get({ config: '1' });
  console.log('   →', cfg.status, cfg.data);
  if (cfg.status !== 200) throw new Error('Expected 200');
  if (!('googleMapsApiKey' in (cfg.data || {}))) throw new Error('Expected googleMapsApiKey field');

  console.log('8. Cleaning up test row…');
  await sql`DELETE FROM registrations WHERE id = ${id}`;

  console.log('\n✓ All smoke tests passed.');
  process.exit(0);
})().catch(err => {
  console.error('\n✗ Test failed:', err.message);
  process.exit(1);
});
