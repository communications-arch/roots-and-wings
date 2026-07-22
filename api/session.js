// Session exchange endpoint.
//
// POST /api/session  (Authorization: Bearer <google-id-token OR app-session-token>)
//   → { token, email, name }   a fresh 30-day app session token
//
// Called right after a Google sign-in to swap the short-lived (~1h) Google ID
// token for a long-lived app session token, and again periodically to slide
// the 30-day window forward so active members effectively never get signed
// out. Accepts an existing app token too (so the sliding refresh doesn't need
// a live Google session). Restricted to @rootsandwingsindy.com identities.
//
// If SESSION_SECRET isn't configured, signing throws and we return 501 — the
// client then simply keeps using the Google token (today's behavior), so a
// missing env var degrades gracefully instead of breaking sign-in.
//
// #88 (Safari sign-in loop): ALSO the login_uri receiver for GIS
// ux_mode:'redirect'. Google form-POSTs { credential, g_csrf_token }
// here after a full-page sign-in — no popup, so Safari ITP can't eat
// the hand-back. We verify the ID token server-side, mint the 30-day
// app token, and reply with a tiny page that stores the session in
// localStorage and bounces to /members.html. The URIs are registered
// as Authorized redirect URIs on the OAuth client (Erin, 2026-07-22).

const { ALLOWED_ORIGINS } = require('./_config');
const { verifyBearer, signSession, SESSION_ENABLED } = require('./_auth');

const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

function gisRedirectPage(res, script) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(
    '<!doctype html><html><head><meta charset="utf-8"><title>Signing you in…</title>'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
    + '<body style="font-family:sans-serif;padding:40px;text-align:center;color:#333;">'
    + '<p>Signing you in…</p><script>' + script + '</scr' + 'ipt>'
    + '<noscript><a href="/members.html">Continue to the Member Portal</a></noscript>'
    + '</body></html>'
  );
}

async function handleGisRedirectPost(req, res) {
  const body = req.body || {};
  const credential = String(body.credential || '');
  const bodyCsrf = String(body.g_csrf_token || '');
  // Double-submit CSRF per Google's guidance: the cookie GIS set on our
  // domain must match the posted value WHEN the browser sends it (a
  // cross-site top-level POST can drop SameSite=Lax cookies — in that
  // case the verified Google signature on the token is the real gate;
  // a mismatch when both are present is always rejected).
  const cookieCsrf = (String(req.headers.cookie || '').match(/(?:^|;\s*)g_csrf_token=([^;]+)/) || [])[1] || '';
  if (!bodyCsrf || (cookieCsrf && cookieCsrf !== bodyCsrf)) {
    return gisRedirectPage(res, 'location.replace("/members.html#signin-failed");');
  }
  try {
    const ticket = await verifyBearer(credential);
    const payload = ticket.getPayload();
    const email = String(payload.email || '');
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) {
      return gisRedirectPage(res, 'location.replace("/members.html#signin-wrong-account");');
    }
    // Prefer the 30-day app token; fall back to the Google credential
    // itself if session signing isn't configured (same degradation as
    // the JSON path below).
    let storeToken = credential;
    if (SESSION_ENABLED) {
      try {
        storeToken = signSession({
          email: email,
          name: payload.name || '',
          given_name: payload.given_name || '',
          family_name: payload.family_name || ''
        });
      } catch (e) { /* keep the Google credential */ }
    }
    return gisRedirectPage(res,
      'try{'
      + 'localStorage.setItem("rw_member_auth","true");'
      + 'localStorage.setItem("rw_user_email",' + JSON.stringify(email) + ');'
      + 'localStorage.setItem("rw_google_credential",' + JSON.stringify(storeToken) + ');'
      + '}catch(e){}'
      + 'location.replace("/members.html");'
    );
  } catch (e) {
    return gisRedirectPage(res, 'location.replace("/members.html#signin-failed");');
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // GIS redirect-mode receiver (#88): Google posts form-encoded with a
  // `credential` field and no Authorization header.
  if (String(req.headers['content-type'] || '').indexOf('application/x-www-form-urlencoded') !== -1
      && req.body && req.body.credential) {
    return handleGisRedirectPost(req, res);
  }

  if (!SESSION_ENABLED) {
    // No secret configured — tell the client to keep its Google token.
    return res.status(501).json({ error: 'Session tokens not enabled' });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No credentials provided' });
  }

  try {
    const ticket = await verifyBearer(authHeader.slice(7));
    const payload = ticket.getPayload();
    const email = String(payload.email || '');
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }
    const token = signSession({
      email: email,
      name: payload.name || '',
      given_name: payload.given_name || '',
      family_name: payload.family_name || ''
    });
    return res.status(200).json({ token: token, email: email, name: payload.name || '' });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
};
