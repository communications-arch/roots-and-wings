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
const { canEditAsRole, getRoleHolderEmail, isSuperUser, activeSchoolYear, canImpersonate } = require('./_permissions');
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
  // Delete existing lessons (cascades to supplies), then re-insert.
  await sql`DELETE FROM lessons WHERE curriculum_id = ${curriculumId}`;
  for (let i = 0; i < lessonCount; i++) {
    const ls = normalizeLesson(lessonRows[i], i + 1);
    const lessonResult = await sql`
      INSERT INTO lessons (curriculum_id, lesson_number, title, overview, room_setup, activity, instruction, links)
      VALUES (${curriculumId}, ${ls.lesson_number}, ${ls.title}, ${ls.overview}, ${ls.room_setup}, ${ls.activity}, ${ls.instruction}, ${JSON.stringify(ls.links)})
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
  if (await canEditAsRole(email, 'Vice President')) return { all: true };
  if (await canEditAsRole(email, 'Afternoon Class Liaison')) return { all: true };
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

// View-As aware reviewer gate. True when the real caller is a reviewer
// (super / VP / Afternoon Class Liaison), OR they can impersonate (super on
// prod; any signed-in @rootsandwingsindy.com on dev/preview) AND are
// viewing-as an email that is itself a reviewer. Lets testers exercise the
// reviewer flows via View-As; no prod behavior change (real reviewers and
// super users already pass the first check). view_as comes from the query
// (GET) or body (POST), matching resolveSubmitterEmail's mechanism.
async function reviewerScopeReq(user, req) {
  const realEmail = user && user.email;
  const s = await reviewerScope(realEmail);
  if (s) return s;
  if (!canImpersonate(realEmail)) return null;
  const va = String((req.query && req.query.view_as) || (req.body && req.body.view_as) || '').trim().toLowerCase();
  if (!va || (va.split('@')[1] || '') !== ALLOWED_DOMAIN) return null;
  return await reviewerScope(va);
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
function prettyHourPrefs(a) {
  const map = {
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
  const pmEmail = await getPmAssistantEmail();

  const cc = ['vicepresident@rootsandwingsindy.com'];
  if (pmEmail && pmEmail.toLowerCase() !== sub.submitted_by_email.toLowerCase()) {
    cc.push(pmEmail);
  }

  const rows = [
    ['Class name',       escapeHtml(sub.class_name)],
    ['Sessions',         escapeHtml(prettySessionPrefs(sub.session_preferences))],
    ['Hour preference',  escapeHtml(prettyHourPrefs(sub.hour_preference))],
    ['Assistants',       escapeHtml(sub.assistant_count.join(' or ') + ' helper(s)')],
    ['Co-teachers',      escapeHtml(sub.co_teachers || '—')],
    ['Space request',    escapeHtml(prettySpace(sub.space_request, sub.space_request_other))],
    ['Max students',     escapeHtml(String(sub.max_students))],
    ['Age groups',       escapeHtml(prettyAges(sub.age_groups, sub.age_groups_other))],
    ['Teen assistant OK', sub.open_to_teen_assistant ? 'Yes — willing to host a Cedars or Pigeons (12+) assistant' : 'No'],
    ['Prerequisites',    escapeHtml(sub.prerequisites || '—')]
  ];
  const rowsHtml = rows.map(
    ([k, v]) => `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;vertical-align:top;">${k}</td><td>${v}</td></tr>`
  ).join('');

  try {
    await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: sub.submitted_by_email,
      cc,
      replyTo: 'vicepresident@rootsandwingsindy.com',
      subject: emailSubject(`PM Class Submission Received — ${sub.class_name}`),
      html: `
        <h2>Thanks for submitting a PM class!</h2>
        <p>Your submission has been logged. The VP and Afternoon Class Liaison have been copied on this email and will reach out when they're planning the next session.</p>
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
          const rscope = await reviewerScopeReq(user, req);
          if (!rscope) {
            return res.status(403).json({ error: 'Reviewer access only' });
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
            is_reviewer: true,
            // 'all' for VP/ACL/super; a lowercase group list for scoped
            // age-group liaisons — the builder greys out everything else.
            reviewer_scope: rscope.all ? 'all' : rscope.groups
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
          sql`SELECT id, class_period, class_name, description,
                     submitted_by_name, submitted_by_email, co_teachers,
                     age_groups, age_groups_other, max_students,
                     scheduled_session, scheduled_hour, scheduled_age_range, scheduled_room
              FROM class_submissions
              WHERE status = 'scheduled' AND school_year = ${year}
                AND scheduled_session IS NOT NULL`,
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
          approved[r.session_number] = { am: !!r.am_approved_at, pm: !!r.approved_at };
        });
        const sessions = {};
        function bucketFor(n) {
          return sessions[n] || (sessions[n] = { am: null, pm: null });
        }
        classRows.forEach(r => {
          const ap = approved[r.scheduled_session];
          const isAM = r.class_period === 'AM';
          if (!ap || (isAM ? !ap.am : !ap.pm)) return; // period not approved yet
          const bucket = bucketFor(r.scheduled_session);
          const list = isAM ? (bucket.am || (bucket.am = [])) : (bucket.pm || (bucket.pm = []));
          list.push({
            id: r.id,
            class_period: r.class_period,
            class_name: r.class_name,
            description: r.description || '',
            teacher: r.submitted_by_name || r.submitted_by_email || '',
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
          if (!r.am_approved_at && !r.approved_at) return;
          const bucket = bucketFor(r.session_number);
          if (r.am_approved_at && !bucket.am) bucket.am = [];
          if (r.approved_at && !bucket.pm) bucket.pm = [];
        });
        return res.status(200).json({ school_year: year, sessions });
      }

      // Single submission fetch — owner or reviewer can view.
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const rows = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const r = rows[0];
        const isOwner = String(r.submitted_by_email || '').toLowerCase() === user.email.toLowerCase();
        if (!isOwner && !(await isReviewerReq(user, req))) {
          return res.status(403).json({ error: 'Not allowed to view this submission' });
        }
        return res.status(200).json({ submission: serializeSubmission(r) });
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
                 submitted_by_name, max_students
          FROM class_submissions
          WHERE status = 'scheduled' AND school_year = ${sy} AND scheduled_session = ${session}
            AND class_period = 'PM'
          ORDER BY class_name
        `;
        const ser = (r) => ({
          id: r.id, name: r.class_name, hour: r.scheduled_hour,
          ageRange: r.scheduled_age_range || '', room: r.scheduled_room || '',
          leader: r.submitted_by_name || '', max: r.max_students || 0
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
        const picks = {};
        if (fam && fam.family_email) {
          const kidRows = await sql`
            SELECT first_name, birth_date FROM kids
            WHERE LOWER(family_email) = LOWER(${fam.family_email})
            ORDER BY sort_order, first_name
          `;
          kids = kidRows.map(k => k.first_name).filter(Boolean);
          // Current age per kid so the parent card can flag age-appropriate
          // classes. Keyed by first name (same key as picks/working).
          kidRows.forEach(k => {
            const age = ageFromBirthDate(k.birth_date);
            if (k.first_name && age != null) kidAges[k.first_name] = age;
          });
          const pickRows = await sql`
            SELECT kid_first_name, hour, class_submission_id
            FROM class_signup_picks
            WHERE school_year = ${sy} AND session_number = ${session}
              AND LOWER(family_email) = LOWER(${fam.family_email})
            ORDER BY kid_first_name, hour, rank
          `;
          pickRows.forEach(p => {
            if (!picks[p.kid_first_name]) picks[p.kid_first_name] = { PM1: [], PM2: [] };
            (picks[p.kid_first_name][p.hour] || (picks[p.kid_first_name][p.hour] = [])).push(p.class_submission_id);
          });
        }
        return res.status(200).json({
          school_year: sy, session,
          window: winRows[0] || { status: null },
          classes, kids, kidAges, picks,
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
        // Fire-and-forget confirmation email (errors logged, not surfaced).
        // Name-only on-behalf rows skip it — it would just email the liaison
        // about her own entry; a real member still gets their confirmation.
        const nameOnlyBehalf = !!behalfName && (!behalfEmail || (behalfEmail.split('@')[1] || '') !== ALLOWED_DOMAIN);
        if (!nameOnlyBehalf) await sendSubmissionConfirmation(sub);
        return res.status(201).json({ submission: serializeSubmission(sub) });
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
        // Upsert — replace existing link for this class+session
        await sql`DELETE FROM class_curriculum_links WHERE session_number = ${session_number} AND class_key = ${class_key}`;
        const inserted = await sql`
          INSERT INTO class_curriculum_links (session_number, class_key, curriculum_id, attached_by)
          VALUES (${session_number}, ${class_key}, ${curriculum_id}, ${user.email})
          RETURNING id, session_number, class_key, curriculum_id, attached_by, attached_at
        `;
        return res.status(201).json({ link: inserted[0] });
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
        if (wstatus === 'locked') return res.status(409).json({ error: 'Sign-ups are locked for this session.' });
        if (wstatus !== 'open' && !isReviewer) return res.status(409).json({ error: 'Sign-ups are not open right now.' });

        const effEmail = resolveSubmitterEmail(user, body.view_as);
        const fam = await resolveFamily(sql, effEmail);
        if (!fam || !fam.family_email) return res.status(403).json({ error: 'No family found for your account.' });
        const familyEmail = fam.family_email;
        if (!isReviewer && !isSuperUser(user.email)) {
          if (!(await canActAs(sql, user.email, familyEmail))) {
            return res.status(403).json({ error: 'Not allowed to edit this family.' });
          }
        }
        const kidOk = await sql`
          SELECT 1 FROM kids WHERE LOWER(family_email) = LOWER(${familyEmail})
            AND LOWER(first_name) = LOWER(${kidFirst}) LIMIT 1
        `;
        if (kidOk.length === 0) return res.status(400).json({ error: 'That child is not in your family.' });

        // Keep only ids that are scheduled classes valid for this hour, in the
        // submitted rank order, de-duplicated.
        let validRows = [];
        if (ranked.length) {
          validRows = await sql`
            SELECT id, scheduled_hour FROM class_submissions
            WHERE status='scheduled' AND school_year=${sy} AND scheduled_session=${session}
              AND class_period = 'PM'
              AND id = ANY(${ranked}::int[])
          `;
        }
        const hourById = {};
        validRows.forEach(r => { hourById[r.id] = r.scheduled_hour; });
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

        await sql`
          DELETE FROM class_signup_picks
          WHERE school_year=${sy} AND session_number=${session}
            AND LOWER(family_email)=LOWER(${familyEmail})
            AND LOWER(kid_first_name)=LOWER(${kidFirst}) AND hour=${hour}
        `;
        for (let i = 0; i < cleanIds.length; i++) {
          await sql`
            INSERT INTO class_signup_picks
              (school_year, session_number, family_email, kid_first_name, hour, rank, class_submission_id, created_by_email)
            VALUES (${sy}, ${session}, ${familyEmail}, ${kidFirst}, ${hour}, ${i + 1}, ${cleanIds[i]}, ${user.email})
          `;
        }
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
          return res.status(403).json({ error: 'Reviewer access only' });
        }
        const existing = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        if (!scopeAllowsSub(rvScope, existing[0])) {
          return res.status(403).json({ error: 'Your liaison role covers a different age group — this class isn’t yours to schedule.' });
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
        const isOwner = String(row.submitted_by_email || '').toLowerCase() === user.email.toLowerCase();
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
        return res.status(200).json({ submission: serializeSubmission(updated[0]) });
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
      // Withdraw own PM class submission. We keep the row (status='withdrawn')
      // rather than hard-delete so the VP/PMA can still see it was there, in
      // case they want to reach out to the submitter.
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const existing = await sql`SELECT submitted_by_email, status FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = existing[0];
        const isOwner = String(row.submitted_by_email || '').toLowerCase() === user.email.toLowerCase();
        const delScope = await reviewerScopeReq(user, req);
        const isReviewer = !!(delScope && scopeAllowsSub(delScope, row));
        if (!isOwner && !isReviewer) return res.status(403).json({ error: 'Only the submitter or a reviewer for this class can remove this submission.' });
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
