// Regression gate — run before pushing to master.
//
// Two tiers:
//   Tier 1 (static): syntax check every JS file, JSON-parse every config file,
//                    grep for "landmine" patterns that would break prod.
//   Tier 2 (unit):   run the hand-rolled test scripts that don't need env vars
//                    (test-permissions, test-cleaning-seed, test-helpers).
//
// Usage: npm test   (or) node scripts/regression.js
// Exits non-zero on any failure so the pre-push hook can block the push.
//
// What this does NOT cover (on purpose):
//   - Live API tests (test-registration, test-tour-regression) — those hit the
//     DB and need .env.local. Run them manually before any risky DB change.
//   - Browser/UI behavior — we don't have a headless browser here.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT_JS = path.join(ROOT, 'script.js');
const API_DIR = path.join(ROOT, 'api');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  console.log('  \u2713 ' + name);
  passed++;
}
function fail(name, msg) {
  console.log('  \u2717 ' + name);
  if (msg) console.log('      ' + msg);
  failed++;
  failures.push(name + (msg ? ': ' + msg : ''));
}
function section(title) {
  console.log('\n' + title);
}

// ─── Tier 1a: syntax check every JS file ─────────────────────────────────
section('Tier 1a — syntax check');

const jsFiles = [SCRIPT_JS];
for (const f of fs.readdirSync(API_DIR)) {
  if (f.endsWith('.js')) jsFiles.push(path.join(API_DIR, f));
}
for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
  if (f.endsWith('.js')) jsFiles.push(path.join(ROOT, 'scripts', f));
}

for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status === 0) ok(rel);
  else fail(rel, (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' | '));
}

// ─── Tier 1b: JSON parse every config file ───────────────────────────────
section('Tier 1b — JSON parse');

const jsonFiles = ['vercel.json', 'package.json'];
const manifestCandidates = ['manifest.json', 'manifest.webmanifest'];
for (const m of manifestCandidates) {
  if (fs.existsSync(path.join(ROOT, m))) jsonFiles.push(m);
}
for (const f of jsonFiles) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) { ok(f + ' (not present — skip)'); continue; }
  try {
    JSON.parse(fs.readFileSync(full, 'utf8'));
    ok(f);
  } catch (err) {
    fail(f, err.message);
  }
}

// ─── Tier 1c: landmine grep ──────────────────────────────────────────────
// These are patterns that caused real bugs or leave the repo in a bad state.
// Each one has a comment explaining WHY so future devs can decide whether to
// extend or retire it.
section('Tier 1c — landmine grep');

