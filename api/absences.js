// Absences API
//
// GET    /api/absences?session=N       → all non-cancelled absences for a session with coverage slots
// GET    /api/absences?from_session=N  → same, for session N and every later one (Coverage Board session pills)
// POST   /api/absences                 → report an absence (creates coverage slots + notifications)
// PATCH  /api/absences?id=N            → add missing coverage slots to an existing absence
//                                        (responsibilities picked after the dates were reported)
// PATCH  /api/absences?id=N {edit:true}→ full in-place edit (#196, Colleen: the old
//                                        DELETE+re-POST edit wiped every claim). Updates the
//                                        absence fields and RECONCILES slots against the sent
//                                        list — matching slots keep their rows (and claims),
//                                        removed ones are deleted, new ones inserted.
// DELETE /api/absences?id=N            → cancel an absence (soft-delete)

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { broadcastAll, sendToUser } = require('./_push');
const { canEditAsRole, BOARD_ROLE_EMAILS, isSuperUser, canImpersonate, activeSchoolYear } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { canActAs } = require('./_family');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

async function verifyGoogleAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await verifyBearer(authHeader.slice(7));
    const payload = ticket.getPayload();
    const email = payload.email || '';
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) return null;
    return { email, name: payload.name || '' };
  } catch (e) { return null; }
}

// View-As wrapper (#171): testers/super users impersonating a family got a
// 403 from the POST ownership gate because this endpoint ignored the
// X-View-As header — the client filed the VIEWED family's email under the
// REAL login. Mirrors verifyWorkspaceAuthWithViewAs in api/tour.js /
// cleaning.js: `email` becomes the viewed identity so ownership checks see
// the family being acted as; `realEmail` is kept for audit stamps.
async function verifyGoogleAuthWithViewAs(req) {
  const real = await verifyGoogleAuth(req);
  if (!real) return null;
  const viewAsRaw = String(req.headers['x-view-as'] || '').trim().toLowerCase();
  if (viewAsRaw && canImpersonate(real.email)) {
    return { email: viewAsRaw, realEmail: real.email, viewedBy: real.email, name: real.name };
  }
  return { email: real.email, realEmail: real.email, name: real.name };
}

// Routed through the 'coverage_admin' capability (defaults to the VP;
// Permissions-table editable) — see api/coverage.js for notes.
function isVP(email) { return hasCapability(email, 'coverage_admin'); }

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

// #198 (Colleen): the morning is TWO volunteer slots — AM1 (10:00–10:55)
// and AM2 (11:00–11:55) — matching My Responsibilities. Legacy 'AM'
// (whole-morning) stays valid so pre-split absences keep working.
const VALID_BLOCKS = ['AM', 'AM1', 'AM2', 'PM1', 'PM2', 'Cleaning'];

