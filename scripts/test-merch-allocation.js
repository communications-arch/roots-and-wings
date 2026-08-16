// Guard tests for the Merch Desk allocation logic (api/_merch.js, #351).
//
// The inventory contract these lock in (2026-08-15 review finding 4):
//   - an order takes what the shelf REALLY gives up ('allocated') and the
//     rest becomes 'backordered' — a partially-coverable line SPLITS into
//     one line of each, never a single mixed line;
//   - 'allocated' is never written for units that did not leave the shelf,
//     even when the count the caller saw was stale or two orders race for
//     the last item (the phantom-stock scenario: a later cancel restores
//     only what was truly taken);
//   - two lines for the same variant in one order drain the same pool
//     sequentially (no double-spending on_hand);
//   - money is integer cents throughout;
//   - the Needs-ordering suggestion = backordered demand + threshold
//     shortfall − already-on-order, floored at zero.
//
// The DB helpers (allocateOrderLines / allocateBackorderedLines) run here
// against an in-memory fake of the Neon tagged-template client that
// models the two tables + the atomic take, so the split/insert logic is
// exercised without a database. The real statement is verified against
// the DEV DB by hand (see the 2026-08-15 review notes).
//
// Usage: node scripts/test-merch-allocation.js   (also runs in npm test)

const assert = require('assert');
const {
  normalizeLines, takeOutcome, orderTotalCents, needsOrderingQty,
  takeStock, allocateOrderLines, allocateBackorderedLines
} = require('../api/_merch.js');

let passed = 0;
let failed = 0;
const pending = [];
function t(name, fn) {
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
  };
  pending.push(run);
}

// ── In-memory fake of the Neon client for the DB helpers ───────────────
// Recognizes exactly the statements api/_merch.js issues. `shelf` maps
// variant_id → on_hand; `items` collects merch_desk_order_items rows.
// `beforeTake(vid)` lets a test yank stock between the caller's view and
// the atomic take (the race / stale-count scenario).
function fakeSql(shelf, opts) {
  const items = [];
  let nextId = 100;
  const hooks = opts || {};
  const sql = async (strings, ...vals) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    if (q.startsWith('UPDATE merch_variants v SET on_hand = GREATEST(v.on_hand - ?, 0)')) {
      const want = vals[0]; const vid = vals[1];
      if (hooks.beforeTake) hooks.beforeTake(vid);
      if (!(vid in shelf)) return [];
      const before = shelf[vid];
      shelf[vid] = Math.max(0, before - want);
      return [{ before: before, after: shelf[vid] }];
    }
    if (q.startsWith('INSERT INTO merch_desk_order_items')) {
      // stock_status is a SQL literal in the real statement ('allocated' /
      // 'backordered'), not a bound value — read it off the query text.
      const statusMatch = q.match(/'(allocated|backordered)'\s*\)/);
      const row = { id: nextId++, order_id: vals[0], variant_id: vals[1], qty: vals[2], price_cents_each: vals[3], stock_status: statusMatch ? statusMatch[1] : vals[4] };
      items.push(row);
      return [];
    }
    if (q.startsWith('UPDATE merch_desk_order_items SET qty = ?, stock_status = \'allocated\'')) {
      const row = items.find(r => r.id === vals[1]);
      if (row) { row.qty = vals[0]; row.stock_status = 'allocated'; }
      return [];
    }
    if (q.startsWith('UPDATE merch_desk_order_items SET stock_status = \'allocated\'')) {
      const row = items.find(r => r.id === vals[0]);
      if (row) row.stock_status = 'allocated';
      return [];
    }
    throw new Error('fakeSql: unexpected statement: ' + q.slice(0, 80));
  };
  sql.items = items;
  sql.seed = (row) => { const r = Object.assign({ id: nextId++ }, row); items.push(r); return r; };
  return sql;
}
const strip = (rows) => rows.map(r => ({ variant_id: r.variant_id, qty: r.qty, price_cents_each: r.price_cents_each, stock_status: r.stock_status }));

