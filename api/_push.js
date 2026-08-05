// Shared web-push helper (underscore prefix = not a Vercel route)

const webpush = require('web-push');

function init() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.warn('VAPID keys not configured — push notifications disabled');
    return false;
  }
  webpush.setVapidDetails('mailto:communications@rootsandwingsindy.com', pub, priv);
  return true;
}

// A push service's response tells us whether the subscription can EVER
// work again. 404/410 = gone. 403 = the subscription was created under a
// different VAPID key than we sign with — permanently dead too (FCM's
// VapidPkHashMismatch); keeping the row makes every future send fail
// silently. Anything else (429/5xx/network) is transient — keep the row.
function isDeadSubscription(err) {
  return err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403;
}

async function trySend(sql, sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { endpoint: sub.endpoint, ok: true };
  } catch (err) {
    if (isDeadSubscription(err)) {
      await sql`DELETE FROM push_subscriptions WHERE endpoint = ${sub.endpoint}`;
    }
    // Log the failure — these were swallowed for months, which is how
    // "notifications aren't working" stayed invisible (2026-08-05).
    // Endpoint host only: the full endpoint is a capability URL.
    let host = '';
    try { host = new URL(sub.endpoint).host; } catch (e) { /* ignore */ }
    console.error('[push] send failed', err.statusCode || err.message, host, isDeadSubscription(err) ? '(row deleted)' : '(kept, transient)');
    return { endpoint: sub.endpoint, ok: false, statusCode: err.statusCode || null, error: err.message, removed: isDeadSubscription(err) };
  }
}

async function sendToUser(sql, email, payload) {
  if (!init()) return;
  // Case-insensitive: subscription rows store whatever case the JWT
  // carried, while some callers pass lowercased emails.
  const subs = await sql`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(user_email) = LOWER(${email})
  `;
  const results = [];
  for (const sub of subs) results.push(await trySend(sql, sub, payload));
  return results;
}

async function broadcastAll(sql, payload) {
  if (!init()) return;
  const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions`;
  let ok = 0, failed = 0;
  for (const sub of subs) {
    const r = await trySend(sql, sub, payload);
    if (r.ok) ok++; else failed++;
  }
  console.log('[push] broadcast:', ok, 'delivered,', failed, 'failed of', subs.length);
}

module.exports = { sendToUser, broadcastAll };
