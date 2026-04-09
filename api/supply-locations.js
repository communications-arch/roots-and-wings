// Supply Storage Locations API
//
// GET    /api/supply-locations          → all locations ordered by sort_order
// POST   /api/supply-locations          → add a location        (auth required)
// PATCH  /api/supply-locations?id=N     → rename a location     (auth required)
// DELETE /api/supply-locations?id=N     → delete a location     (auth required)

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

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

  try {
    const sql = getSql();

    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, name, sort_order FROM supply_locations ORDER BY sort_order, name
      `;
      return res.status(200).json({ locations: rows });
    }

    if (req.method === 'POST') {
      const name = String((req.body && req.body.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.length > 200) return res.status(400).json({ error: 'name too long' });

      // Put new items at the end
      const maxOrder = await sql`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM supply_locations`;
      const inserted = await sql`
        INSERT INTO supply_locations (name, sort_order)
        VALUES (${name}, ${maxOrder[0].next})
        RETURNING id, name, sort_order
      `;
      return res.status(201).json({ location: inserted[0] });
    }

    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });
      const name = String((req.body && req.body.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.length > 200) return res.status(400).json({ error: 'name too long' });

      // Get old name first so we can update supply_closet references
      const old = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
      if (old.length === 0) return res.status(404).json({ error: 'Location not found' });
      const oldName = old[0].name;

      const updated = await sql`
        UPDATE supply_locations SET name = ${name} WHERE id = ${id}
        RETURNING id, name, sort_order
      `;

      // Update any supply_closet items referencing the old name
      if (oldName !== name) {
        await sql`UPDATE supply_closet SET location = ${name} WHERE location = ${oldName}`;
      }

      return res.status(200).json({ location: updated[0] });
    }

    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'id query param required' });

      // Clear location on any supply_closet items using this location
      const toDelete = await sql`SELECT name FROM supply_locations WHERE id = ${id}`;
      if (toDelete.length) {
        await sql`UPDATE supply_closet SET location = '' WHERE location = ${toDelete[0].name}`;
      }

      const deleted = await sql`DELETE FROM supply_locations WHERE id = ${id} RETURNING id`;
      if (deleted.length === 0) return res.status(404).json({ error: 'Location not found' });
      return res.status(200).json({ ok: true, id: deleted[0].id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Supply locations API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
