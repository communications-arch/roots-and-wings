// Shared role-based permission helper.
//
// Uses the master Google Sheet to look up who holds a given coordinator role
// (e.g. "Supply Coordinator", "Cleaning Liaison") and derives their
// @rootsandwingsindy.com email from the directory. No env vars per role
// required — when a role changes hands in the sheet, the API picks it up.
//
// Cached in-memory on warm Lambda instances for ROLE_CACHE_TTL_MS to keep
// write-path latency low.
//
// Every role check is additionally satisfied by SUPER_USER_EMAIL
// (communications@). That address is the app-wide super user intended for
// helping members who are out or struggling technically.

const { google } = require('googleapis');

const SUPER_USER_EMAIL = 'communications@rootsandwingsindy.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Abbreviated titles in the volunteer sheet are normalised to their canonical
// form so permission checks can use the full title (matches client-side
// BOARD_TITLE_MAP in script.js).
const TITLE_NORMALIZATIONS = {
  'communications dir.': 'Communications Director',
  'membership dir.': 'Membership Director',
  'sustaining dir.': 'Sustaining Director'
};
function normalizeTitle(title) {
  if (!title) return title;
  const key = String(title).trim().toLowerCase();
  return TITLE_NORMALIZATIONS[key] || title;
}

let roleCache = null; // { fetchedAt, roleHolders: { roleTitle_lowercase: email } }

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  return google.sheets({ version: 'v4', auth });
}

function cell(row, col) {
  if (!row || col >= row.length) return '';
  const v = row[col];
  return (v === undefined || v === null) ? '' : String(v).trim();
}

// Build lastName -> email map from the Directory tab.
// Matches the email-generation rule in api/sheets.js parseDirectory:
//   firstParentFirstName + familyLastInitial + @rootsandwingsindy.com
function buildDirectoryEmailMap(dirRows) {
  const map = {};
  if (!dirRows || dirRows.length < 2) return map;

  for (let r = 1; r < dirRows.length; r++) {
    const parentStr = cell(dirRows[r], 0);
    if (!parentStr) continue;

    // Strip pronoun parens: "Amber Furnish (she/her)" -> "Amber Furnish"
    const parentClean = parentStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (!parentClean) continue;

    // Family last name = last word of the FULL parentClean string
    // (matches api/sheets.js parseDirectory). For "Amber & Bobby Furnish"
    // that's "Furnish"; for a single "Madonna" entry there is no last
    // name and we skip the row.
    const parentWords = parentClean.split(/\s+/);
    if (parentWords.length < 2) continue;
    const familyName = parentWords[parentWords.length - 1];

    // First parent's first name = first word of parentClean
    const firstParentFirst = parentWords[0].toLowerCase().replace(/[^a-z]/g, '');
    const lastInitial = familyName.charAt(0).toLowerCase();
    if (!firstParentFirst || !lastInitial) continue;
    const email = firstParentFirst + lastInitial + '@' + ALLOWED_DOMAIN;

    map[familyName.toLowerCase()] = email;
  }
  return map;
}

// Minimal volunteer-committee parse: return a flat list of { title, person }
// from the "Year Volunteer Roles" tab. Mirrors api/sheets.js logic but trimmed
// to what we need (role title + person name).
function parseVolunteerRoles(rows) {
  const out = [];
  if (!rows || rows.length < 2) return out;

  for (let r = 0; r < rows.length; r++) {
    const label = cell(rows[r], 1);
    const value = cell(rows[r], 2);
    if (!label) continue;
    if (label.match(/Committee\s*$/i)) continue;

    // Chair rows: everything lives in col 1 as "Chair: <title>-<person>"
    if (label.match(/^Chair:/i)) {
      const parts = label.replace(/^Chair:\s*/i, '');
      const dashIdx = parts.lastIndexOf('-');
      if (dashIdx <= -1) continue;
      const rawTitle = parts.substring(0, dashIdx).trim();
      const person = parts.substring(dashIdx + 1).trim();
      if (rawTitle && person) out.push({ title: normalizeTitle(rawTitle), person });
      continue;
    }

    // Filler rows, unrelated liaison-chart rows, etc.
    if (label.match(/^(Morning Class|See chart|>)/i)) continue;

    // Regular role rows require a person in col 2.
    if (!value) continue;
    out.push({ title: normalizeTitle(label), person: value });
  }
  return out;
}