// ── takeOutcome (pure contract of one atomic take) ─────────────────────
t('takeOutcome: fully covered', () => {
  assert.deepStrictEqual(takeOutcome(2, 5, 3), { taken: 2, short: 0 });
});
t('takeOutcome: shelf ran short → taken is what really left, rest is short', () => {
  assert.deepStrictEqual(takeOutcome(4, 1, 0), { taken: 1, short: 3 });
});
t('takeOutcome: empty shelf → nothing taken', () => {
  assert.deepStrictEqual(takeOutcome(3, 0, 0), { taken: 0, short: 3 });
});
t('takeOutcome: never reports more than wanted or more than the shelf held', () => {
  assert.deepStrictEqual(takeOutcome(2, 10, 3), { taken: 2, short: 0 }); // odd before/after still capped at want
  assert.deepStrictEqual(takeOutcome(5, 2, 0), { taken: 2, short: 3 });
});
t('takeOutcome: garbage inputs clamp to zero', () => {
  assert.deepStrictEqual(takeOutcome('x', -4, null), { taken: 0, short: 0 });
});

// ── takeStock (against the fake) ───────────────────────────────────────
t('takeStock: missing variant takes nothing', async () => {
  const sql = fakeSql({ 1: 5 });
  assert.deepStrictEqual(await takeStock(sql, 99, 2), { taken: 0, short: 2 });
});
t('takeStock: on_hand never goes below zero', async () => {
  const shelf = { 1: 1 };
  const sql = fakeSql(shelf);
  assert.deepStrictEqual(await takeStock(sql, 1, 5), { taken: 1, short: 4 });
  assert.strictEqual(shelf[1], 0);
});

// ── allocateOrderLines ─────────────────────────────────────────────────
t('allocateOrderLines: all in stock', async () => {
  const shelf = { 1: 10 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [{ variant_id: 1, qty: 2, price_cents_each: 1500 }]);
  assert.deepStrictEqual(out, [{ variant_id: 1, qty: 2, price_cents_each: 1500, stock_status: 'allocated' }]);
  assert.deepStrictEqual(strip(sql.items), out);
  assert.strictEqual(shelf[1], 8);
});

t('allocateOrderLines: partial line splits into allocated + backordered', async () => {
  const shelf = { 7: 3 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [{ variant_id: 7, qty: 5, price_cents_each: 2000 }]);
  assert.deepStrictEqual(out, [
    { variant_id: 7, qty: 3, price_cents_each: 2000, stock_status: 'allocated' },
    { variant_id: 7, qty: 2, price_cents_each: 2000, stock_status: 'backordered' }
  ]);
  assert.strictEqual(shelf[7], 0);
  // Backordered units are still owed money — total covers the FULL ask.
  assert.strictEqual(orderTotalCents(out), 10000);
});

t('allocateOrderLines: out of stock → pure backorder, shelf untouched', async () => {
  const shelf = { 2: 0 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [{ variant_id: 2, qty: 2, price_cents_each: 500 }]);
  assert.deepStrictEqual(out, [{ variant_id: 2, qty: 2, price_cents_each: 500, stock_status: 'backordered' }]);
  assert.strictEqual(shelf[2], 0);
});

t('allocateOrderLines: two lines share one variant pool (no double-spend)', async () => {
  const shelf = { 4: 3 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [
    { variant_id: 4, qty: 2, price_cents_each: 1000 },
    { variant_id: 4, qty: 2, price_cents_each: 1000 }
  ]);
  assert.deepStrictEqual(out, [
    { variant_id: 4, qty: 2, price_cents_each: 1000, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 1000, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 1000, stock_status: 'backordered' }
  ]);
  assert.strictEqual(shelf[4], 0);
});

