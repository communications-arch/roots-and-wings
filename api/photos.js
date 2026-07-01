// Profile photo API
//
// GET /api/photos
//     Auth required (@rootsandwingsindy.com JWT). Returns
//     { photos: { email: thumbnailPhotoUrl, ... } } for the full Workspace
//     directory, via the Admin SDK.
//     Side effect: caches the 7 board members' photos into the
//     `board_photos` table so the public site can render them without
//     requiring sign-in.
//
// GET /api/photos?scope=board
//     No auth required. Returns the cached board member photos for the
//     public site. Shape:
//     { board: [ { email, photo_url, role_title, full_name }, ... ] }

const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');
const { getRoleHolderEmails } = require('./_permissions');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

// Board role titles in canonical display order. Sourced statically here
// because upsertBoardPhotos needs the title set before any DB query — the
// DB is the source of truth (roles WHERE category='board'), but we want
// the photo cache to populate even if the DB is unreachable. Order
// matches what shapeBoardRows / index.html expect.
const BOARD_ROLE_TITLES = [
  'President',
  'Vice President',
  'Treasurer',
  'Secretary',
  'Membership Director',
  'Sustaining Director',
  'Communications Director'
];

async function verifyGoogleAuth(req) {
  var authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  try {
    var ticket = await verifyBearer(authHeader.slice(7));
    var payload = ticket.getPayload();
    var domain = (payload.email || '').split('@')[1] || '';
    return domain === ALLOWED_DOMAIN;
  } catch (e) {
    return false;
  }
}

function getAdminAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
    clientOptions: { subject: 'communications@rootsandwingsindy.com' }
  });
}

function getSql() {
  if (!process.env.DATABASE_URL) return null;
  return neon(process.env.DATABASE_URL);
}

// Build a set of Workspace emails that belong to parents who opted out of
// photo use. Defense in depth: the client-side rendering already honors
// photo_consent via getPhotoUrl, this prevents opted-out photos from ever
// leaving the API and from being cached to the public board_photos table.
//
// Derivation: family_email's local part is "<firstLC><familyLastInitial>".
// For any parent in that family, the Workspace email is
// "<parentFirstLC><familyLastInitial>@<domain>". Returns empty on any DB
// error so we fail open — the client-side gate is the primary enforcement.
async function getOptedOutAdultEmails(workspaceUsers) {
  const sql = getSql();
  if (!sql) return new Set();
  try {
    // Each opted-out person now lives as a row in `people` keyed by their
    // own Workspace email, so we can directly intersect against the
    // workspaceUsers map without re-deriving emails from family_email +
    // first-name initials.
    const rows = await sql`
      SELECT email FROM people WHERE photo_consent = FALSE
    `;
    const optedOut = new Set();
    for (const r of rows) {
      const e = String(r.email || '').toLowerCase();
      if (e && workspaceUsers[e]) optedOut.add(e);
    }
    return optedOut;
  } catch (err) {
    console.warn('opted-out adult lookup failed (fail open):', err.message);
    return new Set();
  }
}

// Pull fresh Workspace photos from the Admin SDK and return email -> { url, name }.
async function fetchWorkspaceUsers() {
  const auth = getAdminAuth();
  const admin = google.admin({ version: 'directory_v1', auth });

  const users = [];
  let pageToken = null;
  do {
    const params = {
      domain: ALLOWED_DOMAIN,
      maxResults: 500,
      projection: 'basic',
      fields: 'users(primaryEmail,thumbnailPhotoUrl,name),nextPageToken'
    };
    if (pageToken) params.pageToken = pageToken;
    const result = await admin.users.list(params);
    if (result.data.users) users.push(...result.data.users);
    pageToken = result.data.nextPageToken;
  } while (pageToken);

  const byEmail = {};
  users.forEach(u => {
    if (u.thumbnailPhotoUrl) {
      byEmail[u.primaryEmail] = {
        url: u.thumbnailPhotoUrl,
        name: (u.name && u.name.fullName) || ''
      };
    }
  });
  return byEmail;
}

