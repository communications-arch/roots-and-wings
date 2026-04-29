// Public intake endpoint.
// Handles two kinds of submissions, distinguished by body.kind:
//   - 'tour'         : forwards a tour request via Resend (default, legacy)
//   - 'registration' : saves a completed, paid registration (requires paypal_transaction_id)
// Also supports:
//   - GET ?list=registrations  — Workspace-authed list for membership coordinators
//   - GET ?config=1            — public config (e.g., Google Maps key) for the register page

const crypto = require('crypto');
const { Resend } = require('resend');
const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { put } = require('@vercel/blob');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, getRoleHolderEmail, SUPER_USER_EMAIL } = require('./_permissions');
const { canActAs } = require('./_family');
const { fetchSheet, getAuth, parseBillingSheet } = require('./sheets');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const REGISTRATION_FEE = 40;
const DEFAULT_SEASON = '2026-2027';
const VALID_TRACKS = ['Morning Only', 'Afternoon Only', 'Both', 'Other'];

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
    const ticket = await oauthClient.verifyIdToken({ idToken: authHeader.slice(7), audience: GOOGLE_CLIENT_ID });
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// ── Tour request (legacy) ──
async function handleTour(body, res) {
  const { name, email, phone, numKids, ages } = body;

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

  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeNumKids = escapeHtml(numKids);
  const safeAges = escapeHtml(ages);

  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    const { error } = await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: 'membership@rootsandwingsindy.com',
      replyTo: email,
      subject: `New Tour Request from ${safeName}`,
      html: `
        <h2>New Tour Request</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;">
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Name</td><td style="padding:8px 0;">${safeName}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Email</td><td style="padding:8px 0;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Number of Kids</td><td style="padding:8px 0;">${safeNumKids}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Ages</td><td style="padding:8px 0;">${safeAges}</td></tr>
        </table>
      `,
    });
    if (error) {
      console.error('Tour email error:', error);
      return res.status(500).json({ error: 'Failed to send. Please try again.' });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Tour email error:', err);
    return res.status(500).json({ error: 'Failed to send. Please try again.' });
  }
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
  const main_learning_coach = String(body.main_learning_coach || '').trim();
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
  const signature_date = String(body.signature_date || '').trim();
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
  if (!address) return res.status(400).json({ error: 'Address required.' });
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
      birth_date: k.birth_date,
      photo_consent: k.photo_consent !== false
    };
  }
  if (!waiver_member_agreement) return res.status(400).json({ error: 'Member agreement acknowledgment required.' });
  if (!waiver_liability) return res.status(400).json({ error: 'Liability waiver acknowledgment required.' });
  if (!signature_name) return res.status(400).json({ error: 'Signature required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature_date)) return res.status(400).json({ error: 'Signature date required.' });
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
      const famName = deriveFamilyName(main_learning_coach, existing_family_name);
      const famEmail = deriveFamilyEmail(main_learning_coach, famName);
      if (famEmail) {
        await upsertProfileFromRegistration(sql, {
          familyEmail: famEmail,
          familyName: famName,
          mlcName: main_learning_coach,
          mlcEmail: email,
          mlcPhotoConsent: waiver_photo_consent === 'yes',
          backupCoaches: backup_coaches,
          kids: kids,
          phone: phone,
          address: address,
          placementNotes: placement_notes
        });
      }
    } catch (profileErr) {
      console.error('Registration → member_profiles upsert error (non-fatal):', profileErr);
    }

    // Create a unique signing token per backup Learning Coach and email each one.
    const baseUrl = (req.headers['x-forwarded-proto'] && req.headers.host)
      ? `${req.headers['x-forwarded-proto']}://${req.headers.host}`
      : 'https://roots-and-wings-topaz.vercel.app';
    const backupCoachRows = [];
    for (const bc of backup_coaches) {
      const token = crypto.randomUUID().replace(/-/g, '');
      try {
        await sql`
          INSERT INTO backup_coach_waivers (registration_id, name, email, token)
          VALUES (${id}, ${bc.name}, ${bc.email}, ${token})
        `;
        backupCoachRows.push({ name: bc.name, email: bc.email, token });
      } catch (bcErr) {
        console.error('Backup coach insert error (non-fatal):', bcErr);
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
            subject: `Roots & Wings Co-op: Please sign the backup Learning Coach waiver`,
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
        ? `<p>Thanks for registering with Roots &amp; Wings Homeschool Co-op! Your spot is held. Please bring <strong>$${escapeHtml(String(payment_amount))} cash or a check payable to <em>Roots and Wings Homeschool, Inc.</em></strong> to Jessica Shewan (Treasurer) on your tour day or your first co-op day. You'll receive a separate confirmation email once the Treasurer records your payment.</p>`
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
        subject: subject,
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
    return res.status(500).json({ error: 'Could not save registration. Please email treasurer@rootsandwingsindy.com with your PayPal transaction ID.' });
  }
}

// ── List registrations (Workspace auth + Comms/Membership Director role) ──
async function handleList(req, res) {
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  // Membership / Comms / Treasurer all see the same Membership Report
  // (Treasurer to record cash/check payments, Comms to onboard new
  // members). Server-side gate matches the report's UI gating.
  const isMembership = await canEditAsRole(auth.email, 'Membership Director');
  const isComms      = !isMembership && await canEditAsRole(auth.email, 'Communications Director');
  const isTreasurer  = !isMembership && !isComms && await canEditAsRole(auth.email, 'Treasurer');
  if (!isMembership && !isComms && !isTreasurer) {
    const expectedM = await getRoleHolderEmail('Membership Director');
    const expectedC = await getRoleHolderEmail('Communications Director');
    const expectedT = await getRoleHolderEmail('Treasurer');
    return res.status(403).json({
      error: 'Only the Membership Director, Communications Director, or Treasurer can view registrations.',
      youAre: auth.email,
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
                 'name', b.name,
                 'email', b.email,
                 'sent_at', b.created_at,
                 'signed_at', b.signed_at,
                 'signature_name', b.signature_name,
                 'signature_date', b.signature_date
               ) ORDER BY b.created_at), '[]'::json)
               FROM backup_coach_waivers b
               WHERE b.registration_id = r.id
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

    return res.status(200).json({ registrations: rows });
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

// ── Public config (no secrets — just the public Maps key) ──
function handleConfig(res) {
  return res.status(200).json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null
  });
}

