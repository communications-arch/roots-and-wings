// Coverage API
//
// POST   /api/coverage         → claim a slot
// PATCH  /api/coverage?id=N    → VP reassign a slot
// DELETE /api/coverage?id=N    → unclaim a slot
//
// Greenhouse Host (#350) rides here too — same "claim a slot to help"
// shape, but per SESSION instead of per absence day:
// GET    /api/coverage?action=greenhouse-host   → status (sessions + hosts)
// POST   {action:'greenhouse-host-claim', session_number}
// POST   {action:'greenhouse-host-release', id}

const { neon } = require('@neondatabase/serverless');
const { OAuth2Client } = require('google-auth-library');
const { ALLOWED_ORIGINS } = require('./_config');
const { sendToUser } = require('./_push');
const { canEditAsRole, isBoardMember, canImpersonate, activeSchoolYear } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { resolveFamily } = require('./_family');

// Building Opener / Closer slots may only be covered by a board member
// (Erin, 2026-07-16). Mirrors BOARD_ONLY_ROLE_TYPES in absences.js.
const BOARD_ONLY_ROLE_TYPES = ['opener', 'closer'];

// The neon driver returns DATE columns as JS Date objects. Concatenating a
// Date with 'T12:00:00' yields "Wed Jul 16 2026...T12:00:00" → Invalid Date
// (2026-07-17 review: coverage notifications showed "Invalid Date"). Coerce
// both Date objects and strings to a plain YYYY-MM-DD first.
function isoDay(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v || '').slice(0, 10);
}

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

// View-As wrapper (#171 wave): same fix as api/absences.js — this endpoint
// ignored X-View-As, so a tester impersonating the VP couldn't reassign
// and impersonated claims/unclaims ran under the real login. `email` is
// the viewed identity for the gates; `realEmail` preserved for fallbacks.
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
// Permissions-table editable). The holder's personal login authorizes
// automatically via role_holders_v2 — the function name predates the table.
function isVP(email) { return hasCapability(email, 'coverage_admin'); }

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

// ── Greenhouse Host (#350) ──
// The 0-2 room has no programming; a host anchors it for a whole session
// so other toddler parents can float. Max 2 active hosts per session.
const GREENHOUSE_MAX_HOSTS = 2;

// Gate (Erin's explicit rule): the feature exists only while at least one
// enrolled kid is in the Greenhouse group this season. Transition-tolerant
// enrollment read per CLAUDE.md — a kid counts UNLESS they carry an
// explicit non-enrolled row (kid_enrollments is sparsely populated; no
// row ≠ withdrawn). Withdrawn families drop out via member_profiles.
async function greenhouseKidsExist(sql, year) {
  const rows = await sql`
    SELECT 1 FROM kids k
    LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(k.family_email)
    WHERE LOWER(COALESCE(k.class_group, '')) = 'greenhouse'
      AND mp.withdrawn_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM kid_enrollments e
        WHERE e.kid_id = k.id AND e.season = ${year} AND e.status <> 'enrolled')
    LIMIT 1
  `;
  return rows.length > 0;
}

