const { google } = require('googleapis');

function getAdminAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/admin.directory.user.readonly'],
    clientOptions: {
      subject: 'communications@rootsandwingsindy.com'
    }
  });
  return auth;
}

module.exports = async function handler(req, res) {
  var allowedOrigins = [
    'https://roots-and-wings-six.vercel.app',
    'https://roots-and-wings-erin-bogans-projects.vercel.app'
  ];
  var origin = req.headers.origin || '';
  if (allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Require auth (same as sheets endpoint)
  var authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ') && !authHeader.startsWith('Password ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (authHeader.startsWith('Password ')) {
    var pw = authHeader.slice(9);
    if (!pw || pw !== process.env.MEMBER_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    var auth = getAdminAuth();
    var admin = google.admin({ version: 'directory_v1', auth: auth });

    // List all users in the domain
    var users = [];
    var pageToken = null;
    do {
      var params = {
        domain: 'rootsandwingsindy.com',
        maxResults: 500,
        projection: 'basic',
        fields: 'users(primaryEmail,thumbnailPhotoUrl,name),nextPageToken'
      };
      if (pageToken) params.pageToken = pageToken;
      var result = await admin.users.list(params);
      if (result.data.users) {
        users = users.concat(result.data.users);
      }
      pageToken = result.data.nextPageToken;
    } while (pageToken);

    // Build email -> photo URL map
    var photos = {};
    users.forEach(function(user) {
      if (user.thumbnailPhotoUrl) {
        photos[user.primaryEmail] = user.thumbnailPhotoUrl;
      }
    });

    res.status(200).json({ photos: photos });
  } catch (err) {
    console.error('Photos API error:', err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
};
