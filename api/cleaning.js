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
// GET    /api/cleaning?action=role-holders       → holders for a school year
// POST   /api/cleaning?action=role-holders       → assign a holder
// DELETE /api/cleaning?action=role-holders&id=N → remove a holder
// GET    /api/cleaning?action=sessions           → co-op calendar (current + next year)
// POST   /api/cleaning?action=sessions           → upsert a session (President/VP)
// DELETE /api/cleaning?action=sessions&id=N      → remove a session (President/VP)
// GET    /api/cleaning?action=role-confirm       → confirmed years (Comms-controlled)
// POST   /api/cleaning?action=role-confirm       → mark a year as confirmed (Comms gated)
// DELETE /api/cleaning?action=role-confirm       → un-confirm a year (Comms gated)

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, isSuperUser, canImpersonate, activeSchoolYear } = require('./_permissions');
const {
  CAPABILITIES, LOCKED_RULES, NONE_SENTINEL,
  capabilityRoles, hasCapability, invalidateGrantsCache
} = require('./_capabilities');

// Editing a role_descriptions row is gated by which bucket of fields
// you're touching. Meta = title / hierarchy / lifecycle, reserved for
// the President (and super user). Content = overview / duties /
// playbook / job_length / last_reviewed_* — those can also be edited
// by anyone whose volunteer-sheet role is an ancestor of the target
// row (so the VP can update any Programming Committee role, the
// Cleaning Crew Liaison can update the area rows they oversee, etc.).
// Meta edits split into two tiers:
//  - STRUCTURAL: changes that move a role between committees or
//    promote/demote its category. Stay President-only because they
//    redraw the org chart.
//  - SUBTREE: title rename, display_order, archive/restore. A board
//    chair can do these freely on roles inside their own committee.
const STRUCTURAL_META_FIELDS = new Set([
  'committee', 'committee_id', 'parent_role_id', 'category'
]);
const SUBTREE_META_FIELDS = new Set([
  'title', 'display_order', 'status'
]);
const META_FIELDS = new Set([
  ...STRUCTURAL_META_FIELDS,
  ...SUBTREE_META_FIELDS
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
// Season-boundary school year for the cleaning rota: the year of the next
// co-op session that hasn't ended yet (Indianapolis "today"), so it flips
// the day after the season's last session — NOT at April's billing pivot
// and NOT when next year's sessions get seeded in May. Falls back to the
// newest seeded year, then null (no filter) pre-seed.
async function activeCleaningYear(sql) {
  try {
    const rows = await sql`
      SELECT school_year FROM co_op_sessions
      WHERE end_date >= (NOW() AT TIME ZONE 'America/Indiana/Indianapolis')::date
      ORDER BY start_date ASC LIMIT 1
    `;
    if (rows.length) return rows[0].school_year;
    const mx = await sql`SELECT MAX(school_year) AS sy FROM co_op_sessions`;
    return mx[0] ? mx[0].sy : null;
  } catch (e) {
    console.error('activeCleaningYear failed:', e.message);
    return null;
  }
}

// Categories are validated client-side AND server-side. Roles v2 dropped
// 'cleaning_area' and 'class' — cleaning lives in cleaning_areas /
// cleaning_assignments, classes have a separate home, and `roles` covers
// humans on the org chart only.
const VALID_CATEGORIES = ['board', 'committee_role'];
const VALID_STATUSES = ['active', 'archived'];

// Structural meta (move-between-committees, change category) is the
// President's job exclusively. Super-user-the-login (communications@,
// vp@, vicepresident@) does NOT bypass this — they impersonate the
// President via X-View-As if they need to perform a structural edit.
// Treating super-user as "impersonate, not omnipotent" keeps role
// edits scoped to the role you're effectively acting as.
async function canEditRoleMeta(userEmail) {
  if (!userEmail) return false;
  // 'roles_structure' capability — defaults to the President; editable
  // in the Permissions admin table.
  return await hasCapability(userEmail, 'roles_structure');
}

// Walks up parent_role_id (max depth 5 — really 3 in practice) on the
// new `roles` table and collects titles. User can edit content if they
// hold ANY of those titles in role_holders_v2, or if they pass the meta
// gate (President + super user).
async function canEditRoleContent(userEmail, sql, roleId) {
  if (await canEditRoleMeta(userEmail)) return true;
  const titles = [];
  let currentId = roleId;
  const seen = new Set();
  for (let depth = 0; depth < 5 && currentId && !seen.has(currentId); depth++) {
    seen.add(currentId);
    const row = await sql`SELECT title, parent_role_id FROM roles WHERE id = ${currentId}`;
    if (row.length === 0) break;
    titles.push(row[0].title);
    currentId = row[0].parent_role_id;
  }
  for (const title of titles) {
    if (await canEditAsRole(userEmail, title)) return true;
  }
  return false;
}

// Board roles are tied to Google Workspace accounts (`president@`,
// `vp@`, etc.) — the role mailbox IS the role. Only the Communications
// Director should be able to assign or remove a board-role holder
// since she's also the one who owns the Workspace user/group setup
// for those mailboxes. Committee-role assignments fall back to the
// usual content-edit ladder (each chair can manage their own
// committee). Returns true if (a) the role is a committee role and
// the user passes canEditRoleContent, OR (b) the role is a board role
// and the user is the Comms Director.
async function canEditRoleHolders(userEmail, sql, roleId) {
  const row = await sql`SELECT category FROM roles WHERE id = ${roleId}`;
  const category = row[0] && row[0].category;
  if (category === 'board') {
    // 'board_roles_assign' — defaults to Comms (she owns the Workspace
    // mailbox setup those seats are tied to); Permissions-table editable.
    return await hasCapability(userEmail, 'board_roles_assign');
  }
  // 'committee_roles_assign' — defaults to the VP (Erin 2026-07-07: VP
  // assigns ANY committee/volunteer role, not just her own subtree).
  // The parent-chain rule below is structural and always applies.
  if (await hasCapability(userEmail, 'committee_roles_assign')) return true;
  return await canEditRoleContent(userEmail, sql, roleId);
}

// Resolve a free-text committee name to a committees.id. Returns null if
// the input is empty (clears the committee_id), or undefined if the name
// doesn't match an existing committee (caller should 400). Committees
// can't be created via this path — they live in the committees table
// and are managed separately.
async function resolveCommitteeId(sql, committeeName) {
  const name = String(committeeName == null ? '' : committeeName).trim();
  if (!name) return null;
  const row = await sql`SELECT id FROM committees WHERE LOWER(name) = LOWER(${name}) LIMIT 1`;
  return row.length > 0 ? row[0].id : undefined;
}

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const VALID_FLOORS = ['mainFloor', 'upstairs', 'outside', 'floater'];

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await verifyBearer(authHeader.slice(7));
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-View-As');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const realUser = await verifyGoogleAuth(req);
  if (!realUser) return res.status(401).json({ error: 'Unauthorized' });

  // View-As impersonation. Honored when the real user has impersonation
  // rights: explicit super users in any env, plus any signed-in
  // @rootsandwingsindy.com Workspace member on dev/preview so testers
  // can exercise role flows without a super-user account. The effective
  // identity (what downstream gates check) IS NOT auto-promoted — it
  // flows through the real production gates.
  const viewAsRaw = String(req.headers['x-view-as'] || '').trim().toLowerCase();
  let user = realUser;
  if (viewAsRaw && canImpersonate(realUser.email)) {
    user = { email: viewAsRaw, name: realUser.name, viewedBy: realUser.email };
  }

  try {
    const sql = getSql();
    const action = req.query.action || '';

    // ── GET: return everything ──
    // Excludes action-routed GETs (roles, role-holders) — they have
    // their own handlers below. Without this guard, GET ?action=role-holders
    // falls into this branch and returns cleaning data with no `holders`
    // field, which silently parses as an empty list on the client.
    if (req.method === 'GET' && action !== 'roles' && action !== 'role-holders' && action !== 'sessions' && action !== 'role-confirm' && action !== 'permissions' && action !== 'capabilities' && action !== 'rooms') {
      const areas = await sql`
        SELECT id, floor_key, area_name, tasks, sort_order
        FROM cleaning_areas ORDER BY sort_order, id
      `;
      // Rota is year-scoped (2026-07-06, Erin: cleaning resets each school
      // year). Reader and writer share activeCleaningYear() so they can't
      // disagree on which year "now" belongs to. An explicit ?school_year=
      // overrides it for read-only views pinned to a picker (the Roles
      // Assignments cleaning lens) — writes still land on the active year.
      const yearParam = String(req.query.school_year || '').trim();
      const rotaYear = /^\d{4}-\d{4}$/.test(yearParam)
        ? yearParam
        : await activeCleaningYear(sql);
      const assignments = await sql`
        SELECT ca.id, ca.session_number, ca.cleaning_area_id, ca.family_name, ca.sort_order,
               a.floor_key, a.area_name
        FROM cleaning_assignments ca
        JOIN cleaning_areas a ON a.id = ca.cleaning_area_id
        WHERE ${rotaYear} IS NULL OR ca.school_year = ${rotaYear}
        ORDER BY ca.session_number, a.sort_order, ca.sort_order
      `;
      // Liaison name is now derived from role_holders_v2 — the
      // cleaning_config table was retired in Phase 5. Joins through
      // people for the live name (resolves to '' for board-mailbox
      // assignees with no people row, same fallback behavior as the
      // old config text field's empty-string default).
      const liaisonRows = await sql`
        SELECT
          NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS person_name
        FROM role_holders_v2 rhv
        JOIN roles r ON r.id = rhv.role_id
        LEFT JOIN people p
          ON (LOWER(p.email) = LOWER(rhv.person_email) OR LOWER(p.family_email) = LOWER(rhv.person_email))
          AND p.role = 'mlc'
        WHERE r.role_key = 'cleaning_crew_liaison'
          AND rhv.ended_at IS NULL
        ORDER BY rhv.school_year DESC, rhv.id ASC
        LIMIT 1
      `;

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
        liaison: (liaisonRows[0] && liaisonRows[0].person_name) || '',
        school_year: rotaYear,
        areas,
        assignments,
        sessions
      });
    }

    // ── Capabilities (effective grants, any member) ──
    // Lightweight map the client fetches at load so workspace cards /
    // report rows / edit affordances follow the SAME grants the server
    // enforces. Titles only — descriptions live in the admin GET below.
    if (action === 'capabilities') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const grants = {};
      for (const cap of CAPABILITIES) {
        grants[cap.key] = await capabilityRoles(cap.key);
      }
      return res.status(200).json({ grants });
    }

    // ── Cleaning self-signup (2026-07-11, Erin's volunteer build) ──
    // Any member claims an OPEN area for a session (one family per area;
    // the Floater area always accepts more). Their display name comes
    // from their people row, matching the rota's person-name convention.
    // DELETE releases their own row only.
    if (action === 'cleaning-signup') {
      const csEmail = String(user.email || '').toLowerCase();
      const csPeople = await sql`SELECT first_name, last_name FROM people
        WHERE LOWER(email) = ${csEmail} OR LOWER(personal_email) = ${csEmail} LIMIT 1`;
      const csName = csPeople.length
        ? ((csPeople[0].first_name || '') + ' ' + (csPeople[0].last_name || '')).trim()
        : String(user.name || '').trim();
      if (req.method === 'POST') {
        const areaId = parseInt((req.body || {}).area_id, 10);
        const csSess = parseInt((req.body || {}).session, 10);
        if (!Number.isFinite(areaId) || !Number.isFinite(csSess) || csSess < 1 || csSess > 5) {
          return res.status(400).json({ error: 'area_id and session 1-5 required' });
        }
        if (!csName) return res.status(409).json({ error: 'Your member profile has no name yet — contact the Communications Director.' });
        const areaRows = await sql`SELECT id, area_name, floor_key FROM cleaning_areas WHERE id = ${areaId}`;
        if (!areaRows.length) return res.status(404).json({ error: 'Area not found.' });
        const csYear = await activeCleaningYear(sql);
        const taken = await sql`SELECT family_name FROM cleaning_assignments
          WHERE cleaning_area_id = ${areaId} AND session_number = ${csSess} AND school_year = ${csYear}`;
        if (areaRows[0].floor_key !== 'floater' && taken.length) {
          return res.status(409).json({ error: '“' + areaRows[0].area_name + '” is already covered by ' + taken[0].family_name + ' for that session.' });
        }
        if (taken.some(t => String(t.family_name || '').trim().toLowerCase() === csName.toLowerCase())) {
          return res.status(409).json({ error: 'You are already on that area for this session.' });
        }
        const ins = await sql`
          INSERT INTO cleaning_assignments (cleaning_area_id, session_number, family_name, school_year, sort_order)
          VALUES (${areaId}, ${csSess}, ${csName}, ${csYear}, ${taken.length})
          RETURNING id`;
        return res.status(201).json({ ok: true, id: ins[0].id, area: areaRows[0].area_name });
      }
      if (req.method === 'DELETE') {
        const rowId = parseInt(req.query.id, 10);
        if (!Number.isFinite(rowId)) return res.status(400).json({ error: 'id required' });
        // Own row only: the stored name must match the acting person (or
        // start with their family surname for legacy family-name rows).
        const csLast = csPeople.length ? String(csPeople[0].last_name || '').trim().toLowerCase() : '';
        const rows = await sql`SELECT id, family_name FROM cleaning_assignments WHERE id = ${rowId}`;
        if (!rows.length) return res.status(404).json({ error: 'Assignment not found.' });
        const nm = String(rows[0].family_name || '').trim().toLowerCase();
        const mineRow = nm === csName.toLowerCase() || (csLast && nm.indexOf(csLast) !== -1);
        if (!mineRow) return res.status(403).json({ error: 'That cleaning spot isn’t yours to release.' });
        await sql`DELETE FROM cleaning_assignments WHERE id = ${rowId}`;
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Rooms / Facilities (2026-07-10, Erin) ──
    // GET: any signed-in member — feeds the Class Builder's room picker.
    // POST (create/update) + DELETE (archive): facilities_manage
    // capability (defaults President / VP / Afternoon Class Liaison;
    // editable in the Permissions admin). Assignments themselves live on
    // class_submissions.scheduled_room via api/curriculum assign-room.
    if (action === 'rooms') {
      if (req.method === 'GET') {
        const rows = await sql`
          SELECT id, name, builder_note, details, sort_order, status, is_outdoor
          FROM rooms ORDER BY sort_order, LOWER(name)`;
        return res.status(200).json({ rooms: rows });
      }
      const canManageRooms = isSuperUser(realUser.email) || await hasCapability(user.email, 'facilities_manage');
      if (!canManageRooms) {
        return res.status(403).json({ error: 'Only Facilities managers can edit rooms. (You are acting as ' + user.email + '.)' });
      }
      if (req.method === 'POST') {
        const b = req.body || {};
        const roomName = String(b.name || '').trim().slice(0, 120);
        if (!roomName) return res.status(400).json({ error: 'A room name is required.' });
        const note = String(b.builder_note || '').trim().slice(0, 200);
        const details = String(b.details || '').trim().slice(0, 2000);
        const sort = Number.isFinite(parseInt(b.sort_order, 10)) ? parseInt(b.sort_order, 10) : 0;
        const roomId = b.id ? parseInt(b.id, 10) : null;
        if (roomId) {
          const updated = await sql`
            UPDATE rooms
            SET name = ${roomName}, builder_note = ${note}, details = ${details},
                sort_order = ${sort}, is_outdoor = ${!!b.is_outdoor}, status = ${b.status === 'archived' ? 'archived' : 'active'},
                updated_by = ${realUser.email}, updated_at = NOW()
            WHERE id = ${roomId}
            RETURNING id, name, builder_note, details, sort_order, status, is_outdoor`;
          if (updated.length === 0) return res.status(404).json({ error: 'Room not found.' });
          return res.status(200).json({ room: updated[0] });
        }
        const inserted = await sql`
          INSERT INTO rooms (name, builder_note, details, sort_order, is_outdoor, updated_by)
          VALUES (${roomName}, ${note}, ${details}, ${sort}, ${!!b.is_outdoor}, ${realUser.email})
          RETURNING id, name, builder_note, details, sort_order, status, is_outdoor`;
        return res.status(201).json({ room: inserted[0] });
      }
      if (req.method === 'DELETE') {
        const roomId = parseInt(req.query.id, 10);
        if (!Number.isFinite(roomId)) return res.status(400).json({ error: 'id required' });
        await sql`UPDATE rooms SET status = 'archived', updated_by = ${realUser.email}, updated_at = NOW() WHERE id = ${roomId}`;
        return res.status(200).json({ ok: true, id: roomId });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Permissions admin (Comms Director + super user) ──
    // The CRUD table behind Workspace → Admin Consoles → Permissions.
    // GET returns the full registry (labels, descriptions, defaults,
    // effective roles, locked structural rules) + the role-title picker
    // options. POST replaces one capability's grant set; DELETE resets
    // it to the registry default.
    if (action === 'permissions') {
      const isPermAdmin = isSuperUser(user.email)
        || await canEditAsRole(user.email, 'Communications Director');
      if (!isPermAdmin) {
        return res.status(403).json({ error: 'Only the Communications Director can manage permissions.' });
      }

      if (req.method === 'GET') {
        const [grantRows, roleRows] = await Promise.all([
          sql`SELECT capability_key, role_title, created_by, created_at
              FROM capability_grants ORDER BY capability_key, role_title`,
          sql`SELECT DISTINCT title FROM roles WHERE status = 'active' ORDER BY title`
        ]);
        const byKey = {};
        grantRows.forEach(r => {
          (byKey[r.capability_key] || (byKey[r.capability_key] = [])).push(r.role_title);
        });
        const capabilities = CAPABILITIES.map(c => {
          const custom = Array.isArray(byKey[c.key]) && byKey[c.key].length > 0;
          const roles = custom
            ? byKey[c.key].filter(t => t !== NONE_SENTINEL)
            : c.defaultRoles.slice();
          return {
            key: c.key, area: c.area, label: c.label, desc: c.desc,
            defaultRoles: c.defaultRoles, roles, custom
          };
        });
        return res.status(200).json({
          capabilities,
          lockedRules: LOCKED_RULES,
          roleOptions: roleRows.map(r => r.title)
        });
      }

      if (req.method === 'POST') {
        const body = req.body || {};
        const key = String(body.capability_key || '').trim();
        const cap = CAPABILITIES.filter(c => c.key === key)[0];
        if (!cap) return res.status(400).json({ error: 'Unknown capability.' });
        if (!Array.isArray(body.roles)) return res.status(400).json({ error: 'roles must be an array of role titles.' });
        const titles = [];
        for (const t of body.roles) {
          const title = String(t || '').trim().slice(0, 120);
          if (!title || title === NONE_SENTINEL) continue;
          if (titles.indexOf(title) === -1) titles.push(title);
        }
        // Store the set verbatim. Matching the registry default exactly
        // still stores rows (an explicit choice) — Reset (DELETE) is how
        // a capability returns to tracking the default.
        await sql`DELETE FROM capability_grants WHERE capability_key = ${key}`;
        const toInsert = titles.length > 0 ? titles : [NONE_SENTINEL];
        for (const title of toInsert) {
          await sql`
            INSERT INTO capability_grants (capability_key, role_title, created_by)
            VALUES (${key}, ${title}, ${realUser.email})
            ON CONFLICT (capability_key, role_title) DO NOTHING
          `;
        }
        invalidateGrantsCache();
        return res.status(200).json({ key, roles: titles, custom: true });
      }

      if (req.method === 'DELETE') {
        const key = String(req.query.key || '').trim();
        const cap = CAPABILITIES.filter(c => c.key === key)[0];
        if (!cap) return res.status(400).json({ error: 'Unknown capability.' });
        await sql`DELETE FROM capability_grants WHERE capability_key = ${key}`;
        invalidateGrantsCache();
        return res.status(200).json({ key, roles: cap.defaultRoles, custom: false });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Roles (v2) ──
    // GET response preserves the old field names (`job_length`, `committee`)
    // so the existing Roles Manager UI continues to work unchanged through
    // the Phase 4 frontend cutover. Internally:
    //   - term_length is exposed as job_length
    //   - committees.name is exposed as committee (via JOIN)
    if (action === 'roles') {
      if (req.method === 'GET') {
        const includeArchived = req.query.includeArchived === '1';
        const rows = includeArchived
          ? await sql`
              SELECT r.id, r.role_key, r.title,
                     r.term_length AS job_length,
                     r.overview, r.duties,
                     c.name AS committee,
                     r.parent_role_id, r.category, r.display_order, r.status,
                     r.last_reviewed_by, r.last_reviewed_date, r.playbook,
                     r.icon_emoji, r.card_summary, r.role_email,
                     r.revision_history,
                     r.updated_at, r.updated_by
              FROM roles r
              LEFT JOIN committees c ON c.id = r.committee_id
              ORDER BY r.category, r.display_order, r.title
            `
          : await sql`
              SELECT r.id, r.role_key, r.title,
                     r.term_length AS job_length,
                     r.overview, r.duties,
                     c.name AS committee,
                     r.parent_role_id, r.category, r.display_order, r.status,
                     r.last_reviewed_by, r.last_reviewed_date, r.playbook,
                     r.icon_emoji, r.card_summary, r.role_email,
                     r.revision_history,
                     r.updated_at, r.updated_by
              FROM roles r
              LEFT JOIN committees c ON c.id = r.committee_id
              WHERE r.status = 'active'
              ORDER BY r.category, r.display_order, r.title
            `;
        // Normalize "" committee for client compat — legacy rows had
        // empty-string here, not NULL.
        const roles = rows.map(r => Object.assign({}, r, { committee: r.committee || '' }));
        return res.status(200).json({ roles });
      }

      if (req.method === 'POST') {
        const body = req.body || {};
        const role_key = String(body.role_key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        const title = String(body.title || '').trim();
        if (!role_key || !title) return res.status(400).json({ error: 'role_key and title are required' });

        const category = VALID_CATEGORIES.indexOf(body.category) !== -1 ? body.category : 'committee_role';
        const status = VALID_STATUSES.indexOf(body.status) !== -1 ? body.status : 'active';
        const parent_role_id = body.parent_role_id ? parseInt(body.parent_role_id, 10) : null;
        const term_length = String(body.job_length || body.term_length || '').trim();
        const overview = String(body.overview || '').trim();
        const dutiesArr = Array.isArray(body.duties) ? body.duties.map(d => String(d).trim()).filter(Boolean) : [];
        const display_order = Number.isFinite(parseInt(body.display_order, 10)) ? parseInt(body.display_order, 10) : 0;

        let committee_id = null;
        if (body.committee_id !== undefined && body.committee_id !== null) {
          committee_id = parseInt(body.committee_id, 10);
          if (!Number.isFinite(committee_id)) return res.status(400).json({ error: 'committee_id must be a number' });
        } else if (body.committee !== undefined) {
          const resolved = await resolveCommitteeId(sql, body.committee);
          if (resolved === undefined) return res.status(400).json({ error: 'Unknown committee: ' + body.committee });
          committee_id = resolved;
        }

        // Auth: President + super user can create anywhere. A board
        // chair can also create a new role, but only inside the
        // committee they chair (and only as a committee_role — they
        // can't seed peer board rows). Everyone else: 403.
        let isCreator = await canEditRoleMeta(user.email);
        if (!isCreator && committee_id) {
          if (category !== 'committee_role') {
            return res.status(403).json({ error: 'Only the President (or super user) can create board-tier roles.' });
          }
          const chairRow = await sql`
            SELECT r.title AS chair_title
            FROM committees c
            JOIN roles r ON r.id = c.chair_role_id
            WHERE c.id = ${committee_id}
          `;
          if (chairRow.length === 0) {
            return res.status(400).json({ error: 'Committee has no chair on file — President must create new roles here.' });
          }
          isCreator = await canEditAsRole(user.email, chairRow[0].chair_title);
        }
        if (!isCreator) {
          return res.status(403).json({ error: 'Only the President or the chair of the target committee can create a role here.' });
        }

        if (parent_role_id) {
          const exists = await sql`SELECT id FROM roles WHERE id = ${parent_role_id}`;
          if (exists.length === 0) return res.status(400).json({ error: 'parent_role_id does not exist' });
        }

        try {
          const inserted = await sql`
            INSERT INTO roles (
              role_key, title, term_length, overview, duties, committee_id,
              parent_role_id, category, display_order, status, updated_by
            ) VALUES (
              ${role_key}, ${title}, ${term_length}, ${overview}, ${dutiesArr}, ${committee_id},
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
        const supplied = Object.keys(body).filter(k => META_FIELDS.has(k) || CONTENT_FIELDS.has(k));
        if (supplied.length === 0) return res.status(400).json({ error: 'No editable fields supplied' });

        // Diff against current row so unchanged values don't count as
        // "touched". The existing role-edit form posts every field on
        // every save — without this diff, a board chair renaming a role
        // would also be flagged as changing committee_id (which they
        // can't), and the request would 403 even though they touched
        // only the title. The legacy `committee` field maps to the
        // joined committees.name from the GET response.
        const currentRows = await sql`
          SELECT r.id, r.title, r.term_length, r.overview, r.duties, r.playbook,
                 r.parent_role_id, r.category, r.committee_id, r.display_order,
                 r.status, c.name AS committee
          FROM roles r LEFT JOIN committees c ON c.id = r.committee_id
          WHERE r.id = ${id}
        `;
        if (currentRows.length === 0) return res.status(404).json({ error: 'Role not found.' });
        const current = currentRows[0];

        function unchanged(field, incoming) {
          let cur;
          if (field === 'job_length') cur = current.term_length || '';
          else if (field === 'duties') cur = Array.isArray(current.duties) ? current.duties : [];
          else if (field === 'parent_role_id') cur = current.parent_role_id == null ? null : Number(current.parent_role_id);
          else if (field === 'display_order') cur = Number(current.display_order || 0);
          else cur = current[field] == null ? '' : current[field];
          // Loose equality on scalars; deep-equal on duties arrays.
          if (Array.isArray(cur) && Array.isArray(incoming)) {
            return cur.length === incoming.length && cur.every((v, i) => String(v) === String(incoming[i]));
          }
          if (field === 'parent_role_id') {
            return cur === (incoming == null ? null : Number(incoming));
          }
          return String(cur) === String(incoming == null ? '' : incoming);
        }

        const touchedFields = supplied.filter(k => !unchanged(k, body[k]));
        if (touchedFields.length === 0) {
          // Form was submitted with no real changes — still a success.
          return res.status(200).json({ ok: true, noop: true });
        }

        // Three permission tiers:
        //  - Structural meta (committee_id / parent_role_id / category /
        //    committee): redraws the org chart → President + super user.
        //  - Subtree meta (title / display_order / status) AND content:
        //    anyone in the parent_role_id chain may edit → covers super
        //    user, President, and the committee chair for this role.
        const hitsStructural = touchedFields.some(k => STRUCTURAL_META_FIELDS.has(k));
        if (hitsStructural && !(await canEditRoleMeta(user.email))) {
          return res.status(403).json({ error: 'Only the President can move a role between committees or change its category. (View-As president@ if you need to.)' });
        }
        if (!(await canEditRoleContent(user.email, sql, id))) {
          return res.status(403).json({ error: 'You don\'t have permission to edit this role.' });
        }

        // Apply per-field updates. job_length is the legacy field name —
        // the column is `term_length` on the new schema.
        if (body.overview !== undefined) {
          await sql`UPDATE roles SET overview = ${String(body.overview)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.job_length !== undefined) {
          await sql`UPDATE roles SET term_length = ${String(body.job_length)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.duties !== undefined) {
          const dutiesArr = Array.isArray(body.duties) ? body.duties.map(d => String(d).trim()).filter(Boolean) : [];
          await sql`UPDATE roles SET duties = ${dutiesArr}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.playbook !== undefined) {
          await sql`UPDATE roles SET playbook = ${String(body.playbook)}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.title !== undefined) {
          const title = String(body.title).trim();
          if (!title) return res.status(400).json({ error: 'title cannot be empty' });
          await sql`UPDATE roles SET title = ${title}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.committee !== undefined) {
          // Free-text input → committee_id lookup. Empty string clears
          // the committee link; unknown name is a 400 (committees aren't
          // auto-created via this path).
          const resolved = await resolveCommitteeId(sql, body.committee);
          if (resolved === undefined) return res.status(400).json({ error: 'Unknown committee: ' + body.committee });
          await sql`UPDATE roles SET committee_id = ${resolved}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.category !== undefined) {
          if (VALID_CATEGORIES.indexOf(body.category) === -1) return res.status(400).json({ error: 'Invalid category' });
          await sql`UPDATE roles SET category = ${body.category}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.status !== undefined) {
          if (VALID_STATUSES.indexOf(body.status) === -1) return res.status(400).json({ error: 'Invalid status' });
          await sql`UPDATE roles SET status = ${body.status}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.display_order !== undefined) {
          const n = parseInt(body.display_order, 10);
          if (!Number.isFinite(n)) return res.status(400).json({ error: 'display_order must be a number' });
          await sql`UPDATE roles SET display_order = ${n}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }
        if (body.parent_role_id !== undefined) {
          const pid = body.parent_role_id === null ? null : parseInt(body.parent_role_id, 10);
          if (pid !== null && !Number.isFinite(pid)) return res.status(400).json({ error: 'parent_role_id must be a number or null' });
          if (pid === id) return res.status(400).json({ error: 'A role cannot be its own parent' });
          if (pid) {
            const exists = await sql`SELECT id FROM roles WHERE id = ${pid}`;
            if (exists.length === 0) return res.status(400).json({ error: 'parent_role_id does not exist' });
          }
          await sql`UPDATE roles SET parent_role_id = ${pid}, updated_at = NOW(), updated_by = ${user.email} WHERE id = ${id}`;
        }

        // Auto-stamp the review fields + append a revision_history entry
        // whenever the descriptive content changed. The history append is
        // new in v2 — captures every save so we don't lose the audit
        // trail the .docx headers used to track manually. Skipped for
        // pure meta edits (archive, hierarchy, display_order) so
        // housekeeping doesn't claim someone "reviewed the description".
        const hitsContent = touchedFields.some(k => REVIEW_TRIGGER_FIELDS.has(k));
        if (hitsContent) {
          const reviewer = (user.name || user.email).trim();
          const today = formatTodayMDY();
          const isoToday = new Date().toISOString().slice(0, 10);
          await sql`
            UPDATE roles
            SET last_reviewed_by = ${reviewer},
                last_reviewed_date = ${isoToday}::date,
                revision_history = ${JSON.stringify({ date: isoToday, by: reviewer })}::jsonb || revision_history,
                updated_at = NOW(),
                updated_by = ${user.email}
            WHERE id = ${id}
          `;
          return res.status(200).json({ ok: true, last_reviewed_by: reviewer, last_reviewed_date: today });
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ── Committee-grouped tree (for the Roles Manager rewrite) ──
    // Returns committees in display order, each with `chair` (the board
    // role pointed at by committees.chair_role_id) and `roles` (every
    // committee_role attached to that committee). Each role carries its
    // current-year holders so the "Open Roles" filter is just
    // `holders.length === 0` client-side.
    if (action === 'tree' && req.method === 'GET') {
      const includeArchived = req.query.includeArchived === '1';
      let schoolYear = req.query.school_year;
      if (!schoolYear || !/^\d{4}-\d{4}$/.test(schoolYear)) {
        const yr = await sql`SELECT MAX(school_year) AS sy FROM role_holders_v2`;
        const now = new Date();
        const fy = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
        schoolYear = (yr[0] && yr[0].sy) || (fy + '-' + (fy + 1));
      }
      const committees = await sql`
        SELECT id, name, chair_role_id, display_order, status
        FROM committees
        WHERE (${includeArchived} OR status = 'active')
        ORDER BY display_order
      `;
      const rolesRows = await sql`
        SELECT
          id, role_key, title, category, committee_id, parent_role_id,
          display_order, status, term_length, overview, duties, playbook,
          icon_emoji, card_summary, role_email,
          last_reviewed_by, last_reviewed_date, revision_history,
          updated_at, updated_by
        FROM roles
        WHERE (${includeArchived} OR status = 'active')
        ORDER BY display_order, title
      `;
      const holderRows = await sql`
        SELECT
          rhv.id, rhv.role_id, rhv.person_email, rhv.school_year,
          rhv.started_at, rhv.ended_at, rhv.notes,
          TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS full_name
        FROM role_holders_v2 rhv
        LEFT JOIN people p ON LOWER(p.email) = LOWER(rhv.person_email)
        WHERE rhv.school_year = ${schoolYear}
          AND rhv.ended_at IS NULL
        ORDER BY rhv.started_at
      `;
      const holdersByRoleId = {};
      holderRows.forEach(h => {
        (holdersByRoleId[h.role_id] = holdersByRoleId[h.role_id] || []).push({
          id: h.id,
          person_email: h.person_email,
          full_name: h.full_name || '',
          school_year: h.school_year,
          started_at: h.started_at,
          ended_at: h.ended_at,
          notes: h.notes || ''
        });
      });
      const rolesById = {};
      rolesRows.forEach(r => {
        r.holders = holdersByRoleId[r.id] || [];
        r.duties = Array.isArray(r.duties) ? r.duties : [];
        r.card_summary = Array.isArray(r.card_summary) ? r.card_summary : [];
        rolesById[r.id] = r;
      });
      const tree = committees.map(c => {
        const chair = c.chair_role_id ? (rolesById[c.chair_role_id] || null) : null;
        const members = rolesRows.filter(r =>
          r.committee_id === c.id && r.id !== c.chair_role_id
        ).sort((a, b) => a.display_order - b.display_order);
        return {
          id: c.id,
          name: c.name,
          display_order: c.display_order,
          status: c.status,
          chair,
          roles: members
        };
      });
      const orphans = rolesRows.filter(r => !r.committee_id);
      if (orphans.length) {
        tree.push({
          id: null, name: 'Unassigned', display_order: 9999,
          status: 'active', chair: null, roles: orphans
        });
      }
      return res.status(200).json({ school_year: schoolYear, committees: tree });
    }

    // ── Co-op Sessions (Phase B: DB-backed SESSION_DATES) ──
    // GET returns rows for the active school year + the next school year
    // (so the portal can show "upcoming" once next year is set up). Any
    // signed-in @rootsandwingsindy.com user can read; the auth check at
    // the top of the handler already enforced that.
    //
    // Date values come back as YYYY-MM-DD strings. Neon returns DATE as a
    // JS Date object whose UTC ISO prefix happens to match the
    // Indianapolis local date (DATE has no time/TZ; the driver synthesizes
    // midnight-local then re-renders in UTC). Slicing the first 10 chars
    // gives us a TZ-agnostic date string the client can compare against
    // its local "today" without surprises — bitten by this before, see
    // feedback_timezone_dates.md.
    if (action === 'sessions') {
      if (req.method === 'GET') {
        // Return ALL co-op sessions across all school years. The client
        // picks which year is "active" for SESSION_DATES purposes —
        // having both the year-just-ending and the year-just-starting on
        // hand keeps the spring-to-fall handoff working (e.g. in summer
        // 2026 we still need 2025-26's Field Day to compute summer-break
        // state even though activeSchoolYear() already says "2026-2027").
        // The dataset is small (5 rows per year), so no need to slice.
        const rows = await sql`
          SELECT id, school_year, session_number, name, start_date, end_date,
                 updated_at, updated_by
          FROM co_op_sessions
          ORDER BY school_year, session_number
        `;
        const sessions = rows.map(r => ({
          id: r.id,
          school_year: r.school_year,
          session_number: r.session_number,
          name: r.name,
          start_date: r.start_date instanceof Date
            ? r.start_date.toISOString().slice(0, 10)
            : String(r.start_date).slice(0, 10),
          end_date: r.end_date instanceof Date
            ? r.end_date.toISOString().slice(0, 10)
            : String(r.end_date).slice(0, 10),
          updated_at: r.updated_at,
          updated_by: r.updated_by
        }));
        return res.status(200).json({ sessions });
      }

      // Writes — gated to President OR Vice-President. canEditAsRole
      // is checked twice (once per role) because there's no OR helper
      // in _permissions.js. Past school years are read-only history:
      // if the row's school_year is older than the active year, we
      // reject the write so historical dates never get rewritten
      // through the UI.
      async function canManageCoopSessions(email) {
        if (!email) return false;
        // 'session_dates_edit' — defaults to President + VP; editable in
        // the Permissions admin table.
        return await hasCapability(email, 'session_dates_edit');
      }
      function isReadOnlyYear(schoolYear) {
        // String compare works because "YYYY-YYYY" sorts chronologically.
        return String(schoolYear || '') < activeSchoolYear();
      }

      if (req.method === 'POST') {
        if (!(await canManageCoopSessions(user.email))) {
          return res.status(403).json({ error: 'Only the President or Vice-President can manage co-op sessions.' });
        }
        const body = req.body || {};
        const schoolYear = String(body.school_year || '').trim();
        const sessionNumber = parseInt(body.session_number, 10);
        const name = String(body.name || '').trim();
        const startDate = String(body.start_date || '').trim();
        const endDate = String(body.end_date || '').trim();
        // Format checks — keep them strict so a typo in the modal
        // can't write a garbage date the client will then fail to parse.
        if (!/^\d{4}-\d{4}$/.test(schoolYear)) {
          return res.status(400).json({ error: 'school_year must be "YYYY-YYYY".' });
        }
        const yrA = parseInt(schoolYear.slice(0, 4), 10);
        const yrB = parseInt(schoolYear.slice(5), 10);
        if (yrB !== yrA + 1) {
          return res.status(400).json({ error: 'school_year second half must be the year after the first half.' });
        }
        if (!Number.isInteger(sessionNumber) || sessionNumber < 1 || sessionNumber > 20) {
          return res.status(400).json({ error: 'session_number must be a positive integer (1-20).' });
        }
        if (!name) return res.status(400).json({ error: 'name is required.' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD.' });
        }
        if (endDate < startDate) {
          return res.status(400).json({ error: 'end_date must be on or after start_date.' });
        }
        if (isReadOnlyYear(schoolYear)) {
          return res.status(400).json({ error: 'Past school years are read-only history.' });
        }
        const inserted = await sql`
          INSERT INTO co_op_sessions
            (school_year, session_number, name, start_date, end_date, updated_at, updated_by)
          VALUES
            (${schoolYear}, ${sessionNumber}, ${name}, ${startDate}, ${endDate}, NOW(), ${user.email})
          ON CONFLICT (school_year, session_number) DO UPDATE
            SET name = EXCLUDED.name,
                start_date = EXCLUDED.start_date,
                end_date = EXCLUDED.end_date,
                updated_at = NOW(),
                updated_by = EXCLUDED.updated_by
          RETURNING id, school_year, session_number, name, start_date, end_date,
                    gcal_event_id, updated_at, updated_by
        `;
        const r = inserted[0];
        // Publish/refresh the session's weekly co-op-day event (9:40 AM –
        // 3:15 PM) on the Google Calendar so it always follows the dates
        // set here. Production only — dev shares the one real calendar
        // but has its own DB rows, so a dev save would double-publish.
        // Non-fatal: a Google hiccup never blocks the session save.
        if (process.env.VERCEL_ENV === 'production') {
          try {
            const { syncSessionToGoogleCalendar } = require('./tour.js');
            await syncSessionToGoogleCalendar(sql, r);
          } catch (gErr) {
            console.error('Session gcal sync error (non-fatal):', (gErr && gErr.message) || gErr);
          }
        }
        return res.status(200).json({
          session: {
            id: r.id,
            school_year: r.school_year,
            session_number: r.session_number,
            name: r.name,
            start_date: r.start_date instanceof Date
              ? r.start_date.toISOString().slice(0, 10)
              : String(r.start_date).slice(0, 10),
            end_date: r.end_date instanceof Date
              ? r.end_date.toISOString().slice(0, 10)
              : String(r.end_date).slice(0, 10),
            updated_at: r.updated_at,
            updated_by: r.updated_by
          }
        });
      }

      if (req.method === 'DELETE') {
        if (!(await canManageCoopSessions(user.email))) {
          return res.status(403).json({ error: 'Only the President or Vice-President can manage co-op sessions.' });
        }
        const id = parseInt(req.query.id, 10);
        if (!Number.isInteger(id) || id < 1) {
          return res.status(400).json({ error: 'id query parameter is required.' });
        }
        // Look up the row first so we can enforce the past-year guard
        // (and surface a 404 cleanly instead of a silent no-op delete).
        const existing = await sql`SELECT school_year, gcal_event_id FROM co_op_sessions WHERE id = ${id}`;
        if (existing.length === 0) {
          return res.status(404).json({ error: 'Session not found.' });
        }
        if (isReadOnlyYear(existing[0].school_year)) {
          return res.status(400).json({ error: 'Past school years are read-only history.' });
        }
        await sql`DELETE FROM co_op_sessions WHERE id = ${id}`;
        // Take the recurring Google event with it (prod only, non-fatal).
        if (process.env.VERCEL_ENV === 'production' && existing[0].gcal_event_id) {
          try {
            const { deleteGoogleCalendarEvent } = require('./tour.js');
            await deleteGoogleCalendarEvent(existing[0].gcal_event_id);
          } catch (gErr) {
            console.error('Session gcal delete error (non-fatal):', (gErr && gErr.message) || gErr);
          }
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Role-holder confirmations ──
    // Per-year tick the Communications Director sets once she's done
    // reviewing role holders for the new school year. Used by the To Do
    // widget to stop nagging — the existence of a row IS the affirmative
    // signal. Any signed-in @rootsandwingsindy.com user can read (the
    // dashboard surfaces the state). Only the Comms Director (or a
    // super user impersonating her via View-As) can write.
    if (action === 'role-confirm') {
      if (req.method === 'GET') {
        const rows = await sql`
          SELECT school_year, confirmed_at, confirmed_by_email
          FROM role_holder_confirmations
          ORDER BY school_year
        `;
        return res.status(200).json({ confirmations: rows });
      }
      // 'board_confirm' — defaults to Comms; Permissions-table editable.
      const canConfirm = await hasCapability(user.email, 'board_confirm');
      if (!canConfirm) {
        return res.status(403).json({ error: 'Only the Communications Director can confirm role holders.' });
      }
      if (req.method === 'POST') {
        const body = req.body || {};
        const schoolYear = String(body.school_year || '').trim();
        if (!/^\d{4}-\d{4}$/.test(schoolYear)) {
          return res.status(400).json({ error: 'school_year must be "YYYY-YYYY".' });
        }
        const inserted = await sql`
          INSERT INTO role_holder_confirmations (school_year, confirmed_at, confirmed_by_email)
          VALUES (${schoolYear}, NOW(), ${user.email})
          ON CONFLICT (school_year) DO UPDATE
            SET confirmed_at = NOW(),
                confirmed_by_email = EXCLUDED.confirmed_by_email
          RETURNING school_year, confirmed_at, confirmed_by_email
        `;
        return res.status(200).json({ confirmation: inserted[0] });
      }
      if (req.method === 'DELETE') {
        const schoolYear = String(req.query.school_year || '').trim();
        if (!/^\d{4}-\d{4}$/.test(schoolYear)) {
          return res.status(400).json({ error: 'school_year query parameter is required.' });
        }
        await sql`DELETE FROM role_holder_confirmations WHERE school_year = ${schoolYear}`;
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── Role Holders (v2) ──
    // Reads from role_holders_v2 + people. Response preserves the legacy
    // field names (`email`, `person_name`, `family_name`) so the existing
    // Roles Manager UI continues to work through Phase 4. person_name and
    // family_name are derived from the people table — person_email is the
    // join key. Holders without a people row (typical for shared board
    // mailboxes like president@) get an empty person_name/family_name.
    if (action === 'role-holders') {
      if (req.method === 'GET') {
        const schoolYear = req.query.school_year || '2025-2026';
        const holders = await sql`
          SELECT
            rhv.id, rhv.role_id,
            rhv.person_email AS email,
            TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS person_name,
            COALESCE(p.last_name, '') AS family_name,
            rhv.school_year, rhv.started_at,
            rhv.updated_at, rhv.updated_by
          FROM role_holders_v2 rhv
          LEFT JOIN people p ON LOWER(p.email) = LOWER(rhv.person_email)
          WHERE rhv.school_year = ${schoolYear}
            AND rhv.ended_at IS NULL
          ORDER BY rhv.role_id, person_name
        `;
        return res.status(200).json({ school_year: schoolYear, holders });
      }

      if (req.method === 'POST') {
        const { role_id, email, school_year } = req.body || {};
        const roleId = parseInt(role_id, 10);
        if (!roleId || !email) {
          return res.status(400).json({ error: 'role_id and email required' });
        }
        const yr = String(school_year || '2025-2026').trim();
        const personEmail = String(email).trim().toLowerCase();
        // Board roles (President, VP, Treasurer, etc.) are gated to the
        // Communications Director — she owns the Workspace mailbox /
        // group memberships that back those roles. Committee roles fall
        // back to the usual content-edit ladder so each chair can manage
        // their own committee.
        const allowed = await canEditRoleHolders(user.email, sql, roleId);
        if (!allowed) {
          return res.status(403).json({ error: 'Not authorized to assign holders for this role' });
        }
        // Board roles are single-seat: President, VP, Treasurer, etc. each
        // have exactly one holder per year. Committee roles can be co-held,
        // so this replace-guard only fires for category='board'. Without it
        // the UI silently stacks a second active holder, and the two board
        // surfaces disagree (My Family card dedups to one; the org chart
        // lists all). See the dup-President incident on dev (2026-06-27).
        const roleRow = await sql`SELECT category FROM roles WHERE id = ${roleId} LIMIT 1`;
        const isBoardRole = roleRow[0] && roleRow[0].category === 'board';
        if (isBoardRole) {
          // Idempotent: re-assigning the same person is a no-op — return the
          // existing active holder instead of inserting a duplicate.
          const existing = await sql`
            SELECT id, role_id, person_email, school_year
            FROM role_holders_v2
            WHERE role_id = ${roleId} AND school_year = ${yr}
              AND LOWER(person_email) = ${personEmail} AND ended_at IS NULL
            LIMIT 1
          `;
          if (existing.length > 0) {
            const e = existing[0];
            const en = await sql`
              SELECT TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS person_name,
                     COALESCE(p.last_name, '') AS family_name
              FROM people p WHERE LOWER(p.email) = ${personEmail} LIMIT 1
            `;
            const ed = en[0] || { person_name: '', family_name: '' };
            return res.status(200).json({
              holder: {
                id: e.id, role_id: e.role_id, email: e.person_email,
                person_name: ed.person_name, family_name: ed.family_name,
                school_year: e.school_year
              }
            });
          }
          // Replace: remove whoever currently holds this board seat for the
          // year so the new assignment is the sole holder. Hard-delete (not
          // soft-end) to match the DELETE endpoint and because the unique
          // index (role_id, lower(person_email), school_year) ignores
          // ended_at — a soft-ended row would permanently block re-assigning
          // that same person to this seat later.
          await sql`
            DELETE FROM role_holders_v2
            WHERE role_id = ${roleId} AND school_year = ${yr} AND ended_at IS NULL
          `;
        }
        const inserted = await sql`
          INSERT INTO role_holders_v2 (role_id, person_email, school_year, updated_by)
          VALUES (${roleId}, ${personEmail}, ${yr}, ${user.email})
          RETURNING id, role_id, person_email, school_year
        `;
        const row = inserted[0];
        // Resolve display names from people for the response so the UI
        // can render the new holder without an extra round-trip.
        const named = await sql`
          SELECT
            TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS person_name,
            COALESCE(p.last_name, '') AS family_name
          FROM people p
          WHERE LOWER(p.email) = ${personEmail}
          LIMIT 1
        `;
        const display = named[0] || { person_name: '', family_name: '' };
        return res.status(201).json({
          holder: {
            id: row.id,
            role_id: row.role_id,
            email: row.person_email,
            person_name: display.person_name,
            family_name: display.family_name,
            school_year: row.school_year
          }
        });
      }

      if (req.method === 'DELETE') {
        const id = parseInt(req.query.id, 10);
        if (!id) return res.status(400).json({ error: 'id required' });
        const row = await sql`SELECT role_id FROM role_holders_v2 WHERE id = ${id}`;
        if (row.length === 0) return res.status(404).json({ error: 'Not found' });
        const allowed = await canEditRoleHolders(user.email, sql, row[0].role_id);
        if (!allowed) {
          return res.status(403).json({ error: 'Not authorized to remove holders for this role' });
        }
        await sql`DELETE FROM role_holders_v2 WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
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
        const yr = await activeCleaningYear(sql);
        const inserted = await sql`
          INSERT INTO cleaning_assignments (session_number, cleaning_area_id, family_name, updated_by, school_year)
          VALUES (${session_number}, ${cleaning_area_id}, ${String(family_name).trim()}, ${user.email}, ${yr})
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

    // ── Config update (retired in Phase 5) ──
    // The Cleaning Crew Liaison is now a regular role with role_key =
    // 'cleaning_crew_liaison'. Assign/unassign via ?action=role-holders.
    if (action === 'config' && req.method === 'PATCH') {
      return res.status(410).json({
        error: 'cleaning_config has been retired. Assign the Cleaning Crew Liaison via /api/cleaning?action=role-holders (POST/DELETE) against the cleaning_crew_liaison role.'
      });
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
