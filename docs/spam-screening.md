# Public-form spam screening

The homepage's public forms — **Schedule a Tour**, **Contact Us**, and **Order
Merch** — all POST to `/api/tour` (a `kind` field picks the handler). Every
submission runs through the layers below, in order. A tripped layer never
hard-fails: the visitor sees the normal "thanks" (a plain 200) and the
submission is **saved silently with a `screen_reason`** so a bot gets no signal
and a real family is never lost — screened rows sit in a rescuable bucket
("Not spam" puts them back; no emails fire until then).

| # | Layer | Where | What trips it |
|---|-------|-------|---------------|
| 1 | Honeypot | `website` hidden field | any value |
| 2 | Signed form token (#207) | `GET /api/tour?form_token=1` at page render; HMAC-signed timestamp | missing / bad signature / <4–8 s fill / >3–24 h old / reused |
| 3 | Client page stamp (`form_ts`) | cheap first tripwire | same windows as the token |
| 4 | Content heuristics (#45) | `inquiryContentScreen` | URL in name, gibberish name, disposable-inbox domain, 3+ links, link-only body |
| 5 | **Content score** (2026-08-15) | `spamScore` / `spamScoreScreen` | additive score ≥ `SPAM_JUNK_THRESHOLD` (5): SEO/agency pitch, crypto/loans/pharma, cold-email openers, bulk-mail footers, raw HTML, machine-looking names/emails, spam TLDs, implausible tour "ages" |
| 6 | **Cloudflare Turnstile** (2026-08-15) | `turnstileScreen` — server calls siteverify | Cloudflare says the token is invalid/expired/duplicate, or the browser sent none |
| 7 | Duplicate text (2026-08-15, contact only) | `duplicateMessageScreen` | same 80+ char message from a different email within 7 days |
| 8 | Per-IP rate caps | `public_form_hits` ledger | 3 in 10 min / 10 in 24 h → screened; 25 in 24 h → hard-dropped (no row) |

Everything is per-form-kind and per-IP; nothing here touches authenticated
member forms.

## Where screened submissions show up

- **Contact + tour** → `tours` rows with `status='junk'` → Workspace → *Inquiries* → the **Junk** chip (rescue = "Not spam"). Each row's detail shows the `screen_reason`.
- **Merch (homepage web form)** → `merch_desk_orders.screen_reason` (Desk queue shows a *screened* pill) and legacy `merch_orders.screen_reason` (Web Orders → *Screened as likely spam* bucket).
- **Counts**: `GET /api/tour?spam_stats=1` (Membership / Merch Manager / board) → last 7 / 30 days by class. Rendered as the one-liner *"Screened this month: 41 — 30 turnstile, 8 content, 3 rate · 12 in the last 7 days"* above the Inquiries junk list and the merch screened bucket. Rescued/deleted rows drop out of the counts.

## Turnstile setup (Erin — Vercel env vars)

Turnstile is **off until both keys exist**. With no keys the page loads no
Cloudflare script, every form submits exactly as before, and the server logs
nothing — this is the designed fail-open state for dev/preview and for a
Cloudflare outage.

1. Cloudflare dashboard → **Turnstile** → *Add widget*.
   - Hostnames: `rootsandwingsindy.com`, `www.rootsandwingsindy.com`, `rw-dev.vercel.app` (add preview hosts if you want them checked; otherwise previews simply skip).
   - Widget mode: **Managed** (invisible for people; a checkbox only when Cloudflare is unsure). The page renders it with `appearance: interaction-only`.
2. Copy the **Site Key** and **Secret Key**.
3. Vercel → project `roots-and-wings` → Settings → Environment Variables:
   - `TURNSTILE_SITE_KEY` — public; Production (+ Preview/Development if you want dev checked)
   - `TURNSTILE_SECRET_KEY` — secret; same environments
4. Redeploy. The homepage's `GET /api/tour?form_token=1` now returns the site key and the widget loads inside each modal.

Half-configured (only one key) = still skipped, with one warning line in the
function logs. Never commit either key to the repo.

### Fail-open contract (`turnstileScreen`)

Returns **null (skip)** when: keys are missing/half-set · siteverify is
unreachable, times out (5 s), or answers non-200 · Cloudflare reports a
config-side error (`*secret*`, `internal-error`, `bad-request`, or no codes).
Returns a **screen reason** only for a visitor-side verdict:
`invalid-input-response`, `timeout-or-duplicate`, action mismatch, or no
token at all. Even then the submission is saved and rescuable.

### CSP note

The site currently ships no `Content-Security-Policy` header (see
`vercel.json`; a real CSP is deferred). When one is added it must allow:

- `script-src https://challenges.cloudflare.com`
- `frame-src https://challenges.cloudflare.com`

The widget lives in a Cloudflare iframe; our own `X-Frame-Options: SAMEORIGIN`
is unaffected.

## Content scorer — tuning

All weights and the threshold are constants at the top of the *Content
scoring* block in `api/tour.js` (`SPAM_JUNK_THRESHOLD`, `SPAM_W_*`, the
`SPAM_RE_*` vocabularies, `SPAM_TLDS`). Each class scores **once** regardless
of how many keywords match, and no single weak signal reaches the threshold —
a family on a `.xyz` address or one who "came across your website" passes.
`scripts/test-spam-score.js` (in `npm test`) holds a dozen real-family samples
that must pass and a set of spam samples that must screen; add to both lists
when you tune.

The `screen_reason` for this layer looks like
`content score 7 (pitch, opener, salesy)` — hit labels only, never the
visitor's text.
