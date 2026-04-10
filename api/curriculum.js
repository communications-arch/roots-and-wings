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
           l.lesson_number
    FROM curriculum_supplies cs
    JOIN lessons l ON l.id = cs.lesson_id
    LEFT JOIN supply_closet sc_id ON sc_id.id = cs.closet_item_id
    LEFT JOIN LATERAL (
      SELECT id, location FROM supply_closet
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
      closet_location: s.closet_location || ''
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

    // ── POST create or copy ──
    if (req.method === 'POST') {
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
