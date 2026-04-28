const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');
const { canEditAsRole, SUPER_USER_EMAIL } = require('./_permissions');

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Verify caller is authenticated ──
async function verifyAuth(req) {
  var authHeader = req.headers.authorization || '';

  // Google JWT: "Bearer <token>"
  if (authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7);
    try {
      var ticket = await oauthClient.verifyIdToken({
        idToken: token,
        audience: GOOGLE_CLIENT_ID,
      });
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
// AM CLASSES
// ══════════════════════════════════════════════
// Layout: sessions at cols 6,12,18,24,30 (row 0)
// Each session data block starts 1 col before header: 5,11,17,23,29
// Group pattern per group:
//   Group header row: col 4/10/16/22/28 = group name, +1 = "Topic of Study", +2 = "Liaison", +3 = "Room"
//   Data row (next): +1 = topic, +2 = liaison name, +3 = room name
//   10-11 am row: +1 = teacher, +2..+5 = assistants
//   11-12 pm row: same

function parseAMClasses(rows) {
  if (!rows || rows.length < 5) return { classes: {}, supportRoles: {} };

  // Find session header columns from row 0
  var sessionCols = []; // { session: N, dataStart: col }
  for (var c = 0; c < (rows[0] ? rows[0].length : 0); c++) {
    var v = cell(rows[0], c);
    var match = v.match(/Session\s+(\d+)/i);
    if (match) {
      sessionCols.push({ session: parseInt(match[1]), dataStart: c - 1 });
    }
  }

  var AGE_RANGES = {
    'Greenhouse': '0-2', 'Green House': '0-2',
    'Saplings': '3-5', 'Sassafras': '3-6',
    'Oaks': '7-8', 'Maples': '8-9',
    'Birch': '9-10', 'Willows': '10-12',
    'Cedars': '12-13', 'Pigeons': '14+', 'Teens': '13+'
  };

  // Group start column is dataStart - 1 (i.e., col 4 for S1)
  var groupCol = sessionCols.length > 0 ? sessionCols[0].dataStart - 1 : 4;

  var classes = {};
  var supportRoles = {};

  for (var r = 0; r < rows.length; r++) {
    var groupName = cell(rows[r], groupCol);

    // Normalize
    if (groupName === 'Green House') groupName = 'Greenhouse';

    if (AGE_RANGES[groupName]) {
      classes[groupName] = {
        ages: AGE_RANGES[groupName],
        liaison: '',
        sessions: {}
      };

      // Data row is r+1 (has topic, liaison, room per session)
      var dataRow = rows[r + 1] || [];

      for (var si = 0; si < sessionCols.length; si++) {
        var sNum = sessionCols[si].session;
        var ds = sessionCols[si].dataStart;

        var topic = cell(dataRow, ds);
        var liaison = cell(dataRow, ds + 1);
        var room = cell(dataRow, ds + 2);

        // Set class-level liaison from first session (it's the same person across sessions)
        if (si === 0 && liaison) classes[groupName].liaison = liaison;

        // Find 10-11 am and 11-12 pm rows below
        var teacher = '';
        var assistants = [];
        for (var tr = r + 2; tr < Math.min(r + 5, rows.length); tr++) {
          var timeLabel = cell(rows[tr], groupCol);
          if (timeLabel === '10-11 am') {
            teacher = cell(rows[tr], ds);
            for (var ac = ds + 1; ac <= ds + 4; ac++) {
              var a = cell(rows[tr], ac);
              if (a && a !== '10-11 am') assistants.push(a);
            }
            break;
          }
        }

        classes[groupName].sessions[sNum] = {
          topic: topic,
          room: room,
          teacher: teacher,
          assistants: assistants
        };
      }
      continue;
    }

    // Support roles: Floater*, Prep Period**, Board Duties
    if (groupName.match(/^Floater/)) {
      for (var tr = r + 1; tr < Math.min(r + 4, rows.length); tr++) {
        var timeLabel = cell(rows[tr], groupCol);
        if (timeLabel === '10-11 am' || timeLabel === '11-12 pm') {
          var timeKey = timeLabel.replace(' am', '').replace(' pm', '');
          for (var si = 0; si < sessionCols.length; si++) {
            var sNum = sessionCols[si].session;
            var ds = sessionCols[si].dataStart;
            if (!supportRoles[sNum]) supportRoles[sNum] = { floaters: {}, prepPeriod: {}, boardDuties: {} };
            if (!supportRoles[sNum].floaters[timeKey]) supportRoles[sNum].floaters[timeKey] = [];
            for (var fc = ds; fc <= ds + 4; fc++) {
              var name = cell(rows[tr], fc);
              if (name && name !== '10-11 am' && name !== '11-12 pm') {
                supportRoles[sNum].floaters[timeKey].push(name);
              }
            }
          }
        }
      }
    }

    if (groupName.match(/^Prep Period/)) {
      for (var tr = r + 1; tr < Math.min(r + 4, rows.length); tr++) {
        var timeLabel = cell(rows[tr], groupCol);
        if (timeLabel === '10-11 am' || timeLabel === '11-12 pm') {
          var timeKey = timeLabel.replace(' am', '').replace(' pm', '');
          for (var si = 0; si < sessionCols.length; si++) {
            var sNum = sessionCols[si].session;
            var ds = sessionCols[si].dataStart;
            if (!supportRoles[sNum]) supportRoles[sNum] = { floaters: {}, prepPeriod: {}, boardDuties: {} };
            if (!supportRoles[sNum].prepPeriod[timeKey]) supportRoles[sNum].prepPeriod[timeKey] = [];
            for (var fc = ds; fc <= ds + 4; fc++) {
              var name = cell(rows[tr], fc);
              if (name && name !== '10-11 am' && name !== '11-12 pm') {
                supportRoles[sNum].prepPeriod[timeKey].push(name);
              }
            }
          }
        }
      }
    }

    if (groupName === 'Board Duties') {
      for (var tr = r + 1; tr < Math.min(r + 4, rows.length); tr++) {
        var timeLabel = cell(rows[tr], groupCol);
        if (timeLabel === '10-11 am' || timeLabel === '11-12 pm') {
          var timeKey = timeLabel.replace(' am', '').replace(' pm', '');
          for (var si = 0; si < sessionCols.length; si++) {
            var sNum = sessionCols[si].session;
            var ds = sessionCols[si].dataStart;
            if (!supportRoles[sNum]) supportRoles[sNum] = { floaters: {}, prepPeriod: {}, boardDuties: {} };
            if (!supportRoles[sNum].boardDuties[timeKey]) supportRoles[sNum].boardDuties[timeKey] = [];
            for (var fc = ds; fc <= ds + 4; fc++) {
              var name = cell(rows[tr], fc);
              if (name && name !== '10-11 am' && name !== '11-12 pm') {
                supportRoles[sNum].boardDuties[timeKey].push(name);
              }
            }
          }
        }
      }
    }
  }

  return { classes: classes, supportRoles: supportRoles };
}

// ══════════════════════════════════════════════
// PM ELECTIVES
// ══════════════════════════════════════════════
// Layout: Hour headers at row 3 (cols 5 and 18)
// Row 4: "Age of student" + ages per class column
// Row 5: "Title of Class" + titles
// Row 6: "Class Description" + descriptions
// Row 7: "Room/Location" + rooms
// Row 8: "Class Leader" + leaders
// Row 9+: "Student Names" + students (until "|" stops or section changes)
// Row 34+: "Class Assistant" rows
// Row 28-31: Board Duties
// Row 38: Supply Closet

function parsePMElectives(rows) {
  if (!rows || rows.length < 9) return { electives: [], supportRoles: {} };

  // Find key rows
  var ageRow = -1, titleRow = -1, descRow = -1, roomRow = -1, leaderRow = -1;
  var studentStartRow = -1;
  var assistantRows = [];
  var hour1StartCol = -1, hour2StartCol = -1;

  for (var r = 0; r < Math.min(40, rows.length); r++) {
    for (var c = 0; c < (rows[r] ? rows[r].length : 0); c++) {
      var v = cell(rows[r], c);
      if (v.match(/^HOUR ONE/i) && hour1StartCol === -1) hour1StartCol = c;
      if (v.match(/^HOUR TWO/i) && hour2StartCol === -1) hour2StartCol = c;
      if (v === 'Age of student' && ageRow === -1) ageRow = r;
      if (v === 'Title of Class' && titleRow === -1) titleRow = r;
      if (v === 'Class Description' && descRow === -1) descRow = r;
      if (v.match(/^Room.*Location/i) && roomRow === -1) roomRow = r;
      if (v === 'Class Leader' && leaderRow === -1) leaderRow = r;
      if (v === 'Student Names' && studentStartRow === -1) studentStartRow = r;
      if (v === 'Class Assistant') assistantRows.push(r);
    }
  }

  if (titleRow === -1) return { electives: [], supportRoles: {} };

  // Find class columns for each hour
  // Hour 1 classes: columns between hour1StartCol and hour2StartCol with title data
  // Hour 2 classes: columns after hour2StartCol with title data
  var h1Cols = [], h2Cols = [];
  var h1End = hour2StartCol > 0 ? hour2StartCol : 99;
  var maxCol = 0;
  for (var r = 0; r < rows.length; r++) {
    if (rows[r] && rows[r].length > maxCol) maxCol = rows[r].length;
  }

  for (var c = hour1StartCol; c < h1End; c++) {
    if (cell(rows[titleRow], c) && cell(rows[titleRow], c) !== 'Title of Class') {
      h1Cols.push(c);
    }
  }
  if (hour2StartCol > 0) {
    for (var c = hour2StartCol; c < maxCol; c++) {
      if (cell(rows[titleRow], c) && cell(rows[titleRow], c) !== 'Title of Class') {
        h2Cols.push(c);
      }
    }
  }

  var electives = [];

  function parseElective(col, hourNum) {
    var title = cell(rows[titleRow], col);
    if (!title) return;

    var hour = hourNum;
    if (title.match(/2\s*hr|two\s*hour|both\s*hour/i)) hour = 'both';

    var ageRange = ageRow >= 0 ? cell(rows[ageRow], col) : '';
    var description = descRow >= 0 ? cell(rows[descRow], col) : '';
    var room = roomRow >= 0 ? cell(rows[roomRow], col) : '';
    var leader = leaderRow >= 0 ? cell(rows[leaderRow], col) : '';

    // Collect students
    var students = [];
    if (studentStartRow >= 0) {
      for (var sr = studentStartRow; sr < rows.length; sr++) {
        var sv = cell(rows[sr], col);
        if (!sv) continue;
        if (sv === '|' || sv === 'Student Names') continue;
        // Stop at assistant/board sections
        var col5 = cell(rows[sr], 5);
        var col6 = cell(rows[sr], 6);
        if (col5 === 'Class Assistant' || col5 === 'Student must provide:') break;
        if (col6 === 'Board Duties' || col6 === 'Prep Period') continue;
        // Skip floater/prep labels in the floater column
        if (sv.match(/^(Prep Period|Board Duties|Supply Closet|Class Assistant|Student must)/i)) break;
        students.push(sv);
      }
    }

    // Collect assistants (deduplicate)
    var assistants = [];
    var assistantSeen = {};
    for (var ai = 0; ai < assistantRows.length; ai++) {
      var av = cell(rows[assistantRows[ai]], col);
      if (av && av !== 'Class Assistant' && !assistantSeen[av.toLowerCase()]) {
        assistants.push(av);
        assistantSeen[av.toLowerCase()] = true;
      }
    }

    // Clean up title
    title = title.replace(/\s*\(This is a 2hr.*?\)/i, '').trim();

    electives.push({
      name: title,
      hour: hour,
      ageRange: String(ageRange),
      description: description,
      room: room,
      leader: leader,
      assistants: assistants,
      maxCapacity: Math.max(students.length + 3, 10),
      students: students
    });
  }

  h1Cols.forEach(function(c) { parseElective(c, 1); });
  h2Cols.forEach(function(c) { parseElective(c, 2); });

  // Parse support roles (floaters, board duties, supply closet)
  var supportRoles = {
    floaters: [],           // combined list (kept for backward compat)
    floatersPM1: [], floatersPM2: [],
    prepPeriodPM1: [], prepPeriodPM2: [],
    boardDutiesPM1: [], boardDutiesPM2: [],
    supplyCloset: []
  };

  // Label-column helpers. Hour section label column is hour{1,2}StartCol;
  // secondary labels like "Floaters" / "Board Duties" live one column to
  // the right. Fall back to historical col 6/19 if discovery failed.
  var h1LabelCol = hour1StartCol >= 0 ? hour1StartCol + 1 : 6;
  var h2LabelCol = hour2StartCol > 0 ? hour2StartCol + 1 : 19;

  // Floaters are in the column next to "Student Names" label. Collect each
  // hour's floaters into its own array, and mirror into the combined
  // `floaters` list for backward compat.
  var h1StudCol = hour1StartCol >= 0 ? hour1StartCol : 5;
  var h2StudCol = hour2StartCol > 0 ? hour2StartCol : 18;
  for (var r = 0; r < rows.length; r++) {
    if (cell(rows[r], h1StudCol) === 'Student Names' || cell(rows[r], h2StudCol) === 'Student Names') {
      var floaterColMap = [[h1LabelCol, 'floatersPM1'], [h2LabelCol, 'floatersPM2']];
      for (var fi = 0; fi < floaterColMap.length; fi++) {
        var flCol = floaterColMap[fi][0], flKey = floaterColMap[fi][1];
        if (cell(rows[r], flCol) === 'Floaters') {
          for (var fr = r + 1; fr < Math.min(r + 15, rows.length); fr++) {
            var fv = cell(rows[fr], flCol);
            if (!fv || fv === '|') continue;
            if (fv.match(/^(Prep Period|Board|Class|Supply|Student)/i)) break;
            if (supportRoles[flKey].indexOf(fv) === -1) supportRoles[flKey].push(fv);
            if (supportRoles.floaters.indexOf(fv) === -1) supportRoles.floaters.push(fv);
          }
        }
      }
    }
  }

  // Prep Period — same label-column layout as Floaters / Board Duties.
  for (var r = 0; r < rows.length; r++) {
    var ppColMap = [[h1LabelCol, 'prepPeriodPM1'], [h2LabelCol, 'prepPeriodPM2']];
    for (var pi = 0; pi < ppColMap.length; pi++) {
      var ppCol = ppColMap[pi][0], ppKey = ppColMap[pi][1];
      if (cell(rows[r], ppCol) === 'Prep Period') {
        for (var pr = r + 1; pr < Math.min(r + 8, rows.length); pr++) {
          var pv = cell(rows[pr], ppCol);
          if (!pv || pv === '|') continue;
          if (pv.match(/^(Board|Class|Supply|Student|Floaters)/i)) break;
          if (supportRoles[ppKey].indexOf(pv) === -1) supportRoles[ppKey].push(pv);
        }
      }
    }
  }

  // Board duties share the same label column as Floaters (one to the right
  // of each HOUR's label column).
  for (var r = 0; r < rows.length; r++) {
    var bdColMap2 = [[h1LabelCol, 'boardDutiesPM1'], [h2LabelCol, 'boardDutiesPM2']];
    for (var bi = 0; bi < bdColMap2.length; bi++) {
      var bdCol = bdColMap2[bi][0], bdKey = bdColMap2[bi][1];
      if (cell(rows[r], bdCol) === 'Board Duties') {
        for (var br = r + 1; br < Math.min(r + 5, rows.length); br++) {
          var bv = cell(rows[br], bdCol);
          if (!bv || bv === '|') continue;
          if (bv.match(/^(Student|Class)/i)) break;
          if (supportRoles[bdKey].indexOf(bv) === -1) supportRoles[bdKey].push(bv);
        }
      }
    }
  }

  // Supply closet
  for (var r = 0; r < rows.length; r++) {
    for (var c = 0; c < (rows[r] ? rows[r].length : 0); c++) {
      if (cell(rows[r], c) === 'Supply Closet') {
        for (var sr = r + 1; sr < Math.min(r + 3, rows.length); sr++) {
          var sv = cell(rows[sr], c);
          if (sv) supportRoles.supplyCloset.push(sv);
        }
      }
    }
  }

  return { electives: electives, supportRoles: supportRoles };
}

// ══════════════════════════════════════════════
// CLEANING CREW
// ══════════════════════════════════════════════
// Row 0: "Cleaning Crew Liaison: Name", Session 1..5
// Rows: area name, names per session
// Floor headers: MAIN FLOOR, UPSTAIRS, OUTSIDE
// Floater row at end

function parseCleaningCrew(rows) {
  if (!rows || rows.length < 2) return { liaison: '', sessions: {} };

  var header = rows[0];
  var liaisonStr = cell(header, 0);
  var liaison = liaisonStr.replace(/^Cleaning Crew Liaison:\s*/i, '').trim();

  // Count sessions from header
  var sessionCount = 0;
  for (var c = 1; c < header.length; c++) {
    if (cell(header, c).match(/Session\s+\d/i)) sessionCount++;
  }
  if (sessionCount === 0) sessionCount = 5;

  var sessions = {};
  for (var s = 1; s <= sessionCount; s++) {
    sessions[s] = { mainFloor: {}, upstairs: {}, outside: {} };
  }

  var currentFloor = 'mainFloor';

  for (var r = 1; r < rows.length; r++) {
    var area = cell(rows[r], 0);
    if (!area) continue;
    if (area.match(/^(MPR|FH|Cleaning Crew Tasks|\*|https)/i)) continue;

    if (area === 'MAIN FLOOR') { currentFloor = 'mainFloor'; continue; }
    if (area === 'UPSTAIRS') { currentFloor = 'upstairs'; continue; }
    if (area === 'OUTSIDE') { currentFloor = 'outside'; continue; }

    if (area.toLowerCase() === 'floater') {
      for (var s = 1; s <= sessionCount; s++) {
        var name = cell(rows[r], s);
        if (name) {
          if (!sessions[s].floater) sessions[s].floater = [];
          sessions[s].floater.push(name);
        }
      }
      continue;
    }

    // Regular area — may have multiple rows for same area
    for (var s = 1; s <= sessionCount; s++) {
      var name = cell(rows[r], s);
      if (name) {
        if (!sessions[s][currentFloor][area]) sessions[s][currentFloor][area] = [];
        sessions[s][currentFloor][area].push(name);
      }
    }
  }

  return { liaison: liaison, sessions: sessions };
}

// ══════════════════════════════════════════════
// VOLUNTEER COMMITTEES
// ══════════════════════════════════════════════
// Col 1: committee names and role titles
// Col 2: person names
// Chair lines: "Chair: Title-Name"
// Liaisons in cols 5-6

function parseVolunteerCommittees(rows) {
  if (!rows || rows.length < 2) return { committees: [], liaisons: [] };

  var committees = [];
  var liaisons = [];
  var current = null;

  // Parse liaisons from cols 5-6
  for (var r = 0; r < rows.length; r++) {
    var groupName = cell(rows[r], 5);
    var liaisonName = cell(rows[r], 6);
    if (groupName && liaisonName && !groupName.match(/AM Class|Liaison|Morning/i)) {
      liaisons.push({ group: groupName, person: liaisonName });
    }
  }

  // Parse committees from cols 1-2
  for (var r = 0; r < rows.length; r++) {
    var label = cell(rows[r], 1);
    var value = cell(rows[r], 2);
    if (!label) continue;

    if (label.match(/Committee\s*$/i)) {
      if (current) committees.push(current);
      current = { name: label.trim(), chair: null, roles: [] };
      continue;
    }

    if (label.match(/^Chair:/i) && current) {
      var parts = label.replace(/^Chair:\s*/i, '');
      var dashIdx = parts.lastIndexOf('-');
      if (dashIdx > -1) {
        current.chair = {
          title: parts.substring(0, dashIdx).trim(),
          person: parts.substring(dashIdx + 1).trim()
        };
      } else {
        current.chair = { title: parts.trim(), person: value };
      }
      continue;
    }

    if (current && !label.match(/^(Morning Class|See chart|>)/i)) {
      if (label.match(/^Afternoon Class Lia/i)) {
        current.roles.push({ title: 'Afternoon Class Liaison', person: value || '' });
      } else {
        current.roles.push({ title: label, person: value || '' });
      }
    }
  }
  if (current) committees.push(current);

  return { committees: committees, liaisons: liaisons };
}

// ══════════════════════════════════════════════
// SPECIAL EVENTS
// ══════════════════════════════════════════════
// Events in 3-column groups at cols 1, 4, 7
// Pattern: name, date, coordinator, support 1-5

function parseSpecialEvents(rows) {
  if (!rows || rows.length < 3) return [];

  var events = [];
  var eventCols = [1, 4, 7]; // Known column positions

  for (var r = 0; r < rows.length; r++) {
    for (var ci = 0; ci < eventCols.length; ci++) {
      var c = eventCols[ci];
      var name = cell(rows[r], c);
      if (!name) continue;

      // Check if next row has a date (contains a year like 2025 or 2026)
      if (r + 1 >= rows.length) continue;
      var dateStr = cell(rows[r + 1], c);
      if (!dateStr || !dateStr.match(/\d{4}/)) continue;

      // Coordinator row
      var coordStr = r + 2 < rows.length ? cell(rows[r + 2], c) : '';
      var coordinator = coordStr.replace(/^Coordinator:\s*/i, '').trim();

      // Support rows
      var support = [];
      for (var sr = r + 3; sr < Math.min(r + 10, rows.length); sr++) {
        var sv = cell(rows[sr], c);
        if (!sv || !sv.match(/^\d+\)/)) break;
        var person = sv.replace(/^\d+\)\s*/, '').trim();
        support.push(person);
      }

      // Auto-derive status from date
      var status = 'Planning';
      try {
        // Extract year and try multiple parsing strategies
        var yearMatch = dateStr.match(/(\d{4})/);
        if (yearMatch) {
          var year = yearMatch[1];
          // Fix common typos
          var fixedDate = dateStr.replace(/Debember/i, 'December').replace(/Sevice/i, 'Service');
          // For "October 17 OR 18, 2025" → use last number before year
          fixedDate = fixedDate.replace(/\s+OR\s+\d+/i, '');
          // For "March 30-April 1, 2026" → use the part after the dash
          var lastPart = fixedDate.replace(/.*[-–]\s*/, '').trim();
          if (!lastPart.match(/\d{4}/)) lastPart = lastPart + ', ' + year;
          var testDate = new Date(lastPart);
          if (isNaN(testDate.getTime())) testDate = new Date(fixedDate);
          if (!isNaN(testDate.getTime()) && testDate < new Date()) status = 'Complete';
        }
      } catch(e) {}
      // If no coordinator and not complete, mark as needs volunteers
      if (status !== 'Complete' && !coordinator) status = 'Needs Volunteers';

      events.push({
        name: name,
        date: dateStr,
        coordinator: coordinator,
        planningSupport: support,
        maxSupport: support.length || 3,
        status: status
      });
    }
  }

  return events;
}