// Side-effect: upsert the 7 board member photos into board_photos so the
// public site can read them without auth. Silent on failure — we never want
// a caching glitch to break the member-portal directory.
async function upsertBoardPhotos(workspaceUsers, optedOut) {
  const sql = getSql();
  if (!sql) return;

  let roleToEmail;
  try {
    // Mirror handleBoardScope: use the most recent school_year that
    // actually has board holders. Going through activeSchoolYear() bites
    // us between its April 1 pivot and the moment next year's board is
    // seeded — the public site reader sees the prior-year row, but the
    // photo cache writer skipped it. Same MAX query keeps them aligned.
    const yrRows = await sql`SELECT MAX(school_year) AS sy FROM role_holders_v2`;
    const schoolYear = yrRows[0] && yrRows[0].sy;
    if (!schoolYear) return;
    roleToEmail = await getRoleHolderEmails(BOARD_ROLE_TITLES, schoolYear);
  } catch (_) {
    return;
  }

  const optedOutSet = optedOut || new Set();
  const rows = [];
  const deleteEmails = [];
  for (const title of BOARD_ROLE_TITLES) {
    const email = roleToEmail[title];
    if (!email) continue;
    // Opted-out board members: drop any previously cached row so the public
    // site stops serving their face after they flip the choice.
    if (optedOutSet.has(email)) {
      deleteEmails.push(email);
      continue;
    }
    const user = workspaceUsers[email];
    if (!user || !user.url) continue;
    rows.push({ email, url: user.url, title, name: user.name });
  }

  for (const r of rows) {
    try {
      await sql`
        INSERT INTO board_photos (email, photo_url, role_title, full_name, updated_at)
        VALUES (${r.email}, ${r.url}, ${r.title}, ${r.name}, NOW())
        ON CONFLICT (email) DO UPDATE
          SET photo_url  = EXCLUDED.photo_url,
              role_title = EXCLUDED.role_title,
              full_name  = EXCLUDED.full_name,
              updated_at = NOW()
      `;
    } catch (err) {
      console.warn('board_photos upsert failed for', r.email, err.message);
    }
  }
  for (const e of deleteEmails) {
    try {
      await sql`DELETE FROM board_photos WHERE email = ${e}`;
    } catch (err) {
      console.warn('board_photos delete failed for', e, err.message);
    }
  }
}

// Pure: dedupe + canonical-order joined role_holder rows for the public
// board grid. Pulled out so scripts/test-board-scope.js can exercise the
// shape contract without a live DB.
//
// Input rows: [{ email, person_name, title, photo_url }]
// Output:     [{ role_title, full_name, email, photo_url }] in canonical
// board hierarchy. Titles are normalized (Vice-President → Vice President).
// When a role has multiple rows, the one with a non-empty photo wins; ties
// keep the first-seen.
function shapeBoardRows(rows) {
  const titleOrder = {};
  BOARD_ROLE_TITLES.forEach((t, i) => { titleOrder[t.toLowerCase()] = i; });
  function normalizeTitle(t) {
    return String(t || '').replace(/^Vice-President$/i, 'Vice President');
  }
  const byTitle = {};
  (rows || []).forEach(r => {
    const title = normalizeTitle(r.title);
    const existing = byTitle[title];
    if (!existing || (!existing.photo_url && r.photo_url)) {
      byTitle[title] = {
        role_title: title,
        full_name: r.person_name || '',
        email: String(r.email || '').toLowerCase(),
        photo_url: r.photo_url || ''
      };
    }
  });
  return Object.keys(byTitle)
    .sort((a, b) => (titleOrder[a.toLowerCase()] ?? 99) - (titleOrder[b.toLowerCase()] ?? 99))
    .map(t => byTitle[t]);
}

