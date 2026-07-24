// Cover page for the printed Disaster Recovery binder.
//
// Sits in the clear front sleeve, so it has to answer three things without
// anyone opening the binder: what this is, when to open it, and who to call.
// Everything else is a pointer to the tabs inside.
//
// The contact line is READ OUT OF RESTORE.md rather than typed here — the
// age-band mess on 2026-07-23 was caused by nine hand-maintained copies of
// one fact, and a phone number in a binder is exactly the kind of thing that
// goes stale silently. One source, one place to update.
//
// Usage: node scripts/print-dr-cover.js [outputPath]
// Default output: DR-BINDER-COVER.html on the Desktop. Open it, Ctrl+P.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || path.join(os.homedir(), 'OneDrive', 'Desktop', 'DR-BINDER-COVER.html');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Pull the live facts out of RESTORE.md ────────────────────────────────
const restore = fs.readFileSync(path.join(ROOT, 'RESTORE.md'), 'utf8');
const warnings = [];

function fromRestore(re, label, fallback) {
  const m = restore.match(re);
  if (!m) { warnings.push('could not read ' + label + ' from RESTORE.md — using fallback'); return fallback; }
  return m[1].replace(/\*\*/g, '').trim();
}

const contact = fromRestore(
  /Communications Director \(runs this system\):\s*(.+)/,
  'the Communications Director contact',
  'Erin Bogan, Communications Director'
);

// ── Logo as a data URI so the page is self-contained on the Desktop ──────
let logoImg = '';
try {
  const svg = fs.readFileSync(path.join(ROOT, 'logo-combined.svg'));
  logoImg = '<img class="logo" alt="Roots &amp; Wings Indianapolis" src="data:image/svg+xml;base64,'
    + svg.toString('base64') + '">';
} catch (e) {
  warnings.push('logo-combined.svg not found — cover will use the wordmark only');
}

const tabs = [
  ['1', 'Disaster Recovery Plan', 'Systems map, failure scenarios, key accounts and their recovery info.'],
  ['2', 'RESTORE runbook', 'Step by step, from “the database is gone” to “the site is back up.”'],
  ['3', 'Sealed passphrase envelope', 'Decrypts the backups. Do not open except to restore — reseal after.'],
  ['4', 'Roles &amp; Committees', 'Who holds which job this year, and every open seat.']
];

const glance = [
  ['Backups run', 'Nightly, about 4:10am Indianapolis time. Encrypted.'],
  ['Kept for', 'The last 30 nights, plus the first backup of each month for a year.'],
  ['Stored in', 'Google Drive → Shared Drives → Communications → Backups'],
  ['NOT backed up', 'Uploaded photos and files. Google Docs are covered by Google’s own retention.']
];

const doc = `<!doctype html><html><head><meta charset="utf-8">
<title>Roots &amp; Wings — Disaster Recovery Binder (cover)</title>
<style>
  @page { margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    font: 13px Georgia, serif; color: #1b1b1b;
    margin: 0; padding: 28px 34px;
    max-width: 7.5in; margin-left: auto; margin-right: auto;
  }
  .logo { display: block; width: 260px; max-width: 60%; margin: 0 auto 22px; }
  .wordmark {
    text-align: center; font-family: Georgia, serif; letter-spacing: 3px;
    font-size: 12px; color: #4f5180; text-transform: uppercase; margin: 0 0 6px;
  }
  h1 {
    font-size: 40px; line-height: 1.04; letter-spacing: -0.5px;
    text-align: center; margin: 0 0 6px; color: #3d2b63;
  }
  h1 span { display: block; font-size: 21px; letter-spacing: 5px;
            text-transform: uppercase; color: #4f5180; margin-top: 8px; }
  .rule { border: 0; border-top: 2px solid #3d2b63; margin: 20px 0 0; }
  .when {
    text-align: center; font-size: 15px; font-style: italic;
    margin: 16px 0 22px; color: #333;
  }
  h2 {
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 2px;
    color: #4f5180; margin: 0 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid #d8d2c4;
  }
  section { margin: 0 0 20px; break-inside: avoid; page-break-inside: avoid; }
  .call {
    background: #f5f0e8; border-left: 4px solid #3d2b63;
    padding: 12px 16px; margin: 0 0 20px;
  }
  .call .who { font-size: 17px; font-weight: bold; margin: 0 0 4px; }
  .call p { margin: 4px 0 0; font-size: 12.5px; }
  ol.tabs { list-style: none; margin: 0; padding: 0; }
  ol.tabs li { display: flex; gap: 12px; margin: 0 0 9px; }
  ol.tabs .n {
    flex: 0 0 22px; height: 22px; border: 1.5px solid #3d2b63; border-radius: 50%;
    text-align: center; line-height: 19px; font-size: 12px; font-weight: bold; color: #3d2b63;
  }
  ol.tabs .t { font-weight: bold; }
  ol.tabs .d { display: block; font-weight: normal; color: #555; font-size: 11.5px; }
  table.glance { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.glance th {
    text-align: left; font-weight: bold; white-space: nowrap;
    padding: 5px 14px 5px 0; vertical-align: top; width: 1%;
  }
  table.glance td { padding: 5px 0; vertical-align: top; }
  table.glance tr + tr th, table.glance tr + tr td { border-top: 1px solid #ebe6db; }
  .copies { font-size: 12.5px; }
  .copies label { display: block; margin: 0 0 7px; }
  .box {
    display: inline-block; width: 12px; height: 12px;
    border: 1.5px solid #666; margin-right: 9px; vertical-align: -1px;
  }
  footer {
    margin-top: 24px; padding-top: 10px; border-top: 1px solid #d8d2c4;
    font-size: 10.5px; color: #777; text-align: center;
  }
</style></head><body>

${logoImg}
<p class="wordmark">Roots &amp; Wings &middot; Indianapolis</p>
<h1>Disaster<br>Recovery<span>Binder</span></h1>
<hr class="rule">
<p class="when">Open this if the website or its database is gone.</p>

<div class="call">
  <p class="who">Call first: ${esc(contact)}</p>
  <p>If you cannot reach her, go straight to <strong>Tab 2, the RESTORE runbook</strong>.
     It assumes no prior knowledge and is written to be followed by any developer.</p>
</div>

<section>
  <h2>What&rsquo;s inside</h2>
  <ol class="tabs">
    ${tabs.map(([n, t, d]) => `<li><span class="n">${n}</span><span class="t">${t}<span class="d">${d}</span></span></li>`).join('\n    ')}
  </ol>
</section>

<section>
  <h2>At a glance</h2>
  <table class="glance"><tbody>
    ${glance.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('\n    ')}
  </tbody></table>
</section>

<section class="copies">
  <h2>This copy lives at</h2>
  <label><span class="box"></span>The R&amp;W supply cabinet &mdash; <strong>includes</strong> the sealed passphrase envelope</label>
  <label><span class="box"></span>The Communications Director&rsquo;s home &mdash; no envelope</label>
</section>

<footer>
  Printed ${new Date().toLocaleDateString()} &middot;
  reprint whenever the contacts, the backup location, or the plan changes
</footer>

</body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, doc, 'utf8');
console.log('Wrote ' + OUT + ' (' + doc.length + ' chars)');
console.log('Contact line read from RESTORE.md: ' + contact);
warnings.forEach(w => console.log('⚠ ' + w));
