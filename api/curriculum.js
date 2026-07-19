// Curriculum Repository API
//
// GET    /api/curriculum                       → list all curricula (summary)
// GET    /api/curriculum?id=N                  → full curriculum with lessons + supplies
// POST   /api/curriculum                       → create new curriculum (+ lessons)
// POST   /api/curriculum?id=N&action=copy      → deep-copy an existing curriculum
// PATCH  /api/curriculum?id=N                  → update curriculum (+ lessons)
// DELETE /api/curriculum?id=N                  → delete curriculum
//
// Auth: Google JWT with @rootsandwingsindy.com domain (read = any logged-in
// member; write = author OR edit_policy='open' OR board member).
// Board check is done client-side; server enforces author/open policy.

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { Resend } = require('./_resend');
const { ALLOWED_ORIGINS, emailSubject } = require('./_config');
const { canEditAsRole, getRoleHolderEmail, isSuperUser, activeSchoolYear, canImpersonate, isBoardMember } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { resolveFamily, canActAs } = require('./_family');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

// When a super user passes ?view_as=<member-email>, return that email so
// the scope=mine query filters by the impersonated identity. Mirrors
// resolveRecipient() in api/notifications.js.
function resolveSubmitterEmail(user, viewAsQuery) {
  // canImpersonate, not isSuperUser, so dev/preview testers (any signed-in
  // @rootsandwingsindy.com member) can View-As too — matches the server's
  // impersonation model. On prod canImpersonate === super user, so unchanged.
  if (!canImpersonate(user.email)) return user.email;
  const va = (viewAsQuery || '').toString().trim().toLowerCase();
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
    const domain = email.split('@')[1] || '';
    if (domain !== ALLOWED_DOMAIN) return null;
    return { email: email, name: payload.name || '' };
  } catch (e) {
    return null;
  }
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

// Validate a lesson payload from the client. Coerces types, trims strings.
function normalizeLesson(raw, lessonNumber) {
  raw = raw || {};
  return {
    lesson_number: lessonNumber,
    title: String(raw.title || '').trim().slice(0, 200),
    overview: String(raw.overview || '').trim().slice(0, 2000),
    room_setup: String(raw.room_setup || '').trim().slice(0, 2000),
    // activity/instruction are parallel arrays — preserve index alignment.
    // Trim trailing rows that are empty in BOTH arrays, but keep interior
    // empties so a note on step 6 stays on step 6.
    ...(function () {
      var act = Array.isArray(raw.activity) ? raw.activity.map(s => String(s || '').trim()) : [];
      var ins = Array.isArray(raw.instruction) ? raw.instruction.map(s => String(s || '').trim()) : [];
      var len = Math.max(act.length, ins.length);
      while (len > 0 && !(act[len - 1] || '') && !(ins[len - 1] || '')) len--;
      act = act.slice(0, Math.min(len, 30));
      ins = ins.slice(0, Math.min(len, 30));
      while (act.length < ins.length) act.push('');
      while (ins.length < act.length) ins.push('');
      return { activity: act, instruction: ins };
    })(),
    links: Array.isArray(raw.links)
      ? raw.links.map(l => ({
          label: String((l && l.label) || '').trim().slice(0, 200),
          url: String((l && l.url) || '').trim().slice(0, 500)
        })).filter(l => l.url).slice(0, 20)
      : [],
    supplies: Array.isArray(raw.supplies)
      ? raw.supplies.map(s => {
          var unit = String((s && s.qty_unit) || '').trim().toLowerCase();
          if (unit !== 'student' && unit !== 'class') unit = '';
          return {
            item_name: String((s && s.item_name) || '').trim().slice(0, 200),
            qty: String((s && s.qty) || '').trim().slice(0, 60),
            qty_unit: unit,
            notes: String((s && s.notes) || '').trim().slice(0, 500),
            closet_item_id: (s && s.closet_item_id) ? parseInt(s.closet_item_id, 10) || null : null
          };
        }).filter(s => s.item_name).slice(0, 50)
      : []
  };
}

async function getFullCurriculum(sql, id) {
  const curr = await sql`
    SELECT id, title, subject, age_range, overview, tags, author_email, author_name,
           parent_id, edit_policy, lesson_count, block, is_favorite, created_at, updated_at
    FROM curricula
    WHERE id = ${id}
  `;
  if (curr.length === 0) return null;

  const lessons = await sql`
    SELECT id, lesson_number, title, overview, room_setup, activity, instruction, links
    FROM lessons
    WHERE curriculum_id = ${id}
    ORDER BY lesson_number
  `;
  const supplies = await sql`
    SELECT cs.id, cs.lesson_id, cs.item_name, cs.qty, cs.qty_unit, cs.notes, cs.closet_item_id,
           COALESCE(sc_id.location, sc_name.location) AS closet_location,
           COALESCE(cs.closet_item_id, sc_name.id) AS resolved_closet_id,
           COALESCE(sc_id.needs_restock, sc_name.needs_restock, FALSE) AS closet_needs_restock,
           COALESCE(sc_id.quantity_level, sc_name.quantity_level) AS closet_quantity_level,
           l.lesson_number
    FROM curriculum_supplies cs
    JOIN lessons l ON l.id = cs.lesson_id
    LEFT JOIN supply_closet sc_id ON sc_id.id = cs.closet_item_id
    LEFT JOIN LATERAL (
      SELECT id, location, needs_restock, quantity_level FROM supply_closet
      WHERE cs.closet_item_id IS NULL
        AND LOWER(TRIM(supply_closet.item_name)) = LOWER(TRIM(cs.item_name))
      LIMIT 1
    ) sc_name ON true
    WHERE l.curriculum_id = ${id}
    ORDER BY l.lesson_number, cs.id
  `;
  // Attach supplies to their lessons
  const byLesson = {};
  supplies.forEach(s => {
    if (!byLesson[s.lesson_id]) byLesson[s.lesson_id] = [];
    byLesson[s.lesson_id].push({
      id: s.id,
      item_name: s.item_name,
      qty: s.qty,
      qty_unit: s.qty_unit || '',
      notes: s.notes,
      closet_item_id: s.resolved_closet_id || s.closet_item_id,
      closet_location: s.closet_location || '',
      closet_needs_restock: !!s.closet_needs_restock,
      closet_quantity_level: s.closet_quantity_level || null
    });
  });
  lessons.forEach(l => { l.supplies = byLesson[l.id] || []; });

  const result = curr[0];
  result.lessons = lessons;
  return result;
}

// 'AM' / 'PM' / 'both' / '' (empty = not categorised). Anything else is
// dropped. Validation shared by create + update paths.
function normalizeBlock(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (v === 'AM' || v === 'PM' || v === 'both') return v;
  return '';
}

async function createCurriculum(sql, user, body) {
  const title = String(body.title || '').trim().slice(0, 200);
  if (!title) throw new Error('title required');

  const subject = String(body.subject || '').trim().slice(0, 100);
  const age_range = String(body.age_range || '').trim().slice(0, 50);
  const overview = String(body.overview || '').trim().slice(0, 2000);
  const tags = Array.isArray(body.tags)
    ? body.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20)
    : [];
  const edit_policy = (body.edit_policy === 'open') ? 'open' : 'author_only';
  const lesson_count = Math.max(1, Math.min(5, parseInt(body.lesson_count, 10) || 5));
  const block = normalizeBlock(body.block);

  const lessonRows = Array.isArray(body.lessons) ? body.lessons : [];
  const normalizedLessons = [];
  for (let i = 0; i < lesson_count; i++) {
    normalizedLessons.push(normalizeLesson(lessonRows[i], i + 1));
  }

  const inserted = await sql`
    INSERT INTO curricula (title, subject, age_range, overview, tags, author_email, author_name, edit_policy, lesson_count, block, parent_id)
    VALUES (${title}, ${subject}, ${age_range}, ${overview}, ${tags}, ${user.email}, ${user.name}, ${edit_policy}, ${lesson_count}, ${block}, ${body.parent_id || null})
    RETURNING id
  `;
  const id = inserted[0].id;

  for (const ls of normalizedLessons) {
    const lessonResult = await sql`
      INSERT INTO lessons (curriculum_id, lesson_number, title, overview, room_setup, activity, instruction, links)
      VALUES (${id}, ${ls.lesson_number}, ${ls.title}, ${ls.overview}, ${ls.room_setup}, ${ls.activity}, ${ls.instruction}, ${JSON.stringify(ls.links)})
      RETURNING id
    `;
    const lessonId = lessonResult[0].id;
    for (const sp of ls.supplies) {
      await sql`
        INSERT INTO curriculum_supplies (lesson_id, item_name, qty, qty_unit, notes, closet_item_id)
        VALUES (${lessonId}, ${sp.item_name}, ${sp.qty}, ${sp.qty_unit || ''}, ${sp.notes}, ${sp.closet_item_id})
      `;
    }
  }

  return id;
}

async function replaceLessons(sql, curriculumId, lessonCount, lessonRows) {
  // Atomic replace (2026-07-17 review): the old code DELETEd all lessons
  // (cascading to supplies) then re-inserted one autocommit statement at a
  // time — a crash mid-save destroyed the author's lessons for good. The
  // lesson replacement now runs as a single transaction; supplies (which
  // need each lesson's returned id) go in a second transaction, so the
  // worst case is lessons-present-without-supplies (re-savable), never the
  // lessons themselves vanishing.
  const normalized = [];
  for (let i = 0; i < lessonCount; i++) normalized.push(normalizeLesson(lessonRows[i], i + 1));

  const lessonStmts = [sql`DELETE FROM lessons WHERE curriculum_id = ${curriculumId}`];
  normalized.forEach(ls => {
    lessonStmts.push(sql`
      INSERT INTO lessons (curriculum_id, lesson_number, title, overview, room_setup, activity, instruction, links)
      VALUES (${curriculumId}, ${ls.lesson_number}, ${ls.title}, ${ls.overview}, ${ls.room_setup}, ${ls.activity}, ${ls.instruction}, ${JSON.stringify(ls.links)})
      RETURNING id
    `);
  });
  const results = await sql.transaction(lessonStmts);

  // results[0] is the DELETE; results[k+1] is lesson k's RETURNING row.
  const supplyStmts = [];
  normalized.forEach((ls, k) => {
    const lessonId = results[k + 1][0].id;
    ls.supplies.forEach(sp => {
      supplyStmts.push(sql`
        INSERT INTO curriculum_supplies (lesson_id, item_name, qty, qty_unit, notes, closet_item_id)
        VALUES (${lessonId}, ${sp.item_name}, ${sp.qty}, ${sp.qty_unit || ''}, ${sp.notes}, ${sp.closet_item_id})
      `);
    });
  });
  if (supplyStmts.length) await sql.transaction(supplyStmts);
}

function canEdit(user, row) {
  if (!row) return false;
  if (row.edit_policy === 'open') return true;
  return row.author_email === user.email;
}

// ──────────────────────────────────────────────
// Class submissions (replaces the PM class Google Form)
// ──────────────────────────────────────────────

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Whitelists that mirror the Google Form checkboxes. Anything outside the
// list is dropped so bad clients can't inject arbitrary strings into the
// column arrays.
const SESSION_PREF_VALUES  = ['1','2','3','4','5','flexible'];
const HOUR_PREF_VALUES     = ['first','last','flexible','2hr-required','2hr-optional'];
const ASSISTANT_COUNT_VALS = [1, 2, 3];
const SPACE_REQ_VALUES     = ['any','pavilion','outside','larger-open','kitchen','dirty','noisy','quiet'];
// Matches AGE_RANGE_OPTIONS in the curriculum library (script.js) so reviewers
// see familiar co-op group names instead of generic age bands.
// Selectable buckets: the 8 named groups + "All ages". The composite "Mixed:…"
// options were retired (teachers check the individual buckets a class spans).
// prettyAges still maps the legacy mixed keys so old submissions display right.
const AGE_GROUP_VALUES     = [
  // 'greenhouse' (0–2) is selectable for MORNING submissions only — the
  // client hides it on the afternoon form; the AM branch in
  // normalizeSubmission is what actually accepts it.
  'greenhouse','saplings','sassafras','oaks','maples','birch','willows','cedars','pigeons','all-ages'
];

function pickArray(raw, allowed, opts) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = {};
  for (const v of raw) {
    const s = (opts && opts.int) ? parseInt(v, 10) : String(v || '').trim().toLowerCase();
    if (opts && opts.int) {
      if (!allowed.includes(s)) continue;
    } else {
      if (!allowed.includes(s)) continue;
    }
    if (seen[s]) continue;
    seen[s] = true;
    out.push(s);
  }
  return out;
}

// Normalize + validate a submission body. Throws Error with a user-facing
// message on invalid input. Returns the cleaned shape ready to INSERT.
function normalizeSubmission(body) {
  body = body || {};
  // Morning vs afternoon proposal (2026-07-05). Morning classes: exactly
  // ONE age group (no combining), no hour preference (afternoon concept),
  // no space pick (rooms are assigned for the year), and no class size
  // (the group's roster IS the size — stored as 0 = n/a).
  const class_period = String(body.class_period || 'PM').trim().toUpperCase() === 'AM' ? 'AM' : 'PM';
  const isAM = class_period === 'AM';

  const class_name = String(body.class_name || '').trim().slice(0, 200);
  if (!class_name) throw new Error('Class Name is required.');

  const description = String(body.description || '').trim().slice(0, 3000);
  if (!description) throw new Error('A class description is required.');

  const session_preferences = pickArray(body.session_preferences, SESSION_PREF_VALUES);
  if (session_preferences.length === 0) throw new Error('Pick at least one session preference.');

  // Morning hours (2026-07-06): a group's morning can be one 2-hour class
  // or two 1-hour classes — submitters pick 1st / 2nd / both (default both).
  let hour_preference;
  if (isAM) {
    hour_preference = pickArray(body.hour_preference, ['first', 'last', 'both']).slice(0, 1);
    if (hour_preference.length === 0) hour_preference = ['both'];
  } else {
    hour_preference = pickArray(body.hour_preference, HOUR_PREF_VALUES);
    if (hour_preference.length === 0) throw new Error('Pick at least one hour preference.');
  }

  const assistant_count = pickArray(body.assistant_count, ASSISTANT_COUNT_VALS, { int: true });
  if (assistant_count.length === 0) throw new Error('Pick how many assistants you would like.');

  const space_request = isAM ? [] : pickArray(body.space_request, SPACE_REQ_VALUES);
  const space_request_other = isAM ? '' : String(body.space_request_other || '').trim().slice(0, 300);
  if (!isAM && space_request.length === 0 && !space_request_other) {
    throw new Error('Pick at least one space request.');
  }

  const age_groups = pickArray(body.age_groups, AGE_GROUP_VALUES);
  const age_groups_other = isAM ? '' : String(body.age_groups_other || '').trim().slice(0, 200);
  if (isAM) {
    if (age_groups.length !== 1 || age_groups[0] === 'all-ages') {
      throw new Error('Morning classes are for exactly one age group.');
    }
    if (age_groups[0] === 'greenhouse') {
      throw new Error('No morning programming is offered for the Greenhouse (0–2) group — toddlers stay with their parents.');
    }
  } else {
    if (age_groups.indexOf('greenhouse') !== -1) {
      throw new Error('Greenhouse is a morning-only age group.');
    }
    if (age_groups.length === 0 && !age_groups_other) {
      throw new Error('Pick at least one age group.');
    }
  }

  // max_students: 10 / 12 / 15 or a free-text "Other" that parses to a
  // positive int. Morning classes store 0 (= n/a; the roster is the size).
  let max_students = 0;
  let max_students_other = '';
  if (!isAM) {
    max_students = parseInt(body.max_students, 10);
    max_students_other = String(body.max_students_other || '').trim().slice(0, 40);
    if (!Number.isFinite(max_students) || max_students <= 0) {
      max_students = parseInt(max_students_other, 10);
    }
    if (!Number.isFinite(max_students) || max_students <= 0 || max_students > 100) {
      throw new Error('Enter a valid maximum class size.');
    }
  }

  const co_teachers     = String(body.co_teachers || '').trim().slice(0, 500);
  const pre_enroll_kids = String(body.pre_enroll_kids || '').trim().slice(0, 500);
  const prerequisites   = String(body.prerequisites || '').trim().slice(0, 1000);
  const other_info      = String(body.other_info || '').trim().slice(0, 2000);
  const school_year     = String(body.school_year || '2026-2027').trim().slice(0, 20);
  const open_to_teen_assistant = !!body.open_to_teen_assistant;

  return {
    class_period, class_name, session_preferences, hour_preference, assistant_count,
    co_teachers, space_request, space_request_other,
    max_students, max_students_other, age_groups, age_groups_other,
    pre_enroll_kids, open_to_teen_assistant, prerequisites, description, other_info, school_year
  };
}

// Valid status values for a reviewer PATCH. `withdrawn` is intentionally
// excluded — only the submitter can withdraw (via DELETE).
const REVIEWER_STATUS_VALUES = ['submitted', 'drafted', 'scheduled', 'declined'];
// Morning placements: 'AM' = both morning hours, 'AM1'/'AM2' = a 1-hour
// morning class (a group's morning can split in two, 2026-07-06).
const SCHEDULED_HOUR_VALUES = ['PM1', 'PM2', 'both', 'AM', 'AM1', 'AM2'];

// Normalize a reviewer PATCH body. Returns the cleaned fields + the status
// that was chosen. Throws Error on invalid input.
function normalizeReviewerPatch(body) {
  body = body || {};
  const status = String(body.status || '').trim();
  if (REVIEWER_STATUS_VALUES.indexOf(status) === -1) {
    throw new Error('Invalid status — must be submitted, drafted, scheduled, or declined.');
  }

  let scheduled_session = null;
  let scheduled_hour = null;
  let scheduled_age_range = '';
  let scheduled_room = '';

  if (body.scheduled_session != null && body.scheduled_session !== '') {
    const s = parseInt(body.scheduled_session, 10);
    if (!Number.isFinite(s) || s < 1 || s > 5) throw new Error('scheduled_session must be 1–5.');
    scheduled_session = s;
  }
  if (body.scheduled_hour) {
    const h = String(body.scheduled_hour).trim();
    if (SCHEDULED_HOUR_VALUES.indexOf(h) === -1) {
      throw new Error('scheduled_hour must be PM1, PM2, or both.');
    }
    scheduled_hour = h;
  }
  let scheduled_backup_room = '';
  if (typeof body.scheduled_backup_room === 'string') {
    scheduled_backup_room = body.scheduled_backup_room.trim().slice(0, 100);
  }
  if (typeof body.scheduled_age_range === 'string') {
    scheduled_age_range = body.scheduled_age_range.trim().slice(0, 100);
  }
  if (typeof body.scheduled_room === 'string') {
    scheduled_room = body.scheduled_room.trim().slice(0, 100);
  }

  // If scheduling, hour + session are required. Age range is strongly
  // recommended but not strictly enforced — VP may want to park something
  // in a section before finalising the exact group.
  if (status === 'scheduled' && (!scheduled_session || !scheduled_hour)) {
    throw new Error('Scheduling requires a session and an hour (PM1, PM2, or both).');
  }

  const reviewer_notes = String(body.reviewer_notes || '').slice(0, 2000);

  return {
    status, scheduled_session, scheduled_hour,
    scheduled_age_range, scheduled_room, reviewer_notes
  };
}

