// Guard tests for the Merch Desk allocation math (api/_merch.js, #351).
//
// The inventory contract these lock in:
//   - an order takes what it can from on_hand ('allocated') and the rest
//     becomes 'backordered' — a partially-coverable line SPLITS into one
//     line of each, never a single mixed line;
//   - two lines for the same variant in one order drain the same pool
//     sequentially (no double-spending on_hand);
//   - money is integer cents throughout;
//   - the Needs-ordering suggestion = backordered demand + threshold
//     shortfall − already-on-order, floored at zero.
//
// Usage: node scripts/test-merch-allocation.js   (also runs in npm test)

const assert = require('assert');
const { splitLine, allocateOrder, orderTotalCents, needsOrderingQty } = require('../api/_merch.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

// ── splitLine ──────────────────────────────────────────────────────────
t('splitLine: fully covered', () => {
  assert.deepStrictEqual(splitLine(2, 5), { allocated: 2, backordered: 0, remainingOnHand: 3 });
});
t('splitLine: exactly covered', () => {
  assert.deepStrictEqual(splitLine(5, 5), { allocated: 5, backordered: 0, remainingOnHand: 0 });
});
t('splitLine: partial coverage splits', () => {
  assert.deepStrictEqual(splitLine(4, 1), { allocated: 1, backordered: 3, remainingOnHand: 0 });
});
t('splitLine: zero stock backorders everything', () => {
  assert.deepStrictEqual(splitLine(3, 0), { allocated: 0, backordered: 3, remainingOnHand: 0 });
});
t('splitLine: garbage inputs clamp to zero', () => {
  assert.deepStrictEqual(splitLine('x', -4), { allocated: 0, backordered: 0, remainingOnHand: 0 });
});

// ── allocateOrder ──────────────────────────────────────────────────────
t('allocateOrder: all in stock', () => {
  const r = allocateOrder(
    [{ variant_id: 1, qty: 2, price_cents_each: 1500 }],
    { 1: 10 }
  );
  assert.deepStrictEqual(r.lines, [{ variant_id: 1, qty: 2, price_cents_each: 1500, stock_status: 'allocated' }]);
  assert.deepStrictEqual(r.decrements, { 1: 2 });
  assert.strictEqual(r.total_cents, 3000);
});

t('allocateOrder: partial line splits into allocated + backordered', () => {
  const r = allocateOrder(
    [{ variant_id: 7, qty: 5, price_cents_each: 2000 }],
    { 7: 3 }
  );
  assert.deepStrictEqual(r.lines, [
    { variant_id: 7, qty: 3, price_cents_each: 2000, stock_status: 'allocated' },
    { variant_id: 7, qty: 2, price_cents_each: 2000, stock_status: 'backordered' }
  ]);
  assert.deepStrictEqual(r.decrements, { 7: 3 });
  // Backordered units are still owed money — total covers the FULL ask.
  assert.strictEqual(r.total_cents, 10000);
});

t('allocateOrder: out of stock → pure backorder, no decrement', () => {
  const r = allocateOrder(
    [{ variant_id: 2, qty: 2, price_cents_each: 500 }],
    { 2: 0 }
  );
  assert.deepStrictEqual(r.lines, [{ variant_id: 2, qty: 2, price_cents_each: 500, stock_status: 'backordered' }]);
  assert.deepStrictEqual(r.decrements, {});
  assert.strictEqual(r.total_cents, 1000);
});

t('allocateOrder: two lines share one variant pool (no double-spend)', () => {
  const r = allocateOrder(
    [
      { variant_id: 4, qty: 2, price_cents_each: 1000 },
      { variant_id: 4, qty: 2, price_cents_each: 1000 }
    ],
    { 4: 3 }
  );
  assert.deepStrictEqual(r.lines, [
    { variant_id: 4, qty: 2, price_cents_each: 1000, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 1000, stock_status: 'allocated' },
    { variant_id: 4, qty: 1, price_cents_each: 1000, stock_status: 'backordered' }
  ]);
  assert.deepStrictEqual(r.decrements, { 4: 3 });
  assert.strictEqual(r.total_cents, 4000);
});

t('allocateOrder: mixed variants, mixed coverage', () => {
  const r = allocateOrder(
    [
      { variant_id: 1, qty: 1, price_cents_each: 1500 },
      { variant_id: 2, qty: 3, price_cents_each: 800 }
    ],
    { 1: 5, 2: 1 }
  );
  assert.deepStrictEqual(r.lines, [
    { variant_id: 1, qty: 1, price_cents_each: 1500, stock_status: 'allocated' },
    { variant_id: 2, qty: 1, price_cents_each: 800, stock_status: 'allocated' },
    { variant_id: 2, qty: 2, price_cents_each: 800, stock_status: 'backordered' }
  ]);
  assert.deepStrictEqual(r.decrements, { 1: 1, 2: 1 });
  assert.strictEqual(r.total_cents, 1500 + 2400);
});

t('allocateOrder: does not mutate the caller stock map', () => {
  const stock = { 9: 4 };
  allocateOrder([{ variant_id: 9, qty: 4, price_cents_each: 100 }], stock);
  assert.strictEqual(stock[9], 4);
});

// ── orderTotalCents ────────────────────────────────────────────────────
t('orderTotalCents sums qty × price', () => {
  assert.strictEqual(orderTotalCents([
    { qty: 2, price_cents_each: 1500 },
    { qty: 1, price_cents_each: 800 }
  ]), 3800);
  assert.strictEqual(orderTotalCents([]), 0);
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

console.log('\nmerch-allocation: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
