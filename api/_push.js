// Shared web-push helper (underscore prefix = not a Vercel route)

const webpush = require('web-push');
const { buildIdentityResolver } = require('./_permissions');

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

// #363: the recipient may have enabled push while signed in under a
// different one of their addresses (family alias / role mailbox / own
// login) than the one this notification is addressed to — fan out to the
// devices of every identity that means the same person.
async function subsForIdentities(sql, resolver, email) {
  const ids = resolver ? resolver.pushIdentitiesFor(email) : [String(email || '').toLowerCase()];
  if (!ids.length) return [];
  const rows = await sql`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE LOWER(user_email) = ANY(${ids}::text[])
  `;
  const seen = new Set();
  return rows.filter(r => { if (seen.has(r.endpoint)) return false; seen.add(r.endpoint); return true; });
}

async function sendToUser(sql, email, payload) {
  if (!init()) return;
  // Case-insensitive: subscription rows store whatever case the JWT
  // carried, while some callers pass lowercased emails.
  const subs = await subsForIdentities(sql, await buildIdentityResolver(sql), email);
  const results = [];
  for (const sub of subs) results.push(await trySend(sql, sub, payload));
  return results;
}

// "Every bell notification also alerts the device" (Erin, 2026-08-11): push a
// batch of freshly-INSERTed notification rows to their recipients. Pass the
// rows a caller got from `RETURNING id, recipient_email, title, body, link_url`.
// Per-recipient (so targeted notifications reach only their person) and safe
// for whole-membership broadcasts too — subs are cached per email so a big
// broadcast doesn't re-query. Non-path link_urls (e.g. "evspace:12", which the
// bell handles) fall back to /members.html for the push's click target.
async function pushNotifications(sql, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  if (!init()) return;
  const subsByEmail = {};
  const resolver = await buildIdentityResolver(sql);
  // A broadcast writes one row per adult login AND the family-alias row
  // now also delivers to the adults' devices — send each device one copy
  // of the same message per batch.
  const sentKeys = new Set();
  for (const r of rows) {
    const email = String(r.recipient_email || '').toLowerCase();
    if (!email) continue;
    if (!subsByEmail[email]) {
      subsByEmail[email] = await subsForIdentities(sql, resolver, email);
    }
    const url = (r.link_url && /^\//.test(r.link_url)) ? r.link_url : '/members.html';
    const payload = { title: r.title, body: r.body, tag: 'notif-' + (r.id || email), url };
    for (const sub of subsByEmail[email]) {
      const k = sub.endpoint + '|' + r.title + '|' + r.body;
      if (sentKeys.has(k)) continue;
      sentKeys.add(k);
      await trySend(sql, sub, payload);
    }
  }
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

module.exports = { sendToUser, broadcastAll, pushNotifications };
