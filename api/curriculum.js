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
const { Resend } = require('resend');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, getRoleHolderEmail, SUPER_USER_EMAIL } = require('./_permissions');

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
           parent_id, edit_policy, lesson_count, created_at, updated_at
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

  const lessonRows = Array.isArray(body.lessons) ? body.lessons : [];
  const normalizedLessons = [];
  for (let i = 0; i < lesson_count; i++) {
    normalizedLessons.push(normalizeLesson(lessonRows[i], i + 1));
  }

  const inserted = await sql`
    INSERT INTO curricula (title, subject, age_range, overview, tags, author_email, author_name, edit_policy, lesson_count, parent_id)
    VALUES (${title}, ${subject}, ${age_range}, ${overview}, ${tags}, ${user.email}, ${user.name}, ${edit_policy}, ${lesson_count}, ${body.parent_id || null})
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
const AGE_GROUP_VALUES     = ['3-7','7-9','10-12','teens'];

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
  const class_name = String(body.class_name || '').trim().slice(0, 200);
  if (!class_name) throw new Error('Class Name is required.');

  const description = String(body.description || '').trim().slice(0, 3000);
  if (!description) throw new Error('A class description is required.');

  const session_preferences = pickArray(body.session_preferences, SESSION_PREF_VALUES);
  if (session_preferences.length === 0) throw new Error('Pick at least one session preference.');

  const hour_preference = pickArray(body.hour_preference, HOUR_PREF_VALUES);
  if (hour_preference.length === 0) throw new Error('Pick at least one hour preference.');

  const assistant_count = pickArray(body.assistant_count, ASSISTANT_COUNT_VALS, { int: true });
  if (assistant_count.length === 0) throw new Error('Pick how many assistants you would like.');

  const space_request = pickArray(body.space_request, SPACE_REQ_VALUES);
  const space_request_other = String(body.space_request_other || '').trim().slice(0, 300);
  if (space_request.length === 0 && !space_request_other) {
    throw new Error('Pick at least one space request.');
  }

  const age_groups = pickArray(body.age_groups, AGE_GROUP_VALUES);
  const age_groups_other = String(body.age_groups_other || '').trim().slice(0, 200);
  if (age_groups.length === 0 && !age_groups_other) {
    throw new Error('Pick at least one age group.');
  }

  // max_students: 10 / 12 / 15 or a free-text "Other" that parses to a positive int.
  let max_students = parseInt(body.max_students, 10);
  const max_students_other = String(body.max_students_other || '').trim().slice(0, 40);
  if (!Number.isFinite(max_students) || max_students <= 0) {
    max_students = parseInt(max_students_other, 10);
  }
  if (!Number.isFinite(max_students) || max_students <= 0 || max_students > 100) {
    throw new Error('Enter a valid maximum class size.');
  }

  const co_teachers     = String(body.co_teachers || '').trim().slice(0, 500);
  const pre_enroll_kids = String(body.pre_enroll_kids || '').trim().slice(0, 500);
  const prerequisites   = String(body.prerequisites || '').trim().slice(0, 1000);
  const other_info      = String(body.other_info || '').trim().slice(0, 2000);
  const school_year     = String(body.school_year || '2026-2027').trim().slice(0, 20);
  const open_to_teen_assistant = !!body.open_to_teen_assistant;

  return {
    class_name, session_preferences, hour_preference, assistant_count,
    co_teachers, space_request, space_request_other,
    max_students, max_students_other, age_groups, age_groups_other,
    pre_enroll_kids, open_to_teen_assistant, prerequisites, description, other_info, school_year
  };
}

// VP, Afternoon Class Liaison, and the super user can review all submissions.
async function canReviewSubmissions(email) {
  if (!email) return false;
  if (String(email).toLowerCase() === SUPER_USER_EMAIL) return true;
  if (await canEditAsRole(email, 'Vice President')) return true;
  if (await canEditAsRole(email, 'Afternoon Class Liaison')) return true;
  return false;
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
    'first': 'First hour',
    'last': 'Last hour',
    'flexible': 'Either hour',
    '2hr-required': '2 hours (both required)',
    '2hr-optional': '2 hours (one or both)'
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
function prettyAges(a, other) {
  const map = { '3-7': '3–7', '7-9': '7–9', '10-12': '10–12', teens: 'Teens' };
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
    ['Teen assistant OK', sub.open_to_teen_assistant ? 'Yes — open to a Pigeons-age assistant' : 'No'],
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
      subject: `PM Class Submission Received — ${sub.class_name}`,
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
function serializeSubmission(r) {
  return {
    id: r.id,
    submitted_by_email: r.submitted_by_email,
    submitted_by_name: r.submitted_by_name,
    school_year: r.school_year,
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
          if (!(await canReviewSubmissions(user.email))) {
            return res.status(403).json({ error: 'Reviewer access only' });
          }
          const rows = await sql`
            SELECT * FROM class_submissions
            ORDER BY created_at DESC
          `;
          return res.status(200).json({ submissions: rows.map(serializeSubmission) });
        }
        const rows = await sql`
          SELECT * FROM class_submissions
          WHERE LOWER(submitted_by_email) = LOWER(${user.email})
          ORDER BY created_at DESC
        `;
        return res.status(200).json({ submissions: rows.map(serializeSubmission) });
      }

      // Single submission fetch — owner or reviewer can view.
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const rows = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const r = rows[0];
        const isOwner = String(r.submitted_by_email || '').toLowerCase() === user.email.toLowerCase();
        if (!isOwner && !(await canReviewSubmissions(user.email))) {
          return res.status(403).json({ error: 'Not allowed to view this submission' });
        }
        return res.status(200).json({ submission: serializeSubmission(r) });
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

      if (id) {
        const full = await getFullCurriculum(sql, id);
        if (!full) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ curriculum: full });
      }
      // List summaries
      const rows = await sql`
        SELECT id, title, subject, age_range, overview, tags, author_email, author_name,
               edit_policy, lesson_count, updated_at
        FROM curricula
        ORDER BY updated_at DESC
      `;
      return res.status(200).json({ curricula: rows });
    }

    // ── POST create, copy, or link ──
    if (req.method === 'POST') {
      // Create a new PM class submission.
      if (action === 'class-submission') {
        let clean;
        try { clean = normalizeSubmission(req.body || {}); }
        catch (validationErr) {
          return res.status(400).json({ error: validationErr.message });
        }
        const inserted = await sql`
          INSERT INTO class_submissions (
            submitted_by_email, submitted_by_name, school_year,
            class_name, session_preferences, hour_preference, assistant_count,
            co_teachers, space_request, space_request_other,
            max_students, max_students_other, age_groups, age_groups_other,
            pre_enroll_kids, open_to_teen_assistant, prerequisites, description, other_info
          )
          VALUES (
            ${user.email}, ${user.name || ''}, ${clean.school_year},
            ${clean.class_name}, ${clean.session_preferences}, ${clean.hour_preference}, ${clean.assistant_count},
            ${clean.co_teachers}, ${clean.space_request}, ${clean.space_request_other},
            ${clean.max_students}, ${clean.max_students_other}, ${clean.age_groups}, ${clean.age_groups_other},
            ${clean.pre_enroll_kids}, ${clean.open_to_teen_assistant}, ${clean.prerequisites}, ${clean.description}, ${clean.other_info}
          )
          RETURNING *
        `;
        const sub = inserted[0];
        // Fire-and-forget confirmation email (errors logged, not surfaced).
        await sendSubmissionConfirmation(sub);
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
      // Edit own PM class submission (only while still 'submitted' — once the
      // reviewers draft it, further edits have to go through them).
      if (action === 'class-submission') {
        if (!id) return res.status(400).json({ error: 'id query param required' });
        const existing = await sql`SELECT * FROM class_submissions WHERE id = ${id}`;
        if (existing.length === 0) return res.status(404).json({ error: 'Not found' });
        const row = existing[0];
        const isOwner = String(row.submitted_by_email || '').toLowerCase() === user.email.toLowerCase();
        if (!isOwner) return res.status(403).json({ error: 'Only the submitter can edit this submission.' });
        if (row.status !== 'submitted') {
          return res.status(409).json({ error: 'This submission has already been drafted by the VP/PM Assistant. Contact them to request changes.' });
        }
        let clean;
        try { clean = normalizeSubmission(req.body || {}); }
        catch (validationErr) {
          return res.status(400).json({ error: validationErr.message });
        }
        const updated = await sql`
          UPDATE class_submissions SET
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

      await sql`
        UPDATE curricula
        SET title = ${title}, subject = ${subject}, age_range = ${age_range},
            overview = ${overview}, tags = ${tags}, edit_policy = ${edit_policy},
            lesson_count = ${lesson_count}, updated_at = NOW()
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
        if (!isOwner) return res.status(403).json({ error: 'Only the submitter can withdraw this submission.' });
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