// ══════════════════════════════════════════════
// CLASS IDEAS
// ══════════════════════════════════════════════
// Age group headers in specific columns, ideas listed below

function parseClassIdeas(rows) {
  if (!rows || rows.length < 3) return {};

  var ideas = {};
  var groupCols = [];

  // Find header row with age group names
  for (var r = 0; r < Math.min(5, rows.length); r++) {
    for (var c = 0; c < (rows[r] ? rows[r].length : 0); c++) {
      var v = cell(rows[r], c);
      if (v.match(/Early Years|Young Years|Middle.*Teen/i)) {
        var name = v.replace(/\s+/g, ' ').trim();
        groupCols.push({ col: c, name: name });
        ideas[name] = [];
      }
    }
    if (groupCols.length > 0) break;
  }

  for (var r = 2; r < rows.length; r++) {
    for (var g = 0; g < groupCols.length; g++) {
      var v = cell(rows[r], groupCols[g].col);
      if (v && !v.match(/^BOLD|^\*Popular|Submission Form/i)) {
        ideas[groupCols[g].name].push(v);
      }
    }
  }

  return ideas;
}

// ══════════════════════════════════════════════
// BILLING
// ══════════════════════════════════════════════
// Billing spreadsheet layout:
//   "Family Payment Tracking" tab:
//     Row 1 = headers, rows 2+ = data.
//     A = Family Name, B = Fall Deposit, C = Fall Fees,
//     D = Spring Deposit, E = Spring Fees.
//     Cell value "Paid" (case-insensitive) means paid; anything else → not paid.
//   "Morning Classes" tab: H2 = Sem1 rate, H3 = Sem2 rate.
//   "Afternoons" tab:     H2 = Sem1 rate, H3 = Sem2 rate.

