#!/usr/bin/env node
// Persona Bench — pick the personas a change touches (issue #352, phase 2).
//
//   node qa/personas/pick.js lottery "sign-up windows"      # free-text
//   node qa/personas/pick.js --since v20260820b             # git range → keywords
//   node qa/personas/pick.js --since origin/master --json   # machine-readable
//
// Scores each persona file by how many of its "Run me when" words (plus the
// alias table below) appear in the query text. With --since, the query text
// is the commit subjects + changed file paths in <ref>..HEAD. Prints the top
// personas (score > 0), best first; the sweep skill runs the top 3–4.
//
// This is a heuristic, not a gate — the README's "Run me when" lines stay the
// source of truth and a human (or the sweep skill) can always override.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..', '..');

// Words in code/commits that imply a persona's world even when the
// "Run me when" prose uses different vocabulary.
const ALIASES = {
  'persona-reviewer':        ['signup', 'sign-up', 'signups', 'lottery', 'placement', 'schedules', 'vp', 'acl', 'overmax', 'window', 'picks', 'assist', 'class_signup', '_signup_todos'],
  'persona-age-edge':        ['age', 'ages', 'grove', 'band', 'eligib', 'out-of-range', 'groupForAge', 'warning'],
  'persona-half-day':        ['afternoon', 'morning-only', 'schedule', 'enrollment', 'kid_enrollments', 'pm1', 'pm2', 'coverage', 'absence'],
  'persona-newcomer':        ['onboard', 'waiver', 'registration', 'quickstart', 'empty', 'first-run', 'welcome', 'install', 'pwa'],
  'persona-welcomer':        ['welcome', 'registration', 'pipeline', 'welcome_outreach', 'orientation', 'community', 'upcoming'],
  'persona-treasurer':       ['billing', 'paypal', 'payment', 'payments', 'treasurer', 'finance', 'deposit', 'cash', 'membership report'],
  'persona-merch-manager':   ['merch', 'order', 'orders', 'catalog', 'stock', 'quick sale', 'heads-up', 'variant'],
  'persona-president':       ['board', 'roles', 'committees', 'calendar', 'board notes', 'permission', 'permissions', 'membership'],
  'persona-board-desk':      ['to do', 'todo', 'todos', 'reports', 'forms', 'admin', 'console', 'pipeline', 'waivers', 'onboarding', 'board notes', 'notification', 'notifications'],
  'persona-grove-liaison':   ['morning', 'grove', 'my grove', 'snack', 'facilities', 'builder', 'roster', 'liaison', 'classmates'],
  'persona-operations-crew': ['supply', 'closet', 'special event', 'events', 'jump in', 'seats', 'cleaning', 'opener', 'closer', 'lending'],
  'persona-coordinator':     ['workspace', 'pills', 'responsibilities', 'collaboration', 'discussion', 'points', 'badges', 'poll', 'section'],
  'persona-coverage-claimer':['absence', 'absences', 'coverage', 'duties', '_duties', 'claim', 'points', 'responsibilities']
};

function personaFiles() {
  return fs.readdirSync(DIR).filter(f => /^persona-.*\.md$/.test(f)).map(f => f.replace(/\.md$/, ''));
}
function runMeWhen(name) {
  const src = fs.readFileSync(path.join(DIR, name + '.md'), 'utf8');
  const m = src.match(/\*\*Run me when:\*\*([\s\S]*?)\n\n/);
  return (m ? m[1] : '').replace(/\([^)]*\)/g, ' ');
}
function title(name) {
  const src = fs.readFileSync(path.join(DIR, name + '.md'), 'utf8');
  const m = src.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : name;
}
function terms(text) {
  return Array.from(new Set(String(text).toLowerCase().split(/[^a-z0-9_\-]+/).filter(w => w.length > 2)));
}
const STOP = new Set(['the', 'and', 'any', 'run', 'when', 'change', 'changes', 'touched', 'template', 'one', 'note', 'which', 'seat', 'seats', 'with', 'for', 'this', 'that', 'are', 'its', 'own', 'each', 'has', 'also', 'after', 'big', 'she', 'all', 'see', 'hang', 'together', 'page', 'anything', 'shaped', 'logic', 'surface', 'flows', 'plumbing', 'rows', 'items', 'light', 'new', 'week', 'sees', 'family', 'exists', 'because', 'seam', 'produced', 'kid', 'placed', 'outside', 'their', 'literal', 'tripped', 'everywhere', 'four', 'below', 'lane', 'login', 'should', 'ship', 'multi', 'role', 'card', 'list', 'pages', 'standalone', 'modal', 'button', 'tile', 'item', 'then', 'size', 'color', 'form', 'report', 'sales', 'expenses', 'deposits', 'hand', 'homepage', 'gilmore', 'per', 'grove']);

function score(name, queryTerms) {
  const qs = new Set(queryTerms);
  const own = terms(runMeWhen(name)).filter(w => !STOP.has(w));
  const aliases = (ALIASES[name] || []).map(a => a.toLowerCase());
  const hits = new Set();
  own.forEach(w => { if (qs.has(w)) hits.add(w); });
  aliases.forEach(a => {
    if (a.includes(' ')) { if (queryTerms.join(' ').includes(a)) hits.add(a); }
    else if (qs.has(a) || queryTerms.some(q => q.startsWith(a) && a.length >= 5)) hits.add(a);
  });
  return { score: hits.size, hits: Array.from(hits).sort() };
}

function queryFromGit(ref) {
  const subjects = execSync(`git log --format=%s ${ref}..HEAD`, { cwd: ROOT }).toString();
  const files = execSync(`git diff --name-only ${ref}..HEAD`, { cwd: ROOT }).toString();
  return subjects + '\n' + files.replace(/[\/.]/g, ' ');
}

function main(argv) {
  const json = argv.includes('--json');
  const args = argv.filter(a => a !== '--json');
  let query;
  const si = args.indexOf('--since');
  if (si !== -1) {
    const ref = args[si + 1];
    if (!ref) { console.error('--since needs a git ref'); process.exit(2); }
    query = queryFromGit(ref);
  } else {
    query = args.join(' ');
  }
  if (!query.trim()) {
    console.error('usage: node qa/personas/pick.js <keywords…> | --since <git-ref> [--json]');
    process.exit(2);
  }
  const qt = terms(query);
  const ranked = personaFiles()
    .map(n => Object.assign({ name: n, title: title(n) }, score(n, qt)))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (json) { console.log(JSON.stringify({ query: qt.slice(0, 40), personas: ranked }, null, 2)); return; }
  if (!ranked.length) { console.log('No persona matched — pick by hand from qa/personas/README.md.'); return; }
  console.log('Personas this change touches (best first):\n');
  ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.title}  (${r.name}.md)  —  ${r.hits.join(', ')}`));
  console.log('\nSweep the top 3–4: /persona-sweep ' + ranked.slice(0, 4).map(r => r.name.replace(/^persona-/, '')).join(' '));
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { score, terms, personaFiles, ALIASES };
