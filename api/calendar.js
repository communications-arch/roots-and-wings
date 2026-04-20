const { google } = require('googleapis');
const { ALLOWED_ORIGINS } = require('./_config');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_CLIENT_ID = '915526936965-ibd6qsd075dabjvuouon38n7ceq4p01i.apps.googleusercontent.com';
const ALLOWED_DOMAIN = 'rootsandwingsindy.com';
const oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

async function verifyGoogleAuth(req) {
  var authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  try {
    var ticket = await oauthClient.verifyIdToken({
      idToken: authHeader.slice(7),
      audience: GOOGLE_CLIENT_ID
    });
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
    var threeMonths = new Date(now);
    threeMonths.setMonth(threeMonths.getMonth() + 3);

    var allEvents = [];

    for (var i = 0; i < CALENDAR_IDS.length; i++) {
      try {
        var result = await calendar.events.list({
          calendarId: CALENDAR_IDS[i],
          timeMin: now.toISOString(),
          timeMax: threeMonths.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50
        });
        if (result.data.items) {
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
        colorId: ev.colorId || ''
      };
    });

    res.status(200).json({ events: events });
  } catch (err) {
    console.error('Calendar API error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
};
