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

// PayPal processing fee passed through to the buyer (Erin, 2026-08-16:
// "add the fee into the cost") — the SAME rate + gross-up the registration
// form and the billing card use (1.99% + 49¢, register.html PAYPAL_FEE),
// so the co-op nets the catalog price after PayPal takes its cut. Cents in,
// cents out; 0 for a zero total. Client mirror: script.js merchPaypalFeeCents.
const PAYPAL_FEE_RATE = 0.0199;
const PAYPAL_FEE_FIXED_CENTS = 49;
function paypalFeeCents(totalCents) {
  const t = Math.max(0, Math.round(Number(totalCents) || 0));
  if (!t) return 0;
  return Math.ceil((t + PAYPAL_FEE_FIXED_CENTS) / (1 - PAYPAL_FEE_RATE) - t);
}
// The fee an order carries for a given payment method (0 unless PayPal).
function orderFeeCents(method, totalCents) {
  return method === 'paypal' ? paypalFeeCents(totalCents) : 0;
}

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

// Quick Sale cart split (Erin, 2026-08-16): which lines are handed over
// at the table right now (INSTANT: delivered + paid, stock clamped) and
// which become a paid PRE-ORDER (not delivered; allocated/backordered
// truthfully). A line is a pre-order when its item is printed to order
// (merch_items.preorder_only) OR the shelf shows nothing on hand — an
// out-of-stock item can't be handed over, so the buyer is ordering it.
//   lines:    [{ variant_id, qty }]  (normalized)
//   variants: { [id]: { price_cents, on_hand, item_preorder_only } }
// → { instant: [...], preorder: [...], reasons: { printed, out } }
//   each line: { variant_id, qty, price_cents_each, preorder_reason? }
function splitQuickSaleLines(lines, variants) {
  const instant = [];
  const preorder = [];
  const reasons = { printed: false, out: false };
  (lines || []).forEach(l => {
    const v = (variants || {})[l.variant_id];
    if (!v) return;
    const line = { variant_id: l.variant_id, qty: l.qty, price_cents_each: Math.max(0, parseInt(v.price_cents, 10) || 0) };
    if (v.item_preorder_only) {
      line.preorder_reason = 'printed';
      reasons.printed = true;
      preorder.push(line);
    } else if ((parseInt(v.on_hand, 10) || 0) <= 0) {
      line.preorder_reason = 'out';
      reasons.out = true;
      preorder.push(line);
    } else {
      instant.push(line);
    }
  });
  return { instant, preorder, reasons };
}

// ── Merch Finances (money ledger) — pure math ─────────────────────────
//
// The Merch Finances report merges three sources into ONE ledger:
// paid Desk orders (type 'sale'), the manager's manual entries in
// merch_ledger_entries ('expense' / 'deposit' / 'adjustment'), and
// paid legacy web-form orders (a 'sale' with no price on file —
// amount null, flagged, never summed). Every row carries the same
// shape: { type, method, amount_cents (SIGNED, or null), voided }.
//
// Sign convention (the Amount column shows exactly this):
//   sale        +amount   money in
//   expense     −amount   money out
//   deposit     −amount   handed to the treasurer (leaves the cash box,
//                         NOT a loss — excluded from Net)
//   adjustment  ±amount   stored signed (+ found / − short / − refund)
// Summary (integer cents throughout):
//   sales      = Σ sale
//   by_method  = Σ sale per payment method
//   expenses   = Σ |expense|
//   deposits   = Σ |deposit|
//   adjustments= Σ adjustment (signed)
//   net        = sales − expenses + adjustments   (= Σ signed, deposits excluded)
//   cash_on_hand = Σ signed over method = 'cash'   (sales − expenses −
//                  deposits ± adjustments, cash only)
// Voided entries and unpriced legacy rows are skipped everywhere.
const LEDGER_TYPES = ['sale', 'expense', 'deposit', 'adjustment'];
const LEDGER_ENTRY_TYPES = ['expense', 'deposit', 'adjustment'];
const LEDGER_METHODS = ['cash', 'check', 'paypal', 'other'];

