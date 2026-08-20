// Notifications API
//
// GET   /api/notifications                    → list notifications for current user
// PATCH /api/notifications?id=N               → mark one as read
// PATCH /api/notifications?mark_all_read=true → mark all as read
// DELETE /api/notifications?id=N               → remove one (own only) — #83
// DELETE /api/notifications?clear_read=true    → remove all READ ones — #83
// POST  /api/notifications?test_push=1        → send the CALLER a test push,
//                                               return per-device results

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { isSuperUser, notificationIdentities } = require('./_permissions');
const { sendToUser } = require('./_push');
const { sweepTodos } = require('./_todos');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

// If the real signed-in user is a super user (communications@ /
// vicepresident@) and they've asked to view as another
// @rootsandwingsindy.com member (via ?view_as=), return that email;
// otherwise return the real user's email. Mirrors the dashboard View
// As pattern so super users can triage notifications on behalf of
// whoever they're helping.
function resolveRecipient(user, viewAsQuery) {
  if (!isSuperUser(user.email)) return user.email;
  var va = (viewAsQuery || '').toString().trim().toLowerCase();
  if (!va) return user.email;
  if ((va.split('@')[1] || '') !== ALLOWED_DOMAIN) return user.email;
  return va;
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

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // #368 daily safety-net sweep of EVERY registered To Do kind (date-gated
  // items and anything a mutation hook missed). Same cron gate as
  // push-send / tour reconcile: CRON_SECRET bearer when set, else the
  // vercel-cron UA. Runs before member auth.
  if (req.method === 'GET' && req.query.cron === 'todo-sweep') {
    const ua = String(req.headers['user-agent'] || '');
    const cronSecret = process.env.CRON_SECRET || '';
    const authHeader = String(req.headers['authorization'] || '');
    const ok = cronSecret ? authHeader === `Bearer ${cronSecret}` : ua.indexOf('vercel-cron') !== -1;
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await sweepTodos(getSql());
      return res.status(200).json(Object.assign({ ok: true }, result));
    } catch (err) {
      console.error('todo-sweep cron error:', err);
      return res.status(500).json({ error: 'Sweep failed' });
    }
  }

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();
    const recipient = resolveRecipient(user, req.query.view_as);
    // #363: a member reaches the portal under more than one address (own
    // login, family alias, role mailbox) and notifications get addressed to
    // whichever the sender knew — read/mark/delete across the whole set.
    // Broadcasts already write one row per address, so twins (same type/
    // title/body/link within the hour) collapse to one bell entry — the
    // unread one first, then the copy addressed to this login — and
    // mark-read / delete act on all twins together.
    const ids = await notificationIdentities(sql, recipient);
    const loginLc = String(recipient || '').toLowerCase();

    if (req.method === 'GET') {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const unreadOnly = req.query.unread_only === 'true';
      let rows;
      if (unreadOnly) {
        rows = await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (type, title, body, link_url, date_trunc('hour', created_at))
                   id, type, title, body, link_url, related_absence_id, is_read, created_at
            FROM notifications
            WHERE LOWER(recipient_email) = ANY(${ids}::text[]) AND is_read = FALSE
            ORDER BY type, title, body, link_url, date_trunc('hour', created_at),
                     (LOWER(recipient_email) = ${loginLc}) DESC, created_at
          ) d ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else {
        rows = await sql`
          SELECT * FROM (
            SELECT DISTINCT ON (type, title, body, link_url, date_trunc('hour', created_at))
                   id, type, title, body, link_url, related_absence_id, is_read, created_at
            FROM notifications
            WHERE LOWER(recipient_email) = ANY(${ids}::text[])
            ORDER BY type, title, body, link_url, date_trunc('hour', created_at),
                     is_read ASC, (LOWER(recipient_email) = ${loginLc}) DESC, created_at
          ) d ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      }
      const unreadCount = await sql`
        SELECT COUNT(*)::int AS count FROM (
          SELECT DISTINCT type, title, body, link_url, date_trunc('hour', created_at)
          FROM notifications
          WHERE LOWER(recipient_email) = ANY(${ids}::text[]) AND is_read = FALSE
        ) d
      `;
      return res.status(200).json({ notifications: rows, unread_count: unreadCount[0].count });
    }

    if (req.method === 'PATCH') {
      if (req.query.mark_all_read === 'true') {
        await sql`
          UPDATE notifications SET is_read = TRUE
          WHERE LOWER(recipient_email) = ANY(${ids}::text[]) AND is_read = FALSE
        `;
        return res.status(200).json({ ok: true });
      }
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });
      await sql`
        UPDATE notifications n SET is_read = TRUE
        FROM notifications t
        WHERE t.id = ${id} AND LOWER(t.recipient_email) = ANY(${ids}::text[])
          AND LOWER(n.recipient_email) = ANY(${ids}::text[])
          AND n.type IS NOT DISTINCT FROM t.type AND n.title IS NOT DISTINCT FROM t.title
          AND n.body IS NOT DISTINCT FROM t.body AND n.link_url IS NOT DISTINCT FROM t.link_url
          AND date_trunc('hour', n.created_at) = date_trunc('hour', t.created_at)
      `;
      return res.status(200).json({ ok: true });
    }

    // #83 (Erin): clear notifications after reading them. Scoped to the
    // recipient's own rows; clear_read sweeps everything already read.
    if (req.method === 'DELETE') {
      if (req.query.clear_read === 'true') {
        await sql`
          DELETE FROM notifications
          WHERE LOWER(recipient_email) = ANY(${ids}::text[]) AND is_read = TRUE
        `;
        return res.status(200).json({ ok: true });
      }
      const delId = parseInt(req.query.id, 10);
      if (!delId || Number.isNaN(delId)) return res.status(400).json({ error: 'id required' });
      await sql`
        DELETE FROM notifications n
        USING notifications t
        WHERE t.id = ${delId} AND LOWER(t.recipient_email) = ANY(${ids}::text[])
          AND LOWER(n.recipient_email) = ANY(${ids}::text[])
          AND n.type IS NOT DISTINCT FROM t.type AND n.title IS NOT DISTINCT FROM t.title
          AND n.body IS NOT DISTINCT FROM t.body AND n.link_url IS NOT DISTINCT FROM t.link_url
          AND date_trunc('hour', n.created_at) = date_trunc('hour', t.created_at)
      `;
      return res.status(200).json({ ok: true });
    }

    // Push self-test (2026-08-05, "notifications aren't working for most
    // people"): sends a real push to the CALLER's own devices — never the
    // View-As target — and reports per-device results so a member (or Erin
    // helping one) can see exactly why nothing arrives. Non-prod deploys
    // have no VAPID keys (Production-scoped env), so name that state
    // instead of returning a silent no-op.
    if (req.method === 'POST' && req.query.test_push === '1') {
      if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        return res.status(200).json({ ok: false, reason: 'no_vapid', message: 'Push is not configured on this deployment (dev/preview has no VAPID keys).' });
      }
      // Also drop a real row in the bell list: when the app is foregrounded
      // Android delivers the push tray-only, so the list entry (and its
      // badge bump) is the visible proof the test arrived.
      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url)
        VALUES (${user.email}, 'push_test', 'Test notification', 'If you can read this, push notifications are working.', '')
      `;
      const results = await sendToUser(sql, user.email, {
        title: 'Test notification',
        body: 'If you can read this, push notifications are working on this device.',
        tag: 'push-self-test',
        url: '/members.html'
      }) || [];
      const delivered = results.filter(r => r.ok).length;
      return res.status(200).json({
        ok: delivered > 0,
        devices: results.length,
        delivered,
        removed_dead: results.filter(r => r.removed).length,
        failures: results.filter(r => !r.ok).map(r => ({ statusCode: r.statusCode, removed: !!r.removed }))
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Notifications API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
