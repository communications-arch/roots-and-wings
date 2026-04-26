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
const { canEditAsRole, SUPER_USER_EMAIL } = require('./_permissions');

// Editing a role_descriptions row is gated by which bucket of fields
// you're touching. Meta = title / hierarchy / lifecycle, reserved for
// the President (and super user). Content = overview / duties /
// playbook / job_length / last_reviewed_* — those can also be edited
// by anyone whose volunteer-sheet role is an ancestor of the target
// row (so the VP can update any Programming Committee role, the
// Cleaning Crew Liaison can update the area rows they oversee, etc.).
const META_FIELDS = new Set([
  'title', 'committee', 'parent_role_id', 'category',
  'display_order', 'status'
]);
const CONTENT_FIELDS = new Set([
  'overview', 'duties', 'job_length', 'playbook'
]);
// last_reviewed_by / last_reviewed_date are stamped server-side from
// the authenticated user + today's date whenever any of these fields
// changes — never trust client-supplied values.
const REVIEW_TRIGGER_FIELDS = new Set([
  'overview', 'duties', 'job_length', 'playbook'
]);

// Vercel runs in UTC, so we have to anchor "today" to Indianapolis
// (Eastern time, year-round) explicitly — otherwise an edit submitted
// after 8 PM ET stamps tomorrow's date.
function formatTodayMDY() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Indianapolis',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric'
  }).format(new Date());
}
const VALID_CATEGORIES = ['board', 'committee_role', 'cleaning_area', 'class'];
const VALID_STATUSES = ['active', 'archived'];

async function canEditRoleMeta(userEmail) {
  if (!userEmail) return false;
  if (String(userEmail).toLowerCase() === SUPER_USER_EMAIL) return true;
  return await canEditAsRole(userEmail, 'President');
}