t('allocateOrderLines: mixed variants, mixed coverage', async () => {
  const shelf = { 1: 5, 2: 1 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [
    { variant_id: 1, qty: 1, price_cents_each: 1500 },
    { variant_id: 2, qty: 3, price_cents_each: 800 }
  ]);
  assert.deepStrictEqual(out, [
    { variant_id: 1, qty: 1, price_cents_each: 1500, stock_status: 'allocated' },
    { variant_id: 2, qty: 1, price_cents_each: 800, stock_status: 'allocated' },
    { variant_id: 2, qty: 2, price_cents_each: 800, stock_status: 'backordered' }
  ]);
  assert.deepStrictEqual(shelf, { 1: 4, 2: 0 });
});

// THE phantom-stock scenario: the caller believed on_hand = 2 (stale
// read / racing order) but by the time the take runs only 1 is left.
// The order must NOT record allocated=2 — a later cancel would then put
// 2 back on a shelf that only ever gave up 1.
t('allocateOrderLines: stale count / race → allocated only for what truly left the shelf', async () => {
  const shelf = { 3: 2 };
  const sql = fakeSql(shelf, { beforeTake: (vid) => { if (vid === 3) shelf[3] = 1; } });
  const out = await allocateOrderLines(sql, 50, [{ variant_id: 3, qty: 2, price_cents_each: 900 }]);
  assert.deepStrictEqual(out, [
    { variant_id: 3, qty: 1, price_cents_each: 900, stock_status: 'allocated' },
    { variant_id: 3, qty: 1, price_cents_each: 900, stock_status: 'backordered' }
  ]);
  assert.strictEqual(shelf[3], 0);
  // Cancel restores ALLOCATED lines only → back to exactly 1, never 2.
  const restore = out.filter(l => l.stock_status === 'allocated').reduce((n, l) => n + l.qty, 0);
  assert.strictEqual(shelf[3] + restore, 1);
});

t('allocateOrderLines: skips zero-qty lines, coerces strings', async () => {
  const shelf = { 1: 5 };
  const sql = fakeSql(shelf);
  const out = await allocateOrderLines(sql, 50, [
    { variant_id: 1, qty: 0, price_cents_each: 100 },
    { variant_id: 1, qty: '2', price_cents_each: '150' }
  ]);
  assert.deepStrictEqual(out, [{ variant_id: 1, qty: 2, price_cents_each: 150, stock_status: 'allocated' }]);
});

// ── allocateBackorderedLines (ready/delivered consume + unscreen) ──────
// A screened public-form order saved every line backordered; "Not spam"
// (and ready/delivered on any order) converts stored backordered lines
// for what CURRENT stock covers: fully-covered lines flip in place, a
// partly-covered line keeps its id for the allocated part and a fresh
// backordered line carries the remainder, uncovered lines are untouched.
t('allocateBackorderedLines: fully coverable line → flips in place', async () => {
  const shelf = { 3: 5 };
  const sql = fakeSql(shelf);
  const row = sql.seed({ order_id: 9, variant_id: 3, qty: 2, price_cents_each: 700, stock_status: 'backordered' });
  const n = await allocateBackorderedLines(sql, 9, [row]);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(strip(sql.items), [{ variant_id: 3, qty: 2, price_cents_each: 700, stock_status: 'allocated' }]);
  assert.strictEqual(shelf[3], 3);
});
t('allocateBackorderedLines: partial coverage keeps the id and splits the qty', async () => {
  const shelf = { 3: 1 };
  const sql = fakeSql(shelf);
  const row = sql.seed({ order_id: 9, variant_id: 3, qty: 4, price_cents_each: 700, stock_status: 'backordered' });
  const n = await allocateBackorderedLines(sql, 9, [row]);
  assert.strictEqual(n, 1);
  assert.strictEqual(sql.items[0].id, row.id);
  assert.deepStrictEqual(strip(sql.items), [
    { variant_id: 3, qty: 1, price_cents_each: 700, stock_status: 'allocated' },
    { variant_id: 3, qty: 3, price_cents_each: 700, stock_status: 'backordered' }
  ]);
  assert.strictEqual(shelf[3], 0);
});
t('allocateBackorderedLines: still out of stock → untouched, shelf untouched', async () => {
  const shelf = { 9: 0 };
  const sql = fakeSql(shelf);
  const row = sql.seed({ order_id: 9, variant_id: 9, qty: 2, price_cents_each: 100, stock_status: 'backordered' });
  const n = await allocateBackorderedLines(sql, 9, [row]);
  assert.strictEqual(n, 0);
  assert.deepStrictEqual(strip(sql.items), [{ variant_id: 9, qty: 2, price_cents_each: 100, stock_status: 'backordered' }]);
});
t('allocateBackorderedLines: two lines on one variant drain the same pool', async () => {
  const shelf = { 4: 3 };
  const sql = fakeSql(shelf);
  const a = sql.seed({ order_id: 9, variant_id: 4, qty: 2, price_cents_each: 100, stock_status: 'backordered' });
  const b = sql.seed({ order_id: 9, variant_id: 4, qty: 2, price_cents_each: 100, stock_status: 'backordered' });
  const n = await allocateBackorderedLines(sql, 9, [a, b]);
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(strip(sql.items), [
    { variant_id: 4, qty: 2, price_cents_each: 100, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 100, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 100, stock_status: 'backordered' }
  ]);
  assert.strictEqual(shelf[4], 0);
});