// Mark a slot covered by the member the reporter named (#179): resolve the
// name to an email best-effort, stamp the claim, and send them a personal
// heads-up. Returns true when the slot ended up claimed with an email
// (false = name didn't resolve; slot stays open for the board).
async function preassignSlot(sql, user, absence, slotId, role_description, replName) {
  const pr = await sql`
    SELECT email, personal_email FROM people
    WHERE LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = ${replName.toLowerCase()}
    LIMIT 1`;
  const replEmail = pr.length ? String(pr[0].email || pr[0].personal_email || '').toLowerCase() : '';
  await sql`
    UPDATE coverage_slots
    SET claimed_by_email = ${replEmail}, claimed_by_name = ${replName},
        claimed_at = NOW(), assigned_by = ${user.realEmail || user.email}
    WHERE id = ${slotId}`;
  if (!replEmail) return false;
  // absence_date is a string on the POST path, a Date when read from the
  // DB (edit path) — same normalization as notifyCoverageNeeded.
  const rIso = absence.absence_date instanceof Date
    ? absence.absence_date.toISOString().slice(0, 10)
    : String(absence.absence_date || '').slice(0, 10);
  const rDate = new Date(rIso + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const rTitle = 'You’re covering — ' + rDate;
  const rBody = absence.absent_person + ' put you down for: ' + role_description + '. Not able to? Open the Coverage Board to release it.';
  await sql`
    INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
    VALUES (${replEmail}, 'slot_reassigned', ${rTitle}, ${rBody}, '#coverage', ${absence.id})`;
  try { await sendToUser(sql, replEmail, { title: rTitle, body: rBody, tag: 'preassign-' + slotId, url: '/members.html#coverage' }); }
  catch (pushErr) { console.error('preassign push (non-fatal):', pushErr); }
  return true;
}

// #169: bell + push heads-up to the absent family's kids' teachers.
// Morning teacher = the group's scheduled AM class for this session
// (age_groups[0] names the group); afternoon = rank-1 pick teachers.
async function notifyKidTeachers(sql, a) {
  const kids = await sql`
    SELECT first_name, class_group FROM kids
    WHERE LOWER(family_email) = ${a.familyEmail}`;
  if (!kids.length) return;
  const yr = activeSchoolYear();
  const teacherEmails = new Set();
  const groups = kids.map(k => String(k.class_group || '').toLowerCase()).filter(Boolean);
  if (groups.length) {
    const amCls = await sql`
      SELECT submitted_by_email, age_groups FROM class_submissions
      WHERE school_year = ${yr} AND class_period = 'AM'
        AND status = 'scheduled' AND scheduled_session = ${a.sessionNumber}`;
    amCls.forEach(c => {
      const g = String(((c.age_groups || [])[0]) || '').toLowerCase();
      if (groups.indexOf(g) !== -1 && c.submitted_by_email) teacherEmails.add(String(c.submitted_by_email).toLowerCase());
    });
  }
  const pmRows = await sql`
    SELECT DISTINCT c.submitted_by_email
    FROM class_signup_picks p
    JOIN class_submissions c ON c.id = p.class_submission_id
    WHERE p.school_year = ${yr} AND p.session_number = ${a.sessionNumber} AND p.rank = 1
      AND LOWER(p.family_email) = ${a.familyEmail}`;
  pmRows.forEach(r => { if (r.submitted_by_email) teacherEmails.add(String(r.submitted_by_email).toLowerCase()); });
  teacherEmails.delete(a.familyEmail);
  if (!teacherEmails.size) return;
  const dateLabel = new Date(String(a.absenceDate).slice(0, 10) + 'T12:00:00')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const title = 'Student absence — ' + dateLabel;
  const bodyTxt = 'The ' + a.familyName + ' kids (' + kids.map(k => k.first_name).join(', ') + ') will be out on ' + dateLabel + '.';
  for (const em of teacherEmails) {
    await sql`
      INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
      VALUES (${em}, 'kids_absent', ${title}, ${bodyTxt}, '', ${a.absenceId})`;
    try {
      await sendToUser(sql, em, { title, body: bodyTxt, tag: 'kids-absent-' + a.absenceId, url: '/members.html' });
    } catch (pushErr) { console.error('kids-absent push (non-fatal):', pushErr); }
  }
}

// Building Opener / Closer slots may only be covered by a board member
// (Erin, 2026-07-16) — their "Coverage Needed" ping goes to the board,
// not the whole membership. Mirrors BOARD_ONLY_ROLE_TYPES in coverage.js.
const BOARD_ONLY_ROLE_TYPES = ['opener', 'closer'];

// PROD INCIDENT 2026-08-06 (Erin's phantom "Assisting Free Art Club" rows):
// coverage slots are posted BY THE CLIENT, derived from whatever schedule
// its page had painted — and a browser that had cached another database's
// schedule wrote that database's duties into this one, verbatim.
//
// Follow-up (Erin, same night): the server is now the AUTHORITY, not a
// name filter. teacher/assistant slots must match a duty the server
// derives for THIS PERSON from this database (api/_duties.js) — a
// phantom naming a real grove ("Leading Willows") dies here too, which
// pure name-validation could never catch. Cleaning slots must name one
// of this database's areas (or the floater). Support/role duties
// (general, floater, prep, board, opener, closer, supply_closet) carry
// no class reference and pass through, as before the incident.
const { deriveClassDutyKeys, deriveCoverageSlots, norm } = require('./_duties');
const DUTY_EXEMPT_ROLE_TYPES = ['general', 'floater', 'board', 'prep', 'opener', 'closer', 'supply_closet'];
async function knownDutyTargets(sql) {
  // Cleaning areas only — class duties are person-level now.
  const names = new Set();
  const areas = await sql`SELECT area_name FROM cleaning_areas`;
  areas.forEach(r => { const s = String(r.area_name || '').trim().toLowerCase(); if (s) names.add(s); });
  return names;
}
// One validator per request: builds the person's derived duty set once.
// Codebase review 2026-08-08: returns null when duty derivation THROWS (a
// transient DB blip) so callers can fail SAFE — the edit/reconcile paths
// must never interpret "derivation unavailable" as "every class slot is a
// phantom" and delete legitimate, even claimed, coverage. A null validator
// means "skip validation this time", not "reject everything".
async function makeSlotValidator(sql, { schoolYear, session, absentPerson, familyEmail }) {
  const areaNames = await knownDutyTargets(sql);
  let duties = null;
  try {
    duties = await deriveClassDutyKeys(sql, { schoolYear, session, absentPerson, familyEmail });
  } catch (e) {
    console.error('makeSlotValidator derivation failed — validation skipped this request:', e);
    return null;
  }
  return function slotAllowed(slot) {
    const rt = String(slot.role_type || '').trim().toLowerCase();
    if (DUTY_EXEMPT_ROLE_TYPES.indexOf(rt) !== -1) return true;
    const goc = String(slot.group_or_class || '').trim().toLowerCase();
    if (rt === 'cleaning') {
      if (goc === 'floater') return true;
      if (goc && areaNames.has(goc)) return true;
      const desc = String(slot.role_description || '').toLowerCase();
      for (const n of areaNames) { if (n.length >= 4 && desc.indexOf(n) !== -1) return true; }
      return false;
    }
    // teacher / assistant (and anything class-shaped): person-level.
    if (!duties) return false; // derivation failed — refuse rather than trust
    if (duties.has(String(slot.block || '').trim(), rt, goc)) return true;
    if (!goc) {
      // Legacy slots without group_or_class: accept when the description
      // names one of THIS PERSON's derived classes.
      const desc = String(slot.role_description || '').toLowerCase();
      for (const n of duties.classNames) { if (n.length >= 4 && desc.indexOf(n) !== -1) return true; }
    }
    return false;
  };
}

// Current board members' emails: every canonical board mailbox plus the
// holders' personal logins from role_holders_v2 (category 'board', the
// year that actually has data — same MAX() convention as _permissions).
async function boardRecipientEmails(sql) {
  const out = new Set();
  Object.keys(BOARD_ROLE_EMAILS).forEach(t => {
    BOARD_ROLE_EMAILS[t].forEach(e => out.add(String(e).toLowerCase()));
  });
  try {
    const rows = await sql`
      SELECT LOWER(rhv.person_email) AS email
      FROM role_holders_v2 rhv
      JOIN roles r ON r.id = rhv.role_id
      WHERE r.category = 'board' AND rhv.ended_at IS NULL
        AND rhv.school_year = (SELECT MAX(school_year) FROM role_holders_v2)
    `;
    rows.forEach(r => { if (r.email) out.add(r.email); });
  } catch (e) {
    // Mailboxes alone still reach every board role.
    console.error('boardRecipientEmails lookup failed:', e);
  }
  return [...out];
}

// Announce new coverage slots (in-app rows + push). Fired when an
// absence is reported WITH slots, and again when a previously slot-less
// absence gains its first slots via PATCH (the member picked up
// responsibilities after entering their dates). Never fired for
// zero-slot (informational) absences — no coverage needed means no
// notification. Regular slots broadcast to everyone; board-only slots
// (Building Opener/Closer) ping just the board.
async function notifyCoverageNeeded(sql, absence, slots) {
  // absence_date is a plain string on the POST path but a Date object when
  // the row was read from the DB (PATCH path) — String(Date).slice(0,10)
  // gave "Wed Jul 16" → Invalid Date in the notification title (2026-07-17
  // review). Normalize both shapes.
  const iso = absence.absence_date instanceof Date
    ? absence.absence_date.toISOString().slice(0, 10)
    : String(absence.absence_date || '').slice(0, 10);
  const dateLabel = new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const boardSlots = slots.filter(s => BOARD_ONLY_ROLE_TYPES.indexOf(s.role_type) !== -1);
  const regularSlots = slots.filter(s => BOARD_ONLY_ROLE_TYPES.indexOf(s.role_type) === -1);

  if (regularSlots.length > 0) {
    const n = regularSlots.length;
    const notifTitle = 'Coverage Needed — ' + dateLabel;
    const notifBody = absence.absent_person + ' is out. ' + n + ' slot' + (n === 1 ? '' : 's') + ' need' + (n === 1 ? 's' : '') + ' coverage.';
    const allEmails = await sql`
      SELECT DISTINCT user_email FROM push_subscriptions
    `;
    const recipientEmails = new Set(allEmails.map(r => r.user_email));
    recipientEmails.add(absence.family_email);
    for (const email of recipientEmails) {
      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
        VALUES (${email}, 'coverage_needed', ${notifTitle}, ${notifBody}, '#coverage', ${absence.id})
      `;
    }
    try {
      await broadcastAll(sql, {
        title: notifTitle,
        body: notifBody,
        tag: 'coverage-' + absence.id,
        url: '/members.html#coverage'
      });
    } catch (pushErr) {
      console.error('Push broadcast error:', pushErr);
    }
  }

  if (boardSlots.length > 0) {
    const boardTitle = 'Board Coverage Needed — ' + dateLabel;
    const boardBody = absence.absent_person + ' is out. '
      + boardSlots.map(s => s.role_description).join('; ')
      + ' — a board member needs to cover.';
    const boardEmails = await boardRecipientEmails(sql);
    for (const email of boardEmails) {
      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
        VALUES (${email}, 'coverage_needed', ${boardTitle}, ${boardBody}, '#coverage', ${absence.id})
      `;
      try {
        await sendToUser(sql, email, {
          title: boardTitle,
          body: boardBody,
          tag: 'coverage-board-' + absence.id,
          url: '/members.html#coverage'
        });
      } catch (pushErr) {
        console.error('Board coverage push error:', pushErr);
      }
    }
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-View-As');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyGoogleAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = getSql();

    // ── Phantom coverage repair (prod incident 2026-08-06) ──
    // Super-user only. GET ?action=phantom-scan lists every coverage slot
    // whose duty names nothing in THIS database (same rule as the posting
    // guard). POST ?action=phantom-clean deletes the UNCLAIMED phantoms
    // and the ghost coverage_needed notifications of absences left fully
    // phantom-free-and-empty. Exists as an API action because the prod
    // connection string is sensitive-scoped (not pullable) — the repair
    // runs through an authenticated super-user session instead.
    if (req.query.action === 'phantom-scan' || req.query.action === 'phantom-clean') {
      if (!isSuperUser(user.realEmail || user.email)) return res.status(403).json({ error: 'Super user only.' });
      const all = await sql`
        SELECT cs.id, cs.absence_id, cs.block, cs.role_type, cs.role_description, cs.group_or_class,
               cs.claimed_by_email, cs.claimed_by_name,
               a.family_email, a.absent_person, a.absence_date, a.cancelled_at, a.session_number
        FROM coverage_slots cs JOIN absences a ON a.id = cs.absence_id
        ORDER BY cs.absence_id, cs.id`;
      // Person-level scan: one validator per absence (person × session ×
      // YEAR), so a phantom naming a REAL grove ("Leading Willows") is
      // caught when this person doesn't hold that duty. Codebase review
      // 2026-08-08: the school year is derived from EACH absence's own
      // date, not today's — otherwise every prior-year slot validates
      // against this year's (different) schedule and gets flagged phantom,
      // which after the April-1 pivot would delete a whole year of slots.
      const validators = {};
      async function validatorFor(r) {
        const rowYear = activeSchoolYear(new Date(String(r.absence_date).slice(0, 10) + 'T12:00:00'));
        const vKey = rowYear + '|' + norm(r.absent_person) + '|' + norm(r.family_email) + '|' + r.session_number;
        if (!(vKey in validators)) {
          validators[vKey] = await makeSlotValidator(sql, {
            schoolYear: rowYear, session: r.session_number,
            absentPerson: r.absent_person, familyEmail: r.family_email
          });
        }
        return validators[vKey];
      }
      const phantoms = [];
      for (const r of all) {
        const v = await validatorFor(r);
        // A null validator (derivation failed) means "can't judge" — never
        // classify as phantom, never delete. Only a real reject counts.
        if (v && !v(r)) phantoms.push(r);
      }
      const phantomIds = new Set(phantoms.map(r => r.id));
      const claimed = phantoms.filter(r => r.claimed_by_email || r.claimed_by_name);
      const deletable = phantoms.filter(r => !r.claimed_by_email && !r.claimed_by_name);
      if (req.query.action === 'phantom-scan') {
        return res.status(200).json({
          scanned: all.length,
          phantoms: phantoms.map(r => ({
            slot_id: r.id, absence_id: r.absence_id, family_email: r.family_email,
            absent_person: r.absent_person, absence_date: r.absence_date, block: r.block,
            role_type: r.role_type, role_description: r.role_description,
            claimed_by: r.claimed_by_name || null, absence_cancelled: !!r.cancelled_at
          })),
          claimed_count: claimed.length, deletable_count: deletable.length
        });
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const byAbsence = {};
      all.forEach(r => { (byAbsence[r.absence_id] = byAbsence[r.absence_id] || []).push(r); });
      let removedSlots = 0, removedNotifs = 0;
      for (const r of deletable) {
        await sql`DELETE FROM coverage_slots WHERE id = ${r.id}`;
        removedSlots++;
      }
      for (const aid of Object.keys(byAbsence)) {
        const slots = byAbsence[aid];
        const allPhantomUnclaimed = slots.every(r => phantomIds.has(r.id) && !r.claimed_by_email && !r.claimed_by_name);
        if (!allPhantomUnclaimed) continue;
        const gone = await sql`DELETE FROM notifications WHERE type = 'coverage_needed' AND related_absence_id = ${parseInt(aid, 10)} RETURNING id`;
        removedNotifs += gone.length;
      }
      console.error('[absence-guard] phantom-clean by', user.realEmail || user.email, '— slots:', removedSlots, 'notifs:', removedNotifs);
      return res.status(200).json({ ok: true, removed_slots: removedSlots, removed_notifications: removedNotifs, claimed_left: claimed.length });
    }

    // ── GET: list absences for a session (or a session + all later ones) ──
    if (req.method === 'GET') {
      const fromSession = parseInt(req.query.from_session, 10);
      const session = parseInt(req.query.session, 10);
      // upcoming=1: every non-cancelled absence dated today-or-later
      // (server "today" = America/Indianapolis). Session numbers are NOT
      // year-qualified, so around the season boundary a from_session
      // filter can silently drop next-season rows (the Coverage Board
      // vanished mid-test for Erin, 2026-07-19) — dates can't.
      const upcoming = req.query.upcoming === '1' || req.query.upcoming === 'true';
      if (!upcoming && !fromSession && !session) return res.status(400).json({ error: 'session or from_session query param required' });

      const absences = upcoming
        ? await sql`
            SELECT id, family_email, family_name, absent_person, session_number, absence_date,
                   blocks, notes, created_by, created_at,
                   coverage_needed, blc_name, kids_absent, kids_adult
            FROM absences
            WHERE cancelled_at IS NULL
              AND absence_date >= (NOW() AT TIME ZONE 'America/Indianapolis')::date
            ORDER BY session_number, absence_date, absent_person
          `
        : fromSession
        ? await sql`
            SELECT id, family_email, family_name, absent_person, session_number, absence_date,
                   blocks, notes, created_by, created_at,
                   coverage_needed, blc_name, kids_absent, kids_adult
            FROM absences
            WHERE session_number >= ${fromSession} AND cancelled_at IS NULL
            ORDER BY session_number, absence_date, absent_person
          `
        : await sql`
            SELECT id, family_email, family_name, absent_person, session_number, absence_date,
                   blocks, notes, created_by, created_at,
                   coverage_needed, blc_name, kids_absent, kids_adult
            FROM absences
            WHERE session_number = ${session} AND cancelled_at IS NULL
            ORDER BY absence_date, absent_person
          `;
      const absenceIds = absences.map(a => a.id);
      let slots = [];
      if (absenceIds.length > 0) {
        slots = await sql`
          SELECT id, absence_id, block, role_type, role_description, group_or_class,
                 claimed_by_email, claimed_by_name, claimed_at, assigned_by
          FROM coverage_slots
          WHERE absence_id = ANY(${absenceIds})
          ORDER BY id
        `;
      }
      // Attach slots to absences
      const slotsByAbsence = {};
      slots.forEach(s => {
        if (!slotsByAbsence[s.absence_id]) slotsByAbsence[s.absence_id] = [];
        slotsByAbsence[s.absence_id].push(s);
      });
      absences.forEach(a => { a.slots = slotsByAbsence[a.id] || []; });

      return res.status(200).json({ absences });
    }

    // ── POST: report an absence ──
    if (req.method === 'POST') {
      const body = req.body || {};
      const absent_person = String(body.absent_person || '').trim();
      const family_email = String(body.family_email || '').trim();
      const family_name = String(body.family_name || '').trim();
      const session_number = parseInt(body.session_number, 10);
      const absence_date = String(body.absence_date || '').trim();
      const blocks = Array.isArray(body.blocks) ? body.blocks.filter(b => VALID_BLOCKS.includes(b)) : [];
      const notes = String(body.notes || '').trim().slice(0, 500);
      // #169: BLC-covered absences create NO coverage slots (server guard,
      // not just client); kids_absent=true pings the kids' teachers.
      const coverageNeeded = body.coverage_needed !== false;
      const blcName = String(body.blc_name || '').trim().slice(0, 120);
      const kidsAbsent = typeof body.kids_absent === 'boolean' ? body.kids_absent : null;
      const kidsAdult = String(body.kids_adult || '').trim().slice(0, 120);

      if (!absent_person || !family_email || !family_name) {
        return res.status(400).json({ error: 'absent_person, family_email, and family_name required' });
      }
      if (!session_number || !absence_date || blocks.length === 0) {
        return res.status(400).json({ error: 'session_number, absence_date, and blocks required' });
      }
      // Ownership gate (2026-07-17 review): PATCH/DELETE already enforce
      // this, but POST used to accept ANY family_email — letting any member
      // file a fake absence for another family and broadcast-push spoofed
      // content to everyone. Allow: your own family, a family you can act
      // for (co-parent), the coverage admin (VP), or a super user (whose
      // View-As posts the viewed family's email under their own token).
      const canFileFor =
        family_email === user.email
        || isSuperUser(user.email)
        || (await isVP(user.email))
        || (await canActAs(sql, user.email, family_email));
      if (!canFileFor) {
        return res.status(403).json({
          error: 'You can only report an absence for your own family.',
          youAre: (user.viewedBy || user.email)
        });
      }
      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(absence_date)) {
        return res.status(400).json({ error: 'Invalid date format' });
      }
      // Validate it's a Wednesday (co-op day)
      const dateObj = new Date(absence_date + 'T12:00:00');
      if (dateObj.getDay() !== 3) {
        return res.status(400).json({ error: 'absence_date must be a Wednesday' });
      }

      // Insert absence
      const inserted = await sql`
        INSERT INTO absences (family_email, family_name, absent_person, session_number, absence_date, blocks, notes, created_by,
                              coverage_needed, blc_name, kids_absent, kids_adult)
        VALUES (${family_email}, ${family_name}, ${absent_person}, ${session_number}, ${absence_date}, ${blocks}, ${notes}, ${user.realEmail || user.email},
                ${coverageNeeded}, ${coverageNeeded ? '' : blcName}, ${kidsAbsent}, ${kidsAbsent === false ? kidsAdult : ''})
        RETURNING id
      `;
      const absenceId = inserted[0].id;
      // #169: heads-up to the kids' teachers (morning group teacher for
      // this session + afternoon rank-1 pick teachers). Never blocks the
      // absence save.
      if (kidsAbsent === true) {
        try {
          await notifyKidTeachers(sql, {
            familyEmail: family_email.toLowerCase(),
            familyName: family_name,
            sessionNumber: session_number,
            absenceDate: absence_date,
            absenceId
          });
        } catch (ntErr) { console.error('kid-teacher notify (non-fatal):', ntErr); }
      }

      // Insert coverage slots. #179 (Colleen): each slot may carry a
      // pre-picked replacement — that slot is created ALREADY COVERED
      // (claimed by the named member, attributed to the absent family via
      // assigned_by), the replacement gets a personal bell+push, and only
      // the still-open slots go into the Coverage Needed broadcast.
      const createdSlots = [];
      const openSlots = [];
      // #293: the SERVER now DERIVES the authoritative slot set from the DB —
      // the browser no longer decides which duties need covering (the
      // 2026-08-06 phantom incident's root cause: a poisoned cache wrote dev
      // duties into prod). The client's `body.slots` is consulted ONLY for
      // optional per-slot pre-picked replacements (#179), matched to the
      // generated slots by (block|role_type|group_or_class). Fail-safe: if
      // derivation throws, we insert nothing rather than trust the client.
      let generatedSlots = [];
      if (coverageNeeded) {
        // #293 review F3: with the client reconciler retired, a transient
        // derive failure at POST would otherwise leave the absence permanently
        // slot-less (no backfill net). One retry covers a momentary DB blip.
        const deriveOnce = () => deriveCoverageSlots(sql, {
          // #293 review M5: year from the ABSENCE date, not "now" (April-1
          // pivot: an absence for last year's session reported after the
          // rollover would otherwise derive against the wrong year).
          schoolYear: activeSchoolYear(new Date(absence_date + 'T12:00:00')),
          session: session_number,
          absentPerson: absent_person, familyEmail: family_email, blocks
        });
        try {
          try { generatedSlots = await deriveOnce(); }
          catch (firstErr) { console.error('[absence] deriveCoverageSlots retry after:', firstErr); generatedSlots = await deriveOnce(); }
        } catch (derErr) {
          console.error('[absence] deriveCoverageSlots failed — no slots created:', derErr);
          generatedSlots = [];
        }
      }
      const slotKey = s => String(s.block || '') + '|' + String(s.role_type || '') + '|' + norm(String(s.group_or_class || ''));
      const replByKey = {};
      (Array.isArray(body.slots) ? body.slots : []).forEach(s => {
        const rn = String(s.replacement_name || '').trim();
        if (rn) replByKey[slotKey(s)] = rn.slice(0, 120);
      });
      for (const slot of generatedSlots) {
        if (!VALID_BLOCKS.includes(slot.block)) continue;
        const ins = await sql`
          INSERT INTO coverage_slots (absence_id, block, role_type, role_description, group_or_class)
          VALUES (${absenceId}, ${slot.block}, ${slot.role_type}, ${slot.role_description}, ${slot.group_or_class})
          RETURNING id
        `;
        const slotRow = { block: slot.block, role_type: slot.role_type, role_description: slot.role_description };
        createdSlots.push(slotRow);
        const replName = replByKey[slotKey(slot)] || '';
        if (!replName) { openSlots.push(slotRow); continue; }
        try {
          await preassignSlot(sql, user,
            { id: absenceId, absence_date, absent_person },
            ins[0].id, slot.role_description, replName);
        } catch (replErr) {
          // Name didn't resolve or the update failed — slot stays open.
          console.error('replacement pre-assign (non-fatal):', replErr);
          openSlots.push(slotRow);
        }
      }

      // Notify members — but only about slots actually needing coverage.
      // A zero-slot absence (no session duties on file) is informational;
      // if duties appear later, PATCH below fires the notification then.
      if (openSlots.length > 0) {
        await notifyCoverageNeeded(sql, { id: absenceId, absence_date, absent_person, family_email }, openSlots);
      }

      // Return the full absence with slots
      const full = await sql`SELECT * FROM absences WHERE id = ${absenceId}`;
      const fullSlots = await sql`SELECT * FROM coverage_slots WHERE absence_id = ${absenceId} ORDER BY id`;
      const result = full[0];
      result.slots = fullSlots;
      return res.status(201).json({ absence: result });
    }

    // ── PATCH: add missing coverage slots to an existing absence ──
    // Used when a member reported dates BEFORE picking responsibilities:
    // once responsibilities exist for that session, the client diffs them
    // against the absence's slots and sends the missing ones here. Only
    // ever adds — existing slots (claimed or not) are never touched.
    if (req.method === 'PATCH') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });
      const body = req.body || {};
      const isEdit = body.edit === true;
      const slotsData = Array.isArray(body.slots) ? body.slots : [];
      if (!isEdit && slotsData.length === 0) return res.status(400).json({ error: 'slots required' });

      const rows = await sql`
        SELECT id, family_email, family_name, absent_person, session_number, absence_date,
               blocks, notes, created_by, coverage_needed, blc_name, kids_absent, kids_adult
        FROM absences WHERE id = ${id} AND cancelled_at IS NULL
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Absence not found' });
      const absence = rows[0];

      // Same ownership rule as DELETE: creator, the absence's family
      // (primary or co-parent), or the coverage admin.
      const isOwner = absence.created_by === user.email
        || absence.created_by === (user.realEmail || user.email)
        || absence.family_email === user.email
        || (await canActAs(sql, user.email, absence.family_email));
      if (!isOwner && !(await isVP(user.email))) {
        return res.status(403).json({ error: 'Not authorized to update this absence' });
      }

      // ── Full edit (#196) ──
      if (isEdit) {
        const absent_person = String(body.absent_person || absence.absent_person).trim();
        const session_number = parseInt(body.session_number, 10) || absence.session_number;
        const absence_date = String(body.absence_date || '').trim();
        const blocks = Array.isArray(body.blocks) ? body.blocks.filter(b => VALID_BLOCKS.includes(b)) : [];
        const notes = String(body.notes || '').trim().slice(0, 500);
        const coverageNeeded = body.coverage_needed !== false;
        const blcName = String(body.blc_name || '').trim().slice(0, 120);
        const kidsAbsent = typeof body.kids_absent === 'boolean' ? body.kids_absent : null;
        const kidsAdult = String(body.kids_adult || '').trim().slice(0, 120);
        if (!absence_date || blocks.length === 0) {
          return res.status(400).json({ error: 'absence_date and blocks required' });
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(absence_date)) {
          return res.status(400).json({ error: 'Invalid date format' });
        }
        if (new Date(absence_date + 'T12:00:00').getDay() !== 3) {
          return res.status(400).json({ error: 'absence_date must be a Wednesday' });
        }

        await sql`
          UPDATE absences
          SET absent_person = ${absent_person}, session_number = ${session_number},
              absence_date = ${absence_date}, blocks = ${blocks}, notes = ${notes},
              coverage_needed = ${coverageNeeded}, blc_name = ${coverageNeeded ? '' : blcName},
              kids_absent = ${kidsAbsent}, kids_adult = ${kidsAbsent === false ? kidsAdult : ''}
          WHERE id = ${id}
        `;

        // Kids' teachers hear about it when the answer FLIPS to yes —
        // an unchanged yes was already announced at POST time.
        if (kidsAbsent === true && absence.kids_absent !== true) {
          try {
            await notifyKidTeachers(sql, {
              familyEmail: String(absence.family_email || '').toLowerCase(),
              familyName: absence.family_name,
              sessionNumber: session_number,
              absenceDate: absence_date,
              absenceId: id
            });
          } catch (ntErr) { console.error('kid-teacher notify (non-fatal):', ntErr); }
        }

        const existingSlots = await sql`
          SELECT id, block, role_type, role_description, group_or_class, claimed_by_email, claimed_by_name
          FROM coverage_slots WHERE absence_id = ${id} ORDER BY id
        `;

        // No coverage needed → this absence carries no slots at all, and
        // any Coverage-Needed bells for it are stale.
        if (!coverageNeeded) {
          for (const s of existingSlots) {
            if (s.claimed_by_email) {
              try {
                await sql`
                  INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
                  VALUES (${s.claimed_by_email}, 'slot_reassigned', 'Coverage no longer needed',
                          ${absent_person + ' updated their absence — you no longer need to cover: ' + s.role_description},
                          '#coverage', ${id})`;
              } catch (nErr) { console.error('release notify (non-fatal):', nErr); }
            }
          }
          await sql`DELETE FROM coverage_slots WHERE absence_id = ${id}`;
          await sql`DELETE FROM notifications WHERE type = 'coverage_needed' AND related_absence_id = ${id}`;
          const noneLeft = await sql`SELECT * FROM absences WHERE id = ${id}`;
          const outAbs0 = noneLeft[0]; outAbs0.slots = [];
          return res.status(200).json({ ok: true, id, absence: outAbs0 });
        }

        // #293: the SERVER derives the authoritative slot set on EDIT too, so
        // report and edit stay consistent. Existing rows are matched by
        // IDENTITY (block|role_type|group_or_class) — NOT description — so a
        // member's CLAIM survives even though the server's descriptions differ
        // from any older client-created ones. body.slots is consulted only for
        // optional replacements (#179). Fail-safe: if derivation throws, we
        // leave the existing slots (and their claims) untouched.
        let editGenerated = [];
        try {
          editGenerated = await deriveCoverageSlots(sql, {
            schoolYear: activeSchoolYear(new Date(absence_date + 'T12:00:00')),
            session: session_number, absentPerson: absent_person,
            familyEmail: absence.family_email, blocks
          });
        } catch (derErr) {
          console.error('[absence] edit deriveCoverageSlots failed — slots left as-is:', derErr);
          const keepAbs = await sql`SELECT * FROM absences WHERE id = ${id}`;
          const keepSlots = await sql`SELECT * FROM coverage_slots WHERE absence_id = ${id} ORDER BY id`;
          const outKeep = keepAbs[0]; outKeep.slots = keepSlots;
          return res.status(200).json({ ok: true, id, absence: outKeep, derive_failed: true });
        }
        const identityKey = s => String(s.block || '') + '|' + String(s.role_type || '') + '|' + norm(String(s.group_or_class || ''));
        const editReplByKey = {};
        (Array.isArray(body.slots) ? body.slots : []).forEach(s => {
          const rn = String(s.replacement_name || '').trim();
          if (rn) editReplByKey[identityKey(s)] = rn.slice(0, 120);
        });
        const unmatched = existingSlots.slice();
        function takeMatch(gen) {
          const k = identityKey(gen);
          let idx = unmatched.findIndex(s => identityKey(s) === k);
          // #293 review F1: a generated AM1/AM2 slot also matches a legacy
          // whole-morning 'AM' row (same role_type + group_or_class), so a
          // CLAIM stored on the old 'AM' row survives the split to hour blocks.
          if (idx === -1 && (gen.block === 'AM1' || gen.block === 'AM2')) {
            const legacyK = 'AM|' + String(gen.role_type || '') + '|' + norm(String(gen.group_or_class || ''));
            idx = unmatched.findIndex(s => identityKey(s) === legacyK);
          }
          return idx === -1 ? null : unmatched.splice(idx, 1)[0];
        }
        const openNew = [];
        for (const gen of editGenerated) {
          if (!VALID_BLOCKS.includes(gen.block)) continue;
          const replName = editReplByKey[identityKey(gen)] || '';
          const match = takeMatch(gen);
          if (match) {
            // Refresh block/description to the derived values (identity is same).
            if (match.block !== gen.block || match.role_description !== gen.role_description) {
              await sql`UPDATE coverage_slots SET block = ${gen.block}, role_description = ${gen.role_description} WHERE id = ${match.id}`;
            }
            if (match.claimed_by_email || match.claimed_by_name) {
              // Claim survives (this is still a real duty); only a NEW, different
              // pre-picked replacement reassigns it — never auto-release.
              if (replName && replName !== match.claimed_by_name) {
                try { await preassignSlot(sql, user, { id, absence_date, absent_person }, match.id, gen.role_description, replName); }
                catch (replErr) { console.error('edit reassign (non-fatal):', replErr); }
              }
            } else if (replName) {
              try { await preassignSlot(sql, user, { id, absence_date, absent_person }, match.id, gen.role_description, replName); }
              catch (replErr) { console.error('edit preassign (non-fatal):', replErr); }
            }
          } else {
            const ins = await sql`
              INSERT INTO coverage_slots (absence_id, block, role_type, role_description, group_or_class)
              VALUES (${id}, ${gen.block}, ${gen.role_type}, ${gen.role_description}, ${gen.group_or_class})
              RETURNING id
            `;
            if (replName) {
              try { await preassignSlot(sql, user, { id, absence_date, absent_person }, ins[0].id, gen.role_description, replName); }
              catch (replErr) { console.error('edit preassign (non-fatal):', replErr); openNew.push({ block: gen.block, role_type: gen.role_type, role_description: gen.role_description }); }
            } else {
              openNew.push({ block: gen.block, role_type: gen.role_type, role_description: gen.role_description });
            }
          }
        }
        // Prune slots the edit no longer covers — but #293 review F1: NEVER
        // delete a CLAIMED slot here. A member's commitment must survive an
        // edit/re-derive even if the duty's identity drifted (a class rename
        // or schedule shift shouldn't silently release someone who stepped up,
        // as the prior incident did). Only OPEN unmatched slots are pruned;
        // a genuinely stale claimed slot can be cleared by the VP by hand.
        for (const s of unmatched) {
          if (s.claimed_by_email || s.claimed_by_name) continue;
          await sql`DELETE FROM coverage_slots WHERE id = ${s.id}`;
        }
        // Broadcast only when a previously silent absence first gains open
        // slots — same rule as the add-slots path below.
        if (existingSlots.length === 0 && openNew.length > 0) {
          await notifyCoverageNeeded(sql, { id, absence_date, absent_person, family_email: absence.family_email }, openNew);
        }
        const fullAbs = await sql`SELECT * FROM absences WHERE id = ${id}`;
        const outSlots = await sql`SELECT * FROM coverage_slots WHERE absence_id = ${id} ORDER BY id`;
        const outAbs = fullAbs[0]; outAbs.slots = outSlots;
        return res.status(200).json({ ok: true, id, absence: outAbs });
      }

      // ── Add-missing-slots (client reconciler) — RETIRED (#293) ──
      // The server now derives coverage slots on report (POST) and edit; the
      // client `syncMyAbsenceSlots` reconciler that drove this path is disabled.
      // This branch used client-proposed slots and the "now" school year (the
      // pre-#293 M5 bug), so it must not run. A stray call (e.g. a stale cached
      // client mid-migration) gets a benign no-op — `added: 0` stops the old
      // reconciler's re-render loop without writing anything.
      const noOpSlots = await sql`SELECT * FROM coverage_slots WHERE absence_id = ${id} ORDER BY id`;
      return res.status(200).json({ ok: true, id, added: 0, slots: noOpSlots, retired: true });
    }

    // ── DELETE: cancel an absence ──
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const existing = await sql`SELECT id, created_by, family_email FROM absences WHERE id = ${id} AND cancelled_at IS NULL`;
      if (existing.length === 0) return res.status(404).json({ error: 'Absence not found' });

      // Only original creator, the family the absence belongs to (primary or
      // co-parent via additional_emails), or VP can cancel.
      const isOwner = existing[0].created_by === user.email
        || existing[0].created_by === (user.realEmail || user.email)
        || existing[0].family_email === user.email
        || (await canActAs(sql, user.email, existing[0].family_email));
      if (!isOwner && !(await isVP(user.email))) {
        return res.status(403).json({ error: 'Not authorized to cancel this absence' });
      }

      await sql`UPDATE absences SET cancelled_at = NOW() WHERE id = ${id}`;
      // A cancelled absence needs no coverage — retract its "Coverage
      // Needed" rows so members' bells don't keep a stale ask (Erin,
      // 2026-07-16: two lingered on prod after cancellations).
      await sql`
        DELETE FROM notifications
        WHERE type = 'coverage_needed' AND related_absence_id = ${id}
      `;
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Absences API error:', err);
    if (err.message && err.message.includes('unique')) {
      return res.status(409).json({ error: 'An absence already exists for this person on this date' });
    }
    return res.status(500).json({ error: 'Server error' });
  }
};
