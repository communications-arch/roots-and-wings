// Supply Closet Inventory API
//
// GET  /api/supply-closet              → all items grouped by category
// POST /api/supply-closet               → add an item     (auth required)
// PATCH /api/supply-closet?id=N         → update an item  (auth required)
// DELETE /api/supply-closet?id=N        → delete an item  (auth required)
//
// Authorization:
//   - GET: any authenticated @rootsandwingsindy.com Google user
//   - POST/PATCH/DELETE: only whoever is named as "Supply Coordinator" in
//     the volunteer-committees tab of the master sheet, OR the
//     communications@ super user. See api/_permissions.js — coordinator
//     identity is looked up live from the sheet (cached 5 min) so no env
//     var needs updating when the role changes hands.

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole } = require('./_permissions');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const VALID_CATEGORIES = ['permanent', 'currently_available', 'classroom_cabinet', 'game_closet'];

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = payload.email || '';
    const domain = email.split('@')[1] || '';
    if (domain !== ALLOWED_DOMAIN) return null;
    return { email: email, name: payload.name || '' };
  } catch (e) {
    return null;
  }
}

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured');
  }
  return neon(process.env.DATABASE_URL);
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Write operations are restricted to the Supply Coordinator or the
  // communications@ super user. GET stays open to any authenticated member.
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    const allowed = await canEditAsRole(user.email, 'Supply Coordinator');
    if (!allowed) {
      return res.status(403).json({ error: 'Only the Supply Coordinator can modify the supply closet.' });
    }
  }

  try {
    const sql = getSql();

    // ── Supply Locations (action=locations) ──
    // MUST be handled before the generic method branches below, otherwise
    // GET /api/supply-closet?action=locations falls into the item list
    // handler and the frontend gets undefined locations.
    if (req.query.action === 'locations') {
      if (req.method === 'GET') {
        const rows = await sql`SELECT id, name, sort_order FROM supply_locations ORDER BY sort_order, name`;
        return res.status(200).json({ locations: rows });
      }
      if (req.method === 'POST') {
        const name = String((req.body && req.body.name) || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        if (name.length > 200) return res.status(400).json({ error: 'name too long' });
        const maxOrder = await sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM supply_locations`;
        const inserted = await sql`INSERT INTO supply_locations (name, sort_order) VALUES (${name}, ${maxOrder[0].next}) RETURNING id, name, sort_order`;
        return res.status(201).json({ location: inserted[0] });
      }
      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const name = String((req.body && req.body.name) || '').trim();
        if (!name) return res.status(400).json({ error: 'name is required' });
        const old = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
        if (old.length === 0) return res.status(404).json({ error: 'Not found' });
        const updated = await sql`UPDATE supply_locations SET name = ${name} WHERE id = ${id} RETURNING id, name, sort_order`;
        if (old[0].name !== name) await sql`UPDATE supply_closet SET location = ${name} WHERE location = ${old[0].name}`;
        return res.status(200).json({ location: updated[0] });
      }
      if (req.method === 'DELETE') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const toDelete = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
        if (toDelete.length) await sql`UPDATE supply_closet SET location = '' WHERE location = ${toDelete[0].name}`;
        const deleted = await sql`DELETE FROM supply_locations WHERE id = ${id} RETURNING id`;
        if (deleted.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, item_name, location, category, notes, sort_order, updated_at, updated_by
        FROM supply_closet
        ORDER BY category, sort_order, item_name
      `;
      const grouped = { permanent: [], currently_available: [], classroom_cabinet: [], game_closet: [] };
      rows.forEach(r => {
        if (grouped[r.category]) grouped[r.category].push(r);
      });
      return res.status(200).json({ items: grouped });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const item_name = String(body.item_name || '').trim();
      const location = String(body.location || '').trim();
      const category = String(body.category || '').trim();
      const notes = String(body.notes || '').trim();

      if (!item_name) return res.status(400).json({ error: 'item_name is required' });
      if (VALID_CATEGORIES.indexOf(category) === -1) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      if (item_name.length > 200 || location.length > 200 || notes.length > 500) {
        return res.status(400).json({ error: 'Field too long' });
      }

      const inserted = await sql`
        INSERT INTO supply_closet (item_name, location, category, notes, updated_by)
        VALUES (${item_name}, ${location}, ${category}, ${notes}, ${user.email})
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by
      `;
      return res.status(201).json({ item: inserted[0] });
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });
      const body = req.body || {};
      const item_name = String(body.item_name || '').trim();
      const location = String(body.location || '').trim();
      const category = String(body.category || '').trim();
      const notes = String(body.notes || '').trim();

      if (!item_name) return res.status(400).json({ error: 'item_name is required' });
      if (VALID_CATEGORIES.indexOf(category) === -1) {
        return res.status(400).json({ error: 'Invalid category' });
      }
      if (item_name.length > 200 || location.length > 200 || notes.length > 500) {
        return res.status(400).json({ error: 'Field too long' });
      }

      const updated = await sql`
        UPDATE supply_closet
        SET item_name = ${item_name},
            location = ${location},
            category = ${category},
            notes = ${notes},
            updated_at = NOW(),
            updated_by = ${user.email}
        WHERE id = ${id}
        RETURNING id, item_name, location, category, notes, sort_order, updated_at, updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ item: updated[0] });
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });

      const deleted = await sql`DELETE FROM supply_closet WHERE id = ${id} RETURNING id`;
      if (deleted.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ ok: true, id: deleted[0].id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Supply closet API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