// ── orderTotalCents ────────────────────────────────────────────────────
t('orderTotalCents sums qty × price', () => {
  assert.strictEqual(orderTotalCents([
    { qty: 2, price_cents_each: 1500 },
    { qty: 1, price_cents_each: 800 }
  ]), 3800);
  assert.strictEqual(orderTotalCents([]), 0);
});

// ── normalizeLines ─────────────────────────────────────────────────────
// Shared by the member shop AND the public homepage form (#351 Phase 2)
// — the untrusted-input funnel every order body passes through.
t('normalizeLines: happy path passes through', () => {
  assert.deepStrictEqual(
    normalizeLines([{ variant_id: 3, qty: 2 }, { variant_id: 5, qty: 1 }]),
    [{ variant_id: 3, qty: 2 }, { variant_id: 5, qty: 1 }]
  );
});
t('normalizeLines: duplicate variants merge, capped at 99', () => {
  assert.deepStrictEqual(
    normalizeLines([{ variant_id: 3, qty: 60 }, { variant_id: 3, qty: 60 }]),
    [{ variant_id: 3, qty: 99 }]
  );
});
t('normalizeLines: garbage rows dropped, strings coerced', () => {
  assert.deepStrictEqual(
    normalizeLines([
      { variant_id: 'x', qty: 1 }, { variant_id: -2, qty: 1 },
      { variant_id: 4, qty: 0 }, { variant_id: '7', qty: '2' }
    ]),
    [{ variant_id: 7, qty: 2 }]
  );
});
t('normalizeLines: nothing valid (or not an array) → null', () => {
  assert.strictEqual(normalizeLines([]), null);
  assert.strictEqual(normalizeLines([{ variant_id: 0, qty: 5 }]), null);
  assert.strictEqual(normalizeLines('lines'), null);
  assert.strictEqual(normalizeLines(null), null);
});
t('normalizeLines: more than 30 distinct variants → null', () => {
  const many = [];
  for (let i = 1; i <= 31; i++) many.push({ variant_id: i, qty: 1 });
  assert.strictEqual(normalizeLines(many), null);
});

