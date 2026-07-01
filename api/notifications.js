// Notifications API
//
// GET   /api/notifications                    → list notifications for current user
// PATCH /api/notifications?id=N               → mark one as read
// PATCH /api/notifications?mark_all_read=true → mark all as read

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { isSuperUser } = require('./_permissions');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();
    const recipient = resolveRecipient(user, req.query.view_as);

    if (req.method === 'GET') {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const unreadOnly = req.query.unread_only === 'true';
      let rows;
      if (unreadOnly) {
        rows = await sql`
          SELECT id, type, title, body, link_url, related_absence_id, is_read, created_at
          FROM notifications
          WHERE recipient_email = ${recipient} AND is_read = FALSE
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      } else {
        rows = await sql`
          SELECT id, type, title, body, link_url, related_absence_id, is_read, created_at
          FROM notifications
          WHERE recipient_email = ${recipient}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
      }
      const unreadCount = await sql`
        SELECT COUNT(*)::int AS count FROM notifications
        WHERE recipient_email = ${recipient} AND is_read = FALSE
      `;
      return res.status(200).json({ notifications: rows, unread_count: unreadCount[0].count });
    }

    if (req.method === 'PATCH') {
      if (req.query.mark_all_read === 'true') {
        await sql`
          UPDATE notifications SET is_read = TRUE
          WHERE recipient_email = ${recipient} AND is_read = FALSE
        `;
        return res.status(200).json({ ok: true });
      }
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id required' });
      await sql`
        UPDATE notifications SET is_read = TRUE
        WHERE id = ${id} AND recipient_email = ${recipient}
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Notifications API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
