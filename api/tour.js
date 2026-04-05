const { Resend } = require('resend');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, phone, numKids, ages } = req.body;

  if (!name || !email || !phone || !numKids || !ages) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Basic validation
  if (String(name).length > 200 || String(email).length > 200 ||
      String(phone).length > 50 || String(ages).length > 200) {
    return res.status(400).json({ error: 'Input too long.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format.' });
  }

  // Sanitize all inputs
  const safeName = escapeHtml(name);
  const safeEmail = escapeHtml(email);
  const safePhone = escapeHtml(phone);
  const safeNumKids = escapeHtml(numKids);
  const safeAges = escapeHtml(ages);

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    const { data, error } = await resend.emails.send({
      from: 'Roots & Wings Website <noreply@rootsandwingsindy.com>',
      to: 'membership@rootsandwingsindy.com',
      replyTo: email,
      subject: `New Tour Request from ${safeName}`,
      html: `
        <h2>New Tour Request</h2>
        <table style="border-collapse:collapse;font-family:sans-serif;">
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Name</td><td style="padding:8px 0;">${safeName}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Email</td><td style="padding:8px 0;"><a href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Number of Kids</td><td style="padding:8px 0;">${safeNumKids}</td></tr>
          <tr><td style="padding:8px 16px 8px 0;font-weight:bold;">Ages</td><td style="padding:8px 0;">${safeAges}</td></tr>
        </table>
      `,
    });

    if (error) {
      console.error('Tour email error:', error);
      return res.status(500).json({ error: 'Failed to send. Please try again.' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Tour email error:', err);
    return res.status(500).json({ error: 'Failed to send. Please try again.' });
  }
};
