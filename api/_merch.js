// Merch Desk (#351) — inventory/allocation logic shared by
// api/supply-closet.js (merch-* actions) and api/tour.js (public order
// form). Pure math up top (guarded by scripts/test-merch-allocation.js);
// the stock-take primitives at the bottom take an injected `sql` and
// touch merch_variants / merch_desk_order_items — no env, no imports.
//
// Inventory truth (Phase 1, tightened 2026-08-15 review finding 4):
//   - Placing an order takes stock ONE LINE AT A TIME with an atomic
//     conditional UPDATE (takeStock): the units it actually removed become
//     an 'allocated' line, the rest a 'backordered' line (a partially-
//     coverable request splits into one line of each). Allocation never
//     writes 'allocated' for units it did not remove — even when two
//     orders race for the last item, or the count the client saw is stale.
//   - Cancelling an order restores on_hand for its ALLOCATED lines only
//     (backordered lines never took stock) — truthful by construction.
//   - Marking an order ready/delivered (and un-screening a public-form
//     order) converts its backordered lines to allocated for whatever the
//     shelf covers NOW; any shortfall stays backordered (visible on the
//     order + still counted as demand until stock arrives / is recounted).
//   - Quick Sale's INSTANT sale is the one deliberate exception: the item
//     physically left the table, so it clamps (GREATEST(on_hand - n, 0)).
//   - Needs ordering = per-variant open backordered demand (screened spam
//     excluded) + anything with on_hand below restock_threshold, minus
//     what's already on_order from the supplier.

// Normalize a client lines payload: ints, qty 1-99, duplicate variants
// merged, max 30 distinct lines. Returns null when nothing valid.
// Shared by the member place-order path (api/supply-closet.js) and the
// public homepage order form (api/tour.js merch-desk-order).
function normalizeLines(raw) {
  if (!Array.isArray(raw)) return null;
  const byVariant = {};
  const order = [];
  raw.slice(0, 60).forEach(l => {
    const vid = parseInt(l && l.variant_id, 10);
    let qty = parseInt(l && l.qty, 10);
    if (!Number.isInteger(vid) || vid < 1) return;
    if (!Number.isFinite(qty) || qty < 1) return;
    qty = Math.min(qty, 99);
    if (!byVariant[vid]) { byVariant[vid] = 0; order.push(vid); }
    byVariant[vid] = Math.min(byVariant[vid] + qty, 99);
  });
  if (order.length === 0 || order.length > 30) return null;
  return order.map(vid => ({ variant_id: vid, qty: byVariant[vid] }));
}

// What one atomic stock take actually did, from the shelf count before
// and after it: units removed vs. units still owed. Pure — this is the
// contract takeStock() reports and the guard test locks in: `taken` is
// never more than the shelf held, never more than was wanted, and
// taken + short always equals the request (so lines written from it
// add back up to the order).
function takeOutcome(want, before, after) {
  const w = Math.max(0, parseInt(want, 10) || 0);
  const b = Math.max(0, parseInt(before, 10) || 0);
  const a = Math.max(0, parseInt(after, 10) || 0);
  const taken = Math.min(w, Math.max(0, b - a));
  return { taken: taken, short: w - taken };
}

// Sum of qty × price for stored order lines.
function orderTotalCents(lines) {
  return (lines || []).reduce((sum, l) => {
    return sum + Math.max(0, parseInt(l.qty, 10) || 0) * Math.max(0, parseInt(l.price_cents_each, 10) || 0);
  }, 0);
}

// Suggested supplier order for one variant on the Needs-ordering report:
// open backordered demand, plus the shortfall to climb back to the
// restock threshold, minus what's already on order. Never negative.
function needsOrderingQty(variant, backorderedDemand) {
  const onHand = Math.max(0, parseInt(variant && variant.on_hand, 10) || 0);
  const onOrder = Math.max(0, parseInt(variant && variant.on_order, 10) || 0);
  const threshold = Math.max(0, parseInt(variant && variant.restock_threshold, 10) || 0);
  const demand = Math.max(0, parseInt(backorderedDemand, 10) || 0);
  const shortfall = Math.max(0, threshold - onHand);
  return Math.max(0, demand + shortfall - onOrder);
}

