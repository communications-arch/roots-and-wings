// Shared configuration for /api/* endpoints.
// Underscore prefix prevents Vercel from exposing this as a route.

// Allowed origins for CORS. Same-origin requests (page and API on the
// same Vercel domain) don't need to match this list — it only matters
// for cross-origin callers (custom domains, local dev, etc.).
const ALLOWED_ORIGINS = [
  'https://roots-and-wings-topaz.vercel.app',
  'https://register.rootsandwingsindy.com'
  // Add the apex (rootsandwingsindy.com) here when that domain is added
  // to the Vercel project.
];

// Subject-line prefix for outbound email. VERCEL_ENV is 'production' on
// the prod deployment, 'preview' on preview deployments, 'development'
// under `vercel dev`. Anything that isn't prod gets a [TEST] prefix so
// recipients (especially membership@) can tell a dev-test email apart
// from a real one at a glance.
function emailSubject(subject) {
  return (process.env.VERCEL_ENV === 'production')
    ? subject
    : '[TEST] ' + subject;
}

// Current waiver version label. Stamped onto every new waiver_signatures row
// at sign time. Bump this any time the text in waiver.html / register.html
// changes materially, and snapshot the prior version into /waivers/<old>.html
// so old signatures still resolve to the exact text that was agreed to.
const WAIVER_VERSION = '2026-05-22';

module.exports = { ALLOWED_ORIGINS, emailSubject, WAIVER_VERSION };