// ── needsOrderingQty ───────────────────────────────────────────────────
t('needsOrderingQty: backorders alone drive demand', () => {
  assert.strictEqual(needsOrderingQty({ on_hand: 5, on_order: 0, restock_threshold: 0 }, 3), 3);
});
t('needsOrderingQty: threshold shortfall adds on top', () => {
  // 2 backordered + need (6 − 1) = 5 to climb back to threshold → 7
  assert.strictEqual(needsOrderingQty({ on_hand: 1, on_order: 0, restock_threshold: 6 }, 2), 7);
});
t('needsOrderingQty: on_order counts against the ask', () => {
  assert.strictEqual(needsOrderingQty({ on_hand: 0, on_order: 4, restock_threshold: 3 }, 2), 1);
});
t('needsOrderingQty: fully covered by on_order → 0, never negative', () => {
  assert.strictEqual(needsOrderingQty({ on_hand: 10, on_order: 50, restock_threshold: 4 }, 1), 0);
});

// ── splitQuickSaleLines (Erin 2026-08-16: out-of-stock → pre-order) ────
const {
  splitQuickSaleLines, ledgerSignedCents, financeSummary, schoolYearBounds, normalizeLedgerEntry
} = require('../api/_merch.js');

t('splitQuickSaleLines: in-stock lines are instant, printed-to-order lines are pre-orders', () => {
  const r = splitQuickSaleLines(
    [{ variant_id: 1, qty: 2 }, { variant_id: 2, qty: 1 }],
    { 1: { price_cents: 1200, on_hand: 5, item_preorder_only: false }, 2: { price_cents: 1000, on_hand: 9, item_preorder_only: true } }
  );
  assert.deepStrictEqual(r.instant, [{ variant_id: 1, qty: 2, price_cents_each: 1200 }]);
  assert.strictEqual(r.preorder.length, 1);
  assert.strictEqual(r.preorder[0].variant_id, 2);
  assert.strictEqual(r.preorder[0].preorder_reason, 'printed');
  assert.deepStrictEqual(r.reasons, { printed: true, out: false });
});
t('splitQuickSaleLines: on_hand 0 → pre-order even for a regular item (no clamp-to-zero delivered sale)', () => {
  const r = splitQuickSaleLines(
    [{ variant_id: 7, qty: 1 }],
    { 7: { price_cents: 700, on_hand: 0, item_preorder_only: false } }
  );
  assert.strictEqual(r.instant.length, 0);
  assert.strictEqual(r.preorder.length, 1);
  assert.strictEqual(r.preorder[0].preorder_reason, 'out');
  assert.deepStrictEqual(r.reasons, { printed: false, out: true });
});
t('splitQuickSaleLines: mixed cart → both buckets, both reasons', () => {
  const r = splitQuickSaleLines(
    [{ variant_id: 1, qty: 1 }, { variant_id: 2, qty: 1 }, { variant_id: 3, qty: 3 }],
    {
      1: { price_cents: 1200, on_hand: 1, item_preorder_only: false },
      2: { price_cents: 1000, on_hand: 0, item_preorder_only: true },
      3: { price_cents: 3000, on_hand: 0, item_preorder_only: false }
    }
  );
  assert.deepStrictEqual(r.instant.map(l => l.variant_id), [1]);
  assert.deepStrictEqual(r.preorder.map(l => l.variant_id), [2, 3]);
  assert.deepStrictEqual(r.reasons, { printed: true, out: true });
  assert.strictEqual(orderTotalCents(r.preorder), 1000 + 9000);
});
t('splitQuickSaleLines: unknown variant is skipped; negative/NaN on_hand reads as out', () => {
  const r = splitQuickSaleLines(
    [{ variant_id: 1, qty: 1 }, { variant_id: 99, qty: 1 }],
    { 1: { price_cents: 500, on_hand: 'x', item_preorder_only: false } }
  );
  assert.strictEqual(r.instant.length + r.preorder.length, 1);
  assert.strictEqual(r.preorder[0].variant_id, 1);
});