// ── Stock-take primitives (DB; `sql` = a Neon tagged-template client) ──
//
// The Neon HTTP driver runs each statement as its own transaction, so
// truthfulness has to come from ONE atomic statement per take rather
// than a read-then-write pair. This UPDATE locks the variant row, reads
// its count, decrements by at most that count, and returns both the
// before and after values in the same statement — so `taken` is exactly
// what left the shelf, however many orders race for it. (Verified on dev
// 2026-08-15: 10 concurrent takes of 1 against on_hand=4 → exactly 4
// taken, on_hand ends 0.)

// Take up to `qty` of one variant from the shelf. → { taken, short }.
// on_hand never goes below zero and `taken` is never more than what was
// actually there. A missing variant takes nothing (short = qty).
async function takeStock(sql, variantId, qty) {
  const want = Math.max(0, parseInt(qty, 10) || 0);
  const vid = parseInt(variantId, 10);
  if (!want || !Number.isInteger(vid)) return { taken: 0, short: want };
  const rows = await sql`
    UPDATE merch_variants v
    SET on_hand = GREATEST(v.on_hand - ${want}, 0), updated_at = NOW()
    FROM (SELECT id, on_hand AS before FROM merch_variants WHERE id = ${vid} FOR UPDATE) b
    WHERE v.id = b.id
    RETURNING b.before, v.on_hand AS after
  `;
  if (!rows.length) return { taken: 0, short: want };
  return takeOutcome(want, rows[0].before, rows[0].after);
}

// Write a NEW order's lines truthfully: per line, take what the shelf
// has right now, insert an 'allocated' line for exactly those units and
// a 'backordered' line for the remainder (allocated first when it splits).
//   lines: [{ variant_id, qty, price_cents_each }]   (normalized)
// → the lines as written: [{ variant_id, qty, price_cents_each, stock_status }]
async function allocateOrderLines(sql, orderId, lines) {
  const out = [];
  for (const line of lines || []) {
    const qty = Math.max(0, parseInt(line.qty, 10) || 0);
    const price = Math.max(0, parseInt(line.price_cents_each, 10) || 0);
    if (!qty) continue;
    const take = await takeStock(sql, line.variant_id, qty);
    if (take.taken > 0) {
      await sql`
        INSERT INTO merch_desk_order_items (order_id, variant_id, qty, price_cents_each, stock_status)
        VALUES (${orderId}, ${line.variant_id}, ${take.taken}, ${price}, 'allocated')
      `;
      out.push({ variant_id: line.variant_id, qty: take.taken, price_cents_each: price, stock_status: 'allocated' });
    }
    if (take.short > 0) {
      await sql`
        INSERT INTO merch_desk_order_items (order_id, variant_id, qty, price_cents_each, stock_status)
        VALUES (${orderId}, ${line.variant_id}, ${take.short}, ${price}, 'backordered')
      `;
      out.push({ variant_id: line.variant_id, qty: take.short, price_cents_each: price, stock_status: 'backordered' });
    }
  }
  return out;
}

// Convert an order's STORED backordered lines to allocated for whatever
// the shelf covers now (ready/delivered consumption; un-screening a
// public-form order). A line the shelf covers fully flips in place; a
// partly-covered line keeps its id for the allocated part and a fresh
// backordered line carries the remainder; an uncovered line is untouched.
//   back: [{ id, variant_id, qty, price_cents_each }]  (stock_status = 'backordered')
// → units allocated
async function allocateBackorderedLines(sql, orderId, back) {
  let allocated = 0;
  for (const l of back || []) {
    const qty = Math.max(0, parseInt(l.qty, 10) || 0);
    if (!qty) continue;
    const take = await takeStock(sql, l.variant_id, qty);
    if (take.taken <= 0) continue;
    allocated += take.taken;
    if (take.short > 0) {
      await sql`UPDATE merch_desk_order_items SET qty = ${take.taken}, stock_status = 'allocated' WHERE id = ${l.id}`;
      await sql`
        INSERT INTO merch_desk_order_items (order_id, variant_id, qty, price_cents_each, stock_status)
        VALUES (${orderId}, ${l.variant_id}, ${take.short}, ${Math.max(0, parseInt(l.price_cents_each, 10) || 0)}, 'backordered')
      `;
    } else {
      await sql`UPDATE merch_desk_order_items SET stock_status = 'allocated' WHERE id = ${l.id}`;
    }
  }
  return allocated;
}

module.exports = {
  normalizeLines, takeOutcome, orderTotalCents, needsOrderingQty,
  takeStock, allocateOrderLines, allocateBackorderedLines
};
