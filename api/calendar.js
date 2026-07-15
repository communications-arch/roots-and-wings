const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { verifyBearer } = require('./_auth');

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

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly']
  });
}

const CALENDAR_IDS = [
  'c_fdc0b20caba65262b9aac95ac1df638ab892fcdf1ee1ad79a1880dcc2a95b291@group.calendar.google.com',
  'c_f7e599c566fa32ba8da0c20bf51c82967e9d8aedffa8f775673db5146646b1b2@group.calendar.google.com'
];

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require authenticated @rootsandwingsindy.com Google account
  if (!(await verifyGoogleAuth(req))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    var auth = getAuth();
    var calendar = google.calendar({ version: 'v3', auth: auth });

    var now = new Date();
    var timeMin = now;
    var timeMax = new Date(now);
    timeMax.setMonth(timeMax.getMonth() + 3);
    var maxResults = 50;

    // ?range=year — the entire school calendar (Aug 1 → Jul 31),
    // including past events. July counts toward the UPCOMING school year
    // (the co-op year flips right after Field Day in June). Board admin
    // items never reach these Google calendars — only 'general' and
    // 'field_trip' board-calendar rows sync (GCAL_SYNCED_TYPES in
    // tour.js) — so no extra filtering is needed here.
    var range = String((req.query && req.query.range) || '');
    if (range === 'year') {
      var startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
      timeMin = new Date(Date.UTC(startYear, 7, 1, 4));      // ≈ midnight Aug 1, Indianapolis
      timeMax = new Date(Date.UTC(startYear + 1, 7, 1, 4));  // ≈ midnight Aug 1 next year
      maxResults = 250;
    }

    var allEvents = [];

    for (var i = 0; i < CALENDAR_IDS.length; i++) {
      try {
        var result = await calendar.events.list({
          calendarId: CALENDAR_IDS[i],
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: maxResults
        });
        if (result.data.items) {
          var srcId = CALENDAR_IDS[i];
          result.data.items.forEach(function (ev) { ev.__source = srcId; });
          allEvents = allEvents.concat(result.data.items);
        }
      } catch (e) {
        // Skip calendars that fail
      }
    }

    // Sort by start time
    allEvents.sort(function(a, b) {
      var aStart = a.start.dateTime || a.start.date;
      var bStart = b.start.dateTime || b.start.date;
      return new Date(aStart) - new Date(bStart);
    });

    // Board-calendar rows remember which Google event they created
    // (gcal_event_id) and what kind it is. Google events carry no colorId
    // or type of their own, so this lookup is what lets the client's
    // filter pills tell an imported Field Trip apart from a co-op day.
    var boardTypeByGid = {};
    try {
      var sql = neon(process.env.DATABASE_URL);
      var typed = await sql`
        SELECT gcal_event_id, event_type FROM board_calendar_events
        WHERE gcal_event_id <> ''`;
      typed.forEach(function (r) { boardTypeByGid[r.gcal_event_id] = r.event_type || ''; });
    } catch (e) {
      // Feed still works untyped if the DB hiccups.
    }

    // Format events
    var events = allEvents.map(function(ev) {
      var startStr = ev.start.dateTime || ev.start.date;
      var endStr = ev.end.dateTime || ev.end.date;
      var allDay = !ev.start.dateTime;
      return {
        summary: ev.summary || 'Untitled',
        start: startStr,
        end: endStr,
        allDay: allDay,
        location: ev.location || '',
        description: ev.description || '',
        colorId: ev.colorId || '',
        sourceCalendarId: ev.__source || '',
        boardType: boardTypeByGid[ev.id] || ''
      };
    });

    res.status(200).json({ events: events });
  } catch (err) {
    console.error('Calendar API error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
};
