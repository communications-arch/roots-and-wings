// Morning-of reminder cron endpoint
// Triggered by Vercel Cron at 7 AM ET on Wednesdays (co-op day)
// Checks for uncovered slots today and broadcasts a reminder

const { neon } = require('@neondatabase/serverless');
const { broadcastAll } = require('./_push');

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

module.exports = async function handler(req, res) {
  // Cron jobs come from Vercel's infrastructure, verify with the cron secret if configured
  // For now, accept GET requests (Vercel crons use GET)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sql = getSql();

    // Get today's date in ET (UTC-5 or UTC-4 depending on DST)
    const now = new Date();
    // Approximate ET by subtracting 5 hours; for DST accuracy, use a proper TZ library in production
    const et = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const today = et.toISOString().slice(0, 10);

    // Find uncovered slots for today
    const openSlots = await sql`
      SELECT cs.id, cs.role_description, cs.block, a.absent_person
      FROM coverage_slots cs
      JOIN absences a ON a.id = cs.absence_id
      WHERE a.absence_date = ${today}
        AND a.cancelled_at IS NULL
        AND cs.claimed_by_email IS NULL
    `;

    if (openSlots.length === 0) {
      return res.status(200).json({ message: 'No open slots today', date: today });
    }

    const title = openSlots.length + ' slot' + (openSlots.length === 1 ? '' : 's') + ' still need coverage today!';
    const body = openSlots.map(s => s.block + ': ' + s.role_description).join(', ');

    // Insert morning_reminder notifications for all subscribed users
    const allSubs = await sql`SELECT DISTINCT user_email FROM push_subscriptions`;
    for (const sub of allSubs) {
      await sql`
        INSERT INTO notifications (recipient_email, type, title, body, link_url)
        VALUES (${sub.user_email}, 'morning_reminder', ${title}, ${body}, '#coverage')
      `;
    }

    // Broadcast push
    await broadcastAll(sql, {
      title: title,
      body: body,
      tag: 'morning-' + today,
      url: '/members.html#coverage'
    });

    return res.status(200).json({ message: 'Sent reminders', open_slots: openSlots.length, date: today });
  } catch (err) {
    console.error('Push-send cron error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};
