const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, isSuperUser, canImpersonate } = require('./_permissions');
const { hasCapability } = require('./_capabilities');
const { resolveFamily, canActAs } = require('./_family');

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

// ── Verify caller is authenticated ──
async function verifyAuth(req) {
  var authHeader = req.headers.authorization || '';

  // Google JWT: "Bearer <token>"
  if (authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7);
    try {
      var ticket = await verifyBearer(token);
      var payload = ticket.getPayload();
      var domain = (payload.email || '').split('@')[1] || '';
      if (domain !== ALLOWED_DOMAIN) {
        return { ok: false, reason: 'Domain not allowed' };
      }
      return {
        ok: true,
        email: payload.email,
        givenName: payload.given_name || '',
        familyName: payload.family_name || ''
      };
    } catch (e) {
      return { ok: false, reason: 'Invalid token' };
    }
  }

  return { ok: false, reason: 'No credentials provided' };
}

// ── Auth setup ──
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });
}

// ── Fetch all tabs from a sheet ──
async function fetchSheet(sheets, spreadsheetId) {
  var meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  var tabNames = meta.data.sheets.map(function(s) { return s.properties.title; });
  var ranges = tabNames.map(function(t) { return "'" + t + "'"; });
  var result = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: ranges,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });
  var tabs = {};
  result.data.valueRanges.forEach(function(vr, i) {
    tabs[tabNames[i]] = vr.values || [];
  });
  return tabs;
}

// ── Helper: get cell value safely ──
function cell(row, col) {
  if (!row || col >= row.length) return '';
  var v = row[col];
  return (v === undefined || v === null) ? '' : String(v).trim();
}

// ══════════════════════════════════════════════
// DIRECTORY / FAMILIES
// ══════════════════════════════════════════════
// Directory tab: col 0 = Parent name(s), col 1 = phone, col 2+ = children names.
// Classlist tab:  row 0 = group names, row 1 = liaisons, row 2 = rooms,
//                 row 3+ = kids "FirstName LastInitial".
//
// Pronouns and allergies used to be parsed from the Directory / Allergies tabs
// here; they now live on member_profiles.kids (and .parents) in Postgres and
// are applied via applyMemberProfileOverlay below. The Allergies tab is no
// longer read. Parenthetical "(pronouns)" text in the Directory tab is still
// stripped for display hygiene but the pronoun values themselves are ignored.

function parseDirectory(dirRows, classlistRows, allergyRows) {
  var families = [];

  if (!dirRows || dirRows.length < 2) return [];

  // Allergies and pronouns are sourced from member_profiles (DB) via the
  // overlay. allergyRows is accepted for signature compatibility but ignored.
  var allergyMap = {};

  // Build classlist lookup: { "firstname lastinitial" -> group }
  // Also build group metadata (liaisons, rooms)
  var classMap = {}; // lowercase kid name -> group name
  var groupMeta = {}; // group display name -> { liaison, room }
  if (classlistRows && classlistRows.length > 3) {
    var groupNames = []; // index = column
    // Map classlist group names (e.g., "Sassafras (3-6)") to AM_CLASSES keys (e.g., "Sassafras")
    var GROUP_NAME_MAP = {
      'Teens': 'Pigeons'
    };
    for (var c = 1; c < classlistRows[0].length; c++) {
      var gNameRaw = cell(classlistRows[0], c);
      // Strip age range: "Sassafras (3-6)" -> "Sassafras"
      var gName = gNameRaw.replace(/\s*\([^)]*\)\s*$/, '').trim();
      // Apply known name mappings
      if (GROUP_NAME_MAP[gName]) gName = GROUP_NAME_MAP[gName];
      groupNames[c] = gName;
      if (gName) {
        groupMeta[gName] = {
          liaison: cell(classlistRows[1], c),
          room: cell(classlistRows[2], c)
        };
      }
    }
    // Kids start at row 3
    // Track PM-only kids separately
    var pmOnlyKids = {}; // lowercase name -> true
    var inPmOnly = false;
    for (var r = 3; r < classlistRows.length; r++) {
      // Check if we've hit the "PM Only" section
      var firstCell = cell(classlistRows[r], 0) || cell(classlistRows[r], 1);
      if (firstCell.match(/^PM Only/i)) {
        inPmOnly = true;
        continue;
      }
      if (inPmOnly) {
        // PM-only kids are listed by name (no group assignment)
        for (var c = 0; c < (classlistRows[r] ? classlistRows[r].length : 0); c++) {
          var kidName = cell(classlistRows[r], c);
          if (kidName) pmOnlyKids[kidName.toLowerCase()] = true;
        }
      } else {
        for (var c = 1; c < (classlistRows[r] ? classlistRows[r].length : 0); c++) {
          var kidName = cell(classlistRows[r], c);
          if (kidName && groupNames[c]) {
            classMap[kidName.toLowerCase()] = groupNames[c];
          }
        }
      }
    }
  }

  // Parse families from Directory tab
  // Row 0 is header: "Name", "Phone Number", "Childs Name/Pronouns"
  for (var r = 1; r < dirRows.length; r++) {
    var parentStr = cell(dirRows[r], 0);
    if (!parentStr) continue;

    var phone = cell(dirRows[r], 1);

    // Parent pronouns now come from member_profiles.parents (DB overlay).
    // Parenthetical text is still stripped from display for legacy rows that
    // had "(she/her)" embedded in the parent cell.
    var parentPronouns = {};
    var parentClean = parentStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
    // Extract last name — last word of the parent string
    var parentWords = parentClean.split(/\s+/);
    var familyName = parentWords[parentWords.length - 1];

    // Parse children from cols 2+
    var kids = [];
    for (var c = 2; c < (dirRows[r] ? dirRows[r].length : 0); c++) {
      var kidStr = cell(dirRows[r], c);
      if (!kidStr) continue;

      // Kid pronouns come from member_profiles.kids via the DB overlay.
      // Parentheticals are still stripped for legacy "Name (she/her)" cells.
      var kidPronouns = '';
      var kidFirst = kidStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
      // Strip family name from kid's name if included (e.g., "Ava Hall" in Hall family → "Ava")
      if (kidFirst.toLowerCase().endsWith(' ' + familyName.toLowerCase())) {
        kidFirst = kidFirst.substring(0, kidFirst.length - familyName.length - 1).trim();
      }

      // Look up group from classlist
      // Classlist uses "FirstName LastInitial" format (e.g., "Edith H")
      // Try: exact "FirstName FamilyInitial", then any "FirstName X" entry
      var lastInitial = familyName.charAt(0).toUpperCase();
      var lookupKey1 = (kidFirst + ' ' + lastInitial).toLowerCase();
      var lookupKey2 = kidFirst.toLowerCase();
      var group = classMap[lookupKey1] || classMap[lookupKey2] || '';

      // If no match, scan classMap for any entry starting with this first name
      if (!group) {
        var kidFirstLower = kidFirst.toLowerCase();
        for (var key in classMap) {
          if (key.split(' ')[0] === kidFirstLower) {
            group = classMap[key];
            break;
          }
        }
      }

      // Check if PM-only kid
      var schedule = 'all-day';
      if (!group) {
        var pmKey1 = lookupKey1;
        var pmKey2 = lookupKey2;
        var isPmOnly = pmOnlyKids[pmKey1] || pmOnlyKids[pmKey2];
        if (!isPmOnly) {
          var kidFirstLower3 = kidFirst.toLowerCase();
          for (var key in pmOnlyKids) {
            if (key.split(' ')[0] === kidFirstLower3) {
              isPmOnly = true;
              break;
            }
          }
        }
        if (isPmOnly) schedule = 'afternoon';
      }

      // Allergies come from member_profiles.kids via the DB overlay.
      kids.push({
        name: kidFirst,
        group: group,
        schedule: schedule,
        pronouns: kidPronouns,
        allergies: '',
        photo_consent: true
      });
    }

    // Generate email: firstname + last initial @ rootsandwingsindy.com
    // Use the first parent's first name + family last name initial
    // Handle separators like "&", "/", ","
    var firstParentName = parentClean.split(/\s*[&\/,]\s*/)[0].trim();
    var firstParentFirst = firstParentName.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
    var lastInitial = familyName.charAt(0).toLowerCase();
    var email = firstParentFirst + lastInitial + '@rootsandwingsindy.com';

    // Build parents as first-names-only (matching expected format for parentFullNames construction)
    // "Amber Furnish" -> "Amber", "Amber & Bobby Furnish" -> "Amber & Bobby"
    var parentFirstNames = parentClean.split(/\s*[&\/,]\s*/).map(function(p) {
      var words = p.trim().split(/\s+/);
      // If last word matches family name, drop it
      if (words.length > 1 && words[words.length - 1].toLowerCase() === familyName.toLowerCase()) {
        words.pop();
      }
      return words.join(' ');
    }).join(' & ');

    families.push({
      name: familyName,
      parents: parentFirstNames,
      parentPronouns: parentPronouns,
      email: email,
      phone: phone,
      kids: kids
    });
  }

  return { families: families, groupMeta: groupMeta };
}

// ══════════════════════════════════════════════
// BILLING
// ══════════════════════════════════════════════
// Billing spreadsheet layout (the Treasurer links a NEW workbook each
// school year — e.g. "Treasurer 26-27" — via the BILLING_SHEET_ID env
// var; swap the var when the new year's workbook goes live):
//   "Family Payment Tracking" tab:
//     Row 1 = headers, rows 2+ = data.
//     A = Family Name (always).
//     Current-year columns: B = Fall Deposit, C = Fall Fees,
//       D = Spring Deposit, E = Spring Fees.
//     F = "Fall Deposit (Next Year)" — Treasurer's working column for
//       upcoming-year registration deposits (tracking next year's
//       deposits before that year's workbook exists). When billing is
//       requested for a school year AFTER the workbook's own year,
//       fall.deposit reads from F instead of B.
//     Cell value "Paid" (case-insensitive) means paid; anything else → not paid.
//   Rates: a "Semester 1 Rate" / "Semester 2 Rate" label cell with the
//     dollar amount in the cell to its right — "Morning Classes" tab for
//     AM rates, "Afternoons" tab for PM rates. Scanned by label so the
//     Treasurer can move them (26-27 workbook: Morning N2/O2-N3/O3,
//     Afternoons H2/I2-H3/I3; the 25-26 workbook kept bare values in
//     H2/H3, which the fallback still reads).

