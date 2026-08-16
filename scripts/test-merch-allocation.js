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

(async () => {
  for (const run of pending) await run();
  console.log('\nmerch-allocation: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
