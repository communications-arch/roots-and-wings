// Push Subscription API
//
// POST   /api/push-subscribe  → save a push subscription
// DELETE /api/push-subscribe  → remove a push subscription

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await verifyBearer(authHeader.slice(7));
    const payload = ticket.getPayload();
    const email = payload.email || '';
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) return null;
    return { email, name: payload.name || '' };
  } catch (e) { return null; }
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();
    const body = req.body || {};

    if (req.method === 'POST') {
      const endpoint = String(body.endpoint || '').trim();
      const p256dh = String((body.keys && body.keys.p256dh) || '').trim();
      const auth = String((body.keys && body.keys.auth) || '').trim();
      if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Missing subscription fields' });

      await sql`
        INSERT INTO push_subscriptions (user_email, endpoint, p256dh, auth)
        VALUES (${user.email}, ${endpoint}, ${p256dh}, ${auth})
        ON CONFLICT (endpoint) DO UPDATE SET user_email = ${user.email}, p256dh = ${p256dh}, auth = ${auth}
      `;
      return res.status(201).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const endpoint = String(body.endpoint || '').trim();
      if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
      // Scope to the caller (2026-07-17 review): an unscoped delete-by-
      // endpoint let anyone who learned another member's endpoint silently
      // unsubscribe them. Server-side dead-endpoint cleanup (api/_push.js)
      // still prunes by bare endpoint by design.
      await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_email = ${user.email}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Push subscribe API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
