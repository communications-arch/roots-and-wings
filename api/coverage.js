// Coverage API
//
// POST   /api/coverage         → claim a slot
// PATCH  /api/coverage?id=N    → VP reassign a slot
// DELETE /api/coverage?id=N    → unclaim a slot

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { sendToUser } = require('./_push');
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

// VP is resolved from the volunteer sheet ("Chair: Vice President - <name>"),
// so Colleen's personal @rootsandwingsindy.com login authorizes automatically
// — no env var update needed when the role changes hands.
function isVP(email) { return canEditAsRole(email, 'Vice President'); }

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();

    // ── POST: claim a slot ──
    if (req.method === 'POST') {
      const slotId = parseInt((req.body || {}).slot_id, 10);
      if (!slotId) return res.status(400).json({ error: 'slot_id required' });

      // Check slot exists and is unclaimed
      const slot = await sql`
        SELECT cs.*, a.family_email AS absent_family_email, a.absent_person, a.absence_date
        FROM coverage_slots cs
        JOIN absences a ON a.id = cs.absence_id
        WHERE cs.id = ${slotId} AND a.cancelled_at IS NULL
      `;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });
      if (slot[0].claimed_by_email) return res.status(409).json({ error: 'Slot already claimed' });

      const claimerName = String((req.body || {}).claimer_name || user.name || '').trim();

      await sql`
        UPDATE coverage_slots
        SET claimed_by_email = ${user.email}, claimed_by_name = ${claimerName}, claimed_at = NOW()
        WHERE id = ${slotId}
      `;

      // Notify the absent person
      const dateLabel = new Date(slot[0].absence_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const notifTitle = 'Slot Covered — ' + dateLabel;
      const notifBody = claimerName + ' is covering: ' + slot[0].role_description;

      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
        VALUES (${slot[0].absent_family_email}, 'slot_claimed', ${notifTitle}, ${notifBody}, '#coverage', ${slot[0].absence_id})
      `;
      try {
        await sendToUser(sql, slot[0].absent_family_email, {
          title: notifTitle, body: notifBody, tag: 'claimed-' + slotId, url: '/members.html#coverage'
        });
      } catch (e) { console.error('Push error:', e); }

      return res.status(200).json({ ok: true, slot_id: slotId });
    }

    // ── PATCH: VP reassign ──
    if (req.method === 'PATCH') {
      if (!(await isVP(user.email))) return res.status(403).json({ error: 'Only the VP can reassign slots' });

      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const body = req.body || {};
      const newEmail = String(body.claimed_by_email || '').trim();
      const newName = String(body.claimed_by_name || '').trim();

      const slot = await sql`
        SELECT cs.*, a.absence_date, a.absence_id
        FROM coverage_slots cs
        JOIN absences a ON a.id = cs.absence_id
        WHERE cs.id = ${id}
      `;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });

      if (newEmail) {
        await sql`
          UPDATE coverage_slots
          SET claimed_by_email = ${newEmail}, claimed_by_name = ${newName}, claimed_at = NOW(), assigned_by = ${user.email}
          WHERE id = ${id}
        `;
        // Notify the new assignee
        const dateLabel = new Date(slot[0].absence_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        await sql`
          INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
          VALUES (${newEmail}, 'slot_reassigned', ${'Assigned to Cover — ' + dateLabel}, ${'VP assigned you to: ' + slot[0].role_description}, '#coverage', ${slot[0].absence_id})
        `;
        try {
          await sendToUser(sql, newEmail, {
            title: 'Assigned to Cover — ' + dateLabel,
            body: 'VP assigned you to: ' + slot[0].role_description,
            tag: 'reassign-' + id, url: '/members.html#coverage'
          });
        } catch (e) { console.error('Push error:', e); }
      } else {
        // Unassign
        await sql`
          UPDATE coverage_slots
          SET claimed_by_email = NULL, claimed_by_name = NULL, claimed_at = NULL, assigned_by = NULL
          WHERE id = ${id}
        `;
      }

      return res.status(200).json({ ok: true, id });
    }

    // ── DELETE: unclaim a slot ──
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const slot = await sql`SELECT * FROM coverage_slots WHERE id = ${id}`;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });

      // Only the claimer or VP can unclaim
      if (slot[0].claimed_by_email !== user.email && !(await isVP(user.email))) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      await sql`
        UPDATE coverage_slots
        SET claimed_by_email = NULL, claimed_by_name = NULL, claimed_at = NULL, assigned_by = NULL
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Coverage API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