// Signed cents for a stored (type, positive-or-signed amount) pair.
// Adjustments are stored signed and pass through; a null/NaN amount
// (unpriced legacy sale) stays null.
function ledgerSignedCents(type, amountCents) {
  if (amountCents == null) return null;
  const n = parseInt(amountCents, 10);
  if (!Number.isFinite(n)) return null;
  if (type === 'adjustment') return n;
  const mag = Math.abs(n);
  return (type === 'expense' || type === 'deposit') ? -mag : mag;
}

// Roll a ledger (rows already carrying SIGNED amount_cents) into the
// summary tiles. Skips voided rows and rows with a null amount, but
// counts the latter so the report can flag "N older orders had no
// price on file".
function financeSummary(rows) {
  const s = {
    sales_cents: 0, expenses_cents: 0, deposits_cents: 0, adjustments_cents: 0,
    net_cents: 0, cash_on_hand_cents: 0,
    by_method: {}, unpriced_count: 0, rows_counted: 0
  };
  (rows || []).forEach(r => {
    if (!r || r.voided) return;
    if (r.amount_cents == null) { s.unpriced_count++; return; }
    const amt = parseInt(r.amount_cents, 10);
    if (!Number.isFinite(amt)) { s.unpriced_count++; return; }
    s.rows_counted++;
    const method = String(r.method || '') || 'other';
    if (r.type === 'sale') {
      s.sales_cents += amt;
      s.by_method[method] = (s.by_method[method] || 0) + amt;
    } else if (r.type === 'expense') {
      s.expenses_cents += Math.abs(amt);
    } else if (r.type === 'deposit') {
      s.deposits_cents += Math.abs(amt);
    } else if (r.type === 'adjustment') {
      s.adjustments_cents += amt;
    } else {
      return;
    }
    if (r.type !== 'deposit') s.net_cents += amt;
    if (method === 'cash') s.cash_on_hand_cents += amt;
  });
  return s;
}

// The calendar window a school-year label covers, matching the April-1
// flip in activeSchoolYear (api/_permissions.js / script.js): a date D
// belongs to label activeSchoolYear(D), so '2026-2027' = [2026-04-01,
// 2027-04-01). Returns { start, end } as YYYY-MM-DD (end exclusive) or
// null for a malformed label.
function schoolYearBounds(label) {
  const m = String(label || '').match(/^(\d{4})-(\d{4})$/);
  if (!m) return null;
  const fall = parseInt(m[1], 10);
  if (parseInt(m[2], 10) !== fall + 1) return null;
  return { start: fall + '-04-01', end: (fall + 1) + '-04-01' };
}

// Validate + normalize a manual ledger entry from the client. Returns
// { error } or the cleaned fields. amount_cents arrives as an integer
// (the client converts dollars); expense/deposit must be > 0,
// adjustment must be non-zero (either sign). Description is required
// so the ledger row can be read without expanding it.
function normalizeLedgerEntry(src) {
  const b = src || {};
  const type = String(b.type || '');
  if (LEDGER_ENTRY_TYPES.indexOf(type) === -1) return { error: 'Type must be expense, deposit, or adjustment.' };
  const entryDate = String(b.entry_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return { error: 'Pick a date.' };
  const d = new Date(entryDate + 'T12:00:00');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== entryDate) return { error: 'That date isn’t valid.' };
  const amount = parseInt(b.amount_cents, 10);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100000000) return { error: 'Enter a non-zero amount (up to $1,000,000).' };
  if (type !== 'adjustment' && amount < 0) return { error: 'Expenses and deposits are entered as positive amounts — the ledger applies the sign.' };
  const method = String(b.method || 'cash');
  if (LEDGER_METHODS.indexOf(method) === -1) return { error: 'Method must be cash, check, paypal, or other.' };
  const description = String(b.description || '').replace(/<[^>]*>/g, '').trim().slice(0, 200);
  if (!description) return { error: 'A short description is required.' };
  const note = String(b.note || '').replace(/<[^>]*>/g, '').trim().slice(0, 1000);
  return { type, entryDate, amountCents: amount, method, description, note };
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
  takeStock, allocateOrderLines, allocateBackorderedLines,
  splitQuickSaleLines,
  PAYPAL_FEE_RATE, PAYPAL_FEE_FIXED_CENTS, paypalFeeCents, orderFeeCents,
  LEDGER_TYPES, LEDGER_ENTRY_TYPES, LEDGER_METHODS,
  ledgerSignedCents, financeSummary, schoolYearBounds, normalizeLedgerEntry
};