// ── Backup Learning Coach waiver: look up by token ──
// Falls back to the one_off_waivers table if the token isn't found in
// backup_coach_waivers, so a single /waiver.html?token=… link works for
// both the registration-backed backup-coach flow and the Comms Director's
// one-off sends from the Workspace.
async function handleBackupWaiverInfo(req, res) {
  const token = String(req.query.backup_waiver_token || '').trim();
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT b.name, b.email, b.signed_at, b.signature_name, b.signature_date,
             r.main_learning_coach, r.existing_family_name, r.season
      FROM backup_coach_waivers b
      JOIN registrations r ON r.id = b.registration_id
      WHERE b.token = ${token}
      LIMIT 1
    `;
    if (rows.length > 0) {
      const row = rows[0];
      return res.status(200).json({
        source: 'backup',
        name: row.name,
        email: row.email,
        main_learning_coach: row.main_learning_coach,
        family_name: row.existing_family_name || row.main_learning_coach,
        season: row.season,
        signed: !!row.signed_at,
        signed_at: row.signed_at || null,
        signature_name: row.signature_name || '',
        signature_date: row.signature_date || null
      });
    }
    // One-off waiver fallback (Comms Director sends).
    const oneOff = await sql`
      SELECT name, email, signed_at, signature_name, signature_date
      FROM one_off_waivers
      WHERE token = ${token}
      LIMIT 1
    `;
    if (oneOff.length === 0) return res.status(404).json({ error: 'Waiver link not found. Please contact membership@rootsandwingsindy.com.' });
    const oo = oneOff[0];
    return res.status(200).json({
      source: 'one_off',
      name: oo.name,
      email: oo.email,
      main_learning_coach: '',
      family_name: oo.name,
      season: '',
      signed: !!oo.signed_at,
      signed_at: oo.signed_at || null,
      signature_name: oo.signature_name || '',
      signature_date: oo.signature_date || null
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
  const signature_date = String(body.signature_date || '').trim();
  // Default to consent=true if the client didn't send the field (older clients).
  const photo_consent = body.photo_consent !== false;
  if (!token || !/^[a-f0-9]{8,64}$/i.test(token)) return res.status(400).json({ error: 'Invalid token.' });
  if (!signature_name) return res.status(400).json({ error: 'Please type your name to sign.' });
  if (signature_name.length > 200) return res.status(400).json({ error: 'Signature too long.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature_date)) return res.status(400).json({ error: 'Signature date required (YYYY-MM-DD).' });

  const sql = getSql();
  try {
    // Try backup-coach waivers first; fall back to one-off waivers so the
    // same /waiver.html sign form works for Comms Director sends.
    const existing = await sql`
      SELECT id, signed_at FROM backup_coach_waivers WHERE token = ${token} LIMIT 1
    `;
    if (existing.length > 0) {
      if (existing[0].signed_at) return res.status(409).json({ error: 'This waiver has already been signed.' });

      const updated = await sql`
        UPDATE backup_coach_waivers
        SET signed_at = NOW(), signature_name = ${signature_name}, signature_date = ${signature_date},
            photo_consent = ${photo_consent}
        WHERE token = ${token} AND signed_at IS NULL
        RETURNING id, name, email, registration_id
      `;
      if (updated.length === 0) return res.status(409).json({ error: 'This waiver has already been signed.' });

      // Confirm to the coach + Main LC (best-effort).
      try {
        const related = await sql`
          SELECT r.main_learning_coach, r.email AS main_email, r.season, r.existing_family_name
          FROM registrations r WHERE r.id = ${updated[0].registration_id} LIMIT 1
        `;
        const info = related[0] || {};

        // Propagate co-parent consent into member_profiles.parents[] so photo
        // rendering honors the backup LC's own choice. Only matters when the
        // backup LC is actually a parent in the family's Directory listing
        // (i.e. a spouse); grandparents / friend backups don't appear in the
        // face cards so skipping the upsert for them is fine.
        try {
          const famName = deriveFamilyName(info.main_learning_coach || '', info.existing_family_name || '');
          const famEmail = deriveFamilyEmail(info.main_learning_coach || '', famName);
          if (famEmail) {
            await upsertParentPhotoConsent(
              sql, famEmail, famName, updated[0].name, photo_consent
            );
          }
        } catch (consentErr) {
          console.error('Backup LC photo consent propagation error (non-fatal):', consentErr);
        }
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
          to: updated[0].email,
          cc: [info.main_email, 'membership@rootsandwingsindy.com'].filter(Boolean),
          replyTo: 'membership@rootsandwingsindy.com',
          subject: `Roots & Wings Co-op: Backup Learning Coach waiver on file`,
          html: `
            <h2>Waiver signed — thank you</h2>
            <p>Thanks, ${escapeHtml(updated[0].name)}! Your backup Learning Coach waiver for the <strong>${escapeHtml(info.main_learning_coach || 'Roots & Wings')} family</strong> is on file.</p>
            <p><strong>Signed:</strong> ${escapeHtml(signature_name)} on ${escapeHtml(signature_date)}</p>
            <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
          `,
        });
      } catch (mailErr) {
        console.error('Backup waiver confirmation email error (non-fatal):', mailErr);
      }

      return res.status(200).json({ success: true, name: updated[0].name });
    }

    // One-off waiver sign path.
    const existingOneOff = await sql`
      SELECT id, signed_at, sent_by_email FROM one_off_waivers WHERE token = ${token} LIMIT 1
    `;
    if (existingOneOff.length === 0) return res.status(404).json({ error: 'Waiver link not found.' });
    if (existingOneOff[0].signed_at) return res.status(409).json({ error: 'This waiver has already been signed.' });

    const updatedOneOff = await sql`
      UPDATE one_off_waivers
      SET signed_at = NOW(), signature_name = ${signature_name}, signature_date = ${signature_date},
          photo_consent = ${photo_consent}
      WHERE token = ${token} AND signed_at IS NULL
      RETURNING id, name, email, sent_by_email
    `;
    if (updatedOneOff.length === 0) return res.status(409).json({ error: 'This waiver has already been signed.' });

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: updatedOneOff[0].email,
        cc: [updatedOneOff[0].sent_by_email, 'membership@rootsandwingsindy.com'].filter(Boolean),
        replyTo: 'membership@rootsandwingsindy.com',
        subject: `Roots & Wings Co-op: Waiver on file`,
        html: `
          <h2>Waiver signed — thank you</h2>
          <p>Thanks, ${escapeHtml(updatedOneOff[0].name)}! Your Roots &amp; Wings waiver is on file.</p>
          <p><strong>Signed:</strong> ${escapeHtml(signature_name)} on ${escapeHtml(signature_date)}</p>
          <p style="color:#666;font-size:0.9rem;margin-top:20px;">Questions? Reply to this email and it'll reach the Membership team.</p>
        `,
      });
    } catch (mailErr) {
      console.error('One-off waiver confirmation email error (non-fatal):', mailErr);
    }

    return res.status(200).json({ success: true, name: updatedOneOff[0].name });
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
// backup_coach_waivers (cascades), and any member_profiles row we derived at
// registration time. Treasurer issues the refund manually against the PayPal
// transaction ID included in the email.
async function handleRegistrationDecline(body, req, res) {
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const canDecline = String(auth.email).toLowerCase() === SUPER_USER_EMAIL ||
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

    // backup_coach_waivers FK is ON DELETE CASCADE, so those clear with the
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
        subject: `Roots & Wings ${reg.season}: Registration declined — ${reg.main_learning_coach} family`,
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
      subject: `Roots & Wings ${reg.season} Payment Received — ${reg.main_learning_coach} family`,
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

  const canMark = String(auth.email).toLowerCase() === SUPER_USER_EMAIL ||
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

  const isComms = String(auth.email).toLowerCase() === SUPER_USER_EMAIL ||
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

// ── Comms Workspace: send the welcome email to a new member ──
// Body of the email is editable client-side (Comms reviews + can swap
// in the actual Workspace email + temp password before send). On send,
// stamps welcome_email_sent_at so the row drops out of the onboarding
// queue.
async function handleSendWelcomeEmail(body, req, res) {
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const isComms = String(auth.email).toLowerCase() === SUPER_USER_EMAIL ||
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
        subject: subject,
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
async function handleWaiversReport(req, res) {
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canEditAsRole(user.email, 'Communications Director'))) {
    const expected = await getRoleHolderEmail('Communications Director');
    return res.status(403).json({
      error: 'Only the Communications Director can view this report.',
      youAre: user.email,
      expected: expected || '(unknown — sheet lookup failed)'
    });
  }
  try {
    const sql = getSql();
    const backup = await sql`
      SELECT 'backup' AS source, b.id, b.name, b.email, b.signed_at,
             b.created_at AS sent_at, r.main_learning_coach AS sent_by, r.season
      FROM backup_coach_waivers b
      JOIN registrations r ON r.id = b.registration_id
      ORDER BY b.created_at DESC
    `;
    const oneOff = await sql`
      SELECT 'one_off' AS source, id, name, email, signed_at, sent_at,
             sent_by_email AS sent_by, note
      FROM one_off_waivers
      ORDER BY sent_at DESC
    `;
    // Registration signers — Main LC for every registration, plus any
    // 18+ adult students whose signatures were captured on the form.
    // Both are always "signed" by definition (the form requires the
    // signature inline before submit), so they sort below pending
    // backup/one-off rows on the client.
    const regs = await sql`
      SELECT id, season, main_learning_coach, email, signature_name,
             signature_date, student_signature, created_at
      FROM registrations
      ORDER BY created_at DESC
    `;
    const registration = [];
    regs.forEach(r => {
      registration.push({
        source: 'registration',
        id: r.id,
        name: r.signature_name || r.main_learning_coach,
        email: r.email,
        signed_at: r.signature_date || r.created_at,
        sent_at: r.created_at,
        sent_by: r.main_learning_coach,
        season: r.season,
        context: 'Main Learning Coach'
      });
      // student_signature is a single string formatted as
      // "KidName: SignedName; KidName2: SignedName2" — parse if present.
      const ss = String(r.student_signature || '').trim();
      if (ss) {
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
            signed_at: r.signature_date || r.created_at,
            sent_at: r.created_at,
            sent_by: r.main_learning_coach,
            season: r.season,
            context: 'Adult student (' + kidName + ')'
          });
        });
      }
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

    await sql`
      INSERT INTO one_off_waivers (name, email, token, sent_by_email, note)
      VALUES (${name}, ${email}, ${token}, ${user.email}, ${note})
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
        subject: `Roots & Wings Co-op: Please sign the waiver`,
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
      subject: `Roots & Wings Co-op: Your registration link`,
      html: `
        <h2>Welcome to Roots &amp; Wings!</h2>
        <p>Hi ${escapeHtml(name)},</p>
        <p>Thanks for your interest in joining our co-op. When you're ready, use the link below to complete registration for your family.</p>
        ${note ? `<p style="background:#f5f0f8;padding:10px 14px;border-left:3px solid #523A79;border-radius:4px;"><em>${escapeHtml(note)}</em></p>` : ''}
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
    phone
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

// Upsert a single parent's photo_consent into member_profiles.parents[]. Used
// by the registration insert (Main LC's own choice) and the backup LC sign
// (co-parent's own choice when they happen to be listed in the family). Merges
// into whatever's already there so we never clobber other portal edits.
async function upsertParentPhotoConsent(sql, familyEmail, familyName, parentFullName, photoConsent) {
  if (!familyEmail || !parentFullName) return;
  const parentFirst = String(parentFullName).trim().split(/\s+/)[0];
  if (!parentFirst) return;
  const parentFirstLower = parentFirst.toLowerCase();

  const rows = await sql`
    SELECT parents FROM member_profiles WHERE family_email = ${familyEmail} LIMIT 1
  `;
  const existing = rows[0];
  const currentParents = (existing && Array.isArray(existing.parents)) ? existing.parents : [];

  let found = false;
  const mergedParents = currentParents.map(p => {
    if (!p || !p.name) return p;
    if (String(p.name).trim().split(/\s+/)[0].toLowerCase() === parentFirstLower) {
      found = true;
      return Object.assign({}, p, { photo_consent: photoConsent });
    }
    return p;
  });
  if (!found) {
    mergedParents.push({
      name: parentFirst,
      pronouns: '',
      photo_url: '',
      photo_consent: photoConsent
    });
  }

  await sql`
    INSERT INTO member_profiles (
      family_email, family_name, phone, address, parents, kids,
      placement_notes, updated_by
    ) VALUES (
      ${familyEmail}, ${familyName || ''}, '', '',
      ${JSON.stringify(mergedParents)}::jsonb, '[]'::jsonb,
      '', 'waiver-sign'
    )
    ON CONFLICT (family_email) DO UPDATE SET
      parents = ${JSON.stringify(mergedParents)}::jsonb,
      family_name = COALESCE(NULLIF(member_profiles.family_name, ''), EXCLUDED.family_name),
      updated_at = NOW(),
      updated_by = 'waiver-sign'
  `;
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
      personal_email: idx === 0 ? String(params.mlcEmail || '').toLowerCase() : '',
      phone: ''
    });
  });
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

  const newKids = (Array.isArray(params.kids) ? params.kids : [])
    .map(sanitizeKid)
    .filter(Boolean);

  const existingRows = await sql`
    SELECT parents, kids FROM member_profiles WHERE family_email = ${familyEmail} LIMIT 1
  `;
  const exParents = (existingRows[0] && Array.isArray(existingRows[0].parents)) ? existingRows[0].parents : [];
  const exKids = (existingRows[0] && Array.isArray(existingRows[0].kids)) ? existingRows[0].kids : [];

  function firstKey(p) {
    const fn = String((p && p.first_name) || '').trim();
    if (fn) return fn.toLowerCase();
    const nm = String((p && p.name) || '').trim();
    return (nm.split(/\s+/)[0] || '').toLowerCase();
  }

  // Merge parents.
  const mergedParents = [];
  const seenFirsts = new Set();
  newParents.forEach(np => {
    const key = firstKey(np);
    if (!key) return;
    seenFirsts.add(key);
    const ex = exParents.find(p => firstKey(p) === key) || {};
    mergedParents.push({
      name: np.name || ex.name || '',
      first_name: np.first_name || ex.first_name || '',
      last_name: np.last_name || ex.last_name || '',
      pronouns: ex.pronouns || np.pronouns || '',
      photo_url: ex.photo_url || np.photo_url || '',
      photo_consent: typeof np.photo_consent === 'boolean' ? np.photo_consent : (ex.photo_consent !== false),
      role: np.role || ex.role || '',
      email: ex.email || np.email || '',
      personal_email: np.personal_email || ex.personal_email || '',
      phone: ex.phone || np.phone || ''
    });
  });
  exParents.forEach(p => { if (!seenFirsts.has(firstKey(p))) mergedParents.push(p); });

  // Merge kids by lowercased name.
  const mergedKids = [];
  const seenKids = new Set();
  newKids.forEach(nk => {
    const key = String(nk.name || '').toLowerCase();
    if (!key) return;
    seenKids.add(key);
    const ex = exKids.find(k => String(k.name || '').toLowerCase() === key) || {};
    mergedKids.push({
      name: nk.name,
      last_name: nk.last_name || ex.last_name || '',
      birth_date: nk.birth_date || ex.birth_date || '',
      pronouns: nk.pronouns || ex.pronouns || '',
      allergies: nk.allergies || ex.allergies || '',
      schedule: nk.schedule || ex.schedule || '',
      photo_url: ex.photo_url || nk.photo_url || '',
      photo_consent: typeof nk.photo_consent === 'boolean' ? nk.photo_consent : (ex.photo_consent !== false)
    });
  });
  exKids.forEach(k => { if (!seenKids.has(String(k.name || '').toLowerCase())) mergedKids.push(k); });

  const phone = String(params.phone || '').trim();
  const address = String(params.address || '').trim();
  const placementNotes = String(params.placementNotes || '').trim();

  await sql`
    INSERT INTO member_profiles (
      family_email, family_name, phone, address, parents, kids,
      placement_notes, updated_by
    ) VALUES (
      ${familyEmail}, ${familyName}, ${phone}, ${address},
      ${JSON.stringify(mergedParents)}::jsonb, ${JSON.stringify(mergedKids)}::jsonb,
      ${placementNotes}, 'registration'
    )
    ON CONFLICT (family_email) DO UPDATE SET
      family_name      = COALESCE(NULLIF(EXCLUDED.family_name, ''), member_profiles.family_name),
      phone            = COALESCE(NULLIF(EXCLUDED.phone, ''), member_profiles.phone),
      address          = COALESCE(NULLIF(EXCLUDED.address, ''), member_profiles.address),
      parents          = EXCLUDED.parents,
      kids             = EXCLUDED.kids,
      placement_notes  = COALESCE(NULLIF(EXCLUDED.placement_notes, ''), member_profiles.placement_notes),
      updated_at       = NOW(),
      updated_by       = 'registration'
  `;
}

function sanitizeKid(k) {
  if (!k || typeof k !== 'object') return null;
  const name = String(k.name || '').trim().slice(0, 200);
  if (!name) return null;
  const last_name = String(k.last_name || '').trim().slice(0, 100);
  const birth_date = String(k.birth_date || '').trim();
  let bd = '';
  if (birth_date && /^\d{4}-\d{2}-\d{2}$/.test(birth_date)) bd = birth_date;
  const schedule = String(k.schedule || '').trim().toLowerCase();
  let sch = '';
  if (['all-day', 'morning', 'afternoon'].indexOf(schedule) !== -1) sch = schedule;
  return {
    name,
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
// the family's additional_emails (a co-parent), OR the caller is
// communications@ (super user). The co-parent path requires a DB lookup.
async function canEditFamily(sql, userEmail, familyEmail) {
  const u = normalizeEmail(userEmail);
  const f = normalizeEmail(familyEmail);
  if (!u || !f) return false;
  if (u === SUPER_USER_EMAIL) return true;
  if (u === f) return true;
  return canActAs(sql, u, f);
}

async function handleProfileGet(req, res) {
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const familyEmail = normalizeEmail(req.query.family_email);
  if (!familyEmail) return res.status(400).json({ error: 'family_email required' });

  const sql = getSql();
  if (!(await canEditFamily(sql, user.email, familyEmail))) {
    return res.status(403).json({ error: 'You can only view/edit your own family.' });
  }
  try {
    const rows = await sql`
      SELECT family_email, family_name, phone, address,
             parents, kids, placement_notes, updated_at, updated_by
      FROM member_profiles
      WHERE family_email = ${familyEmail}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return res.status(200).json({ profile: null, family_email: familyEmail });
    }
    return res.status(200).json({ profile: rows[0] });
  } catch (err) {
    console.error('Profile GET error:', err);
    return res.status(500).json({ error: 'Could not load profile.' });
  }
}

