// Absences API
//
// GET    /api/absences?session=N  → all non-cancelled absences for a session with coverage slots
// POST   /api/absences            → report an absence (creates coverage slots + notifications)
// DELETE /api/absences?id=N       → cancel an absence (soft-delete)

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { broadcastAll, sendToUser } = require('./_push');
const { canEditAsRole } = require('./_permissions');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: authHeader.slice(7), audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email || '';
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) return null;
    return { email, name: payload.name || '' };
  } catch (e) { return null; }
}

// VP resolved from the volunteer sheet — see api/coverage.js for notes.
function isVP(email) { return canEditAsRole(email, 'Vice President'); }

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

const VALID_BLOCKS = ['AM', 'PM1', 'PM2', 'Cleaning'];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();

    // ── GET: list absences for a session ──
    if (req.method === 'GET') {
      const session = parseInt(req.query.session, 10);
      if (!session) return res.status(400).json({ error: 'session query param required' });

      const absences = await sql`
        SELECT id, family_email, family_name, absent_person, session_number, absence_date,
               blocks, notes, created_by, created_at
        FROM absences
        WHERE session_number = ${session} AND cancelled_at IS NULL
        ORDER BY absence_date, absent_person
      `;
      const absenceIds = absences.map(a => a.id);
      let slots = [];
      if (absenceIds.length > 0) {
        slots = await sql`
          SELECT id, absence_id, block, role_type, role_description, group_or_class,
                 claimed_by_email, claimed_by_name, claimed_at, assigned_by
          FROM coverage_slots
          WHERE absence_id = ANY(${absenceIds})
          ORDER BY id
        `;
      }
      // Attach slots to absences
      const slotsByAbsence = {};
      slots.forEach(s => {
        if (!slotsByAbsence[s.absence_id]) slotsByAbsence[s.absence_id] = [];
        slotsByAbsence[s.absence_id].push(s);
      });
      absences.forEach(a => { a.slots = slotsByAbsence[a.id] || []; });

      return res.status(200).json({ absences });
    }

    // ── POST: report an absence ──
    if (req.method === 'POST') {
      const body = req.body || {};
      const absent_person = String(body.absent_person || '').trim();
      const family_email = String(body.family_email || '').trim();
      const family_name = String(body.family_name || '').trim();
      const session_number = parseInt(body.session_number, 10);
      const absence_date = String(body.absence_date || '').trim();
      const blocks = Array.isArray(body.blocks) ? body.blocks.filter(b => VALID_BLOCKS.includes(b)) : [];
      const slotsData = Array.isArray(body.slots) ? body.slots : [];
      const notes = String(body.notes || '').trim().slice(0, 500);

      if (!absent_person || !family_email || !family_name) {
        return res.status(400).json({ error: 'absent_person, family_email, and family_name required' });
      }
      if (!session_number || !absence_date || blocks.length === 0) {
        return res.status(400).json({ error: 'session_number, absence_date, and blocks required' });
      }
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(absence_date)) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      // Validate it's a Wednesday (co-op day)
      const dateObj = new Date(absence_date + 'T12:00:00');
      if (dateObj.getDay() !== 3) {
        return res.status(400).json({ error: 'absence_date must be a Wednesday' });
      }

      // Insert absence
      const inserted = await sql`
        INSERT INTO absences (family_email, family_name, absent_person, session_number, absence_date, blocks, notes, created_by)
        VALUES (${family_email}, ${family_name}, ${absent_person}, ${session_number}, ${absence_date}, ${blocks}, ${notes}, ${user.email})
        RETURNING id
      `;
      const absenceId = inserted[0].id;

      // Insert coverage slots
      for (const slot of slotsData) {
        const block = String(slot.block || '').trim();
        const role_type = String(slot.role_type || '').trim();
        const role_description = String(slot.role_description || '').trim();
        const group_or_class = String(slot.group_or_class || '').trim();
        if (!block || !role_type || !role_description) continue;
        await sql`
          INSERT INTO coverage_slots (absence_id, block, role_type, role_description, group_or_class)
          VALUES (${absenceId}, ${block}, ${role_type}, ${role_description}, ${group_or_class})
        `;
      }

      // Create notifications for all members
      const dateLabel = new Date(absence_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const slotCount = slotsData.length;
      const notifTitle = 'Coverage Needed — ' + dateLabel;
      const notifBody = absent_person + ' is out. ' + slotCount + ' slot' + (slotCount === 1 ? '' : 's') + ' need' + (slotCount === 1 ? 's' : '') + ' coverage.';

      // Get all unique member emails for broadcast notifications
      const allEmails = await sql`
        SELECT DISTINCT user_email FROM push_subscriptions
      `;
      // Also insert in-app notifications for all members who have push subs
      // (plus the absent person's family)
      const recipientEmails = new Set(allEmails.map(r => r.user_email));
      recipientEmails.add(family_email);
      for (const email of recipientEmails) {
        await sql`
          INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
          VALUES (${email}, 'coverage_needed', ${notifTitle}, ${notifBody}, '#coverage', ${absenceId})
        `;
      }

      // Send push notifications
      try {
        await broadcastAll(sql, {
          title: notifTitle,
          body: notifBody,
          tag: 'coverage-' + absenceId,
          url: '/members.html#coverage'
        });
      } catch (pushErr) {
        console.error('Push broadcast error:', pushErr);
      }

      // Return the full absence with slots
      const full = await sql`SELECT * FROM absences WHERE id = ${absenceId}`;
      const fullSlots = await sql`SELECT * FROM coverage_slots WHERE absence_id = ${absenceId} ORDER BY id`;
      const result = full[0];
      result.slots = fullSlots;
      return res.status(201).json({ absence: result });
    }

    // ── DELETE: cancel an absence ──
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const existing = await sql`SELECT id, created_by, family_email FROM absences WHERE id = ${id} AND cancelled_at IS NULL`;
      if (existing.length === 0) return res.status(404).json({ error: 'Absence not found' });

      // Only original creator or VP can cancel
      if (existing[0].created_by !== user.email && existing[0].family_email !== user.email && !(await isVP(user.email))) {
        return res.status(403).json({ error: 'Not authorized to cancel this absence' });
      }

      await sql`UPDATE absences SET cancelled_at = NOW() WHERE id = ${id}`;
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Absences API error:', err);
    if (err.message && err.message.includes('unique')) {
      return res.status(409).json({ error: 'An absence already exists for this person on this date' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
};
