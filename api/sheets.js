const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');

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
      return { ok: true, email: payload.email };
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
// Directory tab: col 0 = Parent name(s), col 1 = phone, col 2+ = children "Name (pronouns)"
// Classlist tab: row 0 = group names, row 1 = liaisons, row 2 = rooms, row 3+ = kids "FirstName LastInitial"
// Allergies tab: paired cols — group name, allergy — kids listed below

function parseDirectory(dirRows, classlistRows, allergyRows) {
  var families = [];

  if (!dirRows || dirRows.length < 2) return [];

  // Build allergy lookup from Allergies tab: { "firstname lastinitial" -> allergy }
  // Also track PM-only kids from the Allergies tab
  var allergyMap = {};
  var allergyPmOnly = {}; // lowercase name -> allergy
  if (allergyRows && allergyRows.length > 1) {
    // Paired columns: col 0 = group, col 1 = allergies, col 2 = group, col 3 = allergies...
    // Find PM ONLY column(s) - check headers for "PM ONLY" label
    var pmOnlyAllergyCol = -1;
    for (var r = 0; r < allergyRows.length; r++) {
      for (var c = 0; c < (allergyRows[r] ? allergyRows[r].length : 0); c++) {
        if (cell(allergyRows[r], c).match(/^PM ONLY$/i)) {
          pmOnlyAllergyCol = c;
          break;
        }
      }
      if (pmOnlyAllergyCol >= 0) break;
    }

    for (var c = 0; c < (allergyRows[0] ? allergyRows[0].length : 0); c += 2) {
      for (var r = 1; r < allergyRows.length; r++) {
        var kidName = cell(allergyRows[r], c).toLowerCase();
        var allergy = cell(allergyRows[r], c + 1);
        if (kidName) {
          allergyMap[kidName] = allergy;
        }
      }
    }

    // Parse PM ONLY column for allergies
    if (pmOnlyAllergyCol >= 0) {
      for (var r = 1; r < allergyRows.length; r++) {
        var kidName = cell(allergyRows[r], pmOnlyAllergyCol).toLowerCase();
        var allergy = cell(allergyRows[r], pmOnlyAllergyCol + 1);
        if (kidName && !kidName.match(/^pm only$/i)) {
          allergyPmOnly[kidName] = allergy;
          allergyMap[kidName] = allergy;
        }
      }
    }
  }

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

    // Extract parent name and pronouns
    // Format: "Amber Furnish (she/her)" or "Amber & Bobby Furnish"
    // Build parentPronouns map: { "FirstName": "she/her" }
    // Format: "Amber Furnish (she/her)" or "Amber & Bobby Furnish (she/her)"
    // Extract all (pronoun) blocks with the name that precedes them
    var parentPronouns = {};
    var pronRe = /(\S+)\s+\(([^)]+)\)/g;
    var pMatch;
    while ((pMatch = pronRe.exec(parentStr)) !== null) {
      // pMatch[1] is the word before parens (could be last name)
      // Walk back to find the first name of this parent
      var before = parentStr.substring(0, pMatch.index + pMatch[1].length);
      // Remove any prior parentheticals
      before = before.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      // Split by & to isolate this parent's name portion
      var segments = before.split(/\s*&\s*/);
      var lastSeg = segments[segments.length - 1].trim();
      var firstName = lastSeg.split(/\s+/)[0];
      if (firstName) parentPronouns[firstName] = pMatch[2].trim();
    }
    var parentClean = parentStr.replace(/\s*\([^)]*\)\s*/g, '').trim();
    // Extract last name — last word of the parent string
    var parentWords = parentClean.split(/\s+/);
    var familyName = parentWords[parentWords.length - 1];

    // Parse children from cols 2+
    var kids = [];
    for (var c = 2; c < (dirRows[r] ? dirRows[r].length : 0); c++) {
      var kidStr = cell(dirRows[r], c);
      if (!kidStr) continue;

      // Format: "Mackenna (she/her)" or just "Coen"
      var pronounMatch = kidStr.match(/\(([^)]+)\)/);
      var kidPronouns = pronounMatch ? pronounMatch[1] : '';
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

      // Look up allergies — try same keys, then scan by first name
      var allergy = allergyMap[lookupKey1] || allergyMap[lookupKey2] || '';
      if (!allergy) {
        var kidFirstLower2 = kidFirst.toLowerCase();
        for (var key in allergyMap) {
          if (key.split(' ')[0] === kidFirstLower2) {
            allergy = allergyMap[key];
            break;
          }
        }
      }

      kids.push({
        name: kidFirst,
        group: group,
        schedule: schedule,
        pronouns: kidPronouns,
        allergies: allergy
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

  // Overlay DB Pending records — but only where the sheet doesn't already
  // say Paid (sheet wins).
  try {
    var sql = getDb();
    var pendingRows = await sql('SELECT family_name, semester_key, payment_type FROM payments WHERE status = $1', ['Pending']);
    pendingRows.forEach(function (p) {
      var key = String(p.family_name || '').toLowerCase();
      var fam = parsed.families[key];
      if (!fam) {
        fam = { name: p.family_name, fall: { deposit: '', classFee: '' }, spring: { deposit: '', classFee: '' } };
        parsed.families[key] = fam;
      }
      var sem = fam[p.semester_key];
      if (!sem) return;
      var field = p.payment_type === 'deposit' ? 'deposit' : 'classFee';
      if (sem[field] !== 'Paid') sem[field] = 'Pending';
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
    var rows = await sql(
      'INSERT INTO payments (family_name, semester_key, payment_type, paypal_transaction_id, amount_cents, payer_email, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
      [familyName, semesterKey, paymentType, paypalId, amountCents, payerEmail, 'Pending']
    );
    return res.status(200).json({ ok: true, id: rows[0].id, created_at: rows[0].created_at });
  } catch (e) {
    console.error('Billing POST failed:', e.message);
    return res.status(500).json({ error: 'Failed to save pending payment' });
  }
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