async function handleProfileUpdate(body, req, res) {
  const user = await verifyWorkspaceAuth(req);
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

  const parentsRaw = Array.isArray(body.parents) ? body.parents : [];
  const kidsRaw = Array.isArray(body.kids) ? body.kids : [];
  if (parentsRaw.length > 6) return res.status(400).json({ error: 'Too many parents.' });
  if (kidsRaw.length > 12) return res.status(400).json({ error: 'Too many kids.' });

  const parents = parentsRaw.map(sanitizeParent).filter(Boolean);
  const kids = kidsRaw.map(sanitizeKid).filter(Boolean);

  // P5 sync: additional_emails is now a derived view of non-MLC parents'
  // emails. Keeping it in lockstep with parents.email means the auth lookup
  // (api/_family.js resolveFamily, which queries this column with a GIN
  // index) stays correct without doing JSONB scans on the hot path. A BLC
  // edits their email in the form → it propagates to the auth column on
  // save. The MLC's own email is family_email and is intentionally excluded.
  const additionalEmails = Array.from(new Set(
    parents
      .filter(p => p.role !== 'mlc' && p.email && p.email.toLowerCase() !== familyEmail)
      .map(p => p.email.toLowerCase())
  ));

  try {
    // placement_notes is intentionally not touched here — it's collected
    // at registration only and the Edit My Info form no longer exposes
    // it. New profiles default to '' from the column default; existing
    // values are preserved across updates.
    const rows = await sql`
      INSERT INTO member_profiles (
        family_email, family_name, phone, address, parents, kids,
        additional_emails, updated_by
      ) VALUES (
        ${familyEmail}, ${familyName}, ${phone}, ${address},
        ${JSON.stringify(parents)}::jsonb, ${JSON.stringify(kids)}::jsonb,
        ${additionalEmails}::text[], ${user.email}
      )
      ON CONFLICT (family_email) DO UPDATE SET
        family_name = EXCLUDED.family_name,
        phone = EXCLUDED.phone,
        address = EXCLUDED.address,
        parents = EXCLUDED.parents,
        kids = EXCLUDED.kids,
        additional_emails = EXCLUDED.additional_emails,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING family_email, family_name, phone, address, parents, kids,
                placement_notes, updated_at, updated_by
    `;
    return res.status(200).json({ success: true, profile: rows[0] });
  } catch (err) {
    console.error('Profile update error:', err);
    return res.status(500).json({ error: 'Could not save profile.' });
  }
}

