// Unit tests for the member-facing Organization & Roles chart.
//
// buildOrgTreeHtml (script.js) is the pure HTML builder behind the modal:
// board roles head each branch (display_order), committee roles nest under
// their board parent via parent_role_id, holders render as chips, unfilled
// active roles get the "Open" pill, and the summary line counts filled vs
// open. Extracted from script.js the same way test-helpers.js does.
//
// Usage: node scripts/test-org-structure.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

// escapeHtml lives at the top of the IIFE; buildOrgTreeHtml depends on it.
const factory = new Function(
  extract('escapeHtml') + '\n' +
  extract('buildOrgTreeHtml') + '\n' +
  'return buildOrgTreeHtml;'
);
const buildOrgTreeHtml = factory();

const ROLES = [
  { id: 1, title: 'President', category: 'board', status: 'active', display_order: 1,
    committee: '', parent_role_id: null, job_length: '2 years', icon_emoji: '🌳',
    overview: 'Leads the co-op.', duties: ['Runs board meetings'] },
  { id: 2, title: 'Communications Director', category: 'board', status: 'active', display_order: 7,
    committee: '', parent_role_id: null, job_length: '', icon_emoji: '',
    overview: '', duties: [] },
  { id: 3, title: 'Welcome Coordinator', category: 'committee_role', status: 'active', display_order: 1,
    committee: 'Communications Committee', parent_role_id: 2, job_length: '1 year', icon_emoji: '',
    overview: 'Greets new families.', duties: ['Welcome table', 'New-family tours'] },
  { id: 4, title: 'Yearbook Coordinator', category: 'committee_role', status: 'active', display_order: 2,
    committee: 'Communications Committee', parent_role_id: 2, job_length: '', icon_emoji: '',
    overview: '', duties: [] },
  { id: 5, title: 'Retired Role', category: 'committee_role', status: 'archived', display_order: 3,
    committee: '', parent_role_id: 2, job_length: '', icon_emoji: '', overview: '', duties: [] },
  { id: 6, title: 'Orphan Role', category: 'committee_role', status: 'active', display_order: 1,
    committee: '', parent_role_id: null, job_length: '', icon_emoji: '', overview: '', duties: [] }
];
const HOLDERS = [
  { role_id: 1, person_name: 'Molly Bellner', email: 'president@x.com' },
  { role_id: 3, person_name: '', email: 'welcome@x.com' }
];

console.log('\nbuildOrgTreeHtml (script.js)');

t('summary counts filled vs open over ACTIVE roles only', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  // 5 active roles (archived excluded), 2 with holders.
  assert.ok(html.includes('2 of 5 roles filled'), 'filled count');
  assert.ok(html.includes('3 open'), 'open count');
});

t('held roles render holder chips; person_name falls back to email', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  assert.ok(html.includes('Molly Bellner'));
  assert.ok(html.includes('welcome@x.com'));
});

t('unfilled active roles get the Open pill; held ones do not', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  const openPills = (html.match(/org-open-pill/g) || []).length;
  assert.strictEqual(openPills, 3); // Comms Director, Yearbook, Orphan
});

t('committee roles nest under their board parent with the committee heading', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  assert.ok(html.includes('Communications Committee'));
  const commsIdx = html.indexOf('Communications Director');
  const welcomeIdx = html.indexOf('Welcome Coordinator');
  assert.ok(commsIdx !== -1 && welcomeIdx > commsIdx, 'child renders after its board parent');
});

t('archived roles are excluded entirely', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  assert.ok(!html.includes('Retired Role'));
});

t('parentless committee roles group under Other Volunteer Roles', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  assert.ok(html.includes('Other Volunteer Roles'));
  assert.ok(html.indexOf('Orphan Role') > html.indexOf('Other Volunteer Roles'));
});

t('descriptions render inline (overview + duties); empty ones get a placeholder', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, null);
  assert.ok(html.includes('Greets new families.'));
  assert.ok(html.includes('New-family tours'));
  assert.ok(html.includes('No description written for this role yet.'));
});

t('note renders when provided, escaped', () => {
  const html = buildOrgTreeHtml('2026-2027', ROLES, HOLDERS, 'showing <prior> year');
  assert.ok(html.includes('showing &lt;prior&gt; year'));
});

t('role titles and holder names are HTML-escaped', () => {
  const html = buildOrgTreeHtml('2026-2027',
    [{ id: 9, title: '<b>Sneaky</b>', category: 'board', status: 'active', display_order: 1,
       committee: '', parent_role_id: null, job_length: '', icon_emoji: '', overview: '', duties: [] }],
    [{ role_id: 9, person_name: '<i>Bad</i>', email: '' }], null);
  assert.ok(!html.includes('<b>Sneaky</b>'));
  assert.ok(html.includes('&lt;b&gt;Sneaky&lt;/b&gt;'));
  assert.ok(html.includes('&lt;i&gt;Bad&lt;/i&gt;'));
});

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
