// Cleaning Crew Management + Role Descriptions API
//
// GET    /api/cleaning                          → all areas, assignments, config
// POST   /api/cleaning?action=assignment        → add an assignment
// PATCH  /api/cleaning?action=assignment&id=N   → update an assignment
// DELETE /api/cleaning?action=assignment&id=N   → remove an assignment
// PATCH  /api/cleaning?action=area&id=N         → update area name/tasks
// POST   /api/cleaning?action=area              → add a new area
// DELETE /api/cleaning?action=area&id=N         → remove an area (cascades)
// PATCH  /api/cleaning?action=config            → update liaison name
// GET    /api/cleaning?action=roles             → all role descriptions
// PATCH  /api/cleaning?action=roles&id=N        → update a role description

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const VALID_FLOORS = ['mainFloor', 'upstairs', 'outside', 'floater'];

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
    return { email, name: payload.name || '' };
  } catch (e) {
    return null;
  }
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
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
    const action = req.query.action || '';

    // ── GET: return everything ──
    if (req.method === 'GET' && action !== 'roles') {
      const areas = await sql`
        SELECT id, floor_key, area_name, tasks, sort_order
        FROM cleaning_areas ORDER BY sort_order, id
      `;
      const assignments = await sql`
        SELECT ca.id, ca.session_number, ca.cleaning_area_id, ca.family_name, ca.sort_order,
               a.floor_key, a.area_name
        FROM cleaning_assignments ca
        JOIN cleaning_areas a ON a.id = ca.cleaning_area_id
        ORDER BY ca.session_number, a.sort_order, ca.sort_order
      `;
      const config = await sql`SELECT liaison_name FROM cleaning_config WHERE id = 1`;

      // Build sessions object matching CLEANING_CREW shape
      const sessions = {};
      assignments.forEach(a => {
        const s = a.session_number;
        if (!sessions[s]) sessions[s] = { mainFloor: {}, upstairs: {}, outside: {} };
        if (a.floor_key === 'floater') {
          if (!sessions[s].floater) sessions[s].floater = [];
          sessions[s].floater.push(a.family_name);
        } else {
          if (!sessions[s][a.floor_key]) sessions[s][a.floor_key] = {};
          if (!sessions[s][a.floor_key][a.area_name]) sessions[s][a.floor_key][a.area_name] = [];
          sessions[s][a.floor_key][a.area_name].push(a.family_name);
        }
      });

      return res.status(200).json({
        liaison: (config[0] && config[0].liaison_name) || '',
        areas,
        assignments,
        sessions
      });
    }

    // ── Role Descriptions ──
    if (action === 'roles') {
      if (req.method === 'GET') {
        const roles = await sql`
          SELECT id, role_key, title, job_length, overview, duties, committee,
                 last_reviewed_by, last_reviewed_date, playbook, updated_at, updated_by
          FROM role_descriptions ORDER BY title
        `;
        return res.status(200).json({ roles });
      }

      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const { overview, duties, job_length, last_reviewed_by, last_reviewed_date, playbook } = req.body || {};
        if (overview === undefined && duties === undefined && job_length === undefined
            && last_reviewed_by === undefined && last_reviewed_date === undefined
            && playbook === undefined) {
          return res.status(400).json({ error: 'No fields to update' });
        }
        if (overview !== undefined) {
          await sql`UPDATE role_descriptions SET overview = ${String(overview)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (job_length !== undefined) {
          await sql`UPDATE role_descriptions SET job_length = ${String(job_length)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (last_reviewed_by !== undefined) {
          await sql`UPDATE role_descriptions SET last_reviewed_by = ${String(last_reviewed_by)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (last_reviewed_date !== undefined) {
          await sql`UPDATE role_descriptions SET last_reviewed_date = ${String(last_reviewed_date)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (duties !== undefined) {
          const dutiesArr = Array.isArray(duties) ? duties.map(d => String(d).trim()).filter(Boolean) : [];
          await sql`UPDATE role_descriptions SET duties = ${dutiesArr}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (playbook !== undefined) {
          await sql`UPDATE role_descriptions SET playbook = ${String(playbook)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ── Assignment CRUD ──
    if (action === 'assignment') {
      if (req.method === 'POST') {
        const { session_number, cleaning_area_id, family_name } = req.body || {};
        if (!session_number || !cleaning_area_id || !family_name) {
          return res.status(400).json({ error: 'session_number, cleaning_area_id, family_name required' });
        }
        if (session_number < 1 || session_number > 5) {
          return res.status(400).json({ error: 'session_number must be 1-5' });
        }
        const inserted = await sql`
          INSERT INTO cleaning_assignments (session_number, cleaning_area_id, family_name, updated_by)
          VALUES (${session_number}, ${cleaning_area_id}, ${String(family_name).trim()}, ${user.email})
          RETURNING id, session_number, cleaning_area_id, family_name
        `;
        return res.status(201).json({ assignment: inserted[0] });
      }

      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const { cleaning_area_id, family_name } = req.body || {};
        if (!cleaning_area_id && !family_name) {
          return res.status(400).json({ error: 'cleaning_area_id or family_name required' });
        }
        let updated;
        if (cleaning_area_id && family_name) {
          updated = await sql`
            UPDATE cleaning_assignments SET cleaning_area_id = ${cleaning_area_id},
              family_name = ${String(family_name).trim()}, updated_at = NOW(), updated_by = ${user.email}
            WHERE id = ${id} RETURNING id
          `;
        } else if (cleaning_area_id) {
          updated = await sql`
            UPDATE cleaning_assignments SET cleaning_area_id = ${cleaning_area_id},
              updated_at = NOW(), updated_by = ${user.email}
            WHERE id = ${id} RETURNING id
          `;
        } else {
          updated = await sql`
            UPDATE cleaning_assignments SET family_name = ${String(family_name).trim()},
              updated_at = NOW(), updated_by = ${user.email}
            WHERE id = ${id} RETURNING id
          `;
        }
        if (updated.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const deleted = await sql`DELETE FROM cleaning_assignments WHERE id = ${id} RETURNING id`;
        if (deleted.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ok: true });
      }
    }

    // ── Area CRUD ──
    if (action === 'area') {
      if (req.method === 'POST') {
        const { floor_key, area_name, tasks } = req.body || {};
        if (!floor_key || !area_name) {
          return res.status(400).json({ error: 'floor_key and area_name required' });
        }
        if (VALID_FLOORS.indexOf(floor_key) === -1) {
          return res.status(400).json({ error: 'Invalid floor_key' });
        }
        const tasksArr = Array.isArray(tasks) ? tasks.map(t => String(t).trim()).filter(Boolean) : [];
        const inserted = await sql`
          INSERT INTO cleaning_areas (floor_key, area_name, tasks, updated_by)
          VALUES (${floor_key}, ${String(area_name).trim()}, ${tasksArr}, ${user.email})
          RETURNING id, floor_key, area_name, tasks, sort_order
        `;
        return res.status(201).json({ area: inserted[0] });
      }

      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const { area_name, tasks } = req.body || {};
        if (area_name !== undefined) {
          await sql`
            UPDATE cleaning_areas SET area_name = ${String(area_name).trim()},
              updated_at = NOW(), updated_by = ${user.email}
            WHERE id = ${id}
          `;
        }
        if (tasks !== undefined) {
          const tasksArr = Array.isArray(tasks) ? tasks.map(t => String(t).trim()).filter(Boolean) : [];
          await sql`
            UPDATE cleaning_areas SET tasks = ${tasksArr},
              updated_at = NOW(), updated_by = ${user.email}
            WHERE id = ${id}
          `;
        }
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const deleted = await sql`DELETE FROM cleaning_areas WHERE id = ${id} RETURNING id`;
        if (deleted.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ok: true });
      }
    }

    // ── Config update ──
    if (action === 'config' && req.method === 'PATCH') {
      const { liaison_name } = req.body || {};
      if (liaison_name === undefined) return res.status(400).json({ error: 'liaison_name required' });
      await sql`
        UPDATE cleaning_config SET liaison_name = ${String(liaison_name).trim()},
          updated_at = NOW(), updated_by = ${user.email}
        WHERE id = 1
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Cleaning API error:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate entry' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
};
