# Roots & Wings Indy — Website

A static website for the Roots & Wings Indy homeschool co-op in Indianapolis, IN.

## File Structure

```
roots-and-wings/
├── index.html      — Public landing page
├── members.html    — Members-only portal (password-gated)
├── 404.html        — Custom 404 page
├── styles.css      — All styles
├── script.js       — All JavaScript
├── logo.png        — Place your logo file here
└── README.md       — This file
```

## Setup

1. Add your `logo.png` file to the root directory. The logo is referenced throughout the site and will display automatically once present.
2. Open `index.html` in a browser, or serve the directory with any static file server.

## Google Workspace Integration Points

The following placeholder URLs in `members.html` need to be replaced with real Google Workspace links:

| Resource | Placeholder | Replace With |
|---|---|---|
| Member Directory | `https://docs.google.com/spreadsheets/d/PLACEHOLDER` | Your Google Sheet URL |
| Handbook | `https://docs.google.com/document/d/PLACEHOLDER` | Your Google Doc URL |
| Reimbursement Form | `https://docs.google.com/forms/d/PLACEHOLDER-REIMBURSEMENT` | Your Google Form URL |
| Liability Waiver | `https://docs.google.com/forms/d/PLACEHOLDER-WAIVER` | Your Google Form URL |
| Google Chat | `https://chat.google.com/room/PLACEHOLDER` | Your Chat space URL |
| Shared Drive | `https://drive.google.com/drive/folders/PLACEHOLDER` | Your Drive folder URL |
| Google Calendar | (iframe in members.html) | Your Google Calendar embed `<iframe>` |

### Schedule a Tour

The "Schedule a Tour" button on the public site currently links to `#schedule-tour`. Replace this with your Google Form URL for tour requests.

## Authentication

The members portal currently uses a simple client-side password check (`rootsandwings2026`). **This is not secure** and exists only for development/demo purposes.

For production, replace with proper authentication — recommended approach:
- **Firebase Authentication** with Google sign-in, restricting to your Google Workspace domain
- This allows members to log in with their Google accounts and avoids managing passwords

## Hosting

This is a fully static site. Recommended hosting options:
- **GitHub Pages** (free)
- **Netlify** (free tier available)
- **Google Sites** (if staying within Google ecosystem, though less customizable)
- **Cloudflare Pages** (free tier available)

## Fonts

The site uses Google Fonts (Playfair Display and Nunito), loaded from the Google Fonts CDN. No local font files needed.

## Testing

Before pushing to `master`, run the regression suite:

```bash
npm test
```

This runs, in order:

- **Tier 1a — syntax check** — `node --check` on `script.js` and every file under `api/` and `scripts/`.
- **Tier 1b — JSON parse** — `vercel.json`, `package.json`, and any manifest files.
- **Tier 1c — landmine grep** — patterns that have caused real bugs (e.g. `a.absence_id` in SQL, stray `debugger;`, `[coverage]` debug logs, unguarded reads of `localStorage.getItem('rw_user_email')` that would skip View As impersonation).
- **Tier 2 — unit tests** — `scripts/test-permissions.js`, `scripts/test-cleaning-seed.js`, `scripts/test-helpers.js`. No env vars required; no network calls.

Live-API scripts (`scripts/test-registration.js`, `scripts/test-tour-regression.js`) need `.env.local` and are **not** run by `npm test`. Run them manually before any risky change to the DB or tour/registration flow.

### Pre-push hook

A git hook at `.githooks/pre-push` runs `npm test` and blocks the push on failure. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

Use `git push --no-verify` to bypass (sparingly — intentional WIP branches only).

### Adding a new test

For a pure function: drop a new `scripts/test-<name>.js` next to the others, follow the existing `t(name, fn)` pattern, and add the path to `unitTests` in `scripts/regression.js`.

For a new landmine pattern: append an entry to the `landmines` array in `scripts/regression.js` with a `name`, `files`, `regex`, and (if the pattern has legitimate existing uses) an `allowedHits` high-water mark with a comment explaining each allowed call site.
