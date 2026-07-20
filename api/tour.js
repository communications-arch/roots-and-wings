// Public intake endpoint.
// Handles two kinds of submissions, distinguished by body.kind:
//   - 'tour'         : forwards a tour request via Resend (default, legacy)
//   - 'registration' : saves a completed, paid registration (requires paypal_transaction_id)
// Also supports:
//   - GET ?list=registrations  — Workspace-authed list for membership coordinators
//   - GET ?config=1            — public config (e.g., Google Maps key) for the register page

const crypto = require('crypto');
const { Resend } = require('./_resend');
const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { put } = require('@vercel/blob');
const { waitUntil } = require('@vercel/functions');
const { ALLOWED_ORIGINS, emailSubject, WAIVER_VERSION } = require('./_config');
const { getRoleHolderEmail, isSuperUser, canImpersonate, activeSchoolYear, isBoardMember } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { canActAs } = require('./_family');
const { fetchSheet, getAuth, parseBillingSheet, firstSeasonByEmail, seasonToYearLabel } = require('./sheets');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

const REGISTRATION_FEE = 40;
const DEFAULT_SEASON = '2026-2027';
const VALID_TRACKS = ['Morning Only', 'Afternoon Only', 'Both', 'Other'];

// "Today" as YYYY-MM-DD in America/Indianapolis. The waiver/registration
// sign date is stamped server-side from this (the forms no longer collect
// a date field), so a signer can't enter a stray date. en-CA → YYYY-MM-DD.
function indySignDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Session calendar — DEFENSIVE FALLBACK only. Phase B moved the source
// of truth to the co_op_sessions DB table (managed by President + VP
// via the Co-op Calendar workspace modal). loadSessionDatesFromDb()
// below queries that table at request time; this static block is the
// last-resort fallback if the DB query fails, so the public tour form
// never silently breaks on a transient outage.
const SESSION_DATES_FALLBACK = {
  1: { name: 'Fall Session 1',   start: '2025-09-03', end: '2025-10-01' },
  2: { name: 'Fall Session 2',   start: '2025-10-15', end: '2025-11-12' },
  3: { name: 'Winter Session 3', start: '2026-01-14', end: '2026-02-11' },
  4: { name: 'Spring Session 4', start: '2026-03-04', end: '2026-04-01' },
  5: { name: 'Spring Session 5', start: '2026-04-15', end: '2026-05-13' }
};

// ──────────────────────────────────────────────
// Merchandise catalog — keyed by item slug. Used to validate POST bodies
// against known item / size / color combinations so the public order
// form can't be tricked into recording garbage in merch_orders.
// Source of truth on prices is also here so the report can show a
// running total if we ever want to. Sizes/colors arrays are exhaustive
// — an empty array means the variant doesn't apply to that item.
// ──────────────────────────────────────────────
const MERCH_CATALOG = {
  tshirt: {
    label: 'T-Shirt',
    sizes: [
      'Toddler 2T', 'Toddler 3T', 'Toddler 4T', 'Toddler 5T',
      'Kids XS', 'Kids S', 'Kids M', 'Kids L', 'Kids XL',
      'Adult S', 'Adult M', 'Adult L', 'Adult XL', 'Adult XXL'
    ],
    colors: ['Purple', 'Olive', 'Lime', 'Teal']
  },
  mug:     { label: 'Campfire Coffee Mug', sizes: [], colors: [] },
  tumbler: { label: 'Stainless Tumbler',   sizes: [], colors: [] },
  pin:     { label: 'Enamel Pin',          sizes: [], colors: [] },
  patch:   { label: 'Woven Patch',         sizes: [], colors: [] },
  tote:    {
    label: 'Block-Printed Tote',
    sizes: ['Small', 'Large'],
    colors: ['Black', 'Brown', 'Purple']
  }
};

// Validate an order body against the catalog. Returns null on success
// or an error string suitable for a 400 response.
function validateMerchOrder(body) {
  const item = String(body.item || '').toLowerCase().trim();
  if (!MERCH_CATALOG[item]) return 'Unknown item.';
  const def = MERCH_CATALOG[item];
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();
  if (def.sizes.length > 0 && def.sizes.indexOf(size) === -1) {
    return 'Pick a size for ' + def.label + '.';
  }
  if (def.sizes.length === 0 && size) return 'Size does not apply to ' + def.label + '.';
  if (def.colors.length > 0 && def.colors.indexOf(color) === -1) {
    return 'Pick a color for ' + def.label + '.';
  }
  if (def.colors.length === 0 && color) return 'Color does not apply to ' + def.label + '.';
  return null;
}

// Pull every session row from co_op_sessions, group by school_year, and
// pick the year that best represents "current" (matches the client's
// picker logic in applyCoopSessionsData). Returns an object shaped like
// SESSION_DATES_FALLBACK (keyed by session_number). Returns the fallback
// if the table is empty or the query throws — every caller is wrapped
// so a DB blip never bubbles up to the tour form.
async function loadSessionDatesFromDb(sql) {
  try {
    const rows = await sql`
      SELECT school_year, session_number, name, start_date, end_date
      FROM co_op_sessions
      ORDER BY school_year, session_number
    `;
    if (rows.length === 0) return SESSION_DATES_FALLBACK;
    const todayStr = new Date().toISOString().slice(0, 10);
    const byYear = {};
    rows.forEach(r => {
      const yr = r.school_year;
      if (!byYear[yr]) byYear[yr] = [];
      byYear[yr].push(r);
    });
    const years = Object.keys(byYear).sort();
    function yearSpan(yr) {
      const list = byYear[yr];
      let minStart = null, maxEnd = null;
      list.forEach(r => {
        const start = r.start_date instanceof Date
          ? r.start_date.toISOString().slice(0, 10)
          : String(r.start_date).slice(0, 10);
        const end = r.end_date instanceof Date
          ? r.end_date.toISOString().slice(0, 10)
          : String(r.end_date).slice(0, 10);
        if (!minStart || start < minStart) minStart = start;
        if (!maxEnd   || end   > maxEnd)   maxEnd   = end;
      });
      return { minStart, maxEnd };
    }
    let pick = null;
    for (const yr of years) {
      const sp = yearSpan(yr);
      if (todayStr >= sp.minStart && todayStr <= sp.maxEnd) { pick = yr; break; }
    }
    if (!pick) {
      // Prefer the NEXT scheduled year (so tour form picks future
      // Wednesdays once the new year is set, even if no row spans today).
      for (const yr of years) {
        if (todayStr < yearSpan(yr).minStart) { pick = yr; break; }
      }
    }
    if (!pick) {
      // Fall back to the most recent year — tour form will show no
      // upcoming Wednesdays, which is the correct summer-break state.
      pick = years[years.length - 1];
    }
    const out = {};
    byYear[pick].forEach(r => {
      out[r.session_number] = {
        name: r.name,
        start: r.start_date instanceof Date
          ? r.start_date.toISOString().slice(0, 10)
          : String(r.start_date).slice(0, 10),
        end: r.end_date instanceof Date
          ? r.end_date.toISOString().slice(0, 10)
          : String(r.end_date).slice(0, 10)
      };
    });
    return out;
  } catch (err) {
    console.error('[tour] loadSessionDatesFromDb failed:', err);
    return SESSION_DATES_FALLBACK;
  }
}

// Tours run during co-op (Wednesdays only) so prospective families can
// see the program in action. 30-minute start slots from 10:00 AM through
// 2:30 PM keeps the visit window inside the 9:40-3:15 co-op day with
// breathing room at both ends. Both lists share the same shape: value
// is what the form posts, label is what the family sees.
const TOUR_TIME_SLOTS = [
  { value: '10:00:00', label: '10:00 AM' },
  { value: '10:30:00', label: '10:30 AM' },
  { value: '11:00:00', label: '11:00 AM' },
  { value: '11:30:00', label: '11:30 AM' },
  { value: '12:00:00', label: '12:00 PM' },
  { value: '12:30:00', label: '12:30 PM' },
  { value: '13:00:00', label: '1:00 PM' },
  { value: '13:30:00', label: '1:30 PM' },
  { value: '14:00:00', label: '2:00 PM' },
  { value: '14:30:00', label: '2:30 PM' }
];
const TOUR_TIME_VALUES = TOUR_TIME_SLOTS.map(s => s.value);

// 'inquiry' is the entry status for Contact Us submissions (source=
// 'contact-form'). It's a separate bucket from 'requested' (a tour ask) so
// general questions don't inflate the Tour Requests to-do; Membership can
// move an inquiry into 'scheduled' if it turns into a tour, or close it out.
const VALID_TOUR_STATUSES = ['inquiry', 'requested', 'scheduled', 'toured', 'followed_up', 'joined', 'declined', 'ghosted'];

// Compute every future Wednesday that falls inside an active session
// range (inclusive). Returns chronological order. Today is excluded —
// even if today is a Wednesday in-session, the form should only let
// families pick a future date. Cap at end of last session.
// `sessions` is the active year's session map (loaded once per request
// via loadSessionDatesFromDb so we don't hit the DB inside the inner
// loop). Defaults to the static fallback for unauthenticated callers
// that haven't loaded yet.
function getUpcomingTourDates(sessions) {
  sessions = sessions || SESSION_DATES_FALLBACK;
  // Compare in the Indianapolis day, not the server's UTC day (2026-07-17
  // review): with plain `new Date()` on Vercel (UTC), the "future" cutoff
  // dropped the very next Wednesday a full evening early (~7-8 PM local
  // Tuesday) and validateTourSlot then rejected a family who picked it.
  const todayStr = indyTodayStr();
  const dates = [];
  Object.keys(sessions).sort().forEach(k => {
    const s = sessions[k];
    const start = new Date(s.start + 'T00:00:00');
    const end = new Date(s.end + 'T00:00:00');
    // Walk from start to end, picking out Wednesdays (getDay() === 3).
    const cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      if (cursor.getDay() === 3 && dateStr > todayStr) {
        dates.push({
          date: dateStr,
          sessionLabel: s.name,
          label: cursor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' — ' + s.name
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });
  return dates;
}

// Validate a (date, time) pair posted from the form: must be one of the
// computed upcoming Wednesdays AND a known time slot. Returns null on
// success or a string error message on failure.
function validateTourSlot(date, time, sessions) {
  if (!date && !time) return null; // both optional — family may submit without picking
  if (!date || !time) return 'Please pick both a date and a time, or leave both blank.';
  const slots = getUpcomingTourDates(sessions);
  if (!slots.some(s => s.date === date)) return 'That date is not an upcoming co-op Wednesday.';
  if (TOUR_TIME_VALUES.indexOf(time) === -1) return 'That time slot is not available.';
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

async function verifyWorkspaceAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  try {
    const ticket = await verifyBearer(authHeader.slice(7));
    const payload = ticket.getPayload();
    const email = payload.email || '';
    if ((email.split('@')[1] || '') !== ALLOWED_DOMAIN) return null;
    return { email };
  } catch (e) { return null; }
}

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-View-As');
}

// Resolve the effective identity for a role-gated request. Returns
// null when the JWT is missing or invalid. When the request carries
// an X-View-As header AND the real user is allowed to impersonate
// (super user, or any @rootsandwingsindy.com on dev/preview), the
// returned email is the view-as target so downstream canEditAsRole
// checks see the role the user is acting as. `realEmail` is preserved
// for audit fields (`updated_by`) so the action is still attributed
// to the actual signed-in person. Mirrors the same pattern in
// api/cleaning.js so View-As behaves consistently across the app.
async function verifyWorkspaceAuthWithViewAs(req) {
  const real = await verifyWorkspaceAuth(req);
  if (!real) return null;
  const viewAsRaw = String(req.headers['x-view-as'] || '').trim().toLowerCase();
  if (viewAsRaw && canImpersonate(real.email)) {
    return { email: viewAsRaw, realEmail: real.email, viewedBy: real.email };
  }
  return { email: real.email, realEmail: real.email };
}

// ── Tour request ──
// Validates input, INSERTs into tours (persistent pipeline backing the
// Membership Director's Member Pipeline report), then emails Membership.

// The person's open pipeline row, if any — repeat inquiries/requests from
// the same email merge into it instead of creating duplicates (Erin,
// 2026-07-14). Terminal statuses (joined/declined/ghosted) don't count:
// a family who comes back later starts a fresh pass.
async function findOpenTourByEmail(sql, email) {
  const rows = await sql`
    SELECT id, status, family_name, message FROM tours
    WHERE LOWER(family_email) = ${String(email || '').toLowerCase().trim()}
      AND status IN ('inquiry', 'requested', 'scheduled', 'toured', 'followed_up')
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

// Self-heal: merge duplicate OPEN pipeline rows sharing an email. The
// repeat-contact intake merge above prevents NEW duplicates, but rows
// created before it shipped (Erin, 2026-07-14: "still a dupe line for a
// person that requested tour 2x") need combining: the MOST RECENT
// request is the main row; older rows fold their history, message, and
// any missing contact fields into it — and the furthest pipeline stage
// wins (an older 'toured' row must not reset to 'requested'). Older rows
// are then deleted. Runs at the top of every pipeline list read;
// no-ops when there are no duplicates.
const TOUR_STAGE_RANK = { inquiry: 0, requested: 1, scheduled: 2, toured: 3, followed_up: 4 };
async function mergeDuplicateOpenTours(sql) {
  const dupeEmails = await sql`
    SELECT LOWER(family_email) AS em
    FROM tours
    WHERE family_email <> ''
      AND status IN ('inquiry', 'requested', 'scheduled', 'toured', 'followed_up')
    GROUP BY LOWER(family_email)
    HAVING COUNT(*) > 1
  `;
  const merged = [];
  for (const d of dupeEmails) {
    const rows = await sql`
      SELECT id, family_name, family_email, phone, num_kids, ages,
             preferred_date, preferred_time, scheduled_date, scheduled_time,
             status, internal_notes, message, status_history, created_at
      FROM tours
      WHERE LOWER(family_email) = ${d.em}
        AND status IN ('inquiry', 'requested', 'scheduled', 'toured', 'followed_up')
      ORDER BY created_at DESC, id DESC
    `;
    if (rows.length < 2) continue;
    const survivor = rows[0];
    const others = rows.slice(1);
    let best = survivor;
    for (const r of others) {
      if ((TOUR_STAGE_RANK[r.status] || 0) > (TOUR_STAGE_RANK[best.status] || 0)) best = r;
    }
    // Survivor's value wins; fall back to the next-most-recent row that
    // has one (an older request often carries the kid count/phone the
    // newer quick inquiry left blank).
    const pick = (field) => {
      if (survivor[field] != null && survivor[field] !== '') return survivor[field];
      for (const r of others) { if (r[field] != null && r[field] !== '') return r[field]; }
      return survivor[field] != null ? survivor[field] : null;
    };
    // Timeline reads oldest request first, then a merge marker.
    const oldestFirst = rows.slice().reverse();
    const mergedHist = [].concat(...oldestFirst.map(r => Array.isArray(r.status_history) ? r.status_history : []));
    mergedHist.push({
      at: new Date().toISOString(),
      by: 'system',
      via: 'dedupe',
      from: survivor.status,
      to: best.status,
      note: 'Merged ' + rows.length + ' pipeline rows for this email into one (most recent request kept as the main row)'
    });
    const dedupeJoin = (field) => {
      const vals = oldestFirst.map(r => String(r[field] || '').trim()).filter(Boolean);
      return vals.filter((v, i) => vals.indexOf(v) === i).join('\n— — —\n').slice(0, 4000);
    };
    await sql`
      UPDATE tours
      SET status = ${best.status},
          scheduled_date = ${best.scheduled_date || survivor.scheduled_date || null},
          scheduled_time = ${best.scheduled_time || survivor.scheduled_time || null},
          phone = ${pick('phone')},
          num_kids = ${pick('num_kids')},
          ages = ${pick('ages')},
          preferred_date = ${pick('preferred_date')},
          preferred_time = ${pick('preferred_time')},
          message = ${dedupeJoin('message')},
          internal_notes = ${dedupeJoin('internal_notes')},
          status_history = ${JSON.stringify(mergedHist)}::jsonb,
          updated_at = NOW()
      WHERE id = ${survivor.id}
    `;
    for (const r of others) {
      await sql`DELETE FROM tours WHERE id = ${r.id}`;
    }
    merged.push({ kept: survivor.id, removed: others.map(r => r.id) });
  }
  return merged;
}
// preferred_date/preferred_time are optional from the family's POV —
// if they leave them blank, the row lands in the pipeline as
// "requested" without a proposed slot, and Membership coordinates via
// reply.
// ── Public-form bot screening (Erin, 2026-07-19: junk tour/inquiry spam) ──
// Layered: (1) honeypot — a visually-hidden "website" field real users never
// fill; (2) time-trap — the page stamps its render time (form_ts, epoch ms);
// direct-to-API posts lack it and instant submits are bots; (3) junk
// heuristics — URLs in the name field, link-stuffed messages. Returns a
// log-only reason or null. Callers answer 200 {success:true} on a trip —
// SILENT discard, so bots don't get a signal to adapt around.
function botScreen(body) {
  if (String(body.website || '').trim()) return 'honeypot filled';
  const ts = parseInt(body.form_ts, 10);
  if (!Number.isFinite(ts) || ts <= 0) return 'missing form_ts (direct API post)';
  const age = Date.now() - ts;
  if (age >= 0 && age < 4000) return 'submitted ' + age + 'ms after page render';
  if (age < 0 || age > 24 * 3600 * 1000) return 'stale/future form_ts';
  if (/https?:\/\//i.test(String(body.name || ''))) return 'URL in name field';
  const msg = String(body.message || '');
  if ((msg.match(/https?:\/\//gi) || []).length >= 3) return 'link-stuffed message';
  return null;
}

async function handleTour(body, res) {
  const botReason = botScreen(body);
  if (botReason) {
    console.warn('tour-request bot screen tripped:', botReason);
    return res.status(200).json({ success: true });
  }
  const { name, email, phone, numKids, ages } = body;
  const preferredDate = body.preferred_date ? String(body.preferred_date).trim() : null;
  const preferredTime = body.preferred_time ? String(body.preferred_time).trim() : null;

  if (!name || !email || !phone || !numKids || !ages) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (String(name).length > 200 || String(email).length > 200 ||
      String(phone).length > 50 || String(ages).length > 200) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }
  // Load the active-year session calendar once per request so the slot
  // validator + the date-row lookup below both see the same data.
  const sessionsForTour = await loadSessionDatesFromDb(getSql());
  const slotErr = validateTourSlot(preferredDate, preferredTime, sessionsForTour);
  if (slotErr) return res.status(400).json({ error: slotErr });

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeNumKids = escapeHtml(numKids);
  const safeAges = escapeHtml(ages);
  const numKidsInt = parseInt(numKids, 10);

  // DB insert — best-effort, but log loudly if it fails so we know the
  // pipeline is missing a row. The email path is the user-visible
  // confirmation; if DB drops a row, Membership still gets the alert.
  // Repeat contacts merge (Erin, 2026-07-14): a second request from an
  // email that already has an OPEN pipeline row ties to that same person
  // instead of creating a duplicate — history gets an entry, fresher
  // contact fields win, and a plain inquiry upgrades to 'requested'.
  // Terminal rows (joined/declined/ghosted) don't reopen; those start a
  // fresh row so a returning family gets a clean pipeline pass.
  let tourId = null;
  let mergedIntoExisting = false;
  try {
    const sql = getSql();
    const existing = await findOpenTourByEmail(sql, email);
    if (existing) {
      const upgraded = existing.status === 'inquiry';
      const newStatus = upgraded ? 'requested' : existing.status;
      const entry = {
        at: new Date().toISOString(),
        by: 'public-form',
        via: 'repeat-contact',
        from: existing.status,
        to: newStatus,
        note: 'Repeat tour request from this email' +
          (String(existing.family_name || '').trim().toLowerCase() !== name.toLowerCase() ? ' (submitted as "' + name + '")' : '') +
          ' — merged into this row'
      };
      await sql`
        UPDATE tours
        SET status = ${newStatus},
            phone = ${phone},
            num_kids = ${Number.isFinite(numKidsInt) ? numKidsInt : null},
            ages = ${ages},
            preferred_date = ${preferredDate},
            preferred_time = ${preferredTime},
            status_history = COALESCE(status_history, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb,
            updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      tourId = existing.id;
      mergedIntoExisting = true;
    } else {
      const inserted = await sql`
        INSERT INTO tours (family_name, family_email, phone, num_kids, ages,
                           preferred_date, preferred_time, status, status_history)
        VALUES (${name}, ${email.toLowerCase()}, ${phone},
                ${Number.isFinite(numKidsInt) ? numKidsInt : null},
                ${ages}, ${preferredDate}, ${preferredTime}, 'requested',
                ${JSON.stringify([{ at: new Date().toISOString(), by: 'public-form', from: null, to: 'requested' }])}::jsonb)
        RETURNING id
      `;
      tourId = inserted[0] && inserted[0].id;
    }
  } catch (dbErr) {
    console.error('Tour DB insert error (non-fatal — email still going):', dbErr);
  }

  // Friendly slot label for the email body. Family-supplied + validated
  // already, so we can format without paranoia.
  let slotRow = '';
  if (preferredDate && preferredTime) {
    const slot = TOUR_TIME_SLOTS.find(s => s.value === preferredTime);
    const dateRow = getUpcomingTourDates(sessionsForTour).find(d => d.date === preferredDate);
    if (dateRow && slot) {
      slotRow = `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Preferred slot</td><td style="padding:8px 0;">${escapeHtml(dateRow.label)} at ${escapeHtml(slot.label)}</td></tr>`;
    }
  }

  // Build the email payloads but don't await them — handing them to
  // waitUntil() lets the function return immediately while Resend
  // finishes in the background. Response time drops from ~1-3s
  // (Resend round-trip) to ~100-300ms (just the DB insert). Trade-off:
  // we no longer surface email-send failures to the user — but the DB
  // row is already saved, so Membership sees the request in the Tour
  // Pipeline either way.
  const resend = new Resend(process.env.RESEND_API_KEY);
  const familySlotLine = slotRow
    ? `<p>You picked: <strong>${slotRow.replace(/<[^>]+>/g, '').replace(/^Preferred slot/, '').trim()}</strong>. We'll confirm the exact time by reply.</p>`
    : `<p>We'll reach out by reply to find a time that works.</p>`;

  const emailWork = Promise.allSettled([
    resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: 'membership@rootsandwingsindy.com',
      replyTo: email,
      subject: emailSubject(`New Tour Request from ${safeName}`),
      html: `
        <h2>New Tour Request</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;">
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Name</td><td style="padding:8px 0;">${safeName}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Email</td><td style="padding:8px 0;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Number of Kids</td><td style="padding:8px 0;">${safeNumKids}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Ages</td><td style="padding:8px 0;">${safeAges}</td></tr>
          ${slotRow}
        </table>
        ${mergedIntoExisting ? `<p style="background:#f5f0f8;padding:8px 12px;border-left:3px solid #523A79;border-radius:4px;color:#3d2a5c;">Repeat contact — this email already had an open pipeline row, so this request was merged into it (see its status history).</p>` : ''}
        <p style="color:#666;font-size:0.9rem;margin-top:16px;">Open the Member Pipeline in My Workspace to schedule, follow up, or close out this request.</p>
      `,
    }),
    resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: email,
      cc: ['membership@rootsandwingsindy.com'],
      replyTo: 'membership@rootsandwingsindy.com',
      subject: emailSubject(`Roots & Wings: We received your tour request`),
      html: `
        <h2>Thanks for reaching out!</h2>
        <p>Hi ${safeName},</p>
        <p>We've received your request for a tour of Roots &amp; Wings Homeschool Co-op and we're looking forward to meeting your family. We host tours on Wednesdays during co-op so you can see the day in action.</p>
        ${familySlotLine}
        <p>If anything changes on your end before then, just reply to this email — it'll reach our Membership Director directly.</p>
        <p style="color:#666;font-size:0.9rem;margin-top:20px;">— The Roots &amp; Wings Membership team<br>membership@rootsandwingsindy.com</p>
      `,
    })
  ]).then(function (results) {
    // Log Resend errors so we can spot delivery issues in Vercel logs.
    // Both sends are best-effort once the DB row is persisted.
    if (results[0].status === 'rejected' || (results[0].value && results[0].value.error)) {
      console.error('Tour membership email error:',
        results[0].reason || (results[0].value && results[0].value.error));
    }
    if (results[1].status === 'rejected' || (results[1].value && results[1].value.error)) {
      console.error('Tour family-confirmation email error:',
        results[1].reason || (results[1].value && results[1].value.error));
    }
  });
  waitUntil(emailWork);

  return res.status(200).json({ success: true, tourId });
}

// ── Contact / general inquiry (public, no auth) ──
// The public "Contact Us" form. Lands in the SAME Tour Pipeline as a tour
// request (so Membership works one list) but tagged source='contact-form'
// and carrying the visitor's free-text message. No kids/ages/slot — those
// stay null/empty. Mirrors handleTour's best-effort email pattern: persist
// the row first, then fire the two Resend emails in the background.
async function handleContact(body, res) {
  const botReason = botScreen(body);
  if (botReason) {
    console.warn('contact-form bot screen tripped:', botReason);
    return res.status(200).json({ success: true });
  }
  const name = body.name ? String(body.name).trim() : '';
  const email = body.email ? String(body.email).trim() : '';
  const phone = body.phone ? String(body.phone).trim() : '';
  const message = body.message ? String(body.message).trim() : '';

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  if (name.length > 200 || email.length > 200 || phone.length > 50 || message.length > 2000) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeMessage = escapeHtml(message);

  // DB insert first — best-effort, same rationale as handleTour: the row is
  // the source of truth for the pipeline; email is the user-visible confirm.
  // Repeat contacts merge into the person's open pipeline row (see
  // handleTour): the new message appends to their existing one, history
  // gets an entry, and the row's stage is left alone (a question from a
  // toured family must not knock them back to 'inquiry').
  let tourId = null;
  let mergedIntoExisting = false;
  try {
    const sql = getSql();
    const existing = await findOpenTourByEmail(sql, email);
    if (existing) {
      const entry = {
        at: new Date().toISOString(),
        by: 'contact-form',
        via: 'repeat-contact',
        from: existing.status,
        to: existing.status,
        note: 'New inquiry message from this email — merged into this row'
      };
      const mergedMessage = (String(existing.message || '').trim()
        ? String(existing.message).trim() + '\n— — —\n' + message
        : message).slice(0, 4000);
      await sql`
        UPDATE tours
        SET message = ${mergedMessage},
            phone = CASE WHEN ${phone} <> '' THEN ${phone} ELSE phone END,
            status_history = COALESCE(status_history, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb,
            updated_at = NOW()
        WHERE id = ${existing.id}
      `;
      tourId = existing.id;
      mergedIntoExisting = true;
    } else {
      const inserted = await sql`
        INSERT INTO tours (family_name, family_email, phone, num_kids, ages,
                           status, source, message, status_history)
        VALUES (${name}, ${email.toLowerCase()}, ${phone}, NULL, '',
                'inquiry', 'contact-form', ${message},
                ${JSON.stringify([{ at: new Date().toISOString(), by: 'contact-form', from: null, to: 'inquiry' }])}::jsonb)
        RETURNING id
      `;
      tourId = inserted[0] && inserted[0].id;
    }
  } catch (dbErr) {
    console.error('Contact DB insert error (non-fatal — email still going):', dbErr);
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const messageBlock = safeMessage
    ? `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;vertical-align:top;">Message</td><td style="padding:8px 0;white-space:pre-wrap;">${safeMessage}</td></tr>`
    : '';
  const emailWork = Promise.allSettled([
    resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: 'membership@rootsandwingsindy.com',
      replyTo: email,
      subject: emailSubject(`New Contact Inquiry from ${safeName}`),
      html: `
        <h2>New Contact Inquiry</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;">
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Name</td><td style="padding:8px 0;">${safeName}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Email</td><td style="padding:8px 0;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
          ${safePhone ? `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>` : ''}
          ${messageBlock}
        </table>
        ${mergedIntoExisting ? `<p style="background:#f5f0f8;padding:8px 12px;border-left:3px solid #523A79;border-radius:4px;color:#3d2a5c;">Repeat contact — this email already had an open pipeline row, so this message was merged into it.</p>` : ''}
        <p style="color:#666;font-size:0.9rem;margin-top:16px;">This inquiry is in the Member Pipeline in My Workspace (tagged "General inquiry"). Reply to this email to reach the family directly, or schedule them a tour from there.</p>
      `,
    }),
    resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: email,
      cc: ['membership@rootsandwingsindy.com'],
      replyTo: 'membership@rootsandwingsindy.com',
      subject: emailSubject(`Roots & Wings: We received your message`),
      html: `
        <h2>Thanks for reaching out!</h2>
        <p>Hi ${safeName},</p>
        <p>We've received your message and someone from our Membership team will get back to you soon. If you'd like to see the co-op in action, we host tours on Wednesdays during the school year — just let us know and we'll help you set one up.</p>
        <p>If anything changes on your end, just reply to this email — it'll reach our Membership Director directly.</p>
        <p style="color:#666;font-size:0.9rem;margin-top:20px;">— The Roots &amp; Wings Membership team<br>membership@rootsandwingsindy.com</p>
      `,
    })
  ]).then(function (results) {
    if (results[0].status === 'rejected' || (results[0].value && results[0].value.error)) {
      console.error('Contact membership email error:',
        results[0].reason || (results[0].value && results[0].value.error));
    }
    if (results[1].status === 'rejected' || (results[1].value && results[1].value.error)) {
      console.error('Contact family-confirmation email error:',
        results[1].reason || (results[1].value && results[1].value.error));
    }
  });
  waitUntil(emailWork);

  return res.status(200).json({ success: true, tourId });
}

// ── Membership Sheet dual-write ──
// Appends a flat 52-column row to the Registrations tab of the Membership
// Sheet so the Membership Director has a CSV-style view alongside the DB.
// Best-effort: logged and swallowed on failure so a broken Sheet can't block
// a paying family. Requires MEMBERSHIP_SHEET_ID env var and the sheet shared
// with rw-sheets-reader@rw-members-auth.iam.gserviceaccount.com as Editor.
async function appendRegistrationToSheet(row) {
  const sheetId = process.env.MEMBERSHIP_SHEET_ID;
  if (!sheetId) {
    console.warn('MEMBERSHIP_SHEET_ID not set — skipping Sheet append');
    return;
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const yn = v => v ? 'Yes' : 'No';
  const kids = Array.isArray(row.kids) ? row.kids : [];
  const coaches = Array.isArray(row.backup_coaches) ? row.backup_coaches : [];
  const values = [row.submitted_at, row.id, row.season, row.main_learning_coach,
    row.email, row.phone, row.address, row.track, row.track_other || '',
    row.existing_family_name || ''];
  for (let i = 0; i < 10; i++) {
    const k = kids[i];
    values.push(k ? (k.name || '') : '', k ? (k.birth_date || '') : '');
  }
  for (let i = 0; i < 4; i++) {
    const c = coaches[i];
    values.push(c ? (c.name || '') : '', c ? (c.email || '') : '', c ? 'No' : '');
  }
  values.push(row.placement_notes || '',
    yn(row.waiver_member_agreement), yn(row.waiver_photo_consent), yn(row.waiver_liability),
    row.signature_name, row.signature_date, row.student_signature || '',
    row.payment_status, row.payment_amount, row.paypal_transaction_id);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Registrations!A:BZ',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
}

// ── Registration (public, no auth; PayPal has already captured) ──
async function handleRegistration(body, req, res) {
  const email = String(body.email || '').trim().toLowerCase();
  const mlc_first_name = String(body.mlc_first_name || '').trim();
  const mlc_last_name = String(body.mlc_last_name || '').trim();
  const known_family_email = String(body.known_family_email || '').trim().toLowerCase();
  // Prefer the explicit first/last fields (current form); fall back to the
  // combined field only for an older client that didn't send them.
  const main_learning_coach = (mlc_first_name || mlc_last_name)
    ? (mlc_first_name + (mlc_last_name ? ' ' + mlc_last_name : '')).trim()
    : String(body.main_learning_coach || '').trim();
  const address = String(body.address || '').trim();
  const phone = String(body.phone || '').trim();
  const track = String(body.track || '').trim();
  const track_other = String(body.track_other || '').trim();
  const existing_family_name = String(body.existing_family_name || '').trim();
  const placement_notes = String(body.placement_notes || '').trim().slice(0, 2000);
  const waiver_member_agreement = body.waiver_member_agreement === true;
  const waiver_liability = body.waiver_liability === true;
  // Main LC's personal photo consent: 'yes' (photos allowed) or 'no' (opted out).
  // Default 'yes' keeps the pre-opt-out behavior for legacy clients.
  const waiver_photo_consent = body.waiver_photo_consent === 'no' ? 'no' : 'yes';
  const signature_name = String(body.signature_name || '').trim();
  // Stamped server-side (the form no longer asks for a date) so the signed
  // date is always the real day of signing, never a value a signer typed.
  const signature_date = indySignDate();
  const student_signature = String(body.student_signature || '').trim();
  const season = String(body.season || DEFAULT_SEASON).trim();
  const kids = Array.isArray(body.kids) ? body.kids : [];
  const paypal_transaction_id = String(body.paypal_transaction_id || '').trim();
  const payment_amount = Number.isFinite(Number(body.payment_amount)) ? Number(body.payment_amount) : REGISTRATION_FEE;
  // 'paypal' (default) → paid via the form; 'cash_check' → spot held,
  // Treasurer marks paid in the Membership Report later.
  const payment_method = String(body.payment_method || 'paypal').trim().toLowerCase();
  const isCashCheck = payment_method === 'cash_check';
  const backup_coaches_raw = Array.isArray(body.backup_coaches) ? body.backup_coaches : [];
  const backup_coaches = [];
  for (let i = 0; i < backup_coaches_raw.length && backup_coaches.length < 10; i++) {
    const bc = backup_coaches_raw[i] || {};
    const bcName = String(bc.name || '').trim();
    const bcEmail = String(bc.email || '').trim().toLowerCase();
    if (!bcName && !bcEmail) continue;
    if (!bcName || !bcEmail) return res.status(400).json({ error: 'Each backup Learning Coach needs both a name and email.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bcEmail)) return res.status(400).json({ error: 'Backup Learning Coach email looks invalid.' });
    if (bcName.length > 200 || bcEmail.length > 200) return res.status(400).json({ error: 'Backup Learning Coach field too long.' });
    backup_coaches.push({ name: bcName, email: bcEmail });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required.' });
  if (!main_learning_coach) return res.status(400).json({ error: 'Main Learning Coach name required.' });
  // Address is optional on the registration form — accept blank, but
  // still cap the length below when supplied.
  if (!phone) return res.status(400).json({ error: 'Phone number required.' });
  if (VALID_TRACKS.indexOf(track) === -1) return res.status(400).json({ error: 'Select AM / PM / Both.' });
  if (kids.length === 0) return res.status(400).json({ error: 'At least one child required.' });
  if (kids.length > 10) return res.status(400).json({ error: 'Too many children.' });
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k || !k.name || !k.birth_date) return res.status(400).json({ error: 'Each child needs a name and birth date.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k.birth_date)) return res.status(400).json({ error: 'Birth date must be YYYY-MM-DD.' });
    // Normalize to a clean { name, birth_date, photo_consent } record so the
    // per-child photo opt-out is a real boolean in the JSONB column. Default
    // is consent=true (photos allowed); explicit false opts the child out.
    kids[i] = {
      name: String(k.name).trim().slice(0, 200),
      first_name: String(k.first_name || '').trim().slice(0, 100),
      last_name: String(k.last_name || '').trim().slice(0, 100),
      birth_date: k.birth_date,
      photo_consent: k.photo_consent !== false
    };
  }
  if (!waiver_member_agreement) return res.status(400).json({ error: 'Member agreement acknowledgment required.' });
  if (!waiver_liability) return res.status(400).json({ error: 'Liability waiver acknowledgment required.' });
  if (!signature_name) return res.status(400).json({ error: 'Signature required.' });
  if (!isCashCheck && !paypal_transaction_id) return res.status(400).json({ error: 'Payment transaction ID required.' });

  if (email.length > 200 || main_learning_coach.length > 200 || address.length > 500 ||
      phone.length > 50 || signature_name.length > 200 || student_signature.length > 200 ||
      paypal_transaction_id.length > 100) {
    return res.status(400).json({ error: 'One or more fields are too long.' });
  }

  const sql = getSql();

  const registrationStatus = isCashCheck ? 'pending' : 'paid';

  try {
    const inserted = await sql`
      INSERT INTO registrations (
        season, email, existing_family_name, main_learning_coach, address, phone,
        track, track_other, kids, placement_notes,
        waiver_member_agreement, waiver_photo_consent, waiver_liability,
        signature_name, signature_date, student_signature,
        payment_status, payment_amount, paypal_transaction_id
      ) VALUES (
        ${season}, ${email}, ${existing_family_name || null}, ${main_learning_coach}, ${address}, ${phone},
        ${track}, ${track_other}, ${JSON.stringify(kids)}::jsonb, ${placement_notes},
        ${waiver_member_agreement}, ${waiver_photo_consent}, ${waiver_liability},
        ${signature_name}, ${signature_date}, ${student_signature},
        ${registrationStatus}, ${payment_amount}, ${paypal_transaction_id}
      )
      RETURNING id, created_at
    `;
    const id = inserted[0].id;

    // Push the registration's family snapshot into member_profiles so the
    // family's Edit My Info page shows what they just submitted (kid
    // birthdates, allergies, schedule, MLC photo consent, etc.) without
    // them having to re-enter it. Merge-not-clobber: existing profile
    // fields (pronouns, photo URLs, EMI-edited values) are preserved
    // when registration doesn't supply them. Non-fatal — registration
    // still succeeds if this fails.
    try {
      // Family last name: use the explicitly entered last name; only fall
      // back to parsing for an older client that didn't send it.
      const famName = mlc_last_name || deriveFamilyName(main_learning_coach, existing_family_name);
      // Identity (the login key) is frozen: a returning family keeps its
      // known login; a new family gets a clean key derived from the entered
      // first + last (no more guessing from a combined name string).
      let famEmail;
      if (known_family_email && known_family_email.endsWith('@' + ALLOWED_DOMAIN)) {
        famEmail = known_family_email;
      } else {
        // No frozen identity from an invite link. Before deriving a fresh
        // key from the typed name (which mints a NEW profile when the name
        // drifts — compound surnames, typos), look for the family this
        // contact email already belongs to. Exact stable keys only.
        let resolved = null;
        try {
          resolved = await resolveFamilyByContactEmail(sql, email, id);
        } catch (resolveErr) {
          console.error('Family resolution error (non-fatal, deriving as before):', resolveErr);
        }
        if (resolved) {
          famEmail = resolved.familyEmail;
          console.log('Registration ' + id + ': resolved existing family via ' + resolved.rule + ' (no fresh profile minted).');
        } else if (mlc_first_name && mlc_last_name) {
          famEmail = deriveFamilyEmail(mlc_first_name, mlc_last_name);
        } else {
          famEmail = deriveFamilyEmail(main_learning_coach, famName);
        }
      }
      if (famEmail) {
        // Record the EXACT key + whether we're creating a brand-new profile
        // vs merging into an existing family — the decline path keys off
        // these instead of re-deriving (2026-07-17 data-loss fix). Checked
        // before the upsert, which would otherwise make it look pre-existing.
        const preExisting = await sql`SELECT 1 FROM member_profiles WHERE family_email = ${famEmail} LIMIT 1`;
        const createdProfile = preExisting.length === 0;
        await sql`
          UPDATE registrations
          SET family_email = ${famEmail}, created_profile = ${createdProfile}
          WHERE id = ${id}
        `;
        await upsertProfileFromRegistration(sql, {
          familyEmail: famEmail,
          familyName: famName,
          mlcName: main_learning_coach,
          mlcFirstName: mlc_first_name,
          mlcLastName: mlc_last_name,
          mlcEmail: email,
          mlcPhotoConsent: waiver_photo_consent === 'yes',
          backupCoaches: backup_coaches,
          kids: kids,
          track: track,
          phone: phone,
          address: address,
          placementNotes: placement_notes,
          season: DEFAULT_SEASON
        });
        // Stable adult id (phase 4): the profile writer just created/kept
        // the family's MLC people row — stamp its id on the registration.
        // Best-effort snapshot: profile upserts rewrite people rows
        // wholesale (fresh ids), so this is a pointer, not a FK.
        try {
          const mlcPerson = await sql`
            SELECT id FROM people
            WHERE LOWER(family_email) = ${famEmail} AND role = 'mlc'
            ORDER BY sort_order, id LIMIT 1
          `;
          if (mlcPerson.length > 0) {
            await sql`UPDATE registrations SET mlc_person_id = ${mlcPerson[0].id} WHERE id = ${id}`;
          }
        } catch (mlcIdErr) {
          console.error('mlc_person_id stamp error (non-fatal):', mlcIdErr);
        }
      }
    } catch (profileErr) {
      console.error('Registration → member_profiles upsert error (non-fatal):', profileErr);
    }

    // Stamp the MLC's signature into waiver_signatures (consolidated, versioned
    // waiver record). The registrations row keeps the inline signature columns
    // for now; this row is the source of truth for the unified Waivers Report.
    // A DECLINED family can re-register (the registrations unique index is
    // partial: WHERE declined_at IS NULL), but waiver_signatures' unique index
    // on (LOWER(person_email), season) is absolute — so a conflict IS reachable
    // on re-registration. DO NOTHING used to silently drop the fresh signature
    // and leave the row pointing at the DECLINED registration, which the report
    // then hides → the active registration showed no signed MLC waiver
    // (2026-07-17 review). Re-point + refresh the existing row instead.
    try {
      await sql`
        INSERT INTO waiver_signatures (
          season, waiver_version, role,
          person_name, person_email, family_email, registration_id,
          signed_at, signature_name, signature_date, photo_consent
        ) VALUES (
          ${season}, ${WAIVER_VERSION}, 'main_lc',
          ${main_learning_coach}, ${email}, ${email}, ${id},
          NOW(), ${signature_name}, ${signature_date}, ${waiver_photo_consent === 'yes'}
        )
        ON CONFLICT (LOWER(person_email), season) DO UPDATE SET
          registration_id = EXCLUDED.registration_id,
          waiver_version  = EXCLUDED.waiver_version,
          person_name     = EXCLUDED.person_name,
          family_email    = EXCLUDED.family_email,
          signed_at       = EXCLUDED.signed_at,
          signature_name  = EXCLUDED.signature_name,
          signature_date  = EXCLUDED.signature_date,
          photo_consent   = EXCLUDED.photo_consent
      `;
    } catch (wsErr) {
      console.error('waiver_signatures (MLC) insert error (non-fatal):', wsErr);
    }

    // Create a unique signing token per backup Learning Coach and email each one.
    const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
      ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
      : 'https://roots-and-wings-topaz.vercel.app';
    const backupCoachRows = [];
    for (const bc of backup_coaches) {
      const token = crypto.randomUUID().replace(/-/g, '');
      try {
        // pending_token + sent_at populated; waiver_version + signed_at stay
        // NULL until the coach clicks the link and signs.
        await sql`
          INSERT INTO waiver_signatures (
            season, role,
            person_name, person_email, family_email, registration_id,
            pending_token, sent_at
          ) VALUES (
            ${season}, 'backup_coach',
            ${bc.name}, ${bc.email}, ${email}, ${id},
            ${token}, NOW()
          )
          ON CONFLICT DO NOTHING
        `;
        backupCoachRows.push({ name: bc.name, email: bc.email, token });
      } catch (bcErr) {
        console.error('Backup coach (waiver_signatures) insert error (non-fatal):', bcErr);
      }
    }

    // Best-effort backup coach emails.
    if (backupCoachRows.length > 0) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        for (const bc of backupCoachRows) {
          const link = `${baseUrl}/waiver.html?token=${encodeURIComponent(bc.token)}`;
          await resend.emails.send({
            from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
            to: bc.email,
            replyTo: 'membership@rootsandwingsindy.com',
            subject: emailSubject(`Roots & Wings Co-op: Please sign the backup Learning Coach waiver`),
            html: `
              <h2>Backup Learning Coach waiver</h2>
              <p>Hi ${escapeHtml(bc.name)},</p>
              <p>${escapeHtml(main_learning_coach)} listed you as a backup Learning Coach for the <strong>${escapeHtml(main_learning_coach)} family</strong> at Roots &amp; Wings Homeschool Co-op Inc. When you sub or cover for the Main Learning Coach at co-op, this waiver needs to be on file.</p>
              <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; sign the waiver</a></p>
              <p style="color:#666;font-size:0.9rem;">Or copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
              <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
            `,
          });
        }
      } catch (mailErr) {
        console.error('Backup coach email error (non-fatal):', mailErr);
      }
    }

    // Mirror the registration's Fall membership payment into `payments` so
    // the My Family billing card flips to "Paid" (or "Pending" for
    // cash/check) without requiring the Treasurer to update the billing
    // sheet first. Best-effort — billing remains accurate via the sheet
    // if this fails.
    try {
      const famNameForBilling = deriveFamilyName(main_learning_coach, existing_family_name);
      const famEmailForBilling = deriveFamilyEmail(main_learning_coach, famNameForBilling) || '';
      if (famNameForBilling) {
        const paymentStatus = isCashCheck ? 'Pending' : 'Paid';
        await sql`
          INSERT INTO payments (
            family_name, family_email, semester_key, payment_type, school_year,
            paypal_transaction_id, amount_cents, payer_email, status
          ) VALUES (
            ${famNameForBilling}, ${famEmailForBilling}, 'fall', 'deposit', ${season},
            ${paypal_transaction_id || ''}, ${Math.round((parseFloat(payment_amount) || 0) * 100)},
            ${email}, ${paymentStatus}
          )
        `;
      }
    } catch (payErr) {
      console.error('Registration → payments mirror error (non-fatal):', payErr);
    }

    // Best-effort append to the Membership Sheet for the Membership Director's
    // CSV-style view. Failures must not block the family's registration.
    try {
      await appendRegistrationToSheet({
        id,
        submitted_at: new Date().toISOString(),
        season, email, existing_family_name, main_learning_coach, address, phone,
        track, track_other, kids, backup_coaches, placement_notes,
        waiver_member_agreement, waiver_photo_consent: true, waiver_liability,
        signature_name, signature_date, student_signature,
        payment_status: 'paid', payment_amount, paypal_transaction_id
      });
    } catch (sheetErr) {
      console.error('Membership Sheet append error (non-fatal):', sheetErr);
    }

    // Best-effort confirmation email — failure does not fail the request.
    // Subject + lead vary by payment method: PayPal = "Confirmed & Paid",
    // cash/check = "Spot held — bring payment to co-op". Treasurer sends
    // a separate "payment received" email later via Mark Paid.
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const kidsList = kids.map(k => `<li>${escapeHtml(k.name)} &mdash; ${escapeHtml(k.birth_date)}</li>`).join('');
      const backupList = backupCoachRows.map(b => `<li>${escapeHtml(b.name)} &mdash; ${escapeHtml(b.email)} (emailed a waiver link)</li>`).join('');
      const subject = isCashCheck
        ? `Roots & Wings ${season} Registration Received — ${main_learning_coach} family (payment pending)`
        : `Roots & Wings ${season} Registration Confirmed — ${main_learning_coach} family`;
      const heading = isCashCheck ? 'Registration Received — Payment Pending' : 'Registration Confirmed &amp; Paid';
      const lead = isCashCheck
        ? `<p>Thanks for registering with Roots &amp; Wings Homeschool Co-op! Your spot is held. Please contact <a href="mailto:treasurer@rootsandwingsindy.com">treasurer@rootsandwingsindy.com</a> to arrange payment of the <strong>$${escapeHtml(String(payment_amount))} registration fee</strong> by cash or check (payable to <em>Roots and Wings Homeschool, Inc.</em>). You'll receive a separate confirmation email once the Treasurer records your payment.</p>`
        : `<p>Thanks for registering with Roots &amp; Wings Homeschool Co-op! Your ${escapeHtml(season)} Membership Fee has been received. The Membership Director, Treasurer, and Communications Director have been copied on this email.</p>`;
      const paymentRow = isCashCheck
        ? `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Payment</td><td>$${escapeHtml(String(payment_amount))} cash or check &mdash; pending</td></tr>`
        : `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;">PayPal txn</td><td>${escapeHtml(paypal_transaction_id)} &mdash; $${escapeHtml(String(payment_amount))}</td></tr>`;
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: email,
        cc: [
          'communications@rootsandwingsindy.com',
          'treasurer@rootsandwingsindy.com',
          'membership@rootsandwingsindy.com'
        ],
        replyTo: 'membership@rootsandwingsindy.com',
        subject: emailSubject(subject),
        html: `
          <h2>${heading}</h2>
          ${lead}
          <table style="border-collapse:collapse;font-family:sans-serif;">
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Season</td><td>${escapeHtml(season)}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Main Learning Coach</td><td>${escapeHtml(main_learning_coach)}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Email</td><td><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Phone</td><td>${escapeHtml(phone)}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Address</td><td>${escapeHtml(address)}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Track</td><td>${escapeHtml(track)}${track_other ? ' — ' + escapeHtml(track_other) : ''}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Returning family</td><td>${existing_family_name ? escapeHtml(existing_family_name) : '(new)'}</td></tr>
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Signature</td><td>${escapeHtml(signature_name)} on ${escapeHtml(signature_date)}</td></tr>
            ${student_signature ? `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;vertical-align:top;">Adult student signatures</td><td>${escapeHtml(student_signature)}</td></tr>` : ''}
            ${paymentRow}
          </table>
          <h3>Children</h3>
          <ul>${kidsList}</ul>
          ${backupList ? `<h3>Backup Learning Coaches</h3><ul>${backupList}</ul>` : ''}
          ${placement_notes ? `<h3>Placement notes</h3><p>${escapeHtml(placement_notes)}</p>` : ''}
          <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
    } catch (mailErr) {
      console.error('Registration email error (non-fatal):', mailErr);
    }

    return res.status(201).json({ id, fee: payment_amount, success: true });
  } catch (err) {
    if (err.message && err.message.toLowerCase().indexOf('unique') !== -1) {
      return res.status(409).json({ error: 'A registration already exists for this email this season. Please contact membership@rootsandwingsindy.com.' });
    }
    console.error('Registration insert error:', err);
    // Treasurer needs to know immediately when a paid PayPal transaction
    // failed to record — otherwise the family is charged but has no
    // membership row, and the only signal is them writing in. Best-effort
    // alert; never block the 500 response on email delivery.
    if (paypal_transaction_id) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: ['treasurer@rootsandwingsindy.com', 'membership@rootsandwingsindy.com'],
          subject: emailSubject(`ALERT: Paid registration failed to save — ${main_learning_coach}`),
          html: `
            <h2>Registration save failed AFTER PayPal capture</h2>
            <p>The family was charged but the registration row did NOT save. They will see an error and have been told to email treasurer@. Reach out to them and either reconcile the registration manually or refund the PayPal charge.</p>
            <table style="border-collapse:collapse;font-family:sans-serif;">
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Main Learning Coach</td><td>${escapeHtml(main_learning_coach)}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Email</td><td>${escapeHtml(email)}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Phone</td><td>${escapeHtml(phone)}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">PayPal txn</td><td>${escapeHtml(paypal_transaction_id)} — $${escapeHtml(String(payment_amount))}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Season</td><td>${escapeHtml(season)}</td></tr>
              <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">DB error</td><td><code>${escapeHtml(String(err && err.message || err))}</code></td></tr>
            </table>
          `,
        });
      } catch (mailErr) {
        console.error('Treasurer alert email failed (non-fatal):', mailErr);
      }
    }
    return res.status(500).json({ error: 'Could not save registration. Please email treasurer@rootsandwingsindy.com with your PayPal transaction ID.' });
  }
}

// ── PayPal client-side error reporter ──
// Receives errors that fire in the buyer's browser (SDK render failure,
// capture failure, post-capture network/API failures) and emails treasurer@
// + membership@ so we hear about broken payment attempts even when the
// buyer never writes in. Always returns 200 — this is fire-and-forget
// from the client and we don't want to drive retry storms or surface
// a follow-up error to a user who's already seeing one.
async function handlePaypalError(body, req, res) {
  const stage = String(body.stage || 'unknown').slice(0, 60);
  const errorText = (function () {
    var e = body.error;
    if (e == null) return '(no error payload)';
    if (typeof e === 'string') return e.slice(0, 4000);
    try { return JSON.stringify(e, null, 2).slice(0, 4000); }
    catch (_) { return String(e).slice(0, 4000); }
  })();
  const form = body.form_snapshot || {};
  const mlc = String(form.main_learning_coach || '').trim().slice(0, 200);
  const email = String(form.email || '').trim().slice(0, 200);
  const phone = String(form.phone || '').trim().slice(0, 50);
  const track = String(form.track || '').trim().slice(0, 50);
  const kidsCount = Array.isArray(form.kids) ? form.kids.length : 0;
  const paypalTxn = String(body.paypal_transaction_id || '').trim().slice(0, 100);
  const userAgent = String((req.headers && req.headers['user-agent']) || '').slice(0, 500);

  console.error('[paypal-error]', stage, mlc || '(no name)', email || '(no email)', errorText.slice(0, 500));

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const subjectStage = paypalTxn
      ? 'PAID but post-capture failed'
      : (stage === 'render' ? 'PayPal button never loaded' : 'PayPal flow failed');
    await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: ['treasurer@rootsandwingsindy.com', 'membership@rootsandwingsindy.com'],
      subject: emailSubject(`ALERT: ${subjectStage} — ${mlc || '(no name yet)'}`),
      html: `
        <h2>PayPal client-side error</h2>
        <p>A buyer hit an error during the registration payment flow. ${paypalTxn ? '<strong style="color:#b00;">PayPal already captured the payment — refund or reconcile manually.</strong>' : 'No PayPal transaction was captured (or none we received).'}</p>
        <table style="border-collapse:collapse;font-family:sans-serif;">
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Stage</td><td><code>${escapeHtml(stage)}</code></td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Main Learning Coach</td><td>${escapeHtml(mlc) || '(not entered yet)'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Email</td><td>${escapeHtml(email) || '(not entered yet)'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Phone</td><td>${escapeHtml(phone) || '(not entered yet)'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Track</td><td>${escapeHtml(track) || '(not entered yet)'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">Kids on form</td><td>${kidsCount}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">PayPal txn</td><td>${paypalTxn ? escapeHtml(paypalTxn) : '(none captured)'}</td></tr>
          <tr><td style="padding:6px 16px 6px 0;font-weight:bold;vertical-align:top;">User agent</td><td><code style="word-break:break-all;">${escapeHtml(userAgent)}</code></td></tr>
        </table>
        <h3>Error payload</h3>
        <pre style="background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;">${escapeHtml(errorText)}</pre>
      `,
    });
  } catch (mailErr) {
    console.error('paypal-error alert email failed (non-fatal):', mailErr);
  }

  return res.status(200).json({ logged: true });
}

// ── List registrations (Workspace auth + Comms/Membership Director role) ──
async function handleList(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  // Membership / Comms / Treasurer get the acting Membership Report
  // (Treasurer to record cash/check payments, Comms to onboard new
  // members, Membership to decline). Every OTHER board member gets the
  // same data read-only — viewerCanAct=false in the response tells the
  // client to hide the Actions column and source-sheet link. Write
  // endpoints (registration-decline, onboarding-dismiss, …) keep their
  // own narrower gates, so read-only is enforced server-side too.
  // View-As-aware: when a super user / dev tester is impersonating one
  // of those roles, auth.email is the effective email so the gate
  // matches the role they're acting as. realEmail is preserved for
  // audit + the youAre field below.
  // 'membership_report_act' — defaults to Membership + Comms + Treasurer;
  // Permissions-table editable. Board-wide READ below stays structural.
  const viewerCanAct = await hasCapability(auth.email, 'membership_report_act');
  // The full Membership Report is board-only (Erin, 2026-07-03). Committee
  // roles like Welcome Coordinator (not a voted board seat) no longer get it —
  // they use the all-members community snapshot (?community=1) instead. The
  // Welcome List (?welcome=1) is a separate endpoint with its own gate.
  const isBoard      = viewerCanAct || await isBoardMember(auth.email);
  if (!isBoard) {
    const expectedM = await getRoleHolderEmail('Membership Director');
    const expectedC = await getRoleHolderEmail('Communications Director');
    const expectedT = await getRoleHolderEmail('Treasurer');
    return res.status(403).json({
      error: 'Only board members can view the Membership Report.',
      youAre: auth.realEmail,
      expected: (expectedM || expectedC || expectedT || '(unknown — sheet lookup failed)')
    });
  }

  const season = String(req.query.season || DEFAULT_SEASON);
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT r.id, r.season, r.email, r.existing_family_name, r.main_learning_coach,
             r.address, r.phone, r.track, r.track_other, r.kids, r.placement_notes,
             r.waiver_member_agreement, r.waiver_photo_consent, r.waiver_liability,
             r.signature_name, r.signature_date, r.student_signature,
             r.payment_status, r.paypal_transaction_id, r.payment_amount,
             r.workspace_account_created_at, r.distribution_list_added_at, r.welcome_email_sent_at,
             r.declined_at, r.declined_by, r.decline_note,
             r.created_at, r.updated_at,
             (
               SELECT COALESCE(json_agg(json_build_object(
                 'name', ws.person_name,
                 'email', ws.person_email,
                 'sent_at', ws.sent_at,
                 'signed_at', ws.signed_at,
                 'signature_name', ws.signature_name,
                 'signature_date', ws.signature_date,
                 'waiver_version', ws.waiver_version
               ) ORDER BY ws.sent_at), '[]'::json)
               FROM waiver_signatures ws
               WHERE ws.registration_id = r.id AND ws.role = 'backup_coach'
             ) AS backup_coaches
      FROM registrations r
      WHERE r.season = ${season}
      ORDER BY r.created_at DESC
    `;

    // Auto-reconcile pending registrations against the billing sheet's
    // Fall Deposit (Next Year) column. When the Treasurer marks a row
    // "Paid" in the sheet for cash/check receipts, this lights up the
    // family's My Family billing card on the next read AND fires the
    // payment-received email — Treasurer's only action is the sheet
    // edit; no separate Mark Paid click required.
    // Declined rows are returned (the report shows them behind a Declined
    // filter) but never auto-reconciled — a sheet Paid mark on a declined
    // family must not fire the payment-received email.
    const pendingRegs = rows.filter(r => !r.declined_at && String(r.payment_status || '').toLowerCase() !== 'paid');
    if (pendingRegs.length > 0 && process.env.BILLING_SHEET_ID) {
      try {
        const sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
        const billingTabs = await fetchSheet(sheetsClient, process.env.BILLING_SHEET_ID);
        const parsed = parseBillingSheet(billingTabs, season);
        for (const reg of pendingRegs) {
          // MLC surname first (how the Treasurer keys the sheet), then
          // derived/stated family names, then backup-coach + kid
          // surnames (mixed-surname households); whichever finds a
          // (unique) sheet row wins. reg.backup_coaches is the
          // waiver_signatures JSON already selected for the report.
          const nameCandidates = reconcileNameCandidates(reg, reg.backup_coaches);
          let entry = null;
          for (const cand of nameCandidates) {
            entry = billingEntryFor(parsed, cand);
            if (entry) break;
          }
          if (!entry || !entry.fall || entry.fall.deposit !== 'Paid') continue;
          // Sheet shows Paid for this family — flip DB + send email.
          // Mutate the row in `rows` so the response reflects the new
          // status without a re-fetch.
          try {
            await applyMarkPaid(sql, reg, '');
            const target = rows.find(r => r.id === reg.id);
            if (target) target.payment_status = 'paid';
          } catch (innerErr) {
            console.error(`Auto-reconcile failed for reg ${reg.id} (${nameCandidates[0] || '?'}):`, innerErr);
          }
        }
      } catch (recErr) {
        console.error('Registration auto-reconcile error (non-fatal):', recErr);
      }
    }

    // Resolve the Communications Director's display name from the new
    // role_holders_v2 + roles tables, joined to people for the live name.
    // Snapshot columns were dropped from role_holders_v2 — the people
    // row is the only source. Returns empty string if no people row
    // matches (typical for shared board mailboxes like communications@).
    let commsDirectorName = '';
    try {
      const cdRows = await sql`
        SELECT
          NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS people_name
        FROM role_holders_v2 rhv
        JOIN roles r ON r.id = rhv.role_id
        LEFT JOIN people p
          ON (LOWER(p.email) = LOWER(rhv.person_email) OR LOWER(p.family_email) = LOWER(rhv.person_email))
          AND p.role = 'mlc'
        WHERE LOWER(r.title) = 'communications director'
          AND rhv.school_year = ${activeSchoolYear()}
          AND rhv.ended_at IS NULL
        ORDER BY rhv.id ASC
        LIMIT 1
      `;
      if (cdRows.length > 0) {
        commsDirectorName = cdRows[0].people_name || '';
      }
    } catch (cdErr) {
      console.error('Comms Director name lookup failed (non-fatal):', cdErr);
    }

    // New-member flag per row — reuse the canonical first-season map (same
    // rule as the Directory's First Year badge + the participation report: a
    // family is "new" until they complete a full co-op year). The map is keyed
    // by personal AND derived Workspace email, so the registration's personal
    // email resolves. Degrades to not-new if the query fails (non-fatal).
    try {
      const firstSeasons = await firstSeasonByEmail(sql);
      const seasonLabel = seasonToYearLabel(season);
      rows.forEach(r => {
        const fs = firstSeasons[String(r.email || '').toLowerCase().trim()] || '';
        r.firstSeason = fs;
        r.isNewMember = !!(fs && seasonLabel && fs >= seasonLabel);
      });
    } catch (nmErr) {
      console.error('New-member flag computation failed (non-fatal):', nmErr);
    }

    return res.status(200).json({ registrations: rows, comms_director_name: commsDirectorName, viewerCanAct });
  } catch (err) {
    console.error('Registration list error:', err);
    return res.status(500).json({ error: 'Could not load registrations.' });
  }
}

// ── Daily cron: reconcile pending registrations against the billing sheet ──
// Vercel Cron hits /api/tour?cron=reconcile-payments once per day (see
// vercel.json). Same auto-reconcile pass that runs when the Membership
// Report is opened, but on a schedule so the family + treasurer/membership
// /comms get the payment-received email even when no one's actively
// browsing the report. Early-returns cheaply when there are no pending
// registrations to check, so it's safe to keep running year-round.
//
// Auth: Vercel cron requests include a `User-Agent: vercel-cron/1.0`
// header; we accept those plus an optional CRON_SECRET bearer token for
// manual invocations / testing.
async function handleReconcileCron(req, res) {
  const ua = String(req.headers['user-agent'] || '');
  const isVercelCron = ua.indexOf('vercel-cron') !== -1;
  const cronSecret = process.env.CRON_SECRET || '';
  const authHeader = String(req.headers['authorization'] || '');
  const hasSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const season = String(req.query.season || DEFAULT_SEASON);
  const sql = getSql();
  try {
    const pending = await sql`
      SELECT r.id, r.season, r.email, r.existing_family_name, r.main_learning_coach,
             r.payment_amount, r.payment_status, r.kids,
             (
               SELECT COALESCE(json_agg(x.name), '[]'::json)
               FROM (
                 SELECT ws.person_name AS name FROM waiver_signatures ws
                 WHERE ws.registration_id = r.id AND ws.role = 'backup_coach'
                 UNION
                 SELECT bw.name FROM backup_coach_waivers bw
                 WHERE bw.registration_id = r.id
               ) x
             ) AS backup_names
      FROM registrations r
      WHERE r.season = ${season}
        AND LOWER(r.payment_status) <> 'paid'
        AND r.declined_at IS NULL
    `;
    if (pending.length === 0) {
      return res.status(200).json({ ok: true, season, pending: 0, reconciled: 0 });
    }

    if (!process.env.BILLING_SHEET_ID) {
      return res.status(500).json({ error: 'BILLING_SHEET_ID not configured' });
    }

    const sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
    const billingTabs = await fetchSheet(sheetsClient, process.env.BILLING_SHEET_ID);
    const parsed = parseBillingSheet(billingTabs, season);

    const reconciled = [];
    for (const reg of pending) {
      // Same candidate list as the Membership Report reconcile: MLC
      // surname first, then family names, then backup-coach + kid
      // surnames (mixed-surname households).
      const nameCandidates = reconcileNameCandidates(reg, reg.backup_names);
      let entry = null;
      for (const cand of nameCandidates) {
        entry = billingEntryFor(parsed, cand);
        if (entry) break;
      }
      if (!entry || !entry.fall || entry.fall.deposit !== 'Paid') continue;
      try {
        await applyMarkPaid(sql, reg, '');
        reconciled.push({ id: reg.id, family: nameCandidates[0] });
      } catch (innerErr) {
        console.error(`Cron reconcile failed for reg ${reg.id} (${nameCandidates[0]}):`, innerErr);
      }
    }

    return res.status(200).json({
      ok: true,
      season,
      pending: pending.length,
      reconciled: reconciled.length,
      families: reconciled
    });
  } catch (err) {
    console.error('Reconcile cron error:', err);
    return res.status(500).json({ error: 'Reconcile cron failed' });
  }
}

// ── Public config (no secrets — just the public Maps key + the
// tour-form's available date/time slots so the form doesn't have to
// duplicate SESSION_DATES on the client). ──
async function handleConfig(res) {
  const sessions = await loadSessionDatesFromDb(getSql());
  return res.status(200).json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
    tourDates: getUpcomingTourDates(sessions),
    tourTimes: TOUR_TIME_SLOTS
  });
}

// ── Backup Learning Coach / one-off waiver: look up by token ──
// Single query against waiver_signatures (consolidated). The role column
// distinguishes backup-coach (registration-backed) from one-off (Comms
// Director ad-hoc send), so the /waiver.html?token=… UI can branch on it.
async function handleBackupWaiverInfo(req, res) {
  const token = String(req.query.backup_waiver_token || '').trim();
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
  const sql = getSql();
  try {
    // Portal-added BLCs may have no registration_id yet (the family hasn't
    // registered for the current season), so the registrations JOIN
    // returns NULL. Fall back to member_profiles + people, keyed off the
    // family_email stamped on the waiver row, so the waiver page still
    // shows the correct MLC name and family last name.
    const rows = await sql`
      SELECT ws.role, ws.person_name, ws.person_email, ws.season,
             ws.signed_at, ws.signature_name, ws.signature_date, ws.waiver_version,
             ws.family_email, ws.note,
             r.main_learning_coach, r.existing_family_name,
             mp.family_name AS profile_family_name,
             (
               SELECT TRIM(BOTH ' ' FROM (COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')))
               FROM people p
               WHERE LOWER(p.family_email) = LOWER(ws.family_email) AND p.role = 'mlc'
               ORDER BY p.sort_order LIMIT 1
             ) AS profile_mlc_name
      FROM waiver_signatures ws
      LEFT JOIN registrations r ON r.id = ws.registration_id
      LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(ws.family_email)
      WHERE ws.pending_token = ${token}
      LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Waiver link not found. Please contact membership@rootsandwingsindy.com.' });
    const row = rows[0];
    // Guest + Community Liaison waivers (2026-07-16) behave exactly like
    // one-offs on the signing page — only backup coaches get the
    // family-context branch.
    const isOneOff = row.role !== 'backup_coach';
    // Prefer the live people / member_profiles values (what the family
    // currently shows in the directory) over the registrations snapshot,
    // which is frozen at registration time and won't reflect EMI edits.
    // The email body uses the same live source, so both stay consistent.
    const mlcName = String(row.profile_mlc_name || row.main_learning_coach || '').trim();
    const familyName = String(row.profile_family_name || row.existing_family_name || mlcName || row.person_name).trim();
    // kid_addition rows stamp the covered child in the note
    // ("Covers newly added child: X") — surface the name so the signing
    // page can say whose waiver this is.
    const kidName = row.role === 'kid_addition'
      ? String(row.note || '').replace(/^Covers newly added child:\s*/i, '').trim()
      : '';
    return res.status(200).json({
      // Keep the legacy 'source' field shape so the existing waiver.html
      // client-side branch ("if isOneOff…") keeps working unmodified.
      source: isOneOff ? 'one_off' : 'backup',
      waiver_role: row.role,
      kid_name: kidName,
      name: row.person_name,
      email: row.person_email,
      main_learning_coach: mlcName,
      family_name: familyName,
      season: row.season || '',
      signed: !!row.signed_at,
      signed_at: row.signed_at || null,
      signature_name: row.signature_name || '',
      signature_date: row.signature_date || null,
      waiver_version: row.waiver_version || null
    });
  } catch (err) {
    console.error('Backup waiver info error:', err);
    return res.status(500).json({ error: 'Could not load waiver.' });
  }
}

// ── Backup Learning Coach waiver: record signature ──
async function handleBackupWaiverSign(body, req, res) {
  const token = String(body.token || '').trim();
  const signature_name = String(body.signature_name || '').trim();
  // Stamped server-side (form no longer collects a date) — always the real
  // day of signing, never a value the signer typed.
  const signature_date = indySignDate();
  // Default to consent=true if the client didn't send the field (older clients).
  const photo_consent = body.photo_consent !== false;
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
  if (!signature_name) return res.status(400).json({ error: 'Please type your name to sign.' });
  if (signature_name.length > 200) return res.status(400).json({ error: 'Signature too long.' });

  const sql = getSql();
  try {
    // Find the pending row in the consolidated waiver_signatures table.
    // role distinguishes backup-coach vs one-off; sent_by_email is non-empty
    // for one-offs (Comms Director's email gets cc'd on the confirmation).
    const existing = await sql`
      SELECT id, role, person_name, person_email, signed_at, sent_by_email, registration_id
      FROM waiver_signatures
      WHERE pending_token = ${token}
      LIMIT 1
    `;
    if (existing.length === 0) return res.status(404).json({ error: 'Waiver link not found.' });
    if (existing[0].signed_at) return res.status(409).json({ error: 'This waiver has already been signed.' });

    // waiver_version stamped at sign time (not row creation), so the value
    // reflects what the signer actually read on /waiver.html.
    const updated = await sql`
      UPDATE waiver_signatures
      SET signed_at = NOW(), signature_name = ${signature_name},
          signature_date = ${signature_date}, photo_consent = ${photo_consent},
          waiver_version = ${WAIVER_VERSION}
      WHERE pending_token = ${token} AND signed_at IS NULL
      RETURNING id, role, person_name, person_email, family_email, sent_by_email, registration_id
    `;
    if (updated.length === 0) return res.status(409).json({ error: 'This waiver has already been signed.' });

    const u = updated[0];
    // Guest / Community Liaison rows take the one-off confirmation path.
    const isOneOff = u.role !== 'backup_coach';

    if (!isOneOff) {
      // Backup-coach branch: confirm to coach + Main LC, propagate photo
      // consent into the people table so the Directory honors it.
      try {
        const related = await sql`
          SELECT r.main_learning_coach, r.email AS main_email, r.existing_family_name
          FROM registrations r WHERE r.id = ${u.registration_id} LIMIT 1
        `;
        const info = related[0] || {};

        // family_email was stamped on the waiver_signatures row at insert
        // time and is the canonical key. Don't derive it from the
        // registration's main_learning_coach — deriveFamilyEmail assumes
        // firstName+lastInitial@ but real (and seed) families don't all
        // follow that pattern, so deriving silently produces an orphan
        // email that doesn't match any member_profiles row, and the
        // photo-consent upsert lands in nowhere.
        let famEmail = u.family_email || info.main_email || '';
        let famName = deriveFamilyName(info.main_learning_coach || '', info.existing_family_name || '');
        let mlcDisplay = info.main_learning_coach || '';
        let mainEmail = info.main_email || u.family_email || '';
        if (famEmail) {
          const profileRows = await sql`
            SELECT mp.family_name AS profile_family_name,
                   (
                     SELECT TRIM(BOTH ' ' FROM (COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')))
                     FROM people p
                     WHERE LOWER(p.family_email) = LOWER(${famEmail}) AND p.role = 'mlc'
                     ORDER BY p.sort_order LIMIT 1
                   ) AS profile_mlc_name
            FROM member_profiles mp
            WHERE LOWER(mp.family_email) = LOWER(${famEmail})
            LIMIT 1
          `;
          if (profileRows.length > 0) {
            // Prefer live profile values over the registration snapshot so
            // EMI edits to the family name / MLC name win.
            famName = profileRows[0].profile_family_name || famName;
            mlcDisplay = profileRows[0].profile_mlc_name || mlcDisplay;
          }
        }

        try {
          if (famEmail) {
            await upsertParentPhotoConsent(
              sql, famEmail, famName, u.person_name, photo_consent, u.person_email
            );
          }
        } catch (consentErr) {
          console.error('Backup LC photo consent propagation error (non-fatal):', consentErr);
        }

        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: u.person_email,
          cc: [mainEmail, 'membership@rootsandwingsindy.com'].filter(Boolean),
          replyTo: 'membership@rootsandwingsindy.com',
          subject: emailSubject(`Roots & Wings Co-op: Backup Learning Coach waiver on file`),
          html: `
            <h2>Waiver signed — thank you</h2>
            <p>Thanks, ${escapeHtml(u.person_name)}! Your backup Learning Coach waiver for the <strong>${escapeHtml(famName || mlcDisplay || 'Roots & Wings')} family</strong> is on file.</p>
            <p><strong>Signed:</strong> ${escapeHtml(signature_name)} on ${escapeHtml(signature_date)}</p>
            <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
          `,
        });
      } catch (mailErr) {
        console.error('Backup waiver confirmation email error (non-fatal):', mailErr);
      }
    } else {
      // One-off branch: confirm to recipient + the Comms Director who sent it.
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: u.person_email,
          cc: [u.sent_by_email, 'membership@rootsandwingsindy.com'].filter(Boolean),
          replyTo: 'membership@rootsandwingsindy.com',
          subject: emailSubject(`Roots & Wings Co-op: Waiver on file`),
          html: `
            <h2>Waiver signed — thank you</h2>
            <p>Thanks, ${escapeHtml(u.person_name)}! Your Roots &amp; Wings waiver is on file.</p>
            <p><strong>Signed:</strong> ${escapeHtml(signature_name)} on ${escapeHtml(signature_date)}</p>
            <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
          `,
        });
      } catch (mailErr) {
        console.error('One-off waiver confirmation email error (non-fatal):', mailErr);
      }
    }

    return res.status(200).json({ success: true, name: u.person_name });
  } catch (err) {
    console.error('Backup waiver sign error:', err);
    return res.status(500).json({ error: 'Could not record signature.' });
  }
}

// ══════════════════════════════════════════════
// REGISTRATION DECLINE
// ══════════════════════════════════════════════
// Membership Director flags a registration as declined. We email the family
// (cc'ing Communications, Treasurer, and Membership), delete any
// member_profiles row we derived at registration time, and stamp
// declined_at/declined_by/decline_note on the registrations row. The row is
// KEPT (soft delete) so the Membership Report can show declined registrations
// and the Director can undo a mistaken decline — every other consumer filters
// on declined_at IS NULL. waiver_signatures rows survive too, which is what
// makes undo lossless. Treasurer issues the refund manually against the
// PayPal transaction ID included in the email.
async function handleRegistrationDecline(body, req, res) {
  // View-As aware: the gate runs on the impersonated identity; audit
  // fields (declined_by) use realEmail so the action stays attributed
  // to the actual signed-in person.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canDecline = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'registration_decline');
  if (!canDecline) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director can decline registrations.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  if (!id) return res.status(400).json({ error: 'Registration id required.' });
  const note = String(body.note || '').trim().slice(0, 2000);

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, email, main_learning_coach, existing_family_name, season,
             paypal_transaction_id, payment_amount, kids, declined_at,
             family_email, created_profile
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];
    if (reg.declined_at) return res.status(200).json({ success: true, already: true });

    // Remove the member_profiles row ONLY when THIS registration created a
    // brand-new one, keyed by the email resolved AT REGISTRATION TIME — never
    // a re-derived guess (2026-07-17 HIGH data-loss fix: the old code could
    // cascade-delete the wrong family, or a returning family's long-lived
    // profile it merely merged into). Extra guard: don't delete if the family
    // still has another active registration. Legacy rows (family_email='' /
    // created_profile=false) fall through and delete nothing — fail-safe.
    try {
      const storedFamEmail = String(reg.family_email || '').trim().toLowerCase();
      if (storedFamEmail && reg.created_profile) {
        const stillActive = await sql`
          SELECT 1 FROM registrations
          WHERE LOWER(family_email) = ${storedFamEmail}
            AND declined_at IS NULL AND id <> ${id} LIMIT 1
        `;
        if (stillActive.length === 0) {
          await sql`DELETE FROM member_profiles WHERE family_email = ${storedFamEmail}`;
        }
      }
    } catch (mpErr) {
      console.error('member_profiles delete (non-fatal):', mpErr);
    }

    // Soft delete: stamp the decline instead of removing the row. All other
    // registration consumers filter on declined_at IS NULL; waiver_signatures
    // rows stay put so an Undo restores the family losslessly.
    await sql`
      UPDATE registrations
      SET declined_at = NOW(), declined_by = ${auth.realEmail || auth.email}, decline_note = ${note},
          updated_at = NOW()
      WHERE id = ${id}
    `;

    // Send the decline email. Failures here don't unwind the delete — the
    // Membership Director can always send a manual note if Resend is down.
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const noteHtml = note
        ? `<p><strong>Note from Membership:</strong><br>${escapeHtml(note).replace(/\n/g, '<br>')}</p>`
        : '';
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: reg.email,
        cc: [
          'communications@rootsandwingsindy.com',
          'treasurer@rootsandwingsindy.com',
          'membership@rootsandwingsindy.com'
        ],
        replyTo: 'membership@rootsandwingsindy.com',
        subject: emailSubject(`Roots & Wings ${reg.season}: Registration declined — ${reg.main_learning_coach} family`),
        html: `
          <h2>Your Roots &amp; Wings registration has been declined</h2>
          <p>Hi ${escapeHtml(reg.main_learning_coach)},</p>
          <p>Your ${escapeHtml(reg.season)} registration with Roots &amp; Wings Homeschool Co-op has been declined by the Membership Director. The Treasurer will issue a refund of your Fall Membership Fee to the original payment method.</p>
          ${noteHtml}
          <table style="border-collapse:collapse;font-family:sans-serif;margin-top:12px;">
            <tr><td style="padding:4px 16px 4px 0;font-weight:bold;">PayPal transaction</td><td>${escapeHtml(reg.paypal_transaction_id || '')} — $${escapeHtml(String(reg.payment_amount || ''))}</td></tr>
            <tr><td style="padding:4px 16px 4px 0;font-weight:bold;">Season</td><td>${escapeHtml(reg.season)}</td></tr>
          </table>
          <p style="margin-top:16px;">Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
    } catch (mailErr) {
      console.error('Decline email error (non-fatal):', mailErr);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Registration decline error:', err);
    return res.status(500).json({ error: 'Could not decline registration.' });
  }
}

// ══════════════════════════════════════════════
// REGISTRATION UNDECLINE (undo a mistaken decline)
// ══════════════════════════════════════════════
// Same gate as decline. Clears the declined_at/declined_by/decline_note
// stamp, re-creates the member_profiles row the decline deleted (from the
// registration row + surviving backup-coach waiver_signatures rows), and
// emails the family an apology/reinstatement note (cc'ing Communications,
// Treasurer, and Membership so everyone who saw the decline email sees the
// reversal too).
async function handleRegistrationUndecline(body, req, res) {
  // View-As aware, same as decline.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canDecline = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'registration_decline');
  if (!canDecline) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director can undo a declined registration.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  if (!id) return res.status(400).json({ error: 'Registration id required.' });
  const note = String(body.note || '').trim().slice(0, 2000);

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, email, main_learning_coach, existing_family_name, season,
             phone, address, track, kids, placement_notes,
             waiver_photo_consent, declined_at,
             family_email, created_profile
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];
    if (!reg.declined_at) return res.status(200).json({ success: true, already: true });

    // If the family already re-registered for this season, restoring the old
    // row would collide with the partial unique index — surface that clearly
    // instead of a raw constraint error.
    const active = await sql`
      SELECT id FROM registrations
      WHERE LOWER(email) = LOWER(${reg.email}) AND season = ${reg.season}
        AND declined_at IS NULL
      LIMIT 1
    `;
    if (active.length > 0) {
      return res.status(409).json({
        error: 'This family already has an active registration for ' + reg.season +
          ' (they may have re-registered). Leave this one declined.'
      });
    }

    await sql`
      UPDATE registrations
      SET declined_at = NULL, declined_by = NULL, decline_note = '',
          updated_at = NOW()
      WHERE id = ${id}
    `;

    // Re-create the member_profiles row the decline may have deleted. This
    // is a merge (never clobbers existing people/kids), so running it is safe
    // whether or not a profile currently exists — which also covers families
    // declined under the old code. Prefer the stored registration-time key so
    // the restore lands on the same row, never a re-derived guess (2026-07-17).
    try {
      const famName = deriveFamilyName(reg.main_learning_coach, reg.existing_family_name);
      const famEmail = String(reg.family_email || '').trim().toLowerCase()
        || deriveFamilyEmail(reg.main_learning_coach, famName);
      if (famEmail) {
        const backupRows = await sql`
          SELECT person_name AS name, person_email AS email
          FROM waiver_signatures
          WHERE registration_id = ${id} AND role = 'backup_coach'
        `;
        let kids = reg.kids;
        if (typeof kids === 'string') { try { kids = JSON.parse(kids); } catch (e) { kids = []; } }
        await upsertProfileFromRegistration(sql, {
          familyEmail: famEmail,
          familyName: famName,
          mlcName: reg.main_learning_coach,
          mlcEmail: reg.email,
          mlcPhotoConsent: reg.waiver_photo_consent === 'yes',
          backupCoaches: backupRows.map(b => ({ name: b.name, email: b.email })),
          kids: Array.isArray(kids) ? kids : [],
          track: reg.track,
          phone: reg.phone,
          address: reg.address,
          placementNotes: reg.placement_notes,
          season: reg.season
        });
      }
    } catch (profileErr) {
      console.error('Undecline member_profiles restore (non-fatal):', profileErr);
    }

    // Apology / reinstatement email. Non-fatal — the restore stands even if
    // Resend is down; Membership can follow up manually.
    let emailSent = true;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const noteHtml = note
        ? `<p><strong>Note from Membership:</strong><br>${escapeHtml(note).replace(/\n/g, '<br>')}</p>`
        : '';
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: reg.email,
        cc: [
          'communications@rootsandwingsindy.com',
          'treasurer@rootsandwingsindy.com',
          'membership@rootsandwingsindy.com'
        ],
        replyTo: 'membership@rootsandwingsindy.com',
        subject: emailSubject(`Roots & Wings ${reg.season}: Our apology — your registration is confirmed`),
        html: `
          <h2>Please disregard the decline notice — your registration is confirmed</h2>
          <p>Hi ${escapeHtml(reg.main_learning_coach)},</p>
          <p>You recently received an email saying your ${escapeHtml(reg.season)} registration with Roots &amp; Wings Homeschool Co-op had been declined. That email was sent in error, and we're very sorry for the confusion.</p>
          <p>Your registration has been fully restored — everything you submitted (your family info, kids, and signed waivers) is intact, and <strong>no action is needed on your part</strong>. If a refund was already processed, the Treasurer will reach out to make it right.</p>
          ${noteHtml}
          <p style="margin-top:16px;">We're glad to have your family with us. Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
    } catch (mailErr) {
      emailSent = false;
      console.error('Undecline apology email error (non-fatal):', mailErr);
    }

    return res.status(200).json({ success: true, emailSent });
  } catch (err) {
    console.error('Registration undecline error:', err);
    return res.status(500).json({ error: 'Could not restore registration.' });
  }
}

// Apply Mark-Paid side effects to an already-fetched registration row:
// flip registrations + payments to Paid, then send the payment-received
// email. Shared by the Treasurer's Mark Paid button and the auto-
// reconcile pass on the Membership Report list endpoint.
async function applyMarkPaid(sql, reg, note) {
  await sql`
    UPDATE registrations
    SET payment_status = 'paid', updated_at = NOW()
    WHERE id = ${reg.id}
  `;

  // Flip the matching payments row to Paid so the My Family billing
  // card surfaces it. Match by family_email when available (canonical),
  // falling back to family_name for pre-Phase-4 rows that haven't been
  // backfilled yet.
  try {
    const famName = deriveFamilyName(reg.main_learning_coach, reg.existing_family_name);
    const famEmail = deriveFamilyEmail(reg.main_learning_coach, famName) || '';
    if (famName || famEmail) {
      await sql`
        UPDATE payments
        SET status = 'Paid'
        WHERE school_year = ${reg.season}
          AND semester_key = 'fall'
          AND payment_type = 'deposit'
          AND (
            (${famEmail} <> '' AND LOWER(family_email) = LOWER(${famEmail}))
            OR (${famName} <> '' AND LOWER(family_name) = LOWER(${famName}))
          )
      `;
    }
  } catch (pErr) {
    console.error('payments mark Paid (non-fatal):', pErr);
  }

  // Confirmation email — the second of the two emails this family will
  // see (the first went out at registration submit).
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const noteHtml = note
      ? `<p><strong>Note from Treasurer:</strong><br>${escapeHtml(note).replace(/\n/g, '<br>')}</p>`
      : '';
    await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: reg.email,
      cc: [
        'treasurer@rootsandwingsindy.com',
        'membership@rootsandwingsindy.com',
        'communications@rootsandwingsindy.com'
      ],
      replyTo: 'treasurer@rootsandwingsindy.com',
      subject: emailSubject(`Roots & Wings ${reg.season} Payment Received — ${reg.main_learning_coach} family`),
      html: `
        <h2>Payment Received &mdash; You're All Set</h2>
        <p>Hi ${escapeHtml(reg.main_learning_coach)},</p>
        <p>Thanks! The Treasurer has recorded your $${escapeHtml(String(reg.payment_amount || ''))} ${escapeHtml(reg.season)} Fall Membership Fee. Your registration is now fully complete.</p>
        ${noteHtml}
        <p style="margin-top:16px;">Questions? Reply to this email and it'll reach the Treasurer.</p>
      `,
    });
  } catch (mailErr) {
    console.error('Mark-paid email error (non-fatal):', mailErr);
  }
}

// ── Treasurer Workspace: mark a pending cash/check registration as Paid ──
// Updates registrations.payment_status → 'paid', updates the matching
// payments row → 'Paid' (so the family's My Family billing card flips),
// and emails the family + Membership/Communications a payment-received
// confirmation.
async function handleRegistrationMarkPaid(body, req, res) {
  // View-As aware so super users / dev testers can act as Treasurer.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canMark = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'registration_mark_paid');
  if (!canMark) {
    const expected = await getRoleHolderEmail('Treasurer');
    return res.status(403).json({
      error: 'Only the Treasurer can mark registrations as paid.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  if (!id) return res.status(400).json({ error: 'Registration id required.' });
  const note = String(body.note || '').trim().slice(0, 2000);

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, email, main_learning_coach, existing_family_name, season,
             payment_amount, payment_status, declined_at
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];
    if (reg.declined_at) {
      return res.status(409).json({ error: 'This registration is declined — undo the decline before marking it paid.' });
    }
    if (String(reg.payment_status || '').toLowerCase() === 'paid') {
      return res.status(200).json({ success: true, already: true });
    }

    await applyMarkPaid(sql, reg, note);

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Registration mark-paid error:', err);
    return res.status(500).json({ error: 'Could not mark registration paid.' });
  }
}

// ── Comms Workspace: toggle a manual onboarding checklist step ──
// Comms ticks workspace_account_created / distribution_list_added /
// welcome_email_sent as she finishes each step in Workspace. Sending
// the welcome email goes through handleSendWelcomeEmail (separate)
// so we control the email body server-side.
const ONBOARDING_FIELDS = new Set([
  'workspace_account_created_at',
  'distribution_list_added_at'
  // welcome_email_sent_at is stamped by send-welcome-email, not toggled here
]);
async function handleOnboardingStep(body, req, res) {
  // View-As aware so super users / dev testers can act as Comms.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'member_onboarding');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can update onboarding status.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  const field = String(body.field || '').trim();
  const done = body.done === true || body.done === 'true';
  if (!id) return res.status(400).json({ error: 'Registration id required.' });
  if (!ONBOARDING_FIELDS.has(field)) return res.status(400).json({ error: 'Invalid field.' });

  const sql = getSql();
  try {
    // Whitelist + interpolate the column name — sql tag won't bind identifiers.
    const newValue = done ? new Date() : null;
    if (field === 'workspace_account_created_at') {
      await sql`UPDATE registrations SET workspace_account_created_at = ${newValue}, updated_at = NOW() WHERE id = ${id}`;
    } else if (field === 'distribution_list_added_at') {
      await sql`UPDATE registrations SET distribution_list_added_at  = ${newValue}, updated_at = NOW() WHERE id = ${id}`;
    }
    return res.status(200).json({ success: true, field, done });
  } catch (err) {
    console.error('Onboarding step update error:', err);
    return res.status(500).json({ error: 'Could not update onboarding step.' });
  }
}

// ── Comms Workspace: dismiss a registration from the onboarding queue ──
// Used when an existing member registers without filling in the
// "existing family name" field on the registration form — the row
// classifies them as a brand-new family and they show up in
// Member Onboarding by mistake. Dismissing sets existing_family_name
// to the derived last name (same value deriveFamilyName would produce
// downstream), which makes isReadyToOnboard treat them as returning
// and drops them off the list without touching welcome_email_sent_at.
async function handleOnboardingDismiss(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'member_onboarding');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can dismiss onboarding rows.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  if (!id) return res.status(400).json({ error: 'Registration id required.' });

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, main_learning_coach, existing_family_name
      FROM registrations WHERE id = ${id} AND declined_at IS NULL
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    if (rows[0].existing_family_name) {
      return res.status(200).json({ ok: true, already: true });
    }
    const familyName = deriveFamilyName(rows[0].main_learning_coach, '');
    if (!familyName) return res.status(400).json({ error: 'Could not derive family name from registration.' });
    await sql`
      UPDATE registrations
      SET existing_family_name = ${familyName}, updated_at = NOW()
      WHERE id = ${id}
    `;
    return res.status(200).json({ ok: true, existing_family_name: familyName });
  } catch (err) {
    console.error('Onboarding dismiss error:', err);
    return res.status(500).json({ error: 'Could not dismiss row.' });
  }
}

// ── Comms Workspace: send the welcome email to a new member ──
// Body of the email is editable client-side (Comms reviews + can swap
// in the actual Workspace email + temp password before send). On send,
// stamps welcome_email_sent_at so the row drops out of the onboarding
// queue.
async function handleSendWelcomeEmail(body, req, res) {
  // View-As aware so super users / dev testers can act as Comms.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'member_onboarding');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can send the welcome email.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }

  const id = parseInt(body.id, 10);
  const subject = String(body.subject || '').trim().slice(0, 200);
  const html = String(body.html || '').trim();
  if (!id) return res.status(400).json({ error: 'Registration id required.' });
  if (!subject) return res.status(400).json({ error: 'Subject required.' });
  if (!html) return res.status(400).json({ error: 'Email body required.' });

  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, email, main_learning_coach
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];

    // CC the Welcome Coordinator (Erin, 2026-07-19) — they reach out to
    // each new family, so they should see the welcome email land.
    // Resolved live so a role handoff needs no code change; lookup
    // failure just means no extra cc.
    const welcomeCc = [];
    try {
      const wcEmail = await getRoleHolderEmail('Welcome Coordinator');
      if (wcEmail && wcEmail.toLowerCase() !== 'communications@rootsandwingsindy.com') welcomeCc.push(wcEmail);
    } catch (e) { /* no Welcome Coordinator on file */ }

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: reg.email,
        cc: ['communications@rootsandwingsindy.com'].concat(welcomeCc),
        replyTo: 'communications@rootsandwingsindy.com',
        subject: emailSubject(subject),
        html: html
      });
    } catch (mailErr) {
      console.error('Welcome email send error:', mailErr);
      return res.status(502).json({ error: 'Email send failed. Try again or contact Resend.' });
    }

    await sql`UPDATE registrations SET welcome_email_sent_at = NOW(), updated_at = NOW() WHERE id = ${id}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Welcome email handler error:', err);
    return res.status(500).json({ error: 'Could not send welcome email.' });
  }
}

// ── Comms Workspace: unified waivers report (backup + one-off) ──
// Lightweight counts-only endpoint for the Comms To Do card. Returns
// { pending, resent } from a single aggregate query against
// waiver_signatures — no JOIN, no per-row payload. Same auth gate as
// the full report so the card stays Comms-only.
async function handleWaiversCounts(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const isComms = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'waivers_manage');
  if (!isComms && !(await isBoardMember(auth.email))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director or a board member can view this report.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE ws.signed_at IS NULL AND ws.last_sent_at IS NULL)     AS pending,
        COUNT(*) FILTER (WHERE ws.signed_at IS NULL AND ws.last_sent_at IS NOT NULL) AS resent
      FROM waiver_signatures ws
      LEFT JOIN registrations r ON r.id = ws.registration_id
      WHERE ws.role IN ('backup_coach', 'one_off', 'guest', 'community_liaison', 'kid_addition')
        AND (ws.registration_id IS NULL OR r.declined_at IS NULL)
    `;
    const r = rows[0] || {};
    return res.status(200).json({
      pending: parseInt(r.pending, 10) || 0,
      resent:  parseInt(r.resent, 10)  || 0
    });
  } catch (err) {
    console.error('waivers-counts error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function handleWaiversReport(req, res) {
  // View-As aware (mirrors the Membership + Merch reports): super users and
  // dev/preview testers reach this via X-View-As into Comms. Without it, a
  // tester signed in as their own @rootsandwingsindy.com email 403s even
  // though they can impersonate.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const isComms = isSuperUser(auth.email) ||
    await hasCapability(auth.email, 'waivers_manage');
  // Board transparency (2026-07-15): board members read the report;
  // viewerCanAct=false hides the send/resend controls client-side (the
  // send endpoints stay gated on waivers_manage).
  if (!isComms && !(await isBoardMember(auth.email))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director or a board member can view this report.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
    // Optional season scope. When ?season= is passed the report is scoped to
    // that school year (so a prior-year signature doesn't count as signed for
    // a new year); with no param it shows every season so the report never
    // goes dark just because the active registration season has little data
    // yet. The client passes the season it wants to view.
    const season = req.query.season ? String(req.query.season) : null;
    // Single query against waiver_signatures. sent_at uses COALESCE so the
    // Resend action surfaces the latest send timestamp instead of the
    // original insert date — matters when Comms is prioritizing pending rows.
    // For Main LCs, "sent_by" is themselves; for backup coaches, it's the
    // Main LC who listed them; for one-offs, the Comms Director who sent it.
    const rows = await sql`
      SELECT ws.id, ws.role, ws.season, ws.waiver_version,
             ws.person_name AS name, ws.person_email AS email,
             ws.signed_at, ws.signature_name, ws.signature_date,
             ws.photo_consent,
             COALESCE(ws.last_sent_at, ws.sent_at, ws.signed_at, ws.created_at) AS sent_at,
             ws.last_sent_at,
             ws.sent_by_email, ws.note,
             r.main_learning_coach
      FROM waiver_signatures ws
      LEFT JOIN registrations r ON r.id = ws.registration_id
      WHERE (${season}::text IS NULL OR ws.season = ${season})
        AND (ws.registration_id IS NULL OR r.declined_at IS NULL)
      ORDER BY COALESCE(ws.last_sent_at, ws.sent_at, ws.signed_at, ws.created_at) DESC
    `;
    // Re-shape into the three buckets the Waivers Report renderer
    // expects ({backup, oneOff, registration}). Adult-student signatures
    // (currently only stored on registrations.student_signature) are
    // surfaced as additional "registration" rows by walking the
    // registrations table once for the parsed pseudo-rows.
    const backup = [], oneOff = [], registration = [];
    rows.forEach(ws => {
      if (ws.role === 'backup_coach') {
        backup.push({
          source: 'backup', id: ws.id, name: ws.name, email: ws.email,
          signed_at: ws.signed_at, sent_at: ws.sent_at,
          last_sent_at: ws.last_sent_at,
          sent_by: ws.main_learning_coach || '',
          season: ws.season, waiver_version: ws.waiver_version,
          photo_consent: ws.photo_consent
        });
      } else if (ws.role === 'one_off' || ws.role === 'guest' || ws.role === 'community_liaison' || ws.role === 'kid_addition') {
        // Guest + Community Liaison (2026-07-16) ride the one-off bucket —
        // same send/resend mechanics — and carry waiver_role so the client
        // can label the Source column distinctly. kid_addition (2026-07-19,
        // the enrollment approval flow) rides here too: the MLC's waiver
        // covering a newly added child.
        oneOff.push({
          source: 'one_off', waiver_role: ws.role,
          id: ws.id, name: ws.name, email: ws.email,
          signed_at: ws.signed_at, sent_at: ws.sent_at,
          last_sent_at: ws.last_sent_at,
          sent_by: ws.sent_by_email || '', note: ws.note,
          season: ws.season, waiver_version: ws.waiver_version,
          photo_consent: ws.photo_consent
        });
      } else if (ws.role === 'main_lc') {
        registration.push({
          source: 'registration', id: ws.id,
          name: ws.signature_name || ws.name, email: ws.email,
          // Use the real server sign timestamp, not the (formerly
          // hand-typed) signature_date — the latter could be any date the
          // signer entered (e.g. a stray 2020). signed_at = NOW() at sign.
          signed_at: ws.signed_at,
          sent_at: ws.signed_at,
          sent_by: ws.main_learning_coach || ws.name,
          season: ws.season, context: 'Main Learning Coach',
          waiver_version: ws.waiver_version,
          photo_consent: ws.photo_consent
        });
      }
    });

    // Adult-student signatures aren't yet in waiver_signatures (they're
    // captured as a single delimited string on registrations.student_signature
    // at form submit). Surface them as virtual rows so they still appear in
    // the report. Future work: give them their own waiver_signatures rows.
    const regsForStudents = await sql`
      SELECT id, season, main_learning_coach, email, signature_date,
             student_signature, waiver_photo_consent, created_at
      FROM registrations
      WHERE student_signature IS NOT NULL AND student_signature <> ''
        AND declined_at IS NULL
        AND (${season}::text IS NULL OR season = ${season})
    `;
    regsForStudents.forEach(r => {
      const ss = String(r.student_signature || '').trim();
      if (!ss) return;
      ss.split(/\s*;\s*/).forEach(part => {
        if (!part) return;
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) return;
        const kidName = part.slice(0, colonIdx).trim();
        const signedName = part.slice(colonIdx + 1).trim();
        if (!signedName) return;
        registration.push({
          source: 'registration',
          id: r.id + '-' + kidName,
          name: signedName,
          email: r.email,
          // Real registration timestamp, not the (formerly hand-typed)
          // signature_date — see the main_lc note above.
          signed_at: r.created_at,
          sent_at: r.created_at,
          sent_by: r.main_learning_coach,
          season: r.season,
          context: 'Adult student (' + kidName + ')',
          // Adult-student rows aren't in waiver_signatures yet, so they
          // inherit the family's MLC photo consent from the registration.
          photo_consent: r.waiver_photo_consent === 'yes'
        });
      });
    });

    return res.status(200).json({ backup, oneOff, registration, viewerCanAct: isComms });
  } catch (err) {
    console.error('waivers report error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Comms Workspace: send a one-off waiver to an ad-hoc adult ──
async function handleWaiverSend(body, req, res) {
  // View-As aware so super users / dev testers can act as Comms.
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await hasCapability(user.email, 'waivers_manage'))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can send one-off waivers.',
      youAre: user.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const note = String(body.note || '').trim().slice(0, 500);
  // Who the waiver is for (2026-07-16): Guest (outside helper for a class
  // or event), Community Liaison, or a plain one-off adult. Stored on the
  // waiver_signatures row so the Waivers Report can label it.
  const waiverRole = String(body.waiver_role || 'one_off').trim();
  const WAIVER_SEND_ROLES = ['one_off', 'guest', 'community_liaison'];

  if (!name) return res.status(400).json({ error: 'Recipient name is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid recipient email is required.' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long.' });
  if (WAIVER_SEND_ROLES.indexOf(waiverRole) === -1) return res.status(400).json({ error: 'Unknown waiver type.' });

  try {
    const sql = getSql();
    const token = crypto.randomUUID().replace(/-/g, '');

    // One-offs aren't tied to a registration, so tag them to the active
    // registration season (DEFAULT_SEASON) — same year registrations use.
    // The old calendar-derived season mis-tagged spring sends: a waiver
    // sent in April 2026 (for the upcoming 2026-2027 year) landed in
    // 2025-2026 and never surfaced in the new year's Waivers Report.
    const season = DEFAULT_SEASON;

    const inserted = await sql`
      INSERT INTO waiver_signatures (
        season, role, person_name, person_email,
        pending_token, sent_at, sent_by_email, note
      ) VALUES (
        ${season}, ${waiverRole}, ${name}, ${email},
        ${token}, NOW(), ${user.realEmail || user.email}, ${note}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    // Waivers are unique per (email, season). Silently emailing a link
    // whose token was never stored (the old behavior) sends a dead link —
    // bites recycled guest Workspace accounts especially (2026-07-16).
    if (inserted.length === 0) {
      const existing = await sql`
        SELECT person_name, signed_at FROM waiver_signatures
        WHERE LOWER(person_email) = ${email} AND season = ${season}
        LIMIT 1
      `;
      const ex = existing[0];
      const who = ex && ex.person_name ? ex.person_name : 'someone';
      return res.status(409).json({
        error: ex && ex.signed_at
          ? `This email already has a signed ${season} waiver on file (${who}). If this is a different person — e.g. a recycled guest account — send the waiver to their personal email instead.`
          : `This email already has a pending ${season} waiver (${who}) — use Resend in the Waivers Report, or send to a different email.`
      });
    }

    const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
      ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
      : 'https://roots-and-wings-topaz.vercel.app';
    const link = `${baseUrl}/waiver.html?token=${encodeURIComponent(token)}`;

    let emailed = false;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: email,
        replyTo: 'membership@rootsandwingsindy.com',
        subject: emailSubject(`Roots & Wings Co-op: Please sign the waiver`),
        html: `
          <h2>Roots &amp; Wings Co-op waiver</h2>
          <p>Hi ${escapeHtml(name)},</p>
          <p>Please review and sign the Roots &amp; Wings Homeschool Co-op waiver before joining us at co-op.</p>
          ${note ? `<p style="background:#f5f0f8;padding:10px 14px;border-left:3px solid #523A79;border-radius:4px;"><em>${escapeHtml(note)}</em></p>` : ''}
          <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; sign the waiver</a></p>
          <p style="color:#666;font-size:0.9rem;">Or copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
          <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
      emailed = true;
    } catch (mailErr) {
      console.error('One-off waiver email error (non-fatal):', mailErr);
    }

    return res.status(200).json({ success: true, emailed, link });
  } catch (err) {
    console.error('waiver-send error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Comms Workspace: resend a pending waiver from the Waivers Report ──
// Re-emails the same token (so the recipient's existing /waiver.html?token=…
// link still works) and stamps last_sent_at so the report's Sent column
// shows the latest send timestamp. Refuses signed waivers.
async function handleWaiverResend(body, req, res) {
  // View-As aware so super users / dev testers can act as Comms.
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await hasCapability(user.email, 'waivers_manage'))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can resend waivers.',
      youAre: user.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }

  // The legacy `source` param is accepted but no longer needed for routing
  // — everything now lives in waiver_signatures and id is unique across roles.
  const source = String(body.source || '').trim();
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid waiver id is required.' });
  if (source && source !== 'backup' && source !== 'one_off') return res.status(400).json({ error: 'source must be "backup" or "one_off" if provided.' });

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT ws.id, ws.role, ws.person_name AS name, ws.person_email AS email,
             ws.pending_token AS token, ws.signed_at, ws.note,
             ws.family_email,
             r.main_learning_coach AS sent_by
      FROM waiver_signatures ws
      LEFT JOIN registrations r ON r.id = ws.registration_id
      WHERE ws.id = ${id}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Waiver not found.' });
    if (row.signed_at) return res.status(409).json({ error: 'Already signed — nothing to resend.' });
    if (!row.token) return res.status(409).json({ error: 'No pending token on this row — cannot resend.' });
    if (['backup_coach', 'one_off', 'guest', 'community_liaison', 'kid_addition'].indexOf(row.role) === -1) {
      return res.status(400).json({ error: 'Only backup-coach, guest, or one-off waivers can be resent.' });
    }

    const isBackup = row.role === 'backup_coach';
    const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
      ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
      : 'https://roots-and-wings-topaz.vercel.app';
    const link = `${baseUrl}/waiver.html?token=${encodeURIComponent(row.token)}`;
    const note = isBackup ? '' : String(row.note || '').trim();

    let emailed = false;
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const subject = isBackup
        ? `Reminder: Roots & Wings Co-op backup Learning Coach waiver`
        : `Reminder: Roots & Wings Co-op waiver`;
      const intro = isBackup
        ? `<p>This is a reminder to sign the Roots &amp; Wings Homeschool Co-op waiver. ${escapeHtml(row.sent_by || 'The Main Learning Coach')} listed you as a backup Learning Coach; the waiver needs to be on file before you sub or cover at co-op.</p>`
        : `<p>This is a reminder to review and sign the Roots &amp; Wings Homeschool Co-op waiver before joining us at co-op.</p>`;
      // On a resend (BLC role only), CC the MLC's family email so they
      // see the link too — BLCs frequently miss the original email and
      // the MLC is the closest backstop.
      const mlcEmail = row.family_email ? String(row.family_email).trim().toLowerCase() : '';
      const recipientEmail = String(row.email || '').trim().toLowerCase();
      const ccMlc = isBackup && mlcEmail && mlcEmail !== recipientEmail ? [mlcEmail] : undefined;
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: row.email,
        cc: ccMlc,
        replyTo: 'membership@rootsandwingsindy.com',
        subject: emailSubject(subject),
        html: `
          <h2>Roots &amp; Wings Co-op waiver — reminder</h2>
          <p>Hi ${escapeHtml(row.name)},</p>
          ${intro}
          ${note ? `<p style="background:#f5f0f8;padding:10px 14px;border-left:3px solid #523A79;border-radius:4px;"><em>${escapeHtml(note)}</em></p>` : ''}
          <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; sign the waiver</a></p>
          <p style="color:#666;font-size:0.9rem;">Or copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
          <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
      emailed = true;
    } catch (mailErr) {
      console.error('Waiver resend email error (non-fatal):', mailErr);
    }

    await sql`UPDATE waiver_signatures SET last_sent_at = NOW() WHERE id = ${id}`;

    return res.status(200).json({ success: true, emailed, link });
  } catch (err) {
    console.error('waiver-resend error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Membership Workspace: email a registration link to a prospective family ──
async function handleRegistrationInvite(body, req, res) {
  // View-As aware so super users / dev testers can act as Membership.
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const canInvite = await hasCapability(user.email, 'registration_invite');
  if (!canInvite) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership or Communications Director can send registration links.',
      youAre: user.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const note = String(body.note || '').trim().slice(0, 500);

  if (!name) return res.status(400).json({ error: 'Recipient name is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid recipient email is required.' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long.' });

  const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
    ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
    : 'https://roots-and-wings-topaz.vercel.app';

  // Log the send so the Membership To Do can track the funnel
  // (Sent → Opened → Registered). One row per family per season; a
  // resend upserts the same row (bumps last_sent_at/send_count, keeps
  // the original token so the earlier emailed link stays live) and
  // revives a dismissed invite. The token makes the link unique —
  // register.html pings ?invite-open=<token> on load to stamp opened_at.
  // Non-fatal: a logging hiccup must never block the actual send.
  let token = '';
  try {
    const sql = getSql();
    const rows = await sql`
      INSERT INTO registration_invites (email, name, note, season, token, sent_by)
      VALUES (${email}, ${name}, ${note}, ${DEFAULT_SEASON}, ${crypto.randomUUID().replace(/-/g, '')}, ${user.realEmail || user.email})
      ON CONFLICT (LOWER(email), season)
      DO UPDATE SET name = EXCLUDED.name,
                    note = EXCLUDED.note,
                    sent_by = EXCLUDED.sent_by,
                    last_sent_at = NOW(),
                    send_count = registration_invites.send_count + 1,
                    dismissed_at = NULL,
                    dismissed_by = ''
      RETURNING token
    `;
    token = (rows[0] && rows[0].token) || '';
  } catch (logErr) {
    console.error('Registration invite logging error (non-fatal):', logErr);
  }
  const link = `${baseUrl}/register.html${token ? '?inv=' + token : ''}`;

  let emailed = false;
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: email,
      replyTo: 'membership@rootsandwingsindy.com',
      subject: emailSubject(`Roots & Wings Co-op: Your registration link`),
      html: `
        <h2>Welcome to Roots &amp; Wings!</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Thanks for your interest in joining our co-op. When you're ready, use the link below to complete registration for your family.</p>
        ${note ? `<p style="background:#f5f0f8;padding:10px 14px;border-left:3px solid #523A79;border-radius:4px;"><em>${escapeHtml(note)}</em></p>` : ''}
        <p style="background:#fdf3e7;padding:10px 14px;border-left:3px solid #c8862a;border-radius:4px;"><strong>Please complete your registration within 2 weeks — this link expires after that.</strong> If it expires, reply to this email for a fresh one; we can't guarantee a spot will still be available.</p>
        <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Complete registration</a></p>
        <p style="color:#666;font-size:0.9rem;">Or copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
        <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
      `,
    });
    emailed = true;
  } catch (mailErr) {
    console.error('Registration invite email error (non-fatal):', mailErr);
  }

  return res.status(200).json({ success: true, emailed, link });
}

// GET ?invite-open=<token> — public, unauthenticated. register.html pings
// this on load when its URL carries ?inv=<token>, stamping the invite as
// Opened in the Membership funnel. The 128-bit random token IS the
// credential; unknown or malformed tokens no-op. Always 200 — the public
// register page must never break over tracking.
// Returns expired:true when the link is past its 14-day window (counted
// from the LAST send — a resend restarts the clock), matching the "within
// 2 weeks" promise in the invite email; register.html shows a warning
// banner. Expiry is advisory, not a gate: the register page is public
// (returning families use it without any token), so submissions still go
// through and Membership reviews them as usual.
async function handleInviteOpenPing(req, res) {
  const token = String(req.query['invite-open'] || '').trim();
  let expired = false;
  if (/^[a-f0-9]{32}$/i.test(token)) {
    try {
      const sql = getSql();
      const rows = await sql`
        UPDATE registration_invites
        SET opened_at = COALESCE(opened_at, NOW()),
            open_count = open_count + 1
        WHERE token = ${token}
        RETURNING (last_sent_at < NOW() - INTERVAL '14 days') AS expired
      `;
      expired = !!(rows[0] && rows[0].expired);
    } catch (err) {
      console.error('Invite open-ping error (non-fatal):', err);
    }
  }
  return res.status(200).json({ ok: true, expired });
}

// GET ?list=registration-invites — every registration link sent this
// season, with funnel status. "Registered" is derived at read time by
// joining registrations on LOWER(email)+season (declined rows excluded —
// and the partial unique index guarantees at most one active match), so
// completing the form needs no write-back here.
async function handleRegistrationInvitesList(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const canAct = await hasCapability(auth.email, 'registration_invite');
  // Board transparency (2026-07-15): board members read the funnel;
  // resend/dismiss/log actions stay gated on the capability.
  const canView = canAct || await isBoardMember(auth.email);
  if (!canView) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership or Communications Director or a board member can view sent registration links.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT i.id, i.email, i.name, i.note, i.season,
             i.sent_by, i.sent_via, i.first_sent_at, i.last_sent_at, i.send_count,
             i.opened_at, i.dismissed_at, i.dismissed_by,
             r.id AS registration_id, r.created_at AS registered_at
      FROM registration_invites i
      LEFT JOIN registrations r
        ON LOWER(r.email) = LOWER(i.email)
       AND r.season = i.season
       AND r.declined_at IS NULL
      WHERE i.season = ${DEFAULT_SEASON}
      ORDER BY i.last_sent_at DESC
    `;
    return res.status(200).json({ invites: rows, viewerCanAct: canAct });
  } catch (err) {
    console.error('Registration invites list error:', err);
    return res.status(500).json({ error: 'Could not load sent registration links.' });
  }
}

// kind=registration-invite-mark — log a registration link that was sent
// OUTSIDE the app (text, in person, personal email). Membership enters
// the date herself; no email fires, and there's no tokenized link in the
// family's hands, so opens can't be tracked for these (sent_via='other').
// Upserts the same one-row-per-family-per-season record the emailed path
// uses, so the whole funnel (Awaiting Registration count, pipeline
// stamps, the 2-week expiry) runs from the entered date.
async function handleRegistrationInviteMark(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const canAct = await hasCapability(auth.email, 'registration_invite');
  if (!canAct) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership or Communications Director can log registration links.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const sentDate = String(body.sent_date || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sentDate)) return res.status(400).json({ error: 'A valid sent date is required.' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long.' });
  try {
    const sql = getSql();
    const rows = await sql`
      INSERT INTO registration_invites
        (email, name, season, token, sent_by, sent_via, first_sent_at, last_sent_at)
      VALUES (${email}, ${name}, ${DEFAULT_SEASON}, ${crypto.randomUUID().replace(/-/g, '')},
              ${auth.realEmail}, 'other', ${sentDate}::date, ${sentDate}::date)
      ON CONFLICT (LOWER(email), season)
      DO UPDATE SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE registration_invites.name END,
                    sent_by = EXCLUDED.sent_by,
                    sent_via = 'other',
                    last_sent_at = ${sentDate}::date,
                    send_count = registration_invites.send_count + 1,
                    dismissed_at = NULL,
                    dismissed_by = ''
      RETURNING id, last_sent_at, send_count
    `;
    return res.status(200).json({ success: true, invite: rows[0] });
  } catch (err) {
    console.error('Registration invite mark error:', err);
    return res.status(500).json({ error: 'Could not log the link.' });
  }
}

// kind=registration-invite-dismiss | registration-invite-restore.
// Dismiss clears a family who went quiet out of the Awaiting Registration
// To Do count (they stay visible behind the Dismissed filter); restore
// undoes it. A resend also revives a dismissed invite (see the upsert).
async function handleRegistrationInviteDismiss(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const canAct = await hasCapability(auth.email, 'registration_invite');
  if (!canAct) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership or Communications Director can update sent registration links.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id is required.' });
  const restore = String(body.kind || '').toLowerCase() === 'registration-invite-restore';
  try {
    const sql = getSql();
    const rows = restore
      ? await sql`UPDATE registration_invites SET dismissed_at = NULL, dismissed_by = ''
                  WHERE id = ${id} RETURNING id, dismissed_at`
      : await sql`UPDATE registration_invites SET dismissed_at = NOW(), dismissed_by = ${auth.realEmail}
                  WHERE id = ${id} RETURNING id, dismissed_at`;
    if (!rows.length) return res.status(404).json({ error: 'Invite not found.' });
    return res.status(200).json({ success: true, dismissed_at: rows[0].dismissed_at || null });
  } catch (err) {
    console.error('Registration invite dismiss error:', err);
    return res.status(500).json({ error: 'Could not update the invite.' });
  }
}

// ══════════════════════════════════════════════
// MEMBER PROFILES — editable Directory overlay
// ══════════════════════════════════════════════
// One row per family in member_profiles, keyed by the family's portal login
// (family_email, derived from the Directory sheet). Anyone signed in with
// that Workspace account can edit their own family. Communications Director
// (super user) can edit any family.

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

const VALID_PARENT_ROLES = ['mlc', 'blc', 'parent'];

function sanitizeParent(p) {
  if (!p || typeof p !== 'object') return null;
  // Each adult carries first_name + last_name as separate fields so a parent
  // who kept their maiden name (e.g. "Sarah Smith" married into the Jones
  // family) displays as "Sarah Smith" rather than "Sarah Smith Jones". The
  // legacy `name` field is preserved for back-compat and used as a fallback
  // when first_name is missing — saved as "first last" so existing readers
  // (lookupPerson, allPeople matchers) keep working.
  const first_name = String(p.first_name || '').trim().slice(0, 100);
  const last_name = String(p.last_name || '').trim().slice(0, 100);
  const fallbackName = String(p.name || '').trim().slice(0, 200);
  const composed = [first_name, last_name].filter(Boolean).join(' ').trim();
  const name = composed || fallbackName;
  if (!name) return null;
  const role = VALID_PARENT_ROLES.includes(p.role) ? p.role : '';
  const email = String(p.email || '').trim().toLowerCase().slice(0, 200);
  const personal_email = String(p.personal_email || '').trim().toLowerCase().slice(0, 200);
  const phone = String(p.phone || '').trim().slice(0, 50);
  return {
    name,
    first_name,
    last_name,
    // Preferred display name ("goes by"). Display-only — matching stays
    // on first_name/last_name.
    nickname: String(p.nickname || '').trim().slice(0, 60),
    pronouns: String(p.pronouns || '').trim().slice(0, 60),
    photo_url: String(p.photo_url || '').trim().slice(0, 500),
    // Per-adult photo opt-out. Default consent = true; explicit false opts out.
    photo_consent: p.photo_consent !== false,
    role,
    email,
    personal_email,
    phone,
    // Nicknames feed participation name resolution so the master sheet
    // can write "Becca" / "Jess" and still credit the right parent.
    // Stored lowercase, trimmed, deduped, capped at 8 entries × 40 chars
    // each so the JSONB stays tidy.
    nicknames: Array.from(new Set(
      (Array.isArray(p.nicknames) ? p.nicknames : [])
        .map(n => String(n || '').trim().toLowerCase().slice(0, 40))
        .filter(Boolean)
    )).slice(0, 8)
  };
}

// Family identity phase 4 (2026-07-19): before minting a fresh derived
// family email for a registration with NO known_family_email (cold
// re-registrations without an invite link), try to resolve the family the
// typed contact email already belongs to. EXACT email equality against
// stable keys ONLY — never fuzzy name matching (name drift + compound
// surnames minting duplicate profiles is exactly the disease this treats;
// see scripts/consolidate-family.js for the O'Connor Gading anatomy).
// Rules, in order:
//   1. member_profiles.family_email        (they typed their login key)
//   2. member_profiles.additional_emails   (a co-parent / alternate login)
//   3. people.email                        (an adult's Workspace email)
//   4. people.personal_email               (an adult's personal email)
//   5. a prior non-declined registration's email/family_email whose
//      family_email still points at a live profile
// A rule that matches MORE than one distinct family is ambiguous — abort
// resolution entirely (fall back to today's derive) rather than guess.
// Returns { familyEmail, rule } or null. Resolution only ever PICKS an
// existing profile instead of minting a new one; it never merges profiles.
async function resolveFamilyByContactEmail(sql, contactEmail, excludeRegId) {
  const ce = String(contactEmail || '').trim().toLowerCase();
  if (!ce) return null;
  const regId = Number(excludeRegId) || 0;

  function pick(rows, rule) {
    const fams = Array.from(new Set(rows.map(r => String(r.family_email || '').trim().toLowerCase()).filter(Boolean)));
    if (fams.length === 1) return { familyEmail: fams[0], rule };
    if (fams.length > 1) {
      console.log('Family resolution: contact email matches ' + fams.length + ' families via ' + rule + ' — ambiguous, falling back to derive.');
      return { ambiguous: true };
    }
    return null;
  }

  let hit = pick(await sql`
    SELECT family_email FROM member_profiles WHERE LOWER(family_email) = ${ce} LIMIT 2
  `, 'member_profiles.family_email');
  if (hit) return hit.ambiguous ? null : hit;

  hit = pick(await sql`
    SELECT family_email FROM member_profiles
    WHERE EXISTS (SELECT 1 FROM unnest(additional_emails) ae WHERE LOWER(ae) = ${ce})
    LIMIT 2
  `, 'member_profiles.additional_emails');
  if (hit) return hit.ambiguous ? null : hit;

  // People-table rules are MLC-ONLY (ship-gate blocker, 2026-07-19): a
  // registrant's personal email also lives on OTHER families' rows when
  // they're listed as someone's Backup Learning Coach — matching those
  // would merge a brand-new family into their friend's profile. Only the
  // main-coach row identifies "this person's own family".
  hit = pick(await sql`
    SELECT family_email FROM people WHERE LOWER(email) = ${ce} AND role = 'mlc' LIMIT 2
  `, 'people.email (mlc)');
  if (hit) return hit.ambiguous ? null : hit;

  hit = pick(await sql`
    SELECT family_email FROM people WHERE LOWER(personal_email) = ${ce} AND role = 'mlc' LIMIT 2
  `, 'people.personal_email (mlc)');
  if (hit) return hit.ambiguous ? null : hit;

  // Prior registrations: only rows whose family_email still resolves to a
  // live profile (consolidation re-points these; a stale key must not
  // resurrect a deleted duplicate). The current registration is excluded —
  // its family_email is still '' at this point anyway, but be explicit.
  hit = pick(await sql`
    SELECT r.family_email FROM registrations r
    WHERE r.declined_at IS NULL
      AND r.family_email <> ''
      AND r.id <> ${regId}
      AND (LOWER(r.email) = ${ce} OR LOWER(r.family_email) = ${ce})
      AND EXISTS (SELECT 1 FROM member_profiles mp WHERE LOWER(mp.family_email) = LOWER(r.family_email))
    ORDER BY r.created_at DESC LIMIT 2
  `, 'prior registration');
  if (hit) return hit.ambiguous ? null : hit;

  return null;
}

// Derive the family's portal email from Main LC name + family surname — same
// convention as the Directory parse in api/sheets.js. Returns null if we can't
// build a plausible email (missing first name or family initial).
function deriveFamilyEmail(mainLcName, familyName) {
  const mlc = String(mainLcName || '').trim();
  const fam = String(familyName || '').trim();
  const firstFirst = mlc.split(/\s*[&\/,]\s*/)[0].trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  const lastInitial = fam.charAt(0).toLowerCase();
  if (!firstFirst || !lastInitial) return null;
  return firstFirst + lastInitial + '@rootsandwingsindy.com';
}

// Billing-sheet lookup tolerant of family-name drift (2026-07-11, Erin:
// Treasurer's Paid flag wasn't reconciling — the sheet says "Van Dyke" /
// "O'Connor Gading" while the registration derives "Dyke" / "Gading").
// Exact lowercase match first; otherwise a word-level containment match
// that must be UNIQUE — an ambiguous name must never auto-mark a family
// paid (that also fires the payment-received email).
function billingEntryFor(parsed, famName) {
  const target = String(famName || '').trim().toLowerCase();
  if (!target || !parsed || !parsed.families) return null;
  if (parsed.families[target]) return parsed.families[target];
  const targetWords = target.split(/[^a-z']+/).filter(Boolean);
  if (!targetWords.length) return null;
  const hits = [];
  for (const key of Object.keys(parsed.families)) {
    const keyWords = key.split(/[^a-z']+/).filter(Boolean);
    const contains = targetWords.every(w => keyWords.indexOf(w) !== -1)
      || (keyWords.length > 0 && keyWords.every(w => targetWords.indexOf(w) !== -1));
    if (contains) hits.push(parsed.families[key]);
  }
  return hits.length === 1 ? hits[0] : null;
}

// If existing_family_name was supplied, use it; otherwise take the last token
// of the Main LC's full name (matches the Directory convention).
function deriveFamilyName(mainLcName, existingFamilyName) {
  const existing = String(existingFamilyName || '').trim();
  if (existing) return existing;
  const mlc = String(mainLcName || '').trim();
  const words = mlc.split(/\s+/);
  return words[words.length - 1] || '';
}

// Candidate surnames for matching a registration to the Treasurer's
// Family Payment Tracking rows. The sheet is keyed by the Main LC's last
// name, but mixed-surname households sometimes land under the other
// parent's (backup coach's) or the kids' last name — a real prod miss on
// 2026-07-14. Order: MLC surname, derived/stated family name, then
// backup-coach and kid surnames. billingEntryFor's unique-match rule
// keeps the extra candidates from grabbing the wrong row. backupNames
// accepts strings or {name}/{person_name} objects; kids is the
// registrations.kids JSONB array.
function reconcileNameCandidates(reg, backupNames) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  const lastWord = (full) => {
    const words = String(full || '').trim().split(/\s+/);
    return words[words.length - 1] || '';
  };
  push(lastWord(reg.main_learning_coach));
  push(deriveFamilyName(reg.main_learning_coach, reg.existing_family_name));
  push(String(reg.existing_family_name || '').trim());
  (Array.isArray(backupNames) ? backupNames : []).forEach(b => {
    const n = (b && typeof b === 'object') ? (b.name || b.person_name) : b;
    push(lastWord(n));
  });
  const kids = Array.isArray(reg.kids) ? reg.kids : [];
  kids.forEach(k => push(k && k.last_name));
  return out;
}

// Build a kid's displayed "First Last" for the Morning Class Builder. Prefers
// the explicit first_name/last_name the registration stores (since b03fe12);
// falls back to the family surname when the row only has a bare first name, so
// a kid never renders without a last name. Older rows that carry a combined
// `name` with a space are kept verbatim (preserves compound surnames).
function morningKidDisplayName(k, familyName) {
  const rawName = String((k && (k.name || k.first_name)) || '').trim();
  if (!rawName) return '';
  const fam = String(familyName || '').trim();
  let display;
  if (k && (k.first_name || k.last_name)) {
    const kFirst = String(k.first_name || '').trim() || rawName.split(/\s+/)[0];
    const kLast = String(k.last_name || '').trim() || fam;
    display = (kFirst + (kLast ? ' ' + kLast : '')).trim();
  } else if (rawName.indexOf(' ') !== -1) {
    display = rawName;
  } else {
    display = (rawName + (fam ? ' ' + fam : '')).trim();
  }
  return display || rawName;
}

// Upsert a single parent's photo_consent. Used by the registration insert
// (Main LC's own choice) and the backup LC sign (co-parent's own choice).
// Writes against the `people` table. Match priority:
//   1. Existing person row by email (when parentEmail supplied + non-empty)
//   2. Existing person row by family_email + LOWER(first_name)
//   3. Insert a new row (only when parentEmail is supplied — people.email is PK)
async function upsertParentPhotoConsent(sql, familyEmail, familyName, parentFullName, photoConsent, parentEmail) {
  if (!familyEmail || !parentFullName) return;
  const parentFirst = String(parentFullName).trim().split(/\s+/)[0];
  if (!parentFirst) return;
  const parts = String(parentFullName).trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
  const email = String(parentEmail || '').trim().toLowerCase();

  // Ensure the family row exists so the FK on people resolves.
  await sql`
    INSERT INTO member_profiles (
      family_email, family_name, phone, address, parents, kids,
      placement_notes, updated_by
    ) VALUES (
      ${familyEmail}, ${familyName || ''}, '', '',
      '[]'::jsonb, '[]'::jsonb, '', 'waiver-sign'
    )
    ON CONFLICT (family_email) DO UPDATE SET
      family_name = COALESCE(NULLIF(member_profiles.family_name, ''), EXCLUDED.family_name),
      updated_at = NOW()
  `;

  // Match strategies (first hit wins). Update by people.id rather than
  // email because BLCs added via the portal often have NULL workspace
  // email — the personal email is their only contact field. Updating by
  // a NULL email column silently no-ops, which is the pre-fix bug.
  let targetId = null;
  if (email) {
    const byWsEmail = await sql`
      SELECT id FROM people
      WHERE LOWER(email) = ${email} AND family_email = ${familyEmail}
      LIMIT 1
    `;
    if (byWsEmail.length > 0) targetId = byWsEmail[0].id;
  }
  if (!targetId && email) {
    const byPersonalEmail = await sql`
      SELECT id FROM people
      WHERE LOWER(personal_email) = ${email} AND family_email = ${familyEmail}
      LIMIT 1
    `;
    if (byPersonalEmail.length > 0) targetId = byPersonalEmail[0].id;
  }
  if (!targetId) {
    // Match the goes-by nickname too (2026-07-16, Goodnight duplicate):
    // a waiver signed as "Cammie" must resolve to the stored legal
    // "Camm" row when "Cammie" is her nickname — otherwise the INSERT
    // fallback below fabricates an orphan person.
    const byName = await sql`
      SELECT id FROM people
      WHERE family_email = ${familyEmail}
        AND (LOWER(first_name) = ${firstName.toLowerCase()}
             OR LOWER(COALESCE(nickname, '')) = ${firstName.toLowerCase()})
      LIMIT 1
    `;
    if (byName.length > 0) targetId = byName[0].id;
  }
  if (targetId) {
    await sql`
      UPDATE people SET photo_consent = ${photoConsent}, updated_at = NOW(),
                        updated_by = 'waiver-sign'
      WHERE id = ${targetId}
    `;
    return;
  }

  // No matching row — insert one (requires an email to satisfy uniqueness)
  if (email) {
    await sql`
      INSERT INTO people (
        email, family_email, first_name, last_name, role,
        photo_consent, sort_order, updated_by
      ) VALUES (
        ${email}, ${familyEmail}, ${firstName}, ${lastName}, 'parent',
        ${photoConsent}, 99, 'waiver-sign'
      )
      ON CONFLICT (email) DO UPDATE SET
        photo_consent = EXCLUDED.photo_consent,
        updated_at = NOW(),
        updated_by = 'waiver-sign'
    `;
  }
  // No email available, no existing row by name → silently skip. Photo
  // consent for an unknown person can't be stored without an identity key.
}

// Comprehensive member_profiles upsert from a registration submission.
// Replaces the narrow upsertParentPhotoConsent path so kid data captured
// at registration (birth_date, schedule, last_name, allergies) shows up
// in Edit My Info instead of being discarded after the registrations
// row is saved.
//
// Merge semantics — registration is authoritative for what it provides;
// existing Edit My Info edits are preserved for fields registration
// doesn't touch:
//   - phone / address / placement_notes: write only if registration
//     supplied a non-empty value (preserves later EMI edits when a
//     family re-registers without updating those).
//   - parents: matched by lowercased first_name. Reg-provided fields
//     (role, photo_consent, last_name) overwrite; pronouns / photo_url /
//     personal_email / phone fall back to whatever's already there.
//     Existing parents not in this registration are kept as-is.
//   - kids: matched by lowercased name. Reg-provided fields (last_name,
//     birth_date, schedule, allergies, photo_consent) overwrite;
//     pronouns / photo_url fall back to existing. Existing kids not in
//     this registration are kept as-is.
async function upsertProfileFromRegistration(sql, params) {
  const familyEmail = String(params.familyEmail || '').toLowerCase();
  const familyName = String(params.familyName || '').trim();
  const mlcName = String(params.mlcName || '').trim();
  if (!familyEmail || !mlcName) return;

  function nameToParts(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  // Build the parent entries the registration knows about. The MLC name
  // string can hold multiple first names ("Erin & Joey Lee") — split them
  // into separate parent rows so a co-parent who isn't a backup coach
  // still surfaces on the family card.
  const newParents = [];
  const mlcChunks = mlcName.split(/\s*[&\/,]\s*/).map(s => s.trim()).filter(Boolean);
  // The last chunk carries the surname; earlier chunks are first-only.
  const lastChunk = mlcChunks[mlcChunks.length - 1] || '';
  const sharedSurname = nameToParts(lastChunk);
  const sharedLast = (sharedSurname && sharedSurname.last) || familyName || '';
  mlcChunks.forEach((chunk, idx) => {
    const isLastChunk = idx === mlcChunks.length - 1;
    const parts = isLastChunk ? sharedSurname : { first: chunk, last: sharedLast };
    if (!parts || !parts.first) return;
    newParents.push({
      name: parts.first + (parts.last ? ' ' + parts.last : ''),
      first_name: parts.first,
      last_name: parts.last || sharedLast,
      pronouns: '',
      photo_url: '',
      photo_consent: !!params.mlcPhotoConsent,
      role: idx === 0 ? 'mlc' : 'parent',
      email: '',
      // Don't auto-write personal_email from the registration form's
      // "Your email" field — for many people that's their workspace
      // address, which would clobber a real personal email if they ever
      // set one via Edit My Info. Let EMI own this field.
      personal_email: '',
      phone: ''
    });
  });
  // When the form sent explicit MLC first/last, use them verbatim for the
  // primary coach row instead of the parsed combined name (handles
  // multi-word first/last names cleanly).
  if (params.mlcFirstName && params.mlcLastName && newParents.length > 0) {
    newParents[0].first_name = params.mlcFirstName;
    newParents[0].last_name = params.mlcLastName;
    newParents[0].name = params.mlcFirstName + ' ' + params.mlcLastName;
  }
  (Array.isArray(params.backupCoaches) ? params.backupCoaches : []).forEach(bc => {
    if (!bc || !bc.name) return;
    const parts = nameToParts(bc.name);
    if (!parts) return;
    newParents.push({
      name: bc.name,
      first_name: parts.first,
      last_name: parts.last,
      pronouns: '',
      photo_url: '',
      photo_consent: true, // flips when the BLC signs the waiver
      role: 'blc',
      email: '',
      personal_email: String(bc.email || '').trim().toLowerCase(),
      phone: ''
    });
  });

  // Default per-kid schedule from the family-level `track` choice when
  // the kid object itself doesn't carry one (the public registration form
  // collects track once per family, not per child). Maps Morning Only →
  // morning, Afternoon Only → afternoon, Both → all-day; Other / unknown
  // leaves it empty for the family to set in Edit My Info.
  const trackToSchedule = {
    'morning only': 'morning',
    'afternoon only': 'afternoon',
    'both': 'all-day'
  };
  const defaultSchedule = trackToSchedule[String(params.track || '').toLowerCase()] || '';
  const rawKids = Array.isArray(params.kids) ? params.kids : [];
  const newKids = rawKids.map(k => {
    const sk = sanitizeKid(k);
    if (!sk) return null;
    if (!sk.schedule && defaultSchedule) sk.schedule = defaultSchedule;
    return sk;
  }).filter(Boolean);

  // Read existing people + kids so we can preserve unchanged entries
  // and merge field-level data when the same person re-registers.
  const exPeopleRows = await sql`
    SELECT email, first_name, last_name, nickname, role, personal_email, phone,
           pronouns, photo_url, photo_consent, nicknames, sort_order
    FROM people WHERE family_email = ${familyEmail}
    ORDER BY sort_order, id
  `;
  const exKidsRows = await sql`
    SELECT id, first_name, last_name, nickname, birth_date, pronouns, allergies,
           schedule, photo_url, photo_consent, sort_order
    FROM kids WHERE family_email = ${familyEmail}
    ORDER BY sort_order, id
  `;
  const exPeople = exPeopleRows;
  const exKids = exKidsRows;

  function firstKey(p) {
    const fn = String((p && p.first_name) || '').trim();
    if (fn) return fn.toLowerCase();
    const nm = String((p && p.name) || '').trim();
    return (nm.split(/\s+/)[0] || '').toLowerCase();
  }
  // Every first name an existing row answers to: the legal first name
  // plus the goes-by nickname (2026-07-16, Goodnight duplicate — a
  // family re-registering as "Cammie" must match the stored "Camm" row
  // instead of appending a second person).
  function answersTo(p) {
    const keys = [];
    const fk = firstKey(p);
    if (fk) keys.push(fk);
    const nick = String((p && p.nickname) || '').trim().toLowerCase();
    const nickFirst = nick.split(/\s+/)[0] || '';
    if (nickFirst && keys.indexOf(nickFirst) === -1) keys.push(nickFirst);
    return keys;
  }

  // Merge parents. Registration is authoritative for the fields it
  // supplies (role, photo_consent, last_name); existing values win for
  // pronouns / photo_url / personal_email / phone (preserves later EMI
  // edits when a family re-registers without updating those).
  const mergedParents = [];
  const matchedExParents = new Set();
  newParents.forEach(np => {
    const key = firstKey(np);
    if (!key) return;
    const ex = exPeople.find(p => !matchedExParents.has(p) && answersTo(p).indexOf(key) !== -1) || {};
    if (exPeople.indexOf(ex) !== -1) matchedExParents.add(ex);
    // When the match came through the goes-by nickname, the typed name is
    // a nickname — keep the stored legal first name rather than renaming.
    const matchedByNickname = ex.first_name && firstKey(ex) !== key;
    mergedParents.push({
      first_name: (matchedByNickname ? ex.first_name : np.first_name || ex.first_name) || '',
      last_name: np.last_name || ex.last_name || '',
      pronouns: ex.pronouns || np.pronouns || '',
      photo_url: ex.photo_url || np.photo_url || '',
      photo_consent: typeof np.photo_consent === 'boolean' ? np.photo_consent : (ex.photo_consent !== false),
      role: np.role || ex.role || 'parent',
      email: (ex.email || np.email || '').toLowerCase(),
      personal_email: np.personal_email || ex.personal_email || '',
      phone: ex.phone || np.phone || '',
      // Registration form doesn't collect nicknames or the display
      // nickname, so registration never overwrites existing ones —
      // they come from Edit My Info.
      nickname: ex.nickname || '',
      nicknames: Array.isArray(ex.nicknames) ? ex.nicknames : []
    });
  });
  exPeople.forEach(p => { if (!matchedExParents.has(p)) mergedParents.push(p); });

  // Merge kids by lowercased FIRST name. Same convention as before.
  function kidFirst(k) {
    if (!k) return '';
    // people-table rows store first_name; legacy registration kids store name
    return String((k.first_name || k.name) || '').trim().split(/\s+/)[0].toLowerCase();
  }
  function aggregateKidMatches(matches) {
    const out = {};
    matches.forEach(m => {
      if (!m) return;
      ['first_name', 'last_name', 'nickname', 'birth_date', 'pronouns', 'allergies',
       'schedule', 'photo_url'].forEach(field => {
        const v = m[field];
        if ((out[field] == null || out[field] === '') && v) out[field] = v;
      });
      if (m.photo_consent === false) out.photo_consent = false;
      else if (out.photo_consent == null) out.photo_consent = (m.photo_consent !== false);
    });
    return out;
  }
  // Same goes-by awareness as the parent merge: a kid registered under
  // their nickname must fold into the stored legal-name row.
  function kidAnswersTo(k) {
    const keys = [];
    const fk = kidFirst(k);
    if (fk) keys.push(fk);
    const nick = String((k && k.nickname) || '').trim().split(/\s+/)[0].toLowerCase();
    if (nick && keys.indexOf(nick) === -1) keys.push(nick);
    return keys;
  }
  const mergedKids = [];
  const matchedExKids = new Set();
  newKids.forEach(nk => {
    const key = kidFirst(nk);
    if (!key) return;
    // Matched-row exclusion (ship-gate 2026-07-19, mirrors the parent
    // merge): each existing row folds into AT MOST one registered kid, so
    // two distinct kids sharing a first name/nickname can't collapse into
    // one row (which deleted the other and cascaded its enrollments).
    const exMatches = exKids.filter(k => !matchedExKids.has(k) && kidAnswersTo(k).indexOf(key) !== -1);
    exMatches.forEach(k => matchedExKids.add(k));
    const ex = aggregateKidMatches(exMatches);
    const kidMatchedByNickname = ex.first_name && String(ex.first_name).trim().split(/\s+/)[0].toLowerCase() !== key;
    mergedKids.push({
      // Enrollment build (2026-07-19): carry the matched row's DB id so
      // the write below UPDATEs it in place (stable kids.id), and flag
      // that this kid IS in the current registration (→ 'enrolled'; the
      // carried-over priors appended after this loop are 'not_returning').
      _id: (exMatches[0] && exMatches[0].id) || null,
      _inReg: true,
      // Prefer the explicitly-entered first name; fall back to the first
      // token of the combined name for older clients. When the match came
      // through the goes-by nickname, keep the stored legal name.
      first_name: kidMatchedByNickname
        ? ex.first_name
        : (nk.first_name && nk.first_name.trim())
          ? nk.first_name.trim()
          : String(nk.name || '').trim().split(/\s+/)[0],
      last_name: nk.last_name || ex.last_name || '',
      // Registration doesn't collect the display nickname — preserve it.
      nickname: ex.nickname || '',
      birth_date: nk.birth_date || ex.birth_date || null,
      pronouns: nk.pronouns || ex.pronouns || '',
      allergies: nk.allergies || ex.allergies || '',
      schedule: nk.schedule || ex.schedule || 'all-day',
      photo_url: ex.photo_url || nk.photo_url || '',
      photo_consent: typeof nk.photo_consent === 'boolean' ? nk.photo_consent : (ex.photo_consent !== false)
    });
  });
  exKids.forEach(k => {
    if (!matchedExKids.has(k)) mergedKids.push(Object.assign({}, k, { _id: k.id, _inReg: false }));
  });

  const phone = String(params.phone || '').trim();
  const address = String(params.address || '').trim();
  const placementNotes = String(params.placementNotes || '').trim();

  // 1) UPSERT family-level row.
  const additionalEmails = Array.from(new Set(
    mergedParents
      .filter(p => p.role !== 'mlc' && p.email && p.email.toLowerCase() !== familyEmail)
      .map(p => p.email.toLowerCase())
  ));
  await sql`
    INSERT INTO member_profiles (
      family_email, family_name, phone, address, parents, kids,
      placement_notes, additional_emails, updated_by
    ) VALUES (
      ${familyEmail}, ${familyName}, ${phone}, ${address},
      '[]'::jsonb, '[]'::jsonb,
      ${placementNotes}, ${additionalEmails}::text[], 'registration'
    )
    ON CONFLICT (family_email) DO UPDATE SET
      family_name       = COALESCE(NULLIF(EXCLUDED.family_name, ''), member_profiles.family_name),
      phone             = COALESCE(NULLIF(EXCLUDED.phone, ''), member_profiles.phone),
      address           = COALESCE(NULLIF(EXCLUDED.address, ''), member_profiles.address),
      placement_notes   = COALESCE(NULLIF(EXCLUDED.placement_notes, ''), member_profiles.placement_notes),
      additional_emails = EXCLUDED.additional_emails,
      updated_at        = NOW(),
      updated_by        = 'registration'
  `;

  // 2) Replace people wholesale; UPSERT kids by identity (enrollment
  // build, 2026-07-19). kids.id must survive every save — kid_enrollments
  // FKs it, and the old delete+reinsert also silently dropped class_group
  // placements on every re-registration. Matched rows UPDATE in place
  // (class_group untouched → preserved), unmatched insert, and rows that
  // matched nothing are deleted (mergedKids already carries every
  // existing row, so that only fires on duplicate-name leftovers).
  await sql`DELETE FROM people WHERE family_email = ${familyEmail}`;

  for (let i = 0; i < mergedParents.length; i++) {
    const pp = mergedParents[i];
    if (!pp.first_name) continue;
    let email = String(pp.email || '').trim().toLowerCase();
    if (!email && pp.role === 'mlc') email = familyEmail;
    await sql`
      INSERT INTO people (
        email, family_email, first_name, last_name, nickname, role,
        personal_email, phone, pronouns, photo_url, photo_consent,
        nicknames, sort_order, updated_by
      ) VALUES (
        ${email || null}, ${familyEmail}, ${pp.first_name}, ${pp.last_name || ''}, ${pp.nickname || ''}, ${pp.role || 'parent'},
        ${pp.personal_email || ''}, ${pp.phone || ''}, ${pp.pronouns || ''},
        ${pp.photo_url || ''}, ${pp.photo_consent !== false},
        ${JSON.stringify(pp.nicknames || [])}::jsonb, ${i}, 'registration'
      )
    `;
  }
  const keptKidIds = [];
  const enrollmentEntries = [];
  for (let i = 0; i < mergedKids.length; i++) {
    const k = mergedKids[i];
    if (!k.first_name) continue;
    let kidId = k._id || null;
    if (kidId) {
      await sql`
        UPDATE kids SET
          first_name = ${k.first_name}, last_name = ${k.last_name || ''},
          nickname = ${k.nickname || ''}, birth_date = ${k.birth_date || null},
          pronouns = ${k.pronouns || ''}, allergies = ${k.allergies || ''},
          schedule = ${k.schedule || 'all-day'}, photo_url = ${k.photo_url || ''},
          photo_consent = ${k.photo_consent !== false}, sort_order = ${i},
          updated_at = NOW()
        WHERE id = ${kidId}
      `;
    } else {
      const ins = await sql`
        INSERT INTO kids (
          family_email, first_name, last_name, nickname, birth_date,
          pronouns, allergies, schedule, photo_url, photo_consent,
          sort_order
        ) VALUES (
          ${familyEmail}, ${k.first_name}, ${k.last_name || ''}, ${k.nickname || ''},
          ${k.birth_date || null}, ${k.pronouns || ''}, ${k.allergies || ''},
          ${k.schedule || 'all-day'}, ${k.photo_url || ''}, ${k.photo_consent !== false},
          ${i}
        ) RETURNING id
      `;
      kidId = ins[0].id;
    }
    keptKidIds.push(kidId);
    enrollmentEntries.push({
      kid_id: kidId,
      first_name: k.first_name,
      schedule: ['all-day', 'morning', 'afternoon'].indexOf(String(k.schedule || '').toLowerCase()) !== -1 ? String(k.schedule).toLowerCase() : 'all-day',
      status: k._inReg ? 'enrolled' : 'not_returning'
    });
  }
  if (keptKidIds.length > 0) {
    await sql`DELETE FROM kids WHERE family_email = ${familyEmail} AND NOT (id = ANY(${keptKidIds}::int[]))`;
  } else {
    await sql`DELETE FROM kids WHERE family_email = ${familyEmail}`;
  }

  // 3) Season enrollment truth: one row per kid per season. Kids in THIS
  // registration → enrolled with their (track-derived or per-kid)
  // schedule; prior kids the family did NOT re-register → not_returning
  // for the season (row kept, kid stays visible — Erin's rule). Non-fatal:
  // a registration must never fail on enrollment bookkeeping.
  try {
    const season = String(params.season || DEFAULT_SEASON);
    await upsertKidEnrollments(sql, familyEmail, season, enrollmentEntries, 'registration', 'registration');
  } catch (enrErr) {
    console.error('kid_enrollments write failed (non-fatal):', enrErr);
  }
}

// Upsert one kid_enrollments row per entry ({kid_id, first_name,
// schedule, status}) for the season. Shared by the registration writer,
// the EMI writer, and (semantics-wise) the backfill script.
async function upsertKidEnrollments(sql, familyEmail, season, entries, source, updatedBy) {
  for (const e of entries) {
    if (!e || !e.kid_id) continue;
    await sql`
      INSERT INTO kid_enrollments (
        kid_id, family_email, kid_first_name, season, schedule, status, source, updated_by
      ) VALUES (
        ${e.kid_id}, ${familyEmail}, ${e.first_name || ''}, ${season},
        ${e.schedule || 'all-day'}, ${e.status || 'enrolled'}, ${source}, ${updatedBy}
      )
      ON CONFLICT (kid_id, season) DO UPDATE SET
        family_email = EXCLUDED.family_email,
        kid_first_name = EXCLUDED.kid_first_name,
        schedule = EXCLUDED.schedule,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
    `;
  }
}

function sanitizeKid(k) {
  if (!k || typeof k !== 'object') return null;
  const name = String(k.name || '').trim().slice(0, 200);
  if (!name) return null;
  const first_name = String(k.first_name || '').trim().slice(0, 100);
  const last_name = String(k.last_name || '').trim().slice(0, 100);
  const birth_date = String(k.birth_date || '').trim();
  let bd = '';
  if (birth_date && /^\d{4}-\d{2}-\d{2}$/.test(birth_date)) bd = birth_date;
  const schedule = String(k.schedule || '').trim().toLowerCase();
  let sch = '';
  if (['all-day', 'morning', 'afternoon'].indexOf(schedule) !== -1) sch = schedule;
  // DB row id, when the client has one (EMI sends it since the enrollment
  // build) — lets the writers UPDATE the existing row instead of re-minting.
  const idNum = parseInt(k.id, 10);
  return {
    id: Number.isFinite(idNum) && idNum > 0 ? idNum : null,
    name,
    first_name,
    last_name,
    nickname: String(k.nickname || '').trim().slice(0, 60),
    birth_date: bd,
    pronouns: String(k.pronouns || '').trim().slice(0, 60),
    allergies: String(k.allergies || '').trim().slice(0, 500),
    schedule: sch,
    photo_url: String(k.photo_url || '').trim().slice(0, 500),
    // Per-child photo opt-out from the waiver. Default consent = true; families
    // flip this off to block photo use across the portal and public site.
    photo_consent: k.photo_consent !== false
  };
}

// Owner: the JWT'd Workspace email MUST equal the family_email, OR appear in
// the family's additional_emails (a co-parent), OR the caller is one of
// the app-wide super users (communications@ / vicepresident@). The
// co-parent path requires a DB lookup.
async function canEditFamily(sql, userEmail, familyEmail) {
  const u = normalizeEmail(userEmail);
  const f = normalizeEmail(familyEmail);
  if (!u || !f) return false;
  if (isSuperUser(u)) return true;
  if (u === f) return true;
  return canActAs(sql, u, f);
}

async function handleProfileGet(req, res) {
  // View-As aware: user.email is the effective family identity (the
  // impersonated family for a super user / dev tester).
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const familyEmail = normalizeEmail(req.query.family_email);
  if (!familyEmail) return res.status(400).json({ error: 'family_email required' });

  const sql = getSql();
  if (!(await canEditFamily(sql, user.email, familyEmail))) {
    return res.status(403).json({ error: 'You can only view/edit your own family.' });
  }
  try {
    const famRows = await sql`
      SELECT family_email, family_name, phone, address,
             placement_notes, additional_emails, alt_logins, updated_at, updated_by
      FROM member_profiles
      WHERE family_email = ${familyEmail}
      LIMIT 1
    `;
    if (famRows.length === 0) {
      return res.status(200).json({ profile: null, family_email: familyEmail });
    }
    const peopleRows = await sql`
      SELECT email, first_name, last_name, nickname, role, personal_email, phone,
             pronouns, photo_url, photo_consent, nicknames, sort_order
      FROM people WHERE family_email = ${familyEmail}
      ORDER BY sort_order, id
    `;
    const kidsRows = await sql`
      SELECT id, first_name, last_name, nickname, birth_date,
             pronouns, allergies, schedule, photo_url, photo_consent, sort_order
      FROM kids WHERE family_email = ${familyEmail}
      ORDER BY sort_order, id
    `;
    // EMI form expects `people` and `kids` arrays. The legacy `parents`
    // alias is included so a stale browser tab from before the cutover
    // still finds something to render.
    const profile = Object.assign({}, famRows[0], {
      people: peopleRows,
      kids: kidsRows,
      parents: peopleRows
    });
    return res.status(200).json({ profile });
  } catch (err) {
    console.error('Profile GET error:', err);
    return res.status(500).json({ error: 'Could not load profile.' });
  }
}

async function handleProfileUpdate(body, req, res) {
  // View-As aware: user.email is the EFFECTIVE family identity (the
  // impersonated family for a super user / dev tester), used for the
  // canEditFamily gate. user.realEmail is the actual signed-in user,
  // used for the updated_by / sent_by audit columns below.
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const familyEmail = normalizeEmail(body.family_email);
  if (!familyEmail) return res.status(400).json({ error: 'family_email required' });

  const sql = getSql();
  if (!(await canEditFamily(sql, user.email, familyEmail))) {
    return res.status(403).json({ error: 'You can only edit your own family.' });
  }

  const familyName = String(body.family_name || '').trim().slice(0, 100);
  if (!familyName) return res.status(400).json({ error: 'family_name required' });

  const phone = String(body.phone || '').trim().slice(0, 50);
  const address = String(body.address || '').trim().slice(0, 500);

  // The frontend now sends `body.people`; tolerate the legacy `body.parents`
  // shape too so a stale browser tab from before the cutover doesn't 500.
  const peopleRaw = Array.isArray(body.people) ? body.people
                  : Array.isArray(body.parents) ? body.parents : [];
  const kidsRaw = Array.isArray(body.kids) ? body.kids : [];
  if (peopleRaw.length > 6) return res.status(400).json({ error: 'Too many parents.' });
  if (kidsRaw.length > 12) return res.status(400).json({ error: 'Too many kids.' });

  const people = peopleRaw.map(sanitizeParent).filter(Boolean);
  const kids = kidsRaw.map(sanitizeKid).filter(Boolean);

  // The MLC's email defaults to the family_email if the form didn't supply
  // one (the EMI input is read-only for the MLC). All other people keep
  // whatever they have, even if blank — schema allows email = NULL.
  let mlcSeen = false;
  for (const pp of people) {
    if (pp.role === 'mlc') {
      if (mlcSeen) return res.status(400).json({ error: 'Only one MLC per family.' });
      mlcSeen = true;
      if (!pp.email) pp.email = familyEmail;
    }
  }

  // BLCs must have a personal email — that's where their waiver signing
  // link is sent. Workspace email stays optional (R&W only provisions
  // BLC Workspace accounts on request). Caught here rather than in
  // sanitizeParent so the Main LC sees a single clear validation message.
  for (const pp of people) {
    if (pp.role === 'blc' && !pp.personal_email) {
      return res.status(400).json({
        error: 'A Back Up Learning Coach needs a personal email so we can send them the waiver to sign.'
      });
    }
  }

  try {
    // placement_notes is intentionally not touched here — it's collected
    // at registration only and the Edit My Info form no longer exposes
    // it. New profiles default to '' from the column default; existing
    // values are preserved across updates.
    //
    // additional_emails is the alternate-login set resolveFamily falls back
    // to when a sign-in email matches neither the primary family_email nor a
    // people row. It carries (a) co-parent Workspace emails, auto-derived
    // here, and (b) super-user-registered alternate logins for the PRIMARY
    // account holder whose real @rootsandwingsindy.com address doesn't match
    // the auto-generated family_email — the only way such a member can log in
    // (the family_email PK is wired into ~30 tables and is NOT renamed).
    //
    // Derived co-parent emails are unioned with the EXISTING stored set so a
    // routine family save never drops a super-user-added alternate. A super
    // user editing the family can pass `additional_logins` to set the manual
    // portion authoritatively (add or prune); non-super saves are additive.
    const derivedEmails = people
      .filter(p => p.role !== 'mlc' && p.email && p.email.toLowerCase() !== familyEmail)
      .map(p => p.email.toLowerCase());
    // alt_logins is the sticky super-user set. A routine family save leaves it
    // exactly as stored; only a super user passing `additional_logins` changes
    // it (add or prune). additional_emails is then the union of the ephemeral
    // co-parent mirror and alt_logins — so removing a co-parent still revokes
    // their login (they drop out of derivedEmails) while a super-user-added
    // alternate persists in alt_logins.
    const priorRows = await sql`SELECT alt_logins FROM member_profiles WHERE family_email = ${familyEmail} LIMIT 1`;
    const priorAlt = (priorRows[0] && Array.isArray(priorRows[0].alt_logins))
      ? priorRows[0].alt_logins.map(e => String(e || '').toLowerCase()).filter(Boolean)
      : [];
    const requesterIsSuper = isSuperUser(user.realEmail || user.email);
    let altLogins = priorAlt;
    if (requesterIsSuper && Array.isArray(body.additional_logins)) {
      // Only on-domain Workspace addresses can actually authenticate
      // (verifyWorkspaceAuth gates on ALLOWED_DOMAIN), so silently drop
      // anything that couldn't ever log in. Exclude the primary itself.
      altLogins = Array.from(new Set(
        body.additional_logins
          .map(e => normalizeEmail(e))
          .filter(e => e && e.endsWith('@' + ALLOWED_DOMAIN) && e !== familyEmail)
      ));
    }
    const additionalEmails = Array.from(new Set(derivedEmails.concat(altLogins)));
    await sql`
      INSERT INTO member_profiles (
        family_email, family_name, phone, address, parents, kids,
        additional_emails, alt_logins, updated_by
      ) VALUES (
        ${familyEmail}, ${familyName}, ${phone}, ${address},
        '[]'::jsonb, '[]'::jsonb,
        ${additionalEmails}::text[], ${altLogins}::text[], ${user.realEmail || user.email}
      )
      ON CONFLICT (family_email) DO UPDATE SET
        family_name = EXCLUDED.family_name,
        phone = EXCLUDED.phone,
        address = EXCLUDED.address,
        additional_emails = EXCLUDED.additional_emails,
        alt_logins = EXCLUDED.alt_logins,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
    `;

    // Replace the family's people + kids wholesale. The EMI form sends
    // the full set every save, so DELETE + INSERT is the simplest correct
    // semantics — anything the user removed from the form goes away.
    //
    // EXCEPTION: class_group is assigned by the VP / at registration, NOT by
    // this form. Snapshot each kid's class_group before the delete and carry
    // it forward (matched by first name) on re-insert. Without this, every
    // profile save silently wiped class_group, dropping the kid out of the
    // directory's class/group sections (their card vanished entirely).
    const priorKidGroups = {};
    const priorKidNames = new Set();
    const priorKidSchedules = {};
    const priorKidIdsByFirst = {};
    const priorKidIds = new Set();
    const priorSchedById = {};
    try {
      const priorKids = await sql`SELECT id, first_name, class_group, schedule FROM kids WHERE family_email = ${familyEmail}`;
      priorKids.forEach(r => {
        const key = String(r.first_name || '').trim().toLowerCase();
        if (key && r.class_group) priorKidGroups[key] = r.class_group;
        if (key) priorKidNames.add(key);
        if (key) priorKidSchedules[key] = String(r.schedule || '').trim().toLowerCase() || 'all-day';
        if (key && !(key in priorKidIdsByFirst)) priorKidIdsByFirst[key] = r.id;
        priorKidIds.add(r.id);
        priorSchedById[r.id] = String(r.schedule || '').trim().toLowerCase() || 'all-day';
      });
    } catch (e) { /* non-fatal — worst case the group is blank, same as before */ }

    // Schedule is dues-bearing (half-day vs full-day), so switching an
    // EXISTING kid's schedule needs the member_schedule_edit capability
    // (Membership Director by default) or super user — checked on the
    // REAL login, not the impersonated family. New kids pass through
    // (registration sets their schedule). A blank incoming value means
    // "keep what they had" so stale clients can never flip anyone.
    const scheduleSwitchedToMorning = [];
    // Option B approval queue (Erin, 2026-07-19): unprivileged schedule
    // changes DON'T apply — they become pending enrollment_change_requests
    // for the Membership Director, and the live schedule stays put. The
    // Membership Director (member_schedule_edit) + super users still edit
    // directly. (This replaces both the old 403 AND the short-lived
    // blanket dev unlock — the request path is what testers exercise now.)
    const queuedRequests = []; // filled below; written after the transaction
    let actorMayEditDirect = null;
    const actorMayEdit = async () => {
      if (actorMayEditDirect === null) {
        const realEmail0 = user.realEmail || user.email;
        // Impersonation acts AS the family (bug #22): a privileged login
        // using View As follows the member path — schedule changes,
        // adds, and removals QUEUE for approval instead of applying
        // silently. And direct-edit privilege belongs to the Membership
        // Director capability ONLY — supers are deliberately NOT exempt
        // (Erin, 2026-07-19: the VP's direct edit skipped every approval
        // flow; the rule is ANY schedule change gets Membership's
        // approval, and supers can approve their own queue entry).
        const impersonating = user.realEmail
          && String(user.realEmail).toLowerCase() !== String(user.email || '').toLowerCase();
        actorMayEditDirect = !impersonating
          && (await hasCapability(realEmail0, 'member_schedule_edit'));
      }
      return actorMayEditDirect;
    };
    {
      const realEmail = user.realEmail || user.email;
      let mayEditSchedule = null; // resolved lazily — most saves change nothing
      for (const k of kids) {
        // Same name key as priorKidGroups: kids.first_name stores the
        // EMI "name" field verbatim. The DB id wins when the client sent
        // one (ship-gate 2026-07-19: a rename + schedule change in one
        // save otherwise misses the prior row and bypasses the queue).
        const key = String(k.name || '').trim().toLowerCase();
        const prior = (k.id && priorSchedById[k.id]) || priorKidSchedules[key];
        if (!prior) continue;               // new kid — no prior to protect
        if (!k.schedule) { k.schedule = prior; continue; }
        if (k.schedule === prior) continue;
        if (mayEditSchedule === null) mayEditSchedule = await actorMayEdit();
        if (!mayEditSchedule) {
          // Option B: queue the change for Membership approval and keep
          // the LIVE schedule as-is (dues + rosters move only on approve).
          queuedRequests.push({
            kind: 'schedule_change',
            kid_id: (k.id && priorSchedById[k.id]) ? k.id : null,
            nameKey: key,
            first_name: String(k.name || '').trim(),
            requested_schedule: k.schedule,
            prior_schedule: prior
          });
          k.schedule = prior;
          continue;
        }
        if (k.schedule === 'morning') scheduleSwitchedToMorning.push(key);
      }
    }
    // Atomic write (2026-07-17 review; reshaped 2026-07-19 enrollment
    // build): people still replace wholesale, but kids UPSERT by identity
    // so kids.id survives every save — kid_enrollments FKs it, and the
    // old delete+reinsert re-minted ids (and needed the fragile name-keyed
    // class_group/schedule carry). Matching: the client-sent kids.id
    // (threaded through EMI since the enrollment build), else the prior
    // row with the same first name. Everything still rides ONE
    // transaction — a failing statement changes nothing.
    const profileStmts = [
      sql`DELETE FROM people WHERE family_email = ${familyEmail}`
    ];
    for (let i = 0; i < people.length; i++) {
      const pp = people[i];
      profileStmts.push(sql`
        INSERT INTO people (
          email, family_email, first_name, last_name, nickname, role,
          personal_email, phone, pronouns, photo_url, photo_consent,
          nicknames, sort_order, updated_by
        ) VALUES (
          ${pp.email || null}, ${familyEmail}, ${pp.first_name}, ${pp.last_name}, ${pp.nickname || ''}, ${pp.role || 'parent'},
          ${pp.personal_email || ''}, ${pp.phone || ''}, ${pp.pronouns || ''},
          ${pp.photo_url || ''}, ${pp.photo_consent !== false},
          ${JSON.stringify(pp.nicknames || [])}::jsonb, ${i}, ${user.realEmail || user.email}
        )
      `);
    }
    const usedKidIds = new Set();
    const addedKidNames = []; // lowercased first-name keys of brand-new rows
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const nameKey = String(k.name || '').trim().toLowerCase();
      // Carry forward the VP-assigned class group for NEW rows only —
      // updates leave class_group untouched (preserved by not listing it).
      const kidGroup = priorKidGroups[nameKey] || '';
      let matchId = null;
      if (k.id && priorKidIds.has(k.id) && !usedKidIds.has(k.id)) {
        matchId = k.id;
      } else if (priorKidIdsByFirst[nameKey] && !usedKidIds.has(priorKidIdsByFirst[nameKey])) {
        matchId = priorKidIdsByFirst[nameKey];
      }
      if (matchId) {
        usedKidIds.add(matchId);
        profileStmts.push(sql`
          UPDATE kids SET
            first_name = ${k.name}, last_name = ${k.last_name || ''},
            nickname = ${k.nickname || ''}, birth_date = ${k.birth_date || null},
            pronouns = ${k.pronouns || ''}, allergies = ${k.allergies || ''},
            schedule = ${k.schedule || 'all-day'}, photo_url = ${k.photo_url || ''},
            photo_consent = ${k.photo_consent !== false}, sort_order = ${i},
            updated_at = NOW()
          WHERE id = ${matchId}
        `);
      } else {
        addedKidNames.push(nameKey);
        profileStmts.push(sql`
          INSERT INTO kids (
            family_email, first_name, last_name, nickname, birth_date,
            pronouns, allergies, schedule, photo_url, photo_consent,
            sort_order, class_group
          ) VALUES (
            ${familyEmail}, ${k.name}, ${k.last_name || ''}, ${k.nickname || ''},
            ${k.birth_date || null}, ${k.pronouns || ''}, ${k.allergies || ''},
            ${k.schedule || 'all-day'}, ${k.photo_url || ''}, ${k.photo_consent !== false},
            ${i}, ${kidGroup}
          )
        `);
      }
    }
    // Rows the family removed from the form. Privileged actors delete
    // directly (enrollments cascade); families queue a remove_kid request
    // and the kid STAYS until Membership approves (Option B).
    const removedIds = [...priorKidIds].filter(id => !usedKidIds.has(id));
    if (removedIds.length > 0) {
      if (await actorMayEdit()) {
        profileStmts.push(sql`DELETE FROM kids WHERE family_email = ${familyEmail} AND id = ANY(${removedIds}::int[])`);
      } else {
        const firstById = {};
        Object.keys(priorKidIdsByFirst).forEach(f => { firstById[priorKidIdsByFirst[f]] = f; });
        removedIds.forEach(idr => queuedRequests.push({
          kind: 'remove_kid', kid_id: idr, first_name: firstById[idr] || ''
        }));
      }
    }
    await sql.transaction(profileStmts);

    // Season enrollment truth for the ACTIVE season (enrollment build):
    // schedule updates ride through; status is only ever CREATED here —
    // 'enrolled' for privileged adds, 'pending' for family adds awaiting
    // Membership approval (Option B) — and never flipped for existing
    // rows (a save must not resurrect a not_returning kid). Non-fatal.
    const createdRequests = [];
    try {
      const privileged = await actorMayEdit();
      const pendingAddNames = new Set(privileged ? [] : addedKidNames);
      const nowKids = await sql`SELECT id, first_name, schedule FROM kids WHERE family_email = ${familyEmail}`;
      // Genuinely-NEW rows only (id not present before this save) — a
      // same-first-name sibling must never absorb the add request or the
      // pending flag (ship-gate 2026-07-19: deny would then delete the
      // enrolled sibling).
      const newIdByFirst = {};
      for (const nk of nowKids) {
        if (priorKidIds.has(nk.id)) continue;
        const fl = String(nk.first_name || '').trim().toLowerCase();
        if (fl && !(fl in newIdByFirst)) newIdByFirst[fl] = nk.id;
      }
      for (const nk of nowKids) {
        const firstLc = String(nk.first_name || '').trim().toLowerCase();
        const sch = ['all-day', 'morning', 'afternoon'].indexOf(String(nk.schedule || '').toLowerCase()) !== -1
          ? String(nk.schedule).toLowerCase() : 'all-day';
        const newStatus = (!priorKidIds.has(nk.id) && pendingAddNames.has(firstLc)) ? 'pending' : 'enrolled';
        await sql`
          INSERT INTO kid_enrollments (
            kid_id, family_email, kid_first_name, season, schedule, status, source, updated_by
          ) VALUES (
            ${nk.id}, ${familyEmail}, ${nk.first_name || ''}, ${DEFAULT_SEASON},
            ${sch}, ${newStatus}, 'emi', ${user.realEmail || user.email}
          )
          ON CONFLICT (kid_id, season) DO UPDATE SET
            schedule = EXCLUDED.schedule,
            kid_first_name = EXCLUDED.kid_first_name,
            family_email = EXCLUDED.family_email,
            source = 'emi',
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        `;
      }

      // Family adds queue an add_kid request WITH a waiver the adult signs
      // (Erin: "they need to do the entire registration" — same agreement
      // the registration form collects, one signature per added child).
      if (!privileged) {
        const mlcRow = people.filter(p => p.role === 'mlc')[0] || {};
        const mlcName = ((mlcRow.first_name || '') + ' ' + (mlcRow.last_name || '')).trim() || familyName;
        for (const nameKey of addedKidNames) {
          const kidId = newIdByFirst[nameKey];
          if (!kidId) continue;
          const dupe = await sql`
            SELECT id FROM enrollment_change_requests
            WHERE kid_id = ${kidId} AND kind = 'add_kid' AND status = 'pending' AND season = ${DEFAULT_SEASON}
          `;
          if (dupe.length) continue;
          const kidRow = kids.filter(k => String(k.name || '').trim().toLowerCase() === nameKey)[0] || {};
          const reg = await sql`
            SELECT id FROM registrations
            WHERE LOWER(family_email) = LOWER(${familyEmail}) AND season = ${DEFAULT_SEASON} AND declined_at IS NULL
            ORDER BY created_at DESC LIMIT 1
          `;
          const wvToken = crypto.randomUUID().replace(/-/g, '');
          const wv = await sql`
            INSERT INTO waiver_signatures (
              season, role, person_name, person_email, family_email, registration_id,
              pending_token, sent_at, sent_by_email, note
            ) VALUES (
              ${DEFAULT_SEASON}, 'kid_addition', ${mlcName}, ${familyEmail}, ${familyEmail},
              ${reg.length ? reg[0].id : null}, ${wvToken}, NOW(), ${user.realEmail || user.email},
              ${'Covers newly added child: ' + (kidRow.name || nameKey)}
            ) RETURNING id
          `;
          const ins = await sql`
            INSERT INTO enrollment_change_requests (
              kind, kid_id, family_email, kid_first_name, season,
              requested_schedule, prior_schedule, waiver_signature_id, requested_by
            ) VALUES (
              'add_kid', ${kidId}, ${familyEmail}, ${kidRow.name || nameKey}, ${DEFAULT_SEASON},
              ${kidRow.schedule || 'all-day'}, '', ${wv[0].id}, ${user.realEmail || user.email}
            ) RETURNING id
          `;
          createdRequests.push({ id: ins[0].id, kind: 'add_kid', kid_first_name: kidRow.name || nameKey, waiver_token: wvToken });
        }

        // Schedule changes + removals queued during the write loop.
        for (const q of queuedRequests) {
          const kidId = q.kid_id || priorKidIdsByFirst[q.nameKey] || null;
          if (!kidId) continue;
          const dupe = q.kind === 'schedule_change'
            ? await sql`SELECT id FROM enrollment_change_requests
                        WHERE kid_id = ${kidId} AND kind = 'schedule_change' AND status = 'pending'
                          AND season = ${DEFAULT_SEASON} AND requested_schedule = ${q.requested_schedule}`
            : await sql`SELECT id FROM enrollment_change_requests
                        WHERE kid_id = ${kidId} AND kind = ${q.kind} AND status = 'pending' AND season = ${DEFAULT_SEASON}`;
          if (dupe.length) continue;
          const ins = await sql`
            INSERT INTO enrollment_change_requests (
              kind, kid_id, family_email, kid_first_name, season,
              requested_schedule, prior_schedule, requested_by
            ) VALUES (
              ${q.kind}, ${kidId}, ${familyEmail}, ${q.first_name || q.nameKey || ''}, ${DEFAULT_SEASON},
              ${q.requested_schedule || ''}, ${q.prior_schedule || ''}, ${user.realEmail || user.email}
            ) RETURNING id
          `;
          createdRequests.push({ id: ins[0].id, kind: q.kind, kid_first_name: q.first_name || q.nameKey || '' });
        }

        if (createdRequests.length > 0) {
          const summary = createdRequests.map(r =>
            (r.kind === 'add_kid' ? 'add ' : r.kind === 'remove_kid' ? 'remove ' : 'schedule change for ') + r.kid_first_name
          ).join(', ');
          await notifyMembershipDirector(sql,
            'Enrollment approval needed — ' + familyName,
            'The ' + familyName + ' family requested: ' + summary + '. Review it in the Enrollment Requests queue.');
        }
      } else {
        // Privileged adds enroll directly — but the child's waiver is
        // STILL required (Erin, 2026-07-19: this path silently skipped
        // it, which is why the waiver felt missable). Create the pending
        // kid_addition waiver, tell the family, and hand the token back
        // so the client can open the signing page. Comms' waiver To Do +
        // the My Family gold banner chase any unsigned stragglers.
        for (const nameKey of addedKidNames) {
          const kidId = newIdByFirst[nameKey];
          if (!kidId) continue;
          const kidRow2 = kids.filter(k => String(k.name || '').trim().toLowerCase() === nameKey)[0] || {};
          const kidLabel = kidRow2.name || nameKey;
          const dupeWv = await sql`
            SELECT id FROM waiver_signatures
            WHERE season = ${DEFAULT_SEASON} AND role = 'kid_addition'
              AND LOWER(family_email) = LOWER(${familyEmail})
              AND note = ${'Covers newly added child: ' + kidLabel}
          `;
          if (dupeWv.length) continue;
          const mlcRow2 = people.filter(p => p.role === 'mlc')[0] || {};
          const mlcName2 = ((mlcRow2.first_name || '') + ' ' + (mlcRow2.last_name || '')).trim() || familyName;
          const reg2 = await sql`
            SELECT id FROM registrations
            WHERE LOWER(family_email) = LOWER(${familyEmail}) AND season = ${DEFAULT_SEASON} AND declined_at IS NULL
            ORDER BY created_at DESC LIMIT 1
          `;
          const wvToken2 = crypto.randomUUID().replace(/-/g, '');
          await sql`
            INSERT INTO waiver_signatures (
              season, role, person_name, person_email, family_email, registration_id,
              pending_token, sent_at, sent_by_email, note
            ) VALUES (
              ${DEFAULT_SEASON}, 'kid_addition', ${mlcName2}, ${familyEmail}, ${familyEmail},
              ${reg2.length ? reg2[0].id : null}, ${wvToken2}, NOW(), ${user.realEmail || user.email},
              ${'Covers newly added child: ' + kidLabel}
            )
          `;
          await notifyEnrollment(sql, familyEmail,
            'Waiver needed: ' + kidLabel,
            'A waiver signature is needed for ' + kidLabel + ' — sign it from the gold banner on your My Family page.');
          createdRequests.push({ kind: 'waiver_only', kid_first_name: kidLabel, waiver_token: wvToken2 });
        }
      }
    } catch (enrErr) {
      console.error('EMI kid_enrollments sync failed (non-fatal):', enrErr);
    }

    // Keep the family's registration TRACK in step with the kids' live
    // schedules (Erin, 2026-07-17: the Membership Report + PM-only labels
    // read registrations.track, which an EMI schedule switch never updated —
    // so an AM/PM-only → full-day change didn't show). Track is family-level:
    // Both if the family does mornings AND afternoons, else the one side.
    // Best-effort; matched on the stored family key (populated for
    // registrations from 2026-07-17 onward).
    try {
      const sched = k => String(k && k.schedule || '').toLowerCase();
      const hasAM = kids.some(k => sched(k) === 'all-day' || sched(k) === 'morning');
      const hasPM = kids.some(k => sched(k) === 'all-day' || sched(k) === 'afternoon');
      const newTrack = (hasAM && hasPM) ? 'Both' : hasAM ? 'Morning Only' : hasPM ? 'Afternoon Only' : '';
      if (newTrack) {
        await sql`
          UPDATE registrations SET track = ${newTrack}, updated_at = NOW()
          WHERE LOWER(family_email) = LOWER(${familyEmail}) AND declined_at IS NULL
        `;
      }
    } catch (trkErr) {
      console.error('EMI → registration track sync (non-fatal):', trkErr);
    }

    // Afternoon class-signup picks are keyed by (family_email,
    // kid_first_name) — kids.id isn't stable across this delete+reinsert.
    // A rename would orphan the kid's saved picks (they'd surface as a
    // phantom student under the old name, e.g. "Test Family" 2026-07-15).
    // Exactly one name out + one name in = a rename: carry the picks to
    // the new name. Anything else that vanished (kid removed, ambiguous
    // multi-rename) gets its current-year picks cleaned up instead.
    try {
      // Option B guard (ship-gate blocker, 2026-07-19): when this save
      // QUEUED requests instead of applying (family removals/schedule
      // changes), the kids are all still here — running the name-diff
      // cleanup would delete a queued-removal kid's picks immediately,
      // and a remove+add pair would masquerade as a rename. Approval
      // does its own cleanup; skip the heuristics entirely.
      if (queuedRequests.length > 0) throw { skip: true };
      const newNames = new Set(kids.map(k => String(k.name || '').trim().toLowerCase()).filter(Boolean));
      const removed = [...priorKidNames].filter(n => !newNames.has(n));
      const addedLc = [...newNames].filter(n => !priorKidNames.has(n));
      const yr = activeSchoolYear(new Date());
      if (removed.length === 1 && addedLc.length === 1) {
        const newName = kids.map(k => String(k.name || '').trim())
          .find(n => n.toLowerCase() === addedLc[0]);
        await sql`
          UPDATE class_signup_picks SET kid_first_name = ${newName}
          WHERE school_year = ${yr} AND LOWER(family_email) = LOWER(${familyEmail})
            AND LOWER(kid_first_name) = ${removed[0]}
        `;
        // The VP-assigned class group is carried by name too (snapshot
        // above) — a rename otherwise drops the kid's placement.
        const priorGroup = priorKidGroups[removed[0]];
        if (priorGroup) {
          await sql`
            UPDATE kids SET class_group = ${priorGroup}
            WHERE family_email = ${familyEmail}
              AND LOWER(first_name) = ${addedLc[0]} AND class_group = ''
          `;
        }
      } else if (removed.length > 0) {
        await sql`
          DELETE FROM class_signup_picks
          WHERE school_year = ${yr} AND LOWER(family_email) = LOWER(${familyEmail})
            AND LOWER(kid_first_name) = ANY(${removed}::text[])
        `;
      }
    } catch (e) {
      if (!e || e.skip !== true) console.error('class_signup_picks rename sync failed (non-fatal):', e);
    }

    // A kid switched to morning-only leaves afternoon programming — drop
    // their current-year afternoon picks so rosters, pending-pick chips,
    // and lead confirmations stop counting them (Erin, 2026-07-16).
    if (scheduleSwitchedToMorning.length > 0) {
      try {
        const yr2 = activeSchoolYear(new Date());
        await sql`
          DELETE FROM class_signup_picks
          WHERE school_year = ${yr2} AND LOWER(family_email) = LOWER(${familyEmail})
            AND LOWER(kid_first_name) = ANY(${scheduleSwitchedToMorning}::text[])
        `;
      } catch (e) {
        console.error('morning-switch pick cleanup failed (non-fatal):', e);
      }
    }

    // Auto-trigger a backup-coach waiver for any newly-added BLC. Mirrors
    // the registration-time backup-coach flow: insert a pending row in
    // waiver_signatures (role='backup_coach') and email the BLC their
    // signing link. Idempotent on (LOWER(person_email), season) so a
    // re-save of the same EMI form doesn't double-send. registration_id
    // is best-effort — linked to the family's most recent registration in
    // DEFAULT_SEASON if one exists, NULL otherwise.
    //
    // BLCs are addressed at their personal email (Workspace email is
    // optional / only provisioned on request), so person_email + the
    // outbound send both use personal_email here.
    const newBlcRows = [];
    const skippedBlcs = [];
    const blcs = people.filter(p => p.role === 'blc' && p.personal_email);
    for (const blc of blcs) {
      const existing = await sql`
        SELECT signed_at FROM waiver_signatures
        WHERE LOWER(person_email) = LOWER(${blc.personal_email}) AND season = ${DEFAULT_SEASON}
        LIMIT 1
      `;
      if (existing.length > 0) {
        skippedBlcs.push({
          name: blc.name,
          email: blc.personal_email,
          status: existing[0].signed_at ? 'signed' : 'pending'
        });
        continue;
      }

      const reg = await sql`
        SELECT id FROM registrations
        WHERE LOWER(email) = LOWER(${familyEmail}) AND season = ${DEFAULT_SEASON}
          AND declined_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `;
      const registrationId = reg.length > 0 ? reg[0].id : null;

      const token = crypto.randomUUID().replace(/-/g, '');
      try {
        await sql`
          INSERT INTO waiver_signatures (
            season, role, person_name, person_email, family_email, registration_id,
            pending_token, sent_at, sent_by_email
          ) VALUES (
            ${DEFAULT_SEASON}, 'backup_coach',
            ${blc.name}, ${blc.personal_email}, ${familyEmail}, ${registrationId},
            ${token}, NOW(), ${user.realEmail || user.email}
          )
          ON CONFLICT DO NOTHING
        `;
        newBlcRows.push({ name: blc.name, email: blc.personal_email, token });
      } catch (bcErr) {
        console.error('Portal-added BLC waiver insert error (non-fatal):', bcErr);
      }
    }

    if (newBlcRows.length > 0) {
      const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
        ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
        : 'https://roots-and-wings-topaz.vercel.app';
      const mlcParent = people.find(p => p.role === 'mlc');
      const mlcName = (mlcParent && mlcParent.name) ? mlcParent.name : familyName;
      waitUntil((async () => {
        try {
          const resend = new Resend(process.env.RESEND_API_KEY);
          for (const bc of newBlcRows) {
            const link = `${baseUrl}/waiver.html?token=${encodeURIComponent(bc.token)}`;
            await resend.emails.send({
              from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
              to: bc.email,
              replyTo: 'membership@rootsandwingsindy.com',
              subject: emailSubject(`Roots & Wings Co-op: Please sign the backup Learning Coach waiver`),
              html: `
                <h2>Backup Learning Coach waiver</h2>
                <p>Hi ${escapeHtml(bc.name)},</p>
                <p>${escapeHtml(mlcName)} listed you as a backup Learning Coach for the <strong>${escapeHtml(familyName)} family</strong> at Roots &amp; Wings Homeschool Co-op Inc. When you sub or cover for the Main Learning Coach at co-op, this waiver needs to be on file.</p>
                <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#523A79;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Review &amp; sign the waiver</a></p>
                <p style="color:#666;font-size:0.9rem;">Or copy this link into your browser:<br><span style="word-break:break-all;">${escapeHtml(link)}</span></p>
                <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
              `,
            });
          }
        } catch (mailErr) {
          console.error('Portal-added BLC email error (non-fatal):', mailErr);
        }
      })());
    }

    // Echo the saved family back. The frontend ignores the returned shape
    // (it triggers a refresh from /api/sheets), so just confirm success.
    return res.status(200).json({
      success: true,
      family_email: familyEmail,
      family_name: familyName,
      people_count: people.length,
      kids_count: kids.length,
      alt_logins: altLogins,
      blc_waivers_sent: newBlcRows.map(r => ({ name: r.name, email: r.email })),
      blc_waivers_skipped: skippedBlcs,
      // Option B approval queue: changes that did NOT apply directly —
      // the client surfaces "awaiting Membership approval" chips and, for
      // add_kid, the waiver link the adult signs right away.
      pending_requests: createdRequests
    });
  } catch (err) {
    console.error('Profile update error:', err);
    return res.status(500).json({ error: 'Could not save profile.' });
  }
}

// Client posts { family_email, person_name, data_url } where data_url is a
// base64-encoded image (data:image/...;base64,XXX). The client is expected to
// resize to ~512x512 before uploading, keeping payload well under 1 MB.
async function handleProfilePhoto(body, req, res) {
  // View-As aware: user.email is the effective family identity, so a super
  // user / dev tester can upload photos for a family they're viewing as.
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Photo uploads not configured. Ask communications@ to add Vercel Blob.' });
  }

  const familyEmail = normalizeEmail(body.family_email);
  if (!familyEmail) return res.status(400).json({ error: 'family_email required' });
  if (!(await canEditFamily(getSql(), user.email, familyEmail))) {
    return res.status(403).json({ error: 'You can only upload photos for your own family.' });
  }

  const personName = String(body.person_name || '').trim().slice(0, 100);
  if (!personName) return res.status(400).json({ error: 'person_name required' });

  const dataUrl = String(body.data_url || '');
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Image must be a base64 data URL (png, jpeg, or webp).' });
  const mime = m[1];
  const ext = m[2] === 'jpg' ? 'jpeg' : m[2];
  const base64 = m[3];

  let buf;
  try { buf = Buffer.from(base64, 'base64'); }
  catch (e) { return res.status(400).json({ error: 'Invalid image data.' }); }
  // Cap at 2 MB server-side defensively — client should pre-resize to far below this.
  if (buf.length > 2 * 1024 * 1024) {
    return res.status(413).json({ error: 'Image too large (max 2 MB). Try a smaller photo.' });
  }

  try {
    const slug = personName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person';
    const famSlug = familyEmail.split('@')[0];
    const key = `profiles/${famSlug}/${slug}-${Date.now()}.${ext}`;
    const blob = await put(key, buf, {
      access: 'public',
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false
    });
    return res.status(200).json({ success: true, photo_url: blob.url });
  } catch (err) {
    console.error('Profile photo upload error:', err);
    return res.status(500).json({ error: 'Could not upload photo.' });
  }
}

// ── Tour Pipeline: list (Membership Director) ──
async function handleTourList(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  // Tour Pipeline is owned exclusively by the Membership Director.
  // View-As-aware: a super user (communications@/vicepresident@) reaches
  // this report by View-As'ing into Membership Director. There is NO
  // super-user short-circuit in canEditAsRole — it only matches the role
  // mailbox or the role_holders_v2 holder — so the X-View-As header must
  // flow through. verifyWorkspaceAuthWithViewAs sets auth.email to the
  // impersonated target (the role holder) so the gate matches; on prod
  // only canImpersonate() super users may do this. auth.realEmail is
  // preserved for the youAre field.
  const isMembership = await hasCapability(auth.email, 'tours_view');
  // Board transparency (2026-07-15): every board member may READ the
  // pipeline; viewerCanAct=false tells the client to hide the action
  // controls (status changes stay gated in handleTourUpdate).
  const canRead = isMembership || await isBoardMember(auth.email);
  if (!canRead) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director or a board member can view the pipeline.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
    // Fold pre-existing duplicate open rows (same email) into one before
    // listing — non-fatal, no-ops when clean.
    try {
      const deduped = await mergeDuplicateOpenTours(sql);
      if (deduped.length) console.log('Member Pipeline dedupe merged:', JSON.stringify(deduped));
    } catch (mErr) {
      console.error('Member Pipeline dedupe error (non-fatal):', mErr);
    }
    const rows = await sql`
      SELECT id, family_name, family_email, phone, num_kids, ages,
             preferred_date, preferred_time, scheduled_date, scheduled_time,
             status, internal_notes, decline_reason, status_history,
             source, message, created_at, updated_at, updated_by
      FROM tours
      ORDER BY
        CASE status
          WHEN 'inquiry'   THEN 0
          WHEN 'requested' THEN 1
          WHEN 'scheduled' THEN 2
          WHEN 'toured'    THEN 3
          WHEN 'followed_up' THEN 3
          WHEN 'joined'    THEN 4
          WHEN 'declined'  THEN 5
          WHEN 'ghosted'   THEN 6
          ELSE 7
        END,
        created_at DESC
    `;
    return res.status(200).json({ tours: rows, viewerCanAct: isMembership });
  } catch (err) {
    console.error('tour-list error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Tour Pipeline: update status / scheduling / notes (Membership) ──
async function handleTourUpdate(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  // View-As-aware role gate (see handleTourList). The action itself is
  // still attributed to the real signed-in person via auth.realEmail in
  // updated_by + the status-history `by` field below.
  const isMembership = await hasCapability(auth.email, 'tours_manage');
  if (!isMembership) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director can update tour records.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  const actorEmail = auth.realEmail;

  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid tour id is required.' });

  const newStatus = body.status ? String(body.status).trim().toLowerCase() : null;
  const scheduledDate = body.scheduled_date ? String(body.scheduled_date).trim() : undefined;
  const scheduledTime = body.scheduled_time ? String(body.scheduled_time).trim() : undefined;
  const internalNotes = body.internal_notes != null ? String(body.internal_notes).slice(0, 4000) : undefined;
  const declineReason = body.decline_reason != null ? String(body.decline_reason).slice(0, 1000) : undefined;
  const transitionNote = body.note != null ? String(body.note).slice(0, 500) : '';

  if (newStatus && VALID_TOUR_STATUSES.indexOf(newStatus) === -1) {
    return res.status(400).json({ error: 'Unknown tour status: ' + newStatus });
  }

  // Loaded once for both the slot validation below and the confirmation
  // email's friendly slot label further down.
  const sessionsForUpdate = await loadSessionDatesFromDb(getSql());

  // Membership scheduling accepts ANY calendar date (2026-07-11, Erin:
  // summer tours have no co-op Wednesdays to offer) — only the PUBLIC
  // request form keeps the Wednesday-in-session rule. Time stays on the
  // 10–2:30 grid. Both required, or both blank to clear.
  if (scheduledDate !== undefined || scheduledTime !== undefined) {
    const sdVal = scheduledDate || null;
    const stVal = scheduledTime || null;
    if (sdVal || stVal) {
      if (!sdVal || !stVal) return res.status(400).json({ error: 'Please pick both a date and a time, or leave both blank.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sdVal)) return res.status(400).json({ error: 'Date must be a valid calendar date.' });
      if (TOUR_TIME_VALUES.indexOf(stVal) === -1) return res.status(400).json({ error: 'That time slot is not available.' });
    }
  }

  try {
    const sql = getSql();
    const existingRows = await sql`SELECT * FROM tours WHERE id = ${id} LIMIT 1`;
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Tour not found.' });

    const targetStatus = newStatus || existing.status;
    const targetScheduledDate = (scheduledDate !== undefined) ? (scheduledDate || null) : existing.scheduled_date;
    const targetScheduledTime = (scheduledTime !== undefined) ? (scheduledTime || null) : existing.scheduled_time;
    const targetInternalNotes = (internalNotes !== undefined) ? internalNotes : existing.internal_notes;
    const targetDeclineReason = (declineReason !== undefined) ? declineReason : existing.decline_reason;

    // Append a history entry only when status actually changes (note
    // edits + scheduling tweaks within the same status don't need an
    // audit row — they show via the updated_at stamp).
    let history = Array.isArray(existing.status_history) ? existing.status_history.slice() : [];
    if (newStatus && newStatus !== existing.status) {
      history.push({
        at: new Date().toISOString(),
        by: actorEmail,
        from: existing.status,
        to: newStatus,
        note: transitionNote || undefined
      });
    }

    await sql`
      UPDATE tours SET
        status          = ${targetStatus},
        scheduled_date  = ${targetScheduledDate},
        scheduled_time  = ${targetScheduledTime},
        internal_notes  = ${targetInternalNotes},
        decline_reason  = ${targetDeclineReason},
        status_history  = ${JSON.stringify(history)}::jsonb,
        updated_at      = NOW(),
        updated_by      = ${actorEmail}
      WHERE id = ${id}
    `;

    // When a tour transitions into 'scheduled' AND has a confirmed
    // slot, fire a confirmation email back to the family. Skip if the
    // slot isn't filled in yet (the Membership Director may flip the
    // status first and add the date in a follow-up edit).
    if (newStatus === 'scheduled' && existing.status !== 'scheduled' && targetScheduledDate && targetScheduledTime) {
      try {
        const slot = TOUR_TIME_SLOTS.find(s => s.value === String(targetScheduledTime));
        const dateRow = getUpcomingTourDates(sessionsForUpdate).find(d => d.date === String(targetScheduledDate));
        const slotLabel = (dateRow && slot)
          ? `${dateRow.label} at ${slot.label}`
          : `${String(targetScheduledDate)} at ${String(targetScheduledTime)}`;
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: existing.family_email,
          replyTo: 'membership@rootsandwingsindy.com',
          subject: emailSubject(`Your Roots & Wings tour is confirmed`),
          html: `
            <h2>Your tour is confirmed</h2>
            <p>Hi ${escapeHtml(existing.family_name)},</p>
            <p>We're looking forward to meeting you at Roots &amp; Wings Homeschool Co-op. Your tour is confirmed for:</p>
            <p style="background:#f5f0f8;padding:12px 16px;border-left:3px solid #523A79;border-radius:4px;font-size:1.05rem;"><strong>${escapeHtml(slotLabel)}</strong></p>
            <p>We meet at First Mennonite Church, 4601 Knollton Rd, Indianapolis IN 46228. Park in the lot off Knollton; the entrance is on the north side of the building.</p>
            ${transitionNote ? `<p><em>A note from the Membership team:</em> ${escapeHtml(transitionNote)}</p>` : ''}
            <p>Reply to this email if you need to reschedule or have questions before then.</p>
            <p style="color:#666;font-size:0.9rem;margin-top:20px;">— The Roots &amp; Wings Membership team</p>
          `,
        });
      } catch (mailErr) {
        // Don't fail the update if the confirmation email hiccups —
        // the status flip is already saved; Membership can re-send by
        // toggling out + back into 'scheduled' if needed.
        console.error('Tour confirmation email error (non-fatal):', mailErr);
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('tour-update error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ──────────────────────────────────────────────
// Merchandise — public order intake + portal report
// ──────────────────────────────────────────────
// Bundled into tour.js because the Hobby tier caps us at 12 functions
// and tour.js is already the "public intake" endpoint (tours,
// registrations, waivers). Same Resend wrapper, same DB connection,
// same role-gating helpers.

// True if `email` may view or edit merch orders. Anyone in the role
// chain that owns merch: Communications Director (parent) +
// Merchandise Manager (the committee role). Super users pass through
// canEditAsRole automatically.
async function canManageMerch(email) {
  if (!email) return false;
  // 'merch_manage' — defaults to Comms (parent role) + Merchandise
  // Manager; editable in the Permissions admin table.
  return await hasCapability(email, 'merch_manage');
}

async function handleMerchOrder(body, res) {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const qty = parseInt(body.qty, 10);
  const notes = String(body.notes || '').trim();

  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (name.length > 200 || email.length > 200 || phone.length > 50 || notes.length > 1000) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
    return res.status(400).json({ error: 'Quantity must be between 1 and 999.' });
  }

  const itemErr = validateMerchOrder(body);
  if (itemErr) return res.status(400).json({ error: itemErr });

  const itemKey = String(body.item).toLowerCase().trim();
  const itemDef = MERCH_CATALOG[itemKey];
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();

  // DB insert is the source of truth — if the email below fails, the
  // Merchandise Manager still sees the order in the portal report.
  let orderId = null;
  try {
    const sql = getSql();
    const inserted = await sql`
      INSERT INTO merch_orders (
        customer_name, customer_email, customer_phone,
        item, size, color, qty, notes, updated_by
      ) VALUES (
        ${name}, ${email.toLowerCase()}, ${phone},
        ${itemDef.label}, ${size}, ${color}, ${qty}, ${notes}, 'public-form'
      )
      RETURNING id
    `;
    orderId = inserted[0] && inserted[0].id;
  } catch (dbErr) {
    console.error('Merch DB insert error:', dbErr);
    return res.status(500).json({ error: 'Could not save your order. Please try again.' });
  }

  // Email work runs in the background so the user gets a snappy ack.
  // CC the Merchandise Manager (or Comms Director as fallback) so the
  // team sees the order land in their inbox the moment it's submitted.
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone || '—');
  const safeItem = escapeHtml(itemDef.label);
  const safeSize = escapeHtml(size || '—');
  const safeColor = escapeHtml(color || '—');
  const safeQty = String(qty);
  const safeNotes = notes ? escapeHtml(notes) : '';

  // Try Merchandise Manager first; fall back to communications@ if no
  // holder is assigned (getRoleHolderEmail returns null when the role
  // isn't filled and isn't on the board mailbox shortcut list).
  let merchCc = null;
  try {
    merchCc = await getRoleHolderEmail('Merchandise Manager');
  } catch (_) { /* fall through */ }
  if (!merchCc) merchCc = 'communications@rootsandwingsindy.com';

  const resend = new Resend(process.env.RESEND_API_KEY);
  const detailRows =
    `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Item</td><td style="padding:8px 0;">${safeItem}</td></tr>` +
    (size  ? `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Size</td><td style="padding:8px 0;">${safeSize}</td></tr>` : '') +
    (color ? `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Color</td><td style="padding:8px 0;">${safeColor}</td></tr>` : '') +
    `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Quantity</td><td style="padding:8px 0;">${safeQty}</td></tr>` +
    (notes ? `<tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Notes</td><td style="padding:8px 0;white-space:pre-wrap;">${safeNotes}</td></tr>` : '');

  const emailWork = resend.emails.send({
    from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
    to: email,
    cc: [merchCc],
    replyTo: merchCc,
    subject: emailSubject('Roots & Wings: We received your merch order'),
    html: `
      <h2>Thanks for your order!</h2>
      <p>Hi ${safeName},</p>
      <p>We've received your merchandise order. The Merchandise Manager will be in touch shortly with payment details (we accept Venmo) and fulfillment timing.</p>
      <table style="border-collapse:collapse;font-family:sans-serif;margin:16px 0;">
        ${detailRows}
      </table>
      <p>Reply to this email with any questions — it goes straight to our Merchandise Manager.</p>
      <p>— Roots &amp; Wings Indy</p>
    `
  }).catch(err => { console.error('Merch email send error:', err); });

  // waitUntil lets the function return immediately while Resend
  // finishes in the background.
  if (typeof waitUntil === 'function') waitUntil(emailWork);

  return res.status(200).json({ ok: true, order_id: orderId });
}

// Manual order entry by the Merchandise Manager or Comms Director, for
// in-person / cash / Venmo sales that bypass the public form. Differs
// from handleMerchOrder in three ways:
//   1. Auth-gated (canManageMerch) — public form is unauthenticated, so
//      we can't reuse the same handler with a flag.
//   2. Email + phone are optional. Cash sales at a market table won't
//      have an email. We store '' rather than NULL to match the column's
//      NOT NULL constraint.
//   3. No customer confirmation email is sent — the manager is recording
//      a transaction that already happened. Optional `paid` / `delivered`
//      booleans let them stamp those timestamps in the same insert so
//      they don't have to click the pills afterward.
async function handleMerchManualOrder(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to add merch orders.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const qty = parseInt(body.qty, 10);
  const notes = String(body.notes || '').trim();

  if (!name) return res.status(400).json({ error: 'Customer name is required.' });
  if (name.length > 200 || email.length > 200 || phone.length > 50 || notes.length > 1000) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
    return res.status(400).json({ error: 'Quantity must be between 1 and 999.' });
  }

  const itemErr = validateMerchOrder(body);
  if (itemErr) return res.status(400).json({ error: itemErr });

  const itemKey = String(body.item).toLowerCase().trim();
  const itemDef = MERCH_CATALOG[itemKey];
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();
  const paid = !!body.paid;
  const delivered = !!body.delivered;

  try {
    const sql = getSql();
    const inserted = await sql`
      INSERT INTO merch_orders (
        customer_name, customer_email, customer_phone,
        item, size, color, qty, notes,
        paid_at, delivered_at, updated_by
      ) VALUES (
        ${name}, ${email.toLowerCase()}, ${phone},
        ${itemDef.label}, ${size}, ${color}, ${qty}, ${notes},
        ${paid ? new Date().toISOString() : null},
        ${delivered ? new Date().toISOString() : null},
        ${auth.realEmail}
      )
      RETURNING id, customer_name, customer_email, customer_phone,
                item, size, color, qty, notes,
                paid_at, delivered_at, created_at, updated_at, updated_by
    `;
    return res.status(200).json({ ok: true, order: inserted[0] });
  } catch (dbErr) {
    console.error('Merch manual insert error:', dbErr);
    return res.status(500).json({ error: 'Could not save order.' });
  }
}

async function handleMerchOrdersList(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to view merch orders.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, customer_name, customer_email, customer_phone,
             item, size, color, qty, notes,
             paid_at, delivered_at, created_at, updated_at, updated_by
      FROM merch_orders
      ORDER BY created_at DESC
    `;
    return res.status(200).json({ orders: rows });
  } catch (err) {
    console.error('Merch list error:', err);
    return res.status(500).json({ error: 'Failed to load merch orders.' });
  }
}

// Full-field edit of an existing order (Erin, 2026-07-19) — same
// validation as the manual add. Item arrives as a catalog KEY; stored as
// the catalog label like every other write path.
async function handleMerchOrderEdit(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to update merch orders.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const qty = parseInt(body.qty, 10);
  const notes = String(body.notes || '').trim();
  if (!name) return res.status(400).json({ error: 'Customer name is required.' });
  if (name.length > 200 || email.length > 200 || phone.length > 50 || notes.length > 1000) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
    return res.status(400).json({ error: 'Quantity must be between 1 and 999.' });
  }
  const itemErr = validateMerchOrder(body);
  if (itemErr) return res.status(400).json({ error: itemErr });
  const itemDef = MERCH_CATALOG[String(body.item).toLowerCase().trim()];
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();

  try {
    const sql = getSql();
    const rows = await sql`
      UPDATE merch_orders SET
        customer_name = ${name},
        customer_email = ${email.toLowerCase()},
        customer_phone = ${phone},
        item = ${itemDef.label}, size = ${size}, color = ${color},
        qty = ${qty}, notes = ${notes},
        updated_at = NOW(), updated_by = ${auth.realEmail}
      WHERE id = ${id}
      RETURNING id, customer_name, customer_email, customer_phone,
                item, size, color, qty, notes,
                paid_at, delivered_at, created_at, updated_at, updated_by
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    return res.status(200).json({ order: rows[0] });
  } catch (err) {
    console.error('Merch order edit error:', err);
    return res.status(500).json({ error: 'Failed to update order.' });
  }
}

// Add a new inventory row (Erin, 2026-07-19: "add an Item type") — item is
// free text so the manager can stock products beyond the hardcoded order
// catalog (those still validate against MERCH_CATALOG; inventory rendering
// already falls back to the raw item string when it's not a catalog key).
async function handleMerchInventoryAdd(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to edit merch inventory.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  const item = String(body.item || '').trim();
  const size = String(body.size || '').trim();
  const color = String(body.color || '').trim();
  const notes = String(body.notes || '').trim();
  const vendorName = String(body.vendor_name || '').trim();
  const vendorUrl = String(body.vendor_url || '').trim();
  if (!item) return res.status(400).json({ error: 'An item name is required.' });
  if (item.length > 100 || size.length > 100 || color.length > 100 || vendorName.length > 200 || vendorUrl.length > 500 || notes.length > 1000) {
    return res.status(400).json({ error: 'Input too long.' });
  }
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : fallback;
  };
  const onHand = num(body.on_hand, 0);
  const lowAt = num(body.low_threshold, 0);
  const reorderMin = num(body.reorder_minimum, 0);
  try {
    const sql = getSql();
    const dup = await sql`
      SELECT id FROM merch_inventory
      WHERE LOWER(item) = LOWER(${item}) AND LOWER(COALESCE(size,'')) = LOWER(${size}) AND LOWER(COALESCE(color,'')) = LOWER(${color})
    `;
    if (dup.length > 0) return res.status(409).json({ error: 'That item/variant already exists — edit its row instead.' });
    const rows = await sql`
      INSERT INTO merch_inventory (item, size, color, on_hand, low_threshold, reorder_minimum, vendor_name, vendor_url, notes, updated_by)
      VALUES (${item}, ${size}, ${color}, ${onHand}, ${lowAt}, ${reorderMin}, ${vendorName}, ${vendorUrl}, ${notes}, ${auth.realEmail})
      RETURNING id, item, size, color, on_hand, low_threshold, reorder_minimum, vendor_name, vendor_url, notes, updated_at
    `;
    return res.status(200).json({ ok: true, row: rows[0] });
  } catch (err) {
    console.error('Merch inventory add error:', err);
    return res.status(500).json({ error: 'Failed to add the item.' });
  }
}

// Hard-delete an order (Erin, 2026-07-19) — two-step confirmed client-side.
// Merch-Manager gated like every other order write.
async function handleMerchOrderDelete(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to delete merch orders.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  try {
    const sql = getSql();
    const rows = await sql`DELETE FROM merch_orders WHERE id = ${id} RETURNING id`;
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    return res.status(200).json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('Merch order delete error:', err);
    return res.status(500).json({ error: 'Failed to delete order.' });
  }
}

async function handleMerchUpdate(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to update merch orders.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const field = String(body.field || '').toLowerCase();
  if (field !== 'paid' && field !== 'delivered') {
    return res.status(400).json({ error: 'field must be "paid" or "delivered"' });
  }
  // Toggle semantics: client sends desired value (true = stamp now,
  // false = clear). Lets the report's pill click flip between states.
  const setOn = !!body.value;
  // Static SQL per column. The previous version used ${sql(col)} for
  // dynamic identifier interpolation, but @neondatabase/serverless's
  // tagged template doesn't escape identifiers that way — it parameterizes
  // the value, which Postgres then rejects as a syntax error in column
  // position. Field whitelist above already guarantees one of two paths,
  // so duplicating the SQL is cheaper than reintroducing the bug.
  const ts = new Date().toISOString();
  try {
    const sql = getSql();
    let rows;
    if (field === 'paid') {
      rows = setOn
        ? await sql`UPDATE merch_orders SET paid_at = ${ts}, updated_at = NOW(), updated_by = ${auth.realEmail}
                    WHERE id = ${id} RETURNING id, paid_at, delivered_at`
        : await sql`UPDATE merch_orders SET paid_at = NULL, updated_at = NOW(), updated_by = ${auth.realEmail}
                    WHERE id = ${id} RETURNING id, paid_at, delivered_at`;
    } else {
      rows = setOn
        ? await sql`UPDATE merch_orders SET delivered_at = ${ts}, updated_at = NOW(), updated_by = ${auth.realEmail}
                    WHERE id = ${id} RETURNING id, paid_at, delivered_at`
        : await sql`UPDATE merch_orders SET delivered_at = NULL, updated_at = NOW(), updated_by = ${auth.realEmail}
                    WHERE id = ${id} RETURNING id, paid_at, delivered_at`;
    }
    if (rows.length === 0) return res.status(404).json({ error: 'Order not found.' });
    return res.status(200).json({ order: rows[0] });
  } catch (err) {
    console.error('Merch update error:', err);
    return res.status(500).json({ error: 'Failed to update order.' });
  }
}

// Merch inventory — one row per (item, size, color). Counts are
// maintained by hand by the Merchandise Manager; we intentionally do
// NOT auto-decrement when an order is marked Delivered (would silently
// double-count any manual adjustment the manager made for in-person
// sales) — the Orders report carries undelivered counts separately so
// the manager can reconcile by eye.
async function handleMerchInventoryList(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to view merch inventory.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, item, size, color,
             on_hand, low_threshold, reorder_minimum, notes,
             vendor_name, vendor_url,
             updated_at, updated_by
      FROM merch_inventory
      ORDER BY item, size, color
    `;
    return res.status(200).json({ inventory: rows });
  } catch (err) {
    console.error('Merch inventory list error:', err);
    return res.status(500).json({ error: 'Failed to load inventory.' });
  }
}

async function handleMerchInventoryUpdate(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canManageMerch(auth.email))) {
    return res.status(403).json({
      error: 'Not authorized to update merch inventory.',
      youAre: auth.realEmail,
      expected: await getRoleHolderEmail('Merchandise Manager')
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });

  // Clamp non-negative integers with a generous cap so a stray keystroke
  // can't park 9 quadrillion mugs on the report.
  function intField(name) {
    if (body[name] === undefined || body[name] === null || body[name] === '') return null;
    const n = parseInt(body[name], 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(name + ' must be a non-negative integer');
    if (n > 100000) throw new Error(name + ' is unreasonably large');
    return n;
  }
  let onHand, lowThreshold, reorderMin;
  try {
    onHand       = intField('on_hand');
    lowThreshold = intField('low_threshold');
    reorderMin   = intField('reorder_minimum');
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const notes = body.notes === undefined ? null : String(body.notes).slice(0, 1000);
  // Vendor name + URL: trim, cap at 200 chars each. URL gets a soft
  // http:// prepend at render time if the manager enters a bare domain,
  // so we don't reject "printco.com" here — keep storage as-typed.
  const vendorName = body.vendor_name === undefined ? null : String(body.vendor_name).trim().slice(0, 200);
  const vendorUrl  = body.vendor_url  === undefined ? null : String(body.vendor_url).trim().slice(0, 500);

  if (onHand === null && lowThreshold === null && reorderMin === null
      && notes === null && vendorName === null && vendorUrl === null) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  try {
    const sql = getSql();
    // COALESCE pattern lets the client send only the field(s) they're
    // editing without us having to dynamically build SQL — Neon's tagged
    // template doesn't parameterize identifiers, and we already burned
    // ourselves on that with handleMerchUpdate (see comment there).
    const rows = await sql`
      UPDATE merch_inventory
      SET on_hand         = COALESCE(${onHand},       on_hand),
          low_threshold   = COALESCE(${lowThreshold}, low_threshold),
          reorder_minimum = COALESCE(${reorderMin},   reorder_minimum),
          notes           = COALESCE(${notes},        notes),
          vendor_name     = COALESCE(${vendorName},   vendor_name),
          vendor_url      = COALESCE(${vendorUrl},    vendor_url),
          updated_at      = NOW(),
          updated_by      = ${auth.realEmail}
      WHERE id = ${id}
      RETURNING id, item, size, color, on_hand, low_threshold, reorder_minimum, notes, vendor_name, vendor_url, updated_at, updated_by
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Inventory row not found.' });
    return res.status(200).json({ row: rows[0] });
  } catch (err) {
    console.error('Merch inventory update error:', err);
    return res.status(500).json({ error: 'Failed to update inventory.' });
  }
}

// ──────────────────────────────────────────────
// Morning Class Builder (Membership Director)
// ──────────────────────────────────────────────
// The brand age-band classes, in age order. Kept in sync with the client
// `ageGroupData` (script.js) and the public-site age-group cards. The
// server only needs the names to validate an assignment payload.
const MORNING_GROUP_NAMES = [
  'Greenhouse', 'Saplings', 'Sassafras', 'Oaks', 'Maples',
  'Birch', 'Willows', 'Cedars', 'Pigeons'
];
// Morning-inclusive registration tracks (see VALID_TRACKS).
const MORNING_TRACKS = ['Morning Only', 'Both'];

// Age a kid will be at the start of the upcoming school year (Sept 1 of
// the fall year), so grouping reflects how old they'll be in class — not
// their age the day the Membership Director happens to be planning.
// Returns null for missing/invalid birth dates.
function fallYearOf(schoolYear) {
  const m = String(schoolYear || '').match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}
function ageAsOfFall(birthDate, schoolYear) {
  if (!birthDate) return null;
  const bd = new Date(birthDate);
  if (isNaN(bd.getTime())) return null;
  const ref = new Date(Date.UTC(fallYearOf(schoolYear), 8, 1)); // Sept 1
  let age = ref.getUTCFullYear() - bd.getUTCFullYear();
  const mo = ref.getUTCMonth() - bd.getUTCMonth();
  if (mo < 0 || (mo === 0 && ref.getUTCDate() < bd.getUTCDate())) age--;
  return age >= 0 ? age : 0;
}

// Brand age bands for the one-time auto-placement. Ranges overlap by design
// (the Membership Director makes the call at boundaries); auto-seed uses
// first-match — e.g. age 5 → Saplings, 8 → Oaks. A starting guess she
// reviews, not a hard rule.
const MORNING_GROUP_RANGES = [
  { name: 'Greenhouse', min: 0,  max: 2 },
  { name: 'Saplings',   min: 3,  max: 5 },
  { name: 'Sassafras',  min: 5,  max: 6 },
  { name: 'Oaks',       min: 7,  max: 8 },
  { name: 'Maples',     min: 8,  max: 9 },
  { name: 'Birch',      min: 9,  max: 10 },
  { name: 'Willows',    min: 10, max: 11 },
  { name: 'Cedars',     min: 12, max: 13 },
  { name: 'Pigeons',    min: 14, max: 200 }
];
function groupForAge(age) {
  if (age == null) return '';
  for (const g of MORNING_GROUP_RANGES) {
    if (age >= g.min && age <= g.max) return g.name;
  }
  return '';
}
// "Today" as YYYY-MM-DD in America/Indianapolis (string-comparable).
function indyTodayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
// True once we're on/after June 1 of the season's fall year — when morning
// class building begins (no off-season auto-seed or To Do nag).
function morningGateOpen(schoolYear) {
  return indyTodayStr() >= (fallYearOf(schoolYear) + '-06-01');
}

// Shared Membership-Director gate for the Morning Class Builder endpoints.
// View-As-aware (see handleTourList). Returns the auth object on success,
// or sends the 401/403 and returns null.
async function requireMembershipDirector(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const ok = await hasCapability(auth.email, 'morning_builder_place');
  if (!ok) {
    const expected = await getRoleHolderEmail('Membership Director');
    res.status(403).json({
      error: 'Only the Membership Director can use the Morning Class Builder.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
    return null;
  }
  return auth;
}

// Morning Class Builder access for the GET + AM-teaching writes: Membership
// Director OR Vice President (VP manages volunteer/teaching assignments;
// canEditAsRole grants super users). auth.canPlaceKids is true only for
// Membership/super — VP can manage teaching but not drag kids or trigger the
// one-time seed. Kid placement/finalize keep their Membership-only gate.
async function morningBuilderAccess(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  // 'morning_builder' opens the builder; 'morning_builder_place' also
  // unlocks kid placement + seed. Both Permissions-table editable
  // (defaults: view = Membership + VP; place = Membership only).
  const canPlace = await hasCapability(auth.email, 'morning_builder_place');
  // Any board member may VIEW the builder read-only (Erin, 2026-07-18: board
  // tools are reachable board-wide; the workspace/To-Do stays role-focused).
  // Kid placement + seed stay gated to morning_builder_place (Membership).
  const canView = canPlace || await hasCapability(auth.email, 'morning_builder') || await isBoardMember(auth.email);
  if (!canView) {
    const expected = await getRoleHolderEmail('Membership Director');
    res.status(403).json({
      error: 'Only the Membership Director or Vice President can use the Morning Class Builder.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
    return null;
  }
  auth.canPlaceKids = canPlace; // default: VP sees teaching only
  return auth;
}

// GET ?morning_builder=1&school_year=YYYY-YYYY[&seed=1]
// Roster of paid, morning-track kids for the season (each with
// age-as-of-fall, allergies, family placement notes, current draft group,
// and a `locked` flag once finalized) plus the plan's status/seeded state.
// When seed=1 (the builder modal's load) and the season hasn't been
// auto-seeded yet, every unplaced kid with a known age is dropped into its
// age-matched group as a one-time starting point — so the builder opens as
// a review. Later registrations are never re-seeded; they stay unplaced.
async function handleMorningBuilderGet(req, res) {
  const auth = await morningBuilderAccess(req, res);
  if (!auth) return;
  const schoolYear = String(req.query.school_year || DEFAULT_SEASON);
  try {
    const sql = getSql();
    // ── Enrollment-driven roster (enrollment build, 2026-07-19) ──
    // The season's morning pool now comes STRAIGHT from kid_enrollments
    // (status='enrolled', schedule all-day/morning) joined to kids — no
    // more parsing registrations.kids JSON, no live-kids merge, and no
    // name-derived family emails deciding who exists (the bug Erin repro'd:
    // a schedule flip was invisible for any family whose real mailbox
    // breaks the first-name+last-initial convention). Registrations only
    // contribute per-family meta (pending payment, placement notes),
    // matched by the registration's STORED family_email first and the
    // derived email as a legacy fallback.
    const regs = await sql`
      SELECT family_email, main_learning_coach, existing_family_name, track,
             placement_notes, payment_status
      FROM registrations
      WHERE season = ${schoolYear}
        AND declined_at IS NULL
    `;
    const draftRows = await sql`
      SELECT family_email, kid_first_name, class_group, finalized, kid_id, sort_position
      FROM morning_class_assignments
      WHERE school_year = ${schoolYear}
    `;
    const draftMap = {};
    const draftByKidId = {};
    draftRows.forEach(r => {
      const rec = { group: r.class_group, finalized: !!r.finalized, position: r.sort_position == null ? null : r.sort_position };
      draftMap[r.family_email + '|' + r.kid_first_name] = rec;
      if (r.kid_id) draftByKidId[r.kid_id] = rec;
    });
    const planRows = await sql`
      SELECT status, finalized_at, finalized_by, seeded_at FROM morning_class_plans
      WHERE school_year = ${schoolYear} LIMIT 1
    `;
    const plan = planRows[0] || { status: 'draft', finalized_at: null, finalized_by: '', seeded_at: null };

    // Family display names from member_profiles (real family_email keys).
    const profileNames = {};
    try {
      const profRows = await sql`SELECT family_email, family_name FROM member_profiles`;
      profRows.forEach(p => { profileNames[String(p.family_email || '').toLowerCase()] = String(p.family_name || ''); });
    } catch (pnErr) {
      console.error('morning-builder profile-name lookup failed (non-fatal):', pnErr);
    }

    const roster = [];
    const familyEmails = new Set();
    const regMetaByEmail = {};
    regs.forEach(r => {
      const familyName = deriveFamilyName(r.main_learning_coach, r.existing_family_name);
      const pending = String(r.payment_status || '').toLowerCase() !== 'paid';
      const meta = {
        family_name: familyName,
        track: r.track,
        placement_notes: String(r.placement_notes || '').trim(),
        pending: pending
      };
      // Stored family_email is authoritative (set at registration time);
      // the derived email stays as a fallback key for pre-linking rows.
      const stored = String(r.family_email || '').toLowerCase();
      if (stored && !regMetaByEmail[stored]) regMetaByEmail[stored] = meta;
      const derived = deriveFamilyEmail(r.main_learning_coach, familyName);
      if (derived && !regMetaByEmail[String(derived).toLowerCase()]) regMetaByEmail[String(derived).toLowerCase()] = meta;
    });

    const enrollRows = await sql`
      SELECT e.kid_id, e.family_email, e.schedule AS enr_schedule,
             k.first_name, k.last_name, k.nickname, k.birth_date, k.allergies
      FROM kid_enrollments e
      JOIN kids k ON k.id = e.kid_id
      WHERE e.season = ${schoolYear}
        AND e.status = 'enrolled'
        AND e.schedule IN ('all-day', 'morning')
      ORDER BY e.family_email, k.sort_order, k.id
    `;
    const seenKidIds = new Set();
    enrollRows.forEach(er => {
      const familyEmail = String(er.family_email || '').toLowerCase();
      const first = String(er.first_name || '').trim().split(/\s+/)[0].toLowerCase();
      if (!familyEmail || !first) return;
      const meta = regMetaByEmail[familyEmail] || {};
      const familyName = profileNames[familyEmail] || meta.family_name || '';
      const key = familyEmail + '|' + first;
      const entry = draftByKidId[er.kid_id] || draftMap[key];
      roster.push({
        key: key,
        kid_id: er.kid_id,
        family_email: familyEmail,
        family_name: familyName,
        first_name: first,
        display_name: morningKidDisplayName({ first_name: er.first_name, last_name: er.last_name }, familyName),
        birth_date: er.birth_date || null,
        age: ageAsOfFall(er.birth_date, schoolYear),
        placement_notes: meta.placement_notes || '',
        allergies: String(er.allergies || '').trim(),
        // Pending (unpaid) kids place like paid ones; it's a visual flag.
        pending: !!meta.pending,
        group: entry ? entry.group : '',
        position: entry && entry.position != null ? entry.position : null,
        locked: false
      });
      familyEmails.add(familyEmail);
      seenKidIds.add(er.kid_id);
    });

    // Never drop an existing placement: assignments whose kid is no longer
    // morning-enrolled (schedule flipped, not returning) still render so
    // the Membership Director consciously removes them.
    for (const dr of draftRows) {
      if (!dr.class_group) continue;
      if (dr.kid_id && seenKidIds.has(dr.kid_id)) continue;
      const nameKey = String(dr.family_email || '').toLowerCase() + '|' + String(dr.kid_first_name || '').toLowerCase();
      if (!dr.kid_id && roster.some(it => it.key === nameKey)) continue;
      const kidRow = dr.kid_id
        ? (await sql`SELECT id, family_email, first_name, last_name, birth_date, allergies FROM kids WHERE id = ${dr.kid_id}`)[0]
        : (await sql`SELECT id, family_email, first_name, last_name, birth_date, allergies FROM kids
                     WHERE LOWER(family_email) = ${String(dr.family_email || '').toLowerCase()}
                       AND LOWER(first_name) = ${String(dr.kid_first_name || '').toLowerCase()} LIMIT 1`)[0];
      if (!kidRow) continue; // kid deleted entirely — assignment is an orphan
      const fe = String(kidRow.family_email || '').toLowerCase();
      const meta = regMetaByEmail[fe] || {};
      const familyName = profileNames[fe] || meta.family_name || '';
      roster.push({
        key: fe + '|' + String(kidRow.first_name || '').toLowerCase(),
        kid_id: kidRow.id,
        family_email: fe,
        family_name: familyName,
        first_name: String(kidRow.first_name || '').toLowerCase(),
        display_name: morningKidDisplayName({ first_name: kidRow.first_name, last_name: kidRow.last_name }, familyName),
        birth_date: kidRow.birth_date || null,
        age: ageAsOfFall(kidRow.birth_date, schoolYear),
        placement_notes: meta.placement_notes || '',
        allergies: String(kidRow.allergies || '').trim(),
        pending: !!meta.pending,
        group: dr.class_group,
        position: dr.sort_position == null ? null : dr.sort_position,
        locked: false
      });
      familyEmails.add(fe);
      if (kidRow.id) seenKidIds.add(kidRow.id);
    }

    // One-time age-based auto-placement. Runs only on an explicit seed=1
    // load (the builder modal), in season, while the plan is draft and has
    // never been seeded, and only for currently-unplaced kids with a known
    // age. Later opens don't re-seed, so late registrations stay unplaced.
    const wantSeed = (req.query.seed === '1' || req.query.seed === 'true') && auth.canPlaceKids;
    if (wantSeed && plan.status !== 'final' && !plan.seeded_at && roster.length > 0 && morningGateOpen(schoolYear)) {
      for (const item of roster) {
        if (item.group) continue;             // already placed
        const g = groupForAge(item.age);
        if (!g) continue;                      // unknown/out-of-range age → leave unplaced
        await sql`
          INSERT INTO morning_class_assignments
            (school_year, family_email, kid_first_name, class_group, finalized, kid_id, updated_by, updated_at)
          VALUES (${schoolYear}, ${item.family_email}, ${item.first_name}, ${g}, FALSE, ${item.kid_id || null}, ${auth.realEmail}, NOW())
          ON CONFLICT (school_year, family_email, kid_first_name) DO NOTHING
        `;
        item.group = g;
      }
      await sql`
        INSERT INTO morning_class_plans (school_year, status, seeded_at, updated_by, updated_at)
        VALUES (${schoolYear}, 'draft', NOW(), ${auth.realEmail}, NOW())
        ON CONFLICT (school_year) DO UPDATE SET
          seeded_at = COALESCE(morning_class_plans.seeded_at, NOW()), updated_at = NOW()
      `;
      plan.seeded_at = plan.seeded_at || new Date().toISOString();
    }

    // Per-kid lock: a placement is locked only once it's been finalized
    // (plan final AND this assignment was included in that finalize). New
    // additions placed after a finalize stay unlocked until re-finalized.
    if (plan.status === 'final') {
      roster.forEach(item => {
        const entry = (item.kid_id && draftByKidId[item.kid_id]) || draftMap[item.key];
        item.locked = !!(entry && entry.finalized);
      });
    }

    // Enrich allergies from the normalized kids table (registration kids
    // JSON doesn't carry them). Matched on the same family_email + first
    // name key the kids table is unique on.
    if (familyEmails.size > 0) {
      const kidRows = await sql`
        SELECT family_email, first_name, allergies
        FROM kids
        WHERE family_email = ANY(${Array.from(familyEmails)})
      `;
      const kidMap = {};
      kidRows.forEach(kr => {
        kidMap[String(kr.family_email).toLowerCase() + '|' + String(kr.first_name || '').toLowerCase()] = kr;
      });
      roster.forEach(item => {
        const kr = kidMap[item.key];
        if (kr) item.allergies = String(kr.allergies || '').trim();
      });
    }

    // First-year flag — same source + rule as the Directory's "First Year"
    // badge (firstSeasonByEmail, keyed by personal AND derived Workspace
    // email). A family is new until they've completed a full co-op year, so
    // for the season being built a kid is "new" when their family's first
    // full season is this season or later (string compare on 'YYYY-YYYY').
    // Best-effort: a lookup failure just leaves new_member false (no badge).
    try {
      const { firstSeasonByEmail } = require('./sheets.js');
      const firstSeasonMap = await firstSeasonByEmail(sql);
      roster.forEach(item => {
        const fs = firstSeasonMap[String(item.family_email || '').toLowerCase()];
        item.new_member = !!fs && fs >= schoolYear;
      });
    } catch (nmErr) {
      console.warn('morning-builder new-member lookup failed (non-fatal):', nmErr.message);
    }

    // Base order: youngest → oldest, then by name (unknown ages last). This is
    // the fallback for any kid that's never been hand-ordered.
    roster.sort((a, b) => {
      const aa = (a.age == null) ? 999 : a.age;
      const bb = (b.age == null) ? 999 : b.age;
      if (aa !== bb) return aa - bb;
      return a.display_name.localeCompare(b.display_name);
    });

    // Manual within-class order overlay (drag-to-sort). Group the roster into
    // its class blocks (pool first, then the canonical morning order) and,
    // inside each block, honor sort_position ascending. Kids without a manual
    // position keep the base (age/name) order and sit after any positioned
    // ones. The client filters per group, so only the within-group order is
    // observable — but a fully deterministic total order keeps the sort stable.
    const groupRank = {};
    MORNING_GROUP_NAMES.forEach((g, i) => { groupRank[g] = i + 1; });
    const unposSeqByGroup = {};
    roster.forEach(item => {
      const g = item.group || '';
      if (item.position == null) {
        unposSeqByGroup[g] = (unposSeqByGroup[g] || 0) + 1;
        item._rank = 1e6 + unposSeqByGroup[g];   // after every real position, in base order
      } else {
        item._rank = item.position;
      }
    });
    roster.sort((a, b) => {
      const ga = a.group ? (groupRank[a.group] || 99) : 0;
      const gb = b.group ? (groupRank[b.group] || 99) : 0;
      if (ga !== gb) return ga - gb;
      return a._rank - b._rank;
    });
    roster.forEach(item => { delete item._rank; });

    // AM teaching assignments for this year + a member picker list (Phase B1).
    // Non-fatal: a failure just yields an empty teaching grid.
    let teaching = [];
    let teachMembers = [];
    try {
      teaching = await sql`
        SELECT session_number, group_name, role, person_email, person_name
        FROM am_class_assignments
        WHERE school_year = ${schoolYear}
        ORDER BY group_name, session_number, role DESC, sort_order
      `;
      const memRows = await sql`
        SELECT email, personal_email, first_name, last_name
        FROM people
        WHERE COALESCE(role, '') <> 'blc'
        ORDER BY first_name, last_name
      `;
      const seenM = new Set();
      memRows.forEach(p => {
        const nm = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
        const em = String(p.email || p.personal_email || '').toLowerCase();
        const k = em || nm.toLowerCase();
        if (!nm || seenM.has(k)) return;
        seenM.add(k);
        teachMembers.push({ name: nm, email: em });
      });
    } catch (e) {
      console.warn('AM teaching load failed (non-fatal):', e.message);
    }

    return res.status(200).json({
      school_year: schoolYear,
      roster,
      plan: {
        status: plan.status,
        finalized_at: plan.finalized_at,
        finalized_by: plan.finalized_by,
        seeded: !!plan.seeded_at
      },
      groups: MORNING_GROUP_NAMES,
      teaching,
      members: teachMembers,
      viewerCanAct: auth.canPlaceKids,
      viewerCanTeach: true
    });
  } catch (err) {
    console.error('morning-builder get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='morning-assign' — upsert one kid's draft group ('' clears it).
// When the plan is finalized, finalized placements stay locked (409 — reopen
// to change them), but a NOT-yet-finalized kid (a late addition) can still be
// placed; it's written as finalized=FALSE so the next finalize picks it up
// without disturbing the locked kids.
async function handleMorningAssign(body, req, res) {
  const auth = await requireMembershipDirector(req, res);
  if (!auth) return;
  const schoolYear = String(body.school_year || DEFAULT_SEASON);
  const familyEmail = String(body.family_email || '').trim().toLowerCase();
  const firstName = String(body.kid_first_name || '').trim().toLowerCase();
  const group = String(body.class_group || '').trim();
  if (!familyEmail || !firstName) {
    return res.status(400).json({ error: 'family_email and kid_first_name are required.' });
  }
  if (group && MORNING_GROUP_NAMES.indexOf(group) === -1) {
    return res.status(400).json({ error: 'Unknown class group: ' + group });
  }
  try {
    const sql = getSql();
    const planRows = await sql`SELECT status FROM morning_class_plans WHERE school_year = ${schoolYear} LIMIT 1`;
    if (planRows[0] && planRows[0].status === 'final') {
      const existing = await sql`
        SELECT finalized FROM morning_class_assignments
        WHERE school_year = ${schoolYear} AND family_email = ${familyEmail} AND kid_first_name = ${firstName}
        LIMIT 1
      `;
      if (existing[0] && existing[0].finalized) {
        return res.status(409).json({ error: 'That placement is finalized. Reopen the plan to change finalized kids.' });
      }
    }
    // Resolve the real kid row so the assignment carries kid_id (the
    // stable key; name columns stay for the transition). Best-effort —
    // an unresolvable name still writes the legacy-keyed row.
    let placeKidId = null;
    try {
      const kr = await sql`
        SELECT id FROM kids
        WHERE LOWER(family_email) = LOWER(${familyEmail}) AND LOWER(first_name) = LOWER(${firstName})
        LIMIT 1
      `;
      placeKidId = (kr[0] && kr[0].id) || null;
    } catch (e) { /* legacy write below */ }
    await sql`
      INSERT INTO morning_class_assignments
        (school_year, family_email, kid_first_name, class_group, finalized, kid_id, updated_by, updated_at)
      VALUES (${schoolYear}, ${familyEmail}, ${firstName}, ${group}, FALSE, ${placeKidId}, ${auth.realEmail}, NOW())
      ON CONFLICT (school_year, family_email, kid_first_name) DO UPDATE SET
        class_group = EXCLUDED.class_group,
        finalized   = FALSE,
        kid_id      = COALESCE(EXCLUDED.kid_id, morning_class_assignments.kid_id),
        updated_by  = EXCLUDED.updated_by,
        updated_at  = NOW()
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('morning-assign error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='morning-reorder' — persist the manual within-class order for one
// group. `order` is the kids of that class, in the desired top-to-bottom order;
// each row's sort_position is rewritten to its index. Placement (class_group)
// and the finalized lock are untouched — this is purely the "class vibe"
// display order — so it's safe to run even on a finalized plan (only unlocked,
// still-draggable kids ever reach here from the UI). Rows are matched with an
// explicit class_group guard so a stale/racing order can't move a kid that has
// since left the class.
async function handleMorningReorder(body, req, res) {
  const auth = await requireMembershipDirector(req, res);
  if (!auth) return;
  const schoolYear = String(body.school_year || DEFAULT_SEASON);
  const group = String(body.class_group || '').trim();
  const order = Array.isArray(body.order) ? body.order : [];
  if (!group || MORNING_GROUP_NAMES.indexOf(group) === -1) {
    return res.status(400).json({ error: 'A valid class_group is required to reorder.' });
  }
  try {
    const sql = getSql();
    for (let i = 0; i < order.length; i++) {
      const fe = String((order[i] && order[i].family_email) || '').trim().toLowerCase();
      const fn = String((order[i] && order[i].kid_first_name) || '').trim().toLowerCase();
      if (!fe || !fn) continue;
      await sql`
        UPDATE morning_class_assignments
        SET sort_position = ${i}, updated_by = ${auth.realEmail}, updated_at = NOW()
        WHERE school_year = ${schoolYear}
          AND family_email = ${fe}
          AND kid_first_name = ${fn}
          AND class_group = ${group}
      `;
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('morning-reorder error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='morning-finalize' — finalize=true writes every non-empty
// draft group into the live kids.class_group and locks the plan;
// finalize=false reopens it for editing.
async function handleMorningFinalize(body, req, res) {
  const auth = await requireMembershipDirector(req, res);
  if (!auth) return;
  const schoolYear = String(body.school_year || DEFAULT_SEASON);
  const finalize = body.finalize === true || String(body.finalize) === 'true';
  try {
    const sql = getSql();
    if (!finalize) {
      // Reopen: unlock every placement so the whole plan is editable again.
      await sql`UPDATE morning_class_assignments SET finalized = FALSE WHERE school_year = ${schoolYear}`;
      await sql`
        INSERT INTO morning_class_plans (school_year, status, finalized_at, finalized_by, updated_by, updated_at)
        VALUES (${schoolYear}, 'draft', NULL, '', ${auth.realEmail}, NOW())
        ON CONFLICT (school_year) DO UPDATE SET
          status = 'draft', finalized_at = NULL, updated_by = ${auth.realEmail}, updated_at = NOW()
      `;
      return res.status(200).json({ ok: true, status: 'draft' });
    }
    // Finalize: write every non-empty draft group into the live kids row
    // (idempotent for already-finalized kids; applies any late additions),
    // then mark those placements finalized so they lock.
    const draftRows = await sql`
      SELECT family_email, kid_first_name, class_group
      FROM morning_class_assignments
      WHERE school_year = ${schoolYear} AND class_group <> ''
    `;
    let written = 0;
    for (const d of draftRows) {
      const updated = await sql`
        UPDATE kids SET class_group = ${d.class_group}, updated_at = NOW()
        WHERE LOWER(family_email) = ${d.family_email} AND LOWER(first_name) = ${d.kid_first_name}
        RETURNING id
      `;
      written += updated.length;
    }
    // Same existence guard as the Board tile (2026-07-19): only finalize
    // rows whose kid still resolves (kid_id-first, name fallback for
    // unmapped legacy rows) — orphaned assignments stay out of the sweep.
    await sql`UPDATE morning_class_assignments a SET finalized = TRUE
      WHERE a.school_year = ${schoolYear} AND a.class_group <> ''
        AND EXISTS (
          SELECT 1 FROM kids k
          WHERE (a.kid_id IS NOT NULL AND k.id = a.kid_id)
             OR (a.kid_id IS NULL
                 AND LOWER(k.family_email) = LOWER(a.family_email)
                 AND LOWER(k.first_name) = LOWER(a.kid_first_name)))`;
    await sql`
      INSERT INTO morning_class_plans (school_year, status, finalized_at, finalized_by, updated_by, updated_at)
      VALUES (${schoolYear}, 'final', NOW(), ${auth.realEmail}, ${auth.realEmail}, NOW())
      ON CONFLICT (school_year) DO UPDATE SET
        status = 'final', finalized_at = NOW(), finalized_by = ${auth.realEmail},
        updated_by = ${auth.realEmail}, updated_at = NOW()
    `;
    return res.status(200).json({ ok: true, status: 'final', written });
  } catch (err) {
    console.error('morning-finalize error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='am-teacher-assign' — set the lead + assistants for one AM cell
// (school_year, session_number, group_name). Replaces the whole cell. Gated
// to Membership Director + VP (+ super). Feeds participation am_lead/am_assist.
async function handleAmTeacherAssign(body, req, res) {
  const auth = await morningBuilderAccess(req, res);
  if (!auth) return;
  const schoolYear = String(body.school_year || DEFAULT_SEASON);
  const session = parseInt(body.session_number, 10);
  const group = String(body.group_name || '').trim();
  if (!(session >= 1 && session <= 5)) return res.status(400).json({ error: 'session_number 1–5 required' });
  if (!group || MORNING_GROUP_NAMES.indexOf(group) === -1) return res.status(400).json({ error: 'valid group_name required' });
  const clean = (p) => (p && (p.name || p.email))
    ? { email: String(p.email || '').trim().toLowerCase(), name: String(p.name || '').trim() }
    : null;
  const lead = clean(body.lead);
  const assists = (Array.isArray(body.assists) ? body.assists : []).map(clean).filter(Boolean);
  try {
    const sql = getSql();
    await sql`
      DELETE FROM am_class_assignments
      WHERE school_year = ${schoolYear} AND session_number = ${session} AND group_name = ${group}
    `;
    if (lead) {
      await sql`
        INSERT INTO am_class_assignments
          (school_year, session_number, group_name, role, person_email, person_name, sort_order, updated_by)
        VALUES (${schoolYear}, ${session}, ${group}, 'lead', ${lead.email}, ${lead.name}, 0, ${auth.realEmail})
      `;
    }
    for (let i = 0; i < assists.length; i++) {
      await sql`
        INSERT INTO am_class_assignments
          (school_year, session_number, group_name, role, person_email, person_name, sort_order, updated_by)
        VALUES (${schoolYear}, ${session}, ${group}, 'assist', ${assists[i].email}, ${assists[i].name}, ${i}, ${auth.realEmail})
      `;
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('am-teacher-assign error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Special Events (participation sheet→DB, Phase B3) ──
// Managed by the Special Events Liaison (+ VP). Dates proposed → approved;
// each event gets one lead + up to four assistants. Feeds participation
// event_lead / event_assist.
const SPECIAL_EVENT_SEED = [
  'Ice Cream Social', 'Field Day', 'Dance', "Maker's Market", 'Passion Fair',
  'PJ Party', 'Service Project', 'Variety Show', 'Camp'
];

async function requireSpecialEventsEditor(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  // 'special_events_manage' (defaults SEL + VP, Permissions-editable) OR any
  // board member (Erin, 2026-07-17: "let anyone on the board edit/approve
  // any admin calendar events") OR a super user.
  const ok = await hasCapability(auth.email, 'special_events_manage')
    || isSuperUser(auth.email)
    || await isBoardMember(auth.email);
  if (!ok) {
    res.status(403).json({
      error: 'Only a board member (or the Special Events Liaison) can manage special events.',
      youAre: auth.realEmail
    });
    return null;
  }
  return auth;
}

function specialEventDateStr(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// GET ?special_events=1&school_year=YYYY-YYYY — seeds the standard event list
// for the year on first load, then returns each event + lead/assistants + a
// member picker list.
async function handleSpecialEventsGet(req, res) {
  // Editors (SEL/VP via special_events_manage) get the full read + the
  // seed pass; board members get the same payload READ-ONLY (Board at a
  // Glance, 2026-07-15) — viewer_can_edit=false hides the Manage drawer
  // client-side, and every write kind still requires the capability.
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const canEdit = await hasCapability(auth.email, 'special_events_manage');
  if (!canEdit && !(await isBoardMember(auth.email))) {
    return res.status(403).json({
      error: 'Only the Special Events Liaison, Vice President, or a board member can view special events.',
      youAre: auth.realEmail
    });
  }
  const schoolYear = String(req.query.school_year || DEFAULT_SEASON);
  try {
    const sql = getSql();
    // Read-only viewers never write — the seed pass is the editor's job.
    for (let i = 0; canEdit && i < SPECIAL_EVENT_SEED.length; i++) {
      await sql`
        INSERT INTO special_events (school_year, name, sort_order, updated_by)
        VALUES (${schoolYear}, ${SPECIAL_EVENT_SEED[i]}, ${i}, ${auth.realEmail})
        ON CONFLICT (school_year, name) DO NOTHING
      `;
    }
    const events = await sql`
      SELECT id, name, event_date, date_status, sort_order, notes
      FROM special_events WHERE school_year = ${schoolYear}
      ORDER BY sort_order, name
    `;
    const people = await sql`
      SELECT sep.event_id, sep.role, sep.person_email, sep.person_name, sep.sort_order
      FROM special_event_people sep
      JOIN special_events se ON se.id = sep.event_id
      WHERE se.school_year = ${schoolYear}
      ORDER BY sep.event_id, sep.role DESC, sep.sort_order
    `;
    const byEvent = {};
    people.forEach(p => { (byEvent[p.event_id] || (byEvent[p.event_id] = [])).push(p); });
    const out = events.map(e => {
      const ppl = byEvent[e.id] || [];
      const lead = ppl.find(x => x.role === 'lead');
      const assists = ppl.filter(x => x.role === 'assist').map(x => ({ email: x.person_email || '', name: x.person_name || '' }));
      return {
        id: e.id,
        name: e.name,
        event_date: specialEventDateStr(e.event_date),
        date_status: e.date_status,
        notes: e.notes || '',
        // Ice Cream Social + Field Day dates are also driven by the session
        // calendar (board-calendar derived events) — flag so the UI can note it.
        date_from_calendar: (e.name === 'Ice Cream Social' || e.name === 'Field Day'),
        lead: lead ? { email: lead.person_email || '', name: lead.person_name || '' } : null,
        assists
      };
    });
    const memRows = await sql`
      SELECT email, personal_email, first_name, last_name
      FROM people WHERE COALESCE(role, '') <> 'blc'
      ORDER BY first_name, last_name
    `;
    const seen = new Set();
    const members = [];
    memRows.forEach(p => {
      const nm = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
      const em = String(p.email || p.personal_email || '').toLowerCase();
      const k = em || nm.toLowerCase();
      if (!nm || seen.has(k)) return;
      seen.add(k);
      members.push({ name: nm, email: em });
    });
    return res.status(200).json({ school_year: schoolYear, events: out, members, viewer_can_edit: canEdit });
  } catch (err) {
    console.error('special-events get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Event planning spaces (Collaboration Phase 1, Erin 2026-07-15) ──
// A per-event checklist copied from a per-event-NAME template. Any
// signed-in member may VIEW a space (open planning doubles as helper
// recruiting — Erin's call); edits belong to SEL/VP/super (the
// special_events_manage capability) plus the event's own lead and
// assistants. Assignees may check off their OWN task even without
// broader edit rights.
async function canEditEventSpace(sql, auth, eventId) {
  if (await hasCapability(auth.email, 'special_events_manage')) return true;
  const ppl = await sql`
    SELECT 1 FROM special_event_people
    WHERE event_id = ${eventId} AND LOWER(person_email) = ${String(auth.email || '').toLowerCase()}
    LIMIT 1
  `;
  return ppl.length > 0;
}

function eventTaskShape(t) {
  return {
    id: t.id,
    title: t.title,
    assigned_email: t.assigned_email || '',
    assigned_name: t.assigned_name || '',
    due_date: specialEventDateStr(t.due_date),
    done_at: t.done_at || null,
    done_by: t.done_by || '',
    sort_order: t.sort_order
  };
}

// GET ?event_space=<special_event_id> — the space payload: event info,
// checklist, people, template size, and (for editors) the member picker.
async function handleEventSpaceGet(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const eventId = parseInt(req.query.event_space, 10);
  if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'event_space id required' });
  try {
    const sql = getSql();
    const evRows = await sql`
      SELECT id, school_year, name, event_date, date_status, notes
      FROM special_events WHERE id = ${eventId}
    `;
    if (evRows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    const ev = evRows[0];
    const tasks = await sql`
      SELECT id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order
      FROM event_tasks WHERE special_event_id = ${eventId}
      ORDER BY sort_order, id
    `;
    const people = await sql`
      SELECT role, person_email, person_name, sort_order
      FROM special_event_people WHERE event_id = ${eventId}
      ORDER BY role DESC, sort_order
    `;
    const tplCount = await sql`
      SELECT COUNT(*)::int AS n FROM event_task_templates WHERE event_name = ${ev.name}
    `;
    const canEdit = await canEditEventSpace(sql, auth, eventId);
    const payload = {
      event: {
        id: ev.id,
        school_year: ev.school_year,
        name: ev.name,
        event_date: specialEventDateStr(ev.event_date),
        date_status: ev.date_status,
        notes: ev.notes || ''
      },
      tasks: tasks.map(eventTaskShape),
      people: people.map(p => ({ role: p.role, email: p.person_email || '', name: p.person_name || '' })),
      template_count: tplCount[0].n,
      can_edit: canEdit,
      viewer_email: String(auth.email || '').toLowerCase()
    };
    if (canEdit) {
      const memRows = await sql`
        SELECT email, personal_email, first_name, last_name
        FROM people WHERE COALESCE(role, '') <> 'blc'
        ORDER BY first_name, last_name
      `;
      const seen = new Set();
      payload.members = [];
      memRows.forEach(p => {
        const nm = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
        const em = String(p.email || p.personal_email || '').toLowerCase();
        const k = em || nm.toLowerCase();
        if (!nm || seen.has(k)) return;
        seen.add(k);
        payload.members.push({ name: nm, email: em });
      });
      // Editors can also see (and edit, via kind=event-template-save) the
      // template titles for this event name.
      const tpl = await sql`
        SELECT title FROM event_task_templates WHERE event_name = ${ev.name} ORDER BY sort_order, id
      `;
      payload.template_titles = tpl.map(t => t.title);
    }
    return res.status(200).json(payload);
  } catch (err) {
    console.error('event-space get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET ?my_event_tasks=1 — the signed-in member's OPEN tasks across all
// events (feeds the To Do card).
async function handleMyEventTasksGet(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT t.id, t.title, t.due_date, t.special_event_id,
             se.name AS event_name, se.school_year, se.event_date
      FROM event_tasks t
      JOIN special_events se ON se.id = t.special_event_id
      WHERE LOWER(t.assigned_email) = ${String(auth.email || '').toLowerCase()}
        AND t.done_at IS NULL
      ORDER BY t.due_date NULLS LAST, se.event_date NULLS LAST, t.id
    `;
    return res.status(200).json({
      tasks: rows.map(r => ({
        id: r.id,
        title: r.title,
        due_date: specialEventDateStr(r.due_date),
        event_id: r.special_event_id,
        event_name: r.event_name,
        school_year: r.school_year,
        event_date: specialEventDateStr(r.event_date)
      }))
    });
  } catch (err) {
    console.error('my-event-tasks error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// kind=event-task-save — add or edit a task (editors only).
async function handleEventTaskSave(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const eventId = parseInt(body.event_id, 10);
  const title = String(body.title || '').trim().slice(0, 300);
  if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'event_id required' });
  if (!title) return res.status(400).json({ error: 'A task title is required.' });
  const dueDate = String(body.due_date || '').trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return res.status(400).json({ error: 'Due date must be YYYY-MM-DD.' });
  const assignedEmail = String(body.assigned_email || '').trim().toLowerCase().slice(0, 200);
  const assignedName = String(body.assigned_name || '').trim().slice(0, 200);
  try {
    const sql = getSql();
    if (!(await canEditEventSpace(sql, auth, eventId))) {
      return res.status(403).json({ error: 'Only the event’s people (or SEL/VP) can edit this planning list.', youAre: auth.realEmail });
    }
    const id = body.id != null ? parseInt(body.id, 10) : null;
    let row;
    if (Number.isInteger(id) && id > 0) {
      const upd = await sql`
        UPDATE event_tasks
        SET title = ${title}, assigned_email = ${assignedEmail}, assigned_name = ${assignedName},
            due_date = ${dueDate || null}, updated_at = NOW(), updated_by = ${auth.realEmail}
        WHERE id = ${id} AND special_event_id = ${eventId}
        RETURNING id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order
      `;
      if (upd.length === 0) return res.status(404).json({ error: 'Task not found.' });
      row = upd[0];
    } else {
      const ins = await sql`
        INSERT INTO event_tasks (special_event_id, title, assigned_email, assigned_name, due_date, sort_order, updated_by)
        VALUES (${eventId}, ${title}, ${assignedEmail}, ${assignedName}, ${dueDate || null},
                (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM event_tasks WHERE special_event_id = ${eventId}),
                ${auth.realEmail})
        RETURNING id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order
      `;
      row = ins[0];
    }
    return res.status(200).json({ task: eventTaskShape(row) });
  } catch (err) {
    console.error('event-task-save error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// kind=event-task-toggle — check/uncheck. Editors can toggle anything;
// an assignee can toggle their OWN task.
async function handleEventTaskToggle(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
  const done = !!body.done;
  try {
    const sql = getSql();
    const rows = await sql`SELECT id, special_event_id, assigned_email FROM event_tasks WHERE id = ${id}`;
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found.' });
    const t = rows[0];
    const isAssignee = String(t.assigned_email || '').toLowerCase() === String(auth.email || '').toLowerCase();
    if (!isAssignee && !(await canEditEventSpace(sql, auth, t.special_event_id))) {
      return res.status(403).json({ error: 'Only the event’s people (or the task’s assignee) can update this task.', youAre: auth.realEmail });
    }
    const upd = done
      ? await sql`UPDATE event_tasks SET done_at = NOW(), done_by = ${auth.realEmail}, updated_at = NOW(), updated_by = ${auth.realEmail} WHERE id = ${id} RETURNING id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order`
      : await sql`UPDATE event_tasks SET done_at = NULL, done_by = '', updated_at = NOW(), updated_by = ${auth.realEmail} WHERE id = ${id} RETURNING id, title, assigned_email, assigned_name, due_date, done_at, done_by, sort_order`;
    return res.status(200).json({ task: eventTaskShape(upd[0]) });
  } catch (err) {
    console.error('event-task-toggle error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// kind=event-task-delete — editors only.
async function handleEventTaskDelete(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'id required' });
  try {
    const sql = getSql();
    const rows = await sql`SELECT special_event_id FROM event_tasks WHERE id = ${id}`;
    if (rows.length === 0) return res.status(404).json({ error: 'Task not found.' });
    if (!(await canEditEventSpace(sql, auth, rows[0].special_event_id))) {
      return res.status(403).json({ error: 'Only the event’s people (or SEL/VP) can edit this planning list.', youAre: auth.realEmail });
    }
    await sql`DELETE FROM event_tasks WHERE id = ${id}`;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('event-task-delete error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// kind=event-space-template-start — copy the event's template into an
// EMPTY checklist (409 if tasks already exist, so nothing duplicates).
async function handleEventSpaceTemplateStart(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const eventId = parseInt(body.event_id, 10);
  if (!Number.isInteger(eventId) || eventId < 1) return res.status(400).json({ error: 'event_id required' });
  try {
    const sql = getSql();
    if (!(await canEditEventSpace(sql, auth, eventId))) {
      return res.status(403).json({ error: 'Only the event’s people (or SEL/VP) can start the planning list.', youAre: auth.realEmail });
    }
    const evRows = await sql`SELECT name FROM special_events WHERE id = ${eventId}`;
    if (evRows.length === 0) return res.status(404).json({ error: 'Event not found.' });
    const existing = await sql`SELECT COUNT(*)::int AS n FROM event_tasks WHERE special_event_id = ${eventId}`;
    if (existing[0].n > 0) return res.status(409).json({ error: 'This event already has tasks — add from the template by hand instead.' });
    const inserted = await sql`
      INSERT INTO event_tasks (special_event_id, title, sort_order, updated_by)
      SELECT ${eventId}, title, sort_order, ${auth.realEmail}
      FROM event_task_templates WHERE event_name = ${evRows[0].name}
      ORDER BY sort_order, id
      RETURNING id
    `;
    return res.status(200).json({ ok: true, added: inserted.length });
  } catch (err) {
    console.error('event-space-template-start error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// kind=event-template-save — replace an event name's template task list
// (SEL/VP/super only; per-year checklists are untouched).
async function handleEventTemplateSave(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const eventName = String(body.event_name || '').trim().slice(0, 200);
  if (!eventName) return res.status(400).json({ error: 'event_name required' });
  const titles = (Array.isArray(body.titles) ? body.titles : [])
    .map(t => String(t || '').trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 100);
  try {
    const sql = getSql();
    await sql`DELETE FROM event_task_templates WHERE event_name = ${eventName}`;
    for (let i = 0; i < titles.length; i++) {
      await sql`
        INSERT INTO event_task_templates (event_name, title, sort_order, updated_by)
        VALUES (${eventName}, ${titles[i]}, ${i}, ${auth.realEmail})
      `;
    }
    return res.status(200).json({ ok: true, count: titles.length });
  } catch (err) {
    console.error('event-template-save error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='special-event-people' — replace one event's lead + assistants.
async function handleSpecialEventSave(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const eventId = parseInt(body.event_id, 10);
  if (!eventId) return res.status(400).json({ error: 'event_id required' });
  const clean = (p) => (p && (p.name || p.email))
    ? { email: String(p.email || '').trim().toLowerCase(), name: String(p.name || '').trim() }
    : null;
  const lead = clean(body.lead);
  const assists = (Array.isArray(body.assists) ? body.assists : []).map(clean).filter(Boolean).slice(0, 4);
  try {
    const sql = getSql();
    const owns = await sql`SELECT id FROM special_events WHERE id = ${eventId}`;
    if (!owns.length) return res.status(404).json({ error: 'Event not found' });
    await sql`DELETE FROM special_event_people WHERE event_id = ${eventId}`;
    if (lead) {
      await sql`
        INSERT INTO special_event_people (event_id, role, person_email, person_name, sort_order, updated_by)
        VALUES (${eventId}, 'lead', ${lead.email}, ${lead.name}, 0, ${auth.realEmail})
      `;
    }
    for (let i = 0; i < assists.length; i++) {
      await sql`
        INSERT INTO special_event_people (event_id, role, person_email, person_name, sort_order, updated_by)
        VALUES (${eventId}, 'assist', ${assists[i].email}, ${assists[i].name}, ${i}, ${auth.realEmail})
      `;
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('special-event-save error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='special-event-date' — set an event's date + proposed/approved.
async function handleSpecialEventDate(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const eventId = parseInt(body.event_id, 10);
  if (!eventId) return res.status(400).json({ error: 'event_id required' });
  const status = body.date_status === 'approved' ? 'approved' : 'proposed';
  const eventDate = String(body.event_date || '').trim();
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  }
  try {
    const sql = getSql();
    const upd = await sql`
      UPDATE special_events
      SET event_date = ${eventDate || null}, date_status = ${status},
          updated_by = ${auth.realEmail}, updated_at = NOW()
      WHERE id = ${eventId}
      RETURNING id, name, date_status, event_date, end_date, start_time, end_time, location, gcal_event_id
    `;
    if (!upd.length) return res.status(404).json({ error: 'Event not found' });
    // Approve → publish to the co-op Google Calendar; propose → remove it.
    try { await syncSpecialEventToGoogleCalendar(sql, upd[0]); }
    catch (gErr) { console.error('special-event gcal sync (non-fatal):', (gErr && gErr.message) || gErr); }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('special-event-date error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='special-event-details' — set a special event's time/location/
// notes/end-date, and (as of the unified Edit form, 2026-07-18) optionally
// its date. Approval status is never touched here — that stays a one-click
// Approve/Mark-proposed button on the calendar row. A blank event_date leaves
// the stored date untouched (via COALESCE) so editing an AUTO event (Field
// Day / Ice Cream, whose date comes from the session calendar) never clobbers
// the derived date — the form simply doesn't send one for those.
async function handleSpecialEventDetails(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const eventId = parseInt(body.event_id, 10);
  if (!eventId) return res.status(400).json({ error: 'event_id required' });
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  const startTime = String(body.start_time || '').trim();
  const endTime = String(body.end_time || '').trim();
  const endDate = String(body.end_date || '').trim();
  const eventDate = String(body.event_date || '').trim();
  if (startTime && !timeRe.test(startTime)) return res.status(400).json({ error: 'Start time must be HH:MM.' });
  if (endTime && !timeRe.test(endTime)) return res.status(400).json({ error: 'End time must be HH:MM.' });
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return res.status(400).json({ error: 'End date must be YYYY-MM-DD.' });
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD.' });
  if (endDate && eventDate && endDate < eventDate) return res.status(400).json({ error: 'End date must be on or after the date.' });
  const location = String(body.location || '').trim().slice(0, 200);
  const notes = String(body.notes || '').trim().slice(0, 1000);
  try {
    const sql = getSql();
    const upd = await sql`
      UPDATE special_events
      SET start_time = ${startTime || null}, end_time = ${endTime || null},
          end_date = ${endDate || null}, location = ${location}, notes = ${notes},
          event_date = COALESCE(${eventDate || null}, event_date),
          updated_by = ${auth.realEmail}, updated_at = NOW()
      WHERE id = ${eventId}
      RETURNING id, name, date_status, event_date, end_date, start_time, end_time, location, gcal_event_id
    `;
    if (!upd.length) return res.status(404).json({ error: 'Event not found' });
    // Keep the published Google event (if approved) in step with edited
    // times / location / date.
    try { await syncSpecialEventToGoogleCalendar(sql, upd[0]); }
    catch (gErr) { console.error('special-event gcal sync (non-fatal):', (gErr && gErr.message) || gErr); }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('special-event-details error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='special-event-create' — add a NEW special event for a year,
// beyond the seeded standard nine (Admin Calendar "+ Add event" with the
// 🎉 Special event type). Created as 'proposed'; date optional.
async function handleSpecialEventCreate(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const schoolYear = String(body.school_year || '').trim();
  const name = String(body.name || '').trim().slice(0, 120);
  const eventDate = String(body.event_date || '').trim();
  if (!/^\d{4}-\d{4}$/.test(schoolYear)) return res.status(400).json({ error: 'school_year must look like 2026-2027' });
  if (!name) return res.status(400).json({ error: 'Event name required' });
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
  try {
    const sql = getSql();
    const maxRows = await sql`SELECT COALESCE(MAX(sort_order), 0) AS m FROM special_events WHERE school_year = ${schoolYear}`;
    const ins = await sql`
      INSERT INTO special_events (school_year, name, event_date, date_status, sort_order, updated_by)
      VALUES (${schoolYear}, ${name}, ${eventDate || null}, 'proposed', ${(parseInt(maxRows[0].m, 10) || 0) + 1}, ${auth.realEmail})
      ON CONFLICT (school_year, name) DO NOTHING
      RETURNING id
    `;
    if (!ins.length) return res.status(409).json({ error: '“' + name + '” already exists for ' + schoolYear });
    return res.status(200).json({ success: true, id: ins[0].id });
  } catch (err) {
    console.error('special-event-create error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='special-event-delete' — remove a CUSTOM special event (and
// its lead/assistant rows). The seeded standard nine are protected — the
// calendar GET would just re-seed them on the next load anyway.
async function handleSpecialEventDelete(body, req, res) {
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const eventId = parseInt(body.event_id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'event_id required' });
  try {
    const sql = getSql();
    const rows = await sql`SELECT name, gcal_event_id FROM special_events WHERE id = ${eventId}`;
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    if (SPECIAL_EVENT_SEED.indexOf(rows[0].name) !== -1) {
      return res.status(400).json({ error: '“' + rows[0].name + '” is a standard event and can’t be deleted.' });
    }
    // Pull its published Google event too (if any).
    if (process.env.VERCEL_ENV === 'production' && rows[0].gcal_event_id) {
      try { await getCalendarWriteClient().events.delete({ calendarId: RW_GCAL_ID, eventId: rows[0].gcal_event_id }); }
      catch (gErr) { console.error('special-event gcal delete (non-fatal):', (gErr && gErr.message) || gErr); }
    }
    await sql`DELETE FROM special_event_people WHERE event_id = ${eventId}`;
    await sql`DELETE FROM special_events WHERE id = ${eventId}`;
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('special-event-delete error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Board Calendar ──
// A board-facing list of date-sensitive co-op events that don't have their
// own home editor (registration opens/closes, "morning classes finalized
// by", board meetings, …). Session dates + sign-up windows keep their own
// editors and are NOT surfaced here in v1. Any board member can view + edit.

// Render a Neon DATE (returned as a JS Date at UTC-midnight) as a TZ-agnostic
// YYYY-MM-DD string; passes through a NULL/empty end_date as ''.
function calDateStr(v) {
  if (!v) return '';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// Pure validator for one event payload. Returns an error string, or '' when
// the payload is valid. Exported for the regression test.
function validateBoardCalendarEvent(p) {
  p = p || {};
  const schoolYear = String(p.school_year || '').trim();
  const title = String(p.title || '').trim();
  const eventDate = String(p.event_date || '').trim();
  const endDate = String(p.end_date || '').trim();
  if (!/^\d{4}-\d{4}$/.test(schoolYear)) return 'school_year must be "YYYY-YYYY".';
  const yrA = parseInt(schoolYear.slice(0, 4), 10);
  const yrB = parseInt(schoolYear.slice(5), 10);
  if (yrB !== yrA + 1) return 'school_year second half must be the year after the first half.';
  if (!title) return 'An event name is required.';
  if (title.length > 200) return 'Event name is too long (200 characters max).';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return 'A valid date is required.';
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return 'End date must be YYYY-MM-DD.';
  if (endDate && endDate < eventDate) return 'End date must be on or after the start date.';
  const startTime = String(p.start_time || '').trim();
  const endTime = String(p.end_time || '').trim();
  if (startTime && !/^\d{2}:\d{2}(:\d{2})?$/.test(startTime)) return 'Start time must be HH:MM.';
  if (endTime && !/^\d{2}:\d{2}(:\d{2})?$/.test(endTime)) return 'End time must be HH:MM.';
  if (endTime && !startTime) return 'An end time needs a start time.';
  // Same-day events must end after they start; multi-day windows are free.
  if (startTime && endTime && !endDate && endTime <= startTime) return 'End time must be after the start time.';
  if (String(p.note || '').length > 1000) return 'Note is too long (1000 characters max).';
  return '';
}

// ── Derived calendar events ──
// The board's date-sensitive work is mostly driven off the session calendar
// (co_op_sessions). Rather than make the board re-enter those dates, we
// COMPUTE the trigger dates and show them as read-only rows alongside any
// manual events. All math is string-based (YYYY-MM-DD) in UTC so it's
// timezone-agnostic — matches how Neon DATE values round-trip.

// Add n days (may be negative) to a YYYY-MM-DD string.
function calAddDays(dateStr, n) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Nearest Wednesday strictly before (dir=-1) or after (dir=+1) a date. If the
// date is itself a Wednesday, lands a full week away (never the same day).
function calSnapWed(dateStr, dir) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  do { d.setUTCDate(d.getUTCDate() + dir); } while (d.getUTCDay() !== 3);
  return d.toISOString().slice(0, 10);
}
function calSessionsForYear(sessions, schoolYear) {
  return (sessions || [])
    .filter(s => s.school_year === schoolYear && s.start_date && s.end_date)
    .sort((a, b) => (a.session_number || 0) - (b.session_number || 0));
}
// Field Day = the Wednesday strictly after the last session's end. '' if the
// year has no sessions yet.
function fieldDayForYear(sessions, schoolYear) {
  const ends = calSessionsForYear(sessions, schoolYear).map(s => s.end_date).sort();
  return ends.length ? calSnapWed(ends[ends.length - 1], 1) : '';
}
// Ice Cream Social = the Wednesday strictly before the first session's start.
function iceCreamSocialForYear(sessions, schoolYear) {
  const rows = calSessionsForYear(sessions, schoolYear);
  return rows.length ? calSnapWed(rows[0].start_date, -1) : '';
}

// Session-anchored DEFAULT dates for special events (Erin, 2026-07-16).
// Surfaced only while the event has no saved date — the SEL's saved value
// always wins, and until then the suggestion tracks session-date edits.
// Anchors (sessions end on Wednesdays):
//   PJ Party + Maker's Market — the "mini session", two weeks after
//     Session 2 ends.
//   Passion Fair — the Wednesday after Session 3 ends.
//   Camp — TBD; the week right after Session 4 (Monday following its
//     end — historically "week of Mar 29" vs "week of Apr 5").
function specialEventDefaultDate(name, sessions, schoolYear) {
  const rows = calSessionsForYear(sessions, schoolYear);
  const endOf = n => {
    const r = rows.filter(s => String(s.session_number) === String(n))[0];
    return r ? r.end_date : '';
  };
  switch (name) {
    case 'PJ Party':
    case "Maker's Market":
      return calAddDays(endOf(2), 14);
    case 'Passion Fair':
      return calAddDays(endOf(3), 7);
    case 'Camp':
      return calAddDays(endOf(4), 5); // Wed end + 5 days = following Monday
    default:
      return '';
  }
}

// Build the read-only derived events for one school year. Each carries a
// synthetic string id (so the client can key/skip it), derived:true, and the
// action item / role it relates to. Returns [] when the year has no sessions
// to anchor the date math (June-1 morning build is still emitted — it doesn't
// need sessions).
function computeDerivedCalendarEvents(sessions, schoolYear) {
  if (!/^\d{4}-\d{4}$/.test(String(schoolYear))) return [];
  const F = parseInt(schoolYear.slice(0, 4), 10);
  const nextYr = (F + 1) + '-' + (F + 2);
  const out = [];
  const push = (key, title, date, end, note, role, icon) => {
    if (!date) return;
    out.push({
      id: 'derived:' + key + ':' + schoolYear,
      school_year: schoolYear, title: title, event_date: date, end_date: end || '',
      note: note || '', role: role || '', icon: icon || '📌', derived: true
    });
  };

  // Nth weekday of a month as YYYY-MM-DD (weekday 0=Sun … 3=Wed). Pure
  // arithmetic on UTC so the server timezone can't shift the day.
  const nthWeekdayOf = (year, month, weekday, nth) => {
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  };

  // Summer setup
  push('morning', 'Build morning classes', F + '-06-01', '',
    'Membership Director groups morning kids into age classes', 'Membership Director', '🌱');

  // Standing meetings (Erin, 2026-07-15): a Board Meeting the 3rd Wednesday
  // of July with the All Member Meeting one week later, and the same pair
  // anchored to the 1st Wednesday of April in the spring.
  const julyBoard = nthWeekdayOf(F, 7, 3, 3);
  push('boardmtg-summer', 'Board Meeting', julyBoard, '',
    'Summer board meeting — 3rd Wednesday of July', '', '🤝');
  push('allmember-summer', 'All Member Meeting', calAddDays(julyBoard, 7), '',
    'All-member meeting — one week after the summer board meeting', '', '📣');
  const aprilBoard = nthWeekdayOf(F + 1, 4, 3, 1);
  push('boardmtg-spring', 'Board Meeting', aprilBoard, '',
    'Spring board meeting — 1st Wednesday of April', '', '🤝');
  push('allmember-spring', 'All Member Meeting', calAddDays(aprilBoard, 7), '',
    'All-member meeting — one week after the spring board meeting', '', '📣');

  // Handbook review leads the FIRST board meeting of the year by a week
  // (Erin, 2026-07-19 — retimed from the original Ice-Cream-Social anchor)
  // so the updated handbook is ready to present there.
  push('handbook', 'Review & update the Membership Handbook', calAddDays(julyBoard, -7), '',
    'Communications Director reviews the Membership Handbook and publishes updates a week before the summer board meeting',
    'Communications Director', '📘');

  const ics = iceCreamSocialForYear(sessions, schoolYear);
  push('removemembers', 'Remove non-returning members', calAddDays(ics, -3), '',
    'Workspace cleanup for families who did not re-enroll (a few days before the Ice Cream Social)',
    'Communications Director', '🧹');
  push('icecream', 'Ice Cream Social', ics, '',
    'Welcome social — the Wednesday before the first session', '', '🍦');

  // Welcome Coordinator reaches out to each new family the week before co-op
  // begins (one week before the first session's start).
  const s1rows = calSessionsForYear(sessions, schoolYear);
  const s1start = s1rows.length ? s1rows[0].start_date : '';
  push('welcomeoutreach', 'Welcome outreach to new families', calAddDays(s1start, -7), '',
    'Welcome Coordinator reaches out to each new family the week before co-op begins — welcome them and answer questions',
    'Welcome Coordinator', '💛');

  // The five sessions — each carries its approval state so the Admin
  // Calendar can show the Proposed/Approved chip + Approve button.
  calSessionsForYear(sessions, schoolYear).forEach(s => {
    push('session' + s.session_number, s.name || ('Session ' + s.session_number),
      s.start_date, s.end_date, 'Co-op session', '', '📚');
    out[out.length - 1].dates_status = s.dates_status || 'approved';
  });

  // Year-end cluster, anchored to Field Day
  const fd = fieldDayForYear(sessions, schoolYear);
  push('regexisting', 'Registration opens — existing members (' + nextYr + ')', calAddDays(fd, -28), '',
    'Returning families re-enroll for next year (2 weeks before public)', 'Membership Director', '📝');
  push('regpublic', 'Registration opens — public (' + nextYr + ')', calAddDays(fd, -14), '',
    'Public registration for next year (2 weeks before Field Day)', 'Membership Director', '📝');
  push('fieldday', 'Field Day (last day)', fd, '',
    'Final day of the school year', '', '🎉');
  // Board terms are TWO years (2026-07-06): the confirm event lands only
  // after Field Day of cycle years — 2026, 2028, 2030… The Comms Director
  // updates board roles in Google Admin AND the portal that summer.
  if (fd && (parseInt(String(fd).slice(0, 4), 10) - 2026) % 2 === 0) {
    push('roleconfirm', 'Confirm board roles — new 2-year term', calAddDays(fd, 1), '',
      'Board terms run two years. Comms Director updates board roles in Google Admin (groups + mailbox access) and in the portal’s Roles Assignments, then marks the term confirmed.',
      'Communications Director', '🧭');
  }
  push('participationreset', 'Participation resets (' + nextYr + ')', calAddDays(fd, 1), '',
    'Volunteer participation counts reset to zero for ' + nextYr + ' — the new school year begins the day after Field Day', '', '🔄');
  const ends = calSessionsForYear(sessions, schoolYear).map(s => s.end_date).sort();
  if (ends.length) {
    push('setdates', 'Set next year’s session dates', calAddDays(ends[ends.length - 1], 14), '',
      'President / VP enter the ' + nextYr + ' session calendar', 'President / Vice President', '📆');
  }
  return out;
}

async function requireBoardMember(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const ok = await isBoardMember(auth.email);
  if (!ok) {
    res.status(403).json({
      error: 'Only board members can use the Admin Calendar.',
      youAre: auth.realEmail
    });
    return null;
  }
  return auth;
}

// GET ?calendar=1[&school_year=YYYY-YYYY]
// Returns every board calendar event (all years) so the client can build its
// year picker; the dataset is tiny. Sorted by date.
async function handleBoardCalendarGet(req, res) {
  // Read-only access is broader than edit: any board member PLUS the
  // Welcome Coordinator (who shows new families the upcoming co-op dates)
  // PLUS the Special Events Liaison (special-event dates live on this
  // calendar as of 2026-07-05). Saving/deleting manual events stays
  // board-only via requireBoardMember in handleBoardCalendarSave/Delete;
  // special-event dates save via kind='special-event-date' with its own
  // SEL/VP gate (requireSpecialEventsEditor).
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  // isSEL follows the 'special_events_manage' grant so anyone granted
  // event management can also READ the calendar their dates live on.
  const isSEL = await hasCapability(auth.email, 'special_events_manage');
  const canRead = await isBoardMember(auth.email) ||
    await hasCapability(auth.email, 'welcome_manage') || isSEL;
  if (!canRead) {
    return res.status(403).json({
      error: 'Only board members, the Welcome Coordinator, and the Special Events Liaison can view the calendar.',
      youAre: auth.realEmail
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, school_year, title, event_date, end_date, note, event_type,
             location, start_time, end_time, updated_at, updated_by
      FROM board_calendar_events
      ORDER BY event_date, start_time NULLS FIRST, id
    `;
    const manual = rows.map(r => ({
      id: r.id,
      school_year: r.school_year,
      title: r.title,
      event_date: calDateStr(r.event_date),
      end_date: calDateStr(r.end_date),
      note: r.note || '',
      location: r.location || '',
      event_type: r.event_type || 'task',
      start_time: r.start_time ? String(r.start_time).slice(0, 5) : '',
      end_time: r.end_time ? String(r.end_time).slice(0, 5) : '',
      derived: false,
      updated_at: r.updated_at,
      updated_by: r.updated_by
    }));

    // Derived (read-only) trigger dates computed off the session calendar.
    const sessRows = await sql`
      SELECT id, school_year, session_number, name, start_date, end_date, dates_status, gcal_event_id
      FROM co_op_sessions
    `;
    const sessions = sessRows.map(s => ({
      school_year: s.school_year,
      session_number: s.session_number,
      name: s.name,
      dates_status: s.dates_status || 'approved',
      start_date: calDateStr(s.start_date),
      end_date: calDateStr(s.end_date)
    }));
    // Compute for every year that has sessions, plus the active + next year
    // (so a not-yet-scheduled upcoming year still shows the June-1 morning
    // build prompt). De-duped.
    const active = activeSchoolYear();
    // Backfill-on-first-sight (Erin, 2026-07-14): current/upcoming
    // sessions that aren't on the Google Calendar yet publish now, so
    // already-entered dates appear without a re-save. Follows the same
    // co_op_sessions rows the Admin Calendar edits — a date change there
    // re-syncs via the sessions save hook in api/cleaning.js. Production
    // only: dev shares the one real calendar but has its own DB copy of
    // the sessions, so a dev backfill would double-publish everything.
    if (process.env.VERCEL_ENV === 'production') {
      for (const s of sessRows) {
        if (String(s.school_year) < active) continue;
        if (String(s.gcal_event_id || '')) continue;
        try {
          await syncSessionToGoogleCalendar(sql, s);
        } catch (gErr) {
          console.error('Session calendar backfill error (non-fatal):', (gErr && gErr.message) || gErr);
        }
      }
    }
    const F = parseInt(active.slice(0, 4), 10);
    const nextYr = (F + 1) + '-' + (F + 2);
    const years = Array.from(new Set(
      sessions.map(s => s.school_year).concat([active, nextYr])
    ));
    const derived = [];
    years.forEach(yr => { computeDerivedCalendarEvents(sessions, yr).forEach(e => derived.push(e)); });

    // Afternoon sign-up close dates on the calendar (Erin, 2026-07-17). This
    // is the deadline after which members can no longer pick and the
    // Afternoon Class Liaison places the kids who didn't sign up.
    try {
      const scWins = await sql`
        SELECT school_year, session_number, signup_end_date
        FROM class_signup_windows WHERE signup_end_date IS NOT NULL
      `;
      scWins.forEach(w => {
        derived.push({
          id: 'derived:signupclose:' + w.school_year + ':' + w.session_number,
          school_year: w.school_year,
          title: 'Afternoon sign-ups close — Session ' + w.session_number,
          event_date: calDateStr(w.signup_end_date), end_date: '',
          note: 'Member afternoon class sign-ups close; the Afternoon Class Liaison then places any kids who didn’t pick.',
          role: 'Afternoon Class Liaison', icon: '🎨', derived: true
        });
      });
    } catch (scErr) { console.error('signup-close calendar events failed (non-fatal):', scErr); }

    const events = manual.concat(derived)
      .sort((a, b) => (a.event_date || '').localeCompare(b.event_date || ''));

    // Special events (2026-07-05): their dates are managed HERE now (the
    // standalone Special Events manager is gone). Seed the standard list
    // for the active + next year so rows exist without any other visit,
    // then return every year's rows for the client's year picker.
    // Editing stays gated to SEL/VP via kind='special-event-date'.
    for (const yr of [active, nextYr]) {
      for (let i = 0; i < SPECIAL_EVENT_SEED.length; i++) {
        await sql`
          INSERT INTO special_events (school_year, name, sort_order, updated_by)
          VALUES (${yr}, ${SPECIAL_EVENT_SEED[i]}, ${i}, ${auth.realEmail})
          ON CONFLICT (school_year, name) DO NOTHING
        `;
      }
    }
    const seRows = await sql`
      SELECT id, school_year, name, event_date, date_status, sort_order,
             start_time, end_time, end_date, location, notes
      FROM special_events
      ORDER BY sort_order, name
    `;
    const specialEvents = seRows.map(e => {
      const saved = specialEventDateStr(e.event_date);
      // No saved date yet → suggest the session-anchored default (Erin,
      // 2026-07-16). date_is_default lets the client flag it; Save or
      // Approve stamps it into the row like any hand-picked date.
      const suggested = saved ? '' : specialEventDefaultDate(e.name, sessions, e.school_year);
      return {
        id: e.id,
        school_year: e.school_year,
        name: e.name,
        event_date: saved || suggested,
        date_is_default: !saved && !!suggested,
        date_status: e.date_status,
        start_time: e.start_time ? String(e.start_time).slice(0, 5) : '',
        end_time: e.end_time ? String(e.end_time).slice(0, 5) : '',
        end_date: specialEventDateStr(e.end_date),
        location: e.location || '',
        notes: e.notes || '',
        // Ice Cream Social + Field Day dates are driven by the session
        // calendar (derived events above) — read-only here.
        date_from_calendar: (e.name === 'Ice Cream Social' || e.name === 'Field Day'),
        // Standard events can't be deleted (they'd just re-seed); custom
        // ones added via "+ Add event" can.
        seeded: SPECIAL_EVENT_SEED.indexOf(e.name) !== -1
      };
    });
    // Mirror requireSpecialEventsEditor exactly: special-events management is
    // the capability (SEL/VP) OR any board member OR super user (Erin,
    // 2026-07-17). The client flag must match or the UI hides the controls.
    const viewerCanEditSpecialEvents = isSEL || isSuperUser(auth.email)
      || await isBoardMember(auth.email);

    return res.status(200).json({
      events,
      special_events: specialEvents,
      viewer_can_edit_special_events: viewerCanEditSpecialEvents
    });
  } catch (err) {
    console.error('board-calendar get error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Google Calendar sync for member-facing Admin Calendar events ──
// General + Field Trip events publish to the co-op Google Calendar so
// members see them where they already look; board tasks NEVER sync
// (Erin, 2026-07-14). Writes impersonate communications@ via domain-wide
// delegation (client ID 117854419582883083714, scope …/auth/calendar,
// authorized in Google Admin + round-trip verified the same day).
// Non-fatal by design: a Google hiccup must never block the DB save.
const RW_GCAL_ID = 'c_fdc0b20caba65262b9aac95ac1df638ab892fcdf1ee1ad79a1880dcc2a95b291@group.calendar.google.com';
const GCAL_SYNCED_TYPES = ['general', 'field_trip'];

function getCalendarWriteClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    // Local .env copies of the key carry raw newlines inside the
    // private_key string (invalid strict JSON; Vercel's env value parses
    // fine) — extract the two fields leniently so local test scripts work.
    const emailM = raw.match(/"client_email"\s*:\s*"([^"]+)"/);
    const keyM = raw.match(/"private_key"\s*:\s*"([\s\S]*?-----END PRIVATE KEY-----(?:\\n|\n)?)"/);
    if (!emailM || !keyM) throw e;
    credentials = { client_email: emailM[1], private_key: keyM[1] };
  }
  const jwt = new google.auth.JWT({
    email: credentials.client_email,
    key: String(credentials.private_key).replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
    subject: 'communications@rootsandwingsindy.com'
  });
  return google.calendar({ version: 'v3', auth: jwt });
}

// Google event body from a board_calendar_events row. All-day events use
// Google's EXCLUSIVE end-date convention; timed events carry the Indy
// timezone; a start time without an end time defaults to one hour.
function gcalBodyFromEvent(row) {
  const date = calDateStr(row.event_date);
  const endDate = calDateStr(row.end_date);
  const st = String(row.start_time || '').slice(0, 5);
  const et = String(row.end_time || '').slice(0, 5);
  const body = {
    summary: row.title || 'Co-op event',
    description: row.note || '',
    // Always set (even when blank) so clearing a location in the app
    // clears it on the Google event too.
    location: row.location || ''
  };
  if (st) {
    // Times apply even with an end date (a multi-day event spans from the
    // start time on day one to the end time on the last day) — the old
    // `st && !endDate` guard silently dropped times whenever an end date
    // was set (Erin, 2026-07-19: "entered times and they aren't showing
    // up on the google calendar").
    let end = et;
    if (!end) {
      const h = String(Math.min(23, parseInt(st.slice(0, 2), 10) + 1)).padStart(2, '0');
      end = h + st.slice(2);
    }
    // Explicit date:null — events.patch merges per-field, so converting a
    // formerly all-day event to timed must clear the old `date` or Google
    // rejects/keeps the all-day form.
    body.start = { dateTime: `${date}T${st}:00`, timeZone: 'America/Indianapolis', date: null };
    body.end = { dateTime: `${endDate || date}T${end}:00`, timeZone: 'America/Indianapolis', date: null };
  } else {
    const plusOne = (d) => {
      const t = new Date(d + 'T00:00:00Z');
      t.setUTCDate(t.getUTCDate() + 1);
      return t.toISOString().slice(0, 10);
    };
    body.start = { date: date, dateTime: null };
    body.end = { date: plusOne(endDate || date), dateTime: null };
  }
  return body;
}

// Upsert (or remove) the Google event for a row; returns the linked
// Google event id ('' when the row doesn't sync). Keeps gcal_event_id
// in step in the DB.
async function syncEventToGoogleCalendar(sql, row) {
  // Same gate as special events/sessions: dev + prod share the ONE real
  // Google Calendar, so only production may write to it. (Board events
  // were the lone ungated path — dev Admin Calendar testing could have
  // published or deleted real member-facing events.)
  if (process.env.VERCEL_ENV !== 'production') return '';
  const cal = getCalendarWriteClient();
  const synced = GCAL_SYNCED_TYPES.indexOf(row.event_type) !== -1;
  const gid = String(row.gcal_event_id || '');
  if (!synced) {
    // Re-typed to a board task (or never synced): remove any lingering
    // Google event so members don't see internal tasks.
    if (gid) {
      try { await cal.events.delete({ calendarId: RW_GCAL_ID, eventId: gid }); } catch (e) { /* already gone */ }
      await sql`UPDATE board_calendar_events SET gcal_event_id = '' WHERE id = ${row.id}`;
    }
    return '';
  }
  const body = gcalBodyFromEvent(row);
  if (gid) {
    try {
      await cal.events.patch({ calendarId: RW_GCAL_ID, eventId: gid, requestBody: body });
      return gid;
    } catch (e) {
      // Linked event vanished (deleted by hand on Google) — recreate.
    }
  }
  const ins = await cal.events.insert({ calendarId: RW_GCAL_ID, requestBody: body });
  const newId = (ins.data && ins.data.id) || '';
  if (newId && newId !== gid) {
    await sql`UPDATE board_calendar_events SET gcal_event_id = ${newId} WHERE id = ${row.id}`;
  }
  return newId;
}

// Publish (or remove) an APPROVED special event on the co-op Google Calendar,
// exactly like a field trip (Erin, 2026-07-18). Only an approved event with a
// date is published; a proposed/undated/deleted event is removed. Gated to
// production — dev + prod share the ONE real Google Calendar, so an ungated
// dev sync would double-publish. The row must carry: id, name, date_status,
// event_date, end_date, start_time, end_time, location, gcal_event_id.
async function syncSpecialEventToGoogleCalendar(sql, seRow) {
  if (process.env.VERCEL_ENV !== 'production') return;
  if (!seRow || !seRow.id) return;
  const cal = getCalendarWriteClient();
  const gid = String(seRow.gcal_event_id || '');
  const shouldPublish = seRow.date_status === 'approved' && !!calDateStr(seRow.event_date);
  if (!shouldPublish) {
    if (gid) {
      try { await cal.events.delete({ calendarId: RW_GCAL_ID, eventId: gid }); } catch (e) { /* already gone */ }
      await sql`UPDATE special_events SET gcal_event_id = '' WHERE id = ${seRow.id}`;
    }
    return;
  }
  // Reuse the field-trip body builder (note intentionally blank — the Notes
  // field was removed board-wide).
  const body = gcalBodyFromEvent({
    title: seRow.name, event_date: seRow.event_date, end_date: seRow.end_date,
    start_time: seRow.start_time, end_time: seRow.end_time, location: seRow.location, note: ''
  });
  if (gid) {
    try { await cal.events.patch({ calendarId: RW_GCAL_ID, eventId: gid, requestBody: body }); return; }
    catch (e) { /* linked event vanished — recreate below */ }
  }
  const ins = await cal.events.insert({ calendarId: RW_GCAL_ID, requestBody: body });
  const newId = (ins.data && ins.data.id) || '';
  if (newId && newId !== gid) {
    await sql`UPDATE special_events SET gcal_event_id = ${newId} WHERE id = ${seRow.id}`;
  }
}

// Co-op sessions publish as WEEKLY RECURRING co-op days, 9:40 AM –
// 3:15 PM (Erin, 2026-07-14), from the session's start Wednesday
// through its end date. Same patch-or-insert pattern as board events;
// gcal_event_id lives on co_op_sessions. IMPORTANT: callers gate this
// to VERCEL_ENV==='production' — dev + prod share the ONE real Google
// Calendar but have separate DBs, so an ungated dev sync would publish
// every session twice.
async function syncSessionToGoogleCalendar(sql, sess) {
  const start = calDateStr(sess.start_date);
  const end = calDateStr(sess.end_date);
  if (!start || !end) return '';
  const cal = getCalendarWriteClient();
  const body = {
    summary: 'Co-op — ' + (sess.name || ('Session ' + sess.session_number)),
    description: 'Roots & Wings co-op day, 9:40 AM – 3:15 PM',
    start: { dateTime: start + 'T09:40:00', timeZone: 'America/Indianapolis' },
    end: { dateTime: start + 'T15:15:00', timeZone: 'America/Indianapolis' },
    recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=' + end.replace(/-/g, '') + 'T235959Z']
  };
  const gid = String(sess.gcal_event_id || '');
  if (gid) {
    try {
      await cal.events.patch({ calendarId: RW_GCAL_ID, eventId: gid, requestBody: body });
      return gid;
    } catch (e) {
      // Linked event vanished — recreate below.
    }
  }
  const ins = await cal.events.insert({ calendarId: RW_GCAL_ID, requestBody: body });
  const newId = (ins.data && ins.data.id) || '';
  if (newId && newId !== gid) {
    await sql`UPDATE co_op_sessions SET gcal_event_id = ${newId} WHERE id = ${sess.id}`;
  }
  return newId;
}

// Best-effort removal of a linked Google event (used by session delete).
async function deleteGoogleCalendarEvent(gid) {
  if (!gid) return;
  try {
    await getCalendarWriteClient().events.delete({ calendarId: RW_GCAL_ID, eventId: gid });
  } catch (e) { /* already gone */ }
}

// POST kind='calendar-save' — insert a new event, or update an existing one
// when body.id is present. Any board member may write.
async function handleBoardCalendarSave(body, req, res) {
  const auth = await requireBoardMember(req, res);
  if (!auth) return;
  const validationErr = validateBoardCalendarEvent(body);
  if (validationErr) return res.status(400).json({ error: validationErr });
  const schoolYear = String(body.school_year).trim();
  const title = String(body.title).trim();
  const eventDate = String(body.event_date).trim();
  const endDate = String(body.end_date || '').trim() || null;
  const note = String(body.note || '').trim();
  const location = String(body.location || '').trim().slice(0, 200);
  // 'task' (board tasks pill), 'general', or 'field_trip' — the latter
  // two are member-facing and sync to the co-op Google Calendar.
  const rawType = String(body.event_type || 'task').trim();
  const eventType = (rawType === 'general' || rawType === 'field_trip') ? rawType : 'task';
  const startTime = String(body.start_time || '').trim() || null;
  const endTime = String(body.end_time || '').trim() || null;
  const id = body.id != null ? parseInt(body.id, 10) : null;
  try {
    const sql = getSql();
    let row;
    if (Number.isInteger(id) && id > 0) {
      const updated = await sql`
        UPDATE board_calendar_events
        SET school_year = ${schoolYear}, title = ${title}, event_date = ${eventDate},
            end_date = ${endDate}, note = ${note}, event_type = ${eventType},
            location = ${location}, start_time = ${startTime}, end_time = ${endTime},
            updated_at = NOW(), updated_by = ${auth.realEmail}
        WHERE id = ${id}
        RETURNING id, school_year, title, event_date, end_date, note, event_type, location, start_time, end_time, gcal_event_id, updated_at, updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Event not found.' });
      row = updated[0];
    } else {
      const inserted = await sql`
        INSERT INTO board_calendar_events
          (school_year, title, event_date, end_date, note, event_type, location, start_time, end_time, updated_at, updated_by)
        VALUES (${schoolYear}, ${title}, ${eventDate}, ${endDate}, ${note}, ${eventType}, ${location}, ${startTime}, ${endTime}, NOW(), ${auth.realEmail})
        RETURNING id, school_year, title, event_date, end_date, note, event_type, location, start_time, end_time, gcal_event_id, updated_at, updated_by
      `;
      row = inserted[0];
    }
    // Member-facing types publish to the co-op Google Calendar; board
    // tasks never do (and re-typing to task removes the Google event).
    let gcalSynced = false;
    try {
      gcalSynced = !!(await syncEventToGoogleCalendar(sql, row));
    } catch (gErr) {
      console.error('Google Calendar sync error (non-fatal):', (gErr && gErr.message) || gErr);
    }
    return res.status(200).json({
      gcal_synced: gcalSynced,
      event: {
        id: row.id,
        school_year: row.school_year,
        title: row.title,
        event_date: calDateStr(row.event_date),
        end_date: calDateStr(row.end_date),
        note: row.note || '',
        location: row.location || '',
        event_type: row.event_type || 'task',
        start_time: row.start_time ? String(row.start_time).slice(0, 5) : '',
        end_time: row.end_time ? String(row.end_time).slice(0, 5) : '',
        updated_at: row.updated_at,
        updated_by: row.updated_by
      }
    });
  } catch (err) {
    console.error('board-calendar save error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// POST kind='calendar-delete' — remove an event by id.
async function handleBoardCalendarDelete(body, req, res) {
  const auth = await requireBoardMember(req, res);
  if (!auth) return;
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id is required.' });
  }
  try {
    const sql = getSql();
    const existing = await sql`SELECT id, gcal_event_id FROM board_calendar_events WHERE id = ${id}`;
    if (existing.length === 0) return res.status(404).json({ error: 'Event not found.' });
    await sql`DELETE FROM board_calendar_events WHERE id = ${id}`;
    // Take the linked Google event with it (non-fatal). Prod-only — the
    // real calendar is shared, dev must never delete member-facing events.
    const gid = String(existing[0].gcal_event_id || '');
    if (gid && process.env.VERCEL_ENV === 'production') {
      try {
        await getCalendarWriteClient().events.delete({ calendarId: RW_GCAL_ID, eventId: gid });
      } catch (gErr) {
        console.error('Google Calendar delete error (non-fatal):', (gErr && gErr.message) || gErr);
      }
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('board-calendar delete error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Welcome List (Welcome Coordinator) ────────────────────────────────
// The Welcome Coordinator's purpose-built view of this season's NEW
// families: name + contact info + a "mark as welcomed" toggle backed by
// the welcome_outreach table. Deliberately independent of the Comms
// Director's onboarding queue so the two roles don't step on each other.

// Read access: Welcome Coordinator (via the 'welcome_manage' grant), any
// board member, or a super user.
async function canViewWelcomeList(email) {
  if (isSuperUser(email)) return true;
  if (await hasCapability(email, 'welcome_manage')) return true;
  return isBoardMember(email);
}
// Write access (mark/un-mark welcomed): 'welcome_manage' grant or super user.
async function canActWelcomeList(email) {
  if (isSuperUser(email)) return true;
  return hasCapability(email, 'welcome_manage');
}

// GET ?welcome=1[&season=YYYY-YYYY] — new families + welcomed status.
async function handleWelcomeListGet(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!await canViewWelcomeList(auth.email)) {
    const expected = await getRoleHolderEmail('Welcome Coordinator');
    return res.status(403).json({
      error: 'Only the Welcome Coordinator can view the Welcome List.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }
  const season = String(req.query.season || DEFAULT_SEASON);
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT r.id, r.email, r.main_learning_coach, r.existing_family_name,
             r.phone, r.track, r.track_other, r.kids, r.created_at,
             w.welcomed_at, w.welcomed_by, w.note AS welcome_note,
             w.met_at, w.met_by
      FROM registrations r
      LEFT JOIN welcome_outreach w ON w.registration_id = r.id
      WHERE r.season = ${season} AND r.declined_at IS NULL
      ORDER BY r.created_at DESC
    `;
    // Keep only NEW families — same canonical rule as the Membership
    // Report / Directory First-Year badge (keyed by personal + workspace
    // email). Degrades to showing all rows if the lookup fails, so the
    // coordinator never gets an empty list from a transient error.
    let families = rows;
    try {
      const firstSeasons = await firstSeasonByEmail(sql);
      const seasonLabel = seasonToYearLabel(season);
      families = rows.filter(r => {
        const fs = firstSeasons[String(r.email || '').toLowerCase().trim()] || '';
        return !!(fs && seasonLabel && fs >= seasonLabel);
      });
    } catch (nmErr) {
      console.error('Welcome List new-member filter failed (non-fatal):', nmErr);
    }
    const out = families.map(r => ({
      id: r.id,
      name: r.main_learning_coach || r.existing_family_name || '',
      email: r.email || '',
      phone: r.phone || '',
      track: r.track === 'Other' ? (r.track_other || 'Other') : (r.track || ''),
      kids: Array.isArray(r.kids) ? r.kids : [],
      created_at: r.created_at,
      welcomed_at: r.welcomed_at || null,
      welcomed_by: r.welcomed_by || '',
      welcome_note: r.welcome_note || '',
      met_at: r.met_at || null,
      met_by: r.met_by || ''
    }));
    return res.status(200).json({ families: out });
  } catch (err) {
    console.error('Welcome List get error:', err);
    return res.status(500).json({ error: 'Could not load the Welcome List.' });
  }
}

// Welcome lifecycle stage updates. kind is one of:
//   welcome-mark        — record the initial welcome (upsert)
//   welcome-unmark      — clear the whole row (back to not-welcomed)
//   welcome-meet-mark   — record the Meet & Greet (implies welcomed)
//   welcome-meet-unmark — clear just the Meet & Greet, keep welcomed
async function handleWelcomeMark(body, req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  if (!await canActWelcomeList(auth.email)) {
    const expected = await getRoleHolderEmail('Welcome Coordinator');
    return res.status(403).json({
      error: 'Only the Welcome Coordinator can update the Welcome List.',
      youAre: auth.realEmail,
      expected: expected || '(unknown)'
    });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id is required.' });
  }
  const kind = String(body.kind || '').toLowerCase();
  const note = String(body.note || '').trim().slice(0, 1000);
  const sql = getSql();
  try {
    // realEmail (not the View-As email) is the audit trail.
    const by = String(auth.realEmail || auth.email || '');

    if (kind === 'welcome-unmark') {
      await sql`DELETE FROM welcome_outreach WHERE registration_id = ${id}`;
      return res.status(200).json({ ok: true, welcomed_at: null, met_at: null });
    }

    if (kind === 'welcome-meet-unmark') {
      // Keep the welcome; just clear the Meet & Greet stage.
      const rows = await sql`
        UPDATE welcome_outreach SET met_at = NULL, met_by = ''
        WHERE registration_id = ${id}
        RETURNING welcomed_at, welcomed_by, met_at, met_by
      `;
      const row = rows[0] || {};
      return res.status(200).json({ ok: true, welcomed_at: row.welcomed_at || null, welcomed_by: row.welcomed_by || '', met_at: null, met_by: '' });
    }

    if (kind === 'welcome-meet-mark') {
      // Record the Meet & Greet. Upsert so it also stamps the welcome if the
      // family somehow skipped straight to it (welcomed_at defaults to NOW()).
      const rows = await sql`
        INSERT INTO welcome_outreach (registration_id, welcomed_by, met_at, met_by)
        VALUES (${id}, ${by}, NOW(), ${by})
        ON CONFLICT (registration_id)
        DO UPDATE SET met_at = NOW(), met_by = ${by}
        RETURNING welcomed_at, welcomed_by, met_at, met_by
      `;
      const row = rows[0] || {};
      return res.status(200).json({ ok: true, welcomed_at: row.welcomed_at || null, welcomed_by: row.welcomed_by || '', met_at: row.met_at || null, met_by: row.met_by || by });
    }

    // Default: welcome-mark — record the initial welcome.
    const rows = await sql`
      INSERT INTO welcome_outreach (registration_id, welcomed_at, welcomed_by, note)
      VALUES (${id}, NOW(), ${by}, ${note})
      ON CONFLICT (registration_id)
      DO UPDATE SET welcomed_at = NOW(), welcomed_by = ${by}, note = ${note}
      RETURNING welcomed_at, welcomed_by, met_at, met_by
    `;
    const row = rows[0] || {};
    return res.status(200).json({ ok: true, welcomed_at: row.welcomed_at || null, welcomed_by: row.welcomed_by || by, met_at: row.met_at || null, met_by: row.met_by || '' });
  } catch (err) {
    console.error('Welcome List mark error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// GET ?community=1[&season=YYYY-YYYY] — a members-facing snapshot of this
// season's registered families. Unlike the board-only Membership Report, this
// is readable by ANY signed-in @rootsandwingsindy.com member (no role gate) and
// returns ONLY non-sensitive fields — family name, the coach + kids' first
// names, and the family's track — the same directory-level info members already
// see. No email / phone / address / payment / waiver data is exposed.
function communityTrack(track, trackOther) {
  switch (String(track || '')) {
    case 'Morning Only':   return { key: 'am',   label: 'AM only' };
    case 'Afternoon Only': return { key: 'pm',   label: 'PM only' };
    case 'Both':           return { key: 'both', label: 'AM + PM' };
    default:               return { key: 'other', label: String(trackOther || track || 'Other') };
  }
}
async function handleCommunitySnapshot(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const season = String(req.query.season || DEFAULT_SEASON);
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT r.id, r.email, r.main_learning_coach, r.existing_family_name,
             r.kids, r.track, r.track_other, r.created_at
      FROM registrations r
      WHERE r.season = ${season} AND r.declined_at IS NULL
      ORDER BY r.main_learning_coach
    `;
    // New vs returning — same canonical rule as the Directory First-Year badge
    // / Membership report (firstSeasonByEmail, keyed by the personal email on
    // the registration). Degrades gracefully if the lookup fails.
    let firstSeasons = {};
    let seasonLabel = '';
    try {
      firstSeasons = await firstSeasonByEmail(sql);
      seasonLabel = seasonToYearLabel(season);
    } catch (nmErr) {
      console.error('Community snapshot new-member lookup failed (non-fatal):', nmErr);
    }
    // Each kid's morning class ("Pigeons", …) from the Morning Class Builder's
    // placements. Keyed by derived family_email + kid first name — the same
    // derivation the builder uses (deriveFamilyName/deriveFamilyEmail), so keys
    // line up. Non-morning kids simply have no class. Non-fatal if it fails.
    const classByKid = {};
    try {
      const clsRows = await sql`
        SELECT family_email, kid_first_name, class_group
        FROM morning_class_assignments
        WHERE school_year = ${season} AND class_group <> ''
      `;
      clsRows.forEach(c => {
        classByKid[String(c.family_email || '').toLowerCase() + '|' + String(c.kid_first_name || '').toLowerCase()] = c.class_group;
      });
    } catch (clsErr) {
      console.error('Community snapshot class lookup failed (non-fatal):', clsErr);
    }
    const families = rows.map(r => {
      const coach = r.main_learning_coach || r.existing_family_name || '';
      const familyName = deriveFamilyName(r.main_learning_coach, r.existing_family_name);
      const familyEmail = String(deriveFamilyEmail(r.main_learning_coach, familyName) || '').toLowerCase();
      const kids = (Array.isArray(r.kids) ? r.kids : []).map(k => {
        const nm = (k && (k.name || k.first_name)) || '';
        const first = String(nm).trim().split(/\s+/)[0].toLowerCase();
        return { name: nm, class: (familyEmail && first) ? (classByKid[familyEmail + '|' + first] || '') : '' };
      }).filter(k => k.name);
      const t = communityTrack(r.track, r.track_other);
      const fs = firstSeasons[String(r.email || '').toLowerCase().trim()] || '';
      const isNewMember = !!(fs && seasonLabel && fs >= seasonLabel);
      // Display name: prefer the explicit family surname, else the coach's.
      const surname = r.existing_family_name ||
        (coach.trim().split(/\s+/).pop() || coach);
      return {
        id: r.id,
        name: surname,
        coach: coach,
        kids: kids,
        track: t.key,
        trackLabel: t.label,
        isNewMember: isNewMember
      };
    });
    return res.status(200).json({ season: season, families: families });
  } catch (err) {
    console.error('Community snapshot error:', err);
    return res.status(500).json({ error: 'Could not load the community snapshot.' });
  }
}

// ── Board at a Glance ─────────────────────────────────────────────────
// One tile per board role (plus the Cleaning Crew + Special Events
// liaisons) with live headline counts, so every board member can see
// what the others are working on without cloning their workspaces.
// Board-gated; each metric is computed in its own try/catch so a single
// broken table degrades that tile to "—" instead of failing the card.
async function handleBoardGlance(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const canView = isSuperUser(auth.email) || await isBoardMember(auth.email);
  if (!canView) {
    return res.status(403).json({
      error: 'Board at a Glance is only visible to board members.',
      youAre: auth.realEmail
    });
  }
  const sql = getSql();
  const year = activeSchoolYear();
  const season = DEFAULT_SEASON;

  // Holders: every active board role, plus the two liaison-run programs
  // the board tracks (cleaning rota + special events). Names resolve
  // through people (never role_holders' snapshot columns).
  let holders = [];
  try {
    holders = await sql`
      SELECT r.title, r.icon_emoji, r.display_order, r.category,
             rhv.person_email,
             NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') AS people_name
      FROM roles r
      LEFT JOIN role_holders_v2 rhv
        ON rhv.role_id = r.id AND rhv.school_year = ${year} AND rhv.ended_at IS NULL
      LEFT JOIN people p
        ON (LOWER(p.email) = LOWER(rhv.person_email) OR LOWER(p.family_email) = LOWER(rhv.person_email))
        AND p.role = 'mlc'
      WHERE r.status = 'active'
        AND (r.category = 'board'
             OR LOWER(REPLACE(r.title, '-', ' ')) IN ('cleaning crew liaison', 'special events liaison'))
      ORDER BY (r.category = 'board') DESC, r.display_order ASC, r.id ASC
    `;
  } catch (err) {
    console.error('board-glance holders lookup failed:', err);
  }

  // Metric queries — independent, each optional.
  const metric = async (fn) => { try { return await fn(); } catch (e) { console.error('board-glance metric failed:', e); return null; } };
  const [pipeline, awaitingReg, pendingPay, waivers, afternoon, morning, cleaning, events, boardTasks, onboard] = await Promise.all([
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('inquiry','requested','scheduled'))::int AS pre_tour,
               COUNT(*) FILTER (WHERE status IN ('toured','followed_up'))::int AS post_tour
        FROM tours`;
      return r[0];
    }),
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*)::int AS n
        FROM registration_invites i
        LEFT JOIN registrations reg
          ON LOWER(reg.email) = LOWER(i.email) AND reg.season = i.season AND reg.declined_at IS NULL
        WHERE i.season = ${season} AND i.dismissed_at IS NULL AND reg.id IS NULL`;
      return r[0].n;
    }),
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*)::int AS n FROM registrations
        WHERE season = ${season} AND declined_at IS NULL AND LOWER(COALESCE(payment_status, '')) <> 'paid'`;
      return r[0].n;
    }),
    metric(async () => {
      // "Pending" matches the Comms To Do exactly (waivers awaiting a
      // first send — handleWaiversCounts), not every unsigned row.
      const r = await sql`
        SELECT COUNT(*) FILTER (WHERE ws.signed_at IS NULL AND ws.last_sent_at IS NULL)::int AS pending
        FROM waiver_signatures ws
        LEFT JOIN registrations reg ON reg.id = ws.registration_id
        WHERE ws.role IN ('backup_coach', 'one_off', 'guest', 'community_liaison', 'kid_addition')
          AND (ws.registration_id IS NULL OR reg.declined_at IS NULL)`;
      return r[0].pending;
    }),
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
               COUNT(*) FILTER (WHERE status = 'submitted')::int AS inbox
        FROM class_submissions WHERE school_year = ${year}`;
      return r[0];
    }),
    metric(async () => {
      // Only assignments whose kid still exists count (kid_id-first, name
      // fallback for unmapped legacy rows) — orphaned rows are invisible
      // in the builder and must not inflate the tile (2026-07-19).
      const r = await sql`
        SELECT COUNT(*) FILTER (WHERE a.class_group <> '')::int AS placed,
               COUNT(*)::int AS total,
               (SELECT status FROM morning_class_plans WHERE school_year = ${year}) AS plan_status
        FROM morning_class_assignments a
        JOIN kids k
          ON (a.kid_id IS NOT NULL AND k.id = a.kid_id)
          OR (a.kid_id IS NULL
              AND LOWER(k.family_email) = LOWER(a.family_email)
              AND LOWER(k.first_name) = LOWER(a.kid_first_name))
        WHERE a.school_year = ${year}`;
      return r[0];
    }),
    metric(async () => {
      // Nearest current-or-upcoming session's unassigned (non-floater) areas —
      // same semantics as the liaison's own To Do count.
      const sess = await sql`
        SELECT session_number FROM co_op_sessions
        WHERE school_year = ${year} AND end_date >= CURRENT_DATE
        ORDER BY session_number ASC LIMIT 1`;
      const sessionNumber = sess.length ? sess[0].session_number : 1;
      const r = await sql`
        SELECT COUNT(*)::int AS open FROM cleaning_areas a
        WHERE a.floor_key <> 'floater'
          AND NOT EXISTS (
            SELECT 1 FROM cleaning_assignments ca
            WHERE ca.cleaning_area_id = a.id
              AND ca.session_number = ${sessionNumber}
              AND ca.school_year = ${year})`;
      return { session: sessionNumber, open: r[0].open };
    }),
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM special_event_people sep
                 WHERE sep.event_id = e.id AND sep.role = 'lead'
                   AND (sep.person_name <> '' OR sep.person_email <> '')))::int AS staffed
        FROM special_events e WHERE e.school_year = ${year}`;
      const t = await sql`
        SELECT COUNT(*)::int AS open FROM event_tasks t
        JOIN special_events e ON e.id = t.special_event_id
        WHERE e.school_year = ${year} AND t.done_at IS NULL`;
      return { total: r[0].total, staffed: r[0].staffed, openTasks: t[0].open };
    }),
    metric(async () => {
      const r = await sql`
        SELECT COUNT(*)::int AS n FROM board_calendar_events
        WHERE event_type = 'task' AND school_year = ${year}
          AND event_date >= CURRENT_DATE AND event_date < CURRENT_DATE + INTERVAL '30 days'`;
      return r[0].n;
    }),
    metric(async () => {
      // New members ready to onboard — mirrors the client's
      // isReadyToOnboard filter on the Comms To Do: paid, agreement
      // signed, genuinely new family, welcome email not yet sent.
      const r = await sql`
        SELECT COUNT(*)::int AS n FROM registrations
        WHERE season = ${season} AND declined_at IS NULL
          AND LOWER(COALESCE(payment_status, '')) = 'paid'
          AND waiver_member_agreement = TRUE
          AND COALESCE(signature_name, '') <> ''
          AND COALESCE(existing_family_name, '') = ''
          AND welcome_email_sent_at IS NULL`;
      return r[0].n;
    })
  ]);

  // Metrics + View targets per role. Each tile carries every view its
  // role's work spans (Erin, 2026-07-15: "the VP View only shows one of
  // many task views") — `views` keys map to board-readable reports and
  // read-only Roles Assignments lenses on the client.
  const metricsFor = (title) => {
    const key = String(title || '').toLowerCase().replace(/-/g, ' ');
    if (key === 'membership director') {
      const m = [];
      if (pipeline) m.push({ label: 'in pipeline', value: pipeline.pre_tour + pipeline.post_tour });
      if (awaitingReg != null) m.push({ label: 'awaiting registration', value: awaitingReg });
      return { metrics: m, views: [
        { key: 'member-pipeline', label: 'Pipeline' },
        { key: 'reg-links', label: 'Reg Links' },
        { key: 'morning-classes', label: 'Morning Classes' },
        { key: 'membership-report', label: 'Members' }
      ] };
    }
    if (key === 'treasurer') {
      return { metrics: pendingPay == null ? [] : [{ label: 'payments pending', value: pendingPay }], views: [
        { key: 'membership-report', label: 'Payments' }
      ] };
    }
    if (key === 'communications director') {
      // Members to onboard + pending waivers — the same two counts as
      // the Comms To Do items (Erin, 2026-07-16).
      const m = [];
      if (onboard != null) m.push({ label: 'members to onboard', value: onboard });
      if (waivers != null) m.push({ label: 'waivers pending', value: waivers });
      return { metrics: m, views: [
        { key: 'waivers-report', label: 'Waivers' },
        { key: 'membership-report', label: 'Members' }
      ] };
    }
    if (key === 'vice president') {
      const m = [];
      if (morning && morning.total > 0) m.push({ label: 'morning kids placed (' + (morning.plan_status || 'draft') + ')', value: morning.placed + '/' + morning.total });
      if (afternoon) {
        m.push({ label: 'afternoon classes scheduled', value: afternoon.scheduled });
        // "Review" = schedule, mark reviewed, or decline in the Class
        // Builder (testers, 2026-07-16: the old "awaiting review" label
        // implied an approval action that doesn't exist).
        if (afternoon.inbox > 0) m.push({ label: 'class submissions to review in the Class Builder', value: afternoon.inbox });
      }
      return { metrics: m, views: [
        // Schedules (issue #8): the adult × hour / kid × hour placement
        // grid. Board members open it read-only; the VP + Afternoon
        // Class Liaison place people from it.
        { key: 'schedules', label: 'Schedules' },
        { key: 'roles-am', label: 'Morning' },
        { key: 'roles-pm', label: 'Afternoon' },
        { key: 'roles-cleaning', label: 'Cleaning' },
        { key: 'roles-se', label: 'Events' }
      ] };
    }
    if (key === 'president') {
      return { metrics: boardTasks == null ? [] : [{ label: 'board tasks next 30 days', value: boardTasks }], views: [
        { key: 'admin-calendar', label: 'Calendar' }
      ] };
    }
    if (key === 'secretary') {
      return { metrics: [], views: [{ key: 'admin-calendar', label: 'Calendar' }] };
    }
    if (key === 'sustaining director') {
      return { metrics: [], views: [{ key: 'membership-report', label: 'Members' }] };
    }
    if (key === 'cleaning crew liaison') {
      return { metrics: !cleaning ? [] : [{ label: 'areas open — Session ' + cleaning.session, value: cleaning.open }], views: [
        { key: 'roles-cleaning', label: 'Rota' }
      ] };
    }
    if (key === 'special events liaison') {
      const m = [];
      if (events) {
        m.push({ label: 'events staffed', value: events.staffed + '/' + events.total });
        if (events.openTasks > 0) m.push({ label: 'planning tasks open', value: events.openTasks });
      }
      return { metrics: m, views: [{ key: 'roles-se', label: 'Events & people' }] };
    }
    return { metrics: [], views: [] };
  };

  // One tile per role; co-holders' names join with " & ".
  const byRole = new Map();
  holders.forEach(h => {
    const t = String(h.title || '');
    let tile = byRole.get(t);
    if (!tile) {
      const extra = metricsFor(t);
      tile = {
        role: t,
        icon: h.icon_emoji || '',
        holder: '',
        isBoard: h.category === 'board',
        metrics: extra.metrics,
        views: extra.views
      };
      byRole.set(t, tile);
    }
    if (h.people_name && tile.holder.indexOf(h.people_name) === -1) {
      tile.holder = tile.holder ? tile.holder + ' & ' + h.people_name : h.people_name;
    }
  });
  const tiles = Array.from(byRole.values());
  return res.status(200).json({ school_year: year, season: season, tiles: tiles });
}

// ── Board Notes ───────────────────────────────────────────────────────
// Shared scratchpad for the whole board (Erin, 2026-07-16): any board
// member can add a note; author or super user can remove one. Same
// visibility gate as Board at a Glance.
async function boardNotesGate(req, res) {
  const auth = await verifyWorkspaceAuthWithViewAs(req);
  if (!auth) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  const canView = isSuperUser(auth.email) || await isBoardMember(auth.email);
  if (!canView) {
    res.status(403).json({ error: 'Board Notes are only visible to board members.' });
    return null;
  }
  return auth;
}

async function handleBoardNotesGet(req, res) {
  const auth = await boardNotesGate(req, res);
  if (!auth) return;
  const sql = getSql();
  const rows = await sql`
    SELECT n.id, n.note, LOWER(n.created_by) AS created_by, n.created_at,
           (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
             WHERE LOWER(p.email) = LOWER(n.created_by)
                OR LOWER(p.personal_email) = LOWER(n.created_by) LIMIT 1) AS author_name
    FROM board_notes n
    ORDER BY n.created_at DESC
    LIMIT 100
  `;
  return res.status(200).json({
    notes: rows.map(r => ({
      id: r.id,
      note: r.note,
      created_by: r.created_by,
      author: r.author_name || String(r.created_by || '').split('@')[0],
      created_at: r.created_at
    })),
    you: String(auth.realEmail || auth.email || '').toLowerCase(),
    is_super: isSuperUser(auth.realEmail || auth.email)
  });
}

async function handleBoardNoteAdd(body, req, res) {
  const auth = await boardNotesGate(req, res);
  if (!auth) return;
  const note = String((body || {}).note || '').trim().slice(0, 1000);
  if (!note) return res.status(400).json({ error: 'Write a note first.' });
  const sql = getSql();
  // Author = the REAL login (a super user or dev tester posting through
  // View As signs their own name, not the impersonated member's).
  const author = String(auth.realEmail || auth.email || '').toLowerCase();
  const ins = await sql`
    INSERT INTO board_notes (note, created_by) VALUES (${note}, ${author})
    RETURNING id, created_at
  `;
  return res.status(201).json({ ok: true, id: ins[0].id, created_at: ins[0].created_at });
}

async function handleBoardNoteDelete(body, req, res) {
  const auth = await boardNotesGate(req, res);
  if (!auth) return;
  const id = parseInt((body || {}).id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const sql = getSql();
  const rows = await sql`SELECT created_by FROM board_notes WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Note not found.' });
  const real = String(auth.realEmail || auth.email || '').toLowerCase();
  if (String(rows[0].created_by || '').toLowerCase() !== real && !isSuperUser(real)) {
    return res.status(403).json({ error: 'Only the note’s author can remove it.' });
  }
  await sql`DELETE FROM board_notes WHERE id = ${id}`;
  return res.status(200).json({ ok: true, id });
}

// ══ Enrollment change requests — the Membership approval queue ══════
// (Erin, 2026-07-19, Option B: gate BEFORE.) A family's schedule change /
// kid add / kid removal creates a PENDING request; builders, rosters, and
// dues keep the old truth until the Membership Director approves. add_kid
// additionally requires a signed waiver before approval. Deny reverts
// (and for add_kid deletes the pending kid row). Every transition
// notifies the affected side in-portal.

async function membershipMayDecide(realEmail) {
  if (isSuperUser(realEmail)) return true;
  if (await hasCapability(realEmail, 'member_schedule_edit')) return true;
  // Dev/preview: testers exercise the queue while impersonating.
  return !!(process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production');
}

async function notifyEnrollment(sql, recipientEmail, title, bodyTxt) {
  try {
    await sql`
      INSERT INTO notifications (recipient_email, type, title, body, link_url)
      VALUES (${String(recipientEmail || '').toLowerCase()}, 'enrollment_request', ${title}, ${bodyTxt}, '')
    `;
  } catch (e) { console.error('enrollment notification failed (non-fatal):', e.message); }
}

async function notifyMembershipDirector(sql, title, bodyTxt) {
  let to = '';
  try { to = await getRoleHolderEmail('Membership Director'); } catch (e) { /* fallback below */ }
  await notifyEnrollment(sql, to || 'membership@rootsandwingsindy.com', title, bodyTxt);
}

// GET ?list=enrollment_requests — Membership's queue (pending first, then
// recent decisions). ?list=enrollment_requests&family_email=… — a family's
// own requests (drives the pending chips in Edit My Info).
async function handleEnrollmentRequestList(req, res) {
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const sql = getSql();
  const famScope = normalizeEmail(req.query.family_email || '');
  if (famScope) {
    if (!(await canEditFamily(sql, user.email, famScope))) {
      return res.status(403).json({ error: 'You can only view your own family’s requests.' });
    }
    const rows = await sql`
      SELECT id, kind, kid_id, kid_first_name, season, requested_schedule,
             prior_schedule, waiver_signature_id, status, requested_at, decided_at, decision_note
      FROM enrollment_change_requests
      WHERE LOWER(family_email) = ${famScope} AND season = ${DEFAULT_SEASON}
      ORDER BY requested_at DESC
      LIMIT 50
    `;
    // Ride the waiver signing state along so the EMI chip can say
    // "waiver needed" vs "awaiting Membership".
    for (const r of rows) {
      if (r.kind === 'add_kid' && r.waiver_signature_id) {
        const w = await sql`SELECT signed_at, pending_token FROM waiver_signatures WHERE id = ${r.waiver_signature_id}`;
        r.waiver_signed = !!(w[0] && w[0].signed_at);
        if (!r.waiver_signed && w[0]) r.waiver_token = w[0].pending_token;
      }
    }
    // Unsigned kid_addition waivers WITHOUT a queue row (privileged adds
    // enroll directly) also feed the My Family banner. Kid name lives in
    // the note ("Covers newly added child: X") — our own format.
    let pendingWaivers = [];
    try {
      const wvRows = await sql`
        SELECT pending_token, note FROM waiver_signatures
        WHERE season = ${DEFAULT_SEASON} AND role = 'kid_addition'
          AND LOWER(family_email) = ${famScope} AND signed_at IS NULL AND pending_token IS NOT NULL
      `;
      pendingWaivers = wvRows.map(w => ({
        waiver_token: w.pending_token,
        kid_first_name: String(w.note || '').replace(/^Covers newly added child:\s*/i, '').trim().split(/\s+/)[0] || 'your new kid'
      }));
    } catch (e) { /* banner extra only */ }
    // Unsigned Backup Learning Coach waivers too (Erin, 2026-07-19): the
    // family should see their BLC hasn't signed. EMI-era rows store the
    // family key; registration-era rows store the personal email, so
    // match those through the registration's stored family_email.
    let pendingBlc = [];
    try {
      const blcRows = await sql`
        SELECT ws.person_name, ws.pending_token FROM waiver_signatures ws
        WHERE ws.season = ${DEFAULT_SEASON} AND ws.role = 'backup_coach'
          AND ws.signed_at IS NULL AND ws.pending_token IS NOT NULL
          AND (LOWER(ws.family_email) = ${famScope}
               OR ws.registration_id IN (
                 SELECT id FROM registrations WHERE LOWER(family_email) = ${famScope} AND season = ${DEFAULT_SEASON}))
      `;
      pendingBlc = blcRows.map(w => ({ name: w.person_name || 'Your Backup Learning Coach', waiver_token: w.pending_token }));
    } catch (e) { /* banner extra only */ }
    return res.status(200).json({ requests: rows, pending_waivers: pendingWaivers, pending_blc_waivers: pendingBlc });
  }
  if (!(await membershipMayDecide(user.realEmail || user.email))) {
    return res.status(403).json({ error: 'Only the Membership Director can review enrollment requests.' });
  }
  const rows = await sql`
    SELECT r.id, r.kind, r.kid_id, r.family_email, r.kid_first_name, r.season,
           r.requested_schedule, r.prior_schedule, r.waiver_signature_id,
           r.status, r.requested_by, r.requested_at, r.decided_by, r.decided_at, r.decision_note,
           mp.family_name,
           w.signed_at AS waiver_signed_at
    FROM enrollment_change_requests r
    LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(r.family_email)
    LEFT JOIN waiver_signatures w ON w.id = r.waiver_signature_id
    WHERE r.season = ${DEFAULT_SEASON}
    ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
    LIMIT 100
  `;
  return res.status(200).json({ requests: rows });
}

// POST kind='enrollment-request-decide' { id, approve, note }
async function handleEnrollmentRequestDecide(body, req, res) {
  const user = await verifyWorkspaceAuthWithViewAs(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const real = user.realEmail || user.email;
  if (!(await membershipMayDecide(real))) {
    return res.status(403).json({ error: 'Only the Membership Director can decide enrollment requests.' });
  }
  const id = parseInt(body.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const approve = body.approve === true || String(body.approve) === 'true';
  const note = String(body.note || '').trim().slice(0, 500);
  const sql = getSql();
  const rows = await sql`SELECT * FROM enrollment_change_requests WHERE id = ${id}`;
  if (!rows.length) return res.status(404).json({ error: 'Request not found.' });
  const rq = rows[0];
  if (rq.status !== 'pending') return res.status(409).json({ error: 'That request was already decided.' });

  try {
    if (approve) {
      if (rq.kind === 'schedule_change') {
        if (!rq.kid_id) return res.status(409).json({ error: 'That kid no longer exists.' });
        await sql`UPDATE kids SET schedule = ${rq.requested_schedule}, updated_at = NOW() WHERE id = ${rq.kid_id}`;
        await sql`
          UPDATE kid_enrollments SET schedule = ${rq.requested_schedule}, updated_at = NOW(), updated_by = ${real}
          WHERE kid_id = ${rq.kid_id} AND season = ${rq.season}
        `;
        // Parity with the direct (privileged) edit path — ship-gate
        // 2026-07-19: a switch to morning-only drops the kid's current-
        // season afternoon picks, and the family's registration track
        // re-syncs from the live kid schedules.
        if (rq.requested_schedule === 'morning') {
          try {
            await sql`
              DELETE FROM class_signup_picks
              WHERE school_year = ${rq.season}
                AND (kid_id = ${rq.kid_id}
                     OR (kid_id IS NULL AND LOWER(family_email) = LOWER(${rq.family_email})
                         AND LOWER(kid_first_name) = LOWER(${rq.kid_first_name})))
            `;
          } catch (e) { console.error('approve morning-switch pick cleanup (non-fatal):', e); }
        }
        try {
          const famKids = await sql`SELECT schedule FROM kids WHERE LOWER(family_email) = LOWER(${rq.family_email})`;
          const s = k => String(k.schedule || '').toLowerCase();
          const hasAM = famKids.some(k => s(k) === 'all-day' || s(k) === 'morning');
          const hasPM = famKids.some(k => s(k) === 'all-day' || s(k) === 'afternoon');
          const newTrack = (hasAM && hasPM) ? 'Both' : hasAM ? 'Morning Only' : hasPM ? 'Afternoon Only' : '';
          if (newTrack) {
            await sql`
              UPDATE registrations SET track = ${newTrack}, updated_at = NOW()
              WHERE LOWER(family_email) = LOWER(${rq.family_email}) AND declined_at IS NULL
            `;
          }
        } catch (e) { console.error('approve track re-sync (non-fatal):', e); }
        // Prompt the Morning Builder follow-up (bug #22): entering or
        // leaving mornings changes the builder roster, and approving the
        // request shouldn't leave that to memory.
        try {
          const wasAM = ['all-day', 'morning'].indexOf(String(rq.prior_schedule || '').toLowerCase()) !== -1;
          const nowAM = ['all-day', 'morning'].indexOf(String(rq.requested_schedule || '').toLowerCase()) !== -1;
          if (wasAM !== nowAM) {
            let placedGroup = '';
            try {
              const pa = await sql`
                SELECT class_group FROM morning_class_assignments
                WHERE school_year = ${rq.season} AND class_group <> ''
                  AND (kid_id = ${rq.kid_id}
                       OR (kid_id IS NULL AND LOWER(family_email) = LOWER(${rq.family_email})
                           AND LOWER(kid_first_name) = LOWER(${rq.kid_first_name})))
                LIMIT 1`;
              placedGroup = (pa[0] && pa[0].class_group) || '';
            } catch (e) { /* group name is a nicety */ }
            await notifyMembershipDirector(sql,
              'Morning Class Builder: ' + rq.kid_first_name + (nowAM ? ' joined mornings' : ' left mornings'),
              nowAM
                ? rq.kid_first_name + '’s schedule now includes mornings — place them in the Morning Class Builder.'
                : rq.kid_first_name + ' switched to afternoon-only' + (placedGroup ? ' but is still placed in ' + placedGroup : '') + ' — update the Morning Class Builder.');
          }
        } catch (e) { console.error('builder-prompt notification (non-fatal):', e); }
      } else if (rq.kind === 'add_kid') {
        if (!rq.kid_id) return res.status(409).json({ error: 'That kid no longer exists.' });
        // No waiver gate (Erin, 2026-07-19): approval doesn't wait on the
        // signature — the unsigned waiver stays pending in the Waivers
        // Report / Comms To Do, and the Communications Director follows up.
        await sql`
          UPDATE kid_enrollments SET status = 'enrolled', updated_at = NOW(), updated_by = ${real}
          WHERE kid_id = ${rq.kid_id} AND season = ${rq.season} AND status = 'pending'
        `;
        // A newly approved morning kid needs a builder placement (bug #22).
        try {
          if (['all-day', 'morning'].indexOf(String(rq.requested_schedule || '').toLowerCase()) !== -1) {
            await notifyMembershipDirector(sql,
              'Morning Class Builder: place ' + rq.kid_first_name,
              rq.kid_first_name + ' was just approved with a morning schedule — place them in the Morning Class Builder.');
          }
        } catch (e) { /* non-fatal */ }
      } else if (rq.kind === 'remove_kid') {
        if (rq.kid_id) {
          // Staleness guard (ship-gate 2026-07-19): a full re-registration
          // AFTER this request re-enrolled the kid — deciding the old
          // request must not delete them.
          const fresher = await sql`
            SELECT 1 FROM kid_enrollments
            WHERE kid_id = ${rq.kid_id} AND season = ${rq.season}
              AND source = 'registration' AND updated_at > ${rq.requested_at}
          `;
          if (fresher.length > 0) {
            return res.status(409).json({ error: 'The family re-registered this kid after asking to remove them — this request is stale. Deny it instead.' });
          }
          // Same cleanup a direct removal does: current-year picks go too.
          try {
            await sql`
              DELETE FROM class_signup_picks
              WHERE school_year = ${rq.season}
                AND (kid_id = ${rq.kid_id}
                     OR (kid_id IS NULL AND LOWER(family_email) = LOWER(${rq.family_email})
                         AND LOWER(kid_first_name) = LOWER(${rq.kid_first_name})))
            `;
          } catch (e) { /* non-fatal */ }
          await sql`DELETE FROM kids WHERE id = ${rq.kid_id}`;
        }
      } else {
        return res.status(400).json({ error: 'Unknown request kind.' });
      }
    } else if (rq.kind === 'add_kid' && rq.kid_id) {
      // Denied add: the pending kid row (and its pending enrollment) go
      // away — but ONLY while still pending (never delete a kid a later
      // registration enrolled, or a mis-keyed sibling; ship-gate
      // 2026-07-19). The unsigned waiver row goes too so it doesn't
      // linger in the Waivers Report's pending counts.
      await sql`
        DELETE FROM kids WHERE id = ${rq.kid_id}
          AND EXISTS (
            SELECT 1 FROM kid_enrollments e
            WHERE e.kid_id = kids.id AND e.season = ${rq.season} AND e.status = 'pending'
          )
      `;
      if (rq.waiver_signature_id) {
        try {
          await sql`DELETE FROM waiver_signatures WHERE id = ${rq.waiver_signature_id} AND signed_at IS NULL`;
        } catch (e) { /* non-fatal */ }
      }
    }

    await sql`
      UPDATE enrollment_change_requests
      SET status = ${approve ? 'approved' : 'denied'}, decided_by = ${real}, decided_at = NOW(), decision_note = ${note}
      WHERE id = ${id}
    `;

    const kindLabel = rq.kind === 'add_kid' ? 'Adding ' + rq.kid_first_name
      : rq.kind === 'remove_kid' ? 'Removing ' + rq.kid_first_name
      : rq.kid_first_name + '’s schedule change (' + rq.prior_schedule + ' → ' + rq.requested_schedule + ')';
    await notifyEnrollment(sql, rq.family_email,
      approve ? 'Approved: ' + kindLabel : 'Not approved: ' + kindLabel,
      (approve ? 'The Membership Director approved this change.' : 'The Membership Director didn’t approve this change.')
      + (note ? ' Note: ' + note : '')
      + (approve && rq.kind === 'add_kid' ? ' Welcome, ' + rq.kid_first_name + '!' : ''));
    // Email too (Erin, 2026-07-19): the in-portal notification only helps
    // members who happen to log in — decisions about their kids warrant
    // an inbox ping. Non-fatal; _resend reroutes on dev via
    // EMAIL_OVERRIDE_TO.
    if (process.env.RESEND_API_KEY && rq.family_email) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const verdict = approve ? 'Approved' : 'Not approved';
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: rq.family_email,
          replyTo: 'membership@rootsandwingsindy.com',
          subject: emailSubject(`${verdict}: ${kindLabel}`),
          html: `
            <h2>${escapeHtml(verdict)}: ${escapeHtml(kindLabel)}</h2>
            <p>${approve ? 'The Membership Director approved this enrollment change.' : 'The Membership Director didn&rsquo;t approve this enrollment change.'}
            ${note ? '<br><strong>Note from the Membership Director:</strong> ' + escapeHtml(note) : ''}</p>
            ${approve && rq.kind === 'add_kid' ? '<p>Welcome, ' + escapeHtml(rq.kid_first_name) + '! 🎉 You&rsquo;ll see them in the directory and class lists shortly.</p>' : ''}
            <p style="color:#666;font-size:13px;">Questions? Reply to this email to reach the Membership Director. You can also see this decision in the notifications bell on <a href="https://www.rootsandwingsindy.com/members.html">the members site</a>.</p>
          `
        });
      } catch (e) { console.error('enrollment decision email failed (non-fatal):', e.message); }
    }
    return res.status(200).json({ ok: true, id, status: approve ? 'approved' : 'denied' });
  } catch (err) {
    console.error('enrollment-request-decide error:', err);
    return res.status(500).json({ error: 'Could not apply that decision.' });
  }
}

// ── Dev-only bug reports (bugs.html) ─────────────────────────────────
// Helper testers on the dev site report bugs and watch fix status
// without ever seeing GitHub. Backed by GitHub Issues on this repo so
// the dev workflow labels (fixed-on-dev / verified / shipped-prod) ARE
// the status source. The whole feature is dev-only: both handlers 404
// on production. Requires a fine-grained PAT in GITHUB_BUGLOG_TOKEN
// (Issues read/write on the one repo); without it we return a clear
// 503 the page renders as a friendly "not set up yet" note.
const BUGLOG_REPO = 'communications-arch/roots-and-wings';

// 60s module-level cache for the issue list — helper testers refreshing
// the page shouldn't hammer the GitHub API (5k req/hr, shared).
let bugListCache = null; // { at: ms, items: [...] }

// Same verification body as verifyWorkspaceAuth, but also returns the
// signer's display name for the issue's "Reported by" line.
async function verifyBugReporter(req) {
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

function bugLogGithubHeaders(token) {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'rw-portal-buglog'
  };
}

// GET ?list=bug_reports — trimmed issue list for the dev bug-log page.
// Never proxies raw GitHub payloads: only number/title/created_at/state/
// label names go to the client.
async function handleBugReportsList(req, res) {
  if (process.env.VERCEL_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const auth = await verifyBugReporter(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = process.env.GITHUB_BUGLOG_TOKEN;
  if (!token) return res.status(503).json({ error: 'Bug log not configured' });
  if (bugListCache && Date.now() - bugListCache.at < 60000) {
    return res.status(200).json({ bugs: bugListCache.items });
  }
  try {
    const gh = await fetch(
      'https://api.github.com/repos/' + BUGLOG_REPO + '/issues?state=all&per_page=50&sort=created&direction=desc',
      { headers: bugLogGithubHeaders(token) }
    );
    if (!gh.ok) {
      console.error('Bug list GitHub error:', gh.status, await gh.text().catch(() => ''));
      return res.status(502).json({ error: 'Could not load the bug list right now.' });
    }
    const raw = await gh.json();
    // The issues endpoint also returns pull requests — skip those.
    const items = (Array.isArray(raw) ? raw : [])
      .filter(it => it && !it.pull_request)
      .map(it => ({
        number: it.number,
        title: String(it.title || ''),
        created_at: it.created_at || '',
        state: it.state === 'closed' ? 'closed' : 'open',
        comments: it.comments || 0,
        labels: Array.isArray(it.labels)
          ? it.labels.map(l => String((l && l.name) || '')).filter(Boolean)
          : []
      }));
    // Latest note per OPEN issue with comments (Erin, 2026-07-19: fix
    // explanations + re-test instructions should read right on the bug
    // page, not in GitHub). Bounded: open issues only, first 15, one
    // comments call each, all inside the same 60s cache. The note is
    // plain text — image markdown is stripped to keep cards tidy.
    const wantNotes = items.filter(it => it.state === 'open' && it.comments > 0).slice(0, 15);
    for (const it of wantNotes) {
      try {
        const cm = await fetch(
          'https://api.github.com/repos/' + BUGLOG_REPO + '/issues/' + it.number + '/comments?per_page=100',
          { headers: bugLogGithubHeaders(token) }
        );
        if (!cm.ok) continue;
        const comments = await cm.json();
        const last = Array.isArray(comments) && comments.length ? comments[comments.length - 1] : null;
        if (last && last.body) {
          it.latest_note = String(last.body)
            .replace(/!\[[^\]]*\]\([^)]*\)/g, '(screenshot)')
            .slice(0, 600);
          it.latest_note_at = last.created_at || '';
        }
      } catch (cmErr) { /* card just renders without a note */ }
    }
    items.forEach(it => { delete it.comments; });
    bugListCache = { at: Date.now(), items };
    return res.status(200).json({ bugs: items });
  } catch (err) {
    console.error('Bug list error:', err);
    return res.status(502).json({ error: 'Could not load the bug list right now.' });
  }
}

// Optional screenshot riding a bug report: base64 image → Vercel Blob under
// bugshots/, markdown-embedded in the issue. Uploading also sweeps bugshots/
// blobs older than 30 days (Erin, 2026-07-19: "delete images after 30 days
// so they don't build up") — cleanup rides usage, so an idle store never
// needs a cron. Failures never block the report itself.
const BUGSHOT_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const BUGSHOT_MAX_BYTES = 3 * 1024 * 1024;
async function uploadBugScreenshot(shot) {
  if (!shot || typeof shot !== 'object') return '';
  const ext = BUGSHOT_TYPES[String(shot.type || '')];
  if (!ext) return '';
  const b64 = String(shot.data || '');
  if (!b64 || b64.length > 4.5 * 1024 * 1024) return '';
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { return ''; }
  if (!buf.length || buf.length > BUGSHOT_MAX_BYTES) return '';
  const { put, list, del } = require('@vercel/blob');
  const name = 'bugshots/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  const blob = await put(name, buf, { access: 'public', contentType: shot.type, addRandomSuffix: false });
  // 30-day sweep, prefix-scoped so nothing else in the store is touched.
  try {
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const old = (await list({ prefix: 'bugshots/', limit: 1000 })).blobs
      .filter(b => b.uploadedAt && new Date(b.uploadedAt).getTime() < cutoff)
      .map(b => b.url);
    if (old.length) await del(old);
  } catch (sweepErr) {
    console.error('Bug screenshot sweep failed (non-fatal):', sweepErr.message);
  }
  return blob.url;
}

// POST kind='bug-verify' — a helper confirms a fixed-on-dev bug works
// (Erin, 2026-07-19: helpers are trusted to verify fixes themselves).
// Adds the 'verified' label + a signed comment. Only valid on OPEN
// issues currently labeled fixed-on-dev — anything else 409s so the
// button can't strand a bug in a weird state.
async function handleBugVerify(body, req, res) {
  if (process.env.VERCEL_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const auth = await verifyBugReporter(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = process.env.GITHUB_BUGLOG_TOKEN;
  if (!token) return res.status(503).json({ error: 'Bug log not configured' });
  const num = parseInt(body.number, 10);
  if (!Number.isFinite(num) || num < 1) return res.status(400).json({ error: 'number required' });
  try {
    const issueUrl = 'https://api.github.com/repos/' + BUGLOG_REPO + '/issues/' + num;
    const cur = await fetch(issueUrl, { headers: bugLogGithubHeaders(token) });
    if (!cur.ok) return res.status(404).json({ error: 'That bug isn’t on the list anymore.' });
    const issue = await cur.json();
    const labels = (issue.labels || []).map(l => String((l && l.name) || ''));
    if (issue.state !== 'open' || labels.indexOf('fixed-on-dev') === -1 || labels.indexOf('verified') !== -1) {
      return res.status(409).json({ error: 'That one isn’t waiting on a re-test right now — refresh the list.' });
    }
    const cm = await fetch(issueUrl + '/comments', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, bugLogGithubHeaders(token)),
      body: JSON.stringify({ body: '✅ Verified on dev by ' + (auth.name || auth.email) + ' (' + auth.email + ') via the dev portal bug log.' })
    });
    if (cm.status !== 201) {
      console.error('Bug verify comment error:', cm.status, await cm.text().catch(() => ''));
      return res.status(502).json({ error: 'Could not save that right now — please try again.' });
    }
    const lb = await fetch(issueUrl + '/labels', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, bugLogGithubHeaders(token)),
      body: JSON.stringify({ labels: ['verified'] })
    });
    if (!lb.ok) {
      console.error('Bug verify label error:', lb.status, await lb.text().catch(() => ''));
      return res.status(502).json({ error: 'Could not save that right now — please try again.' });
    }
    bugListCache = null;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Bug verify error:', err);
    return res.status(502).json({ error: 'Could not save that right now — please try again.' });
  }
}

// POST kind='bug-report' — file a tester's report as a GitHub issue.
async function handleBugReport(body, req, res) {
  if (process.env.VERCEL_ENV === 'production') return res.status(404).json({ error: 'Not found.' });
  const auth = await verifyBugReporter(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const token = process.env.GITHUB_BUGLOG_TOKEN;
  if (!token) return res.status(503).json({ error: 'Bug log not configured' });
  const what = String(body.what || '').trim();
  const where = String(body.where || '').trim();
  if (!what) return res.status(400).json({ error: 'Please describe what happened.' });
  if (what.length > 5000 || where.length > 300) {
    return res.status(400).json({ error: 'That report is a little too long — could you trim it down?' });
  }
  // Optional screenshot — a failed upload never sinks the report.
  let shotUrl = '';
  if (body.screenshot) {
    try { shotUrl = await uploadBugScreenshot(body.screenshot); }
    catch (shotErr) { console.error('Bug screenshot upload failed (non-fatal):', shotErr.message); }
  }
  // Title = first ~80 chars of the report, collapsed to one line.
  const oneLine = what.replace(/\s+/g, ' ').trim();
  const title = oneLine.length > 80 ? oneLine.slice(0, 80).trimEnd() + '…' : oneLine;
  const issueBody = what
    + (where ? '\n\nWhere: ' + where : '')
    + (shotUrl ? '\n\n![screenshot](' + shotUrl + ')' : '')
    + '\n\nReported by: ' + (auth.name || auth.email) + ' (' + auth.email + ') via dev portal';
  try {
    const gh = await fetch('https://api.github.com/repos/' + BUGLOG_REPO + '/issues', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, bugLogGithubHeaders(token)),
      body: JSON.stringify({ title, body: issueBody })
    });
    if (gh.status !== 201) {
      console.error('Bug report GitHub error:', gh.status, await gh.text().catch(() => ''));
      return res.status(502).json({ error: 'Could not save the report right now — please try again in a minute.' });
    }
    const created = await gh.json();
    bugListCache = null; // so the fresh report shows on the next list load
    return res.status(200).json({ ok: true, number: created.number });
  } catch (err) {
    console.error('Bug report error:', err);
    return res.status(502).json({ error: 'Could not save the report right now — please try again in a minute.' });
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (req.query.list === 'registrations') return handleList(req, res);
    if (req.query.list === 'tours') return handleTourList(req, res);
    if (req.query.list === 'registration-invites') return handleRegistrationInvitesList(req, res);
    if (req.query['invite-open']) return handleInviteOpenPing(req, res);
    if (req.query.config === '1' || req.query.config === 'true') return handleConfig(res);
    if (req.query.backup_waiver_token) return handleBackupWaiverInfo(req, res);
    if (req.query.waivers_report === '1') return handleWaiversReport(req, res);
    if (req.query.waivers_counts === '1') return handleWaiversCounts(req, res);
    if (req.query.action === 'profile') return handleProfileGet(req, res);
    if (req.query.cron === 'reconcile-payments') return handleReconcileCron(req, res);
    if (req.query.list === 'merch_orders') return handleMerchOrdersList(req, res);
    if (req.query.list === 'bug_reports') return handleBugReportsList(req, res);
    if (req.query.list === 'enrollment_requests') return handleEnrollmentRequestList(req, res);
    if (req.query.list === 'merch_inventory') return handleMerchInventoryList(req, res);
    if (req.query.morning_builder === '1' || req.query.morning_builder === 'true') return handleMorningBuilderGet(req, res);
    if (req.query.special_events === '1' || req.query.special_events === 'true') return handleSpecialEventsGet(req, res);
    if (req.query.event_space) return handleEventSpaceGet(req, res);
    if (req.query.my_event_tasks === '1') return handleMyEventTasksGet(req, res);
    if (req.query.calendar === '1' || req.query.calendar === 'true') return handleBoardCalendarGet(req, res);
    if (req.query.welcome === '1' || req.query.welcome === 'true') return handleWelcomeListGet(req, res);
    if (req.query.community === '1' || req.query.community === 'true') return handleCommunitySnapshot(req, res);
    if (req.query.board_glance === '1') return handleBoardGlance(req, res);
    if (req.query.board_notes === '1') return handleBoardNotesGet(req, res);
    return res.status(400).json({ error: 'Unknown GET action.' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const kind = String(body.kind || 'tour').toLowerCase();
    if (kind === 'tour') return handleTour(body, res);
    if (kind === 'contact') return handleContact(body, res);
    if (kind === 'merch-order') return handleMerchOrder(body, res);
    if (kind === 'merch-manual-order') return handleMerchManualOrder(body, req, res);
    if (kind === 'merch-update') return handleMerchUpdate(body, req, res);
    if (kind === 'merch-order-edit') return handleMerchOrderEdit(body, req, res);
    if (kind === 'merch-order-delete') return handleMerchOrderDelete(body, req, res);
    if (kind === 'merch-inventory-add') return handleMerchInventoryAdd(body, req, res);
    if (kind === 'merch-inventory-update') return handleMerchInventoryUpdate(body, req, res);
    if (kind === 'tour-update') return handleTourUpdate(body, req, res);
    if (kind === 'bug-report') return handleBugReport(body, req, res);
    if (kind === 'bug-verify') return handleBugVerify(body, req, res);
    if (kind === 'enrollment-request-decide') return handleEnrollmentRequestDecide(body, req, res);
    if (kind === 'registration') return handleRegistration(body, req, res);
    if (kind === 'paypal-error') return handlePaypalError(body, req, res);
    if (kind === 'board-note') return handleBoardNoteAdd(body, req, res);
    if (kind === 'board-note-delete') return handleBoardNoteDelete(body, req, res);
    if (kind === 'registration-decline') return handleRegistrationDecline(body, req, res);
    if (kind === 'registration-undecline') return handleRegistrationUndecline(body, req, res);
    if (kind === 'registration-mark-paid') return handleRegistrationMarkPaid(body, req, res);
    if (kind === 'onboarding-step') return handleOnboardingStep(body, req, res);
    if (kind === 'onboarding-dismiss') return handleOnboardingDismiss(body, req, res);
    if (kind === 'send-welcome-email') return handleSendWelcomeEmail(body, req, res);
    if (kind === 'backup-waiver-sign') return handleBackupWaiverSign(body, req, res);
    if (kind === 'waiver-send') return handleWaiverSend(body, req, res);
    if (kind === 'waiver-resend') return handleWaiverResend(body, req, res);
    if (kind === 'registration-invite') return handleRegistrationInvite(body, req, res);
    if (kind === 'registration-invite-dismiss' ||
        kind === 'registration-invite-restore') return handleRegistrationInviteDismiss(body, req, res);
    if (kind === 'registration-invite-mark') return handleRegistrationInviteMark(body, req, res);
    if (kind === 'profile-update') return handleProfileUpdate(body, req, res);
    if (kind === 'profile-photo') return handleProfilePhoto(body, req, res);
    if (kind === 'morning-assign') return handleMorningAssign(body, req, res);
    if (kind === 'morning-reorder') return handleMorningReorder(body, req, res);
    if (kind === 'morning-finalize') return handleMorningFinalize(body, req, res);
    if (kind === 'am-teacher-assign') return handleAmTeacherAssign(body, req, res);
    if (kind === 'special-event-people') return handleSpecialEventSave(body, req, res);
    if (kind === 'special-event-date') return handleSpecialEventDate(body, req, res);
    if (kind === 'special-event-details') return handleSpecialEventDetails(body, req, res);
    if (kind === 'special-event-create') return handleSpecialEventCreate(body, req, res);
    if (kind === 'special-event-delete') return handleSpecialEventDelete(body, req, res);
    if (kind === 'event-task-save') return handleEventTaskSave(body, req, res);
    if (kind === 'event-task-toggle') return handleEventTaskToggle(body, req, res);
    if (kind === 'event-task-delete') return handleEventTaskDelete(body, req, res);
    if (kind === 'event-space-template-start') return handleEventSpaceTemplateStart(body, req, res);
    if (kind === 'event-template-save') return handleEventTemplateSave(body, req, res);
    if (kind === 'calendar-save') return handleBoardCalendarSave(body, req, res);
    if (kind === 'calendar-delete') return handleBoardCalendarDelete(body, req, res);
    if (kind === 'welcome-mark' || kind === 'welcome-unmark' ||
        kind === 'welcome-meet-mark' || kind === 'welcome-meet-unmark') return handleWelcomeMark(body, req, res);
    return res.status(400).json({ error: 'Unknown kind.' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// Exposed for backfill scripts (scripts/backfill-registration-profiles.js)
// so the one-time catch-up uses the same merge logic as live registrations.
module.exports.upsertProfileFromRegistration = upsertProfileFromRegistration;
module.exports.deriveFamilyName = deriveFamilyName;
module.exports.deriveFamilyEmail = deriveFamilyEmail;
module.exports.resolveFamilyByContactEmail = resolveFamilyByContactEmail;
module.exports.DEFAULT_SEASON = DEFAULT_SEASON;
module.exports.morningKidDisplayName = morningKidDisplayName;
module.exports.validateBoardCalendarEvent = validateBoardCalendarEvent;
module.exports.computeDerivedCalendarEvents = computeDerivedCalendarEvents;
module.exports.fieldDayForYear = fieldDayForYear;
module.exports.iceCreamSocialForYear = iceCreamSocialForYear;
module.exports.calAddDays = calAddDays;
module.exports.calSnapWed = calSnapWed;
module.exports.reconcileNameCandidates = reconcileNameCandidates;
module.exports.mergeDuplicateOpenTours = mergeDuplicateOpenTours;
module.exports.syncEventToGoogleCalendar = syncEventToGoogleCalendar;
module.exports.gcalBodyFromEvent = gcalBodyFromEvent;
module.exports.syncSessionToGoogleCalendar = syncSessionToGoogleCalendar;
module.exports.deleteGoogleCalendarEvent = deleteGoogleCalendarEvent;