// ── Merch Finances math ────────────────────────────────────────────────
t('ledgerSignedCents: sale +, expense −, deposit −, adjustment keeps its sign, null stays null', () => {
  assert.strictEqual(ledgerSignedCents('sale', 1250), 1250);
  assert.strictEqual(ledgerSignedCents('expense', 1850), -1850);
  assert.strictEqual(ledgerSignedCents('expense', -1850), -1850);
  assert.strictEqual(ledgerSignedCents('deposit', 5000), -5000);
  assert.strictEqual(ledgerSignedCents('adjustment', -200), -200);
  assert.strictEqual(ledgerSignedCents('adjustment', 500), 500);
  assert.strictEqual(ledgerSignedCents('sale', null), null);
  assert.strictEqual(ledgerSignedCents('sale', 'abc'), null);
});
t('financeSummary: sales by method, expenses, deposits, net, cash on hand', () => {
  const rows = [
    { type: 'sale', method: 'cash', amount_cents: 3000 },
    { type: 'sale', method: 'cash', amount_cents: 1700 },
    { type: 'sale', method: 'paypal', amount_cents: 3400 },
    { type: 'sale', method: 'check', amount_cents: 1000 },
    { type: 'expense', method: 'cash', amount_cents: -1850 },
    { type: 'expense', method: 'paypal', amount_cents: -1000 },
    { type: 'deposit', method: 'cash', amount_cents: -2000 },
    { type: 'adjustment', method: 'cash', amount_cents: -200 },
    { type: 'adjustment', method: 'other', amount_cents: 300 }
  ];
  const s = financeSummary(rows);
  assert.strictEqual(s.sales_cents, 9100);
  assert.deepStrictEqual(s.by_method, { cash: 4700, paypal: 3400, check: 1000 });
  assert.strictEqual(s.expenses_cents, 2850);
  assert.strictEqual(s.deposits_cents, 2000);
  assert.strictEqual(s.adjustments_cents, 100);
  // net = sales − expenses + adjustments (deposits are a transfer, not a loss)
  assert.strictEqual(s.net_cents, 9100 - 2850 + 100);
  // cash on hand = cash sales − cash expenses − cash deposits ± cash adjustments
  assert.strictEqual(s.cash_on_hand_cents, 4700 - 1850 - 2000 - 200);
  assert.strictEqual(s.rows_counted, 9);
});
t('financeSummary: voided entries and unpriced legacy sales are skipped (unpriced counted)', () => {
  const s = financeSummary([
    { type: 'sale', method: 'cash', amount_cents: 1000 },
    { type: 'sale', method: '', amount_cents: null },
    { type: 'expense', method: 'cash', amount_cents: -500, voided: true },
    { type: 'deposit', method: 'cash', amount_cents: -1000, voided: true }
  ]);
  assert.strictEqual(s.sales_cents, 1000);
  assert.strictEqual(s.expenses_cents, 0);
  assert.strictEqual(s.deposits_cents, 0);
  assert.strictEqual(s.cash_on_hand_cents, 1000);
  assert.strictEqual(s.unpriced_count, 1);
});
t('financeSummary: empty ledger → all zeros', () => {
  const s = financeSummary([]);
  assert.strictEqual(s.sales_cents + s.expenses_cents + s.deposits_cents + s.net_cents + s.cash_on_hand_cents, 0);
});
t('schoolYearBounds: April-1 flip window; malformed labels → null', () => {
  assert.deepStrictEqual(schoolYearBounds('2026-2027'), { start: '2026-04-01', end: '2027-04-01' });
  assert.strictEqual(schoolYearBounds('2026-2028'), null);
  assert.strictEqual(schoolYearBounds('26/27'), null);
  assert.strictEqual(schoolYearBounds(''), null);
});
t('normalizeLedgerEntry: expense/deposit must be positive; adjustment may be negative; zero rejected', () => {
  const ok = normalizeLedgerEntry({ type: 'expense', entry_date: '2026-08-16', amount_cents: 1850, method: 'cash', description: 'Table cloth', note: '' });
  assert.deepStrictEqual(ok, { type: 'expense', entryDate: '2026-08-16', amountCents: 1850, method: 'cash', description: 'Table cloth', note: '' });
  assert.ok(normalizeLedgerEntry({ type: 'expense', entry_date: '2026-08-16', amount_cents: -5, method: 'cash', description: 'x' }).error);
  assert.ok(normalizeLedgerEntry({ type: 'deposit', entry_date: '2026-08-16', amount_cents: 0, method: 'cash', description: 'x' }).error);
  const adj = normalizeLedgerEntry({ type: 'adjustment', entry_date: '2026-08-16', amount_cents: -200, method: 'cash', description: 'box short' });
  assert.strictEqual(adj.amountCents, -200);
  assert.ok(normalizeLedgerEntry({ type: 'sale', entry_date: '2026-08-16', amount_cents: 100, method: 'cash', description: 'x' }).error, 'sales are not manual entries');
  assert.ok(normalizeLedgerEntry({ type: 'expense', entry_date: '2026-02-30', amount_cents: 100, method: 'cash', description: 'x' }).error, 'invalid date');
  assert.ok(normalizeLedgerEntry({ type: 'expense', entry_date: '2026-08-16', amount_cents: 100, method: 'venmo', description: 'x' }).error, 'venmo retired');
  assert.ok(normalizeLedgerEntry({ type: 'expense', entry_date: '2026-08-16', amount_cents: 100, method: 'cash', description: '  ' }).error, 'description required');
  const stripped = normalizeLedgerEntry({ type: 'expense', entry_date: '2026-08-16', amount_cents: 100, method: 'other', description: '<b>bold</b> invoice', note: '<script>x</script>ok' });
  assert.strictEqual(stripped.description, 'bold invoice');
  assert.strictEqual(stripped.note, 'xok');
});