// Board members + the coverage admin (VP by default) may release anyone's
// claim — the same "reviewer" convention the rest of this file uses.
async function canReleaseAnyGreenhouseHost(email) {
  if (await isBoardMember(email)) return true;
  return await isVP(email);
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

    // ── Greenhouse Host (#350): routed by explicit action, ahead of the
    // legacy method-shaped coverage-slot handlers below. ──
    const ghAction = String((req.query || {}).action || (req.body || {}).action || '');
    const meEmail = String(user.email || '').toLowerCase();
    const meRealEmail = String(user.realEmail || user.email || '').toLowerCase();

    // Status: which sessions this school year, who's hosting each, whether
    // the Greenhouse gate is open, and what the viewer may do. School-year
    // resolution = activeSchoolYear() (April-1 flip), the same helper the
    // class sign-up surfaces in api/curriculum.js use — do NOT swap in the
    // cleaning rota's MAX-of-rows variant here.
    if (ghAction === 'greenhouse-host' && req.method === 'GET') {
      const year = activeSchoolYear();
      const hasKids = await greenhouseKidsExist(sql, year);
      if (!hasKids) {
        // Gate closed → the card hides entirely; send nothing else.
        return res.status(200).json({
          school_year: year, greenhouse_kids: false, sessions: [],
          can_release_any: false, max_hosts: GREENHOUSE_MAX_HOSTS
        });
      }
      const [sessRows, claimRows, canReleaseAny] = await Promise.all([
        sql`SELECT session_number, name, start_date, end_date
            FROM co_op_sessions WHERE school_year = ${year}
            ORDER BY session_number`,
        // Host display names via the people/email join convention (never
        // raw emails); family_name is the fallback for a people-less login.
        // DISTINCT ON guards against a duplicated people email fanning out.
        sql`SELECT DISTINCT ON (c.id)
              c.id, c.session_number, c.claimed_at,
              LOWER(c.claimed_by_email) AS claimer,
              NULLIF(TRIM(CONCAT_WS(' ', p.first_name, NULLIF(p.last_name, ''))), '') AS person_name,
              mp.family_name
            FROM greenhouse_host_claims c
            LEFT JOIN people p ON LOWER(p.email) = LOWER(c.claimed_by_email)
            LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(c.family_email)
            WHERE c.school_year = ${year} AND c.released_at IS NULL
            ORDER BY c.id`,
        canReleaseAnyGreenhouseHost(user.email)
      ]);
      const hostsBySession = {};
      claimRows
        .slice()
        .sort((a, b) => new Date(a.claimed_at) - new Date(b.claimed_at))
        .forEach(c => {
          (hostsBySession[c.session_number] || (hostsBySession[c.session_number] = [])).push({
            id: c.id,
            name: c.person_name || (c.family_name ? String(c.family_name) : 'A member'),
            mine: c.claimer === meEmail || c.claimer === meRealEmail
          });
        });
      return res.status(200).json({
        school_year: year,
        greenhouse_kids: true,
        can_release_any: canReleaseAny,
        max_hosts: GREENHOUSE_MAX_HOSTS,
        sessions: sessRows.map(s => ({
          session_number: s.session_number,
          name: s.name || '',
          start_date: isoDay(s.start_date),
          end_date: isoDay(s.end_date),
          hosts: hostsBySession[s.session_number] || []
        }))
      });
    }

    // Claim: any adult member may host (the gate is about Greenhouse kids
    // existing, not the claimer's own kids). The conditional INSERT…SELECT
    // makes the DB the arbiter of the 2-host cap and the no-double-claim
    // rule, same race posture as the slot-claim UPDATE below.
    if (ghAction === 'greenhouse-host-claim' && req.method === 'POST') {
      const sess = parseInt((req.body || {}).session_number, 10);
      if (!Number.isFinite(sess) || sess < 1) {
        return res.status(400).json({ error: 'session_number required' });
      }
      const year = activeSchoolYear();
      if (!(await greenhouseKidsExist(sql, year))) {
        return res.status(409).json({ error: 'No Greenhouse (0-2) kids are enrolled this season.' });
      }
      const sessRow = await sql`SELECT 1 FROM co_op_sessions
        WHERE school_year = ${year} AND session_number = ${sess} LIMIT 1`;
      if (sessRow.length === 0) {
        return res.status(400).json({ error: 'Unknown session for ' + year + '.' });
      }
      const fam = await resolveFamily(sql, user.email);
      const familyEmail = (fam && fam.family_email) || user.email;
      const inserted = await sql`
        INSERT INTO greenhouse_host_claims (school_year, session_number, family_email, claimed_by_email)
        SELECT ${year}, ${sess}, ${familyEmail}, ${user.email}
        WHERE (SELECT COUNT(*) FROM greenhouse_host_claims
               WHERE school_year = ${year} AND session_number = ${sess}
                 AND released_at IS NULL) < ${GREENHOUSE_MAX_HOSTS}
          AND NOT EXISTS (SELECT 1 FROM greenhouse_host_claims
               WHERE school_year = ${year} AND session_number = ${sess}
                 AND released_at IS NULL
                 AND LOWER(claimed_by_email) = ${meEmail})
        RETURNING id
      `;
      if (inserted.length === 0) {
        const own = await sql`SELECT 1 FROM greenhouse_host_claims
          WHERE school_year = ${year} AND session_number = ${sess}
            AND released_at IS NULL AND LOWER(claimed_by_email) = ${meEmail} LIMIT 1`;
        return res.status(409).json({
          error: own.length
            ? 'You’re already hosting this session.'
            : 'Both host spots for this session are taken.'
        });
      }
      return res.status(200).json({ ok: true, id: inserted[0].id });
    }

    // Release own claim; board / coverage admin may release anyone's.
    // Releasing stamps released_at — the row stays (no DELETE).
    if (ghAction === 'greenhouse-host-release' && req.method === 'POST') {
      const claimId = parseInt((req.body || {}).id, 10);
      if (!claimId) return res.status(400).json({ error: 'id required' });
      const rows = await sql`SELECT id, LOWER(claimed_by_email) AS claimer
        FROM greenhouse_host_claims WHERE id = ${claimId} AND released_at IS NULL`;
      if (rows.length === 0) return res.status(404).json({ error: 'Claim not found' });
      if (rows[0].claimer !== meEmail && rows[0].claimer !== meRealEmail
          && !(await canReleaseAnyGreenhouseHost(user.email))) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      await sql`UPDATE greenhouse_host_claims SET released_at = NOW()
        WHERE id = ${claimId} AND released_at IS NULL`;
      return res.status(200).json({ ok: true, id: claimId });
    }

    // ── POST: claim a slot ──
    if (req.method === 'POST') {
      const slotId = parseInt((req.body || {}).slot_id, 10);
      if (!slotId) return res.status(400).json({ error: 'slot_id required' });

      // Check slot exists and is unclaimed
      const slot = await sql`
        SELECT cs.*, a.family_email AS absent_family_email, a.absent_person, a.absence_date
        FROM coverage_slots cs
        JOIN absences a ON a.id = cs.absence_id
        WHERE cs.id = ${slotId} AND a.cancelled_at IS NULL
      `;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });
      if (slot[0].claimed_by_email) return res.status(409).json({ error: 'Slot already claimed' });
      if (BOARD_ONLY_ROLE_TYPES.indexOf(slot[0].role_type) !== -1 && !(await isBoardMember(user.email))) {
        return res.status(403).json({ error: 'Only a board member can cover the Building Opener/Closer.' });
      }

      const claimerName = String((req.body || {}).claimer_name || user.name || '').trim();

      // Codebase review 2026-08-08: the pre-check + unconditional UPDATE
      // let two simultaneous claims both win, the second silently
      // overwriting the first claimant (who still thinks they're covering).
      // The WHERE now includes claimed_by_email IS NULL, so the race loser
      // updates zero rows and gets the 409 — the DB is the arbiter.
      const claimed = await sql`
        UPDATE coverage_slots
        SET claimed_by_email = ${user.email}, claimed_by_name = ${claimerName}, claimed_at = NOW()
        WHERE id = ${slotId} AND claimed_by_email IS NULL
        RETURNING id
      `;
      if (claimed.length === 0) return res.status(409).json({ error: 'Slot already claimed' });

      // Notify the absent person
      const dateLabel = new Date(isoDay(slot[0].absence_date) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const notifTitle = 'Slot Covered — ' + dateLabel;
      const notifBody = claimerName + ' is covering: ' + slot[0].role_description;

      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
        VALUES (${slot[0].absent_family_email}, 'slot_claimed', ${notifTitle}, ${notifBody}, '#coverage', ${slot[0].absence_id})
      `;
      try {
        await sendToUser(sql, slot[0].absent_family_email, {
          title: notifTitle, body: notifBody, tag: 'claimed-' + slotId, url: '/members.html#coverage'
        });
      } catch (e) { console.error('Push error:', e); }

      return res.status(200).json({ ok: true, slot_id: slotId });
    }

    // ── PATCH: VP reassign ──
    if (req.method === 'PATCH') {
      if (!(await isVP(user.email))) return res.status(403).json({ error: 'Only the VP can reassign slots' });

      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const body = req.body || {};
      const newEmail = String(body.claimed_by_email || '').trim();
      const newName = String(body.claimed_by_name || '').trim();

      const slot = await sql`
        SELECT cs.*, a.absence_date
        FROM coverage_slots cs
        JOIN absences a ON a.id = cs.absence_id
        WHERE cs.id = ${id}
      `;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });

      if (newEmail && BOARD_ONLY_ROLE_TYPES.indexOf(slot[0].role_type) !== -1
          && !(await isBoardMember(newEmail))) {
        return res.status(400).json({ error: 'The Building Opener/Closer can only be covered by a board member.' });
      }

      if (newEmail) {
        await sql`
          UPDATE coverage_slots
          SET claimed_by_email = ${newEmail}, claimed_by_name = ${newName}, claimed_at = NOW(), assigned_by = ${user.email}
          WHERE id = ${id}
        `;
        // Notify the new assignee
        const dateLabel = new Date(isoDay(slot[0].absence_date) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        await sql`
          INSERT INTO notifications (recipient_email, type, title, body, link_url, related_absence_id)
          VALUES (${newEmail}, 'slot_reassigned', ${'Assigned to Cover — ' + dateLabel}, ${'VP assigned you to: ' + slot[0].role_description}, '#coverage', ${slot[0].absence_id})
        `;
        try {
          await sendToUser(sql, newEmail, {
            title: 'Assigned to Cover — ' + dateLabel,
            body: 'VP assigned you to: ' + slot[0].role_description,
            tag: 'reassign-' + id, url: '/members.html#coverage'
          });
        } catch (e) { console.error('Push error:', e); }
      } else {
        // Unassign
        await sql`
          UPDATE coverage_slots
          SET claimed_by_email = NULL, claimed_by_name = NULL, claimed_at = NULL, assigned_by = NULL
          WHERE id = ${id}
        `;
      }

      return res.status(200).json({ ok: true, id });
    }

    // ── DELETE: unclaim a slot ──
    if (req.method === 'DELETE') {
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const slot = await sql`SELECT * FROM coverage_slots WHERE id = ${id}`;
      if (slot.length === 0) return res.status(404).json({ error: 'Slot not found' });

      // Only the claimer or VP can unclaim (realEmail too: a claim made
      // without impersonation is still unclaimable mid-View-As)
      if (slot[0].claimed_by_email !== user.email
          && slot[0].claimed_by_email !== (user.realEmail || user.email)
          && !(await isVP(user.email))) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      await sql`
        UPDATE coverage_slots
        SET claimed_by_email = NULL, claimed_by_name = NULL, claimed_at = NULL, assigned_by = NULL
        WHERE id = ${id}
      `;
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Coverage API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