// Reviewer scope (2026-07-06, per-group liaison scoping):
//   { all: true }                  — super user, VP, Afternoon Class Liaison
//   { all: false, groups: [...] } — age-group class liaisons ("Pigeons Class
//                                    Liaison" → ['pigeons']); may only build
//                                    the MORNING schedule for their group(s)
//   null                           — not a reviewer
const LIAISON_GROUPS = ['greenhouse', 'saplings', 'sassafras', 'oaks', 'maples', 'birch', 'willows', 'cedars', 'pigeons'];
async function reviewerScope(email) {
  if (!email) return null;
  if (isSuperUser(email)) return { all: true };
  // 'class_review' capability — defaults to VP + Afternoon Class Liaison;
  // editable in the Permissions admin table. The per-group liaison path
  // below is structural and stays fixed.
  if (await hasCapability(email, 'class_review')) return { all: true };
  // Role titled "<Group> Liaison" (also accepts the older "<Group>
  // Morning Class Liaison" / "<Group> Class Liaison" spellings; singular
  // or plural group word) scopes the holder to that age group's morning
  // slots. The VP assigns these via Roles Assignments (grouped under the
  // generic Morning Class Liaison heading); the liaison then builds that
  // group's classes. Non-group liaisons ("Afternoon Class Liaison",
  // "Cleaning Crew Liaison"…) never match a group word, so the broader
  // ILIKE is safe.
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT r.title
      FROM role_holders_v2 h
      JOIN roles r ON r.id = h.role_id
      WHERE LOWER(h.person_email) = LOWER(${email})
        AND h.ended_at IS NULL
        AND r.status = 'active'
        AND r.title ILIKE '%liaison'
    `;
    const groups = [];
    rows.forEach(r => {
      const prefix = String(r.title || '').toLowerCase().replace(/\s*(morning\s+)?(class\s+)?liaison\s*$/, '').trim();
      LIAISON_GROUPS.forEach(g => {
        if ((prefix === g || prefix + 's' === g || prefix === g + 's') && groups.indexOf(g) === -1) groups.push(g);
      });
    });
    if (groups.length) return { all: false, groups };
  } catch (e) {
    console.error('reviewerScope liaison lookup failed:', e.message);
  }
  return null;
}
async function canReviewSubmissions(email) {
  return !!(await reviewerScope(email));
}

// View-As aware reviewer gate. While impersonating, the VIEWED email's
// scope applies — matching resolveSubmitterEmail (the submission files
// under the viewed member) and the identity swap every other endpoint
// does. The old real-scope-first order broke View-As for any tester
// whose OWN account holds a liaison role: their real (narrower) scope
// pinned them to their own age group no matter who they viewed as, and
// adds for the impersonated liaison's group 403'd (Erin, 2026-07-10 —
// "liaisons are not allowed to add classes even when they should").
// Not impersonating (or not allowed to): the real email's scope, so
// real liaisons and reviewers on prod are unchanged. view_as comes from
// the query (GET) or body (POST), matching resolveSubmitterEmail.
async function reviewerScopeReq(user, req) {
  const realEmail = user && user.email;
  const va = String((req.query && req.query.view_as) || (req.body && req.body.view_as) || '').trim().toLowerCase();
  if (va && (va.split('@')[1] || '') === ALLOWED_DOMAIN && canImpersonate(realEmail)) {
    return await reviewerScope(va);
  }
  return await reviewerScope(realEmail);
}
// The email whose permissions applied to this request — the View-As
// target when impersonating, else the real login. For error messages.
function actingEmailFor(user, req) {
  const realEmail = (user && user.email) || '';
  const va = String((req.query && req.query.view_as) || (req.body && req.body.view_as) || '').trim().toLowerCase();
  if (va && (va.split('@')[1] || '') === ALLOWED_DOMAIN && canImpersonate(realEmail)) return va;
  return realEmail;
}
async function isReviewerReq(user, req) {
  return !!(await reviewerScopeReq(user, req));
}
// Can this scope touch (schedule/edit/decline/delete) this submission row?
function scopeAllowsSub(scope, row) {
  if (!scope) return false;
  if (scope.all) return true;
  if (String(row.class_period || 'PM') !== 'AM') return false;
  const g = String(((row.age_groups || [])[0]) || '').toLowerCase();
  return scope.groups.indexOf(g) !== -1;
}

// Resolve the PM Assistant's current email from the volunteer sheet. Returns
// null if the role isn't filled or the lookup fails — caller should handle.
async function getPmAssistantEmail() {
  try { return await getRoleHolderEmail('Afternoon Class Liaison'); }
  catch (e) { return null; }
}

function prettySessionPrefs(a) {
  return a.map(s => s === 'flexible' ? 'any session' : 'Session ' + s).join(', ');
}
function prettyHourPrefs(a, isAM) {
  const map = isAM
    ? {
        'both': 'Both morning hours (10:00–11:55)',
        'first': 'Hour 1 (10:00–10:55)',
        'last': 'Hour 2 (11:00–11:55)'
      }
    : {
        'first': 'PM1 (first hour)',
        'last': 'PM2 (last hour)',
        'flexible': 'Either PM1 or PM2',
        '2hr-required': 'Both PM1 & PM2 (required)',
        '2hr-optional': 'Both PM1 & PM2 (one or both)'
      };
  return a.map(v => map[v] || v).join(', ');
}
function prettySpace(a, other) {
  const map = {
    any: 'Any room', pavilion: 'Outside Pavilion', outside: 'Outside',
    'larger-open': 'Larger open room', kitchen: 'Kitchen',
    dirty: 'Someplace to get dirty', noisy: 'We will be noisy', quiet: 'Need quiet'
  };
  const parts = a.map(v => map[v] || v);
  if (other) parts.push(other);
  return parts.join(', ');
}
// Whole-year age as of today from a YYYY-MM-DD birth date (or Date).
// Returns null for a missing/invalid date.
function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const bd = new Date(birthDate);
  if (isNaN(bd.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - bd.getUTCFullYear();
  const mo = now.getUTCMonth() - bd.getUTCMonth();
  if (mo < 0 || (mo === 0 && now.getUTCDate() < bd.getUTCDate())) age--;
  return age >= 0 ? age : 0;
}

function prettyAges(a, other) {
  const map = {
    saplings: 'Saplings (3–5)', sassafras: 'Sassafras (5–6)',
    oaks: 'Oaks (7–8)', maples: 'Maples (8–9)', birch: 'Birch (9–10)',
    willows: 'Willows (10–11)', cedars: 'Cedars (12–13)', pigeons: 'Pigeons (14+)',
    'mixed-younger': 'Mixed: Younger (3–8)',
    'mixed-elementary': 'Mixed: Elementary (5–11)',
    'mixed-older': 'Mixed: Older (8–14)',
    'all-ages': 'All ages'
  };
  const parts = a.map(v => map[v] || v);
  if (other) parts.push(other);
  return parts.join(', ');
}

async function sendSubmissionConfirmation(sub) {
  if (!process.env.RESEND_API_KEY) return;
  const resend = new Resend(process.env.RESEND_API_KEY);
  // Morning and afternoon ideas share this pipeline since the one-builder
  // merge — the wording follows the submission's period (Erin, 2026-07-15:
  // a morning submission's email said "PM class").
  const isAM = String(sub.class_period || 'PM').toUpperCase() === 'AM';
  const periodWord = isAM ? 'Morning' : 'Afternoon';
  const pmEmail = await getPmAssistantEmail();

  const cc = ['vicepresident@rootsandwingsindy.com'];
  // The Afternoon Class Liaison is only copied on afternoon ideas.
  if (!isAM && pmEmail && pmEmail.toLowerCase() !== sub.submitted_by_email.toLowerCase()) {
    cc.push(pmEmail);
  }

  const rows = [
    ['Class name',       escapeHtml(sub.class_name)],
    ['Sessions',         escapeHtml(prettySessionPrefs(sub.session_preferences))],
    ['Hour preference',  escapeHtml(prettyHourPrefs(sub.hour_preference, isAM))],
    ['Assistants',       escapeHtml(sub.assistant_count.join(' or ') + ' helper(s)')],
    ['Co-teachers',      escapeHtml(sub.co_teachers || '—')],
    ['Age groups',       escapeHtml(prettyAges(sub.age_groups, sub.age_groups_other))],
    ['Teen assistant OK', sub.open_to_teen_assistant ? 'Yes — willing to host a Cedars or Pigeons (12+) assistant' : 'No'],
    ['Prerequisites',    escapeHtml(sub.prerequisites || '—')]
  ];
  // Space + class-size only apply to afternoon electives (morning classes
  // are whole-group with no size cap — the form doesn't collect these).
  if (!isAM) {
    rows.splice(5, 0,
      ['Space request',  escapeHtml(prettySpace(sub.space_request, sub.space_request_other))],
      ['Max students',   escapeHtml(String(sub.max_students))]);
  }
  const rowsHtml = rows.map(
    ([k, v]) => `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;vertical-align:top;">${k}</td><td>${v}</td></tr>`
  ).join('');

  try {
    await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: sub.submitted_by_email,
      cc,
      replyTo: 'vicepresident@rootsandwingsindy.com',
      subject: emailSubject(`${periodWord} Class Submission Received — ${sub.class_name}`),
      html: `
        <h2>Thanks for submitting a ${periodWord.toLowerCase()} class!</h2>
        <p>Your submission has been logged. ${isAM
          ? 'The VP has been copied on this email, and the class review team will reach out when they’re planning the next session.'
          : 'The VP and Afternoon Class Liaison have been copied on this email and will reach out when they’re planning the next session.'}</p>
        <table style="border-collapse:collapse;font-family:sans-serif;">${rowsHtml}</table>
        <h3 style="margin-top:18px;">Description</h3>
        <p style="white-space:pre-wrap;">${escapeHtml(sub.description)}</p>
        ${sub.other_info ? `<h3>Anything else</h3><p style="white-space:pre-wrap;">${escapeHtml(sub.other_info)}</p>` : ''}
        <p style="color:#666;font-size:0.9rem;margin-top:20px;">You can edit or withdraw this submission from the members portal until it's been drafted into a session.</p>
      `
    });
  } catch (mailErr) {
    console.error('Class submission email error (non-fatal):', mailErr);
  }
}