function numFromCell(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  var s = String(raw).replace(/[$,\s]/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Find a "Semester N Rate" label anywhere in the tab's first rows and
// return the amount in the cell to its right. 0 when not found.
function rateFromTab(tab, semNum) {
  var re = new RegExp('^\\s*Semester\\s*' + semNum + '\\s*Rate\\s*$', 'i');
  for (var r = 0; r < tab.length && r < 25; r++) {
    var row = tab[r] || [];
    for (var c = 0; c < row.length; c++) {
      if (re.test(String(row[c] || ''))) return numFromCell(row[c + 1]);
    }
  }
  return 0;
}

// The workbook's own school year: its transactions-register tab is named
// after it ("2026-2027"). Empty string if no such tab (legacy workbooks).
function billingSheetYear(tabs) {
  for (var name in tabs) {
    if (/^\d{4}-\d{4}$/.test(String(name).trim())) return String(name).trim();
  }
  return '';
}

// Column indexes for the Family Payment Tracking tab. The linked workbook
// is always the current year's, so current-year columns (B-E) serve its
// own school year; requesting a LATER year reads the Treasurer's "Fall
// Deposit (Next Year)" working column (F). Self-describing via the
// workbook's year tab — no per-year hardcoding to update at handover.
function billingColumnsFor(schoolYear, tabs) {
  var sheetYear = billingSheetYear(tabs || {});
  if (!sheetYear) {
    // Workbook has no year-named register tab — the legacy 25-26 shape.
    // Preserve the old hardcoded rule (26/27 deposits live in its "Fall
    // Deposit (Next Year)" column) so this code is safe to deploy while
    // the old workbook is still the linked BILLING_SHEET_ID. Without
    // this, a 2026-2027 read of the old workbook would pull LAST year's
    // col-B paid marks and auto-mark-paid (+email) the wrong families.
    if (schoolYear === '2026-2027') {
      return { fallDeposit: 5, fallClassFee: -1, springDeposit: -1, springClassFee: -1 };
    }
    return { fallDeposit: 1, fallClassFee: 2, springDeposit: 3, springClassFee: 4 };
  }
  if (String(schoolYear) > sheetYear) {
    return { fallDeposit: 5, fallClassFee: -1, springDeposit: -1, springClassFee: -1 };
  }
  return { fallDeposit: 1, fallClassFee: 2, springDeposit: 3, springClassFee: 4 };
}

function parseBillingSheet(tabs, schoolYear) {
  var out = {
    rates: {
      fall: { amRate: 0, pmRate: 0 },
      spring: { amRate: 0, pmRate: 0 }
    },
    families: {}
  };

  // Label-driven rate scan, with the legacy bare-H2/H3 read as fallback
  // (the 25-26 workbook had no label cells).
  var amTab = tabs['Morning Classes'] || [];
  out.rates.fall.amRate = rateFromTab(amTab, 1) || (amTab[1] ? numFromCell(amTab[1][7]) : 0);
  out.rates.spring.amRate = rateFromTab(amTab, 2) || (amTab[2] ? numFromCell(amTab[2][7]) : 0);

  var pmTab = tabs['Afternoons'] || [];
  out.rates.fall.pmRate = rateFromTab(pmTab, 1) || (pmTab[1] ? numFromCell(pmTab[1][7]) : 0);
  out.rates.spring.pmRate = rateFromTab(pmTab, 2) || (pmTab[2] ? numFromCell(pmTab[2][7]) : 0);

  var cols = billingColumnsFor(schoolYear, tabs);
  var payTab = tabs['Family Payment Tracking'] || [];
  for (var r = 1; r < payTab.length; r++) {
    var row = payTab[r];
    if (!row) continue;
    var famName = cell(row, 0);
    if (!famName) continue;
    function statusOf(v) {
      return /paid/i.test(String(v || '').trim()) ? 'Paid' : '';
    }
    out.families[famName.toLowerCase()] = {
      name: famName,
      fall: {
        deposit: statusOf(cell(row, cols.fallDeposit)),
        classFee: statusOf(cell(row, cols.fallClassFee))
      },
      spring: {
        deposit: statusOf(cell(row, cols.springDeposit)),
        classFee: statusOf(cell(row, cols.springClassFee))
      }
    };
  }

  return out;
}

// Active school year flips on April 1 — matches activeSchoolYear() in
// script.js so server defaults agree with the client default.
function activeSchoolYearLabel(now) {
  now = now || new Date();
  var fallYear = (now.getMonth() < 3) ? now.getFullYear() - 1 : now.getFullYear();
  return fallYear + '-' + (fallYear + 1);
}

async function handleBillingGet(req, res, sheets) {
  var billingSheetId = process.env.BILLING_SHEET_ID;
  if (!billingSheetId) {
    return res.status(200).json({
      error: 'BILLING_SHEET_ID not configured',
      rates: { fall: {}, spring: {} },
      families: {}
    });
  }

  var billingTabs;
  try {
    billingTabs = await fetchSheet(sheets, billingSheetId);
  } catch (e) {
    console.error('Billing sheet fetch failed:', e.message);
    return res.status(502).json({ error: 'Failed to fetch billing sheet' });
  }

  var schoolYear = String(req.query.school_year || activeSchoolYearLabel());
  var parsed = parseBillingSheet(billingTabs, schoolYear);

  // Attach family_email to each sheet entry by joining against
  // member_profiles (LOWER(family_name) match). The frontend prefers email
  // over name when matching billingStatus to fam, so a compound surname
  // ("O'Connor Gading") resolves cleanly even when the sheet still has the
  // last-word form ("Gading").
  try {
    var sql = getDb();
    var profiles = await sql`SELECT family_email, family_name FROM member_profiles`;
    var nameToEmail = {};
    profiles.forEach(function (p) {
      var nm = String(p.family_name || '').toLowerCase();
      if (nm) nameToEmail[nm] = String(p.family_email || '');
    });
    Object.keys(parsed.families).forEach(function (k) {
      var hit = nameToEmail[k];
      if (hit) parsed.families[k].email = hit;
    });

    // Overlay DB payment records on top of the sheet. Sheet still wins for
    // anything it explicitly marks Paid; DB Paid records (mostly from the
    // registration auto-write) light up cells the sheet hasn't touched yet,
    // and DB Pending records show "Pending" until the Treasurer confirms.
    // Scoped to the requested school_year so prior years' Paid markers
    // don't bleed into the current view.
    var dbRows = await sql`
      SELECT family_name, family_email, semester_key, payment_type, status
      FROM payments
      WHERE school_year = ${schoolYear}
        AND status IN ('Pending', 'Paid')
    `;
    dbRows.forEach(function (p) {
      var emailKey = String(p.family_email || '').toLowerCase();
      var nameKey = String(p.family_name || '').toLowerCase();

      // Find the entry by email match first (canonical), then by name.
      var fam = null;
      if (emailKey) {
        for (var k in parsed.families) {
          if (String(parsed.families[k].email || '').toLowerCase() === emailKey) {
            fam = parsed.families[k];
            break;
          }
        }
      }
      if (!fam && nameKey) {
        fam = parsed.families[nameKey] || null;
      }
      if (!fam) {
        // No sheet row for this family yet — create one keyed by email
        // when available so subsequent DB rows for the same family
        // collapse onto it.
        var newKey = emailKey || nameKey;
        if (!newKey) return;
        fam = {
          name: p.family_name || '',
          email: emailKey,
          fall: { deposit: '', classFee: '' },
          spring: { deposit: '', classFee: '' }
        };
        parsed.families[newKey] = fam;
      } else if (emailKey && !fam.email) {
        fam.email = emailKey;
      }

      var sem = fam[p.semester_key];
      if (!sem) return;
      var field = p.payment_type === 'deposit' ? 'deposit' : 'classFee';
      // Sheet Paid wins. DB Paid promotes empty/Due/Pending → Paid. DB
      // Pending only promotes empty/Due → Pending.
      if (sem[field] === 'Paid') return;
      if (p.status === 'Paid') sem[field] = 'Paid';
      else if (sem[field] !== 'Paid') sem[field] = 'Pending';
    });
  } catch (e) {
    console.error('Billing DB overlay failed:', e.message);
    // fall through with sheet-only data
  }

  return res.status(200).json(parsed);
}

async function handleBillingPost(req, res, authResult) {
  var body = req.body || {};
  var familyName = String(body.family_name || '').trim();
  var familyEmail = String(body.family_email || '').trim().toLowerCase();
  var semesterKey = String(body.semester_key || '').trim();
  var paymentType = String(body.payment_type || '').trim();
  var schoolYear = String(body.school_year || activeSchoolYearLabel()).trim();
  var paypalId = String(body.paypal_transaction_id || '').trim();
  var amountCents = parseInt(body.amount_cents, 10) || 0;
  var payerEmail = String(body.payer_email || '').trim();

  if (!familyName && !familyEmail) {
    return res.status(400).json({ error: 'family_name or family_email required' });
  }
  if (semesterKey !== 'fall' && semesterKey !== 'spring') {
    return res.status(400).json({ error: "semester_key must be 'fall' or 'spring'" });
  }
  if (paymentType !== 'deposit' && paymentType !== 'class_fee') {
    return res.status(400).json({ error: "payment_type must be 'deposit' or 'class_fee'" });
  }

  try {
    var sql = getDb();
    // Ownership gate (2026-07-17 review): billing rows used to accept any
    // family_email from any member, letting anyone pollute the Treasurer's
    // reconcile view with fabricated Pending payments. Only your own family
    // (or a super user recording on their behalf) may post.
    var billingActor = authResult && authResult.email ? authResult.email : '';
    if (!billingActor) return res.status(401).json({ error: 'Unauthorized' });
    if (familyEmail && !isSuperUser(billingActor) && !(await canActAs(sql, billingActor, familyEmail))) {
      return res.status(403).json({ error: 'You can only record a payment for your own family.' });
    }
    var rows = await sql`
      INSERT INTO payments (
        family_name, family_email, semester_key, payment_type, school_year,
        paypal_transaction_id, amount_cents, payer_email, status
      )
      VALUES (
        ${familyName}, ${familyEmail}, ${semesterKey}, ${paymentType}, ${schoolYear},
        ${paypalId}, ${amountCents}, ${payerEmail}, 'Pending'
      )
      RETURNING id, created_at
    `;
    return res.status(200).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('Billing POST failed:', e.message);
    return res.status(500).json({ error: 'Failed to save pending payment' });
  }
}

// ══════════════════════════════════════════════
// MEMBER PROFILE OVERLAY
// ══════════════════════════════════════════════
// member_profiles stores family-level metadata (phone, address, display
// name); the normalized people + kids tables hold the per-person rows.
// This overlay sets fam.people[] (replaces the legacy fam.parentInfo[] +
// fam.parents string) and merges per-kid DB fields onto the sheet's
// classlist-derived kids.
//
// fam.people[] shape — this is the contract the frontend relies on:
//   { email, family_email, first_name, last_name, role,
//     personal_email, phone, pronouns, photo_url, photo_consent,
//     nicknames: [string] }
// ordered by sort_order (mlc first, then blc, then other parents).

// Convert a snake_case people row from Postgres into the camelCase-friendly
// shape the client expects. Keeps photo_consent / photo_url / personal_email
// in snake_case because the frontend save payload uses snake_case (matches
// the EMI form field names) — readability over consistency here.
// Normalize a birth_date to 'YYYY-MM-DD'. The driver may hand back a Date
// object (DATE columns) or an ISO string; a raw Date leaks into the client
// as a full ISO timestamp, which a <input type="date"> rejects — it renders
// EMPTY and the next EMI save silently wipes the birthday. Local date parts
// (not toISOString) so a UTC server doesn't shift the day.
function isoDay(v) {
  if (!v) return '';
  if (v instanceof Date) {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  return String(v).slice(0, 10);
}

function shapePersonRow(r) {
  return {
    id:             r.id || null,
    email:          String(r.email || '').toLowerCase(),
    family_email:   String(r.family_email || '').toLowerCase(),
    first_name:     r.first_name || '',
    last_name:      r.last_name || '',
    nickname:       r.nickname || '',
    role:           r.role || 'parent',
    personal_email: r.personal_email || '',
    phone:          r.phone || '',
    pronouns:       r.pronouns || '',
    photo_url:      r.photo_url || '',
    photo_consent:  r.photo_consent !== false,
    nicknames:      Array.isArray(r.nicknames) ? r.nicknames : [],
    // Adult allergies/medical notes (Erin, 2026-07-20) — same field kids
    // have, member-visible in EMI + the directory.
    allergies:      r.allergies || '',
    // BLC portal sign-in request state (Erin, 2026-07-20) — drives the
    // "Request R&W sign-in" button / "requested" chip on the EMI BLC row.
    rw_email_requested: !!r.rw_email_requested_at
  };
}

async function applyMemberProfileOverlay(families) {
  if (!Array.isArray(families) || families.length === 0) return;
  var sql = getDb();
  var rows = await sql`
    SELECT family_email, family_name, phone, address,
           placement_notes, additional_emails
    FROM member_profiles
  `;
  // Family-level overlay still works even when there are no DB rows (we
  // synthesize fam.people from the sheet below in that case).
  var familyByEmail = {};
  (rows || []).forEach(function (r) {
    if (r.family_email) familyByEmail[String(r.family_email).toLowerCase()] = r;
  });

  // Single round-trip per table; group in JS rather than N queries.
  var peopleRows = await sql`
    SELECT id, email, family_email, first_name, last_name, nickname, role,
           personal_email, phone, pronouns, photo_url, photo_consent,
           nicknames, allergies, sort_order, rw_email_requested_at
    FROM people
    ORDER BY family_email, sort_order, email
  `;
  var peopleByFamily = {};
  (peopleRows || []).forEach(function (pr) {
    var k = String(pr.family_email || '').toLowerCase();
    if (!peopleByFamily[k]) peopleByFamily[k] = [];
    peopleByFamily[k].push(shapePersonRow(pr));
  });

  var kidsRows = await sql`
    SELECT id, family_email, first_name, last_name, nickname, birth_date,
           pronouns, allergies, schedule, photo_url, photo_consent,
           sort_order
    FROM kids
    ORDER BY family_email, sort_order, id
  `;
  var kidsByFamily = {};
  (kidsRows || []).forEach(function (kr) {
    var k = String(kr.family_email || '').toLowerCase();
    if (!kidsByFamily[k]) kidsByFamily[k] = [];
    kidsByFamily[k].push(kr);
  });
  var overlayKidFlags = await kidEnrollmentFlags(sql);

  families.forEach(function (fam) {
    var key = String(fam.email || '').toLowerCase();
    var p = familyByEmail[key];
    var dbPeople = peopleByFamily[key] || [];
    var dbKids = kidsByFamily[key] || [];

    if (p) {
      if (p.phone) fam.phone = p.phone;
      if (p.address) fam.address = p.address;
      if (p.placement_notes) fam.placementNotes = p.placement_notes;
      // Display name: surface the DB-stored family_name when it differs from
      // the sheet-parsed last word (e.g. compound surnames like "O'Connor
      // Gading"). Kept separate from fam.name so existing classlist + last-
      // initial lookups (which expect the parsed single-word value) keep
      // working until those callers migrate.
      if (p.family_name && p.family_name !== fam.name) {
        fam.displayName = p.family_name;
      }
    }

    // ── People ──
    // Authoritative source is the people table. If the DB has rows, they
    // win wholesale (parentInfo + the legacy fam.parents string stay only
    // as compatibility shims for participation/internal flows).
    if (dbPeople.length > 0) {
      fam.people = dbPeople;
    } else if (Array.isArray(fam.people) && fam.people.length > 0) {
      // Already populated upstream (e.g. dev-mode loadFamiliesFromProfiles)
      // — keep as-is.
    } else {
      // Sheet-only family with no DB row: synthesize fam.people from the
      // legacy fam.parents string so the frontend has SOMETHING to render.
      // No emails available → use the family_email for the [0] slot, so
      // the MLC at least has a login identity.
      var sheetFirsts = String(fam.parents || '')
        .split(/\s*&\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
      fam.people = sheetFirsts.map(function (n, idx) {
        var parts = String(n).trim().split(/\s+/);
        var first = parts[0] || '';
        var last = parts.length > 1 ? parts.slice(1).join(' ') : '';
        return {
          email: idx === 0 ? String(fam.email || '').toLowerCase() : '',
          family_email: String(fam.email || '').toLowerCase(),
          first_name: first,
          last_name: last,
          role: idx === 0 ? 'mlc' : idx === 1 ? 'blc' : 'parent',
          personal_email: '',
          phone: '',
          pronouns: (fam.parentPronouns && fam.parentPronouns[n]) || '',
          photo_url: '',
          photo_consent: true,
          nickname: '',
          nicknames: []
        };
      });
    }

    // Compatibility shims — the participation report and a few legacy
    // sheet helpers still expect fam.parents (first-names string) and
    // fam.parentInfo (camelCase). The frontend has been migrated off both.
    // Synthesize from fam.people so they stay consistent.
    fam.parents = fam.people.map(function (pp) { return pp.first_name; }).filter(Boolean).join(' & ');
    fam.parentInfo = fam.people.map(function (pp) {
      return {
        name: ((pp.first_name || '') + ' ' + (pp.last_name || '')).trim(),
        firstName: pp.first_name,
        lastName: pp.last_name,
        nickname: pp.nickname || '',
        pronouns: pp.pronouns,
        photoUrl: pp.photo_url,
        photoConsent: pp.photo_consent !== false,
        role: pp.role,
        email: pp.email,
        personalEmail: pp.personal_email,
        phone: pp.phone,
        nicknames: pp.nicknames,
        allergies: pp.allergies || ''
      };
    });

    // Phase 3 co-parent login surface. Now derived from people.email +
    // member_profiles.additional_emails (the latter kept for back-compat
    // with rows that haven't been backfilled into people yet).
    var primary = String(fam.email || '').toLowerCase();
    var seen = primary ? { [primary]: true } : {};
    var loginEmails = primary ? [primary] : [];
    fam.people.forEach(function (pp) {
      var lc = String(pp.email || '').toLowerCase();
      if (lc && !seen[lc]) { seen[lc] = true; loginEmails.push(lc); }
    });
    var addl = (p && Array.isArray(p.additional_emails)) ? p.additional_emails : [];
    addl.forEach(function (ae) {
      var lc = String(ae || '').toLowerCase();
      if (lc && !seen[lc]) { seen[lc] = true; loginEmails.push(lc); }
    });
    fam.loginEmails = loginEmails;

    // ── Kids ──
    // Match DB kid rows onto sheet-parsed fam.kids by first name
    // (case-insensitive). DB wins for non-empty fields. DB-only kids
    // (no matching sheet entry) get appended.
    var kMap = {};
    dbKids.forEach(function (k) {
      if (k && k.first_name) {
        kMap[String(k.first_name).trim().toLowerCase()] = k;
      }
    });
    (fam.kids || []).forEach(function (kid) {
      var first = String(kid.name || '').trim().split(/\s+/)[0].toLowerCase();
      var ov = kMap[first];
      if (!ov) return;
      if (ov.pronouns) kid.pronouns = ov.pronouns;
      if (ov.allergies) kid.allergies = ov.allergies;
      if (ov.birth_date) kid.birthDate = isoDay(ov.birth_date);
      if (ov.schedule) kid.schedule = ov.schedule;
      if (ov.photo_url) kid.photoUrl = ov.photo_url;
      if (ov.last_name) kid.lastName = ov.last_name;
      if (ov.nickname) kid.nickname = ov.nickname;
      kid.photo_consent = ov.photo_consent !== false;
      // DB row id → Edit My Info → save upserts by id (enrollment build).
      if (ov.id) {
        kid.id = ov.id;
        kid.pending_approval = overlayKidFlags.pending.has(ov.id);
        kid.not_returning = overlayKidFlags.notReturning.has(ov.id);
      }
    });
    // DB-only kids (not in the sheet's classlist).
    dbKids.forEach(function (k) {
      if (!k || !k.first_name) return;
      var first = String(k.first_name).trim();
      var exists = (fam.kids || []).some(function (x) {
        return String(x.name || '').trim().toLowerCase() === first.toLowerCase();
      });
      if (!exists) {
        fam.kids = fam.kids || [];
        fam.kids.push({
          id: k.id || null,
          pending_approval: overlayKidFlags.pending.has(k.id),
          not_returning: overlayKidFlags.notReturning.has(k.id),
          name: first,
          lastName: k.last_name || '',
          nickname: k.nickname || '',
          group: '',
          schedule: k.schedule || 'all-day',
          pronouns: k.pronouns || '',
          allergies: k.allergies || '',
          birthDate: isoDay(k.birth_date),
          photoUrl: k.photo_url || '',
          photo_consent: k.photo_consent !== false
        });
      }
    });
  });

  // ── Board roles from role_holders_v2 ──
  // Surface fam.boardRole + fam.boardEmail from the new role_holders_v2
  // table so dev environments (where the master sheet's Volunteer
  // Committees tab is skipped) and any future sheet-free path get the
  // right board cards in My Workspace + the right "Board Member" duty
  // in My Responsibilities.
  //
  // Match strategy is family_email-only (per feedback_rw_family_identity
  // — names drift silently). A holder's family_email is whichever of
  // these matches the rhv.person_email through the people join:
  //   - dev seed: role inbox IS the family_email (membership@ etc.)
  //   - prod: holder's personal Workspace email maps to their family
  //     via people.family_email
  // We never fall back to family_name matching — it produced duplicate
  // assignments in dev (two "Family" families both claiming VP).
  try {
    // Scope to the most recent school_year that has board rows — same
    // resolution handleBoardScope (api/photos.js) uses for the public
    // site, so directory/workspace/responsibilities stay in sync with
    // what the homepage advertises. Without this, transitioning to next
    // year's board (rows for both 2025-2026 AND 2026-2027 exist
    // simultaneously) tags BOTH old and new holders as board members.
    var byrRows = await sql`SELECT MAX(school_year) AS sy FROM role_holders_v2`;
    var boardSchoolYear = byrRows[0] && byrRows[0].sy;
    var boardRows = boardSchoolYear ? await sql`
      SELECT rhv.person_email AS email,
             p.family_email AS holder_family_email,
             r.title
      FROM role_holders_v2 rhv
      JOIN roles r ON r.id = rhv.role_id
      LEFT JOIN people p ON LOWER(p.email) = LOWER(rhv.person_email)
      WHERE r.status = 'active'
        AND rhv.ended_at IS NULL
        AND rhv.school_year = ${boardSchoolYear}
        AND r.title ~* '(President|Treasurer|Secretary|Director|Class Liaison|Vice)'
    ` : [];
    var BOARD_TITLE_NORMALIZE = {
      'Vice-President': 'Vice President',
      'Membership Dir.': 'Membership Director',
      'Sustaining Dir.': 'Sustaining Director',
      'Communications Dir.': 'Communications Director'
    };
    families.forEach(function (fam) {
      var hit = null;
      var famEmailLc = String(fam.email || '').toLowerCase();
      if (!famEmailLc) return;
      for (var bi = 0; bi < boardRows.length; bi++) {
        var br = boardRows[bi];
        var brEmailLc = String(br.email || '').toLowerCase();
        var brFamEmailLc = String(br.holder_family_email || '').toLowerCase();
        // Prefer direct holder-email match (dev seed: role inbox =
        // family_email). Otherwise match the holder's family_email
        // (prod: personal Workspace email maps to family inbox).
        if (brEmailLc === famEmailLc || brFamEmailLc === famEmailLc) {
          hit = br;
          break;
        }
      }
      if (hit) {
        var title = BOARD_TITLE_NORMALIZE[hit.title] || hit.title;
        fam.boardRole = title;
        fam.boardEmail = String(hit.email || '').toLowerCase() || fam.boardEmail || null;
      }
    });
  } catch (boardErr) {
    console.warn('[overlay] role_holders lookup failed (non-fatal):', boardErr.message);
  }

  // ── Committee role holders from role_holders_v2 ──
  // Mirror the board pattern above but for committee_role entries (e.g.
  // Merchandise Manager, Welcome Coordinator). Returns a flat map keyed
  // by lowercase email → array of role titles, so the client's
  // getWorkspaceRoles can resolve per-person assignments without having
  // to dip into the legacy Google Sheets "Volunteer Committees" tab.
  // Same MAX(school_year) scoping so we stay aligned with handleBoardScope.
  // Returned to the caller; caller is responsible for attaching to the
  // outer response object (since JSON.stringify ignores non-index
  // properties on the families array).
  var committeeRoleHolders = {};
  try {
    var cryRows = await sql`SELECT MAX(school_year) AS sy FROM role_holders_v2`;
    var commSchoolYear = cryRows[0] && cryRows[0].sy;
    if (commSchoolYear) {
      var commRows = await sql`
        SELECT LOWER(rhv.person_email) AS email, r.title
        FROM role_holders_v2 rhv
        JOIN roles r ON r.id = rhv.role_id
        WHERE r.category = 'committee_role'
          AND r.status = 'active'
          AND rhv.school_year = ${commSchoolYear}
          AND rhv.ended_at IS NULL
      `;
      commRows.forEach(function (r) {
        if (!committeeRoleHolders[r.email]) committeeRoleHolders[r.email] = [];
        if (committeeRoleHolders[r.email].indexOf(r.title) === -1) {
          committeeRoleHolders[r.email].push(r.title);
        }
      });
    }
  } catch (commErr) {
    console.warn('[overlay] committee role lookup failed (non-fatal):', commErr.message);
  }
  return { committeeRoleHolders: committeeRoleHolders };
}

// ══════════════════════════════════════════════
// PARTICIPATION TRACKING
// ══════════════════════════════════════════════
// Report surface for VP + Afternoon Class Liaison. Counts every
// session-slot a member fills across AM classes, PM electives, cleaning
// crew, special events, board/volunteer roles, and AM class liaisons,
// then applies admin-editable weights + exemptions + new-member grace.
// Coverage Given is reported separately without a weight so the "assigned
// responsibility" score can't be gamed by swapping slots.

// Both gates route through the Permissions admin table (capabilities
// 'participation_view' / 'participation_edit', defaults VP + Afternoon
// Class Liaison). Super user keeps its longstanding shortcut here.
async function participationCanRead(email) {
  if (!email) return false;
  if (isSuperUser(email)) return true;
  return await hasCapability(email, 'participation_view');
}

async function participationCanWrite(email) {
  if (!email) return false;
  if (isSuperUser(email)) return true;
  return await hasCapability(email, 'participation_edit');
}

function participationNormName(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // strip pronouns
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Common-nickname groups for participation name resolution. Each group
// is bidirectional — any name in the group counts as any other when
// matching the master sheet's volunteer entries against member_profiles.
// Per-person nicknames stored in member_profiles.parents[].nicknames are
// merged on top, so anything not in this hardcoded list can be handled
// via Edit My Info.
var NICKNAME_GROUPS = [
  ['rebecca', 'becca', 'becky'],
  ['jessica', 'jess', 'jessie'],
  ['matthew', 'matt', 'matty'],
  ['michael', 'mike', 'mikey'],
  ['william', 'will', 'bill', 'billy'],
  ['robert', 'rob', 'bob', 'bobby'],
  ['thomas', 'tom', 'tommy'],
  ['joseph', 'joe', 'joey'],
  ['joshua', 'josh'],
  ['benjamin', 'ben', 'benny'],
  ['catherine', 'cathy', 'kate', 'katie'],
  ['katherine', 'kate', 'katie', 'kathy'],
  ['elizabeth', 'liz', 'beth', 'betsy', 'eliza'],
  ['samantha', 'sam', 'sammy'],
  ['samuel', 'sam', 'sammy'],
  ['nicholas', 'nick', 'nicky'],
  ['daniel', 'dan', 'danny'],
  ['christopher', 'chris', 'topher'],
  ['anthony', 'tony'],
  ['gregory', 'greg'],
  ['jonathan', 'jon', 'jonny'],
  ['andrew', 'andy', 'drew'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['richard', 'rick', 'ricky', 'rich'],
  ['stephanie', 'steph'],
  ['stephen', 'steve'],
  ['steven', 'steve'],
  ['tiffany', 'tiff'],
  ['patricia', 'pat', 'patty', 'tricia'],
  ['frederick', 'fred', 'freddy'],
  ['theodore', 'theo', 'ted'],
  ['alexander', 'alex'],
  ['alexandra', 'alex', 'allie'],
  ['nathaniel', 'nate', 'nathan'],
  ['jennifer', 'jen', 'jenny']
];
var NICKNAME_LOOKUP = (function () {
  var out = {};
  NICKNAME_GROUPS.forEach(function (group) {
    group.forEach(function (name) {
      // A name like "sam" lives in two groups (samantha, samuel). Merge
      // groups so both sets of aliases resolve from the same key.
      if (!out[name]) out[name] = [];
      group.forEach(function (other) {
        if (out[name].indexOf(other) === -1) out[name].push(other);
      });
    });
  });
  return out;
})();
function aliasesFor(firstLc) {
  return NICKNAME_LOOKUP[firstLc] || [firstLc];
}

function participationCurrentSeason() {
  // Fallback heuristic only (used when the session calendar is unavailable).
  // The real boundary is Field Day — see participationResolveSeason below.
  // School year runs Aug–May; anything before August rolls back a year.
  var now = new Date();
  var y = now.getFullYear();
  var start = now.getMonth() >= 7 ? y : y - 1; // month 7 = Aug
  var end = start + 1;
  return String(start).slice(2) + '_' + String(end).slice(2);
}

function participationYearBounds(season) {
  // `season` is the short 'YY_YY' form; defaults to the month heuristic.
  season = season || participationCurrentSeason();
  var startYear = 2000 + parseInt(season.slice(0, 2), 10);
  return {
    start: new Date(startYear, 7, 1),       // Aug 1
    end: new Date(startYear + 1, 4, 31)     // May 31
  };
}

// UTC-safe date helpers for the Field-Day season math (mirror api/tour.js's
// calAddDays / calSnapWed so participation and the Board Calendar agree).
function participationAddDays(dateStr, n) {
  var d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Nearest Wednesday strictly after a YYYY-MM-DD date (Field Day = the Wednesday
// after the last session ends; never lands on the same day).
function participationSnapWedAfter(dateStr) {
  var d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 3);
  return d.toISOString().slice(0, 10);
}

// Pure resolver: given the co-op sessions ([{school_year, end_date}]) and today
// (YYYY-MM-DD), return the current participation season by the Field-Day
// boundary — the school year flips the DAY AFTER Field Day (rw-school-year-
// boundary), not on a fixed calendar month. Returns
//   { seasonLabel:'2026-2027', seasonShort:'26_27', seasonStart:'2026-05-21' }
// or null when there are no sessions to anchor the math (caller falls back to
// the month heuristic). `seasonStart` = the day after the PREVIOUS season's
// Field Day; used to scope year-agnostic tables (cleaning/coverage/absences) to
// the current year. It is '' when the previous year's sessions aren't known, in
// which case callers simply skip date-scoping (no regression).
function participationResolveSeason(sessions, todayStr) {
  var latestEnd = {};
  (sessions || []).forEach(function (s) {
    var yr = String(s.school_year || '');
    if (!/^\d{4}-\d{4}$/.test(yr)) return;
    var end = String(s.end_date || '').slice(0, 10);
    if (!end) return;
    if (!latestEnd[yr] || end > latestEnd[yr]) latestEnd[yr] = end;
  });
  var years = Object.keys(latestEnd).sort(); // ascending
  if (!years.length) return null;
  var fd = {};
  years.forEach(function (yr) { fd[yr] = participationSnapWedAfter(latestEnd[yr]); });
  // Current season = the smallest year whose Field Day is today-or-later; if
  // today is past every known Field Day we're into the year AFTER the latest.
  var curYear = null;
  for (var i = 0; i < years.length; i++) {
    if (fd[years[i]] && todayStr <= fd[years[i]]) { curYear = years[i]; break; }
  }
  var startY, prevYearLabel;
  if (curYear) {
    startY = parseInt(curYear.slice(0, 4), 10);
    prevYearLabel = (startY - 1) + '-' + startY;
  } else {
    var last = years[years.length - 1];
    startY = parseInt(last.slice(0, 4), 10) + 1;
    prevYearLabel = last; // the latest known year is the season we just left
  }
  return {
    seasonLabel: startY + '-' + (startY + 1),
    seasonShort: String(startY).slice(2) + '_' + String(startY + 1).slice(2),
    seasonStart: fd[prevYearLabel] ? participationAddDays(fd[prevYearLabel], 1) : ''
  };
}

// Async wrapper: read co_op_sessions and resolve the season. Falls back to the
// month heuristic (no date-scoping) if the table is empty or unavailable.
async function participationSeasonInfo(sql) {
  var fallback = {
    seasonShort: participationCurrentSeason(),
    seasonLabel: seasonToYearLabel(participationCurrentSeason()),
    seasonStart: ''
  };
  try {
    var rows = await sql`SELECT school_year, end_date FROM co_op_sessions WHERE end_date IS NOT NULL`;
    var sessions = (rows || []).map(function (r) {
      return {
        school_year: r.school_year,
        end_date: (r.end_date instanceof Date)
          ? r.end_date.toISOString().slice(0, 10)
          : String(r.end_date).slice(0, 10)
      };
    });
    var todayStr = new Date().toISOString().slice(0, 10);
    return participationResolveSeason(sessions, todayStr) || fallback;
  } catch (e) {
    console.error('participationSeasonInfo failed:', e.message);
    return fallback;
  }
}

// Normalize a school-year/season string to the long '2025-2026' form.
// Two formats coexist: participationCurrentSeason() produces '25_26'
// while register.html writes season '2026-2027' into registrations.
// Returns '' for anything unrecognizable so callers fail safe.
function seasonToYearLabel(season) {
  var s = String(season || '').trim();
  var long = /^(\d{4})-(\d{4})$/.exec(s);
  if (long) return s;
  var short = /^(\d{2})_(\d{2})$/.exec(s);
  if (short) return '20' + short[1] + '-20' + short[2];
  return '';
}

function nextYearLabel(label) {
  var m = /^(\d{4})-(\d{4})$/.exec(label || '');
  if (!m) return '';
  return (parseInt(m[1], 10) + 1) + '-' + (parseInt(m[2], 10) + 1);
}

// Pure core of firstSeasonByEmail — exported for unit tests.
//
// Maps each family to the FIRST FULL school year of their membership
// ('2026-2027' form). "New member" = that year hasn't completed yet; the
// same rule drives the Directory's First Year badge and the participation
// report's reduced points expectation, per Membership's definition: a
// family counts as new until they have completed a full co-op year, and
// members can sign up any time. So the family's earliest registration
// (by created_at) decides:
//   - registered on/before Sept 1 of the season's start year → that
//     season is their first full year;
//   - registered after (mid-year join) → their first full year is the
//     NEXT season;
//   - earliest registration declared existing_family_name → pre-portal
//     family re-registering, returning not new → omitted entirely.
//
// Each family's label is emitted under EVERY identity seen on its rows:
// the raw registration email (personal), the STORED family_email column
// (authoritative — stamped at registration since 2026-07-17), AND the
// re-derived Workspace family email. The stored column matters (bug log
// #10): registration derives the family email from the SPLIT first/last
// fields ("Erin" + "Testing Account" → erint@…) while re-derivation here
// only has main_learning_coach ("Erin Testing Account" → last word
// "Account" → erina@…), so a fresh family's member_profiles key was
// unreachable and they rendered dimmed / badge-less. Callers join on
// whichever identity they hold (family-identity-by-email rule).
function firstSeasonFromRows(rows) {
  // Lazy require: tour.js requires sheets.js at module load, so a
  // top-level require here would create a cycle and import {}.
  var tour = require('./tour.js');
  var groups = {}; // canonical family key → { keys:{}, earliest }
  (rows || []).forEach(function (r) {
    var label = seasonToYearLabel(r.season);
    if (!label) return;
    var rawEmail = String(r.email || '').toLowerCase().trim();
    var storedFam = String(r.family_email || '').toLowerCase().trim();
    var famName = tour.deriveFamilyName(r.main_learning_coach, r.existing_family_name);
    var famEmail = String(tour.deriveFamilyEmail(r.main_learning_coach, famName) || '').toLowerCase();
    // Grouping stays on the derived/raw key so pre-column rows (stored
    // family_email='') keep collapsing into the same family group; the
    // stored email joins the emitted KEYS below.
    var groupKey = famEmail || rawEmail || storedFam;
    if (!groupKey) return;

    // Mid-year join: registered after the season already started → the
    // next season is the first one they're present for in full.
    var createdIso = '';
    if (r.created_at) {
      try { createdIso = new Date(r.created_at).toISOString().slice(0, 10); } catch (e) { /* keep '' */ }
    }
    var seasonStart = label.slice(0, 4) + '-09-01';
    var fullLabel = (createdIso && createdIso > seasonStart) ? nextYearLabel(label) : label;
    if (!fullLabel) return;

    if (!groups[groupKey]) groups[groupKey] = { keys: {}, earliest: null };
    var g = groups[groupKey];
    if (rawEmail) g.keys[rawEmail] = true;
    if (storedFam) g.keys[storedFam] = true;
    if (famEmail) g.keys[famEmail] = true;
    var sortKey = (createdIso || '9999-99-99') + '|' + label;
    if (!g.earliest || sortKey < g.earliest.sortKey) {
      g.earliest = {
        sortKey: sortKey,
        fullLabel: fullLabel,
        wasExisting: String(r.existing_family_name || '').trim() !== ''
      };
    }
  });

  var out = {};
  Object.keys(groups).forEach(function (gk) {
    var g = groups[gk];
    if (!g.earliest || g.earliest.wasExisting) return;
    Object.keys(g.keys).forEach(function (k) { out[k] = g.earliest.fullLabel; });
  });
  return out;
}

// DB wrapper — returns {} on query failure so callers degrade gracefully
// (no indicator, no reduced expectation).
async function firstSeasonByEmail(sql) {
  try {
    var regRows = await sql`
      SELECT email, season, created_at, main_learning_coach,
             existing_family_name, family_email
      FROM registrations
      WHERE declined_at IS NULL
    `;
    return firstSeasonFromRows(regRows);
  } catch (e) {
    console.error('Registrations first-season query failed:', e.message);
    return {};
  }
}

// Which families hold a live (non-declined) registration for the season
// currently open for registration (tour.js DEFAULT_SEASON) — drives the
// Directory's "hasn't re-enrolled" state (Erin, 2026-07-16). Any payment
// status counts (pending cash/check families ARE re-enrolled). Same
// multi-key emission as firstSeasonFromRows: the flag is reachable by the
// raw registration (personal) email, the STORED family_email column
// (authoritative, stamped at registration since 2026-07-17 — bug log #10:
// re-derivation from main_learning_coach alone can disagree with what
// registration actually stored, dimming a family who registered today),
// and the re-derived Workspace family email as fallback for legacy rows.
// {} on failure so the directory degrades to no indicator.

// Per-kid enrollment flags for the active season (enrollment build):
// pending = kid-add awaiting Membership approval (hidden from Directory;
// family's EMI only); notReturning = enrolled last year, not this one
// (stays LISTED in the Directory, marked — Erin's rule).
async function kidEnrollmentFlags(sql) {
  var tour = require('./tour.js'); // lazy: top-level require would cycle
  var out = { pending: new Set(), notReturning: new Set() };
  try {
    var rows = await sql`
      SELECT kid_id, status FROM kid_enrollments
      WHERE season = ${tour.DEFAULT_SEASON} AND status IN ('pending', 'not_returning')
    `;
    rows.forEach(function (r) {
      if (r.status === 'pending') out.pending.add(r.kid_id);
      else out.notReturning.add(r.kid_id);
    });
  } catch (e) { /* flags just don't render */ }
  return out;
}

async function registeredSeasonByEmail(sql) {
  var tour = require('./tour.js'); // lazy: top-level require would cycle
  try {
    var rows = await sql`
      SELECT email, main_learning_coach, existing_family_name, family_email
      FROM registrations
      WHERE declined_at IS NULL AND season = ${tour.DEFAULT_SEASON}
    `;
    var out = {};
    rows.forEach(function (r) {
      var rawEmail = String(r.email || '').toLowerCase().trim();
      var storedFam = String(r.family_email || '').toLowerCase().trim();
      var famName = tour.deriveFamilyName(r.main_learning_coach, r.existing_family_name);
      var famEmail = String(tour.deriveFamilyEmail(r.main_learning_coach, famName) || '').toLowerCase();
      if (rawEmail) out[rawEmail] = true;
      if (storedFam) out[storedFam] = true;
      if (famEmail) out[famEmail] = true;
    });
    return out;
  } catch (e) {
    console.error('Registrations current-season query failed:', e.message);
    return {};
  }
}

function participationBuildNameIndex(families) {
  var idx = {};
  // Build a per-parent nickname lookup keyed by canonical first name +
  // family. Pulled from fam.parentInfo[].nicknames (member_profiles edit)
  // when present, falling back to the hardcoded NICKNAME_LOOKUP. Lets the
  // master sheet's "Becca Smith" or just "Becca" resolve to the
  // member_profiles entry "Rebecca Smith".
  var perFamilyNicks = {};
  (families || []).forEach(function (fam) {
    var famName = String(fam.name || '').trim().toLowerCase();
    if (!famName) return;
    perFamilyNicks[famName] = perFamilyNicks[famName] || {};
    (fam.parentInfo || []).forEach(function (pi) {
      var first = String(pi.firstName || (pi.name || '').split(/\s+/)[0] || '').toLowerCase();
      if (!first) return;
      // The display nickname ("goes by") counts as a match variant too —
      // if someone displays as "Beth" the master sheet will likely say Beth.
      var custom = (pi.nicknames || [])
        .concat(pi.nickname ? [pi.nickname] : [])
        .map(function (n) { return String(n || '').trim().toLowerCase(); })
        .filter(Boolean);
      if (custom.length) perFamilyNicks[famName][first] = custom;
    });
  });

  (families || []).forEach(function (fam) {
    var famName = String(fam.name || '').trim();
    if (!famName) return;
    var famInitial = famName.charAt(0);
    var parentNames = String(fam.parents || '')
      .split(/\s*[&\/,]\s*/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    parentNames.forEach(function (first) {
      var firstLc = participationNormName(first);
      var canonical = participationNormName(first + ' ' + famName);
      idx[canonical] = canonical;
      idx[participationNormName(first + ' ' + famInitial)] = canonical;
      var fKey = '~first~' + firstLc;
      if (!idx[fKey]) idx[fKey] = [];
      if (idx[fKey].indexOf(canonical) === -1) idx[fKey].push(canonical);

      // Register every alias of this first name (hardcoded + per-person)
      // pointing to the same canonical entry, so "Becca Smith" matches
      // when the parent's stored name is "Rebecca".
      var aliases = aliasesFor(firstLc);
      var custom = (perFamilyNicks[famName.toLowerCase()] || {})[firstLc] || [];
      var allAliases = aliases.slice();
      custom.forEach(function (a) {
        if (allAliases.indexOf(a) === -1) allAliases.push(a);
      });
      allAliases.forEach(function (alias) {
        if (alias === firstLc) return;
        idx[participationNormName(alias + ' ' + famName)] = canonical;
        idx[participationNormName(alias + ' ' + famInitial)] = canonical;
        var aKey = '~first~' + alias;
        if (!idx[aKey]) idx[aKey] = [];
        if (idx[aKey].indexOf(canonical) === -1) idx[aKey].push(canonical);
      });
    });
  });
  return idx;
}

function participationResolveName(raw, idx) {
  var n = participationNormName(raw);
  if (!n) return null;
  if (idx[n] && typeof idx[n] === 'string') return idx[n];
  // Try single-word matches (first-name only) — only disambiguates when unique
  var parts = n.split(/\s+/);
  if (parts.length >= 1) {
    var firstKey = '~first~' + parts[0];
    var list = idx[firstKey];
    if (list && list.length === 1) return list[0];
  }
  return null;
}

function participationBlankCounts() {
  return {
    board_role: 0,
    one_year_role: 0,
    am_lead: 0,
    am_assist: 0,
    pm_lead: 0,
    pm_assist: 0,
    cleaning_session: 0,
    event_lead: 0,
    event_assist: 0
  };
}

// Build the families[] shape buildParticipationReport expects — name,
// parents string ("First & First"), email, plus a fam.people[] array — by
// joining member_profiles with the normalized people table.
//
// BLCs are excluded from the participation totals (they only step in for
// the MLC's absences, so they're not on the same expected-points baseline),
// but they ARE included in fam.people so the dev-mode dashboard render
// has the full roster. The fam.parents string + parentInfo[] (consumed by
// participationBuildNameIndex) only carry MLC + 'parent' rows.
async function loadFamiliesFromProfiles(sql) {
  // Pull families, people, and kids in parallel; group each by family.
  // The kids join is what lets us retire the Directory + Classlist
  // tabs: parseDirectory used to be the only source of kid age-group
  // assignments + AM/PM schedule, both now live on the kids table.
  var famRows = await sql`
    SELECT family_email, family_name, phone
    FROM member_profiles
    ORDER BY LOWER(family_name)
  `;
  var peopleRows = await sql`
    SELECT id, email, family_email, first_name, last_name, nickname, role,
           personal_email, phone, pronouns, photo_url, photo_consent,
           nicknames, allergies, sort_order, rw_email_requested_at
    FROM people
    ORDER BY family_email, sort_order, email
  `;
  var kidRows = await sql`
    SELECT id, family_email, first_name, last_name, nickname, birth_date, pronouns,
           allergies, schedule, class_group, photo_url, photo_consent, sort_order
    FROM kids
    ORDER BY family_email, sort_order, LOWER(first_name)
  `;
  var kidFlags = await kidEnrollmentFlags(sql);
  // First registration per family — drives the Directory's "new member"
  // indicator (family hasn't completed a full co-op year yet). The client
  // derives newness from firstSeason against the Field-Day year boundary.
  var regByEmail = await firstSeasonByEmail(sql);
  // Live registration for the season currently open — families without
  // one render dimmed in the Directory ("hasn't re-enrolled").
  var regCurrentByEmail = await registeredSeasonByEmail(sql);
  var byFamily = {};
  peopleRows.forEach(function (pr) {
    var k = String(pr.family_email || '').toLowerCase();
    if (!byFamily[k]) byFamily[k] = [];
    byFamily[k].push(shapePersonRow(pr));
  });
  var kidsByFamily = {};
  kidRows.forEach(function (kr) {
    var k = String(kr.family_email || '').toLowerCase();
    if (!kidsByFamily[k]) kidsByFamily[k] = [];
    kidsByFamily[k].push({
      id: kr.id || null, // → EMI → save upserts by id (enrollment build)
      pending_approval: kidFlags.pending.has(kr.id),
      not_returning: kidFlags.notReturning.has(kr.id),
      name: String(kr.first_name || '').trim(),
      lastName: String(kr.last_name || '').trim(),
      nickname: String(kr.nickname || ''),
      // Missing birthDate here is what wiped sibling birthdays on dev:
      // the EMI form seeded every kid's date input empty, so saving one
      // kid's edit re-inserted the others with NULL (2026-07-15).
      birthDate: isoDay(kr.birth_date),
      group: String(kr.class_group || ''),
      schedule: String(kr.schedule || 'all-day'),
      pronouns: String(kr.pronouns || ''),
      allergies: String(kr.allergies || ''),
      photo_consent: kr.photo_consent !== false,
      photoUrl: String(kr.photo_url || '')
    });
  });

  return famRows.map(function (r) {
    var key = String(r.family_email || '').toLowerCase();
    var people = byFamily[key] || [];
    var kids = kidsByFamily[key] || [];

    var firstNames = [];
    var parentInfo = [];
    people.forEach(function (pp) {
      if (pp.role === 'blc') return; // skip BLCs from participation index
      var fn = String(pp.first_name || '').trim();
      if (!fn) return;
      firstNames.push(fn);
      parentInfo.push({
        name: ((pp.first_name || '') + ' ' + (pp.last_name || '')).trim(),
        firstName: fn,
        lastName: pp.last_name || '',
        nickname: pp.nickname || '',
        nicknames: pp.nicknames || []
      });
    });
    return {
      name: String(r.family_name || '').trim(),
      parents: firstNames.join(' & '),
      email: String(r.family_email || '').toLowerCase(),
      phone: String(r.phone || ''),
      parentInfo: parentInfo,
      kids: kids,
      // First FULL school year of this family's membership, long
      // '2026-2027' form (mid-year joins roll to the next season).
      // '' when they predate the portal or their earliest registration
      // was an existing-family one — never new.
      firstSeason: regByEmail[key] || '',
      // TRUE when the family holds a live registration for the season
      // currently open (DEFAULT_SEASON). Strictly boolean so the client
      // can distinguish "not re-enrolled" (false) from older cached
      // payloads that predate the field (undefined).
      registeredCurrentSeason: regCurrentByEmail[key] === true,
      // Full normalized roster for downstream consumers that want every
      // person (e.g. dev-mode renderMyFamily / View As).
      people: people
    };
  });
}

// Participation input data — DB-only as of the Sheets retirement (issue
// #25). Families come from member_profiles; every activity source
// (AM/PM/cleaning/events/roles) is queried straight from Postgres in
// buildParticipationReport. The Master-sheet fetch + parse that used to
// live here only fed pre-2026-2027 fallback seasons and was discarded on
// every current-season call.
async function participationFetchData() {
  var sql = getDb();
  var families = await loadFamiliesFromProfiles(sql).catch(function (e) {
    console.error('Profiles fetch failed:', e.message); return [];
  });
  return { families: families };
}

async function buildParticipationReport(sql, data) {
  var families = data.families || [];
  // Report season — resolved from the actual co-op calendar so participation
  // resets the day AFTER Field Day (rw-school-year-boundary), not on a fixed
  // Aug-1 flip. Short '25_26' form drives display; the long '2025-2026' label
  // drives the DB school_year filters. `seasonStart` (day after last year's
  // Field Day) scopes the year-agnostic tables (cleaning/coverage/absences) so
  // last year's rows don't carry into a freshly-reset new year; '' = skip
  // date-scoping (calendar unavailable → no regression).
  var seasonInfo = await participationSeasonInfo(sql);
  var season = seasonInfo.seasonShort;
  var seasonLabel = seasonInfo.seasonLabel;
  var seasonStart = seasonInfo.seasonStart;
  var nameIndex = participationBuildNameIndex(families);
  var members = {};

  families.forEach(function (fam) {
    var famName = String(fam.name || '').trim();
    if (!famName) return;
    var parentNames = String(fam.parents || '')
      .split(/\s*[&\/,]\s*/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    parentNames.forEach(function (first) {
      var key = participationNormName(first + ' ' + famName);
      if (members[key]) return;
      members[key] = {
        key: key,
        first: first,
        family: famName,
        email: fam.email || '',
        displayName: first + ' ' + famName,
        counts: participationBlankCounts(),
        coverageGiven: 0,
        roles: [],
        timeline: { 1: [], 2: [], 3: [], 4: [], 5: [] },
        weightedTotal: 0,
        expectedPoints: 0,
        status: 'on_track',
        isNewMember: false,
        isBoard: false,
        absencesCount: 0,
        exemption: null
      };
    });
  });

  // Email → member-key index for matching DB rows (roles, PM lead) to the
  // exact parent. Built from each family's people roster (workspace +
  // personal email); BLCs skipped to mirror the member map above. The
  // familyFirstMemberKey index credits cleaning (stored by family name, no
  // person) to one parent — the first tracked parent in the family.
  var emailToMemberKey = {};
  var familyFirstMemberKey = {};
  // family_email → first tracked parent, so a role held under a family/role
  // inbox (e.g. president@…) credits the family's primary parent when the
  // holder's own address doesn't match a specific person.
  var familyEmailFirstKey = {};
  (families || []).forEach(function (fam) {
    var famName = String(fam.name || '').trim();
    if (!famName) return;
    var famKeyLc = famName.toLowerCase();
    var famEmailLc = String(fam.email || '').trim().toLowerCase();
    (fam.people || []).forEach(function (pp) {
      if (pp.role === 'blc') return;
      var fn = String(pp.first_name || '').trim();
      if (!fn) return;
      var canonical = participationNormName(fn + ' ' + famName);
      if (!members[canonical]) return;
      [pp.email, pp.personal_email].forEach(function (e) {
        var elc = String(e || '').trim().toLowerCase();
        if (elc && !emailToMemberKey[elc]) emailToMemberKey[elc] = canonical;
      });
      if (!familyFirstMemberKey[famKeyLc]) familyFirstMemberKey[famKeyLc] = canonical;
      if (famEmailLc && !familyEmailFirstKey[famEmailLc]) familyEmailFirstKey[famEmailLc] = canonical;
    });
  });
  // Resolve a DB row to a member: prefer its email, fall back to name match.
  function resolveMemberByEmail(email, fallbackName) {
    var elc = String(email || '').trim().toLowerCase();
    if (elc && emailToMemberKey[elc]) return emailToMemberKey[elc];
    return participationResolveName(fallbackName, nameIndex);
  }
  // Resolve a role holder: try their own address, then their family_email
  // (role/workspace inboxes map to a family via people.family_email), then
  // the family's primary parent, then a name match.
  function resolveRoleHolder(personEmail, familyEmail, fallbackName) {
    var pe = String(personEmail || '').trim().toLowerCase();
    if (pe && emailToMemberKey[pe]) return emailToMemberKey[pe];
    var fe = String(familyEmail || '').trim().toLowerCase();
    if (fe && emailToMemberKey[fe]) return emailToMemberKey[fe];
    if (fe && familyEmailFirstKey[fe]) return familyEmailFirstKey[fe];
    return participationResolveName(fallbackName, nameIndex);
  }

  function addTimeline(memberKey, sessionNum, entry) {
    var m = members[memberKey];
    if (!m || !sessionNum || !m.timeline[sessionNum]) return;
    m.timeline[sessionNum].push(entry);
  }

  // AM teaching — source order (2026-07-05):
  //   1. Scheduled MORNING class_submissions (members submit AM classes
  //      through the same pipeline as PM; leader = submitter, helpers →
  //      am_assist). The Class Builder's Morning lens places these.
  //   2. am_class_assignments (Phase B1 grid — hidden but still honored).
  //   3. Master-sheet AM Volunteer tab (legacy fallback).
  var amSubCredited = false;
  try {
    var amLeadRows = await sql`
      SELECT submitted_by_email, submitted_by_name, scheduled_session, class_name
      FROM class_submissions
      WHERE status = 'scheduled' AND school_year = ${seasonLabel}
        AND class_period = 'AM'
    `;
    var amHelperRows = await sql`
      SELECT h.person_email, h.person_name, cs.scheduled_session, cs.class_name
      FROM class_assignment_helpers h
      JOIN class_submissions cs ON cs.id = h.class_submission_id
      WHERE cs.status = 'scheduled' AND cs.school_year = ${seasonLabel}
        AND cs.class_period = 'AM'
    `;
    if (amLeadRows.length) {
      amSubCredited = true;
      amLeadRows.forEach(function (r) {
        var key = resolveMemberByEmail(r.submitted_by_email, r.submitted_by_name);
        if (!key || !members[key]) return;
        members[key].counts.am_lead += 1;
        addTimeline(key, r.scheduled_session, { category: 'am_lead', label: 'Leading AM — ' + (r.class_name || '') });
      });
      amHelperRows.forEach(function (r) {
        var key = resolveMemberByEmail(r.person_email, r.person_name);
        if (!key || !members[key]) return;
        members[key].counts.am_assist += 1;
        addTimeline(key, r.scheduled_session, { category: 'am_assist', label: 'Assisting AM — ' + (r.class_name || '') });
      });
    }
  } catch (e) {
    console.error('Participation AM-submissions query failed:', e.message);
  }

  var amDbRows = [];
  if (!amSubCredited) {
    try {
      amDbRows = await sql`
        SELECT session_number, group_name, role, person_email, person_name
        FROM am_class_assignments WHERE school_year = ${seasonLabel}
      `;
    } catch (e) {
      console.error('Participation AM-teaching query failed:', e.message);
    }
  }
  if (amDbRows.length) {
    amDbRows.forEach(function (r) {
      var key = resolveMemberByEmail(r.person_email, r.person_name);
      if (!key || !members[key]) return;
      if (r.role === 'lead') {
        members[key].counts.am_lead += 1;
        addTimeline(key, r.session_number, { category: 'am_lead', label: 'Leading AM — ' + (r.group_name || '') });
      } else {
        members[key].counts.am_assist += 1;
        addTimeline(key, r.session_number, { category: 'am_assist', label: 'Assisting AM — ' + (r.group_name || '') });
      }
    });
  }

  // PM electives — "both hour" electives count twice
  // PM elective LEADERS come from the DB (scheduled class_submissions) as of
  // the sheet→DB migration; the leader is the submitter. 'both'-hour classes
  // count double.
  try {
    var pmLeadRows = await sql`
      SELECT submitted_by_email, submitted_by_name, scheduled_session,
             scheduled_hour, class_name
      FROM class_submissions
      WHERE status = 'scheduled' AND school_year = ${seasonLabel}
        AND class_period = 'PM'
    `;
    pmLeadRows.forEach(function (r) {
      var key = resolveMemberByEmail(r.submitted_by_email, r.submitted_by_name);
      if (!key || !members[key]) return;
      var mult = r.scheduled_hour === 'both' ? 2 : 1;
      members[key].counts.pm_lead += mult;
      addTimeline(key, r.scheduled_session, { category: 'pm_lead', label: 'Leading PM — ' + (r.class_name || '') + (mult === 2 ? ' (2-hr)' : '') });
    });
  } catch (e) {
    console.error('Participation PM-lead query failed:', e.message);
  }

  // PM ASSISTANTS — class_assignment_helpers (Phase B2; set in the
  // Schedule Builder).
  var pmAssistDbRows = [];
  try {
    pmAssistDbRows = await sql`
      SELECT h.person_email, h.person_name, cs.scheduled_session, cs.scheduled_hour, cs.class_name
      FROM class_assignment_helpers h
      JOIN class_submissions cs ON cs.id = h.class_submission_id
      WHERE cs.status = 'scheduled' AND cs.school_year = ${seasonLabel}
        AND cs.class_period = 'PM'
    `;
  } catch (e) {
    console.error('Participation PM-assist query failed:', e.message);
  }
  if (pmAssistDbRows.length) {
    pmAssistDbRows.forEach(function (r) {
      var key = resolveMemberByEmail(r.person_email, r.person_name);
      if (!key || !members[key]) return;
      var mult = r.scheduled_hour === 'both' ? 2 : 1;
      members[key].counts.pm_assist += mult;
      addTimeline(key, r.scheduled_session, { category: 'pm_assist', label: 'Assisting PM — ' + (r.class_name || '') + (mult === 2 ? ' (2-hr)' : '') });
    });
  }

  // Cleaning crew — from the DB (cleaning_assignments) as of the sheet→DB
  // migration. One count per family per session (DISTINCT dedupes across
  // areas); credited to the family's first tracked parent per Erin's
  // "one parent only" rule.
  try {
    // cleaning_assignments has no school_year — it's a single "current" grid
    // rebuilt each year. Scope by updated_at ≥ the season start (day after last
    // year's Field Day) so last year's rows don't count against the new season.
    var cleanRows = seasonStart
      ? await sql`
          SELECT DISTINCT session_number, family_name FROM cleaning_assignments
          WHERE updated_at >= ${seasonStart}
        `
      : await sql`
          SELECT DISTINCT session_number, family_name FROM cleaning_assignments
        `;
    cleanRows.forEach(function (r) {
      var key = familyFirstMemberKey[String(r.family_name || '').trim().toLowerCase()];
      if (!key) key = participationResolveName(r.family_name, nameIndex);
      if (!key || !members[key]) return;
      members[key].counts.cleaning_session += 1;
      addTimeline(key, r.session_number, { category: 'cleaning_session', label: 'Cleaning crew' });
    });
  } catch (e) {
    console.error('Participation cleaning query failed:', e.message);
  }

  // Board + committee roles — from the LIVE roles system (roles +
  // role_holders_v2, managed in the Org & Roles UI). The legacy
  // role_holders/role_descriptions tables this used to read are dead (only
  // seed scripts ever wrote them), so continuing role holders were silently
  // getting zero role points — and, crucially, none in a freshly-reset year.
  // Reading the live tables means a holder earns the role's points AGAIN each
  // school_year they serve (board = board_role once; committee_role =
  // one_year_role per role). ended_at IS NULL = still serving; matched to a
  // participation member by holder email → family_email → primary parent.
  try {
    var roleRows = await sql`
      SELECT rhv.person_email AS email,
             p.family_email AS family_email,
             TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS person_name,
             r.title, r.category
      FROM role_holders_v2 rhv
      JOIN roles r ON r.id = rhv.role_id
      LEFT JOIN people p ON LOWER(p.email) = LOWER(rhv.person_email)
      WHERE rhv.school_year = ${seasonLabel}
        AND rhv.ended_at IS NULL
        AND r.status = 'active'
        AND r.category IN ('board', 'committee_role')
    `;
    roleRows.forEach(function (r) {
      var key = resolveRoleHolder(r.email, r.family_email, r.person_name);
      if (!key || !members[key]) return;
      if (r.category === 'board') {
        if (members[key].counts.board_role === 0) members[key].counts.board_role = 1;
        members[key].isBoard = true;
      } else {
        members[key].counts.one_year_role += 1;
      }
      if (r.title) members[key].roles.push(r.title);
    });
  } catch (e) {
    console.error('Participation roles query failed:', e.message);
  }

  // Special events — special_events + special_event_people (Phase B3;
  // managed by the Special Events Liaison).
  var evDbRows = [];
  try {
    evDbRows = await sql`
      SELECT se.name, sep.role, sep.person_email, sep.person_name
      FROM special_event_people sep
      JOIN special_events se ON se.id = sep.event_id
      WHERE se.school_year = ${seasonLabel}
    `;
  } catch (e) {
    console.error('Participation special-events query failed:', e.message);
  }
  if (evDbRows.length) {
    evDbRows.forEach(function (r) {
      var key = resolveMemberByEmail(r.person_email, r.person_name);
      if (!key || !members[key]) return;
      if (r.role === 'lead') {
        members[key].counts.event_lead += 1;
        members[key].roles.push('Event lead — ' + (r.name || ''));
      } else {
        members[key].counts.event_assist += 1;
      }
    });
  }

  // Coverage given (not weighted — reported alongside)
  try {
    // Scope to the current season via the parent absence's date (coverage_slots
    // has no year of its own) so last year's coverage doesn't carry over.
    var coverageRows = seasonStart
      ? await sql`
          SELECT cs.claimed_by_email, cs.claimed_by_name, COUNT(*)::int AS c
          FROM coverage_slots cs
          JOIN absences a ON a.id = cs.absence_id
          WHERE cs.claimed_by_email IS NOT NULL AND a.absence_date >= ${seasonStart}
          GROUP BY cs.claimed_by_email, cs.claimed_by_name
        `
      : await sql`
          SELECT claimed_by_email, claimed_by_name, COUNT(*)::int AS c
          FROM coverage_slots
          WHERE claimed_by_email IS NOT NULL
          GROUP BY claimed_by_email, claimed_by_name
        `;
    coverageRows.forEach(function (r) {
      var k = participationResolveName(r.claimed_by_name, nameIndex);
      if (k && members[k]) members[k].coverageGiven += r.c;
    });
  } catch (e) {
    console.error('Participation coverage query failed:', e.message);
  }

  // Active absences count (informational)
  try {
    var absRows = seasonStart
      ? await sql`
          SELECT absent_person, COUNT(*)::int AS c
          FROM absences
          WHERE cancelled_at IS NULL AND absence_date >= ${seasonStart}
          GROUP BY absent_person
        `
      : await sql`
          SELECT absent_person, COUNT(*)::int AS c
          FROM absences
          WHERE cancelled_at IS NULL
          GROUP BY absent_person
        `;
    absRows.forEach(function (r) {
      var k = participationResolveName(r.absent_person, nameIndex);
      if (k && members[k]) members[k].absencesCount = r.c;
    });
  } catch (e) {
    console.error('Participation absences query failed:', e.message);
  }

  // New-member detection — same rule as the Directory's First Year badge:
  // a family is new until they've completed a full co-op year, so they're
  // flagged while their first FULL season (firstSeasonByEmail; mid-year
  // joins roll to the next season) is the current report season or later.
  // Seasons compare as normalized long labels — registrations store
  // '2026-2027' while participationCurrentSeason() returns '25_26', so the
  // raw equality this used to do never matched.
  // seasonLabel computed at the top of the function.
  var firstSeasons = await firstSeasonByEmail(sql);
  Object.keys(members).forEach(function (k) {
    var m = members[k];
    var emailLc = String(m.email || '').toLowerCase();
    var firstSeason = firstSeasons[emailLc];
    if (firstSeason && seasonLabel && firstSeason >= seasonLabel) m.isNewMember = true;
  });

  // Active exemptions
  var today = new Date().toISOString().slice(0, 10);
  var exemptionRows = [];
  try {
    exemptionRows = await sql`
      SELECT id, member_email, member_name, start_date, end_date, reason, note
      FROM participation_exemptions
      WHERE end_date IS NULL OR end_date >= ${today}
    `;
    exemptionRows.forEach(function (r) {
      var k = null;
      var emailLc = String(r.member_email || '').toLowerCase();
      var nameNorm = participationNormName(r.member_name);
      // Prefer family-email + name match so we pick the right parent.
      Object.keys(members).forEach(function (mk) {
        var m = members[mk];
        if (!k && m.email && m.email.toLowerCase() === emailLc && participationNormName(m.displayName) === nameNorm) {
          k = mk;
        }
      });
      if (!k) k = participationResolveName(r.member_name, nameIndex);
      if (k && members[k]) {
        members[k].exemption = {
          id: r.id,
          start_date: r.start_date,
          end_date: r.end_date,
          reason: r.reason,
          note: r.note || ''
        };
      }
    });
  } catch (e) {
    console.error('Participation exemptions query failed:', e.message);
  }

  // Load weights
  var weights = {};
  try {
    var wRows = await sql`SELECT key, value FROM participation_weights`;
    wRows.forEach(function (w) { weights[w.key] = parseFloat(w.value); });
  } catch (e) {
    console.error('Participation weights query failed:', e.message);
  }

  var annualExpected = Number.isFinite(weights.annual_expected_points) ? weights.annual_expected_points : 14;
  var newPct = (Number.isFinite(weights.new_member_baseline_pct) ? weights.new_member_baseline_pct : 60) / 100;
  var yearBounds = participationYearBounds(season);
  var yearMs = yearBounds.end - yearBounds.start;

  Object.keys(members).forEach(function (k) {
    var m = members[k];
    var total = 0;
    ['board_role', 'one_year_role', 'am_lead', 'am_assist', 'pm_lead', 'pm_assist', 'cleaning_session', 'event_lead', 'event_assist'].forEach(function (field) {
      var cnt = m.counts[field] || 0;
      var w = Number.isFinite(weights[field]) ? weights[field] : 0;
      total += cnt * w;
    });
    m.weightedTotal = Math.round(total * 100) / 100;

    var exp = annualExpected;
    if (m.isNewMember) exp = exp * newPct;
    if (m.exemption) {
      var exStart = new Date(m.exemption.start_date);
      var exEnd = m.exemption.end_date ? new Date(m.exemption.end_date) : yearBounds.end;
      if (exStart < yearBounds.start) exStart = yearBounds.start;
      if (exEnd > yearBounds.end) exEnd = yearBounds.end;
      if (exEnd >= exStart && yearMs > 0) {
        var covered = (exEnd - exStart) / yearMs;
        covered = Math.max(0, Math.min(1, covered));
        exp = exp * (1 - covered);
      }
    }
    m.expectedPoints = Math.round(exp * 10) / 10;

    if (m.exemption && m.expectedPoints < 0.5) m.status = 'exempt';
    else if (m.isNewMember && m.weightedTotal < m.expectedPoints) m.status = 'new';
    else if (m.weightedTotal >= m.expectedPoints) m.status = 'on_track';
    else if (m.expectedPoints > 0 && m.weightedTotal >= m.expectedPoints * 0.8) m.status = 'near';
    else m.status = 'behind';
  });

  var out = Object.keys(members).map(function (k) { return members[k]; });
  out.sort(function (a, b) {
    if (a.family < b.family) return -1;
    if (a.family > b.family) return 1;
    return a.first < b.first ? -1 : (a.first > b.first ? 1 : 0);
  });

  return { season: season, members: out, weights: weights };
}

// Collapse the 5-state participation status into a 3-tier growth stage for
// the dashboard badge. 'exempt' and 'on_track' count as the fully-grown tree;
// 'near' is the sapling; 'behind' and 'new' both map to sprout (soft-coral
// nudge).
function participationTier(status) {
  if (status === 'on_track' || status === 'exempt') return 'tree';
  if (status === 'near') return 'sapling';
  return 'sprout';
}

async function handleParticipationAction(req, res, action, userEmail, authGivenName, realEmail) {
  var sql = getDb();
  // userEmail = effective (View-As) identity used for gates + own-row
  // resolution. realEmail = the actual signed-in person, used for write
  // audit fields so an impersonated action is still attributed correctly.
  var auditEmail = realEmail || userEmail;

  // Personal participation view — any authed @rootsandwingsindy.com member
  // can fetch their own row. Super users (communications@ / vicepresident@)
  // can fetch any family's row by passing ?email=<target> (used by the
  // View As picker).
  if (action === 'participation-mine' && req.method === 'GET') {
    var emailLc = String(userEmail || '').toLowerCase();
    var canViewAny = isSuperUser(emailLc);
    var targetEmail = String((req.query && req.query.email) || userEmail || '').toLowerCase();
    if (!targetEmail) return res.status(400).json({ error: 'email required' });
    if (targetEmail !== emailLc && !canViewAny) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Resolve targetEmail to its canonical family. Backup learning
    // coaches sign in with their own Workspace email (e.g. brianr@),
    // which lives in member_profiles.additional_emails — not on any
    // member row's email field. Without this hop, the per-family
    // filter below misses every BLC and they see "no member" / 0 score.
    var familyRow = await resolveFamily(sql, targetEmail);
    var canonicalFamilyEmail = familyRow
      ? String(familyRow.family_email || '').toLowerCase()
      : targetEmail;

    var data = await participationFetchData();
    var report = await buildParticipationReport(sql, data);
    var familyMembers = (report.members || []).filter(function (m) {
      return String(m.email || '').toLowerCase() === canonicalFamilyEmail;
    });
    if (familyMembers.length === 0) {
      return res.status(200).json({ season: report.season, member: null });
    }
    // Disambiguate which parent in the family is "you". Tries in order:
    //   1. Email local part === firstname + family-initial — derived
    //      from targetEmail (which is the View-As target for super
    //      users, or the signed-in user otherwise). Most reliable
    //      because workspace addresses ARE firstname+lastInitial.
    //   2. JWT given_name === stored first_name — only useful when the
    //      signed-in user IS the parent we're looking up; skipped for
    //      super-user View-As since the JWT carries comms@'s own
    //      given_name, not the target's.
    //   3. Last resort — first parent in the family (alphabetic).
    var mine = null;
    var localPart = String(targetEmail.split('@')[0] || '').toLowerCase();
    if (localPart) {
      for (var j = 0; j < familyMembers.length; j++) {
        var first = String(familyMembers[j].first || '').toLowerCase().replace(/[^a-z]/g, '');
        var fam = String(familyMembers[j].family || '').toLowerCase();
        var li = fam.charAt(0);
        if (first && li && (first + li) === localPart) {
          mine = familyMembers[j];
          break;
        }
      }
    }
    if (!mine && !canViewAny) {
      var gn = String(authGivenName || '').toLowerCase();
      if (gn) {
        for (var i = 0; i < familyMembers.length; i++) {
          if (String(familyMembers[i].first || '').toLowerCase() === gn) {
            mine = familyMembers[i];
            break;
          }
        }
      }
    }
    // If neither match hit AND the user signed in with a co-parent
    // address (not the canonical family_email), they're a Backup
    // Learning Coach or other non-tracked co-parent — BLCs are
    // intentionally excluded from the participation report. Return
    // null so the panel renders "you're not tracked" rather than
    // falsely surfacing the MLC's row to them.
    if (!mine && !canViewAny && targetEmail !== canonicalFamilyEmail) {
      return res.status(200).json({ season: report.season, member: null });
    }
    if (!mine) mine = familyMembers[0];
    mine.tier = participationTier(mine.status);
    return res.status(200).json({ season: report.season, member: mine });
  }

  var canRead = await participationCanRead(userEmail);
  if (!canRead) return res.status(403).json({ error: 'Not authorized' });

  if (action === 'participation-report' && req.method === 'GET') {
    var data = await participationFetchData();
    var report = await buildParticipationReport(sql, data);
    return res.status(200).json(report);
  }

  if (action === 'participation-weights' && req.method === 'GET') {
    var wRows = await sql`
      SELECT key, label, value, sort_order, description, updated_by, updated_at
      FROM participation_weights
      ORDER BY sort_order, key
    `;
    return res.status(200).json({ weights: wRows });
  }

  if (action === 'participation-weight-save' && req.method === 'POST') {
    if (!(await participationCanWrite(userEmail))) {
      return res.status(403).json({ error: 'Vice President, Afternoon Class Liaison, or super user only' });
    }
    var body = req.body || {};
    // Accept either a single {key, value} (legacy) or a batch
    // {updates: [{key, value}, …]} — the Settings modal saves all dirty
    // fields in one POST. Validate everything before writing anything.
    var updates = Array.isArray(body.updates) ? body.updates
      : [{ key: body.key, value: body.value }];
    if (updates.length === 0) return res.status(400).json({ error: 'no updates' });
    var cleaned = [];
    for (var ui = 0; ui < updates.length; ui++) {
      var uKey = String((updates[ui] && updates[ui].key) || '').trim();
      if (!uKey) return res.status(400).json({ error: 'key required' });
      var uVal = parseFloat(updates[ui].value);
      if (!Number.isFinite(uVal)) return res.status(400).json({ error: 'value must be a number (' + uKey + ')' });
      cleaned.push({ key: uKey, value: uVal });
    }
    var saved = [];
    for (var ci = 0; ci < cleaned.length; ci++) {
      var rows = await sql`
        UPDATE participation_weights
        SET value = ${cleaned[ci].value}, updated_by = ${auditEmail}, updated_at = NOW()
        WHERE key = ${cleaned[ci].key}
        RETURNING key, value, updated_at
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'weight key not found: ' + cleaned[ci].key });
      saved.push(rows[0]);
    }
    return res.status(200).json({ ok: true, weights: saved, weight: saved[0] });
  }

  if (action === 'participation-exemptions' && req.method === 'GET') {
    var exRows = await sql`
      SELECT id, member_email, member_name, start_date, end_date, reason, note, created_by, created_at
      FROM participation_exemptions
      ORDER BY start_date DESC, id DESC
    `;
    return res.status(200).json({ exemptions: exRows });
  }

  if (action === 'participation-exemption-save' && req.method === 'POST') {
    if (!(await participationCanWrite(userEmail))) {
      return res.status(403).json({ error: 'Vice President, Afternoon Class Liaison, or super user only' });
    }
    var body2 = req.body || {};
    var exId = body2.id ? parseInt(body2.id, 10) : null;
    var mEmail = String(body2.member_email || '').trim();
    var mName = String(body2.member_name || '').trim();
    var startDate = String(body2.start_date || '').trim();
    var endDate = String(body2.end_date || '').trim();
    var reason = String(body2.reason || 'other').trim();
    var note = String(body2.note || '').trim();
    if (!mEmail || !mName || !startDate) {
      return res.status(400).json({ error: 'member_email, member_name, start_date required' });
    }
    if (['medical', 'family', 'other'].indexOf(reason) === -1) {
      return res.status(400).json({ error: "reason must be 'medical', 'family', or 'other'" });
    }
    var endDateVal = endDate || null;
    var saved;
    if (exId) {
      saved = await sql`
        UPDATE participation_exemptions
        SET member_email = ${mEmail},
            member_name = ${mName},
            start_date = ${startDate},
            end_date = ${endDateVal},
            reason = ${reason},
            note = ${note}
        WHERE id = ${exId}
        RETURNING *
      `;
      if (saved.length === 0) return res.status(404).json({ error: 'exemption not found' });
    } else {
      saved = await sql`
        INSERT INTO participation_exemptions
          (member_email, member_name, start_date, end_date, reason, note, created_by)
        VALUES
          (${mEmail}, ${mName}, ${startDate}, ${endDateVal}, ${reason}, ${note}, ${auditEmail})
        RETURNING *
      `;
    }
    return res.status(200).json({ ok: true, exemption: saved[0] });
  }

  if (action === 'participation-exemption-delete' && req.method === 'POST') {
    if (!(await participationCanWrite(userEmail))) {
      return res.status(403).json({ error: 'Vice President, Afternoon Class Liaison, or super user only' });
    }
    var body3 = req.body || {};
    var delId = parseInt(body3.id, 10);
    if (!delId) return res.status(400).json({ error: 'id required' });
    await sql`DELETE FROM participation_exemptions WHERE id = ${delId}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ══════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════
module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-View-As');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Authentication required ──
  var authResult = await verifyAuth(req);
  if (!authResult.ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var action = (req.query && req.query.action) || '';

  // ── Source-sheets index ──
  // Returns the canonical list of Google Sheets the app reads from, with
  // shareable URLs. Powers the Workspace "Source Sheets" widget so board
  // members can jump straight to whichever sheet they need without
  // hunting through Drive. Sheet IDs are pulled from env vars so this
  // stays accurate even if a sheet is swapped out.
  if (action === 'sheet-index' && req.method === 'GET') {
    function urlFor(id) {
      return id ? ('https://docs.google.com/spreadsheets/d/' + id + '/edit') : '';
    }
    var entries = [
      // Directory sheet retired 2026-05-15 (member_profiles / people /
      // kids own family data); Master Coordination + Membership Report
      // sheets retired 2026-07-19 with the full Sheets retirement
      // (issue #25). The Billing workbook is the ONLY sheet the portal
      // still reads.
      {
        key: 'billing',
        label: 'Billing — Family Payment Tracking',
        purpose: 'Treasurer marks Paid here; site reads it for the My Family billing card. Also holds AM/PM semester rates.',
        envVar: 'BILLING_SHEET_ID',
        id: process.env.BILLING_SHEET_ID || '',
        url: urlFor(process.env.BILLING_SHEET_ID)
      }
    ];
    return res.status(200).json({ sheets: entries });
  }

  // ── Billing sub-routes ──
  if (action === 'billing') {
    try {
      var billingAuth = getAuth();
      var billingSheets = google.sheets({ version: 'v4', auth: billingAuth });
      if (req.method === 'GET') return handleBillingGet(req, res, billingSheets);
      if (req.method === 'POST') return handleBillingPost(req, res, authResult);
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      console.error('Billing action error:', err);
      return res.status(500).json({ error: 'Billing request failed' });
    }
  }

  // ── Participation sub-routes. Most are VP / Afternoon Class Liaison /
  // super-user only; participation-mine lets any authed member fetch just
  // their own row. The router gates at the action level inside the handler.
  if (action && action.indexOf('participation-') === 0) {
    try {
      // View-As aware (mirrors api/tour.js verifyWorkspaceAuthWithViewAs and
      // the merch/membership reports): when the real caller may impersonate
      // (super user, or any @rootsandwingsindy.com on dev/preview) and sends
      // an X-View-As header, gate + own-row resolution use the impersonated
      // identity so acting as VP / Afternoon Class Liaison grants the read.
      // realEmail is preserved so write audit fields stay attributed to the
      // actual signed-in person.
      var partReal = String(authResult.email || '').toLowerCase();
      var partViewAs = String(req.headers['x-view-as'] || '').trim().toLowerCase();
      var partEffective = (partViewAs && canImpersonate(partReal)) ? partViewAs : partReal;
      return await handleParticipationAction(req, res, action, partEffective, authResult.givenName || '', partReal);
    } catch (err) {
      console.error('Participation action error:', err);
      return res.status(500).json({ error: 'Participation request failed' });
    }
  }

  try {
    // The Master Coordination sheet is retired along with the Directory
    // sheet (issue #25) — every block below reads Postgres. The only
    // Google Sheet the portal still touches is the Treasurer's Billing
    // workbook (handleBillingAction).
    var errors = [];
    var result = { errors: errors };

    // ── Families (DB-only as of 2026-05-15) ──
    // Source of truth: member_profiles + people + kids tables. The
    // legacy Directory + Classlist tabs used to feed parseDirectory
    // here; one-time backfill (scripts/backfill-kids-from-classlist.js)
    // moved kid age-group + schedule into the kids table.
    try {
      var sql = getDb();
      result.families = await loadFamiliesFromProfiles(sql);
    } catch (loadErr) {
      console.error('loadFamiliesFromProfiles failed:', loadErr);
      result.families = [];
      errors.push({ source: 'families', error: 'Failed to load from DB' });
    }

    // applyMemberProfileOverlay was originally the merge step that
    // layered DB edits on top of the sheet read. Now that families
    // come from the DB directly, the overlay is mostly redundant —
    // but it still surfaces fam.boardRole / fam.boardEmail from
    // role_holders_v2 (the board-role overlay block at line ~1318
    // is the only piece that's load-bearing).
    try {
      var overlayOut = await applyMemberProfileOverlay(result.families);
      // Attach committee role holders (email → titles[]) to the top-level
      // response so the client's getWorkspaceRoles can pick up new
      // committee_role assignments (e.g. Merchandise Manager) without
      // depending on the legacy Volunteer Committees Sheet.
      if (overlayOut && overlayOut.committeeRoleHolders) {
        result.committeeRoleHolders = overlayOut.committeeRoleHolders;
      }
    } catch (overlayErr) {
      console.error('Member profile overlay failed:', overlayErr);
    }

    // ── Roles directory (roles + role_holders_v2, DB) ──
    // Every active board/committee role for the current roles year, WITH
    // zero-holder roles included — open (holder-less) committee seats are
    // exactly what the workspace "Ways to get more involved" list renders.
    // Holder names resolve via people by email (falling back to the bare
    // email) so the client never has to name-match. Replaces the retired
    // Volunteer Committees tab for the role popups, the Supply Coordinator
    // lookup, and the open-seats list (issue #25).
    try {
      var rdYearRows = await sql`SELECT MAX(school_year) AS sy FROM role_holders_v2`;
      var rdYear = (rdYearRows[0] && rdYearRows[0].sy) || '';
      var rdRows = await sql`
        SELECT r.id, r.role_key, r.title, r.category, r.parent_role_id,
               r.term_length, c.name AS committee,
               LOWER(rhv.person_email) AS holder_email,
               p.first_name AS holder_first, p.last_name AS holder_last
        FROM roles r
        LEFT JOIN committees c ON c.id = r.committee_id
        LEFT JOIN role_holders_v2 rhv
          ON rhv.role_id = r.id
         AND rhv.school_year = ${rdYear}
         AND rhv.ended_at IS NULL
        LEFT JOIN people p ON LOWER(p.email) = LOWER(rhv.person_email)
        WHERE r.status = 'active' AND r.category IN ('board', 'committee_role')
        ORDER BY r.display_order, r.title
      `;
      var rdById = {};
      result.rolesDirectory = [];
      rdRows.forEach(function (row) {
        var entry = rdById[row.id];
        if (!entry) {
          entry = {
            id: row.id, role_key: row.role_key, title: row.title,
            category: row.category, parent_role_id: row.parent_role_id,
            term_length: row.term_length || '', committee: row.committee || '',
            holders: []
          };
          rdById[row.id] = entry;
          result.rolesDirectory.push(entry);
        }
        if (row.holder_email) {
          var holderName = ((row.holder_first || '') + ' ' + (row.holder_last || '')).trim();
          entry.holders.push({ name: holderName || row.holder_email, email: row.holder_email });
        }
      });
    } catch (rdErr) {
      console.error('rolesDirectory query failed (non-fatal):', rdErr);
    }

    // Default loginEmails = [primary] for every family — see buildSheetData
    // sibling for the shape rationale.
    result.families.forEach(function (fam) {
      if (!Array.isArray(fam.loginEmails)) {
        var primary = String(fam.email || '').toLowerCase();
        fam.loginEmails = primary ? [primary] : [];
      }
    });

    // ── Special Events (DB) ──
    // Approved events for the active season with their lead/assist people
    // (special_events + special_event_people) — the members' Events grid
    // and the coordinator duty in My Responsibilities read this instead
    // of the retired Master-sheet Special Events tab. People are
    // email-keyed so the client never name-matches (bug log #9). Distinct
    // key from the old sheet-shaped `specialEvents` so a stale cached
    // payload can't be mistaken for the DB shape.
    try {
      var seSeason = '';
      try {
        var seInfo = await participationSeasonInfo(sql);
        seSeason = seInfo.seasonLabel || '';
      } catch (seSeasonErr) {
        console.error('Special-events season resolve failed:', seSeasonErr);
      }
      if (seSeason) {
        var seDateStr = function (v) {
          if (!v) return '';
          return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
        };
        var seTimeStr = function (v) { return v ? String(v).slice(0, 5) : ''; };
        var seRows = await sql`
          SELECT id, name, event_date, end_date, start_time, end_time,
                 location, notes
          FROM special_events
          WHERE school_year = ${seSeason} AND date_status = 'approved'
          ORDER BY event_date NULLS LAST, sort_order, name
        `;
        var sePeople = seRows.length ? await sql`
          SELECT sep.event_id, sep.role, LOWER(sep.person_email) AS person_email,
                 sep.person_name
          FROM special_event_people sep
          JOIN special_events se ON se.id = sep.event_id
          WHERE se.school_year = ${seSeason}
          ORDER BY sep.event_id, sep.role DESC, sep.sort_order
        ` : [];
        var sePeopleByEvent = {};
        sePeople.forEach(function (pr) {
          (sePeopleByEvent[pr.event_id] = sePeopleByEvent[pr.event_id] || []).push(pr);
        });
        result.specialEventsDb = seRows.map(function (ev) {
          var lead = null;
          var support = [];
          (sePeopleByEvent[ev.id] || []).forEach(function (pr) {
            var person = { name: pr.person_name || pr.person_email, email: pr.person_email };
            if (pr.role === 'lead' && !lead) lead = person;
            else support.push(person);
          });
          return {
            id: ev.id,
            name: ev.name,
            schoolYear: seSeason,
            date: seDateStr(ev.event_date),
            endDate: seDateStr(ev.end_date),
            startTime: seTimeStr(ev.start_time),
            endTime: seTimeStr(ev.end_time),
            location: ev.location || '',
            notes: ev.notes || '',
            coordinator: lead,
            support: support
          };
        });
      }
    } catch (seErr) {
      console.error('specialEventsDb query failed (non-fatal):', seErr);
    }

    res.status(200).json(result);

  } catch (err) {
    console.error('Sheets API error:', err);
    res.status(500).json({ error: 'Failed to fetch sheet data' });
  }
};

// Expose pure helpers for one-off scripts (seed migrations, inspections) so
// they stay in lockstep with the live parser. Vercel treats the default
// module.exports function as the handler and ignores attached properties.
module.exports.parseDirectory = parseDirectory;
module.exports.parseBillingSheet = parseBillingSheet;
module.exports.fetchSheet = fetchSheet;
module.exports.getAuth = getAuth;
module.exports.applyMemberProfileOverlay = applyMemberProfileOverlay;
module.exports.loadFamiliesFromProfiles = loadFamiliesFromProfiles;
module.exports.seasonToYearLabel = seasonToYearLabel;
module.exports.firstSeasonByEmail = firstSeasonByEmail;
module.exports.firstSeasonFromRows = firstSeasonFromRows;
