// Shared role-based permission helper.
//
// Phase B (2026-04-29): the role-holder source of truth is the
// `role_holders` Postgres table (joined to `role_descriptions`), not the
// volunteer Google sheet. The President + super users manage holders
// through the Workspace UI (api/cleaning.js role-holders endpoints).
// The seed script `scripts/seed-role-holders.js` is now a one-shot
// migration tool only — runtime no longer touches the sheet.
//
// Every role check is additionally satisfied by:
//   - any address in SUPER_USER_EMAILS (app-wide super users), or
//   - the canonical board mailbox for that role (BOARD_ROLE_EMAILS),
//     so signing in as e.g. treasurer@ always grants Treasurer
//     regardless of who currently holds the role in role_holders.

const { neon } = require('@neondatabase/serverless');

const SUPER_USER_EMAIL = 'communications@rootsandwingsindy.com';
// All addresses that get app-wide super-user privileges (edit anything,
// View-As any family). communications@ is the primary; vicepresident@
// (and its vp@ alias) was added so the VP can help members from her own
// mailbox without sharing comms@ credentials.
const SUPER_USER_EMAILS = [
  SUPER_USER_EMAIL,
  'vicepresident@rootsandwingsindy.com',
  'vp@rootsandwingsindy.com'
];
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';

// Board roles each have a dedicated Workspace mailbox. Signing in with
// the mailbox itself unconditionally grants the role — the mailbox IS
// the role, and a static map sidesteps any flakiness in role_holders
// being seeded for the right year.
const BOARD_ROLE_EMAILS = {
  'president':              ['president@rootsandwingsindy.com'],
  'vice president':         ['vicepresident@rootsandwingsindy.com', 'vp@rootsandwingsindy.com'],
  'vice-president':         ['vicepresident@rootsandwingsindy.com', 'vp@rootsandwingsindy.com'],
  'treasurer':              ['treasurer@rootsandwingsindy.com'],
  'secretary':              ['secretary@rootsandwingsindy.com'],
  'membership director':    ['membership@rootsandwingsindy.com'],
  'sustaining director':    ['sustaining@rootsandwingsindy.com', 'sustainingdirector@rootsandwingsindy.com'],
  'communications director':['communications@rootsandwingsindy.com']
};

// Title aliases — call sites use the un-hyphenated form ("Vice
// President"); role_descriptions stores the hyphenated canonical
// ("Vice-President"). Map common variants to the canonical title used
// in the DB so the lookup matches.
const TITLE_ALIASES = {
  'vice president': 'Vice-President'
};

function canonicalTitle(t) {
  const lower = String(t || '').trim().toLowerCase();
  return TITLE_ALIASES[lower] || String(t || '').trim();
}

function isSuperUser(email) {
  if (!email) return false;
  return SUPER_USER_EMAILS.indexOf(String(email).toLowerCase()) !== -1;
}

// April 1 flip — matches activeSchoolYear() in script.js and
// activeSchoolYearLabel() in api/sheets.js so server defaults agree
// with the client default. Registrations open in late April for the
// upcoming school year, so April is the natural pivot.
function activeSchoolYear(now) {
  now = now || new Date();
  const fallYear = (now.getMonth() < 3) ? now.getFullYear() - 1 : now.getFullYear();
  return fallYear + '-' + (fallYear + 1);
}

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

// True if `userEmail` is authorized to perform actions gated to
// `roleTitle`. Resolution order:
//   1. App-wide super user (communications@ / vicepresident@ / vp@)
//   2. Canonical board mailbox for that role (treasurer@, etc.)
//   3. role_holders row matching this email + role for the active year
async function canEditAsRole(userEmail, roleTitle) {
  if (!userEmail || !roleTitle) return false;
  const email = String(userEmail).toLowerCase();
  if (isSuperUser(email)) return true;

  const titleLc = String(roleTitle).toLowerCase();
  const boardEmails = BOARD_ROLE_EMAILS[titleLc] || [];
  if (boardEmails.indexOf(email) !== -1) return true;

  try {
    const sql = getDb();
    const canonical = canonicalTitle(roleTitle).toLowerCase();
    const rows = await sql`
      SELECT 1
      FROM role_holders rh
      JOIN role_descriptions rd ON rd.id = rh.role_id
      WHERE LOWER(rh.email) = ${email}
        AND LOWER(rd.title) = ${canonical}
        AND rh.school_year = ${activeSchoolYear()}
      LIMIT 1
    `;
    if (rows.length > 0) return true;
    console.warn('[perms] canEditAsRole DENY user=' + email +
      ' role=' + roleTitle + ' (no role_holders row for active year)');
    return false;
  } catch (err) {
    console.error('[perms] canEditAsRole DB lookup failed for user=' + email +
      ' role=' + roleTitle + ':', err);
    // Fail closed — without DB we can't authorize.
    return false;
  }
}

// Look up the email of whoever holds `roleTitle` for the active year.
// Returns the canonical board mailbox as a fallback so 403 responses
// always surface an actionable address.
async function getRoleHolderEmail(roleTitle) {
  if (!roleTitle) return null;
  try {
    const sql = getDb();
    const canonical = canonicalTitle(roleTitle).toLowerCase();
    const rows = await sql`
      SELECT rh.email
      FROM role_holders rh
      JOIN role_descriptions rd ON rd.id = rh.role_id
      WHERE LOWER(rd.title) = ${canonical}
        AND rh.school_year = ${activeSchoolYear()}
      ORDER BY rh.id ASC
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0].email;
  } catch (err) {
    console.error('[perms] getRoleHolderEmail failed:', err);
  }
  const boardEmails = BOARD_ROLE_EMAILS[String(roleTitle).toLowerCase()];
  return (boardEmails && boardEmails[0]) || null;
}

// Batch variant for endpoints that need several role holders at once
// (e.g. workspace cards). Returns { [originalTitle]: email } only for
// titles that resolved.
async function getRoleHolderEmails(roleTitles) {
  if (!Array.isArray(roleTitles) || roleTitles.length === 0) return {};
  const out = {};
  try {
    const sql = getDb();
    // Map each input title to its canonical lowercase form so the
    // join hits role_descriptions even when callers use the unhyphenated
    // alias.
    const canonicalLc = roleTitles.map(t => canonicalTitle(t).toLowerCase());
    const rows = await sql`
      SELECT LOWER(rd.title) AS title, rh.email, rh.id
      FROM role_holders rh
      JOIN role_descriptions rd ON rd.id = rh.role_id
      WHERE LOWER(rd.title) = ANY(${canonicalLc}::text[])
        AND rh.school_year = ${activeSchoolYear()}
      ORDER BY rh.id ASC
    `;
    rows.forEach(r => {
      // Map back to the caller's original title casing.
      const idx = canonicalLc.indexOf(r.title);
      if (idx === -1) return;
      const original = roleTitles[idx];
      if (!out[original]) out[original] = r.email;
    });
  } catch (err) {
    console.error('[perms] getRoleHolderEmails failed:', err);
  }
  return out;
}

module.exports = {
  SUPER_USER_EMAIL,
  SUPER_USER_EMAILS,
  BOARD_ROLE_EMAILS,
  isSuperUser,
  canEditAsRole,
  getRoleHolderEmail,
  getRoleHolderEmails,
  activeSchoolYear,
  // Exported for tests:
  _canonicalTitle: canonicalTitle
};