// Safe public shape for sending submissions back to the client. No reviewer-only
// fields are ever stripped here — reviewer notes etc. are fine for the submitter
// to see as well.
function serializeSubmission(r, helpers) {
  return {
    id: r.id,
    helpers: helpers || [],
    submitted_by_email: r.submitted_by_email,
    submitted_by_name: r.submitted_by_name,
    school_year: r.school_year,
    class_period: r.class_period || 'PM',
    class_name: r.class_name,
    session_preferences: r.session_preferences || [],
    hour_preference: r.hour_preference || [],
    assistant_count: r.assistant_count || [],
    co_teachers: r.co_teachers || '',
    space_request: r.space_request || [],
    space_request_other: r.space_request_other || '',
    max_students: r.max_students,
    max_students_other: r.max_students_other || '',
    age_groups: r.age_groups || [],
    age_groups_other: r.age_groups_other || '',
    pre_enroll_kids: r.pre_enroll_kids || '',
    open_to_teen_assistant: !!r.open_to_teen_assistant,
    prerequisites: r.prerequisites || '',
    description: r.description,
    other_info: r.other_info || '',
    status: r.status,
    scheduled_session: r.scheduled_session,
    scheduled_hour: r.scheduled_hour,
    scheduled_age_range: r.scheduled_age_range,
    scheduled_room: r.scheduled_room,
    scheduled_backup_room: r.scheduled_backup_room || '',
    reviewer_notes: r.reviewer_notes || '',
    reviewed_by_email: r.reviewed_by_email,
    reviewed_at: r.reviewed_at,
    created_at: r.created_at,
    updated_at: r.updated_at
  };
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
    const id = req.query.id ? parseInt(req.query.id, 10) : null;
    const action = req.query.action || '';

    // ── GET ──
    if (req.method === 'GET') {
      // Class submissions — list view. scope='mine' (default) returns only the
      // caller's rows; scope='all' is gated to VP / Afternoon Class Liaison /
      // super user for the Phase 2 review dashboard.
      if (action === 'class-submissions') {
        const scope = (req.query.scope || 'mine').toLowerCase();
        if (scope === 'all') {
          // Reviewers (VP / ACL / group liaisons / super) get their normal
          // scope. Board members get the same payload READ-ONLY
          // (reviewer_scope='board-read', Board at a Glance 2026-07-15) so
          // the Roles Assignments lenses can show them the year's classes;
          // is_reviewer stays false and every write path keeps its own gate.
          let rscope = await reviewerScopeReq(user, req);
          let boardRead = false;
          if (!rscope) {
            boardRead = await isBoardMember(actingEmailFor(user, req));
            if (!boardRead) {
              return res.status(403).json({ error: 'Reviewer access only' });
            }
            rscope = { all: true };
          }
          // Schedule Builder needs per-session approval state to lock the UI
          // for finalized sessions. Also returns the sign-up window per
          // session so the builder can surface the "Open Sign-Ups" date
          // panel inline. Both maps keyed by `${school_year}|${session_number}`
          // to keep the payload tiny even across multiple years.
          const [rows, approvalRows, windowRows, helperRows, memberRows] = await Promise.all([
            sql`SELECT * FROM class_submissions ORDER BY created_at DESC`,
            sql`SELECT school_year, session_number, approved_at, approved_by,
                       am_approved_at, am_approved_by
                FROM co_op_sessions
                WHERE approved_at IS NOT NULL OR am_approved_at IS NOT NULL`,
            sql`SELECT school_year, session_number, status,
                       signup_start_date, signup_end_date
                FROM class_signup_windows`,
            sql`SELECT class_submission_id, person_email, person_name
                FROM class_assignment_helpers ORDER BY class_submission_id, sort_order`,
            sql`SELECT email, personal_email, first_name, last_name
                FROM people WHERE COALESCE(role, '') <> 'blc'
                ORDER BY first_name, last_name`
          ]);
          // PM helpers per scheduled class (Phase B2) + a member picker list.
          const helpersBySub = {};
          helperRows.forEach(h => {
            (helpersBySub[h.class_submission_id] || (helpersBySub[h.class_submission_id] = []))
              .push({ email: h.person_email || '', name: h.person_name || '' });
          });
          const seenMem = new Set();
          const members = [];
          memberRows.forEach(p => {
            const nm = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
            const em = String(p.email || p.personal_email || '').toLowerCase();
            const k = em || nm.toLowerCase();
            if (!nm || seenMem.has(k)) return;
            seenMem.add(k);
            members.push({ name: nm, email: em });
          });
          const session_approvals = {};
          approvalRows.forEach(r => {
            session_approvals[r.school_year + '|' + r.session_number] = {
              approved_at: r.approved_at,
              approved_by: r.approved_by || '',
              am_approved_at: r.am_approved_at,
              am_approved_by: r.am_approved_by || ''
            };
          });
          const signup_windows = {};
          windowRows.forEach(r => {
            signup_windows[r.school_year + '|' + r.session_number] = {
              status: r.status || null,
              signup_start_date: r.signup_start_date
                ? (r.signup_start_date instanceof Date
                    ? r.signup_start_date.toISOString().slice(0, 10)
                    : String(r.signup_start_date).slice(0, 10))
                : null,
              signup_end_date: r.signup_end_date
                ? (r.signup_end_date instanceof Date
                    ? r.signup_end_date.toISOString().slice(0, 10)
                    : String(r.signup_end_date).slice(0, 10))
                : null
            };
          });
          return res.status(200).json({
            submissions: rows.map(r => serializeSubmission(r, helpersBySub[r.id] || [])),
            session_approvals,
            signup_windows,
            members,
            is_reviewer: !boardRead,
            // 'all' for VP/ACL/super; a lowercase group list for scoped
            // age-group liaisons — the builder greys out everything else;
            // 'board-read' for board members viewing read-only.
            reviewer_scope: boardRead ? 'board-read' : (rscope.all ? 'all' : rscope.groups)
          });
        }
        // scope=mine — super users may impersonate via ?view_as= so the
        // My Family card on a View-As'd dashboard shows that family's
        // submissions instead of the super user's own. Same pattern as
        // /api/notifications resolveRecipient.
        const filterEmail = resolveSubmitterEmail(user, req.query.view_as);
        const [rows, isReviewer] = await Promise.all([
          sql`SELECT * FROM class_submissions
              WHERE LOWER(submitted_by_email) = LOWER(${filterEmail})
              ORDER BY created_at DESC`,
          isReviewerReq(user, req)
        ]);
        return res.status(200).json({
          submissions: rows.map(serializeSubmission),
          is_reviewer: !!isReviewer
        });
      }

      // Published schedule — member-visible (2026-07-06, Erin: once a
      // session's schedule is approved it should be visible to any member,
      // replacing the Master-sheet session data in Co-op Coordination).
      // Returns ONLY approved periods' scheduled classes, stripped of
      // reviewer internals (no notes, no session/hour preferences), keyed
      // by session number. An approved-but-empty period publishes as []
      // so the client can tell "approved, none scheduled" from "not
      // approved yet" (null).
      if (action === 'published-schedule') {
        const year = String(req.query.school_year || '2026-2027').slice(0, 20);
        const [approvalRows, classRows, helperRows] = await Promise.all([
          sql`SELECT session_number, approved_at, am_approved_at
              FROM co_op_sessions WHERE school_year = ${year}`,
          sql`SELECT c.id, c.class_period, c.class_name, c.description,
                     c.submitted_by_name, c.submitted_by_email, c.co_teachers,
                     c.age_groups, c.age_groups_other, c.max_students,
                     c.scheduled_session, c.scheduled_hour, c.scheduled_age_range, c.scheduled_room,
                     (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
                       WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                          OR LOWER(p.personal_email) = LOWER(c.submitted_by_email)
                       LIMIT 1) AS person_name
              FROM class_submissions c
              WHERE c.status = 'scheduled' AND c.school_year = ${year}
                AND c.scheduled_session IS NOT NULL`,
          sql`SELECT class_submission_id, person_name
              FROM class_assignment_helpers ORDER BY class_submission_id, sort_order`
        ]);
        const helpersBySub = {};
        helperRows.forEach(h => {
          (helpersBySub[h.class_submission_id] || (helpersBySub[h.class_submission_id] = []))
            .push(h.person_name || '');
        });
        const approved = {};
        approvalRows.forEach(r => {
          approved[r.session_number] = { pm: !!r.approved_at };
        });
        const sessions = {};
        function bucketFor(n) {
          return sessions[n] || (sessions[n] = { am: null, pm: null });
        }
        classRows.forEach(r => {
          const ap = approved[r.scheduled_session];
          const isAM = r.class_period === 'AM';
          // The MORNING side has no approval flow (Erin, 2026-07-10):
          // a placed morning class is live immediately. Afternoon keeps
          // the approve → publish → sign-ups gate.
          if (!isAM && (!ap || !ap.pm)) return; // afternoon not approved yet
          const bucket = bucketFor(r.scheduled_session);
          const list = isAM ? (bucket.am || (bucket.am = [])) : (bucket.pm || (bucket.pm = []));
          list.push({
            id: r.id,
            class_period: r.class_period,
            class_name: r.class_name,
            description: r.description || '',
            // Real name first (people join), then the submitted name; the
            // raw email never shows to members (Erin, 2026-07-11).
            teacher: r.person_name || r.submitted_by_name || String(r.submitted_by_email || '').split('@')[0],
            co_teachers: r.co_teachers || '',
            helpers: (helpersBySub[r.id] || []).filter(Boolean),
            age_groups: r.age_groups || [],
            age_groups_other: r.age_groups_other || '',
            max_students: r.max_students || 0,
            scheduled_hour: r.scheduled_hour || (isAM ? 'AM' : ''),
            scheduled_age_range: r.scheduled_age_range || '',
            scheduled_room: r.scheduled_room || ''
          });
        });
        approvalRows.forEach(r => {
          const bucket = bucketFor(r.session_number);
          // Morning is always "published": [] = live but nothing placed
          // yet, so the client renders the morning section either way.
          if (!bucket.am) bucket.am = [];
          if (r.approved_at && !bucket.pm) bucket.pm = [];
        });
        return res.status(200).json({ school_year: year, sessions });
      }

      // Family-facing: the acting family's kids' FINALIZED morning
      // placements (2026-07-11, Erin: the Kids' Schedule card shows each
      // kid's class once the Membership Director finalizes). Group names
      // only — no other family's data is reachable.
      if (action === 'my-kid-placements') {
        const famEmail = resolveSubmitterEmail(user, req.query.view_as);
        // resolveFamily(sql, email) — the arity was wrong (email landed in
        // the sql slot, returning null) and .email isn't a returned field
        // (.family_email is), so co-parents fell back to their raw login
        // and saw the wrong/stale group (2026-07-17 review).
        const famRec = await resolveFamily(sql, famEmail);
        const keyEmail = (famRec && famRec.family_email) || famEmail;
        const pYear = String(req.query.school_year || '').trim().slice(0, 20) || activeSchoolYear();
        // Enrollment re-key phase (2026-07-19): assignments carry kid_id
        // now — match the family via the kid's REAL family_email too, so
        // rows keyed on a registration-derived email (compound-surname
        // families) still surface, and a renamed kid shows their current
        // first name instead of the stale assignment key.
        const pRows = await sql`
          SELECT a.kid_first_name, a.class_group, a.finalized,
                 COALESCE(NULLIF(k.first_name, ''), a.kid_first_name) AS kid_name
          FROM morning_class_assignments a
          LEFT JOIN kids k ON k.id = a.kid_id
          WHERE a.school_year = ${pYear}
            AND (LOWER(a.family_email) = LOWER(${keyEmail})
              OR LOWER(k.family_email) = LOWER(${keyEmail}))`;
        return res.status(200).json({
          school_year: pYear,
          placements: pRows.filter(r => r.finalized && r.class_group)
            .map(r => ({ kid: r.kid_name, group: r.class_group }))
        });
      }

      // ── Class info (2026-07-11, Erin): the member-visible detail card
      // behind every class row in My Responsibilities — what the class is,
      // where it meets, who's in it (staff + finalized morning kids), so
      // any coach can answer "what am I walking into?" Only scheduled/
      // drafted classes resolve; no reviewer internals are exposed.
      if (action === 'class-info') {
        const ciId = parseInt(String(req.query.id || ''), 10);
        if (!Number.isFinite(ciId)) return res.status(400).json({ error: 'id required' });
        const ciRows = await sql`
          SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.scheduled_session, c.school_year,
                 c.age_groups, c.scheduled_age_range, c.scheduled_room, c.scheduled_backup_room,
                 c.description, c.co_teachers, c.assistant_count, c.submitted_by_email, c.submitted_by_name,
                 c.pre_enroll_kids, c.status,
                 (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
                   WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                      OR LOWER(p.personal_email) = LOWER(c.submitted_by_email)
                   LIMIT 1) AS person_name
          FROM class_submissions c WHERE c.id = ${ciId}`;
        if (!ciRows.length || ['scheduled', 'drafted'].indexOf(ciRows[0].status) === -1) {
          return res.status(404).json({ error: 'That class is not on the schedule.' });
        }
        const ci = ciRows[0];
        const ciHelpers = await sql`SELECT person_name, person_email FROM class_assignment_helpers
          WHERE class_submission_id = ${ciId} ORDER BY sort_order`;
        let ciKids = [];
        let ciKidsPending = false;
        if (ci.class_period === 'AM') {
          const ciGroup = String((ci.age_groups || [])[0] || '');
          if (ciGroup) {
            const kidRows = await sql`SELECT kid_first_name FROM morning_class_assignments
              WHERE school_year = ${ci.school_year} AND finalized = TRUE
                AND LOWER(class_group) = LOWER(${ciGroup})
              ORDER BY kid_first_name`;
            ciKids = kidRows.map(r => r.kid_first_name);
            // Placements not finalized yet — show the kids currently in the
            // class's age group as the pending roster (Erin, 2026-07-15:
            // "I'm not seeing the kids"). Enrollment-scoped (2026-07-19):
            // only kids ENROLLED for this season with a morning schedule
            // count, mirroring the Morning Builder's kid_enrollments read.
            if (!ciKids.length) {
              const pend = await sql`
                SELECT COALESCE(NULLIF(k.nickname, ''), k.first_name) AS n
                FROM kid_enrollments e
                JOIN kids k ON k.id = e.kid_id
                WHERE e.season = ${ci.school_year} AND e.status = 'enrolled'
                  AND e.schedule IN ('all-day', 'morning')
                  AND LOWER(k.class_group) = LOWER(${ciGroup})
                ORDER BY 1`;
              ciKids = pend.map(r => r.n);
              ciKidsPending = ciKids.length > 0;
            }
          }
        }
        // Afternoon classes: who has ranked this class so far (1st/2nd
        // choice + assistant flag) — pending the lottery. Enrollment-scoped
        // (2026-07-19): stale picks from kids not ENROLLED this season
        // don't count; NULL-kid_id legacy rows keep counting (transition
        // tolerance).
        let ciSignups = [];
        if (ci.class_period === 'PM' && ci.scheduled_session) {
          const suRows = await sql`
            SELECT MIN(p.rank) AS pick_rank, BOOL_OR(p.as_assistant) AS as_assistant,
                   COALESCE(NULLIF(k.nickname, ''), p.kid_first_name) AS display_first,
                   COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last,
                   MAX(k.class_group) AS class_group
            FROM class_signup_picks p
            JOIN kids k
              ON (p.kid_id IS NOT NULL AND k.id = p.kid_id)
              OR (p.kid_id IS NULL
                  AND LOWER(k.family_email) = LOWER(p.family_email)
                  AND LOWER(k.first_name) = LOWER(p.kid_first_name))
            LEFT JOIN member_profiles mp
              ON LOWER(mp.family_email) = LOWER(p.family_email)
            WHERE p.class_submission_id = ${ciId}
              AND p.school_year = ${ci.school_year} AND p.session_number = ${ci.scheduled_session}
              AND (p.kid_id IS NULL OR EXISTS (
                SELECT 1 FROM kid_enrollments e
                WHERE e.kid_id = p.kid_id AND e.season = ${ci.school_year}
                  AND e.status = 'enrolled'))
            GROUP BY p.kid_first_name, LOWER(p.family_email), k.nickname, k.last_name, mp.family_name
          `;
          ciSignups = suRows.map(r => ({
            name: ((r.display_first || '') + ' ' + (r.display_last || '')).trim(),
            rank: parseInt(r.pick_rank, 10) || 1,
            assistant: r.as_assistant === true,
            group: r.class_group || ''
          })).filter(s => s.name)
            .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
        }
        const ciWants = Math.min.apply(null, (ci.assistant_count && ci.assistant_count.length) ? ci.assistant_count : [1]);
        return res.status(200).json({
          class: {
            id: ci.id, class_name: ci.class_name, class_period: ci.class_period,
            hour: ci.scheduled_hour || '', session: ci.scheduled_session,
            groups: ci.age_groups || [], ages: ci.scheduled_age_range || '',
            room: ci.scheduled_room || '', backup_room: ci.scheduled_backup_room || '',
            description: ci.description || '',
            teacher: ci.person_name || ci.submitted_by_name || String(ci.submitted_by_email || '').split('@')[0],
            co_teachers: ci.co_teachers || '',
            helpers: ciHelpers.map(h => h.person_name || String(h.person_email || '').split('@')[0]),
            helpers_needed: Math.max(0, ciWants - ciHelpers.length),
            pre_enroll_kids: ci.pre_enroll_kids || ''
          },
          kids: ciKids,
          kids_pending: ciKidsPending,
          signups: ciSignups
        });
      }

      // ── Sign-up To Dos (Erin, 2026-07-15) — VP + Afternoon Class Liaison ──
      // Three placement gaps for one session: adults with an uncovered hour,
      // kids without afternoon picks, and classes short on assistants.
      if (action === 'signup-todos') {
        const stReviewer = await isReviewerReq(user, req);
        if (!stReviewer) return res.status(403).json({ error: 'Only the VP or Afternoon Class Liaison can view sign-up to-dos.' });
        const stSess = parseInt(req.query.session, 10) || 1;
        const stYear = activeSchoolYear(new Date());

        // The season's afternoon pool comes from kid_enrollments (enrollment
        // re-key phase, 2026-07-19) — status='enrolled', schedule
        // all-day/afternoon — mirroring the Morning Builder's morning read.
        // Pending / not-returning / morning-only kids no longer show up as
        // "needs picks"; the kids table supplies display metadata only.
        const [stKids, stPicked, stCls, stHelpers, stSignups, stApproval, stWin, stFirsts] = await Promise.all([
          sql`SELECT k.id AS kid_id, k.first_name, k.class_group, k.birth_date,
                     LOWER(e.family_email) AS fam,
                     COALESCE(NULLIF(k.nickname, ''), k.first_name) AS display_first,
                     COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last
              FROM kid_enrollments e
              JOIN kids k ON k.id = e.kid_id
              LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(e.family_email)
              WHERE e.season = ${stYear} AND e.status = 'enrolled'
                AND e.schedule IN ('all-day', 'afternoon')`,
          sql`SELECT DISTINCT kid_id, LOWER(family_email) AS fam, LOWER(kid_first_name) AS kid
              FROM class_signup_picks WHERE school_year = ${stYear} AND session_number = ${stSess}`,
          sql`SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.assistant_count,
                     c.max_students, c.lead_email_sent_at, c.lottery_run_at,
                     LOWER(c.submitted_by_email) AS teacher_email,
                     (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
                       WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                          OR LOWER(p.personal_email) = LOWER(c.submitted_by_email) LIMIT 1) AS teacher_name
              FROM class_submissions c
              WHERE c.school_year = ${stYear} AND c.scheduled_session = ${stSess}
                AND c.status IN ('scheduled', 'drafted')`,
          sql`SELECT h.class_submission_id, LOWER(h.person_email) AS email, h.person_name, h.block
              FROM class_assignment_helpers h
              JOIN class_submissions c ON c.id = h.class_submission_id
              WHERE c.school_year = ${stYear} AND c.scheduled_session = ${stSess}`,
          sql`SELECT block, LOWER(person_email) AS email, person_name FROM volunteer_signups
              WHERE school_year = ${stYear} AND session_number = ${stSess}`,
          sql`SELECT approved_at FROM co_op_sessions
              WHERE school_year = ${stYear} AND session_number = ${stSess}`,
          sql`SELECT status FROM class_signup_windows
              WHERE school_year = ${stYear} AND session_number = ${stSess} LIMIT 1`,
          // Enrollment = 1st-choice picks (distinct kids) per class.
          // Enrollment-scoped (2026-07-19): stale picks from kids not
          // ENROLLED this season don't count toward over-max / confirm
          // headcounts; NULL-kid_id legacy rows keep counting.
          sql`SELECT p.class_submission_id,
                     COUNT(DISTINCT (LOWER(p.family_email) || '|' || LOWER(p.kid_first_name)))::int AS firsts
              FROM class_signup_picks p
              WHERE p.school_year = ${stYear} AND p.session_number = ${stSess} AND p.rank = 1
                AND (p.kid_id IS NULL OR EXISTS (
                  SELECT 1 FROM kid_enrollments e
                  WHERE e.kid_id = p.kid_id AND e.season = ${stYear}
                    AND e.status = 'enrolled'))
              GROUP BY p.class_submission_id`
        ]);
        const stPmApproved = !!(stApproval.length && stApproval[0].approved_at);
        const stWinStatus = stWin.length ? stWin[0].status : null;
        const stFirstBy = {};
        stFirsts.forEach(r => { stFirstBy[r.class_submission_id] = r.firsts; });

        // 1. Kids without afternoon picks. Morning-only / pending /
        // not-returning kids are already filtered out by the enrollment
        // read above; Greenhouse / under-3 never pick. "Picked" matches by
        // kid_id when the pick row carries one (rename-proof), name key as
        // the legacy fallback.
        const stPickedSet = new Set(stPicked.map(r => r.fam + '|' + r.kid));
        const stPickedIds = new Set(stPicked.map(r => r.kid_id).filter(Boolean));
        const kidsUnpicked = stKids.filter(k => {
          if (String(k.class_group || '').trim().toLowerCase() === 'greenhouse') return false;
          const age = ageFromBirthDate(k.birth_date);
          if (age != null && age < 3) return false;
          if (stPickedIds.has(k.kid_id)) return false;
          return !stPickedSet.has(k.fam + '|' + String(k.first_name || '').toLowerCase());
        }).map(k => ({
          name: ((k.display_first || '') + ' ' + (k.display_last || '')).trim(),
          first_name: k.first_name,
          family_email: k.fam,
          group: k.class_group || '',
          // Age so the liaison can eyeball class fit from the To Do
          // (Erin, 2026-07-16); null when no birth date is on file.
          age: ageFromBirthDate(k.birth_date)
        })).sort((a, b) => a.name.localeCompare(b.name));

        // Shared occupancy maps (mirrors volunteer-matrix semantics).
        const stBlocksOf = r => r.class_period === 'AM'
          ? (r.scheduled_hour === 'AM1' ? ['AM1'] : r.scheduled_hour === 'AM2' ? ['AM2'] : ['AM1', 'AM2'])
          : r.scheduled_hour === 'both' ? ['PM1', 'PM2']
          : r.scheduled_hour === 'PM2' ? ['PM2'] : ['PM1'];
        const stHelpersBySub = {};
        stHelpers.forEach(h => {
          (stHelpersBySub[h.class_submission_id] || (stHelpersBySub[h.class_submission_id] = [])).push(h);
        });
        // occupied['AM1'] = Set of emails + lowercased names committed that hour
        const occupied = { AM1: new Set(), AM2: new Set(), PM1: new Set(), PM2: new Set() };
        const mark = (b, email, name) => {
          if (email) occupied[b].add(email);
          const nl = String(name || '').trim().toLowerCase();
          if (nl) occupied[b].add(nl);
        };
        stCls.forEach(r => {
          const hs = stHelpersBySub[r.id] || [];
          stBlocksOf(r).forEach(b => {
            mark(b, r.teacher_email, r.teacher_name);
            hs.forEach(h => { if (!h.block || h.block === b) mark(b, h.email, h.person_name); });
          });
        });
        stSignups.forEach(s2 => {
          (s2.block === 'AM' ? ['AM1', 'AM2'] : [s2.block]).forEach(b => {
            if (occupied[b]) mark(b, s2.email, s2.person_name);
          });
        });

        // 2. Adults (Main Learning Coaches) with an uncovered hour. PM hours
        // only count once the session's afternoon schedule is approved.
        const stMlcs = await sql`
          SELECT LOWER(p.email) AS email, LOWER(p.personal_email) AS personal_email,
                 NULLIF(TRIM(CONCAT_WS(' ', p.first_name, NULLIF(p.last_name, ''))), '') AS pname,
                 p.first_name, mp.family_name
          FROM people p
          LEFT JOIN member_profiles mp ON mp.family_email = p.family_email
          WHERE p.role = 'mlc'`;
        const stExpected = stPmApproved ? ['AM1', 'AM2', 'PM1', 'PM2'] : ['AM1', 'AM2'];
        const adultsUnplaced = [];
        stMlcs.forEach(m => {
          const fullName = (m.pname || ((m.first_name || '') + ' ' + (m.family_name || '')).trim()).toLowerCase();
          const ids = [m.email, m.personal_email, fullName].filter(Boolean);
          const missing = stExpected.filter(b => !ids.some(idv => occupied[b].has(idv)));
          if (missing.length) {
            adultsUnplaced.push({
              name: m.pname || ((m.first_name || '') + ' ' + (m.family_name || '')).trim(),
              email: m.email || '',
              missing
            });
          }
        });
        adultsUnplaced.sort((a, b) => a.name.localeCompare(b.name));

        // 3. Classes short on assistants (per hour for whole-morning classes,
        // once per class otherwise).
        const assistantGaps = [];
        stCls.forEach(r => {
          const hs = stHelpersBySub[r.id] || [];
          const wants = Math.min.apply(null, (r.assistant_count && r.assistant_count.length) ? r.assistant_count : [1]);
          const spansTwo = r.class_period === 'AM'
            ? (r.scheduled_hour !== 'AM1' && r.scheduled_hour !== 'AM2')
            : r.scheduled_hour === 'both';
          if (spansTwo) {
            // Two-hour classes take per-hour assists — gaps count per hour.
            stBlocksOf(r).forEach(b => {
              const n = hs.filter(h => !h.block || h.block === b).length;
              if (wants - n > 0) assistantGaps.push({ class_name: r.class_name, block: b, needs: wants - n });
            });
          } else {
            const gap = wants - hs.length;
            if (gap > 0) assistantGaps.push({ class_name: r.class_name, block: r.scheduled_hour || (r.class_period === 'AM' ? 'AM' : 'PM'), needs: gap });
          }
        });
        assistantGaps.sort((a, b) => a.class_name.localeCompare(b.class_name) || String(a.block).localeCompare(String(b.block)));

        // Post-close resolution (Erin, 2026-07-15). Over-max = 1st-choice
        // kids beyond max_students on a PM class. Once the window is
        // closed AND nothing is over-max, un-sent lead confirmations
        // become the next To Do.
        const overmax = [];
        const confirmPending = [];
        stCls.forEach(r => {
          if (r.class_period !== 'PM') return;
          const firsts = stFirstBy[r.id] || 0;
          const max = r.max_students || 0;
          if (max > 0 && firsts > max) {
            overmax.push({
              id: r.id, class_name: r.class_name, hour: r.scheduled_hour || 'PM1',
              max: max, firsts: firsts, over: firsts - max,
              lottery_run: !!r.lottery_run_at,
              // Lead's name so the liaison knows who to talk to before
              // raising the max or running a lottery (Erin, 2026-07-16).
              teacher: r.teacher_name || ''
            });
          }
          if (firsts > 0) {
            confirmPending.push({
              id: r.id, class_name: r.class_name, firsts: firsts,
              sent: !!r.lead_email_sent_at, teacher: r.teacher_name || ''
            });
          }
        });
        overmax.sort((a, b) => b.over - a.over);
        confirmPending.sort((a, b) => a.class_name.localeCompare(b.class_name));

        // Lottery moves the families haven't been told about yet (Erin,
        // 2026-07-16): each bump shows which class's lottery it was and
        // where the kid landed — their promoted 2nd choice (now rank 1 in
        // the same hour), or nothing if they had no 2nd choice. Derived
        // live so a later re-pick shows the family's current placement.
        const lotteryMoveRows = await sql`
          SELECT b.id, b.class_submission_id, LOWER(b.family_email) AS fam,
                 b.kid_first_name,
                 c.class_name AS from_class, c.scheduled_hour AS from_hour,
                 COALESCE(NULLIF(k.nickname, ''), b.kid_first_name) AS display_first,
                 COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last,
                 (SELECT c2.class_name FROM class_signup_picks p2
                    JOIN class_submissions c2 ON c2.id = p2.class_submission_id
                   WHERE p2.school_year = b.school_year AND p2.session_number = b.session_number
                     AND ((b.kid_id IS NOT NULL AND p2.kid_id = b.kid_id)
                       OR (LOWER(p2.family_email) = LOWER(b.family_email)
                           AND LOWER(p2.kid_first_name) = LOWER(b.kid_first_name)))
                     AND p2.hour = (CASE WHEN c.scheduled_hour = 'PM2' THEN 'PM2' ELSE 'PM1' END)
                     AND p2.rank = 1
                   LIMIT 1) AS moved_to
          FROM class_lottery_bumps b
          JOIN class_submissions c ON c.id = b.class_submission_id
          LEFT JOIN kids k ON (b.kid_id IS NOT NULL AND k.id = b.kid_id)
                           OR (b.kid_id IS NULL
                               AND LOWER(k.family_email) = LOWER(b.family_email)
                               AND LOWER(k.first_name) = LOWER(b.kid_first_name))
          LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(b.family_email)
          WHERE b.school_year = ${stYear} AND b.session_number = ${stSess}
            AND b.notified_at IS NULL
          ORDER BY c.class_name, b.kid_first_name`;
        const lotteryMoves = lotteryMoveRows.map(r => ({
          id: r.id,
          kid: ((r.display_first || '') + ' ' + (r.display_last || '')).trim(),
          family_email: r.fam,
          from_class: r.from_class,
          hour: r.from_hour || 'PM1',
          moved_to: r.moved_to || ''
        }));

        return res.status(200).json({
          session: stSess, school_year: stYear, pm_approved: stPmApproved,
          window_status: stWinStatus,
          // Placing FROM the To Do modal works via view_as. Reviewers
          // (VP + Afternoon Class Liaison) place kids as part of the job —
          // the picks write honors reviewer view_as too (testers,
          // 2026-07-16: the ACL was locked out on prod because this flag
          // keyed on canImpersonate = super users only).
          can_place: stReviewer || canImpersonate(user.email),
          kids_unpicked: kidsUnpicked,
          adults_unplaced: adultsUnplaced,
          assistant_gaps: assistantGaps,
          overmax: overmax,
          confirm_pending: confirmPending,
          lottery_moves: lotteryMoves
        });
      }

      // ── "Went to lottery" report (Erin, 2026-07-15) — popular classes
      // whose lesson plans are worth starring for future sessions.
      if (action === 'lottery-report') {
        if (!(await isReviewerReq(user, req))) return res.status(403).json({ error: 'Reviewers only.' });
        const lrYear = activeSchoolYear(new Date());
        const rows = await sql`
          SELECT c.id, c.class_name, c.scheduled_session, c.scheduled_hour, c.max_students,
                 c.lottery_run_at, c.submitted_by_name,
                 (SELECT COUNT(*)::int FROM class_lottery_bumps b
                   WHERE b.class_submission_id = c.id) AS bumped
          FROM class_submissions c
          WHERE c.school_year = ${lrYear} AND c.lottery_run_at IS NOT NULL
          ORDER BY c.scheduled_session, c.class_name`;
        return res.status(200).json({
          school_year: lrYear,
          classes: rows.map(r => ({
            id: r.id, class_name: r.class_name, session: r.scheduled_session,
            hour: r.scheduled_hour || '', max: r.max_students || 0,
            bumped: r.bumped, leader: r.submitted_by_name || '',
            run_at: r.lottery_run_at
          }))
        });
      }

      // ── Lead confirmation draft (Erin, 2026-07-15) ──
      // #students × $5 per hour; kids (1st choice), co-leads, assistants.
      if (action === 'class-confirm-draft') {
        const cdId = parseInt(String(req.query.id || ''), 10);
        if (!Number.isFinite(cdId)) return res.status(400).json({ error: 'id required' });
        const cdScope = await reviewerScopeReq(user, req);
        const cdRows = await sql`SELECT * FROM class_submissions WHERE id = ${cdId}`;
        if (!cdRows.length) return res.status(404).json({ error: 'Class not found.' });
        const cd = cdRows[0];
        if (!cdScope || !scopeAllowsSub(cdScope, cd)) return res.status(403).json({ error: 'Reviewers only.' });
        const cdHour = (cd.scheduled_hour === 'PM2') ? 'PM2' : 'PM1';
        // Enrollment-scoped (2026-07-19): stale picks from kids not
        // ENROLLED this season stay off the class list + budget;
        // NULL-kid_id legacy rows keep counting (transition tolerance).
        const cdKids = await sql`
          SELECT COALESCE(NULLIF(k.nickname, ''), p.kid_first_name) AS first,
                 COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS last
          FROM class_signup_picks p
          JOIN kids k ON (p.kid_id IS NOT NULL AND k.id = p.kid_id)
                      OR (p.kid_id IS NULL
                          AND LOWER(k.family_email) = LOWER(p.family_email)
                          AND LOWER(k.first_name) = LOWER(p.kid_first_name))
          LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(p.family_email)
          WHERE p.class_submission_id = ${cdId} AND p.rank = 1 AND p.hour = ${cdHour}
            AND p.school_year = ${cd.school_year} AND p.session_number = ${cd.scheduled_session}
            AND (p.kid_id IS NULL OR EXISTS (
              SELECT 1 FROM kid_enrollments e
              WHERE e.kid_id = p.kid_id AND e.season = ${cd.school_year}
                AND e.status = 'enrolled'))
          ORDER BY 1, 2`;
        const cdHelpers = await sql`SELECT person_name, person_email, block FROM class_assignment_helpers
          WHERE class_submission_id = ${cdId} ORDER BY sort_order`;
        const leadRows = await sql`SELECT first_name, last_name FROM people
          WHERE LOWER(email) = LOWER(${cd.submitted_by_email})
             OR LOWER(personal_email) = LOWER(${cd.submitted_by_email}) LIMIT 1`;
        const leadName = leadRows.length
          ? ((leadRows[0].first_name || '') + ' ' + (leadRows[0].last_name || '')).trim()
          : (cd.submitted_by_name || String(cd.submitted_by_email || '').split('@')[0]);
        const nKids = cdKids.length;
        const hours = cd.scheduled_hour === 'both' ? 2 : 1;
        const budget = nKids * 5 * hours;
        const kidLines = cdKids.map(k => '  • ' + (k.first + ' ' + (k.last || '')).trim()).join('\n');
        const coLeads = String(cd.co_teachers || '').split(/[,;]+/).map(s => s.trim()).filter(Boolean);
        const helperLines = cdHelpers.map(h => '  • ' + (h.person_name || h.person_email)
          + (h.block === 'PM1' ? ' (Hour 1)' : h.block === 'PM2' ? ' (Hour 2)' : '')).join('\n');
        const body =
          'Hi ' + (leadName.split(' ')[0] || leadName) + ',\n\n' +
          'Class sign-ups are wrapped up — here are the details for “' + cd.class_name + '” (Session ' + cd.scheduled_session + '):\n\n' +
          'Students: ' + nKids + '\n' +
          'Budget: $' + budget + ' (' + nKids + ' student' + (nKids === 1 ? '' : 's') + ' × $5' + (hours === 2 ? ' × 2 hours' : ' per hour') + ')\n\n' +
          'Your class list:\n' + (kidLines || '  (no students yet)') + '\n\n' +
          (coLeads.length ? 'Co-lead' + (coLeads.length === 1 ? '' : 's') + ':\n' + coLeads.map(n => '  • ' + n).join('\n') + '\n\n' : '') +
          (helperLines ? 'Assistant' + (cdHelpers.length === 1 ? '' : 's') + ':\n' + helperLines + '\n\n' : '') +
          'Please double-check the list and let me know if anything looks off. Thank you for leading!\n\n' +
          '— Afternoon Class Liaison';
        return res.status(200).json({
          id: cd.id,
          to: cd.submitted_by_email,
          subject: '“' + cd.class_name + '” — Session ' + cd.scheduled_session + ' class list & budget',
          body: body,
          sent_at: cd.lead_email_sent_at || null
        });
      }

      // ── Volunteer matrix (2026-07-11, Erin's session sign-up build) ──
      // One member-visible picture of a session: every placed class per
      // block (AM1 / AM2 / PM1 / PM2 — morning split per hour, Erin
      // 2026-07-11) with its leader + helpers, the floater /
      // board-duties / prep pledges, the cleaning rota, and what the
      // ACTING person is already committed to per block.
      if (action === 'volunteer-matrix') {
        const vmYear = String(req.query.school_year || '').trim().slice(0, 20) || activeSchoolYear();
        const vmSess = parseInt(req.query.session, 10);
        if (!Number.isFinite(vmSess) || vmSess < 1 || vmSess > 5) return res.status(400).json({ error: 'session 1-5 required' });
        const actingEmail = actingEmailFor(user, req).toLowerCase();
        const [clsRows, helperRows, signupRows, cleanRows, meRows, apprRows] = await Promise.all([
          sql`SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.age_groups, c.scheduled_age_range,
                     c.submitted_by_email, c.submitted_by_name, c.co_teachers, c.assistant_count, c.scheduled_room,
                     (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
                       WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                          OR LOWER(p.personal_email) = LOWER(c.submitted_by_email)
                       LIMIT 1) AS person_name
              FROM class_submissions c
              WHERE c.school_year = ${vmYear} AND c.scheduled_session = ${vmSess}
                AND c.status IN ('scheduled', 'drafted')`,
          sql`SELECT h.class_submission_id, h.person_email, h.person_name, h.block
              FROM class_assignment_helpers h
              JOIN class_submissions c ON c.id = h.class_submission_id
              WHERE c.school_year = ${vmYear} AND c.scheduled_session = ${vmSess}
              ORDER BY h.class_submission_id, h.sort_order`,
          sql`SELECT id, block, role, person_email, person_name
              FROM volunteer_signups
              WHERE school_year = ${vmYear} AND session_number = ${vmSess}
              ORDER BY role, created_at`,
          sql`SELECT ca.id, ca.family_name, a.area_name
              FROM cleaning_assignments ca
              JOIN cleaning_areas a ON a.id = ca.cleaning_area_id
              WHERE ca.session_number = ${vmSess} AND ca.school_year = ${vmYear}
              ORDER BY a.sort_order, ca.sort_order`,
          sql`SELECT first_name, last_name FROM people
              WHERE LOWER(email) = ${actingEmail} OR LOWER(personal_email) = ${actingEmail} LIMIT 1`,
          sql`SELECT approved_at FROM co_op_sessions
              WHERE school_year = ${vmYear} AND session_number = ${vmSess}`
        ]);
        // Afternoon classes stay out of the matrix until the session's PM
        // side is APPROVED (Erin, 2026-07-11) — same rule as the published
        // schedule, so drafted placements never leak into sign-ups.
        const pmApproved = !!(apprRows.length && apprRows[0].approved_at);
        const helpersBySub = {};
        helperRows.forEach(h => {
          (helpersBySub[h.class_submission_id] || (helpersBySub[h.class_submission_id] = []))
            .push({ email: (h.person_email || '').toLowerCase(), name: h.person_name || '', block: h.block || '' });
        });
        // Which helper rows count for a given hour block: whole-class rows
        // ('') always, hour rows only for their own hour.
        const helpersForBlock = (hs, b) => hs.filter(h => !h.block || h.block === b);
        const meName = meRows.length ? ((meRows[0].first_name || '') + ' ' + (meRows[0].last_name || '')).trim() : (user.name || '');
        const meNameLc = meName.toLowerCase();
        const blocksOf = r => r.class_period === 'AM'
          ? (r.scheduled_hour === 'AM1' ? ['AM1'] : r.scheduled_hour === 'AM2' ? ['AM2'] : ['AM1', 'AM2'])
          : r.scheduled_hour === 'both' ? ['PM1', 'PM2']
          : r.scheduled_hour === 'PM2' ? ['PM2'] : ['PM1'];
        const blocks = { AM1: { classes: [], floaters: [], board: [], prep: [] }, AM2: { classes: [], floaters: [], board: [], prep: [] }, PM1: { classes: [], floaters: [], board: [], prep: [] }, PM2: { classes: [], floaters: [], board: [], prep: [] } };
        const mine = { AM1: null, AM2: null, PM1: null, PM2: null };
        // Key classroom positions per hour (lead + co-leads + assistant
        // spots). Support roles (floater/board/prep) only get whatever
        // adults remain beyond these (Erin, 2026-07-15).
        const keyNeeded = { AM1: 0, AM2: 0, PM1: 0, PM2: 0 };
        clsRows.forEach(r => {
          if (r.class_period !== 'AM' && !pmApproved) return;
          const hs = helpersBySub[r.id] || [];
          const wants = Math.min.apply(null, (r.assistant_count && r.assistant_count.length) ? r.assistant_count : [1]);
          blocksOf(r).forEach(b => {
            // Per-block view of the class: hour-scoped assists (whole-morning
            // classes, Erin 2026-07-15) only show/count in their own hour.
            const hsB = helpersForBlock(hs, b);
            const entry = {
              id: r.id, class_name: r.class_name,
              group: r.class_period === 'AM' ? String((r.age_groups || [])[0] || '') : '',
              groups: r.age_groups || [],
              ages: r.scheduled_age_range || '',
              teacher: r.person_name || r.submitted_by_name || String(r.submitted_by_email || '').split('@')[0],
              teacher_email: (r.submitted_by_email || '').toLowerCase(),
              co_teachers: r.co_teachers || '',
              helpers: hsB.map(h => h.name || h.email),
              helpers_needed: Math.max(0, wants - hsB.length),
              room: r.scheduled_room || '',
              hour: r.scheduled_hour || ''
            };
            blocks[b].classes.push(entry);
            keyNeeded[b] += 1
              + String(r.co_teachers || '').split(/[,;]+/).filter(s => s.trim()).length
              + Math.max(wants, hsB.length);
            if (entry.teacher_email === actingEmail || (meNameLc && String(entry.teacher).trim().toLowerCase() === meNameLc)) {
              mine[b] = { kind: 'lead', label: 'Leading “' + r.class_name + '”', class_id: r.id };
            }
            if (!mine[b]) {
              const hit = hsB.find(h => (h.email && h.email === actingEmail) || (meNameLc && h.name && h.name.trim().toLowerCase() === meNameLc));
              if (hit) mine[b] = { kind: 'assist', label: 'Assisting “' + r.class_name + '”', class_id: r.id, block: hit.block || '' };
            }
          });
        });
        const VM_ROLE_LABEL = { floater: 'Floater', board: 'Board Duties', prep: 'Prep Period' };
        signupRows.forEach(s2 => {
          // Legacy 'AM' rows (whole-morning pledges from the first build)
          // read as covering both hours.
          const sBlocks = s2.block === 'AM' ? ['AM1', 'AM2'] : [s2.block];
          sBlocks.forEach(sb => {
            const bucket = blocks[sb];
            if (!bucket) return;
            const list = s2.role === 'floater' ? bucket.floaters : s2.role === 'board' ? bucket.board : bucket.prep;
            list.push(s2.person_name || s2.person_email);
            if ((s2.person_email || '').toLowerCase() === actingEmail) {
              mine[sb] = { kind: s2.role, label: VM_ROLE_LABEL[s2.role], signup_id: s2.id };
            }
          });
        });
        // Support-slot capacity per hour: adults (MLCs) minus the key
        // classroom positions. Sent per block so the sign-up dropdowns can
        // close floater/board/prep once every remaining adult is needed in
        // a classroom.
        const mlcCountRows = await sql`SELECT COUNT(*)::int AS n FROM people WHERE role = 'mlc'`;
        const adultCount = mlcCountRows[0].n;
        Object.keys(blocks).forEach(b => {
          const bk = blocks[b];
          bk.support_capacity = Math.max(0, adultCount - keyNeeded[b]);
          bk.support_taken = bk.floaters.length + bk.board.length + bk.prep.length;
        });

        const cleaning = cleanRows.map(c => ({ id: c.id, area: c.area_name, family: c.family_name }));
        // Open cleaning spots for self-serve sign-up (2026-07-11): every
        // non-floater area takes ONE family per session; the Floater area
        // always accepts more hands.
        const openAreas = await sql`
          SELECT a.id, a.area_name, a.floor_key FROM cleaning_areas a
          WHERE a.floor_key = 'floater' OR NOT EXISTS (
            SELECT 1 FROM cleaning_assignments ca
            WHERE ca.cleaning_area_id = a.id AND ca.session_number = ${vmSess} AND ca.school_year = ${vmYear})
          ORDER BY a.sort_order, a.id`;
        const cleaning_open = openAreas.map(a => ({ id: a.id, area: a.area_name, floor: a.floor_key || '', floater: a.floor_key === 'floater' }));
        return res.status(200).json({
          school_year: vmYear, session: vmSess, pm_approved: pmApproved, blocks, mine, cleaning, cleaning_open,
          me: { email: actingEmail, name: meName, is_board: await isBoardMember(actingEmail) }
        });
      }

      // Single submission fetch — owner or reviewer can view.
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const rows = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const r = rows[0];
        const viewOwnEmails = [user.email.toLowerCase(), actingEmailFor(user, req).toLowerCase()];
        const isOwner = viewOwnEmails.indexOf(String(r.submitted_by_email || '').toLowerCase()) !== -1;
        if (!isOwner && !(await isReviewerReq(user, req))) {
          return res.status(403).json({ error: 'Not allowed to view this submission' });
        }
        return res.status(200).json({ submission: serializeSubmission(r) });
      }

      // ── Class Inspiration board (Erin, 2026-07-15) ──
      // DB-backed idea list; any member reads. Edits live in the POST /
      // DELETE sections below ('class_inspiration_edit' capability).
      if (action === 'class-inspiration') {
        const rows = await sql`SELECT id, group_name, idea FROM class_inspirations
          ORDER BY group_name, sort_order, id`;
        const groups = {};
        rows.forEach(r => {
          (groups[r.group_name] || (groups[r.group_name] = [])).push({ id: r.id, idea: r.idea });
        });
        return res.status(200).json({ groups });
      }

      // Favorited PM/both curricula — feeds the "Need inspiration?" strip
      // inside the PM class submission modal. Any logged-in member can read.
      if (action === 'inspiration') {
        const rows = await sql`
          SELECT id, title, subject, age_range, overview, tags, author_name, lesson_count, block
          FROM curricula
          WHERE is_favorite = TRUE AND block IN ('PM', 'both')
          ORDER BY updated_at DESC
          LIMIT 20
        `;
        return res.status(200).json({ curricula: rows });
      }

      // Get class-curriculum links for a session
      if (action === 'links') {
        const session = parseInt(req.query.session, 10);
        if (!session) return res.status(400).json({ error: 'session query param required' });
        const links = await sql`
          SELECT ccl.id, ccl.session_number, ccl.class_key, ccl.curriculum_id,
                 ccl.attached_by, ccl.attached_at, c.title AS curriculum_title,
                 c.subject, c.lesson_count
          FROM class_curriculum_links ccl
          JOIN curricula c ON c.id = ccl.curriculum_id
          WHERE ccl.session_number = ${session}
          ORDER BY ccl.class_key
        `;
        return res.status(200).json({ links });
      }

      // ── Class sign-ups (student-side afternoon selection) ──
      // Window status + the scheduled afternoon classes split into PM1/PM2
      // ranking pools + the caller's family's kids and their current picks.
      // Any authed member can read; picks come back only for the family the
      // caller resolves to (their own, or a View-As'd family for super users).
      if (action === 'class-signup') {
        const sy = activeSchoolYear(new Date());
        const reviewer = await isReviewerReq(user, req);
        // session is optional: with none, fall back to whichever session has an
        // OPEN window (most recent) so the parent card auto-shows the active
        // sign-up. Reviewers pass an explicit session to manage any of them.
        let session = parseInt(req.query.session, 10) || null;
        if (!session) {
          const openWin = await sql`
            SELECT session_number FROM class_signup_windows
            WHERE school_year = ${sy} AND status = 'open'
            ORDER BY session_number DESC LIMIT 1
          `;
          session = openWin[0] ? openWin[0].session_number : null;
        }
        if (!session) {
          return res.status(200).json({
            school_year: sy, session: null, window: { status: null },
            classes: { PM1: [], PM2: [] }, kids: [], picks: {}, is_reviewer: reviewer
          });
        }
        const winRows = await sql`
          SELECT status, opened_at, closed_at, locked_at,
                 signup_start_date, signup_end_date
          FROM class_signup_windows
          WHERE school_year = ${sy} AND session_number = ${session} LIMIT 1
        `;
        const classRows = await sql`
          SELECT id, class_name, scheduled_hour, scheduled_age_range, scheduled_room,
                 submitted_by_name, max_students, age_groups, description,
                 open_to_teen_assistant
          FROM class_submissions
          WHERE status = 'scheduled' AND school_year = ${sy} AND scheduled_session = ${session}
            AND class_period = 'PM'
          ORDER BY class_name
        `;
        // Who has this class in their picks right now (any rank, across all
        // families) — surfaces demand + names next to max_students on the
        // parent card. Distinct per kid so re-ranking doesn't double count.
        // Display name = the kid's "goes by" nickname (or first name) + the
        // family surname; placement itself happens at the lottery.
        // INNER join on kids: picks keyed only by kid_first_name are
        // orphaned by a rename — those must not surface as phantom students
        // ("Test Family", 2026-07-15). Rows carrying kid_id (enrollment
        // re-key phase) join by id, so mapped picks survive a rename.
        // Enrollment-scoped (2026-07-19): stale picks from kids not
        // ENROLLED this season don't inflate demand; NULL-kid_id legacy
        // rows keep counting (transition tolerance).
        const pickKidRows = await sql`
          SELECT p.class_submission_id, p.kid_first_name, LOWER(p.family_email) AS fam_email,
                 MIN(p.rank) AS pick_rank,
                 BOOL_OR(p.as_assistant) AS as_assistant,
                 COALESCE(NULLIF(k.nickname, ''), p.kid_first_name) AS display_first,
                 COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last
          FROM class_signup_picks p
          JOIN kids k
            ON (p.kid_id IS NOT NULL AND k.id = p.kid_id)
            OR (p.kid_id IS NULL
                AND LOWER(k.family_email) = LOWER(p.family_email)
                AND LOWER(k.first_name) = LOWER(p.kid_first_name))
          LEFT JOIN member_profiles mp
            ON LOWER(mp.family_email) = LOWER(p.family_email)
          WHERE p.school_year = ${sy} AND p.session_number = ${session}
            AND (p.kid_id IS NULL OR EXISTS (
              SELECT 1 FROM kid_enrollments e
              WHERE e.kid_id = p.kid_id AND e.season = ${sy}
                AND e.status = 'enrolled'))
          GROUP BY p.class_submission_id, p.kid_first_name, LOWER(p.family_email),
                   k.nickname, k.last_name, mp.family_name
        `;
        const pickCounts = {};
        const pickNames = {};
        const pickDetailed = {};
        pickKidRows.forEach(r => {
          const id = r.class_submission_id;
          pickCounts[id] = (pickCounts[id] || 0) + 1;
          const base = (r.display_first + ' ' + (r.display_last || '')).trim();
          if (!base) return;
          if (!pickDetailed[id]) pickDetailed[id] = [];
          pickDetailed[id].push({
            name: base,
            rank: parseInt(r.pick_rank, 10) || 1,
            assistant: r.as_assistant === true
          });
        });
        // 1st choices first, then 2nd (etc.), alphabetical within a rank —
        // the detail popup groups them; the flat list feeds the tiles.
        Object.keys(pickDetailed).forEach(id => {
          pickDetailed[id].sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name));
          pickNames[id] = pickDetailed[id].map(d => d.name + (d.assistant ? ' (assistant)' : ''));
        });
        const ser = (r) => ({
          id: r.id, name: r.class_name, hour: r.scheduled_hour,
          // scheduled_age_range is the reviewer's free-text override; most
          // schedules leave it blank, so the teacher-picked age_groups slugs
          // ride along and the client renders/fits from whichever exists.
          ageRange: r.scheduled_age_range || '',
          ageGroups: Array.isArray(r.age_groups) ? r.age_groups : [],
          description: r.description || '',
          room: r.scheduled_room || '',
          leader: r.submitted_by_name || '', max: r.max_students || 0,
          // Teacher opted in to a Pigeons-age assistant — Pigeon kids may
          // rank this class as its assistant regardless of age range.
          openToTeen: r.open_to_teen_assistant === true,
          signedUp: pickCounts[r.id] || 0,
          signedUpNames: pickNames[r.id] || [],
          signedUpDetailed: pickDetailed[r.id] || []
        });
        // A 2-hour ('both') class is ranked under PM1 only and fills both slots.
        const classes = {
          PM1: classRows.filter(r => r.scheduled_hour === 'PM1' || r.scheduled_hour === 'both').map(ser),
          PM2: classRows.filter(r => r.scheduled_hour === 'PM2').map(ser)
        };
        const effEmail = resolveSubmitterEmail(user, req.query.view_as);
        const fam = await resolveFamily(sql, effEmail);
        let kids = [];
        const kidAges = {};
        const kidGroups = {};
        const picks = {};
        const pickNotes = {};
        const pickAssists = {};
        if (fam && fam.family_email) {
          // Afternoon eligibility comes from kid_enrollments (enrollment
          // re-key phase, 2026-07-19): the family's kids ENROLLED for the
          // season with an all-day/afternoon schedule — mirroring the
          // Morning Builder's kid_enrollments read. Pending / not-returning
          // / morning-only kids no longer surface in the picker; the kids
          // table supplies age + group metadata.
          const kidRows = await sql`
            SELECT k.first_name, k.birth_date, k.class_group
            FROM kid_enrollments e
            JOIN kids k ON k.id = e.kid_id
            WHERE e.season = ${sy} AND e.status = 'enrolled'
              AND e.schedule IN ('all-day', 'afternoon')
              AND LOWER(e.family_email) = LOWER(${fam.family_email})
            ORDER BY k.sort_order, k.first_name
          `;
          // No programming under 3 (Erin, 2026-07-15): Greenhouse kids stay
          // with the littles all day, so they never enter afternoon
          // sign-ups — leave them out of the picker entirely.
          const eligible = kidRows.filter(k => {
            if (String(k.class_group || '').trim().toLowerCase() === 'greenhouse') return false;
            const age = ageFromBirthDate(k.birth_date);
            return !(age != null && age < 3);
          });
          kids = eligible.map(k => k.first_name).filter(Boolean);
          // Current age per kid so the parent card can flag age-appropriate
          // classes. Keyed by first name (same key as picks/working). The
          // class group rides along as the fallback when there's no birth
          // date on file (the card derives an age band from the group).
          eligible.forEach(k => {
            const age = ageFromBirthDate(k.birth_date);
            if (k.first_name && age != null) kidAges[k.first_name] = age;
            if (k.first_name && k.class_group) kidGroups[k.first_name] = k.class_group;
          });
          const pickRows = await sql`
            SELECT kid_first_name, hour, class_submission_id, note, as_assistant
            FROM class_signup_picks
            WHERE school_year = ${sy} AND session_number = ${session}
              AND LOWER(family_email) = LOWER(${fam.family_email})
            ORDER BY kid_first_name, hour, rank
          `;
          pickRows.forEach(p => {
            if (!picks[p.kid_first_name]) picks[p.kid_first_name] = { PM1: [], PM2: [] };
            (picks[p.kid_first_name][p.hour] || (picks[p.kid_first_name][p.hour] = [])).push(p.class_submission_id);
            if (p.note) {
              if (!pickNotes[p.kid_first_name]) pickNotes[p.kid_first_name] = {};
              pickNotes[p.kid_first_name][p.class_submission_id] = p.note;
            }
            if (p.as_assistant) {
              if (!pickAssists[p.kid_first_name]) pickAssists[p.kid_first_name] = {};
              pickAssists[p.kid_first_name][p.class_submission_id] = true;
            }
          });
          // Placed kids never vanish (same rule as the Morning Builder): a
          // kid with saved picks whose enrollment has since flipped
          // (morning-only, pending, not returning) stays visible so the
          // family / liaison can consciously move or clear the placement
          // instead of it silently disappearing.
          const kidSetLc = new Set(kids.map(n => String(n).toLowerCase()));
          const pickedOnly = Object.keys(picks)
            .filter(n => !kidSetLc.has(String(n).toLowerCase()));
          if (pickedOnly.length) {
            const famKidRows = await sql`
              SELECT first_name, birth_date, class_group FROM kids
              WHERE LOWER(family_email) = LOWER(${fam.family_email})`;
            const famByLc = new Map(famKidRows.map(k =>
              [String(k.first_name || '').toLowerCase(), k]));
            pickedOnly.forEach(n => {
              const kRow = famByLc.get(String(n).toLowerCase());
              if (!kRow) return; // orphaned name-keyed picks — no phantom tabs
              kids.push(n);
              const age = ageFromBirthDate(kRow.birth_date);
              if (age != null) kidAges[n] = age;
              if (kRow.class_group) kidGroups[n] = kRow.class_group;
            });
          }
        }
        return res.status(200).json({
          school_year: sy, session,
          window: winRows[0] || { status: null },
          classes, kids, kidAges, kidGroups, picks,
          pick_notes: pickNotes,
          pick_assists: pickAssists,
          is_reviewer: reviewer
        });
      }

      if (id) {
        const full = await getFullCurriculum(sql, id);
        if (!full) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ curriculum: full });
      }
      // List summaries
      const rows = await sql`
        SELECT id, title, subject, age_range, overview, tags, author_email, author_name,
               edit_policy, lesson_count, block, is_favorite, updated_at
        FROM curricula
        ORDER BY updated_at DESC
      `;
      return res.status(200).json({ curricula: rows });
    }

    // ── POST create, copy, or link ──
    if (req.method === 'POST') {
      // Create a new class submission (AM or PM). View-As aware
      // (2026-07-05): a super user submitting while impersonating files
      // the class under the VIEWED member — matching the Class Ideas
      // card, which lists the impersonated person's submissions. Without
      // this the two disagreed: submit attributed to the real login, the
      // card showed the impersonated one, and the class "vanished".
      if (action === 'class-submission') {
        let clean;
        try { clean = normalizeSubmission(req.body || {}); }
        catch (validationErr) {
          return res.status(400).json({ error: validationErr.message });
        }
        let submitterEmail = resolveSubmitterEmail(user, req.query.view_as);
        let submitterName = submitterEmail.toLowerCase() === user.email.toLowerCase()
          ? (user.name || '') : '';
        // Reviewers/liaisons can file a class ON BEHALF of a member (the
        // builder's "+ New Class", 2026-07-06 — liaisons recruit teachers
        // in conversation and enter the class themselves). Workspace email
        // → files under that member (they get the confirmation email);
        // name-only (no account yet) → files under the liaison with the
        // intended teacher's name kept visible.
        const behalfEmail = String((req.body || {}).on_behalf_email || '').trim().toLowerCase();
        const behalfName = String((req.body || {}).on_behalf_name || '').trim().slice(0, 120);
        const behalfScope = (behalfEmail || behalfName) ? await reviewerScopeReq(user, req) : null;
        if (behalfScope && !scopeAllowsSub(behalfScope, clean)) {
          return res.status(403).json({ error: 'Your liaison role covers a different age group — you can only add morning classes for your own group.' });
        }
        if (behalfScope) {
          if (behalfEmail && (behalfEmail.split('@')[1] || '') === ALLOWED_DOMAIN) {
            submitterEmail = behalfEmail;
            submitterName = behalfName;
          } else if (behalfName) {
            submitterName = behalfName + ' (via ' + (user.name || user.email) + ')';
          }
        }
        const inserted = await sql`
          INSERT INTO class_submissions (
            submitted_by_email, submitted_by_name, school_year, class_period,
            class_name, session_preferences, hour_preference, assistant_count,
            co_teachers, space_request, space_request_other,
            max_students, max_students_other, age_groups, age_groups_other,
            pre_enroll_kids, open_to_teen_assistant, prerequisites, description, other_info
          )
          VALUES (
            ${submitterEmail}, ${submitterName}, ${clean.school_year}, ${clean.class_period},
            ${clean.class_name}, ${clean.session_preferences}, ${clean.hour_preference}, ${clean.assistant_count},
            ${clean.co_teachers}, ${clean.space_request}, ${clean.space_request_other},
            ${clean.max_students}, ${clean.max_students_other}, ${clean.age_groups}, ${clean.age_groups_other},
            ${clean.pre_enroll_kids}, ${clean.open_to_teen_assistant}, ${clean.prerequisites}, ${clean.description}, ${clean.other_info}
          )
          RETURNING *
        `;
        const sub = inserted[0];
        // Assistants identified at submission time (2026-07-10, Erin:
        // co-leaders and assistants are separate) land straight on the
        // helpers roster — same table the builder's helper edits use.
        let subHelpers;
        if (Array.isArray(req.body.helpers)) {
          const hs = req.body.helpers
            .filter(h => h && (h.name || h.email))
            .map(h => ({ email: String(h.email || '').trim().toLowerCase(), name: String(h.name || '').trim() }));
          for (let i = 0; i < hs.length; i++) {
            await sql`
              INSERT INTO class_assignment_helpers
                (class_submission_id, person_email, person_name, sort_order, updated_by)
              VALUES (${sub.id}, ${hs[i].email}, ${hs[i].name}, ${i}, ${user.email})`;
          }
          subHelpers = hs;
        }
        // Fire-and-forget confirmation email (errors logged, not surfaced).
        // Name-only on-behalf rows skip it — it would just email the liaison
        // about her own entry; a real member still gets their confirmation.
        const nameOnlyBehalf = !!behalfName && (!behalfEmail || (behalfEmail.split('@')[1] || '') !== ALLOWED_DOMAIN);
        if (!nameOnlyBehalf) await sendSubmissionConfirmation(sub);
        return res.status(201).json({ submission: serializeSubmission(sub, subHelpers) });
      }

      // Link a curriculum to a class
      if (action === 'link') {
        const body = req.body || {};
        const session_number = parseInt(body.session_number, 10);
        const class_key = String(body.class_key || '').trim();
        const curriculum_id = parseInt(body.curriculum_id, 10);
        if (!session_number || !class_key || !curriculum_id) {
          return res.status(400).json({ error: 'session_number, class_key, and curriculum_id required' });
        }
        // Gate (2026-07-17 review): link/unlink were ungated — any member
        // could strip or swap any class's lesson-plan attachment. Allow a
        // reviewer (VP/ACL) or someone attaching their OWN curriculum.
        const linkActor = actingEmailFor(user, req).toLowerCase();
        const linkAuthor = await sql`SELECT author_email FROM curricula WHERE id = ${curriculum_id}`;
        const isLinkReviewer = await isReviewerReq(user, req);
        if (!isLinkReviewer && !(linkAuthor.length && String(linkAuthor[0].author_email || '').toLowerCase() === linkActor)) {
          return res.status(403).json({ error: 'Only the plan’s author or a class reviewer can attach it.' });
        }
        // Upsert — replace existing link for this class+session
        await sql`DELETE FROM class_curriculum_links WHERE session_number = ${session_number} AND class_key = ${class_key}`;
        const inserted = await sql`
          INSERT INTO class_curriculum_links (session_number, class_key, curriculum_id, attached_by)
          VALUES (${session_number}, ${class_key}, ${curriculum_id}, ${user.email})
          RETURNING id, session_number, class_key, curriculum_id, attached_by, attached_at
        `;
        return res.status(201).json({ link: inserted[0] });
      }

      // ── Room assignment (2026-07-10, Erin) ──
      // Assign / reassign / clear a placed class's room, gated by the
      // room_assign capability (defaults President / VP / Afternoon Class
      // Liaison). A room hosts ONE class per hour: conflicts check the
      // same year + session + period with hour overlap ('both' and 'AM'
      // span both hours). Stores the room NAME in scheduled_room so all
      // existing surfaces keep reading it unchanged.
      // ── Volunteer sign-up (2026-07-11): floater / board / prep pledge ──
      // Self-serve for the acting member. One commitment per block per
      // session (a lead/assist in that block also counts). Blocks are
      // per-hour: AM1 / AM2 / PM1 / PM2 (morning split 2026-07-11).
      // Caps: board 2, prep 2 per block; floater AM 2 per hour; floater
      // PM uncapped BUT gated on every placed class in that hour having
      // its helper spots covered.
      if (action === 'volunteer-signup') {
        const vsBody = req.body || {};
        const vsYear = String(vsBody.school_year || '').trim().slice(0, 20) || activeSchoolYear();
        const vsSess = parseInt(vsBody.session, 10);
        const vsBlock = String(vsBody.block || '').trim();
        const vsRole = String(vsBody.role || '').trim();
        if (!Number.isFinite(vsSess) || vsSess < 1 || vsSess > 5) return res.status(400).json({ error: 'session 1-5 required' });
        if (['AM1', 'AM2', 'PM1', 'PM2'].indexOf(vsBlock) === -1) return res.status(400).json({ error: 'block must be AM1, AM2, PM1, or PM2' });
        if (['floater', 'board', 'prep'].indexOf(vsRole) === -1) return res.status(400).json({ error: 'role must be floater, board, or prep' });
        const vsEmail = actingEmailFor(user, req).toLowerCase();
        // Board Duties is a board-member commitment (Erin, 2026-07-15) —
        // the dropdown hides it for everyone else, and the server backs
        // that up here.
        if (vsRole === 'board' && !(await isBoardMember(vsEmail))) {
          return res.status(403).json({ error: 'Board Duties is for board members.' });
        }
        const vsPeople = await sql`SELECT first_name, last_name FROM people
          WHERE LOWER(email) = ${vsEmail} OR LOWER(personal_email) = ${vsEmail} LIMIT 1`;
        const vsName = vsPeople.length ? ((vsPeople[0].first_name || '') + ' ' + (vsPeople[0].last_name || '')).trim() : (user.name || vsEmail);
        // One commitment per block: existing pledge? (legacy 'AM' rows
        // count against both morning hours)
        const vsDupeBlocks = vsBlock.indexOf('AM') === 0 ? ['AM', vsBlock] : [vsBlock];
        const dupe = await sql`SELECT id, role FROM volunteer_signups
          WHERE school_year = ${vsYear} AND session_number = ${vsSess} AND block = ANY(${vsDupeBlocks})
            AND LOWER(person_email) = ${vsEmail}`;
        if (dupe.length) return res.status(409).json({ error: 'You already have a ' + dupe[0].role + ' pledge for that hour — remove it first.' });
        // ...or a lead/assist already occupying the block?
        const vsHour = vsBlock === 'AM1' ? ['AM', 'AM1', '']
          : vsBlock === 'AM2' ? ['AM', 'AM2', '']
          : vsBlock === 'PM1' ? ['PM1', 'both'] : ['PM2', 'both'];
        const vsPeriod = vsBlock.indexOf('AM') === 0 ? 'AM' : 'PM';
        const busy = await sql`
          SELECT c.class_name FROM class_submissions c
          WHERE c.school_year = ${vsYear} AND c.scheduled_session = ${vsSess}
            AND c.class_period = ${vsPeriod} AND c.status IN ('scheduled', 'drafted')
            AND COALESCE(c.scheduled_hour, '') = ANY(${vsHour})
            AND (LOWER(c.submitted_by_email) = ${vsEmail}
              OR EXISTS (SELECT 1 FROM class_assignment_helpers h
                         WHERE h.class_submission_id = c.id
                           AND (h.block = '' OR h.block = ${vsBlock})
                           AND (LOWER(h.person_email) = ${vsEmail} OR LOWER(h.person_name) = LOWER(${vsName}))))
          LIMIT 1`;
        if (busy.length) return res.status(409).json({ error: 'You are already with “' + busy[0].class_name + '” that hour.' });
        // Support capacity: floater/board/prep slots only exist for adults
        // beyond the hour's key classroom positions — leads + co-leads +
        // assistant spots (Erin, 2026-07-15).
        const capCls = await sql`
          SELECT scheduled_hour, class_period, co_teachers, assistant_count
          FROM class_submissions
          WHERE school_year = ${vsYear} AND scheduled_session = ${vsSess}
            AND class_period = ${vsPeriod} AND status IN ('scheduled', 'drafted')`;
        let keyNeededHour = 0;
        capCls.forEach(r => {
          const occ = r.class_period === 'AM'
            ? (r.scheduled_hour === 'AM1' ? ['AM1'] : r.scheduled_hour === 'AM2' ? ['AM2'] : ['AM1', 'AM2'])
            : r.scheduled_hour === 'both' ? ['PM1', 'PM2'] : r.scheduled_hour === 'PM2' ? ['PM2'] : ['PM1'];
          if (occ.indexOf(vsBlock) === -1) return;
          keyNeededHour += 1
            + String(r.co_teachers || '').split(/[,;]+/).filter(s => s.trim()).length
            + Math.min.apply(null, (r.assistant_count && r.assistant_count.length) ? r.assistant_count : [1]);
        });
        const mlcRows = await sql`SELECT COUNT(*)::int AS n FROM people WHERE role = 'mlc'`;
        const supportCapacity = Math.max(0, mlcRows[0].n - keyNeededHour);
        const supportTaken = await sql`SELECT COUNT(*)::int AS n FROM volunteer_signups
          WHERE school_year = ${vsYear} AND session_number = ${vsSess} AND block = ANY(${vsDupeBlocks})`;
        if (supportTaken[0].n >= supportCapacity) {
          return res.status(409).json({ error: 'Support slots for that hour are full — every remaining adult is needed to lead or assist a class.' });
        }
        // Caps.
        const capCount = await sql`SELECT COUNT(*)::int AS n FROM volunteer_signups
          WHERE school_year = ${vsYear} AND session_number = ${vsSess} AND block = ANY(${vsDupeBlocks}) AND role = ${vsRole}`;
        const n = capCount[0].n;
        if (vsRole === 'board' && n >= 2) return res.status(409).json({ error: 'Board Duties is full for that hour (2 max).' });
        if (vsRole === 'prep' && n >= 2) return res.status(409).json({ error: 'Prep Period is full for that hour (2 max).' });
        if (vsRole === 'floater' && vsPeriod === 'AM' && n >= 2) return res.status(409).json({ error: 'Morning floaters are full for that hour (2 max).' });
        if (vsRole === 'floater' && vsPeriod === 'PM') {
          // PM gate: floaters open only once every placed class that hour
          // has its helper spots covered.
          // Count helpers PER HOUR (2026-07-17 review): assists on a 2-hour
          // 'both' class are hour-scoped (block='PM1'/'PM2'), so a class
          // wanting 2 assistants with one in each hour must NOT read as
          // covered. Match the block predicate every other consumer uses.
          const uncovered = await sql`
            SELECT c.class_name,
                   GREATEST(0, (SELECT MIN(x) FROM UNNEST(c.assistant_count) AS x)
                     - (SELECT COUNT(*)::int FROM class_assignment_helpers h
                        WHERE h.class_submission_id = c.id AND (h.block = '' OR h.block = ${vsBlock}))) AS gap
            FROM class_submissions c
            WHERE c.school_year = ${vsYear} AND c.scheduled_session = ${vsSess}
              AND c.class_period = 'PM' AND c.status IN ('scheduled', 'drafted')
              AND COALESCE(c.scheduled_hour, '') = ANY(${vsHour})`;
          const needy = uncovered.find(u => Number(u.gap) > 0);
          // Generic on purpose (Erin, 2026-07-15) — no class name, just the rule.
          if (needy) return res.status(409).json({ error: 'Classes that hour still need assistants — classes fill before floaters.' });
        }
        const insertedVs = await sql`
          INSERT INTO volunteer_signups (school_year, session_number, block, role, person_email, person_name)
          VALUES (${vsYear}, ${vsSess}, ${vsBlock}, ${vsRole}, ${vsEmail}, ${vsName})
          RETURNING id, block, role`;
        return res.status(201).json({ ok: true, signup: insertedVs[0] });
      }

      // ── Volunteer assist (2026-07-11): join a class as an assistant ──
      // Writes the existing class_assignment_helpers roster, so builder
      // tiles, the published schedule, and participation credit all see
      // it immediately.
      if (action === 'volunteer-assist') {
        const vaSubId = parseInt((req.body || {}).class_submission_id, 10);
        if (!Number.isFinite(vaSubId)) return res.status(400).json({ error: 'class_submission_id required' });
        const vaEmail = actingEmailFor(user, req).toLowerCase();
        const vaCls = await sql`SELECT id, class_name, class_period, scheduled_hour, school_year, scheduled_session, status, submitted_by_email, assistant_count
          FROM class_submissions WHERE id = ${vaSubId}`;
        if (!vaCls.length || !vaCls[0].scheduled_session || ['scheduled', 'drafted'].indexOf(vaCls[0].status) === -1) {
          return res.status(409).json({ error: 'That class is not on the schedule.' });
        }
        const vc = vaCls[0];
        if ((vc.submitted_by_email || '').toLowerCase() === vaEmail) {
          return res.status(409).json({ error: 'You lead this class — no need to assist it too.' });
        }
        const vaPeople = await sql`SELECT first_name, last_name FROM people
          WHERE LOWER(email) = ${vaEmail} OR LOWER(personal_email) = ${vaEmail} LIMIT 1`;
        const vaName = vaPeople.length ? ((vaPeople[0].first_name || '') + ' ' + (vaPeople[0].last_name || '')).trim() : (user.name || vaEmail);
        // Assisting a class that spans two hours (whole-morning AM, or a
        // 2-hour 'both' afternoon class) from an hour dropdown is a ONE-hour
        // commitment (Erin, 2026-07-15): honor body.block so the other hour
        // stays free for a different pick.
        const spansTwoHours = vc.class_period === 'AM'
          ? (vc.scheduled_hour !== 'AM1' && vc.scheduled_hour !== 'AM2')
          : vc.scheduled_hour === 'both';
        const validHourBlocks = vc.class_period === 'AM' ? ['AM1', 'AM2'] : ['PM1', 'PM2'];
        const reqBlock = String((req.body || {}).block || '').trim();
        const effBlock = (spansTwoHours && validHourBlocks.indexOf(reqBlock) !== -1) ? reqBlock : '';
        // One commitment per block the ASSIST occupies.
        const vaBlocks = effBlock ? [effBlock]
          : vc.class_period === 'AM'
            ? (vc.scheduled_hour === 'AM1' ? ['AM1'] : vc.scheduled_hour === 'AM2' ? ['AM2'] : ['AM1', 'AM2'])
            : vc.scheduled_hour === 'both' ? ['PM1', 'PM2'] : vc.scheduled_hour === 'PM2' ? ['PM2'] : ['PM1'];
        for (const b of vaBlocks) {
          const bHours = b === 'AM1' ? ['AM', 'AM1', '']
            : b === 'AM2' ? ['AM', 'AM2', '']
            : b === 'PM1' ? ['PM1', 'both'] : ['PM2', 'both'];
          const clash = await sql`
            SELECT c.class_name FROM class_submissions c
            WHERE c.school_year = ${vc.school_year} AND c.scheduled_session = ${vc.scheduled_session}
              AND c.class_period = ${vc.class_period === 'AM' ? 'AM' : 'PM'} AND c.status IN ('scheduled', 'drafted')
              AND c.id <> ${vaSubId}
              AND COALESCE(c.scheduled_hour, '') = ANY(${bHours})
              AND (LOWER(c.submitted_by_email) = ${vaEmail}
                OR EXISTS (SELECT 1 FROM class_assignment_helpers h
                           WHERE h.class_submission_id = c.id
                             AND (h.block = '' OR h.block = ${b})
                             AND (LOWER(h.person_email) = ${vaEmail} OR LOWER(h.person_name) = LOWER(${vaName}))))
            LIMIT 1`;
          if (clash.length) return res.status(409).json({ error: 'You are already with “' + clash[0].class_name + '” that hour.' });
          const vaPledgeBlocks = b.indexOf('AM') === 0 ? ['AM', b] : [b];
          const pledged = await sql`SELECT role FROM volunteer_signups
            WHERE school_year = ${vc.school_year} AND session_number = ${vc.scheduled_session}
              AND block = ANY(${vaPledgeBlocks}) AND LOWER(person_email) = ${vaEmail}`;
          if (pledged.length) return res.status(409).json({ error: 'You already have a ' + pledged[0].role + ' pledge that hour — remove it first.' });
        }
        // Overlap check: an existing whole-class row blocks everything;
        // an hour row only blocks that hour (or a new whole-class join).
        const already = await sql`SELECT id, block FROM class_assignment_helpers
          WHERE class_submission_id = ${vaSubId}
            AND (LOWER(person_email) = ${vaEmail} OR LOWER(person_name) = LOWER(${vaName}))`;
        const overlaps = already.some(r => r.block === '' || effBlock === '' || r.block === effBlock);
        if (overlaps) return res.status(409).json({ error: 'You are already helping this class that hour.' });
        // Capacity gate (testers, 2026-07-16: Place Adults let you stack
        // unlimited helpers onto a full class). A class wants
        // MIN(assistant_count) helpers per hour; whole-class helper rows
        // (block='') occupy every hour the class runs — same math as the
        // volunteer-matrix helpers_needed derivation.
        const vaWants = (vc.assistant_count && vc.assistant_count.length)
          ? Math.min.apply(null, vc.assistant_count) : 1;
        for (const b of vaBlocks) {
          const helperCount = await sql`SELECT COUNT(*)::int AS n FROM class_assignment_helpers
            WHERE class_submission_id = ${vaSubId} AND (block = '' OR block = ${b})`;
          if (helperCount[0].n >= vaWants) {
            return res.status(409).json({ error: '“' + vc.class_name + '” already has its ' + vaWants + ' assistant' + (vaWants === 1 ? '' : 's') + ' for ' + b + '. Pick a class that still shows an open spot.' });
          }
        }
        const sortRows = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM class_assignment_helpers WHERE class_submission_id = ${vaSubId}`;
        await sql`INSERT INTO class_assignment_helpers (class_submission_id, person_email, person_name, block, sort_order, updated_by)
          VALUES (${vaSubId}, ${vaEmail}, ${vaName}, ${effBlock}, ${sortRows[0].next}, ${user.email})`;
        return res.status(201).json({ ok: true, class_id: vaSubId, class_name: vc.class_name });
      }

      if (action === 'assign-room') {
        const actingEmail = actingEmailFor(user, req);
        const mayAssign = isSuperUser(actingEmail) || await hasCapability(actingEmail, 'room_assign');
        if (!mayAssign) {
          return res.status(403).json({ error: 'Only the President, VP, or Afternoon Class Liaison can assign rooms. (You are acting as ' + actingEmail + '.)' });
        }
        const body = req.body || {};
        const subId = parseInt(body.id, 10);
        if (!Number.isFinite(subId)) return res.status(400).json({ error: 'id required' });
        const room = String(body.room || '').trim().slice(0, 100);
        // Outdoor primaries carry an indoor BACKUP (rain plan) that stays
        // reserved for the hour (2026-07-11, Erin).
        let backup = String(body.backup_room || '').trim().slice(0, 100);
        const rows = await sql`
          SELECT id, class_name, class_period, school_year, scheduled_session, scheduled_hour, status
          FROM class_submissions WHERE id = ${subId}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Class not found.' });
        const target = rows[0];
        if (room && !target.scheduled_session) {
          return res.status(409).json({ error: 'Place the class into a session first — rooms attach to a scheduled slot.' });
        }
        if (room) {
          const roomRows = await sql`SELECT name, is_outdoor FROM rooms WHERE status = 'active'`;
          const roomMeta = {};
          roomRows.forEach(r => { roomMeta[String(r.name).toLowerCase()] = r; });
          const primaryMeta = roomMeta[room.toLowerCase()];
          if (primaryMeta && primaryMeta.is_outdoor) {
            const backupMeta = backup ? roomMeta[backup.toLowerCase()] : null;
            if (!backupMeta) return res.status(409).json({ error: '“' + room + '” is an outdoor space — pick an indoor backup room for it.' });
            if (backupMeta.is_outdoor) return res.status(409).json({ error: 'The backup for an outdoor space must be an INDOOR room.' });
          } else {
            backup = ''; // indoor primary needs no backup
          }
          const hoursOverlap = (a, b) => {
            const A = String(a || ''), B = String(b || '');
            if (target.class_period === 'AM') {
              // '' / 'AM' = both morning hours.
              if (!A || A === 'AM' || !B || B === 'AM') return true;
              return A === B;
            }
            if (A === 'both' || B === 'both') return true;
            return A === B;
          };
          // A room is taken when any same-slot class holds it as PRIMARY
          // or has it reserved as a rain BACKUP.
          const occupants = await sql`
            SELECT id, class_name, scheduled_hour, scheduled_room, scheduled_backup_room
            FROM class_submissions
            WHERE school_year = ${target.school_year}
              AND scheduled_session = ${target.scheduled_session}
              AND class_period = ${target.class_period}
              AND status IN ('scheduled', 'drafted')
              AND id <> ${subId}`;
          const wanted = [room, backup].filter(Boolean).map(x => x.toLowerCase());
          const clash = occupants.find(o => hoursOverlap(target.scheduled_hour, o.scheduled_hour)
            && (wanted.indexOf(String(o.scheduled_room || '').toLowerCase()) !== -1
              || wanted.indexOf(String(o.scheduled_backup_room || '').toLowerCase()) !== -1));
          if (clash) {
            return res.status(409).json({ error: 'That room is already taken (or reserved as a rain backup) that hour by “' + clash.class_name + '”. Pick another.' });
          }
        } else {
          backup = '';
        }
        const updated = await sql`
          UPDATE class_submissions
          SET scheduled_room = ${room}, scheduled_backup_room = ${backup}, updated_at = NOW()
          WHERE id = ${subId}
          RETURNING id, scheduled_room, scheduled_backup_room`;
        return res.status(200).json({ ok: true, id: updated[0].id, room: updated[0].scheduled_room, backup_room: updated[0].scheduled_backup_room });
      }

      // VP / Afternoon Class Liaison toggle a Schedule Builder session's
      // "Approved" lock. Sets approved_at/approved_by on the matching
      // co_op_sessions row when body.approved is true; clears them when
      // false. The Schedule Builder reads this state via the
      // class-submissions response and uses it to make the grid read-only.
      if (action === 'session-approval') {
        // Full-scope reviewers only — group liaisons build their slots but
        // don't flip a whole session's approval.
        const apScope = await reviewerScopeReq(user, req);
        if (!apScope || !apScope.all) {
          return res.status(403).json({ error: 'Only the VP or Afternoon Class Liaison can approve a session.', youAre: user.email });
        }
        const body = req.body || {};
        const school_year = String(body.school_year || '').trim();
        const session = parseInt(body.session, 10);
        const approved = !!body.approved;
        // Morning approval is independent (2026-07-06): period 'AM' flips
        // am_approved_*; default/'PM' keeps the original columns, which
        // also gate afternoon sign-ups.
        const period = String(body.period || 'PM').toUpperCase() === 'AM' ? 'AM' : 'PM';
        if (!school_year) return res.status(400).json({ error: 'school_year required' });
        if (!session || session < 1 || session > 5) return res.status(400).json({ error: 'session must be 1–5' });
        const updated = period === 'AM'
          ? await sql`
              UPDATE co_op_sessions
              SET am_approved_at = ${approved ? new Date() : null},
                  am_approved_by = ${approved ? user.email : null},
                  updated_at  = NOW(),
                  updated_by  = ${user.email}
              WHERE school_year = ${school_year} AND session_number = ${session}
              RETURNING school_year, session_number, am_approved_at, am_approved_by
            `
          : await sql`
              UPDATE co_op_sessions
              SET approved_at = ${approved ? new Date() : null},
                  approved_by = ${approved ? user.email : null},
                  updated_at  = NOW(),
                  updated_by  = ${user.email}
              WHERE school_year = ${school_year} AND session_number = ${session}
              RETURNING school_year, session_number, approved_at, approved_by
            `;
        if (updated.length === 0) {
          return res.status(404).json({ error: 'No session row for ' + school_year + ' / Session ' + session + '. Add session dates first.' });
        }
        return res.status(200).json({ ok: true, ...updated[0] });
      }

      // VP / Afternoon Class Liaison open/close/lock a session's sign-up window.
      // Opening requires the session's Schedule Builder to be Approved first
      // and a (start, end) date range so the parent My Family widget knows
      // when to show itself.
      // ── Class Inspiration: add an idea (Erin, 2026-07-15) ──
      if (action === 'class-inspiration') {
        const ciEditor = isSuperUser(user.email) || await hasCapability(user.email, 'class_inspiration_edit');
        if (!ciEditor) return res.status(403).json({ error: 'Only the VP or Afternoon Class Liaison can edit the inspiration list.' });
        const ciGroup = String((req.body || {}).group_name || '').trim().slice(0, 80);
        const ciIdea = String((req.body || {}).idea || '').trim().slice(0, 200);
        if (!ciGroup || !ciIdea) return res.status(400).json({ error: 'group_name and idea required' });
        const ciNext = await sql`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM class_inspirations WHERE group_name = ${ciGroup}`;
        const ciIns = await sql`INSERT INTO class_inspirations (group_name, idea, sort_order, created_by)
          VALUES (${ciGroup}, ${ciIdea}, ${ciNext[0].n}, ${user.email}) RETURNING id`;
        return res.status(201).json({ ok: true, id: ciIns[0].id });
      }

      // ── Over-max resolution (Erin, 2026-07-15): raise the cap, spin up a
      // second section, or run the lottery. All reviewer-scoped writes.
      if (action === 'class-set-max') {
        const smId = parseInt((req.body || {}).id, 10);
        const smMax = parseInt((req.body || {}).max_students, 10);
        if (!Number.isFinite(smId) || !Number.isFinite(smMax) || smMax < 1 || smMax > 60) {
          return res.status(400).json({ error: 'id and max_students (1-60) required' });
        }
        const smScope = await reviewerScopeReq(user, req);
        const smRows = await sql`SELECT id, class_period, age_groups FROM class_submissions WHERE id = ${smId}`;
        if (!smRows.length) return res.status(404).json({ error: 'Class not found.' });
        if (!smScope || !scopeAllowsSub(smScope, smRows[0])) return res.status(403).json({ error: 'Reviewers only.' });
        await sql`UPDATE class_submissions SET max_students = ${smMax}, updated_at = NOW() WHERE id = ${smId}`;
        return res.status(200).json({ ok: true, id: smId, max_students: smMax });
      }

      if (action === 'class-duplicate') {
        const dupId = parseInt((req.body || {}).id, 10);
        if (!Number.isFinite(dupId)) return res.status(400).json({ error: 'id required' });
        const dupScope = await reviewerScopeReq(user, req);
        const dupRows = await sql`SELECT * FROM class_submissions WHERE id = ${dupId}`;
        if (!dupRows.length) return res.status(404).json({ error: 'Class not found.' });
        const dc = dupRows[0];
        if (!dupScope || !scopeAllowsSub(dupScope, dc)) return res.status(403).json({ error: 'Reviewers only.' });
        // Same schedule slot + settings; the liaison lines up a second
        // leader afterwards (room stays blank so it can be assigned).
        const ins = await sql`
          INSERT INTO class_submissions
            (submitted_by_email, submitted_by_name, school_year, class_name,
             session_preferences, hour_preference, assistant_count, co_teachers,
             space_request, space_request_other, max_students, max_students_other,
             age_groups, age_groups_other, pre_enroll_kids, open_to_teen_assistant,
             prerequisites, description, other_info, status,
             scheduled_session, scheduled_hour, scheduled_age_range, scheduled_room,
             reviewer_notes, reviewed_by_email, reviewed_at)
          VALUES
            (${dc.submitted_by_email}, ${dc.submitted_by_name}, ${dc.school_year}, ${dc.class_name + ' — 2nd section'},
             ${dc.session_preferences}, ${dc.hour_preference}, ${dc.assistant_count}, ${dc.co_teachers},
             ${dc.space_request}, ${dc.space_request_other}, ${dc.max_students}, ${dc.max_students_other},
             ${dc.age_groups}, ${dc.age_groups_other}, ${dc.pre_enroll_kids}, ${dc.open_to_teen_assistant},
             ${dc.prerequisites}, ${dc.description}, ${dc.other_info}, ${dc.status},
             ${dc.scheduled_session}, ${dc.scheduled_hour}, ${dc.scheduled_age_range}, ${''},
             ${'Second section spun up from over-full sign-ups (' + user.email + ')'}, ${user.email}, NOW())
          RETURNING id, class_name`;
        return res.status(201).json({ ok: true, id: ins[0].id, class_name: ins[0].class_name });
      }

      if (action === 'class-lottery') {
        const ltId = parseInt((req.body || {}).id, 10);
        if (!Number.isFinite(ltId)) return res.status(400).json({ error: 'id required' });
        const ltScope = await reviewerScopeReq(user, req);
        const ltRows = await sql`SELECT * FROM class_submissions WHERE id = ${ltId}`;
        if (!ltRows.length) return res.status(404).json({ error: 'Class not found.' });
        const lt = ltRows[0];
        if (!ltScope || !scopeAllowsSub(ltScope, lt)) return res.status(403).json({ error: 'Reviewers only.' });
        const max = lt.max_students || 0;
        if (max < 1) return res.status(400).json({ error: 'Set a max before running a lottery.' });
        const ltHour = (lt.scheduled_hour === 'PM2') ? 'PM2' : 'PM1';
        // 1st-choice kids, with display names for the result summary.
        // kid_id rides along (kid_id-first join, name fallback for legacy
        // rows) so the bump insert + 2nd-choice promotion are rename-proof.
        // Enrollment-scoped (2026-07-19): stale picks from kids not
        // ENROLLED this season don't enter the lottery pool; NULL-kid_id
        // legacy rows keep counting (transition tolerance).
        const signed = await sql`
          SELECT p.id AS pick_id, LOWER(p.family_email) AS fam, p.kid_first_name,
                 k.id AS kid_id,
                 COALESCE(NULLIF(k.nickname, ''), p.kid_first_name) AS display_first,
                 COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last
          FROM class_signup_picks p
          JOIN kids k ON (p.kid_id IS NOT NULL AND k.id = p.kid_id)
                      OR (p.kid_id IS NULL
                          AND LOWER(k.family_email) = LOWER(p.family_email)
                          AND LOWER(k.first_name) = LOWER(p.kid_first_name))
          LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(p.family_email)
          WHERE p.class_submission_id = ${ltId} AND p.rank = 1 AND p.hour = ${ltHour}
            AND p.school_year = ${lt.school_year} AND p.session_number = ${lt.scheduled_session}
            AND (p.kid_id IS NULL OR EXISTS (
              SELECT 1 FROM kid_enrollments e
              WHERE e.kid_id = p.kid_id AND e.season = ${lt.school_year}
                AND e.status = 'enrolled'))`;
        if (signed.length <= max) return res.status(409).json({ error: 'This class is not over its max — no lottery needed.' });
        // Exempt (never bumped): the lead's own kids, and any kid who
        // already lost a lottery this school year.
        const leadFam = await sql`SELECT family_email FROM people
          WHERE LOWER(email) = LOWER(${lt.submitted_by_email})
             OR LOWER(personal_email) = LOWER(${lt.submitted_by_email}) LIMIT 1`;
        const leadFamEmail = leadFam.length ? String(leadFam[0].family_email || '').toLowerCase() : '';
        const priorBumps = await sql`SELECT kid_id, LOWER(family_email) AS fam, LOWER(kid_first_name) AS kid
          FROM class_lottery_bumps WHERE school_year = ${lt.school_year}`;
        const priorSet = new Set(priorBumps.map(r => r.fam + '|' + r.kid));
        const priorIds = new Set(priorBumps.map(r => r.kid_id).filter(Boolean));
        const safe = [];
        const pool = [];
        signed.forEach(s2 => {
          const key = s2.fam + '|' + String(s2.kid_first_name).toLowerCase();
          const priorLoss = (s2.kid_id && priorIds.has(s2.kid_id)) || priorSet.has(key);
          if ((leadFamEmail && s2.fam === leadFamEmail) || priorLoss) safe.push(s2);
          else pool.push(s2);
        });
        // Fisher-Yates, then keep enough from the pool to reach max.
        for (let i = pool.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        const keepFromPool = Math.max(0, max - safe.length);
        const winners = pool.slice(0, keepFromPool);
        const losers = pool.slice(keepFromPool);
        const nameOf = s2 => (s2.display_first + ' ' + (s2.display_last || '')).trim();
        for (const l of losers) {
          // Dual-keyed (enrollment re-key phase): kid_id alongside the name
          // columns so the year-wide exemption survives a kid rename.
          await sql`INSERT INTO class_lottery_bumps
            (school_year, session_number, class_submission_id, family_email, kid_first_name, kid_id, created_by)
            VALUES (${lt.school_year}, ${lt.scheduled_session}, ${ltId}, ${l.fam}, ${l.kid_first_name}, ${l.kid_id || null}, ${user.email})`;
          // Drop the lost 1st choice; their 2nd choice (same hour) becomes
          // their 1st so the family keeps a placement without re-picking.
          // kid_id match first, name match for unmapped legacy rows.
          await sql`DELETE FROM class_signup_picks WHERE id = ${l.pick_id}`;
          await sql`UPDATE class_signup_picks SET rank = 1
            WHERE school_year = ${lt.school_year} AND session_number = ${lt.scheduled_session}
              AND (kid_id = ${l.kid_id || null}
                OR (LOWER(family_email) = ${l.fam} AND LOWER(kid_first_name) = LOWER(${l.kid_first_name})))
              AND hour = ${ltHour} AND rank = 2`;
        }
        await sql`UPDATE class_submissions SET lottery_run_at = NOW(), updated_at = NOW() WHERE id = ${ltId}`;
        return res.status(200).json({
          ok: true, id: ltId,
          kept: safe.concat(winners).map(nameOf).sort(),
          bumped: losers.map(nameOf).sort(),
          exempt: safe.map(nameOf).sort()
        });
      }

      // ── Mark a lottery move as "family told" (Erin, 2026-07-16) ──
      // Clears the row from the liaison's lottery-moves To Do.
      if (action === 'lottery-move-notified') {
        const lmId = parseInt((req.body || {}).id, 10);
        if (!Number.isFinite(lmId)) return res.status(400).json({ error: 'id required' });
        if (!(await isReviewerReq(user, req))) return res.status(403).json({ error: 'Reviewers only.' });
        const upd = await sql`
          UPDATE class_lottery_bumps
          SET notified_at = NOW(), notified_by = ${user.email}
          WHERE id = ${lmId} AND notified_at IS NULL
          RETURNING id`;
        return res.status(200).json({ ok: true, id: lmId, updated: upd.length });
      }

      // ── Send the lead-confirmation email (edited draft) ──
      if (action === 'class-confirm-send') {
        const csId = parseInt((req.body || {}).id, 10);
        const csSubject = String((req.body || {}).subject || '').trim().slice(0, 200);
        const csBody = String((req.body || {}).body || '').trim().slice(0, 8000);
        if (!Number.isFinite(csId) || !csSubject || !csBody) {
          return res.status(400).json({ error: 'id, subject, and body required' });
        }
        const csScope = await reviewerScopeReq(user, req);
        const csRows = await sql`SELECT id, class_name, class_period, age_groups, submitted_by_email FROM class_submissions WHERE id = ${csId}`;
        if (!csRows.length) return res.status(404).json({ error: 'Class not found.' });
        if (!csScope || !scopeAllowsSub(csScope, csRows[0])) return res.status(403).json({ error: 'Reviewers only.' });
        if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email service is not configured in this environment.' });
        const escBody = csBody
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>');
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'Roots & Wings <noreply@rootsandwingsindy.com>',
            to: csRows[0].submitted_by_email,
            replyTo: user.email,
            subject: emailSubject(csSubject),
            html: '<div style="font-family:Georgia,serif;line-height:1.5;">' + escBody + '</div>'
          });
        } catch (mailErr) {
          console.error('class-confirm-send email error:', mailErr);
          return res.status(502).json({ error: 'Email failed to send — try again.' });
        }
        await sql`UPDATE class_submissions
          SET lead_email_sent_at = NOW(), lead_email_sent_by = ${user.email}, updated_at = NOW()
          WHERE id = ${csId}`;
        return res.status(200).json({ ok: true, id: csId });
      }

      if (action === 'class-signup-window') {
        // Sign-ups are an afternoon concern — full-scope reviewers only.
        const swScope = await reviewerScopeReq(user, req);
        if (!swScope || !swScope.all) {
          return res.status(403).json({ error: 'Only the VP or Afternoon Class Liaison can manage sign-ups.', youAre: user.email });
        }
        const body = req.body || {};
        const session = parseInt(body.session, 10);
        const status = String(body.status || '').trim();
        if (!session) return res.status(400).json({ error: 'session required' });
        if (['open', 'closed', 'locked'].indexOf(status) === -1) {
          return res.status(400).json({ error: 'status must be open, closed, or locked' });
        }
        const sy = activeSchoolYear(new Date());
        // Date range. Strict YYYY-MM-DD; end >= start. Required when opening
        // (so parents see a deterministic window); optional when closing /
        // locking (preserves whatever range the VP last set).
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        const rawStart = String(body.signup_start_date || '').trim();
        const rawEnd   = String(body.signup_end_date || '').trim();
        if (rawStart && !dateRe.test(rawStart)) return res.status(400).json({ error: 'signup_start_date must be YYYY-MM-DD' });
        if (rawEnd && !dateRe.test(rawEnd))     return res.status(400).json({ error: 'signup_end_date must be YYYY-MM-DD' });
        if (rawStart && rawEnd && rawEnd < rawStart) {
          return res.status(400).json({ error: 'signup_end_date must be on or after signup_start_date' });
        }
        // Gate: opening requires the Schedule Builder session to be Approved.
        if (status === 'open') {
          if (!rawStart || !rawEnd) return res.status(400).json({ error: 'Pick a start and end date for sign-ups.' });
          const approvedRows = await sql`
            SELECT approved_at FROM co_op_sessions
            WHERE school_year = ${sy} AND session_number = ${session} AND approved_at IS NOT NULL
            LIMIT 1
          `;
          if (approvedRows.length === 0) {
            return res.status(400).json({ error: 'Approve Session ' + session + ' in the Afternoon Class Builder before opening sign-ups.' });
          }
        }
        const startDate = rawStart || null;
        const endDate   = rawEnd   || null;
        const now = new Date();
        const openedAt = status === 'open' ? now : null;
        const closedAt = status === 'closed' ? now : null;
        const lockedAt = status === 'locked' ? now : null;
        const openedBy = status === 'open' ? user.email : null;
        await sql`
          INSERT INTO class_signup_windows
            (school_year, session_number, status, opened_by, opened_at, closed_at, locked_at,
             signup_start_date, signup_end_date, updated_by, updated_at)
          VALUES (${sy}, ${session}, ${status}, ${openedBy}, ${openedAt}, ${closedAt}, ${lockedAt},
             ${startDate}, ${endDate}, ${user.email}, ${now})
          ON CONFLICT (school_year, session_number) DO UPDATE SET
            status            = EXCLUDED.status,
            opened_by         = COALESCE(EXCLUDED.opened_by, class_signup_windows.opened_by),
            opened_at         = COALESCE(EXCLUDED.opened_at, class_signup_windows.opened_at),
            closed_at         = COALESCE(EXCLUDED.closed_at, class_signup_windows.closed_at),
            locked_at         = COALESCE(EXCLUDED.locked_at, class_signup_windows.locked_at),
            signup_start_date = COALESCE(EXCLUDED.signup_start_date, class_signup_windows.signup_start_date),
            signup_end_date   = COALESCE(EXCLUDED.signup_end_date,   class_signup_windows.signup_end_date),
            updated_by        = EXCLUDED.updated_by,
            updated_at        = EXCLUDED.updated_at
        `;
        return res.status(200).json({ ok: true, status });
      }

      // Save a kid's ranked picks for one hour. Parents may edit only while the
      // window is 'open'; reviewers may also edit while 'closed' (never once
      // 'locked'). Picks are scoped to the caller's resolved family.
      if (action === 'class-signup-picks') {
        const body = req.body || {};
        const session = parseInt(body.session, 10);
        const hour = String(body.hour || '').trim();
        const kidFirst = String(body.kid_first_name || '').trim();
        const ranked = (Array.isArray(body.ranked_class_ids) ? body.ranked_class_ids : [])
          .map(x => parseInt(x, 10)).filter(Boolean);
        // Optional per-class parent note ({classId: text}) — required by the
        // client when the class is outside the kid's age range.
        const rawNotes = (body.notes && typeof body.notes === 'object') ? body.notes : {};
        // Optional per-class assistant flag ({classId: true}) — Pigeons
        // ranking a class as its assistant. Only honored below for classes
        // whose teacher opted in (open_to_teen_assistant).
        const rawAssist = (body.assist && typeof body.assist === 'object') ? body.assist : {};
        if (!session || (hour !== 'PM1' && hour !== 'PM2') || !kidFirst) {
          return res.status(400).json({ error: 'session, hour (PM1/PM2), and kid_first_name required' });
        }
        if (ranked.length > 8) return res.status(400).json({ error: 'Too many picks (max 8).' });
        const sy = activeSchoolYear(new Date());
        const isReviewer = await isReviewerReq(user, req);

        const winRows = await sql`
          SELECT status FROM class_signup_windows
          WHERE school_year = ${sy} AND session_number = ${session} LIMIT 1
        `;
        const wstatus = winRows[0] ? winRows[0].status : null;
        // The deadline (closed/locked) only stops MEMBER self-signup — the
        // VP + Afternoon Class Liaison place and move kids regardless of
        // window status (Erin, 2026-07-17: "the deadline just means members
        // can pick classes; the ACL should still be able to place/move").
        if (!isReviewer) {
          if (wstatus === 'locked') return res.status(409).json({ error: 'Sign-ups are locked for this session.' });
          if (wstatus !== 'open') return res.status(409).json({ error: 'Sign-ups are not open right now.' });
        }

        // Reviewers (VP + ACL) place other families' kids from the To Do
        // card — honor their view_as even without canImpersonate (testers,
        // 2026-07-16). resolveSubmitterEmail alone only swaps identities
        // for super users on prod.
        let effEmail = resolveSubmitterEmail(user, body.view_as);
        if (isReviewer && effEmail === user.email) {
          const rvVa = String(body.view_as || '').trim().toLowerCase();
          if (rvVa && (rvVa.split('@')[1] || '') === ALLOWED_DOMAIN) effEmail = rvVa;
        }
        const fam = await resolveFamily(sql, effEmail);
        if (!fam || !fam.family_email) return res.status(403).json({ error: 'No family found for your account.' });
        const familyEmail = fam.family_email;
        if (!isReviewer && !isSuperUser(user.email)) {
          // The real login qualifies directly, OR — when View-As was honored
          // (resolveSubmitterEmail only swaps identities for callers that
          // pass canImpersonate: super users on prod, any signed-in member
          // on dev/preview) — the IMPERSONATED identity must belong to the
          // family. Checking only the real login 403'd every non-reviewer
          // View-As save (2026-07-15: "picks only save for reviewers").
          const actingSelf = await canActAs(sql, user.email, familyEmail);
          const actingViewAs = !actingSelf
            && effEmail !== user.email
            && (await canActAs(sql, effEmail, familyEmail));
          if (!actingSelf && !actingViewAs) {
            return res.status(403).json({ error: 'Not allowed to edit this family.' });
          }
        }
        const kidOk = await sql`
          SELECT id, class_group, birth_date, schedule FROM kids
          WHERE LOWER(family_email) = LOWER(${familyEmail})
            AND LOWER(first_name) = LOWER(${kidFirst}) LIMIT 1
        `;
        if (kidOk.length === 0) return res.status(400).json({ error: 'That child is not in your family.' });
        const kidId = kidOk[0].id;
        // Mirror the picker's eligibility server-side: Greenhouse /
        // under-3 kids aren't in afternoon programming, and the season's
        // kid_enrollments row is the schedule truth (enrollment re-key
        // phase, 2026-07-19) — pending / not-returning / morning-only kids
        // can't take picks. Kids without an enrollment row yet (legacy,
        // pre-backfill) fall back to the kids.schedule column.
        {
          const kr = kidOk[0];
          const krAge = ageFromBirthDate(kr.birth_date);
          const enrRows = await sql`
            SELECT status, schedule FROM kid_enrollments
            WHERE kid_id = ${kidId} AND season = ${sy} LIMIT 1
          `;
          const notAfternoon = enrRows.length
            ? (enrRows[0].status !== 'enrolled'
               || String(enrRows[0].schedule || '').trim().toLowerCase() === 'morning')
            : String(kr.schedule || '').trim().toLowerCase() === 'morning';
          const ineligible =
            String(kr.class_group || '').trim().toLowerCase() === 'greenhouse'
            || notAfternoon
            || (krAge != null && krAge < 3);
          if (ineligible && ranked.length > 0) {
            return res.status(400).json({ error: 'That child isn’t in afternoon programming this season (Greenhouse, under 3, morning-only, or not enrolled).' });
          }
        }

        // Keep only ids that are scheduled classes valid for this hour, in the
        // submitted rank order, de-duplicated.
        let validRows = [];
        if (ranked.length) {
          validRows = await sql`
            SELECT id, scheduled_hour, open_to_teen_assistant FROM class_submissions
            WHERE status='scheduled' AND school_year=${sy} AND scheduled_session=${session}
              AND class_period = 'PM'
              AND id = ANY(${ranked}::int[])
          `;
        }
        const hourById = {};
        const teenOkById = {};
        validRows.forEach(r => {
          hourById[r.id] = r.scheduled_hour;
          teenOkById[r.id] = r.open_to_teen_assistant === true;
        });
        const cleanIds = [];
        const seen = {};
        for (const cid of ranked) {
          if (seen[cid]) continue;
          const h = hourById[cid];
          if (!h) continue;
          if ((hour === 'PM1' && (h === 'PM1' || h === 'both')) || (hour === 'PM2' && h === 'PM2')) {
            cleanIds.push(cid); seen[cid] = true;
          }
        }

        // Atomic replace (2026-07-17 review): DELETE + INSERTs run as one
        // transaction so a crash between them can't wipe the kid's existing
        // picks and write nothing back (the "dev kid lost 3 picks" incident).
        // The DELETE matches by kid_id first (rename-proof — clears rows
        // saved under an old first name) with the name key as the fallback
        // for unmapped legacy rows; INSERTs dual-key (name + kid_id). The
        // kid_id branch deliberately ignores family_email: backfilled rows
        // can carry an old DERIVED family_email that differs from the kid's
        // real one, and those must not survive the replace (kid_id is
        // globally unique + already family-verified by the kidOk lookup).
        const pickStmts = [sql`
          DELETE FROM class_signup_picks
          WHERE school_year=${sy} AND session_number=${session}
            AND (kid_id = ${kidId}
              OR (kid_id IS NULL
                  AND LOWER(family_email)=LOWER(${familyEmail})
                  AND LOWER(kid_first_name)=LOWER(${kidFirst})))
            AND hour=${hour}
        `];
        for (let i = 0; i < cleanIds.length; i++) {
          const note = String(rawNotes[cleanIds[i]] || '').trim().slice(0, 300);
          const asAssistant = !!rawAssist[cleanIds[i]] && teenOkById[cleanIds[i]] === true;
          pickStmts.push(sql`
            INSERT INTO class_signup_picks
              (school_year, session_number, family_email, kid_first_name, kid_id, hour, rank, class_submission_id, note, as_assistant, created_by_email)
            VALUES (${sy}, ${session}, ${familyEmail}, ${kidFirst}, ${kidId}, ${hour}, ${i + 1}, ${cleanIds[i]}, ${note}, ${asAssistant}, ${user.email})
          `);
        }
        await sql.transaction(pickStmts);
        return res.status(200).json({ ok: true, saved: cleanIds.length });
      }

      if (action === 'copy' && id) {
        const source = await getFullCurriculum(sql, id);
        if (!source) return res.status(404).json({ error: 'Source not found' });
        const copyBody = {
          title: source.title + ' (copy)',
          subject: source.subject,
          age_range: source.age_range,
          overview: source.overview,
          tags: source.tags,
          edit_policy: 'author_only',
          lesson_count: source.lesson_count,
          parent_id: source.id,
          lessons: source.lessons.map(l => ({
            title: l.title,
            overview: l.overview,
            activity: l.activity,
            instruction: l.instruction,
            links: l.links,
            supplies: l.supplies
          }))
        };
        const newId = await createCurriculum(sql, user, copyBody);
        const created = await getFullCurriculum(sql, newId);
        return res.status(201).json({ curriculum: created });
      }

      // Plain create
      const body = req.body || {};
      if (!body.title || !String(body.title).trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      const newId = await createCurriculum(sql, user, body);
      const created = await getFullCurriculum(sql, newId);
      return res.status(201).json({ curriculum: created });
    }

    // ── PATCH update ──
    if (req.method === 'PATCH') {
      // Reviewer schedule/unschedule/decline path — VP + Afternoon Class
      // Liaison + super user can change status + scheduled_* fields without
      // touching the submitter's 13 form fields.
      if (action === 'class-submission' && req.query.review === '1') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const rvScope = await reviewerScopeReq(user, req);
        if (!rvScope) {
          return res.status(403).json({ error: 'Reviewer access only. (You are acting as ' + actingEmailFor(user, req) + '.)' });
        }
        const existing = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        if (!scopeAllowsSub(rvScope, existing[0])) {
          return res.status(403).json({ error: 'Your liaison role covers a different age group — this class isn’t yours to schedule. (You are acting as ' + actingEmailFor(user, req) + (rvScope.all ? '' : ' — ' + rvScope.groups.join('/') + ' only') + '.)' });
        }
        if (existing[0].status === 'withdrawn') {
          return res.status(409).json({ error: 'Submission was withdrawn by the submitter; contact them before rescheduling.' });
        }
        let clean;
        try { clean = normalizeReviewerPatch(req.body || {}); }
        catch (validationErr) {
          return res.status(400).json({ error: validationErr.message });
        }
        const updated = await sql`
          UPDATE class_submissions SET
            status = ${clean.status},
            scheduled_session = ${clean.scheduled_session},
            scheduled_hour = ${clean.scheduled_hour},
            scheduled_age_range = ${clean.scheduled_age_range},
            scheduled_room = ${clean.scheduled_room},
            reviewer_notes = ${clean.reviewer_notes},
            reviewed_by_email = ${user.email},
            reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `;
        // PM helpers (Phase B2): when the editor sends a helpers array, replace
        // this class's helper roster. Feeds participation pm_assist.
        let helpersOut;
        if (Array.isArray(req.body.helpers)) {
          await sql`DELETE FROM class_assignment_helpers WHERE class_submission_id = ${id}`;
          const hs = req.body.helpers
            .filter(h => h && (h.name || h.email))
            .map(h => ({ email: String(h.email || '').trim().toLowerCase(), name: String(h.name || '').trim() }));
          for (let i = 0; i < hs.length; i++) {
            await sql`
              INSERT INTO class_assignment_helpers
                (class_submission_id, person_email, person_name, sort_order, updated_by)
              VALUES (${id}, ${hs[i].email}, ${hs[i].name}, ${i}, ${user.email})
            `;
          }
          helpersOut = hs;
        }
        return res.status(200).json({ submission: serializeSubmission(updated[0], helpersOut) });
      }

      // Edit own PM class submission (only while still 'submitted' — once the
      // reviewers draft it, further edits have to go through them).
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const existing = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = existing[0];
        // Acting identity counts as owner too (View-As symmetry, 2026-07-10).
        const edOwnEmails = [user.email.toLowerCase(), actingEmailFor(user, req).toLowerCase()];
        const isOwner = edOwnEmails.indexOf(String(row.submitted_by_email || '').toLowerCase()) !== -1;
        const edScope = await reviewerScopeReq(user, req);
        const isReviewer = !!(edScope && (isOwner || scopeAllowsSub(edScope, row)));
        if (!isOwner && !isReviewer) return res.status(403).json({ error: 'Only the submitter or a reviewer for this class can edit this submission.' });
        // Owners can edit only before the VP/PMA approves (keeps the inbox
        // stable). Reviewers can edit at any status so they can correct
        // details on already-placed classes from the Schedule Builder.
        if (isOwner && !isReviewer && row.status !== 'submitted') {
          return res.status(409).json({ error: 'This submission has already been drafted by the VP/PM Assistant. Contact them to request changes.' });
        }
        let clean;
        try { clean = normalizeSubmission(req.body || {}); }
        catch (validationErr) {
          return res.status(400).json({ error: validationErr.message });
        }
        const updated = await sql`
          UPDATE class_submissions SET
            class_period = ${clean.class_period},
            class_name = ${clean.class_name},
            session_preferences = ${clean.session_preferences},
            hour_preference = ${clean.hour_preference},
            assistant_count = ${clean.assistant_count},
            co_teachers = ${clean.co_teachers},
            space_request = ${clean.space_request},
            space_request_other = ${clean.space_request_other},
            max_students = ${clean.max_students},
            max_students_other = ${clean.max_students_other},
            age_groups = ${clean.age_groups},
            age_groups_other = ${clean.age_groups_other},
            pre_enroll_kids = ${clean.pre_enroll_kids},
            open_to_teen_assistant = ${clean.open_to_teen_assistant},
            prerequisites = ${clean.prerequisites},
            description = ${clean.description},
            other_info = ${clean.other_info},
            school_year = ${clean.school_year},
            updated_at = NOW()
          WHERE id = ${id}
          RETURNING *
        `;
        // Assistants field (2026-07-10): the form sends helpers alongside
        // the 13 columns — replace the roster like the review PATCH does.
        let editHelpers;
        if (Array.isArray(req.body.helpers)) {
          await sql`DELETE FROM class_assignment_helpers WHERE class_submission_id = ${id}`;
          const ehs = req.body.helpers
            .filter(h => h && (h.name || h.email))
            .map(h => ({ email: String(h.email || '').trim().toLowerCase(), name: String(h.name || '').trim() }));
          for (let i = 0; i < ehs.length; i++) {
            await sql`
              INSERT INTO class_assignment_helpers
                (class_submission_id, person_email, person_name, sort_order, updated_by)
              VALUES (${id}, ${ehs[i].email}, ${ehs[i].name}, ${i}, ${user.email})`;
          }
          editHelpers = ehs;
        }
        return res.status(200).json({ submission: serializeSubmission(updated[0], editHelpers) });
      }

      // Reviewer-only: toggle the ⭐ favorite flag on a curriculum. Dedicated
      // action so the main curriculum PATCH stays author-only. VP + PMA +
      // super user gate.
      if (action === 'favorite') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        if (!(await isReviewerReq(user, req))) {
          return res.status(403).json({ error: 'Reviewer access only' });
        }
        const desired = !!(req.body && req.body.is_favorite);
        const updated = await sql`
          UPDATE curricula SET is_favorite = ${desired}, updated_at = NOW()
          WHERE id = ${id}
          RETURNING id, is_favorite
        `;
        if (updated.length === 0) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ id: updated[0].id, is_favorite: updated[0].is_favorite });
      }

      if (!id) return res.status(400).json({ error: 'id query param required' });

      const existing = await sql`SELECT id, author_email, edit_policy FROM curricula WHERE id = ${id}`;
      if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
      if (!canEdit(user, existing[0])) {
        return res.status(403).json({ error: 'Not allowed to edit this plan' });
      }

      const body = req.body || {};
      const title = String(body.title || '').trim().slice(0, 200);
      if (!title) return res.status(400).json({ error: 'title is required' });
      const subject = String(body.subject || '').trim().slice(0, 100);
      const age_range = String(body.age_range || '').trim().slice(0, 50);
      const overview = String(body.overview || '').trim().slice(0, 2000);
      const tags = Array.isArray(body.tags)
        ? body.tags.map(t => String(t || '').trim()).filter(Boolean).slice(0, 20)
        : [];
      const edit_policy = (body.edit_policy === 'open') ? 'open' : 'author_only';
      const lesson_count = Math.max(1, Math.min(5, parseInt(body.lesson_count, 10) || 5));
      const block = normalizeBlock(body.block);

      await sql`
        UPDATE curricula
        SET title = ${title}, subject = ${subject}, age_range = ${age_range},
            overview = ${overview}, tags = ${tags}, edit_policy = ${edit_policy},
            lesson_count = ${lesson_count}, block = ${block}, updated_at = NOW()
        WHERE id = ${id}
      `;
      await replaceLessons(sql, id, lesson_count, Array.isArray(body.lessons) ? body.lessons : []);

      const updated = await getFullCurriculum(sql, id);
      return res.status(200).json({ curriculum: updated });
    }

    // ── DELETE ──
    if (req.method === 'DELETE') {
      // Class Inspiration: remove an idea (Erin, 2026-07-15).
      if (action === 'class-inspiration') {
        const ciDelOk = isSuperUser(user.email) || await hasCapability(user.email, 'class_inspiration_edit');
        if (!ciDelOk) return res.status(403).json({ error: 'Only the VP or Afternoon Class Liaison can edit the inspiration list.' });
        const ciDelId = parseInt(req.query.id, 10);
        if (!Number.isFinite(ciDelId)) return res.status(400).json({ error: 'id required' });
        await sql`DELETE FROM class_inspirations WHERE id = ${ciDelId}`;
        return res.status(200).json({ ok: true });
      }
      // Volunteer sign-ups (2026-07-11): drop your own floater/board/prep
      // pledge, or step out of a class you're assisting.
      if (action === 'volunteer-signup') {
        const dsId = parseInt(req.query.id, 10);
        if (!Number.isFinite(dsId)) return res.status(400).json({ error: 'id required' });
        const dsEmail = actingEmailFor(user, req).toLowerCase();
        const gone = await sql`DELETE FROM volunteer_signups
          WHERE id = ${dsId} AND LOWER(person_email) = ${dsEmail} RETURNING id`;
        if (!gone.length) return res.status(404).json({ error: 'Pledge not found (or not yours).' });
        return res.status(200).json({ ok: true });
      }
      if (action === 'volunteer-assist') {
        const daSubId = parseInt(req.query.id, 10);
        if (!Number.isFinite(daSubId)) return res.status(400).json({ error: 'id required' });
        const daEmail = actingEmailFor(user, req).toLowerCase();
        // Optional hour scope: removing an hour-only assist leaves the
        // other hour's row; no block removes every row for the class.
        const daBlock = String(req.query.block || '').trim();
        const daPeople = await sql`SELECT first_name, last_name FROM people
          WHERE LOWER(email) = ${daEmail} OR LOWER(personal_email) = ${daEmail} LIMIT 1`;
        const daName = daPeople.length ? ((daPeople[0].first_name || '') + ' ' + (daPeople[0].last_name || '')).trim() : (user.name || '');
        const goneH = (['AM1', 'AM2', 'PM1', 'PM2'].indexOf(daBlock) !== -1)
          ? await sql`DELETE FROM class_assignment_helpers
              WHERE class_submission_id = ${daSubId} AND block = ${daBlock}
                AND (LOWER(person_email) = ${daEmail} OR (${daName} <> '' AND LOWER(person_name) = LOWER(${daName})))
              RETURNING id`
          : await sql`DELETE FROM class_assignment_helpers
              WHERE class_submission_id = ${daSubId}
                AND (LOWER(person_email) = ${daEmail} OR (${daName} <> '' AND LOWER(person_name) = LOWER(${daName})))
              RETURNING id`;
        if (!goneH.length) return res.status(404).json({ error: 'You are not on that class’s helper list.' });
        return res.status(200).json({ ok: true });
      }
      // Withdraw own PM class submission. We keep the row (status='withdrawn')
      // rather than hard-delete so the VP/PMA can still see it was there, in
      // case they want to reach out to the submitter.
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        // class_period + age_groups MUST ride along: scopeAllowsSub reads
        // them, and without them every group-scoped liaison's delete
        // denied as "PM/no-group" — even for their own class (2026-07-10).
        const existing = await sql`SELECT submitted_by_email, status, class_period, age_groups FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = existing[0];
        // Owner = the ACTING identity too: a View-As'd submission files
        // under the impersonated member, so they can withdraw it as well.
        const ownEmails = [user.email.toLowerCase(), actingEmailFor(user, req).toLowerCase()];
        const isOwner = ownEmails.indexOf(String(row.submitted_by_email || '').toLowerCase()) !== -1;
        const delScope = await reviewerScopeReq(user, req);
        const isReviewer = !!(delScope && scopeAllowsSub(delScope, row));
        if (!isOwner && !isReviewer) {
          // Name the acting identity — View-As testers kept hitting this
          // when the impersonation had reset between actions (2026-07-10).
          return res.status(403).json({ error: 'Only the submitter or a reviewer for this class can remove this submission. (You are acting as ' + actingEmailFor(user, req) + (delScope && !delScope.all ? ' — ' + delScope.groups.join('/') + ' only' : '') + '.)' });
        }
        if (isReviewer) {
          // Reviewer "Delete Class": hard-delete from the system entirely.
          // Cascades wipe any class_signup_picks referencing this submission.
          await sql`DELETE FROM class_submissions WHERE id = ${id}`;
          return res.status(200).json({ ok: true, id, deleted: true });
        }
        // Owner soft-withdraw — only before VP/PMA places it.
        if (row.status !== 'submitted') {
          return res.status(409).json({ error: 'This submission has already been drafted. Contact the VP to cancel.' });
        }
        await sql`UPDATE class_submissions SET status = 'withdrawn', updated_at = NOW() WHERE id = ${id}`;
        return res.status(200).json({ ok: true, id });
      }

      // Unlink a class-curriculum link
      if (action === 'unlink') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        // Gate (2026-07-17 review): reviewer, or the member who attached it.
        const unlinkActor = actingEmailFor(user, req).toLowerCase();
        const linkRow = await sql`SELECT attached_by FROM class_curriculum_links WHERE id = ${id}`;
        if (!linkRow.length) return res.status(404).json({ error: 'Link not found.' });
        const isUnlinkReviewer = await isReviewerReq(user, req);
        if (!isUnlinkReviewer && String(linkRow[0].attached_by || '').toLowerCase() !== unlinkActor) {
          return res.status(403).json({ error: 'Only the member who attached this plan or a class reviewer can remove it.' });
        }
        await sql`DELETE FROM class_curriculum_links WHERE id = ${id}`;
        return res.status(200).json({ ok: true });
      }
      if (!id) return res.status(400).json({ error: 'id query param required' });
      const existing = await sql`SELECT id, author_email, edit_policy FROM curricula WHERE id = ${id}`;
      if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
      if (!canEdit(user, existing[0])) {
        return res.status(403).json({ error: 'Not allowed to delete this plan' });
      }
      await sql`DELETE FROM curricula WHERE id = ${id}`;
      return res.status(200).json({ ok: true, id: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Curriculum API error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
};
