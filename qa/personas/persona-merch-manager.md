# The Merch Manager

**Run me when:** the Merchandise report (Orders / Catalog & Stock / Quick
Sale), the homepage Order Merch form, the Heads-up card, My Merch Orders,
merch To Dos, spam screening of public forms, or payment methods change.

**Who:** The volunteer who sells shirts at a folding table and fills web
orders from a tub in the closet — one hand free and a phone at events, the
queue vs the tub at home. Her worst bug is stock that's wrong (she promises
a shirt she doesn't have) or an order that vanishes between the web form
and her queue. Venmo is over — she records cash, check, or PayPal.

**Login:** the dev holder of Merchandise Manager (Roles & Committees) — if
no one holds it, run as erinb@ (Communications Director passes
`merch_manage` by default) and say so. **Device: PHONE** for Quick Sale;
**DESKTOP** for Orders and Catalog & Stock.

## Journeys

1. **Orders tab, one queue.** Reports & Forms → Merchandise & Orders. Expected:
   filter chips Pre-orders / All / Fulfilled / Cancelled with counts that
   sum sensibly; every row wears a Source badge (Web or Event) and a
   fulfillment pill (Pre-order / Fulfilled / Cancelled) beside a payment pill
   (Paid · method / Unpaid); "Mark paid" offers exactly Cash / Check / PayPal;
   Ready → Fulfilled moves the row; Cancel returns stock (check On hand).
2. **Screened bucket.** Expand "Screened as likely spam (N)" at the bottom.
   Expected: rows show the reason; "Not spam" moves one back into the list
   AND reserves its stock (On hand drops); the "Screened this month" line
   appears; nothing in the bucket ever emailed anyone.
3. **Catalog & Stock.** Expected: one row per variant; funnels for Need
   ("Needs ordering"), Item, Active; header sort sticks across re-renders;
   Edit (variant) and Edit item (chip toolbar) save inline; "Receive stock"
   adds a shipment and draws down On order when the box is ticked; the
   "Pre-order only — printed to order" flag on an item shows a pre-order
   badge on its chip and in Quick Sale.
4. **Quick Sale on the phone.** Tap a mug ×2 and a tee ×1, pick a member
   family from the list, tap Cash, Record sale. Expected: the running total
   is right; the note says tees are saved as a pre-order; "Recorded — $X
   collected" names the split; Orders now holds TWO Event orders — mugs
   Fulfilled + Paid · Cash, the tee under Pre-orders, Paid · Cash — and the
   mugs' On hand dropped by 2 in Catalog & Stock. The family's Heads-up
   card (View-As them) shows the tee waiting for pickup. Repeat with a
   walk-up guest name.
5. **The two To Dos.** To Do card: "Merch orders waiting on you" equals the
   Pre-orders count and opens Orders; "Reorder low or back-ordered merch"
   equals the Need funnel's row count and opens Catalog & Stock with the
   Needs-ordering view preset. Both hide at zero.
6. **Public form → Heads-up round trip.** On index.html → Order Merch, place
   an order using a dev family's email. Expected: it lands on Orders as Web /
   Pre-order / Unpaid with the total; back in the portal as that family, the
   Heads-up card lists it with a button into My Merch Orders; the confirmation
   email says pay at pickup — cash, check, or PayPal.

## Exploratory charter (~10 min)

Break stock: order the last unit twice (web + Quick Sale), cancel one, watch
On hand / backordered / Need after each step; receive a negative recount;
hide an item mid-pre-order. Break the queue: an older web order with no
price, an order from an email that isn't a member, a Not-spam rescue whose
stock is now gone. Then look at merch from a plain member's My Community
card ("Purchase Merch") — the shop is the public page, and the Heads-up card
must disappear when nothing is outstanding.

## UX-notes lens

Chips whose selected state is hard to see outdoors; any Quick Sale tap
target too small for a thumb; the word "Fulfilled" doing double duty as a
filter and an action on the same row.
