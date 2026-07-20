// Push API — cron reminder + subscription management in ONE function.
//
// GET    /api/push-send      → morning-of reminder cron (Vercel Cron, 7 AM ET Wednesdays)
// POST   /api/push-send      → save a push subscription
// DELETE /api/push-send      → remove a push subscription
//
// POST/DELETE used to live in api/push-subscribe.js; merged 2026-07-20 when
// Vercel began hard-enforcing the 12-function Hobby ceiling at deploy time
// (errorCode exceeded_serverless_functions_per_deployment — we were 13).
// A vercel.json rewrite keeps the public /api/push-subscribe URL working,
// so the client and installed PWAs never noticed. The methods don't
// overlap: the cron is GET-only, subscriptions are POST/DELETE.

const { neon } = require('@neondatabase/serverless');
const { broadcastAll } = require('./_push');
const { ALLOWED_ORIGINS } = require('./_config');
const { verifyBearer } = require('./_auth');

const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

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

// ── Subscription management (POST/DELETE, member-authed) ──
async function handleSubscription(req, res) {
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

    // DELETE — scope to the caller (2026-07-17 review): an unscoped
    // delete-by-endpoint let anyone who learned another member's endpoint
    // silently unsubscribe them. Server-side dead-endpoint cleanup
    // (api/_push.js) still prunes by bare endpoint by design.
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_email = ${user.email}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Push subscribe API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Morning-of reminder cron (GET) ──
async function handleCron(req, res) {
  // Cron-only endpoint: without a gate ANYONE could curl it and fire a push
  // broadcast + notification insert for every member (2026-07-17 review).
  // Mirror api/tour.js handleReconcileCron exactly: accept Vercel cron's
  // `User-Agent: vercel-cron/...` (works even when CRON_SECRET isn't set)
  // OR an explicit bearer secret for manual runs. A plain anonymous curl
  // has neither → 401.
  const ua = String(req.headers['user-agent'] || '');
  const isVercelCron = ua.indexOf('vercel-cron') !== -1;
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = String(req.headers['authorization'] || '');
  const hasSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sql = getSql();

    // Get today's date in ET (UTC-5 or UTC-4 depending on DST)
    const now = new Date();
    // Approximate ET by subtracting 5 hours; for DST accuracy, use a proper TZ library in production
    const et = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const today = et.toISOString().slice(0, 10);

    // Find uncovered slots for today
    const openSlots = await sql`
      SELECT cs.id, cs.role_description, cs.block, a.absent_person
      FROM coverage_slots cs
      JOIN absences a ON a.id = cs.absence_id
      WHERE a.absence_date = ${today}
        AND a.cancelled_at IS NULL
        AND cs.claimed_by_email IS NULL
    `;

    if (openSlots.length === 0) {
      return res.status(200).json({ message: 'No open slots today', date: today });
    }

    const title = openSlots.length + ' slot' + (openSlots.length === 1 ? '' : 's') + ' still need coverage today!';
    const body = openSlots.map(s => s.block + ': ' + s.role_description).join(', ');

    // Insert morning_reminder notifications for all subscribed users
    const allSubs = await sql`SELECT DISTINCT user_email FROM push_subscriptions`;
    for (const sub of allSubs) {
      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url)
        VALUES (${sub.user_email}, 'morning_reminder', ${title}, ${body}, '#coverage')
      `;
    }

    // Broadcast push
    await broadcastAll(sql, {
      title: title,
      body: body,
      tag: 'morning-' + today,
      url: '/members.html#coverage'
    });

    return res.status(200).json({ message: 'Sent reminders', open_slots: openSlots.length, date: today });
  } catch (err) {
    console.error('Push-send cron error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') return handleCron(req, res);
  if (req.method === 'POST' || req.method === 'DELETE') return handleSubscription(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};