const landmines = [
  {
    name: 'no `a.absence_id` in api/*.js',
    // The absences table PK is `id`, not `absence_id`. Writing `a.absence_id`
    // when the alias is `a` causes a 500 at runtime. (The coverage_slots
    // table does have `cs.absence_id` — that form is fine, which is why we
    // use a lookbehind to exclude any identifier chars before the `a`.)
    files: jsFilesIn(API_DIR),
    regex: /(?<![A-Za-z0-9_.])a\.absence_id\b/,
  },
  {
    name: 'no stray `debugger;` statements',
    files: [SCRIPT_JS, ...jsFilesIn(API_DIR)],
    regex: /^\s*debugger\s*;/m,
  },
  {
    name: 'no TODO-BEFORE-COMMIT / FIXME-NOW markers',
    files: [SCRIPT_JS, ...jsFilesIn(API_DIR)],
    regex: /TODO-BEFORE-COMMIT|FIXME-NOW/,
  },
  {
    name: 'no `[coverage]` debug console.logs',
    // We used `console.log('[coverage] ...')` while debugging the VP assign
    // bug. Left in prod, these spam the browser console on every board render.
    files: [SCRIPT_JS],
    regex: /console\.log\s*\(\s*['"`]\[coverage\]/,
  },
  {
    name: 'no `fam.parents.split` calls outside renderMyFamily/EMI seed',
    // After the people-table migration, fam.people[] is the canonical
    // per-person source. fam.parents is kept as a first-name-only
    // compatibility shim ("Erin & Michael") for the participation report
    // + a few legacy display strings, NOT for matching duties to people.
    // Any new `.parents.split(' & ')` is almost certainly the bug we
    // just fixed. The existing call sites are intentional (display-only
    // "Parents: ..." strings); raise this allowance only with a comment
    // explaining why.
    files: [SCRIPT_JS],
    regex: /\bfam\.parents\.split\s*\(\s*['"`]\s*&\s*['"`]\s*\)/,
    allowedHits: 12,
  },
  {
    name: 'no new direct `localStorage.getItem(\'rw_user_email\')` reads',
    // View As impersonation routes through `getActiveEmail()`. Direct reads of
    // localStorage skip the sessionStorage override and silently break the
    // impersonation flow. A handful of EXISTING reads are intentional:
    //   - getActiveEmail() itself (returns the raw value when no View As set)
    //   - isCommsUser() and super-user checks (super-user privileges follow the
    //     REAL account, not the impersonated one)
    //   - 401 diagnostic in fetchWithAuth
    //   - notifViewAsSuffix() (needs to know who is really viewing)
    //   - rwAuthHeaders() compares real vs. view-as to decide whether to
    //     emit the X-View-As header — needs the REAL identity
    // High-water mark: 9. If you add a 10th, prefer getActiveEmail() unless
    // the check is about the real user's identity; if it's intentional, bump
    // this number with a comment and ideally add the call to a named helper.
    files: [SCRIPT_JS],
    regex: /localStorage\.getItem\s*\(\s*['"]rw_user_email['"]\s*\)/,
    allowedHits: 9,
  },
];

function jsFilesIn(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f));
}

// ─── Tier 1d: cache-bust freshness ───────────────────────────────────────
// script.js gets cached aggressively by browsers. If the `?v=` string in
// the HTML doesn't change when script.js does, members keep running the
// old code — features silently disappear AND (worse) EMI saves can revert
// to stale form state. Hit on 2026-05-03 when ~1500 lines of script.js
// changed but `?v=20260430g` stayed.
//
// The check: index.html and members.html must reference the SAME `?v=`,
// and the version's date prefix must be >= the date of the last script.js
// commit (so a script.js touch always rides with a cache-bust bump).
section('Tier 1d — cache-bust freshness');
try {
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const mem = fs.readFileSync(path.join(ROOT, 'members.html'), 'utf8');
  const idxV = (idx.match(/script\.js\?v=([A-Za-z0-9._-]+)/) || [])[1];
  const memV = (mem.match(/script\.js\?v=([A-Za-z0-9._-]+)/) || [])[1];
  if (!idxV || !memV) {
    fail('cache-bust present in both index.html and members.html', 'missing ?v= in one or both');
  } else if (idxV !== memV) {
    fail('index.html and members.html share the same script.js ?v=', `index=${idxV}, members=${memV}`);
  } else {
    ok('index.html and members.html share script.js?v=' + idxV);
  }
  const dateMatch = (idxV || '').match(/^(\d{8})/);
  if (dateMatch) {
    const bustDate = dateMatch[1];
    let lastScriptDate = '';
    try {
      lastScriptDate = execFileSync('git', ['log', '-1', '--format=%cd', '--date=format:%Y%m%d', '--', 'script.js'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch (gitErr) {
      lastScriptDate = '';
    }
    if (lastScriptDate && lastScriptDate > bustDate) {
      fail('cache-bust date keeps up with script.js commits', `script.js last touched ${lastScriptDate}, bust=${bustDate}`);
    } else if (lastScriptDate) {
      ok('cache-bust date >= last script.js commit (' + lastScriptDate + ')');
    }
  }
} catch (err) {
  fail('cache-bust freshness check', err.message);
}

for (const lm of landmines) {
  let totalHits = 0;
  const hitFiles = [];
  for (const file of lm.files) {
    const body = fs.readFileSync(file, 'utf8');
    const matches = body.match(new RegExp(lm.regex.source, lm.regex.flags.includes('g') ? lm.regex.flags : lm.regex.flags + 'g'));
    if (matches && matches.length > 0) {
      totalHits += matches.length;
      hitFiles.push(path.relative(ROOT, file) + ' (' + matches.length + ')');
    }
  }
  const allowed = lm.allowedHits || 0;
  if (totalHits <= allowed) ok(lm.name + (allowed ? ' (≤' + allowed + ' allowed)' : ''));
  else fail(lm.name, totalHits + ' hit(s) in ' + hitFiles.join(', ') + '; allowed ' + allowed);
}

// ─── Tier 2: run unit test scripts ───────────────────────────────────────
section('Tier 2 — unit tests');

const unitTests = [
  'scripts/test-permissions.js',
  'scripts/test-cleaning-seed.js',
  'scripts/test-helpers.js',
  'scripts/test-reports.js',
  'scripts/test-coparent-auth.js',
  'scripts/test-responsibilities.js',
  'scripts/test-board-scope.js',
  'scripts/test-waiver-access.js',
  'scripts/test-new-member.js',
  'scripts/test-org-structure.js',
  'scripts/test-members-summary.js',
  'scripts/test-morning-builder.js',
  'scripts/test-board-calendar.js',
  'scripts/test-participation-season.js',
  'scripts/test-participation-settings.js',
  'scripts/test-welcome-lifecycle.js',
  'scripts/test-reg-invites.js',
  'scripts/test-billing-parse.js',
  'scripts/test-volunteer-assignments.js',
  'scripts/test-capabilities.js',
];

for (const rel of unitTests) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) { fail(rel, 'missing'); continue; }
  const r = spawnSync(process.execPath, [full], { encoding: 'utf8' });
  // Echo the child's own output so the user sees individual test names.
  process.stdout.write((r.stdout || '').split('\n').map(l => l ? '  ' + l : l).join('\n'));
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) ok(rel);
  else fail(rel, 'exit ' + r.status);
}

// ─── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