// Client posts { family_email, person_name, data_url } where data_url is a
// base64-encoded image (data:image/...;base64,XXX). The client is expected to
// resize to ~512x512 before uploading, keeping payload well under 1 MB.
async function handleProfilePhoto(body, req, res) {
  const user = await verifyWorkspaceAuth(req);
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

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (req.query.list === 'registrations') return handleList(req, res);
    if (req.query.config === '1' || req.query.config === 'true') return handleConfig(res);
    if (req.query.backup_waiver_token) return handleBackupWaiverInfo(req, res);
    if (req.query.waivers_report === '1') return handleWaiversReport(req, res);
    if (req.query.action === 'profile') return handleProfileGet(req, res);
    if (req.query.cron === 'reconcile-payments') return handleReconcileCron(req, res);
    return res.status(400).json({ error: 'Unknown GET action.' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const kind = String(body.kind || 'tour').toLowerCase();
    if (kind === 'tour') return handleTour(body, res);
    if (kind === 'registration') return handleRegistration(body, req, res);
    if (kind === 'registration-decline') return handleRegistrationDecline(body, req, res);
    if (kind === 'registration-mark-paid') return handleRegistrationMarkPaid(body, req, res);
    if (kind === 'onboarding-step') return handleOnboardingStep(body, req, res);
    if (kind === 'send-welcome-email') return handleSendWelcomeEmail(body, req, res);
    if (kind === 'backup-waiver-sign') return handleBackupWaiverSign(body, req, res);
    if (kind === 'waiver-send') return handleWaiverSend(body, req, res);
    if (kind === 'registration-invite') return handleRegistrationInvite(body, req, res);
    if (kind === 'profile-update') return handleProfileUpdate(body, req, res);
    if (kind === 'profile-photo') return handleProfilePhoto(body, req, res);
    return res.status(400).json({ error: 'Unknown kind.' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// Exposed for backfill scripts (scripts/backfill-registration-profiles.js)
// so the one-time catch-up uses the same merge logic as live registrations.
module.exports.upsertProfileFromRegistration = upsertProfileFromRegistration;
module.exports.deriveFamilyName = deriveFamilyName;
module.exports.deriveFamilyEmail = deriveFamilyEmail;
