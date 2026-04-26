// Dumps every (committee, title, person) tuple parseVolunteerRoles
// pulls from the volunteer sheet — same parser the seed uses.
// Shows which titles map to a role_descriptions row (✓) vs which
// don't (✗), and how many person-chunks each cell contains.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');

function loadKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  let out = ''; let inStr = false; let esc = false;
  for (const c of raw) {
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && c === '\n') { out += '\\n'; continue; }
    if (inStr && c === '\r') continue;
    out += c;
  }
  return JSON.parse(out);
}

(async () => {
  const auth = new google.auth.GoogleAuth({
    credentials: loadKey(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    fields: 'sheets.properties.title'
  });
  const tab = meta.data.sheets.map(s => s.properties.title).find(t => /Year.*Volunteer/i.test(t));
  console.log('Volunteer tab:', tab, '\n');

  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.MASTER_SHEET_ID,
    range: "'" + tab + "'",
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const rows = data.data.values || [];

  const sql = neon(process.env.DATABASE_URL);
  const roleRows = await sql`SELECT title FROM role_descriptions WHERE category IN ('board','committee_role')`;
  const roleTitles = new Set(roleRows.map(r => r.title.toLowerCase()));

  // Mirror the seed's normalization map.
  const NORM = {
    'communications dir.': 'Communications Director',
    'membership dir.': 'Membership Director',
    'sustaining dir.': 'Sustaining Director',
    'afternoon class liaisons': 'Afternoon Class Liaison',
    'vice-president': 'Vice-President',
    'vice president': 'Vice-President',
    'opener & morning set-up': 'Building Opener',
    'closer/lost & found': 'Building Closer',
    'field trip coordinators': 'Field Trip Coordinator',
    'gratitude/encouragement': 'Gratitude/Encouragement Leader'
  };
  const norm = t => NORM[String(t || '').trim().toLowerCase()] || String(t || '').trim();

  console.log('All rows (col B → col C, with parser verdict):');
  console.log('verdict legend: SKIP=parser dropped row · ✓=title matched · ✗=no role_descriptions row\n');
  let currentCommittee = '';
  rows.forEach((row, i) => {
    const label = (row[1] || '').toString().trim();
    const value = (row[2] || '').toString().trim();
    if (!label && !value) return;
    if (label.match(/Committee\s*$/i)) {
      currentCommittee = label;
      console.log(`  ── ${label} ──`);
      return;
    }
    if (label.match(/^Chair:/i)) {
      const parts = label.replace(/^Chair:\s*/i, '');
      const dashIdx = parts.lastIndexOf('-');
      if (dashIdx <= -1) { console.log(`  SKIP[${i}] no dash in chair: "${label}"`); return; }
      const t = norm(parts.substring(0, dashIdx));
      const p = parts.substring(dashIdx + 1).trim();
      const verdict = roleTitles.has(t.toLowerCase()) ? '✓' : '✗';
      const chunks = p.split(/\s*[&\/,]\s*/).map(s => s.trim()).filter(Boolean);
      console.log(`  ${verdict} chair[${i}] "${t}" ← ${chunks.length} person(s): ${JSON.stringify(chunks)}`);
      return;
    }
    if (label.match(/^(Morning Class|See chart|>)/i)) {
      console.log(`  SKIP[${i}] regex filter: "${label}"`);
      return;
    }
    if (!label) return;
    if (!value) {
      console.log(`  SKIP[${i}] empty value: "${label}"`);
      return;
    }
    const t = norm(label);
    const verdict = roleTitles.has(t.toLowerCase()) ? '✓' : '✗';
    const chunks = value.split(/\s*[&\/,]\s*/).map(s => s.trim()).filter(Boolean);
    console.log(`  ${verdict} role[${i}] "${t}" ← ${chunks.length} person(s): ${JSON.stringify(chunks)}`);
  });
})().catch(e => { console.error(e); process.exit(1); });
