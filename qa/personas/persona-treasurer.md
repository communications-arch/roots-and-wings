# The Treasurer

**Run me when:** billing, PayPal, registration payment status, the
Membership report, waivers-vs-registration linkage, or merch payment
recording changes.

**Who:** The person who reconciles the co-op's money against what the portal
says. She acts on the Pending pill and marks people paid; a family shown as
paid on one screen and pending on another means a real email to a real
family, so number drift is her worst bug. She does not run merch (that's the
Merch Manager, by design) but she must not be shown a Venmo anywhere.

**Login:** treasurer@ (Dunphy family) · **Device: DESKTOP.** One journey on
the phone (she confirms cash at the co-op door).

## Journeys

1. **Pending Payment Registrations.** To Do card → the item with its count.
   Expected: opens the Membership report pre-scoped to Pending; rows shown =
   the To Do count = the "N Pending" pill = the Board card's "payments
   pending" metric.
2. **Mark paid, watch it propagate.** Mark one pending family paid (Actions
   column — she is an acting role). Expected: the row's Paid pill flips, the
   Pending count drops by one everywhere (To Do, pills, Board card), the
   family's own Billing & Fees card (View-As allowed for this check) reads
   Paid — not "awaiting Treasurer confirmation" — without a hard refresh.
3. **Billing card as a family.** View-As a regular family: Billing & Fees
   shows the deposit + semester lines, PayPal fee note, due dates and the
   pay button. Expected: totals foot; a family with nothing due gets the
   "Nothing to bill right now" state, not an empty card.
4. **Waivers ↔ registrations.** Compare the Membership report's Waiver
   column (Signed / Pending pills) with the Waivers report (Board section →
   Communications Director card → Waivers chip; read-only for her — no
   Resend). Expected: a family counted signed in one is signed in the
   other; declined/withdrawn/waitlisted rows stay out of the money counts.
5. **Merch vocabulary (View-As the Merch Manager, or Comms).** Open
   Merchandise → Orders → Mark paid on a pre-order and the Quick Sale
   payment chips. Expected: exactly Cash / Check / PayPal — no Venmo on any
   new-payment chip (historical rows may still *read* Venmo). Confirm the
   Merchandise report is NOT on her own Reports & Forms card by default.
6. **Phone.** Repeat journey 1. Expected: the report scrolls; Mark Paid is
   reachable without horizontal pan.

## Exploratory charter (~10 min)

Break the reconciliation: filter combos in the Membership report (Paid ×
New × track pills), CSV/print exports vs on-screen counts, a family with two
registrations across seasons, the April-1 school-year pivot (which season's
rows count?). Any surface that shows the same family both paid and unpaid —
or a total that doesn't equal its parts — is a defect regardless of which
side is right.

## UX-notes lens

Money states without a timestamp or "who marked this"; pills that filter but
don't look pressed; the word "pending" used for both "not yet paid" and
"paid, awaiting confirmation" on the same screen.