async function loadRoleHolders() {
  const now = Date.now();
  if (roleCache && (now - roleCache.fetchedAt) < ROLE_CACHE_TTL_MS) {
    return roleCache.roleHolders;
  }

  const spreadsheetId = process.env.MASTER_SHEET_ID;
  const directoryId = process.env.DIRECTORY_SHEET_ID;
  if (!spreadsheetId || !directoryId) {
    throw new Error('MASTER_SHEET_ID / DIRECTORY_SHEET_ID not configured');
  }

  const sheets = getSheetsClient();

  // Find the volunteer-roles tab by title so we can fetch just that range.
  const [masterMeta, dirMeta] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }),
    sheets.spreadsheets.get({ spreadsheetId: directoryId, fields: 'sheets.properties.title' })
  ]);

  const volTab = masterMeta.data.sheets
    .map(s => s.properties.title)
    .find(t => /Year.*Volunteer/i.test(t));
  if (!volTab) throw new Error('Volunteer roles tab not found in master sheet');

  const dirTab = dirMeta.data.sheets
    .map(s => s.properties.title)
    .find(t => /Directory/i.test(t)) || dirMeta.data.sheets[0].properties.title;

  const [volData, dirData] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "'" + volTab + "'",
      valueRenderOption: 'UNFORMATTED_VALUE'
    }),
    sheets.spreadsheets.values.get({
      spreadsheetId: directoryId,
      range: "'" + dirTab + "'",
      valueRenderOption: 'UNFORMATTED_VALUE'
    })
  ]);

  const roles = parseVolunteerRoles(volData.data.values || []);
  const emailByLastName = buildDirectoryEmailMap(dirData.data.values || []);

  // Map role title (lowercased) -> email (by last name of the named person)
  const roleHolders = {};
  for (const { title, person } of roles) {
    if (!title || !person) continue;
    const lastName = person.trim().split(/\s+/).pop().toLowerCase();
    const email = emailByLastName[lastName];
    if (email) {
      roleHolders[title.toLowerCase()] = email;
    }
  }

  roleCache = { fetchedAt: now, roleHolders };
  return roleHolders;
}

// Force-refresh the cache on next lookup. Call this from admin/debug paths
// if you need to clear stale data without waiting for the TTL.
function invalidateRoleCache() {
  roleCache = null;
}

// Look up the email of whoever holds `roleTitle` (case-insensitive). Returns
// null if the role isn't named in the sheet or the person can't be matched to
// a family in the directory.
async function getRoleHolderEmail(roleTitle) {
  if (!roleTitle) return null;
  try {
    const holders = await loadRoleHolders();
    return holders[roleTitle.toLowerCase()] || null;
  } catch (err) {
    console.error('getRoleHolderEmail lookup failed:', err);
    return null;
  }
}

// Batch variant: returns { [roleTitle]: email } for all titles that matched.
async function getRoleHolderEmails(roleTitles) {
  if (!Array.isArray(roleTitles) || roleTitles.length === 0) return {};
  try {
    const holders = await loadRoleHolders();
    const out = {};
    for (const title of roleTitles) {
      const email = holders[String(title).toLowerCase()];
      if (email) out[title] = email;
    }
    return out;
  } catch (err) {
    console.error('getRoleHolderEmails lookup failed:', err);
    return {};
  }
}

// True if `userEmail` is authorized to perform actions gated to `roleTitle`,
// either because they hold that role in the volunteer committees sheet, or
// because they are the communications@ super user.
async function canEditAsRole(userEmail, roleTitle) {
  if (!userEmail) return false;
  const email = userEmail.toLowerCase();
  if (email === SUPER_USER_EMAIL) return true;

  try {
    const holders = await loadRoleHolders();
    const holder = holders[roleTitle.toLowerCase()];
    return !!holder && email === holder.toLowerCase();
  } catch (err) {
    console.error('canEditAsRole lookup failed:', err);
    // On sheet failure, fall back to super-user-only so we fail closed.
    return false;
  }
}

module.exports = {
  SUPER_USER_EMAIL,
  canEditAsRole,
  getRoleHolderEmail,
  getRoleHolderEmails,
  invalidateRoleCache,
  // Exported for tests:
  _parseVolunteerRoles: parseVolunteerRoles,
  _buildDirectoryEmailMap: buildDirectoryEmailMap
};
