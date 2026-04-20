# Parking Lot

Deferred items — work that's known and scoped but waiting on outside input, a decision, or a time slot.

## Fix PayPal client-id on registration form (URGENT — blocks registration)
- **Where:** `register.html` line ~383, the PayPal JS SDK script tag. Current `client-id=BAAEXrFcNz-Q5sFay27KpbAs3d29W3AdjACtLpfAJXN5XshPFGjdnKD7ueLJcdHCNUNlhk7YigOuyoB1HQ`.
- **Status:** Every registration payment fails with **403 NOT_AUTHORIZED** on `POST /v2/checkout/orders`. Confirmed via browser DevTools console. Debug ID for PayPal support: `c9ef7f063ff16`.
- **Root cause:** The client-id is an 84-char `BAAE…` token from PayPal's **hosted-button / Standard Checkout wizard** (business.paypal.com "Add a PayPal button" flow). The JS SDK Advanced Checkout v2 orders API that our code uses requires a proper **REST API client-id** (80-char, starts with `A…`) from developer.paypal.com, and the merchant account behind the current token lacks the `orders:create` permission.
- **Blocker:** Needs the Treasurer — only they have login to the R&W PayPal Business account.
- **What to do:**
  1. Treasurer logs in at https://developer.paypal.com/dashboard/applications/live
  2. If no "Live" app exists: **Create App** → Merchant account type → name it "Roots & Wings Registration"
  3. On the app page, under **Features**, ensure **"Accept payments"** is enabled
  4. Copy the **Client ID** (starts with `A`, 80 chars)
  5. Send to Erin → replace the `client-id=…` value in `register.html` (and the duplicate inside `paypal_sdk` script src at line ~380)
- **Verify:** Click the PayPal button on `/register.html`. Button should open the PayPal approval flow instead of showing "Payment could not be processed."

## Configure Google Maps API key for address autocomplete
- **Where:** Registration form (`register.html`) has address autocomplete code wired up; it activates only when `GOOGLE_MAPS_API_KEY` is returned from `GET /api/tour?config=1`.
- **Status:** Currently the production endpoint returns `{ "googleMapsApiKey": null }`, so the field falls through to a plain text input.
- **Blocker:** Needs the Treasurer — Google Cloud project requires a billing account, which should come from the co-op's card, not Erin's personal card. Also sanity-check with Treasurer that the free-tier usage ($200/mo credit, ~28k Places sessions — way more than we'll use for a member registration form) won't trigger surprise charges.
- **What to do:**
  1. Treasurer creates/reuses a Google Cloud project at https://console.cloud.google.com/ and attaches a billing account (co-op card)
  2. Enable **Places API (New)** AND **Maps JavaScript API** in APIs & Services → Library
  3. APIs & Services → Credentials → Create Credentials → API key. Copy the `AIzaSy…` string.
  4. Restrict the key: Application restrictions → HTTP referrers → `roots-and-wings-topaz.vercel.app/*` (and the custom GoDaddy domain once live). API restrictions → restrict to the two APIs enabled above.
  5. Add to Vercel → Settings → Environment Variables as `GOOGLE_MAPS_API_KEY` for Production + Preview + Development
  6. Redeploy (or wait for next push) so the new env var is live
- **Verify:** Open `/register.html`, focus the Address field; the hint below should read "Suggestions powered by Google Maps." (instead of "Enter your full street address, city, and ZIP.")
