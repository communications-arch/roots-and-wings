// ── Shared auth: app session tokens + Google ID token verification ──
//
// Google ID tokens expire ~1 hour after sign-in, which forced members to
// re-sign-in constantly. To fix that, after a Google sign-in the client
// exchanges the Google token once at POST /api/session for a long-lived
// (30-day) *app session token* — a compact HS256 JWT signed with
// SESSION_SECRET — and then sends THAT as the Bearer on every API call.
//
// verifyBearer() accepts EITHER token type and returns a drop-in shim with
// the same `.getPayload()` shape as google-auth-library's verifyIdToken(),
// so each API file's existing verify logic keeps working with a one-line
// change. It throws on an invalid token, matching verifyIdToken's contract
// (callers already wrap it in try/catch). The Google fallback keeps old
// clients (still holding a Google token) working through the rollout.
//
// SAFETY: if SESSION_SECRET is unset, app-session verification/signing are
// disabled (verifyAppSession returns null, signSession throws) and the app
// transparently falls back to today's Google-token behavior — nothing breaks.

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_ISSUER = 'rw-portal';
const SESSION_TTL_SEC = 30 * 24 * 3600; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Mint a 30-day app session token from a verified identity.
function signSession(claims, ttlSec) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    email: claims.email || '',
    name: claims.name || '',
    given_name: claims.given_name || '',
    family_name: claims.family_name || '',
    iss: SESSION_ISSUER,
    iat: now,
    exp: now + (ttlSec || SESSION_TTL_SEC)
  };
  const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest());
  return data + '.' + sig;
}

// Verify an app session token. Returns the payload or null (never throws).
function verifyAppSession(token) {
  if (!SESSION_SECRET || !token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const data = parts[0] + '.' + parts[1];
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest());
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1])); } catch (e) { return null; }
  if (!payload || payload.iss !== SESSION_ISSUER) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

// Drop-in replacement for `oauthClient.verifyIdToken({ idToken, audience })`.
// Tries the app session token first (fast, no network), then falls back to a
// real Google ID token. Returns a ticket-shim { getPayload() }. THROWS on an
// invalid token so existing try/catch blocks behave exactly as before.
async function verifyBearer(rawToken) {
  const appPayload = verifyAppSession(rawToken);
  if (appPayload) return { getPayload: function () { return appPayload; } };
  // Not (or no longer) a valid app token — verify as a Google ID token.
  return await oauthClient.verifyIdToken({ idToken: rawToken, audience: GOOGLE_CLIENT_ID });
}

module.exports = {
  verifyBearer,
  verifyAppSession,
  signSession,
  GOOGLE_CLIENT_ID,
  SESSION_ENABLED: !!SESSION_SECRET
};