// ── PayPal pass-through fee (Erin, 2026-08-16: "add the fee into the cost") ──
// Same 1.99% + 49¢ gross-up as register.html / the billing card: after
// PayPal takes its cut of (price + fee), the co-op nets at least the price.
// Cash/check carry no fee; a zero total carries none either.
t('paypalFeeCents grosses up so the co-op nets the price; cash/check carry 0', () => {
  const { paypalFeeCents, orderFeeCents, PAYPAL_FEE_RATE, PAYPAL_FEE_FIXED_CENTS } = require('../api/_merch.js');
  assert.strictEqual(PAYPAL_FEE_RATE, 0.0199);
  assert.strictEqual(PAYPAL_FEE_FIXED_CENTS, 49);
  assert.strictEqual(paypalFeeCents(0), 0);
  assert.strictEqual(paypalFeeCents(1000), 71);   // $10 tee → $10.71
  assert.strictEqual(paypalFeeCents(200), 55);    // $2 sticker → $2.55
  for (const c of [100, 200, 700, 1000, 1500, 3000, 4999, 10000]) {
    const fee = paypalFeeCents(c);
    const net = (c + fee) * (1 - PAYPAL_FEE_RATE) - PAYPAL_FEE_FIXED_CENTS;
    assert.ok(net >= c - 0.5, 'net ' + net + ' < price ' + c);
    assert.ok(Number.isInteger(fee) && fee > 0);
  }
  assert.strictEqual(orderFeeCents('paypal', 1000), 71);
  assert.strictEqual(orderFeeCents('cash', 1000), 0);
  assert.strictEqual(orderFeeCents('check', 1000), 0);
  assert.strictEqual(orderFeeCents('', 1000), 0);
});
// The client mirror in script.js must agree with the server (display only,
// but a drifted rate would quote the buyer the wrong number).
t('script.js merchPaypalFeeCents mirrors api/_merch.js', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(/var MERCH_PAYPAL_FEE_RATE = 0\.0199;/.test(src), 'client rate is 0.0199');
  assert.ok(/var MERCH_PAYPAL_FEE_FIXED_CENTS = 49;/.test(src), 'client fixed part is 49¢');
  assert.ok(/function merchPaypalFeeCents\(totalCents\)/.test(src), 'client helper exists');
});

(async () => {
  for (const run of pending) await run();
  console.log('\nmerch-allocation: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
