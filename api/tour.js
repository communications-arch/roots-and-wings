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
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole } = require('./_permissions');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const REGISTRATION_FEE = 50;
const DEFAULT_SEASON = '2025-2026';
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
  const signature_name = String(body.signature_name || '').trim();
  const signature_date = String(body.signature_date || '').trim();
  const student_signature = String(body.student_signature || '').trim();
  const season = String(body.season || DEFAULT_SEASON).trim();
  const kids = Array.isArray(body.kids) ? body.kids : [];
  const paypal_transaction_id = String(body.paypal_transaction_id || '').trim();
  const payment_amount = Number.isFinite(Number(body.payment_amount)) ? Number(body.payment_amount) : REGISTRATION_FEE;
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
  }
  if (!waiver_member_agreement) return res.status(400).json({ error: 'Member agreement acknowledgment required.' });
  if (!waiver_liability) return res.status(400).json({ error: 'Liability waiver acknowledgment required.' });
  if (!signature_name) return res.status(400).json({ error: 'Signature required.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signature_date)) return res.status(400).json({ error: 'Signature date required.' });
  if (!paypal_transaction_id) return res.status(400).json({ error: 'Payment transaction ID required.' });

  if (email.length > 200 || main_learning_coach.length > 200 || address.length > 500 ||
      phone.length > 50 || signature_name.length > 200 || student_signature.length > 200 ||
      paypal_transaction_id.length > 100) {
    return res.status(400).json({ error: 'One or more fields are too long.' });
  }

  const sql = getSql();

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
        ${waiver_member_agreement}, 'yes', ${waiver_liability},
        ${signature_name}, ${signature_date}, ${student_signature},
        'paid', ${payment_amount}, ${paypal_transaction_id}
      )
      RETURNING id, created_at
    `;
    const id = inserted[0].id;

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

    // Best-effort confirmation email — failure does not fail the request.
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const kidsList = kids.map(k => `<li>${escapeHtml(k.name)} &mdash; ${escapeHtml(k.birth_date)}</li>`).join('');
      const backupList = backupCoachRows.map(b => `<li>${escapeHtml(b.name)} &mdash; ${escapeHtml(b.email)} (emailed a waiver link)</li>`).join('');
      await resend.emails.send({
        from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
        to: email,
        cc: [
          'communications@rootsandwingsindy.com',
          'treasurer@rootsandwingsindy.com',
          'vicepresident@rootsandwingsindy.com'
        ],
        replyTo: 'membership@rootsandwingsindy.com',
        subject: `Roots & Wings ${season} Registration Confirmed — ${main_learning_coach} family`,
        html: `
          <h2>Registration Confirmed &amp; Paid</h2>
          <p>Thanks for registering with Roots &amp; Wings Homeschool Co-op! Your ${escapeHtml(season)} Membership Fee has been received. The co-op board has been copied on this email.</p>
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
            <tr><td style="padding:6px 16px 6px 0;font-weight:bold;">PayPal txn</td><td>${escapeHtml(paypal_transaction_id)} — $${escapeHtml(String(payment_amount))}</td></tr>
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

// ── List registrations (Workspace auth required) ──
async function handleList(req, res) {
  const auth = await verifyWorkspaceAuth(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });

  const season = String(req.query.season || DEFAULT_SEASON);
  const sql = getSql();
  try {
    const rows = await sql`
      SELECT id, season, email, existing_family_name, main_learning_coach, address, phone,
             track, track_other, kids, placement_notes,
             waiver_member_agreement, waiver_photo_consent, waiver_liability,
             signature_name, signature_date, student_signature,
             payment_status, paypal_transaction_id, payment_amount,
             created_at, updated_at
      FROM registrations
      WHERE season = ${season}
      ORDER BY created_at DESC
    `;
    return res.status(200).json({ registrations: rows });
  } catch (err) {
    console.error('Registration list error:', err);
    return res.status(500).json({ error: 'Could not load registrations.' });
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
        SET signed_at = NOW(), signature_name = ${signature_name}, signature_date = ${signature_date}
        WHERE token = ${token} AND signed_at IS NULL
        RETURNING id, name, email, registration_id
      `;
      if (updated.length === 0) return res.status(409).json({ error: 'This waiver has already been signed.' });

      // Confirm to the coach + Main LC (best-effort).
      try {
        const related = await sql`
          SELECT r.main_learning_coach, r.email AS main_email, r.season
          FROM registrations r WHERE r.id = ${updated[0].registration_id} LIMIT 1
        `;
        const info = related[0] || {};
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
      SET signed_at = NOW(), signature_name = ${signature_name}, signature_date = ${signature_date}
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

// ── Comms Workspace: unified waivers report (backup + one-off) ──
async function handleWaiversReport(req, res) {
  const user = await verifyWorkspaceAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (!(await canEditAsRole(user.email, 'Communications Director'))) {
    return res.status(403).json({ error: 'Only the Communications Director can view this report.' });
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
    return res.status(200).json({ backup, oneOff });
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
    return res.status(403).json({ error: 'Only the Communications Director can send one-off waivers.' });
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

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (req.query.list === 'registrations') return handleList(req, res);
    if (req.query.config === '1' || req.query.config === 'true') return handleConfig(res);
    if (req.query.backup_waiver_token) return handleBackupWaiverInfo(req, res);
    if (req.query.waivers_report === '1') return handleWaiversReport(req, res);
    return res.status(400).json({ error: 'Unknown GET action.' });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const kind = String(body.kind || 'tour').toLowerCase();
    if (kind === 'tour') return handleTour(body, res);
    if (kind === 'registration') return handleRegistration(body, req, res);
    if (kind === 'backup-waiver-sign') return handleBackupWaiverSign(body, req, res);
    if (kind === 'waiver-send') return handleWaiverSend(body, req, res);
    return res.status(400).json({ error: 'Unknown kind.' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