// ── Public endpoint: return current board members from the DB, no auth ──
//
// Source of truth is role_holders_v2 + roles for THIS school year
// (membership rotates annually). The roles row carries `category='board'`
// so we filter by category instead of matching titles. Current holder
// name resolves via the people join (snapshot columns were dropped from
// role_holders_v2 — see feedback rw_role_holder_name_resolution).
// photo_url is left-joined from board_photos (populated as a side-effect
// of authed /api/photos calls); a missing photo just means "no Workspace
// photo on file" — the public-site script falls back to initials.
//
// Returned shape: {
//   board: [{
//     role_key, role_title, full_name, email, photo_url,
//     icon_emoji, role_email, card_summary
//   }],
//   school_year
// }
// Order is the canonical board hierarchy (President → Comms Director),
// not alphabetical, so the public grid always renders in the order the
// co-op presents itself.
//
// The rich fields (icon_emoji, card_summary, role_email) power the
// members.html portal-board overlay; index.html only needs role_title /
// full_name / photo_url. Same response shape serves both — the v2
// design merged the public + portal endpoints to keep Vercel's Hobby
// 12-function ceiling.
async function handleBoardScope(req, res) {
  const sql = getSql();
  if (!sql) return res.status(200).json({ board: [] });
  // Short cache so board edits in the Roles Manager propagate to the
  // public site within ~a minute. Board edits are rare but when they
  // happen we want them visible now, not 30 minutes later.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  try {
    // Pick the most recent school_year that actually has board holders.
    // Usually this is the current academic year, but tolerates the May
    // transition where next year's board has been seeded before the
    // calendar flips. Falls back to a calendar-derived year if v2 is
    // empty so the empty-state response still has a sensible label.
    const yrRows = await sql`
      SELECT MAX(school_year) AS sy FROM role_holders_v2
    `;
    const now = new Date();
    const fallbackStart = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const schoolYear = (yrRows[0] && yrRows[0].sy) || (fallbackStart + '-' + (fallbackStart + 1));

    const rows = await sql`
      SELECT
        r.role_key,
        r.title,
        r.icon_emoji,
        r.role_email,
        r.card_summary,
        r.display_order,
        rhv.person_email AS email,
        TRIM(CONCAT_WS(' ', p.first_name, p.last_name)) AS person_name,
        bp.photo_url
      FROM roles r
      LEFT JOIN role_holders_v2 rhv
        ON rhv.role_id = r.id
       AND rhv.school_year = ${schoolYear}
       AND rhv.ended_at IS NULL
      LEFT JOIN people p
        ON LOWER(p.email) = LOWER(rhv.person_email)
      LEFT JOIN board_photos bp
        ON LOWER(bp.email) = LOWER(rhv.person_email)
      WHERE r.category = 'board' AND r.status = 'active'
      ORDER BY r.display_order
    `;

    // shapeBoardRows handles legacy callers (index.html). Rich fields
    // pass through untouched for the members.html overlay. The lookup
    // table keys on role_key (stable across the title normalization
    // shapeBoardRows applies, which would otherwise miss the
    // Vice-President → Vice President remap).
    const shaped = shapeBoardRows(rows);
    const byKey = {};
    rows.forEach(r => { if (r.role_key) byKey[r.role_key] = r; });
    const KEY_BY_NORMALIZED_TITLE = {
      'president': 'president',
      'vice president': 'vice_president',
      'treasurer': 'treasurer',
      'secretary': 'secretary',
      'membership director': 'membership_director',
      'sustaining director': 'sustaining_director',
      'communications director': 'communications_director'
    };
    const enriched = shaped.map(s => {
      const key = KEY_BY_NORMALIZED_TITLE[String(s.role_title || '').toLowerCase()];
      const r = key ? (byKey[key] || {}) : {};
      return Object.assign({}, s, {
        role_key: r.role_key || '',
        icon_emoji: r.icon_emoji || '',
        role_email: r.role_email || '',
        card_summary: Array.isArray(r.card_summary) ? r.card_summary : []
      });
    });
    return res.status(200).json({ board: enriched, school_year: schoolYear });
  } catch (err) {
    console.error('board scope read failed:', err);
    return res.status(500).json({ error: 'Failed to read board' });
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Public endpoint — no auth required. Must be checked BEFORE verifyGoogleAuth.
  if (req.query.scope === 'board') {
    // Public cache-control set inside handleBoardScope
    return handleBoardScope(req, res);
  }

  // Authenticated endpoint. Short cache (60s) so portal sessions
  // re-trigger the board photo upsert below within a minute of any
  // board change. The hour-long cache that used to live here held
  // /api/photos responses long enough that role rotations went days
  // without refreshing board_photos.
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (!(await verifyGoogleAuth(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const workspaceUsers = await fetchWorkspaceUsers();

    // Filter opted-out adults before handing photos back to the portal or
    // caching board photos. This runs BEFORE the response so we don't leak
    // URLs that the DB says are off-limits.
    const optedOut = await getOptedOutAdultEmails(workspaceUsers);
    const allowedUsers = {};
    for (const email of Object.keys(workspaceUsers)) {
      if (!optedOut.has(email)) allowedUsers[email] = workspaceUsers[email];
    }

    // Build the email -> URL map the member portal already consumes.
    const photos = {};
    for (const email of Object.keys(allowedUsers)) {
      photos[email] = allowedUsers[email].url;
    }

    // Await the board photo cache refresh so Vercel doesn't terminate
    // the function before the upserts land in the DB. Previously this
    // was fire-and-forget and could be killed mid-write, leaving
    // newly-rotated board members without a board_photos row. The
    // refresh is ~7 small upserts — well within the budget.
    try {
      await upsertBoardPhotos(workspaceUsers, optedOut);
    } catch (err) {
      console.warn('upsertBoardPhotos failed:', err && err.message);
    }

    res.status(200).json({ photos });
  } catch (err) {
    console.error('Photos API error:', err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
};

// Exported for tests (scripts/test-board-scope.js). Vercel runs the
// default function as the handler and ignores attached properties.
module.exports.shapeBoardRows = shapeBoardRows;
