// Merch Desk (#351) — pure inventory/allocation math, shared by
// api/supply-closet.js (merch-* actions) and guarded by
// scripts/test-merch-allocation.js. No DB, no env — keep it pure.
//
// Inventory truth (Phase 1):
//   - Placing an order decrements on_hand for what it can cover; covered
//     units become 'allocated' lines, the remainder 'backordered' lines
//     (a partially-coverable request splits into one line of each).
//   - Cancelling an order restores on_hand for its ALLOCATED lines only
//     (backordered lines never took stock).
//   - Marking an order ready/delivered converts its backordered lines to
//     allocated, decrementing on_hand then (clamped at 0) so a received
//     shipment that fulfills the backorder keeps counts truthful.
//   - Needs ordering = per-variant open backordered demand + anything
//     with on_hand below restock_threshold, minus what's already
//     on_order from the supplier.

// Split one requested line against available stock.
// → { allocated, backordered, remainingOnHand }
function splitLine(qty, onHand) {
  const q = Math.max(0, parseInt(qty, 10) || 0);
  const h = Math.max(0, parseInt(onHand, 10) || 0);
  const allocated = Math.min(q, h);
  return {
    allocated: allocated,
    backordered: q - allocated,
    remainingOnHand: h - allocated
  };
}

// Allocate a whole order against current stock.
//   lines:            [{ variant_id, qty, price_cents_each }]
//   onHandByVariant:  { [variant_id]: on_hand }   (NOT mutated)
// → {
//   lines:      [{ variant_id, qty, price_cents_each, stock_status }]
//               (allocated line first when a request splits),
//   decrements: { [variant_id]: unitsTakenFromStock },
//   total_cents
// }
function allocateOrder(lines, onHandByVariant) {
  const stock = {};
  Object.keys(onHandByVariant || {}).forEach(k => {
    stock[k] = Math.max(0, parseInt(onHandByVariant[k], 10) || 0);
  });
  const out = [];
  const decrements = {};
  let total = 0;
  (lines || []).forEach(line => {
    const vid = line.variant_id;
    const price = Math.max(0, parseInt(line.price_cents_each, 10) || 0);
    const split = splitLine(line.qty, stock[vid]);
    stock[vid] = split.remainingOnHand;
    if (split.allocated > 0) {
      out.push({ variant_id: vid, qty: split.allocated, price_cents_each: price, stock_status: 'allocated' });
      decrements[vid] = (decrements[vid] || 0) + split.allocated;
    }
    if (split.backordered > 0) {
      out.push({ variant_id: vid, qty: split.backordered, price_cents_each: price, stock_status: 'backordered' });
    }
    total += (split.allocated + split.backordered) * price;
  });
  return { lines: out, decrements: decrements, total_cents: total };
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

module.exports = { splitLine, allocateOrder, orderTotalCents, needsOrderingQty };
