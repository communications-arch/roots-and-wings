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
const { canEditAsRole, getRoleHolderEmail, isSuperUser, canImpersonate, activeSchoolYear, isBoardMember } = require('./_permissions');
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
const VALID_TOUR_STATUSES = ['inquiry', 'requested', 'scheduled', 'toured', 'joined', 'declined', 'ghosted'];

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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  Object.keys(sessions).sort().forEach(k => {
    const s = sessions[k];
    const start = new Date(s.start + 'T00:00:00');
    const end = new Date(s.end + 'T00:00:00');
    // Walk from start to end, picking out Wednesdays (getDay() === 3).
    const cursor = new Date(start.getTime());
    while (cursor.getTime() <= end.getTime()) {
      if (cursor.getDay() === 3 && cursor.getTime() > today.getTime()) {
        const yyyy = cursor.getFullYear();
        const mm = String(cursor.getMonth() + 1).padStart(2, '0');
        const dd = String(cursor.getDate()).padStart(2, '0');
        dates.push({
          date: `${yyyy}-${mm}-${dd}`,
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
// Membership Director's Tour Pipeline report), then emails Membership.
// preferred_date/preferred_time are optional from the family's POV —
// if they leave them blank, the row lands in the pipeline as
// "requested" without a proposed slot, and Membership coordinates via
// reply.
async function handleTour(body, res) {
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
  let tourId = null;
  try {
    const sql = getSql();
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
        <p style="color:#666;font-size:0.9rem;margin-top:16px;">Open the Tour Pipeline in My Workspace to schedule, follow up, or close out this request.</p>
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
  let tourId = null;
  try {
    const sql = getSql();
    const inserted = await sql`
      INSERT INTO tours (family_name, family_email, phone, num_kids, ages,
                         status, source, message, status_history)
      VALUES (${name}, ${email.toLowerCase()}, ${phone}, NULL, '',
              'inquiry', 'contact-form', ${message},
              ${JSON.stringify([{ at: new Date().toISOString(), by: 'contact-form', from: null, to: 'inquiry' }])}::jsonb)
      RETURNING id
    `;
    tourId = inserted[0] && inserted[0].id;
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
        <p style="color:#666;font-size:0.9rem;margin-top:16px;">This inquiry is in the Tour Pipeline in My Workspace (tagged "General inquiry"). Reply to this email to reach the family directly, or schedule them a tour from there.</p>
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
      } else if (mlc_first_name && mlc_last_name) {
        famEmail = deriveFamilyEmail(mlc_first_name, mlc_last_name);
      } else {
        famEmail = deriveFamilyEmail(main_learning_coach, famName);
      }
      if (famEmail) {
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
          placementNotes: placement_notes
        });
      }
    } catch (profileErr) {
      console.error('Registration → member_profiles upsert error (non-fatal):', profileErr);
    }

    // Stamp the MLC's signature into waiver_signatures (consolidated, versioned
    // waiver record). The registrations row keeps the inline signature columns
    // for now; this row is the source of truth for the unified Waivers Report.
    // Conflict on (LOWER(person_email), season) shouldn't happen — the
    // registration insert above would have failed first via its own unique
    // index — but if it does (e.g. prior backfill), DO NOTHING keeps us safe.
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
        ON CONFLICT DO NOTHING
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
  const isMembership = await canEditAsRole(auth.email, 'Membership Director');
  const isComms      = !isMembership && await canEditAsRole(auth.email, 'Communications Director');
  const isTreasurer  = !isMembership && !isComms && await canEditAsRole(auth.email, 'Treasurer');
  const viewerCanAct = isMembership || isComms || isTreasurer;
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
    const pendingRegs = rows.filter(r => String(r.payment_status || '').toLowerCase() !== 'paid');
    if (pendingRegs.length > 0 && process.env.BILLING_SHEET_ID) {
      try {
        const sheetsClient = google.sheets({ version: 'v4', auth: getAuth() });
        const billingTabs = await fetchSheet(sheetsClient, process.env.BILLING_SHEET_ID);
        const parsed = parseBillingSheet(billingTabs, season);
        for (const reg of pendingRegs) {
          const famName = deriveFamilyName(reg.main_learning_coach, reg.existing_family_name);
          if (!famName) continue;
          const entry = parsed.families[famName.toLowerCase()];
          if (!entry || !entry.fall || entry.fall.deposit !== 'Paid') continue;
          // Sheet shows Paid for this family — flip DB + send email.
          // Mutate the row in `rows` so the response reflects the new
          // status without a re-fetch.
          try {
            await applyMarkPaid(sql, reg, '');
            const target = rows.find(r => r.id === reg.id);
            if (target) target.payment_status = 'paid';
          } catch (innerErr) {
            console.error(`Auto-reconcile failed for reg ${reg.id} (${famName}):`, innerErr);
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
      SELECT id, season, email, existing_family_name, main_learning_coach,
             payment_amount, payment_status
      FROM registrations
      WHERE season = ${season}
        AND LOWER(payment_status) <> 'paid'
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
      const famName = deriveFamilyName(reg.main_learning_coach, reg.existing_family_name);
      if (!famName) continue;
      const entry = parsed.families[famName.toLowerCase()];
      if (!entry || !entry.fall || entry.fall.deposit !== 'Paid') continue;
      try {
        await applyMarkPaid(sql, reg, '');
        reconciled.push({ id: reg.id, family: famName });
      } catch (innerErr) {
        console.error(`Cron reconcile failed for reg ${reg.id} (${famName}):`, innerErr);
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
             ws.family_email,
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
    const isOneOff = row.role === 'one_off';
    // Prefer the live people / member_profiles values (what the family
    // currently shows in the directory) over the registrations snapshot,
    // which is frozen at registration time and won't reflect EMI edits.
    // The email body uses the same live source, so both stay consistent.
    const mlcName = String(row.profile_mlc_name || row.main_learning_coach || '').trim();
    const familyName = String(row.profile_family_name || row.existing_family_name || mlcName || row.person_name).trim();
    return res.status(200).json({
      // Keep the legacy 'source' field shape so the existing waiver.html
      // client-side branch ("if isOneOff…") keeps working unmodified.
      source: isOneOff ? 'one_off' : 'backup',
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
    const isOneOff = u.role === 'one_off';

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
// (cc'ing Communications, Treasurer, and Membership), then hard-delete all
// user info created by the registration: the registrations row itself,
// waiver_signatures (cascades on registration_id), and any member_profiles row we derived at
// registration time. Treasurer issues the refund manually against the PayPal
// transaction ID included in the email.
async function handleRegistrationDecline(body, req, res) {
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canDecline = isSuperUser(auth.email) ||
    await canEditAsRole(auth.email, 'Membership Director');
  if (!canDecline) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director can decline registrations.',
      youAre: auth.email,
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
             paypal_transaction_id, payment_amount, kids
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];

    // Best-effort: delete any member_profiles row created by this registration.
    // We keyed it by derived family_email (Main LC first name + family initial).
    try {
      const famName = deriveFamilyName(reg.main_learning_coach, reg.existing_family_name);
      const famEmail = deriveFamilyEmail(reg.main_learning_coach, famName);
      if (famEmail) {
        await sql`DELETE FROM member_profiles WHERE family_email = ${famEmail}`;
      }
    } catch (mpErr) {
      console.error('member_profiles delete (non-fatal):', mpErr);
    }

    // waiver_signatures.registration_id is ON DELETE CASCADE, so MLC + backup-coach waiver rows clear with the
    // registration row. No separate DELETE needed.
    await sql`DELETE FROM registrations WHERE id = ${id}`;

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
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canMark = isSuperUser(auth.email) ||
    await canEditAsRole(auth.email, 'Treasurer');
  if (!canMark) {
    const expected = await getRoleHolderEmail('Treasurer');
    return res.status(403).json({
      error: 'Only the Treasurer can mark registrations as paid.',
      youAre: auth.email,
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
             payment_amount, payment_status
      FROM registrations WHERE id = ${id} LIMIT 1
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'Registration not found.' });
    const reg = rows[0];
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
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = isSuperUser(auth.email) ||
    await canEditAsRole(auth.email, 'Communications Director');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can update onboarding status.',
      youAre: auth.email,
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
    await canEditAsRole(auth.email, 'Communications Director');
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
      FROM registrations WHERE id = ${id}
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
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = isSuperUser(auth.email) ||
    await canEditAsRole(auth.email, 'Communications Director');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can send the welcome email.',
      youAre: auth.email,
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

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: reg.email,
        cc: ['communications@rootsandwingsindy.com'],
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
    await canEditAsRole(auth.email, 'Communications Director');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can view this report.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE signed_at IS NULL AND last_sent_at IS NULL)     AS pending,
        COUNT(*) FILTER (WHERE signed_at IS NULL AND last_sent_at IS NOT NULL) AS resent
      FROM waiver_signatures
      WHERE role IN ('backup_coach', 'one_off')
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
    await canEditAsRole(auth.email, 'Communications Director');
  if (!isComms) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can view this report.',
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
      } else if (ws.role === 'one_off') {
        oneOff.push({
          source: 'one_off', id: ws.id, name: ws.name, email: ws.email,
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

    return res.status(200).json({ backup, oneOff, registration });
  } catch (err) {
    console.error('waivers report error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// ── Comms Workspace: send a one-off waiver to an ad-hoc adult ──
async function handleWaiverSend(body, req, res) {
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canEditAsRole(user.email, 'Communications Director'))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can send one-off waivers.',
      youAre: user.email,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const note = String(body.note || '').trim().slice(0, 500);

  if (!name) return res.status(400).json({ error: 'Recipient name is required.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid recipient email is required.' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long.' });

  try {
    const sql = getSql();
    const token = crypto.randomUUID().replace(/-/g, '');

    // One-offs aren't tied to a registration, so tag them to the active
    // registration season (DEFAULT_SEASON) — same year registrations use.
    // The old calendar-derived season mis-tagged spring sends: a waiver
    // sent in April 2026 (for the upcoming 2026-2027 year) landed in
    // 2025-2026 and never surfaced in the new year's Waivers Report.
    const season = DEFAULT_SEASON;

    await sql`
      INSERT INTO waiver_signatures (
        season, role, person_name, person_email,
        pending_token, sent_at, sent_by_email, note
      ) VALUES (
        ${season}, 'one_off', ${name}, ${email},
        ${token}, NOW(), ${user.email}, ${note}
      )
      ON CONFLICT DO NOTHING
    `;

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
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canEditAsRole(user.email, 'Communications Director'))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can resend waivers.',
      youAre: user.email,
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
    if (row.role !== 'backup_coach' && row.role !== 'one_off') {
      return res.status(400).json({ error: 'Only backup-coach or one-off waivers can be resent.' });
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
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const isMembership = await canEditAsRole(user.email, 'Membership Director');
  const isComms = !isMembership && await canEditAsRole(user.email, 'Communications Director');
  if (!isMembership && !isComms) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership or Communications Director can send registration links.',
      youAre: user.email,
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
  const link = `${baseUrl}/register.html`;

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
        <p style="background:#fdf3e7;padding:10px 14px;border-left:3px solid #c8862a;border-radius:4px;"><strong>Please complete your registration within 2 weeks.</strong> After that, we can't guarantee a spot will still be available.</p>
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

// If existing_family_name was supplied, use it; otherwise take the last token
// of the Main LC's full name (matches the Directory convention).
function deriveFamilyName(mainLcName, existingFamilyName) {
  const existing = String(existingFamilyName || '').trim();
  if (existing) return existing;
  const mlc = String(mainLcName || '').trim();
  const words = mlc.split(/\s+/);
  return words[words.length - 1] || '';
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
    const byName = await sql`
      SELECT id FROM people
      WHERE family_email = ${familyEmail}
        AND LOWER(first_name) = ${firstName.toLowerCase()}
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
    SELECT email, first_name, last_name, role, personal_email, phone,
           pronouns, photo_url, photo_consent, nicknames, sort_order
    FROM people WHERE family_email = ${familyEmail}
    ORDER BY sort_order, id
  `;
  const exKidsRows = await sql`
    SELECT first_name, last_name, birth_date, pronouns, allergies,
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

  // Merge parents. Registration is authoritative for the fields it
  // supplies (role, photo_consent, last_name); existing values win for
  // pronouns / photo_url / personal_email / phone (preserves later EMI
  // edits when a family re-registers without updating those).
  const mergedParents = [];
  const seenFirsts = new Set();
  newParents.forEach(np => {
    const key = firstKey(np);
    if (!key) return;
    seenFirsts.add(key);
    const ex = exPeople.find(p => firstKey(p) === key) || {};
    mergedParents.push({
      first_name: np.first_name || ex.first_name || '',
      last_name: np.last_name || ex.last_name || '',
      pronouns: ex.pronouns || np.pronouns || '',
      photo_url: ex.photo_url || np.photo_url || '',
      photo_consent: typeof np.photo_consent === 'boolean' ? np.photo_consent : (ex.photo_consent !== false),
      role: np.role || ex.role || 'parent',
      email: (ex.email || np.email || '').toLowerCase(),
      personal_email: np.personal_email || ex.personal_email || '',
      phone: ex.phone || np.phone || '',
      // Registration form doesn't collect nicknames, so registration
      // never overwrites existing ones — they come from Edit My Info.
      nicknames: Array.isArray(ex.nicknames) ? ex.nicknames : []
    });
  });
  exPeople.forEach(p => { if (!seenFirsts.has(firstKey(p))) mergedParents.push(p); });

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
      ['first_name', 'last_name', 'birth_date', 'pronouns', 'allergies',
       'schedule', 'photo_url'].forEach(field => {
        const v = m[field];
        if ((out[field] == null || out[field] === '') && v) out[field] = v;
      });
      if (m.photo_consent === false) out.photo_consent = false;
      else if (out.photo_consent == null) out.photo_consent = (m.photo_consent !== false);
    });
    return out;
  }
  const mergedKids = [];
  const seenKids = new Set();
  newKids.forEach(nk => {
    const key = kidFirst(nk);
    if (!key) return;
    seenKids.add(key);
    const ex = aggregateKidMatches(exKids.filter(k => kidFirst(k) === key));
    mergedKids.push({
      // Prefer the explicitly-entered first name; fall back to the first
      // token of the combined name for older clients.
      first_name: (nk.first_name && nk.first_name.trim())
        ? nk.first_name.trim()
        : String(nk.name || '').trim().split(/\s+/)[0],
      last_name: nk.last_name || ex.last_name || '',
      birth_date: nk.birth_date || ex.birth_date || null,
      pronouns: nk.pronouns || ex.pronouns || '',
      allergies: nk.allergies || ex.allergies || '',
      schedule: nk.schedule || ex.schedule || 'all-day',
      photo_url: ex.photo_url || nk.photo_url || '',
      photo_consent: typeof nk.photo_consent === 'boolean' ? nk.photo_consent : (ex.photo_consent !== false)
    });
  });
  exKids.forEach(k => { if (!seenKids.has(kidFirst(k))) mergedKids.push(k); });

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

  // 2) Replace people + kids wholesale with the merged sets.
  await sql`DELETE FROM people WHERE family_email = ${familyEmail}`;
  await sql`DELETE FROM kids   WHERE family_email = ${familyEmail}`;

  for (let i = 0; i < mergedParents.length; i++) {
    const pp = mergedParents[i];
    if (!pp.first_name) continue;
    let email = String(pp.email || '').trim().toLowerCase();
    if (!email && pp.role === 'mlc') email = familyEmail;
    await sql`
      INSERT INTO people (
        email, family_email, first_name, last_name, role,
        personal_email, phone, pronouns, photo_url, photo_consent,
        nicknames, sort_order, updated_by
      ) VALUES (
        ${email || null}, ${familyEmail}, ${pp.first_name}, ${pp.last_name || ''}, ${pp.role || 'parent'},
        ${pp.personal_email || ''}, ${pp.phone || ''}, ${pp.pronouns || ''},
        ${pp.photo_url || ''}, ${pp.photo_consent !== false},
        ${JSON.stringify(pp.nicknames || [])}::jsonb, ${i}, 'registration'
      )
    `;
  }
  for (let i = 0; i < mergedKids.length; i++) {
    const k = mergedKids[i];
    if (!k.first_name) continue;
    await sql`
      INSERT INTO kids (
        family_email, first_name, last_name, birth_date,
        pronouns, allergies, schedule, photo_url, photo_consent,
        sort_order
      ) VALUES (
        ${familyEmail}, ${k.first_name}, ${k.last_name || ''},
        ${k.birth_date || null}, ${k.pronouns || ''}, ${k.allergies || ''},
        ${k.schedule || 'all-day'}, ${k.photo_url || ''}, ${k.photo_consent !== false},
        ${i}
      )
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
  return {
    name,
    first_name,
    last_name,
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
             placement_notes, updated_at, updated_by
      FROM member_profiles
      WHERE family_email = ${familyEmail}
      LIMIT 1
    `;
    if (famRows.length === 0) {
      return res.status(200).json({ profile: null, family_email: familyEmail });
    }
    const peopleRows = await sql`
      SELECT email, first_name, last_name, role, personal_email, phone,
             pronouns, photo_url, photo_consent, nicknames, sort_order
      FROM people WHERE family_email = ${familyEmail}
      ORDER BY sort_order, id
    `;
    const kidsRows = await sql`
      SELECT id, first_name, last_name, birth_date,
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
    // additional_emails kept in lockstep with non-MLC people emails for
    // back-compat with the legacy auth path (resolveFamily still falls
    // back to it when no people row matches). Drop in the follow-up.
    const additionalEmails = Array.from(new Set(
      people
        .filter(p => p.role !== 'mlc' && p.email && p.email.toLowerCase() !== familyEmail)
        .map(p => p.email.toLowerCase())
    ));
    await sql`
      INSERT INTO member_profiles (
        family_email, family_name, phone, address, parents, kids,
        additional_emails, updated_by
      ) VALUES (
        ${familyEmail}, ${familyName}, ${phone}, ${address},
        '[]'::jsonb, '[]'::jsonb,
        ${additionalEmails}::text[], ${user.realEmail || user.email}
      )
      ON CONFLICT (family_email) DO UPDATE SET
        family_name = EXCLUDED.family_name,
        phone = EXCLUDED.phone,
        address = EXCLUDED.address,
        additional_emails = EXCLUDED.additional_emails,
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
    try {
      const priorKids = await sql`SELECT first_name, class_group FROM kids WHERE family_email = ${familyEmail}`;
      priorKids.forEach(r => {
        const key = String(r.first_name || '').trim().toLowerCase();
        if (key && r.class_group) priorKidGroups[key] = r.class_group;
      });
    } catch (e) { /* non-fatal — worst case the group is blank, same as before */ }
    await sql`DELETE FROM people WHERE family_email = ${familyEmail}`;
    await sql`DELETE FROM kids   WHERE family_email = ${familyEmail}`;

    for (let i = 0; i < people.length; i++) {
      const pp = people[i];
      await sql`
        INSERT INTO people (
          email, family_email, first_name, last_name, role,
          personal_email, phone, pronouns, photo_url, photo_consent,
          nicknames, sort_order, updated_by
        ) VALUES (
          ${pp.email || null}, ${familyEmail}, ${pp.first_name}, ${pp.last_name}, ${pp.role || 'parent'},
          ${pp.personal_email || ''}, ${pp.phone || ''}, ${pp.pronouns || ''},
          ${pp.photo_url || ''}, ${pp.photo_consent !== false},
          ${JSON.stringify(pp.nicknames || [])}::jsonb, ${i}, ${user.realEmail || user.email}
        )
      `;
    }
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      // Carry forward the VP-assigned class group (preserved above). A
      // brand-new kid with no prior row gets '' — the VP assigns it later.
      const kidGroup = priorKidGroups[String(k.name || '').trim().toLowerCase()] || '';
      await sql`
        INSERT INTO kids (
          family_email, first_name, last_name, birth_date,
          pronouns, allergies, schedule, photo_url, photo_consent,
          sort_order, class_group
        ) VALUES (
          ${familyEmail}, ${k.name}, ${k.last_name || ''},
          ${k.birth_date || null}, ${k.pronouns || ''}, ${k.allergies || ''},
          ${k.schedule || 'all-day'}, ${k.photo_url || ''}, ${k.photo_consent !== false},
          ${i}, ${kidGroup}
        )
      `;
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
      blc_waivers_sent: newBlcRows.map(r => ({ name: r.name, email: r.email })),
      blc_waivers_skipped: skippedBlcs
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
  const isMembership = await canEditAsRole(auth.email, 'Membership Director');
  if (!isMembership) {
    const expected = await getRoleHolderEmail('Membership Director');
    return res.status(403).json({
      error: 'Only the Membership Director can view the tour pipeline.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
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
          WHEN 'joined'    THEN 4
          WHEN 'declined'  THEN 5
          WHEN 'ghosted'   THEN 6
          ELSE 7
        END,
        created_at DESC
    `;
    return res.status(200).json({ tours: rows });
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
  const isMembership = await canEditAsRole(auth.email, 'Membership Director');
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

  // If a scheduled slot is being set, validate it the same way as the
  // public form — Wednesday in an active session, time in the 10-2:30
  // grid. Both required (or both blank to clear).
  if (scheduledDate !== undefined || scheduledTime !== undefined) {
    const slotErr = validateTourSlot(scheduledDate || null, scheduledTime || null, sessionsForUpdate);
    if (slotErr) return res.status(400).json({ error: slotErr });
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
  return (await canEditAsRole(email, 'Communications Director'))
      || (await canEditAsRole(email, 'Merchandise Manager'));
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
  const ok = await canEditAsRole(auth.email, 'Membership Director');
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
  const isMembership = await canEditAsRole(auth.email, 'Membership Director');
  const isVP = !isMembership && await canEditAsRole(auth.email, 'Vice President');
  if (!isMembership && !isVP) {
    const expected = await getRoleHolderEmail('Membership Director');
    res.status(403).json({
      error: 'Only the Membership Director or Vice President can use the Morning Class Builder.',
      youAre: auth.realEmail,
      expected: expected || '(unknown — sheet lookup failed)'
    });
    return null;
  }
  auth.canPlaceKids = isMembership; // VP: teaching only
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
    // Include not-yet-paid morning registrations too. They're placed/seeded/
    // finalized exactly like paid kids — `pending` is only a visual flag so
    // Membership knows payment hasn't landed yet.
    const regs = await sql`
      SELECT main_learning_coach, existing_family_name, track, placement_notes, payment_status, kids
      FROM registrations
      WHERE season = ${schoolYear}
        AND track = ANY(${MORNING_TRACKS})
    `;
    const draftRows = await sql`
      SELECT family_email, kid_first_name, class_group, finalized
      FROM morning_class_assignments
      WHERE school_year = ${schoolYear}
    `;
    const draftMap = {};
    draftRows.forEach(r => {
      draftMap[r.family_email + '|' + r.kid_first_name] = { group: r.class_group, finalized: !!r.finalized };
    });
    const planRows = await sql`
      SELECT status, finalized_at, finalized_by, seeded_at FROM morning_class_plans
      WHERE school_year = ${schoolYear} LIMIT 1
    `;
    const plan = planRows[0] || { status: 'draft', finalized_at: null, finalized_by: '', seeded_at: null };

    const roster = [];
    const familyEmails = new Set();
    regs.forEach(r => {
      const familyName = deriveFamilyName(r.main_learning_coach, r.existing_family_name);
      const familyEmail = deriveFamilyEmail(r.main_learning_coach, familyName);
      if (!familyEmail) return;
      const pending = String(r.payment_status || '').toLowerCase() !== 'paid';
      familyEmails.add(familyEmail);
      const kids = Array.isArray(r.kids) ? r.kids : [];
      kids.forEach(k => {
        // rawName is the combined name (or bare first) as stored. Keep the
        // matching key derived from its first token exactly as before so
        // existing placements/draft rows still resolve.
        const rawName = String((k && (k.name || k.first_name)) || '').trim();
        if (!rawName) return;
        const first = rawName.split(/\s+/)[0].toLowerCase();
        if (!first) return;
        // Displayed name uses the explicit first/last the registration now
        // stores (b03fe12), with the family surname as a fallback so a kid
        // never renders without a last name.
        const display = morningKidDisplayName(k, familyName);
        const entry = draftMap[familyEmail + '|' + first];
        roster.push({
          key: familyEmail + '|' + first,
          family_email: familyEmail,
          family_name: familyName,
          first_name: first,
          display_name: display,
          birth_date: k.birth_date || null,
          age: ageAsOfFall(k.birth_date, schoolYear),
          placement_notes: String(r.placement_notes || '').trim(),
          allergies: '',
          // Pending (unpaid) kids are treated the same as paid for placement;
          // `pending` is just a visual flag on the client.
          pending: pending,
          group: entry ? entry.group : '',
          locked: false
        });
      });
    });

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
            (school_year, family_email, kid_first_name, class_group, finalized, updated_by, updated_at)
          VALUES (${schoolYear}, ${item.family_email}, ${item.first_name}, ${g}, FALSE, ${auth.realEmail}, NOW())
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
        const entry = draftMap[item.key];
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

    // Youngest → oldest, then by name (unknown ages last).
    roster.sort((a, b) => {
      const aa = (a.age == null) ? 999 : a.age;
      const bb = (b.age == null) ? 999 : b.age;
      if (aa !== bb) return aa - bb;
      return a.display_name.localeCompare(b.display_name);
    });

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
    await sql`
      INSERT INTO morning_class_assignments
        (school_year, family_email, kid_first_name, class_group, finalized, updated_by, updated_at)
      VALUES (${schoolYear}, ${familyEmail}, ${firstName}, ${group}, FALSE, ${auth.realEmail}, NOW())
      ON CONFLICT (school_year, family_email, kid_first_name) DO UPDATE SET
        class_group = EXCLUDED.class_group,
        finalized   = FALSE,
        updated_by  = EXCLUDED.updated_by,
        updated_at  = NOW()
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('morning-assign error:', err);
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
    await sql`UPDATE morning_class_assignments SET finalized = TRUE WHERE school_year = ${schoolYear} AND class_group <> ''`;
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
  const ok = (await canEditAsRole(auth.email, 'Special Events Liaison'))
    || (await canEditAsRole(auth.email, 'Vice President'));
  if (!ok) {
    res.status(403).json({
      error: 'Only the Special Events Liaison or Vice President can manage special events.',
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
  const auth = await requireSpecialEventsEditor(req, res);
  if (!auth) return;
  const schoolYear = String(req.query.school_year || DEFAULT_SEASON);
  try {
    const sql = getSql();
    for (let i = 0; i < SPECIAL_EVENT_SEED.length; i++) {
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
    return res.status(200).json({ school_year: schoolYear, events: out, members });
  } catch (err) {
    console.error('special-events get error:', err);
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
      WHERE id = ${eventId} RETURNING id
    `;
    if (!upd.length) return res.status(404).json({ error: 'Event not found' });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('special-event-date error:', err);
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
    const rows = await sql`SELECT name FROM special_events WHERE id = ${eventId}`;
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    if (SPECIAL_EVENT_SEED.indexOf(rows[0].name) !== -1) {
      return res.status(400).json({ error: '“' + rows[0].name + '” is a standard event and can’t be deleted.' });
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

  // Summer setup
  push('morning', 'Build morning classes', F + '-06-01', '',
    'Membership Director groups morning kids into age classes', 'Membership Director', '🌱');

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

  // The five sessions
  calSessionsForYear(sessions, schoolYear).forEach(s => {
    push('session' + s.session_number, s.name || ('Session ' + s.session_number),
      s.start_date, s.end_date, 'Co-op session', '', '📚');
  });

  // Year-end cluster, anchored to Field Day
  const fd = fieldDayForYear(sessions, schoolYear);
  push('regexisting', 'Registration opens — existing members (' + nextYr + ')', calAddDays(fd, -28), '',
    'Returning families re-enroll for next year (2 weeks before public)', 'Membership Director', '📝');
  push('regpublic', 'Registration opens — public (' + nextYr + ')', calAddDays(fd, -14), '',
    'Public registration for next year (2 weeks before Field Day)', 'Membership Director', '📝');
  push('fieldday', 'Field Day (last day)', fd, '',
    'Final day of the school year', '', '🎉');
  push('roleconfirm', 'Confirm role holders', calAddDays(fd, 1), '',
    'Comms Director confirms board role assignments for the new year', 'Communications Director', '🧭');
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
  const isSEL = await canEditAsRole(auth.email, 'Special Events Liaison');
  const canRead = await isBoardMember(auth.email) ||
    await canEditAsRole(auth.email, 'Welcome Coordinator') || isSEL;
  if (!canRead) {
    return res.status(403).json({
      error: 'Only board members, the Welcome Coordinator, and the Special Events Liaison can view the calendar.',
      youAre: auth.realEmail
    });
  }
  try {
    const sql = getSql();
    const rows = await sql`
      SELECT id, school_year, title, event_date, end_date, note, updated_at, updated_by
      FROM board_calendar_events
      ORDER BY event_date, id
    `;
    const manual = rows.map(r => ({
      id: r.id,
      school_year: r.school_year,
      title: r.title,
      event_date: calDateStr(r.event_date),
      end_date: calDateStr(r.end_date),
      note: r.note || '',
      derived: false,
      updated_at: r.updated_at,
      updated_by: r.updated_by
    }));

    // Derived (read-only) trigger dates computed off the session calendar.
    const sessRows = await sql`
      SELECT school_year, session_number, name, start_date, end_date
      FROM co_op_sessions
    `;
    const sessions = sessRows.map(s => ({
      school_year: s.school_year,
      session_number: s.session_number,
      name: s.name,
      start_date: calDateStr(s.start_date),
      end_date: calDateStr(s.end_date)
    }));
    // Compute for every year that has sessions, plus the active + next year
    // (so a not-yet-scheduled upcoming year still shows the June-1 morning
    // build prompt). De-duped.
    const active = activeSchoolYear();
    const F = parseInt(active.slice(0, 4), 10);
    const nextYr = (F + 1) + '-' + (F + 2);
    const years = Array.from(new Set(
      sessions.map(s => s.school_year).concat([active, nextYr])
    ));
    const derived = [];
    years.forEach(yr => { computeDerivedCalendarEvents(sessions, yr).forEach(e => derived.push(e)); });

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
      SELECT id, school_year, name, event_date, date_status, sort_order
      FROM special_events
      ORDER BY sort_order, name
    `;
    const specialEvents = seRows.map(e => ({
      id: e.id,
      school_year: e.school_year,
      name: e.name,
      event_date: specialEventDateStr(e.event_date),
      date_status: e.date_status,
      // Ice Cream Social + Field Day dates are driven by the session
      // calendar (derived events above) — read-only here.
      date_from_calendar: (e.name === 'Ice Cream Social' || e.name === 'Field Day'),
      // Standard events can't be deleted (they'd just re-seed); custom
      // ones added via "+ Add event" can.
      seeded: SPECIAL_EVENT_SEED.indexOf(e.name) !== -1
    }));
    const viewerCanEditSpecialEvents = isSEL ||
      await canEditAsRole(auth.email, 'Vice President');

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
  const id = body.id != null ? parseInt(body.id, 10) : null;
  try {
    const sql = getSql();
    let row;
    if (Number.isInteger(id) && id > 0) {
      const updated = await sql`
        UPDATE board_calendar_events
        SET school_year = ${schoolYear}, title = ${title}, event_date = ${eventDate},
            end_date = ${endDate}, note = ${note}, updated_at = NOW(), updated_by = ${auth.realEmail}
        WHERE id = ${id}
        RETURNING id, school_year, title, event_date, end_date, note, updated_at, updated_by
      `;
      if (updated.length === 0) return res.status(404).json({ error: 'Event not found.' });
      row = updated[0];
    } else {
      const inserted = await sql`
        INSERT INTO board_calendar_events
          (school_year, title, event_date, end_date, note, updated_at, updated_by)
        VALUES (${schoolYear}, ${title}, ${eventDate}, ${endDate}, ${note}, NOW(), ${auth.realEmail})
        RETURNING id, school_year, title, event_date, end_date, note, updated_at, updated_by
      `;
      row = inserted[0];
    }
    return res.status(200).json({
      event: {
        id: row.id,
        school_year: row.school_year,
        title: row.title,
        event_date: calDateStr(row.event_date),
        end_date: calDateStr(row.end_date),
        note: row.note || '',
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
    const existing = await sql`SELECT id FROM board_calendar_events WHERE id = ${id}`;
    if (existing.length === 0) return res.status(404).json({ error: 'Event not found.' });
    await sql`DELETE FROM board_calendar_events WHERE id = ${id}`;
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

// Read access: Welcome Coordinator, any board member, or a super user.
async function canViewWelcomeList(email) {
  if (isSuperUser(email)) return true;
  if (await canEditAsRole(email, 'Welcome Coordinator')) return true;
  return isBoardMember(email);
}
// Write access (mark/un-mark welcomed): Welcome Coordinator or super user.
async function canActWelcomeList(email) {
  if (isSuperUser(email)) return true;
  return canEditAsRole(email, 'Welcome Coordinator');
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
      WHERE r.season = ${season}
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
      WHERE r.season = ${season}
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

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (req.query.list === 'registrations') return handleList(req, res);
    if (req.query.list === 'tours') return handleTourList(req, res);
    if (req.query.config === '1' || req.query.config === 'true') return handleConfig(res);
    if (req.query.backup_waiver_token) return handleBackupWaiverInfo(req, res);
    if (req.query.waivers_report === '1') return handleWaiversReport(req, res);
    if (req.query.waivers_counts === '1') return handleWaiversCounts(req, res);
    if (req.query.action === 'profile') return handleProfileGet(req, res);
    if (req.query.cron === 'reconcile-payments') return handleReconcileCron(req, res);
    if (req.query.list === 'merch_orders') return handleMerchOrdersList(req, res);
    if (req.query.list === 'merch_inventory') return handleMerchInventoryList(req, res);
    if (req.query.morning_builder === '1' || req.query.morning_builder === 'true') return handleMorningBuilderGet(req, res);
    if (req.query.special_events === '1' || req.query.special_events === 'true') return handleSpecialEventsGet(req, res);
    if (req.query.calendar === '1' || req.query.calendar === 'true') return handleBoardCalendarGet(req, res);
    if (req.query.welcome === '1' || req.query.welcome === 'true') return handleWelcomeListGet(req, res);
    if (req.query.community === '1' || req.query.community === 'true') return handleCommunitySnapshot(req, res);
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
    if (kind === 'merch-inventory-update') return handleMerchInventoryUpdate(body, req, res);
    if (kind === 'tour-update') return handleTourUpdate(body, req, res);
    if (kind === 'registration') return handleRegistration(body, req, res);
    if (kind === 'paypal-error') return handlePaypalError(body, req, res);
    if (kind === 'registration-decline') return handleRegistrationDecline(body, req, res);
    if (kind === 'registration-mark-paid') return handleRegistrationMarkPaid(body, req, res);
    if (kind === 'onboarding-step') return handleOnboardingStep(body, req, res);
    if (kind === 'onboarding-dismiss') return handleOnboardingDismiss(body, req, res);
    if (kind === 'send-welcome-email') return handleSendWelcomeEmail(body, req, res);
    if (kind === 'backup-waiver-sign') return handleBackupWaiverSign(body, req, res);
    if (kind === 'waiver-send') return handleWaiverSend(body, req, res);
    if (kind === 'waiver-resend') return handleWaiverResend(body, req, res);
    if (kind === 'registration-invite') return handleRegistrationInvite(body, req, res);
    if (kind === 'profile-update') return handleProfileUpdate(body, req, res);
    if (kind === 'profile-photo') return handleProfilePhoto(body, req, res);
    if (kind === 'morning-assign') return handleMorningAssign(body, req, res);
    if (kind === 'morning-finalize') return handleMorningFinalize(body, req, res);
    if (kind === 'am-teacher-assign') return handleAmTeacherAssign(body, req, res);
    if (kind === 'special-event-people') return handleSpecialEventSave(body, req, res);
    if (kind === 'special-event-date') return handleSpecialEventDate(body, req, res);
    if (kind === 'special-event-create') return handleSpecialEventCreate(body, req, res);
    if (kind === 'special-event-delete') return handleSpecialEventDelete(body, req, res);
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
module.exports.morningKidDisplayName = morningKidDisplayName;
module.exports.validateBoardCalendarEvent = validateBoardCalendarEvent;
module.exports.computeDerivedCalendarEvents = computeDerivedCalendarEvents;
module.exports.fieldDayForYear = fieldDayForYear;
module.exports.iceCreamSocialForYear = iceCreamSocialForYear;
module.exports.calAddDays = calAddDays;
module.exports.calSnapWed = calSnapWed;