// Walks up parent_role_id (max depth 5 — really 3 in practice) and
// collects titles. User can edit content if they hold ANY of those
// titles in the volunteer sheet, or if they pass the meta gate.
async function canEditRoleContent(userEmail, sql, roleId) {
  if (await canEditRoleMeta(userEmail)) return true;
  const titles = [];
  let currentId = roleId;
  const seen = new Set();
  for (let depth = 0; depth < 5 && currentId && !seen.has(currentId); depth++) {
    seen.add(currentId);
    const row = await sql`SELECT title, parent_role_id FROM role_descriptions WHERE id = ${currentId}`;
    if (row.length === 0) break;
    titles.push(row[0].title);
    currentId = row[0].parent_role_id;
  }
  for (const title of titles) {
    if (await canEditAsRole(userEmail, title)) return true;
  }
  return false;
}

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
    // Excludes action-routed GETs (roles, role-holders) — they have
    // their own handlers below. Without this guard, GET ?action=role-holders
    // falls into this branch and returns cleaning data with no `holders`
    // field, which silently parses as an empty list on the client.
    if (req.method === 'GET' && action !== 'roles' && action !== 'role-holders') {
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
        // includeArchived=1 returns every row (for the President's
        // management page). Default excludes archived so the duty-popup
        // + directory lookups don't bloat.
        const includeArchived = req.query.includeArchived === '1';
        const roles = includeArchived
          ? await sql`
              SELECT id, role_key, title, job_length, overview, duties, committee,
                     parent_role_id, category, display_order, status,
                     last_reviewed_by, last_reviewed_date, playbook,
                     updated_at, updated_by
              FROM role_descriptions
              ORDER BY category, display_order, title
            `
          : await sql`
              SELECT id, role_key, title, job_length, overview, duties, committee,
                     parent_role_id, category, display_order, status,
                     last_reviewed_by, last_reviewed_date, playbook,
                     updated_at, updated_by
              FROM role_descriptions
              WHERE status = 'active'
              ORDER BY category, display_order, title
            `;
        return res.status(200).json({ roles });
      }

      if (req.method === 'POST') {
        // Create a new role. President + super user only.
        if (!(await canEditRoleMeta(user.email))) {
          return res.status(403).json({ error: 'Only the President (or super user) can create roles.' });
        }
        const body = req.body || {};
        const role_key = String(body.role_key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        const title = String(body.title || '').trim();
        if (!role_key || !title) return res.status(400).json({ error: 'role_key and title are required' });

        const category = VALID_CATEGORIES.indexOf(body.category) !== -1 ? body.category : 'committee_role';
        const status = VALID_STATUSES.indexOf(body.status) !== -1 ? body.status : 'active';
        const parent_role_id = body.parent_role_id ? parseInt(body.parent_role_id, 10) : null;
        const committee = String(body.committee || '').trim();
        const job_length = String(body.job_length || '').trim();
        const overview = String(body.overview || '').trim();
        const dutiesArr = Array.isArray(body.duties) ? body.duties.map(d => String(d).trim()).filter(Boolean) : [];
        const display_order = Number.isFinite(parseInt(body.display_order, 10)) ? parseInt(body.display_order, 10) : 0;

        if (parent_role_id) {
          const exists = await sql`SELECT id FROM role_descriptions WHERE id = ${parent_role_id}`;
          if (exists.length === 0) return res.status(400).json({ error: 'parent_role_id does not exist' });
        }

        try {
          const inserted = await sql`
            INSERT INTO role_descriptions (
              role_key, title, job_length, overview, duties, committee,
              parent_role_id, category, display_order, status, updated_by
            ) VALUES (
              ${role_key}, ${title}, ${job_length}, ${overview}, ${dutiesArr}, ${committee},
              ${parent_role_id}, ${category}, ${display_order}, ${status}, ${user.email}
            )
            RETURNING *
          `;
          return res.status(201).json({ role: inserted[0] });
        } catch (err) {
          if (String(err.message || '').match(/duplicate key|unique constraint/i)) {
            return res.status(409).json({ error: 'A role with that role_key already exists' });
          }
          throw err;
        }
      }

      if (req.method === 'PATCH') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const body = req.body || {};
        const touchedFields = Object.keys(body).filter(k => META_FIELDS.has(k) || CONTENT_FIELDS.has(k));
        if (touchedFields.length === 0) return res.status(400).json({ error: 'No editable fields supplied' });

        const hitsMeta = touchedFields.some(k => META_FIELDS.has(k));
        if (hitsMeta && !(await canEditRoleMeta(user.email))) {
          return res.status(403).json({ error: 'Only the President (or super user) can change role title, hierarchy, or lifecycle.' });
        }
        // Even for content-only edits, the user needs some stake in the
        // committee subtree. canEditRoleContent covers super-user + President
        // + any ancestor-role holder.
        if (!hitsMeta && !(await canEditRoleContent(user.email, sql, id))) {
          return res.status(403).json({ error: 'You don\'t have permission to edit this role.' });
        }

        // Apply per-field updates.
        if (body.overview !== undefined) {
          await sql`UPDATE role_descriptions SET overview = ${String(body.overview)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.job_length !== undefined) {
          await sql`UPDATE role_descriptions SET job_length = ${String(body.job_length)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.duties !== undefined) {
          const dutiesArr = Array.isArray(body.duties) ? body.duties.map(d => String(d).trim()).filter(Boolean) : [];
          await sql`UPDATE role_descriptions SET duties = ${dutiesArr}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.playbook !== undefined) {
          await sql`UPDATE role_descriptions SET playbook = ${String(body.playbook)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.title !== undefined) {
          const title = String(body.title).trim();
          if (!title) return res.status(400).json({ error: 'title cannot be empty' });
          await sql`UPDATE role_descriptions SET title = ${title}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.committee !== undefined) {
          await sql`UPDATE role_descriptions SET committee = ${String(body.committee).trim()}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.category !== undefined) {
          if (VALID_CATEGORIES.indexOf(body.category) === -1) return res.status(400).json({ error: 'Invalid category' });
          await sql`UPDATE role_descriptions SET category = ${body.category}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.status !== undefined) {
          if (VALID_STATUSES.indexOf(body.status) === -1) return res.status(400).json({ error: 'Invalid status' });
          await sql`UPDATE role_descriptions SET status = ${body.status}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.display_order !== undefined) {
          const n = parseInt(body.display_order, 10);
          if (!Number.isFinite(n)) return res.status(400).json({ error: 'display_order must be a number' });
          await sql`UPDATE role_descriptions SET display_order = ${n}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.parent_role_id !== undefined) {
          const pid = body.parent_role_id === null ? null : parseInt(body.parent_role_id, 10);
          if (pid !== null && !Number.isFinite(pid)) return res.status(400).json({ error: 'parent_role_id must be a number or null' });
          if (pid === id) return res.status(400).json({ error: 'A role cannot be its own parent' });
          if (pid) {
            const exists = await sql`SELECT id FROM role_descriptions WHERE id = ${pid}`;
            if (exists.length === 0) return res.status(400).json({ error: 'parent_role_id does not exist' });
          }
          await sql`UPDATE role_descriptions SET parent_role_id = ${pid}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }

        // Auto-stamp the review fields whenever the descriptive content
        // changed. Skipped for pure meta edits (archive, hierarchy,
        // display_order) so housekeeping doesn't claim someone "reviewed
        // the description". Returned to the client so it can update the
        // local cache without a refetch.
        const hitsContent = touchedFields.some(k => REVIEW_TRIGGER_FIELDS.has(k));
        if (hitsContent) {
          const reviewer = (user.name || user.email).trim();
          const today = formatTodayMDY();
          await sql`UPDATE role_descriptions SET last_reviewed_by = ${reviewer}, last_reviewed_date = ${today}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
          return res.status(200).json({ ok: true, last_reviewed_by: reviewer, last_reviewed_date: today });
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ── Role Holders (Phase A: read-only, seeded from the volunteer sheet).
    // Returns an array of holders; the client groups by role_id on render.
    // Phase B adds POST/DELETE + cuts over the permission lookup here.
    if (action === 'role-holders') {
      if (req.method === 'GET') {
        const schoolYear = req.query.school_year || '2025-2026';
        const holders = await sql`
          SELECT rh.id, rh.role_id, rh.email, rh.person_name, rh.family_name,
                 rh.school_year, rh.started_at, rh.updated_at, rh.updated_by
          FROM role_holders rh
          WHERE rh.school_year = ${schoolYear}
          ORDER BY rh.role_id, rh.person_name
        `;
        return res.status(200).json({ school_year: schoolYear, holders });
      }
      return res.status(405).json({ error: 'Method not allowed (Phase A is read-only)' });
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