function numFromCell(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  var s = String(raw).replace(/[$,\s]/g, '');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function parseBillingSheet(tabs) {
  var out = {
    rates: {
      fall: { amRate: 0, pmRate: 0 },
      spring: { amRate: 0, pmRate: 0 }
    },
    families: {}
  };

  var amTab = tabs['Morning Classes'] || [];
  if (amTab[1]) out.rates.fall.amRate = numFromCell(amTab[1][7]);
  if (amTab[2]) out.rates.spring.amRate = numFromCell(amTab[2][7]);

  var pmTab = tabs['Afternoons'] || [];
  if (pmTab[1]) out.rates.fall.pmRate = numFromCell(pmTab[1][7]);
  if (pmTab[2]) out.rates.spring.pmRate = numFromCell(pmTab[2][7]);

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
        deposit: statusOf(cell(row, 1)),
        classFee: statusOf(cell(row, 2))
      },
      spring: {
        deposit: statusOf(cell(row, 3)),
        classFee: statusOf(cell(row, 4))
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

  var parsed = parseBillingSheet(billingTabs);
  var schoolYear = String(req.query.school_year || activeSchoolYearLabel());

  // Sheet has no year column — old Paid markers carry across school years.
  // For 2026-27 specifically, the DB is the source of truth for the Fall
  // membership fee (registration auto-write). Wipe the sheet's Fall.deposit
  // values so a family who hasn't registered for 2026-27 doesn't inherit
  // last year's Paid status from the sheet.
  if (schoolYear === '2026-2027') {
    Object.keys(parsed.families).forEach(function (k) {
      if (parsed.families[k].fall) parsed.families[k].fall.deposit = '';
    });
  }

  // Overlay DB payment records on top of the sheet. Sheet still wins for
  // anything it explicitly marks Paid; DB Paid records (mostly from the
  // registration auto-write) light up cells the sheet hasn't touched yet,
  // and DB Pending records show "Pending" until the Treasurer confirms.
  // Scoped to the requested school_year so prior years' Paid markers
  // don't bleed into the current view.
  try {
    var sql = getDb();
    var dbRows = await sql`
      SELECT family_name, semester_key, payment_type, status
      FROM payments
      WHERE school_year = ${schoolYear}
        AND status IN ('Pending', 'Paid')
    `;
    dbRows.forEach(function (p) {
      var key = String(p.family_name || '').toLowerCase();
      var fam = parsed.families[key];
      if (!fam) {
        fam = { name: p.family_name, fall: { deposit: '', classFee: '' }, spring: { deposit: '', classFee: '' } };
        parsed.families[key] = fam;
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

async function handleBillingPost(req, res) {
  var body = req.body || {};
  var familyName = String(body.family_name || '').trim();
  var semesterKey = String(body.semester_key || '').trim();
  var paymentType = String(body.payment_type || '').trim();
  var schoolYear = String(body.school_year || activeSchoolYearLabel()).trim();
  var paypalId = String(body.paypal_transaction_id || '').trim();
  var amountCents = parseInt(body.amount_cents, 10) || 0;
  var payerEmail = String(body.payer_email || '').trim();

  if (!familyName) return res.status(400).json({ error: 'family_name required' });
  if (semesterKey !== 'fall' && semesterKey !== 'spring') {
    return res.status(400).json({ error: "semester_key must be 'fall' or 'spring'" });
  }
  if (paymentType !== 'deposit' && paymentType !== 'class_fee') {
    return res.status(400).json({ error: "payment_type must be 'deposit' or 'class_fee'" });
  }

  try {
    var sql = getDb();
    var rows = await sql`
      INSERT INTO payments (
        family_name, semester_key, payment_type, school_year,
        paypal_transaction_id, amount_cents, payer_email, status
      )
      VALUES (
        ${familyName}, ${semesterKey}, ${paymentType}, ${schoolYear},
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
// member_profiles stores family-editable values that override the Directory
// sheet for phone / address / per-parent pronouns + photos / per-kid
// pronouns, allergies, birth_date, schedule, photo. Non-empty DB values win;
// empty DB values fall through so membership@'s sheet edits still show up.

async function applyMemberProfileOverlay(families) {
  if (!Array.isArray(families) || families.length === 0) return;
  var sql = getDb();
  var rows = await sql`
    SELECT family_email, family_name, phone, address,
           parents, kids, placement_notes, additional_emails
    FROM member_profiles
  `;
  if (!rows || rows.length === 0) return;
  var byEmail = {};
  rows.forEach(function (r) {
    if (r.family_email) byEmail[String(r.family_email).toLowerCase()] = r;
  });

  families.forEach(function (fam) {
    var key = String(fam.email || '').toLowerCase();
    var p = byEmail[key];
    if (!p) return;

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

    // Phase 3: surface co-parent secondary login emails. The client uses this
    // to match the authenticated user's JWT email against ANY of the family's
    // emails, not just the derived primary. fam.email stays as the canonical
    // primary (still the member_profiles PK + the value used as family_email
    // in API requests).
    var addl = Array.isArray(p.additional_emails) ? p.additional_emails : [];
    var primary = String(fam.email || '').toLowerCase();
    var seen = primary ? { [primary]: true } : {};
    var loginEmails = primary ? [primary] : [];
    addl.forEach(function (ae) {
      var lc = String(ae || '').toLowerCase();
      if (lc && !seen[lc]) { seen[lc] = true; loginEmails.push(lc); }
    });
    fam.loginEmails = loginEmails;

    // Parents: merge pronouns and photoUrl onto the derived parent list.
    // parents are stored on the family as a "First & First" string; we expose
    // a parsed structure here (parentInfo) so the client can render per-parent
    // pronouns/photos without rebuilding the split logic.
    var parentFirstNames = String(fam.parents || '')
      .split(/\s*&\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
    var pMap = {};
    (p.parents || []).forEach(function (pp) {
      if (pp && pp.name) {
        var first = String(pp.name).trim().split(/\s+/)[0].toLowerCase();
        pMap[first] = pp;
      }
    });
    // Phase 4: surface role + per-person email/phone on parentInfo. When the
    // DB row hasn't been backfilled yet, default by position so the client
    // gets sensible values: parents[0] = mlc, [1] = blc, [2+] = parent.
    fam.parentInfo = parentFirstNames.map(function (n, idx) {
      // Match DB entry by FIRST WORD of the parsed sheet name. For a
      // compound name like "Aimee O'Connor", the sheet's parsed value is
      // "Aimee O'Connor" while the DB key is "aimee" — full-string lookup
      // would miss every time and create phantom duplicates.
      var firstWord = String(n).trim().split(/\s+/)[0].toLowerCase();
      var hit = pMap[firstWord] || {};
      var pronouns = hit.pronouns || (fam.parentPronouns && fam.parentPronouns[n]) || '';
      if (pronouns) {
        fam.parentPronouns = fam.parentPronouns || {};
        fam.parentPronouns[n] = pronouns;
      }
      // Prefer the DB-stored name when present so corrections (typo fixes,
      // updated spellings) flow through to display without waiting on a
      // sheet edit.
      var displayedName = hit.name || n;
      return {
        name: displayedName,
        pronouns: pronouns,
        photoUrl: hit.photo_url || '',
        // Explicit false opts the adult out; anything else (missing field, true)
        // stays consented so legacy rows and Directory-only families keep photos.
        photoConsent: hit.photo_consent !== false,
        role: hit.role || (idx === 0 ? 'mlc' : (idx === 1 ? 'blc' : 'parent')),
        email: hit.email || '',
        personalEmail: hit.personal_email || '',
        phone: hit.phone || ''
      };
    });
    // Any DB-only parents (name not yet in the sheet) appended so edits are
    // visible before the sheet catches up. Existence check uses FIRST WORD
    // so a DB entry "Aimee" doesn't get appended again when parentInfo
    // already has "Aimee O'Connor".
    (p.parents || []).forEach(function (pp) {
      if (!pp || !pp.name) return;
      var first = String(pp.name).trim().split(/\s+/)[0];
      var exists = fam.parentInfo.some(function (x) {
        return String(x.name || '').trim().split(/\s+/)[0].toLowerCase() === first.toLowerCase();
      });
      if (!exists) {
        var nextIdx = fam.parentInfo.length;
        fam.parentInfo.push({
          name: pp.name,
          pronouns: pp.pronouns || '',
          photoUrl: pp.photo_url || '',
          photoConsent: pp.photo_consent !== false,
          role: pp.role || (nextIdx === 0 ? 'mlc' : (nextIdx === 1 ? 'blc' : 'parent')),
          email: pp.email || '',
          personalEmail: pp.personal_email || '',
          phone: pp.phone || ''
        });
        if (pp.pronouns) {
          fam.parentPronouns = fam.parentPronouns || {};
          fam.parentPronouns[pp.name] = pp.pronouns;
        }
      }
    });
    // Re-sync the family's parents-string from the (possibly DB-corrected)
    // parentInfo names so downstream consumers (allPeople, Directory grid,
    // detail card heading) use the corrected name even when the sheet still
    // has the legacy spelling.
    fam.parents = fam.parentInfo.map(function (pi) { return pi.name; }).join(' & ');

    // Kids: match by first name (case-insensitive).
    var kMap = {};
    (p.kids || []).forEach(function (k) {
      if (k && k.name) {
        var first = String(k.name).trim().split(/\s+/)[0].toLowerCase();
        kMap[first] = k;
      }
    });
    (fam.kids || []).forEach(function (kid) {
      var first = String(kid.name || '').trim().split(/\s+/)[0].toLowerCase();
      var ov = kMap[first];
      if (!ov) return;
      if (ov.pronouns) kid.pronouns = ov.pronouns;
      if (ov.allergies) kid.allergies = ov.allergies;
      if (ov.birth_date) kid.birthDate = ov.birth_date;
      if (ov.schedule) kid.schedule = ov.schedule;
      if (ov.photo_url) kid.photoUrl = ov.photo_url;
      // photo_consent: explicit false opts the child out. Default when the
      // field is missing is consent=true so legacy rows keep their photos.
      kid.photo_consent = ov.photo_consent !== false;
    });
    // Append DB-only kids (not yet in the sheet).
    (p.kids || []).forEach(function (k) {
      if (!k || !k.name) return;
      var first = String(k.name).trim().split(/\s+/)[0];
      var exists = (fam.kids || []).some(function (x) {
        return String(x.name || '').trim().toLowerCase() === first.toLowerCase();
      });
      if (!exists) {
        fam.kids = fam.kids || [];
        fam.kids.push({
          name: first,
          group: '',
          schedule: k.schedule || 'all-day',
          pronouns: k.pronouns || '',
          allergies: k.allergies || '',
          birthDate: k.birth_date || '',
          photoUrl: k.photo_url || '',
          photo_consent: k.photo_consent !== false
        });
      }
    });
  });
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

async function participationCanRead(email) {
  if (!email) return false;
  if (String(email).toLowerCase() === SUPER_USER_EMAIL) return true;
  if (await canEditAsRole(email, 'Vice President')) return true;
  if (await canEditAsRole(email, 'Afternoon Class Liaison')) return true;
  return false;
}

async function participationCanWrite(email) {
  if (!email) return false;
  if (String(email).toLowerCase() === SUPER_USER_EMAIL) return true;
  return await canEditAsRole(email, 'Vice President');
}

function participationNormName(s) {
  if (!s) return '';
  return String(s)
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // strip pronouns
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function participationCurrentSeason() {
  // School year runs Aug–May. Anything before August rolls back a year.
  var now = new Date();
  var y = now.getFullYear();
  var start = now.getMonth() >= 7 ? y : y - 1; // month 7 = Aug
  var end = start + 1;
  return String(start).slice(2) + '_' + String(end).slice(2);
}

function participationYearBounds() {
  var season = participationCurrentSeason();
  var startYear = 2000 + parseInt(season.slice(0, 2), 10);
  return {
    start: new Date(startYear, 7, 1),       // Aug 1
    end: new Date(startYear + 1, 4, 31)     // May 31
  };
}

function participationBuildNameIndex(families) {
  var idx = {};
  (families || []).forEach(function (fam) {
    var famName = String(fam.name || '').trim();
    if (!famName) return;
    var famInitial = famName.charAt(0);
    var parentNames = String(fam.parents || '')
      .split(/\s*[&\/,]\s*/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    parentNames.forEach(function (first) {
      var canonical = participationNormName(first + ' ' + famName);
      idx[canonical] = canonical;
      idx[participationNormName(first + ' ' + famInitial)] = canonical;
      var fKey = '~first~' + participationNormName(first);
      if (!idx[fKey]) idx[fKey] = [];
      if (idx[fKey].indexOf(canonical) === -1) idx[fKey].push(canonical);
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

async function participationFetchSheetData(sheetsClient) {
  var directorySheetId = process.env.DIRECTORY_SHEET_ID;
  var masterSheetId = process.env.MASTER_SHEET_ID;

  // Fetch both sheets in parallel — on Vercel Hobby we're on a 10s budget
  // and the DB rollup still has to run after this.
  var directoryTabs = {}, masterTabs = {};
  var results = await Promise.all([
    fetchSheet(sheetsClient, directorySheetId).catch(function (e) { console.error('Directory fetch failed:', e.message); return {}; }),
    fetchSheet(sheetsClient, masterSheetId).catch(function (e) { console.error('Master fetch failed:', e.message); return {}; })
  ]);
  directoryTabs = results[0] || {};
  masterTabs = results[1] || {};

  var dirTab = directoryTabs['Directory'] || null;
  var classTab = directoryTabs['Classlist'] || null;
  var allergyTab = directoryTabs['Allergies'] || null;
  var dirParsed = parseDirectory(dirTab, classTab, allergyTab);
  var families = dirParsed.families || [];

  try { await applyMemberProfileOverlay(families); } catch (e) { /* sheet-only fine */ }

  // Default loginEmails = [primary] for every family, so the client can use
  // a single uniform shape (loginEmails.includes(...)) regardless of whether
  // the family had a member_profiles row when the overlay ran.
  families.forEach(function (fam) {
    if (!Array.isArray(fam.loginEmails)) {
      var primary = String(fam.email || '').toLowerCase();
      fam.loginEmails = primary ? [primary] : [];
    }
  });

  var amTab = null;
  for (var k1 in masterTabs) if (k1.match(/AM.*Volunteer/i)) { amTab = masterTabs[k1]; break; }
  var amClasses = amTab ? (parseAMClasses(amTab).classes || {}) : {};

  var pmElectives = {};
  for (var k2 in masterTabs) {
    var pmMatch = k2.match(/PM.*Session\s*(\d+)/i);
    if (pmMatch) {
      pmElectives[parseInt(pmMatch[1], 10)] = (parsePMElectives(masterTabs[k2]).electives || []);
    }
  }

  var cleanTab = null;
  for (var k3 in masterTabs) if (k3.match(/Cleaning/i)) { cleanTab = masterTabs[k3]; break; }
  var cleaningCrew = cleanTab ? parseCleaningCrew(cleanTab) : { liaison: '', sessions: {} };

  var volTab = null;
  for (var k4 in masterTabs) if (k4.match(/Year.*Volunteer/i)) { volTab = masterTabs[k4]; break; }
  var volParsed = volTab ? parseVolunteerCommittees(volTab) : { committees: [], liaisons: [] };

  var eventTab = null;
  for (var k5 in masterTabs) if (k5.match(/Special.*Event/i)) { eventTab = masterTabs[k5]; break; }
  var specialEvents = eventTab ? parseSpecialEvents(eventTab) : [];

  return {
    families: families,
    amClasses: amClasses,
    pmElectives: pmElectives,
    cleaningCrew: cleaningCrew,
    volunteerCommittees: volParsed.committees || [],
    classLiaisons: volParsed.liaisons || [],
    specialEvents: specialEvents
  };
}

async function buildParticipationReport(sql, data) {
  var families = data.families || [];
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

  function addTimeline(memberKey, sessionNum, entry) {
    var m = members[memberKey];
    if (!m || !sessionNum || !m.timeline[sessionNum]) return;
    m.timeline[sessionNum].push(entry);
  }

  // AM classes — counts per session per group
  var amClasses = data.amClasses || {};
  Object.keys(amClasses).forEach(function (groupName) {
    var cls = amClasses[groupName];
    var sessions = cls.sessions || {};
    Object.keys(sessions).forEach(function (sKey) {
      var sNum = parseInt(sKey, 10);
      var s = sessions[sKey] || {};
      var teacherKey = participationResolveName(s.teacher, nameIndex);
      if (teacherKey && members[teacherKey]) {
        members[teacherKey].counts.am_lead += 1;
        addTimeline(teacherKey, sNum, { category: 'am_lead', label: 'Leading AM — ' + groupName });
      }
      (s.assistants || []).forEach(function (a) {
        var aKey = participationResolveName(a, nameIndex);
        if (aKey && members[aKey]) {
          members[aKey].counts.am_assist += 1;
          addTimeline(aKey, sNum, { category: 'am_assist', label: 'Assisting AM — ' + groupName });
        }
      });
    });
  });

  // PM electives — "both hour" electives count twice
  var pmElectives = data.pmElectives || {};
  Object.keys(pmElectives).forEach(function (sKey) {
    var sNum = parseInt(sKey, 10);
    (pmElectives[sKey] || []).forEach(function (el) {
      var mult = el.hour === 'both' ? 2 : 1;
      var leaderKey = participationResolveName(el.leader, nameIndex);
      if (leaderKey && members[leaderKey]) {
        members[leaderKey].counts.pm_lead += mult;
        addTimeline(leaderKey, sNum, { category: 'pm_lead', label: 'Leading PM — ' + (el.name || '') + (mult === 2 ? ' (2-hr)' : '') });
      }
      (el.assistants || []).forEach(function (a) {
        var aKey = participationResolveName(a, nameIndex);
        if (aKey && members[aKey]) {
          members[aKey].counts.pm_assist += mult;
          addTimeline(aKey, sNum, { category: 'pm_assist', label: 'Assisting PM — ' + (el.name || '') + (mult === 2 ? ' (2-hr)' : '') });
        }
      });
    });
  });

  // Cleaning crew — one count per session per person (dedupe across areas)
  var cleaning = data.cleaningCrew || {};
  var cSessions = cleaning.sessions || {};
  Object.keys(cSessions).forEach(function (sKey) {
    var sNum = parseInt(sKey, 10);
    var s = cSessions[sKey] || {};
    var seen = {};
    function tally(name, label) {
      var key = participationResolveName(name, nameIndex);
      if (!key || !members[key] || seen[key]) return;
      seen[key] = true;
      members[key].counts.cleaning_session += 1;
      addTimeline(key, sNum, { category: 'cleaning_session', label: label });
    }
    ['mainFloor', 'upstairs', 'outside'].forEach(function (floor) {
      var areas = s[floor] || {};
      Object.keys(areas).forEach(function (area) {
        (areas[area] || []).forEach(function (n) { tally(n, 'Cleaning — ' + area); });
      });
    });
    (s.floater || []).forEach(function (n) { tally(n, 'Cleaning floater'); });
  });

  // Volunteer committees — chair = board role (annual, count once),
  // other roles = one-year role (count once per role held).
  (data.volunteerCommittees || []).forEach(function (comm) {
    if (comm.chair && comm.chair.person) {
      var ckey = participationResolveName(comm.chair.person, nameIndex);
      if (ckey && members[ckey]) {
        if (members[ckey].counts.board_role === 0) members[ckey].counts.board_role = 1;
        members[ckey].isBoard = true;
        if (comm.chair.title) members[ckey].roles.push(comm.chair.title);
      }
    }
    (comm.roles || []).forEach(function (role) {
      if (!role.person) return;
      String(role.person).split(/\s*[&\/,]\s*/).map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (p) {
        var k = participationResolveName(p, nameIndex);
        if (k && members[k]) {
          members[k].counts.one_year_role += 1;
          members[k].roles.push(role.title || 'Volunteer role');
        }
      });
    });
  });

  // AM class liaisons — counted as a 1-year role
  (data.classLiaisons || []).forEach(function (l) {
    if (!l.person) return;
    var k = participationResolveName(l.person, nameIndex);
    if (k && members[k]) {
      members[k].counts.one_year_role += 1;
      members[k].roles.push('AM Class Liaison — ' + (l.group || ''));
    }
  });

  // Special events
  (data.specialEvents || []).forEach(function (ev) {
    if (ev.coordinator) {
      var ck = participationResolveName(ev.coordinator, nameIndex);
      if (ck && members[ck]) {
        members[ck].counts.event_lead += 1;
        members[ck].roles.push('Event coordinator — ' + (ev.name || ''));
      }
    }
    (ev.support || []).forEach(function (n) {
      var k = participationResolveName(n, nameIndex);
      if (k && members[k]) members[k].counts.event_assist += 1;
    });
  });

  // Coverage given (not weighted — reported alongside)
  try {
    var coverageRows = await sql`
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
    var absRows = await sql`
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

  // New-member detection: first registration season is the current season
  var season = participationCurrentSeason();
  try {
    var regRows = await sql`
      SELECT LOWER(email) AS e, MIN(season) AS first_season
      FROM registrations
      GROUP BY LOWER(email)
    `;
    var regByEmail = {};
    regRows.forEach(function (r) { regByEmail[r.e] = r.first_season; });
    Object.keys(members).forEach(function (k) {
      var m = members[k];
      var emailLc = String(m.email || '').toLowerCase();
      var firstSeason = regByEmail[emailLc];
      if (firstSeason && firstSeason === season) m.isNewMember = true;
    });
  } catch (e) {
    console.error('Participation registrations query failed:', e.message);
  }

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
  var yearBounds = participationYearBounds();
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

async function handleParticipationAction(req, res, action, userEmail, authGivenName) {
  var sql = getDb();

  // Personal participation view — any authed @rootsandwingsindy.com member
  // can fetch their own row. Super user (communications@) can fetch any
  // family's row by passing ?email=<target> (used by the View As picker).
  if (action === 'participation-mine' && req.method === 'GET') {
    var emailLc = String(userEmail || '').toLowerCase();
    var isSuperUser = emailLc === SUPER_USER_EMAIL;
    var targetEmail = String((req.query && req.query.email) || userEmail || '').toLowerCase();
    if (!targetEmail) return res.status(400).json({ error: 'email required' });
    if (targetEmail !== emailLc && !isSuperUser) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    var auth = getAuth();
    var sheetsClient = google.sheets({ version: 'v4', auth: auth });
    var data = await participationFetchSheetData(sheetsClient);
    var report = await buildParticipationReport(sql, data);
    var familyMembers = (report.members || []).filter(function (m) {
      return String(m.email || '').toLowerCase() === targetEmail;
    });
    if (familyMembers.length === 0) {
      return res.status(200).json({ season: report.season, member: null });
    }
    // Prefer the parent matching the signed-in given_name. For super-user
    // view-as we can't disambiguate — fall back to the first parent.
    var mine = null;
    var gn = String(authGivenName || '').toLowerCase();
    if (gn && !isSuperUser) {
      for (var i = 0; i < familyMembers.length; i++) {
        if (String(familyMembers[i].first || '').toLowerCase() === gn) {
          mine = familyMembers[i];
          break;
        }
      }
    }
    if (!mine) mine = familyMembers[0];
    mine.tier = participationTier(mine.status);
    return res.status(200).json({ season: report.season, member: mine });
  }

  var canRead = await participationCanRead(userEmail);
  if (!canRead) return res.status(403).json({ error: 'Not authorized' });

  if (action === 'participation-report' && req.method === 'GET') {
    var auth = getAuth();
    var sheetsClient = google.sheets({ version: 'v4', auth: auth });
    var data = await participationFetchSheetData(sheetsClient);
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
      return res.status(403).json({ error: 'Vice President or super user only' });
    }
    var body = req.body || {};
    var key = String(body.key || '').trim();
    if (!key) return res.status(400).json({ error: 'key required' });
    var value = parseFloat(body.value);
    if (!Number.isFinite(value)) return res.status(400).json({ error: 'value must be a number' });
    var rows = await sql`
      UPDATE participation_weights
      SET value = ${value}, updated_by = ${userEmail}, updated_at = NOW()
      WHERE key = ${key}
      RETURNING key, value, updated_at
    `;
    if (rows.length === 0) return res.status(404).json({ error: 'weight key not found' });
    return res.status(200).json({ ok: true, weight: rows[0] });
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
      return res.status(403).json({ error: 'Vice President or super user only' });
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
          (${mEmail}, ${mName}, ${startDate}, ${endDateVal}, ${reason}, ${note}, ${userEmail})
        RETURNING *
      `;
    }
    return res.status(200).json({ ok: true, exemption: saved[0] });
  }

  if (action === 'participation-exemption-delete' && req.method === 'POST') {
    if (!(await participationCanWrite(userEmail))) {
      return res.status(403).json({ error: 'Vice President or super user only' });
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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Authentication required ──
  var authResult = await verifyAuth(req);
  if (!authResult.ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Billing sub-routes ──
  var action = (req.query && req.query.action) || '';
  if (action === 'billing') {
    try {
      var billingAuth = getAuth();
      var billingSheets = google.sheets({ version: 'v4', auth: billingAuth });
      if (req.method === 'GET') return handleBillingGet(req, res, billingSheets);
      if (req.method === 'POST') return handleBillingPost(req, res);
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
      return await handleParticipationAction(req, res, action, authResult.email, authResult.givenName || '');
    } catch (err) {
      console.error('Participation action error:', err);
      return res.status(500).json({ error: 'Participation request failed' });
    }
  }

  try {
    var auth = getAuth();
    var sheets = google.sheets({ version: 'v4', auth: auth });

    var directorySheetId = process.env.DIRECTORY_SHEET_ID;
    var masterSheetId = process.env.MASTER_SHEET_ID;

    // Fetch both spreadsheets
    var directoryTabs, masterTabs;
    var errors = [];
    try {
      directoryTabs = await fetchSheet(sheets, directorySheetId);
    } catch (e) {
      errors.push({ sheet: 'directory', error: 'Failed to fetch' });
      directoryTabs = {};
    }
    try {
      masterTabs = await fetchSheet(sheets, masterSheetId);
    } catch (e) {
      errors.push({ sheet: 'master', error: 'Failed to fetch' });
      masterTabs = {};
    }

    var result = { errors: errors };

    // ── Directory / Families ──
    var dirTab = directoryTabs['Directory'] || null;
    var classTab = directoryTabs['Classlist'] || null;
    var allergyTab = directoryTabs['Allergies'] || null;
    var dirParsed = parseDirectory(dirTab, classTab, allergyTab);
    result.families = dirParsed.families || [];
    result.groupMeta = dirParsed.groupMeta || {};

    // Overlay member_profiles (member self-edits). DB wins for any non-empty
    // field; blank DB fields fall through to the sheet value so membership@
    // can still import/correct data via the Sheet when needed.
    try {
      await applyMemberProfileOverlay(result.families);
    } catch (overlayErr) {
      console.error('Member profile overlay failed:', overlayErr);
      // fall through: sheet-only data still serves
    }

    // Default loginEmails = [primary] for every family — see buildSheetData
    // sibling for the shape rationale.
    result.families.forEach(function (fam) {
      if (!Array.isArray(fam.loginEmails)) {
        var primary = String(fam.email || '').toLowerCase();
        fam.loginEmails = primary ? [primary] : [];
      }
    });

    // ── AM Classes ──
    var amTab = null;
    for (var key in masterTabs) {
      if (key.match(/AM.*Volunteer/i)) { amTab = masterTabs[key]; break; }
    }
    if (amTab) {
      var amParsed = parseAMClasses(amTab);
      result.amClasses = amParsed.classes;
      result.amSupportRoles = amParsed.supportRoles;
    }

    // ── PM Electives (one tab per session) ──
    result.pmElectives = {};
    result.pmSupportRoles = {};
    for (var key in masterTabs) {
      var pmMatch = key.match(/PM.*Session\s*(\d+)/i);
      if (pmMatch) {
        var sessionNum = parseInt(pmMatch[1]);
        var pmParsed = parsePMElectives(masterTabs[key]);
        result.pmElectives[sessionNum] = pmParsed.electives;
        result.pmSupportRoles[sessionNum] = pmParsed.supportRoles;
      }
    }

    // ── Cleaning Crew ──
    var cleanTab = null;
    for (var key in masterTabs) {
      if (key.match(/Cleaning/i)) { cleanTab = masterTabs[key]; break; }
    }
    if (cleanTab) {
      result.cleaningCrew = parseCleaningCrew(cleanTab);
    }

    // ── Volunteer Committees ──
    var volTab = null;
    for (var key in masterTabs) {
      if (key.match(/Year.*Volunteer/i)) { volTab = masterTabs[key]; break; }
    }
    if (volTab) {
      var volParsed = parseVolunteerCommittees(volTab);
      result.volunteerCommittees = volParsed.committees;
      result.classLiaisons = volParsed.liaisons;
    }

    // ── Special Events ──
    var eventTab = null;
    for (var key in masterTabs) {
      if (key.match(/Special.*Event/i)) { eventTab = masterTabs[key]; break; }
    }
    if (eventTab) {
      result.specialEvents = parseSpecialEvents(eventTab);
    }

    // ── Class Ideas ──
    var ideasTab = null;
    for (var key in masterTabs) {
      if (key.match(/Class.*Idea/i)) { ideasTab = masterTabs[key]; break; }
    }
    if (ideasTab) {
      result.classIdeas = parseClassIdeas(ideasTab);
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
module.exports.fetchSheet = fetchSheet;
module.exports.getAuth = getAuth;
