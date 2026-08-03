const { google } = require('googleapis');
const { neon } = require('@neondatabase/serverless');
const { ALLOWED_ORIGINS } = require('./_config');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');

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

// ── #206: iCal (ICS) subscription feed ──────────────────────────────────
// The co-op Google Calendar is domain-internal by decision (2026-07-30),
// so personal Gmail / Apple / Outlook can't subscribe to it directly.
// This feed serves the same merged events as ICS, gated by a signed key
// in the URL — the "secret address" model — because calendar apps fetch
// subscriptions with no auth headers. The key is stable per environment
// (derived from ICS_FEED_KEY env or DATABASE_URL); rotating either env
// var invalidates every previously shared URL.
function icsFeedKey() {
  const base = process.env.ICS_FEED_KEY || process.env.DATABASE_URL || 'rw-ics-dev-fallback';
  return crypto.createHmac('sha256', 'rw-coop-ics-feed-v1').update(base).digest('base64url').slice(0, 32);
}
function icsKeyOk(candidate) {
  const want = Buffer.from(icsFeedKey());
  const got = Buffer.from(String(candidate || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// RFC 5545 text escaping + 75-octet-ish line folding.
function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  var out = '';
  while (line.length > 74) {
    out += line.slice(0, 74) + '\r\n ';
    line = line.slice(74);
  }
  return out + line;
}
function icsUtc(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function icsFromEvents(items) {
  var lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Roots & Wings Indy//Co-op Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Roots & Wings Indy',
    'X-WR-TIMEZONE:America/Indianapolis',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H'
  ];
  var stamp = icsUtc(new Date().toISOString());
  items.forEach(function (ev) {
    var allDay = !(ev.start && ev.start.dateTime);
    var startStr = ev.start && (ev.start.dateTime || ev.start.date);
    var endStr = ev.end && (ev.end.dateTime || ev.end.date);
    if (!startStr) return;
    lines.push('BEGIN:VEVENT');
    lines.push(icsFold('UID:' + icsEscape((ev.id || crypto.randomUUID()) + '@rootsandwingsindy.com')));
    lines.push('DTSTAMP:' + stamp);
    if (allDay) {
      // Google's all-day end date is already exclusive, matching RFC 5545.
      lines.push('DTSTART;VALUE=DATE:' + String(startStr).replace(/-/g, ''));
      if (endStr) lines.push('DTEND;VALUE=DATE:' + String(endStr).replace(/-/g, ''));
    } else {
      lines.push('DTSTART:' + icsUtc(startStr));
      if (endStr) lines.push('DTEND:' + icsUtc(endStr));
    }
    lines.push(icsFold('SUMMARY:' + icsEscape(ev.summary || 'Co-op event')));
    if (ev.location) lines.push(icsFold('LOCATION:' + icsEscape(ev.location)));
    if (ev.description) lines.push(icsFold('DESCRIPTION:' + icsEscape(ev.description)));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // #206: ICS mode authenticates by signed URL key (calendar apps can't
  // send headers); everything else requires a signed-in co-op account.
  var isIcs = !!(req.query && req.query.ics === '1');
  if (isIcs) {
    if (!icsKeyOk(req.query.key)) return res.status(404).send('Not found');
  } else if (!(await verifyGoogleAuth(req))) {
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

    if (isIcs) {
      // Rolling window for subscriptions: recent past for context, the
      // next ~13 months ahead — refreshing clients stay current across
      // the school-year boundary without ever re-subscribing.
      timeMin = new Date(now.getTime() - 60 * 24 * 3600 * 1000);
      timeMax = new Date(now.getTime() + 400 * 24 * 3600 * 1000);
      maxResults = 500;
    }

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

    if (isIcs) {
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'inline; filename="roots-and-wings-indy.ics"');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).send(icsFromEvents(allEvents));
    }

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
      // Approved special events publish to the SAME co-op calendar as field
      // trips (Erin, 2026-07-18); tag them 'special' so the client files them
      // under the Special Events pill rather than plain Co-op Days.
      var se = await sql`
        SELECT gcal_event_id FROM special_events WHERE gcal_event_id <> ''`;
      se.forEach(function (r) { boardTypeByGid[r.gcal_event_id] = 'special'; });
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

    // #206: hand signed-in members their subscribe-by-URL address — the
    // client shows it in the Calendar modal for personal Google / Apple /
    // Outlook. Built from the request host so dev serves dev URLs.
    var host = String(req.headers['x-forwarded-host'] || req.headers.host || 'www.rootsandwingsindy.com').split(',')[0].trim();
    var icsUrl = 'https://' + host + '/api/calendar?ics=1&key=' + icsFeedKey();

    res.status(200).json({ events: events, ics_url: icsUrl });
  } catch (err) {
    console.error('Calendar API error:', err);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
};

// #206 ICS helpers — pure, exported for the unit suite.
module.exports.icsFromEvents = icsFromEvents;
module.exports.icsEscape = icsEscape;
module.exports.icsFeedKey = icsFeedKey;
module.exports.icsKeyOk = icsKeyOk;
