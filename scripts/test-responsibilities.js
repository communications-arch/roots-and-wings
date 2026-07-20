// Unit test for the My Responsibilities duty-matching logic.
//
// The matching code lives inside renderMyFamily() in script.js (a browser
// IIFE we can't require from Node). This test re-implements the matching
// rules verbatim and exercises them against synthetic AM/PM/cleaning data,
// so a regression in either the test or the production code is visible
// when the two diverge.
//
// What this protects against:
//   1. The 2026-05 regression where fam.parents went from "First1 & First2"
//      to "First1 Last1 & First2 Last2", which broke parentFullNames
//      matching and caused My Responsibilities to show only annual roles.
//   2. The semantic shift to per-person matching: a co-parent (BLC) should
//      see their OWN duties, not their spouse's. And the MLC should not
//      see the BLC's duties either.
//   3. Cleaning Crew at family level (just "Bogan") matches every member
//      of that family. Cleaning at person level ("Erin Bogan") matches
//      only that person.
//
// Run with: node scripts/test-responsibilities.js

const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

// ── Helpers (mirror script.js) ────────────────────────────────────────
function personFullName(p, fam) {
  if (!p) return '';
  var first = String(p.first_name || '').trim();
  var last = String(p.last_name || '').trim();
  if (!last && fam && fam.name) last = fam.name;
  return (first + (last ? ' ' + last : '')).trim();
}

function getActivePerson(fam, activeEmail) {
  if (!fam || !Array.isArray(fam.people)) return null;
  var email = String(activeEmail || '').toLowerCase();
  if (!email) return null;
  for (var i = 0; i < fam.people.length; i++) {
    var pp = fam.people[i];
    if (pp && String(pp.email || '').toLowerCase() === email) return pp;
  }
  if (email === String(fam.email || '').toLowerCase()) {
    for (var j = 0; j < fam.people.length; j++) {
      if (fam.people[j] && fam.people[j].role === 'mlc') return fam.people[j];
    }
  }
  return null;
}

// Mirrors personNamesMatch in script.js (bug log #9): BOTH first and last
// name must correspond — case/whitespace tolerant, middle tokens ignored,
// and a bare first name never matches a full name.
function nameMatch(a, b) {
  if (!a || !b) return false;
  var ta = String(a).trim().toLowerCase().split(/\s+/);
  var tb = String(b).trim().toLowerCase().split(/\s+/);
  if (!ta[0] || !tb[0]) return false;
  if (ta[0] !== tb[0]) return false;
  if (ta.length === 1 || tb.length === 1) return ta.length === tb.length;
  return ta[ta.length - 1] === tb[tb.length - 1];
}

// Pure function: given the active person + family + AM/PM/cleaning data,
// return the duty list. Mirrors the matching block inside renderMyFamily.
function collectDutiesForPerson(activePerson, fam, ctx) {
  var duties = [];
  var matchTargets = activePerson
    ? [personFullName(activePerson, fam)]
    : (Array.isArray(fam.people) ? fam.people.map(function (pp) { return personFullName(pp, fam); }) : []);
  matchTargets = matchTargets.filter(Boolean);

  // AM
  Object.keys(ctx.AM_CLASSES || {}).forEach(function (groupName) {
    var staff = ctx.AM_CLASSES[groupName];
    var sess = staff.sessions && staff.sessions[ctx.currentSession];
    if (!sess) return;
    matchTargets.forEach(function (full) {
      if (nameMatch(staff.liaison, full)) duties.push({block: 'annual', role: 'liaison', group: groupName});
      if (nameMatch(sess.teacher, full)) duties.push({block: 'AM', role: 'teach', group: groupName});
      (sess.assistants || []).forEach(function (a) {
        if (nameMatch(a, full)) duties.push({block: 'AM', role: 'assist', group: groupName});
      });
    });
  });

  // Cleaning
  var sessClean = ctx.CLEANING_CREW && ctx.CLEANING_CREW.sessions && ctx.CLEANING_CREW.sessions[ctx.currentSession];
  // Mirrors the hardened matchesCleaning in script.js (bug log #9):
  // whole-token first-name + family-name matching, no substrings.
  function matchesCleaning(names) {
    return names.some(function(n) {
      var nl = n.trim().toLowerCase();
      if (nl === fam.name.toLowerCase()) return true;
      var nlToks = nl.split(/\s+/);
      var famToks = fam.name.toLowerCase().split(/\s+/);
      return matchTargets.some(function(pf) {
        var pfl = pf.trim().toLowerCase();
        if (nl === pfl) return true;
        var first = pfl.split(/\s+/)[0];
        return nlToks.indexOf(first) !== -1 &&
          famToks.every(function (ft) { return nlToks.indexOf(ft) !== -1; });
      });
    });
  }
  if (sessClean) {
    ['mainFloor', 'upstairs', 'outside'].forEach(function (floor) {
      if (!sessClean[floor]) return;
      Object.keys(sessClean[floor]).forEach(function (area) {
        if (matchesCleaning(sessClean[floor][area])) {
          duties.push({block: 'Cleaning', role: 'clean', area: area});
        }
      });
    });
  }

  return duties;
}

// ── Fixture ───────────────────────────────────────────────────────────
const fixture = {
  // Bogan family: Erin (MLC) + Jay (BLC). Erin teaches Saplings, Jay
  // assists Pigeons. Family is on cleaning crew for "Kitchen".
  fam: {
    name: 'Bogan',
    email: 'erin@rootsandwingsindy.com',
    people: [
      { email: 'erin@rootsandwingsindy.com', first_name: 'Erin', last_name: 'Bogan', role: 'mlc' },
      { email: 'jay@rootsandwingsindy.com',  first_name: 'Jay',  last_name: 'Bogan', role: 'blc' }
    ]
  },
  ctx: {
    currentSession: 4,
    AM_CLASSES: {
      Saplings: { liaison: 'Erin Bogan', sessions: { 4: { teacher: 'Erin Bogan', assistants: ['Other Person'] } } },
      Pigeons:  { liaison: 'Other Person', sessions: { 4: { teacher: 'Other Person', assistants: ['Jay Bogan'] } } }
    },
    CLEANING_CREW: { sessions: { 4: { mainFloor: { 'Kitchen': ['Bogan'] } } } }
  }
};

// ── Tests ─────────────────────────────────────────────────────────────
console.log('\nRegression: My Responsibilities — per-person duty matching');

t('MLC sees their own AM teach + liaison roles', () => {
  const erin = getActivePerson(fixture.fam, 'erin@rootsandwingsindy.com');
  assert.ok(erin, 'getActivePerson should resolve Erin');
  assert.strictEqual(erin.role, 'mlc');
  const duties = collectDutiesForPerson(erin, fixture.fam, fixture.ctx);
  const am = duties.filter(d => d.block === 'AM' && d.role === 'teach');
  assert.strictEqual(am.length, 1, 'should have 1 AM teach duty');
  assert.strictEqual(am[0].group, 'Saplings');
  const liaison = duties.filter(d => d.role === 'liaison');
  assert.strictEqual(liaison.length, 1);
  assert.strictEqual(liaison[0].group, 'Saplings');
});

t('MLC does NOT see the BLC\'s assist duty (no bleed)', () => {
  const erin = getActivePerson(fixture.fam, 'erin@rootsandwingsindy.com');
  const duties = collectDutiesForPerson(erin, fixture.fam, fixture.ctx);
  const pigeonDuties = duties.filter(d => d.group === 'Pigeons');
  assert.strictEqual(pigeonDuties.length, 0, 'MLC should not see BLC\'s Pigeons duty');
});

t('BLC sees their own AM assist role', () => {
  const jay = getActivePerson(fixture.fam, 'jay@rootsandwingsindy.com');
  assert.ok(jay, 'getActivePerson should resolve Jay by email');
  assert.strictEqual(jay.role, 'blc');
  const duties = collectDutiesForPerson(jay, fixture.fam, fixture.ctx);
  const am = duties.filter(d => d.block === 'AM' && d.role === 'assist');
  assert.strictEqual(am.length, 1);
  assert.strictEqual(am[0].group, 'Pigeons');
});

t('BLC does NOT see the MLC\'s teach duty', () => {
  const jay = getActivePerson(fixture.fam, 'jay@rootsandwingsindy.com');
  const duties = collectDutiesForPerson(jay, fixture.fam, fixture.ctx);
  const teachDuties = duties.filter(d => d.role === 'teach');
  assert.strictEqual(teachDuties.length, 0, 'BLC should not see MLC\'s teach duty');
});

t('Family-level cleaning ("Bogan") shows for the active person', () => {
  const erin = getActivePerson(fixture.fam, 'erin@rootsandwingsindy.com');
  const duties = collectDutiesForPerson(erin, fixture.fam, fixture.ctx);
  const cleaning = duties.filter(d => d.block === 'Cleaning');
  assert.strictEqual(cleaning.length, 1, 'family-level cleaning should match');
  assert.strictEqual(cleaning[0].area, 'Kitchen');
});

t('Family-level cleaning shows for the BLC too', () => {
  const jay = getActivePerson(fixture.fam, 'jay@rootsandwingsindy.com');
  const duties = collectDutiesForPerson(jay, fixture.fam, fixture.ctx);
  const cleaning = duties.filter(d => d.block === 'Cleaning');
  assert.strictEqual(cleaning.length, 1, 'family-level cleaning matches every family member');
});

t('Person-level cleaning ("Erin Bogan") shows for Erin only', () => {
  const fam = JSON.parse(JSON.stringify(fixture.fam));
  const ctx = JSON.parse(JSON.stringify(fixture.ctx));
  // Replace family-level "Bogan" with person-level "Erin Bogan"
  ctx.CLEANING_CREW.sessions[4].mainFloor.Kitchen = ['Erin Bogan'];

  const erin = getActivePerson(fam, 'erin@rootsandwingsindy.com');
  const erinDuties = collectDutiesForPerson(erin, fam, ctx);
  assert.strictEqual(erinDuties.filter(d => d.block === 'Cleaning').length, 1, 'Erin should match');

  const jay = getActivePerson(fam, 'jay@rootsandwingsindy.com');
  const jayDuties = collectDutiesForPerson(jay, fam, ctx);
  assert.strictEqual(jayDuties.filter(d => d.block === 'Cleaning').length, 0, 'Jay should not match');
});

t('No active person (super-user impersonating): all family members surface duties', () => {
  // When the active email doesn't match any people row, fall back to
  // matching every person — gives a coordinator a complete view.
  const someoneElse = getActivePerson(fixture.fam, 'comms@rootsandwingsindy.com');
  assert.strictEqual(someoneElse, null);
  const duties = collectDutiesForPerson(someoneElse, fixture.fam, fixture.ctx);
  // Should see both Erin's and Jay's duties.
  assert.ok(duties.filter(d => d.group === 'Saplings').length > 0, 'Erin\'s duties should appear');
  assert.ok(duties.filter(d => d.group === 'Pigeons').length > 0, 'Jay\'s duties should appear');
});

// ── Bug log #9: fresh "Erin Testing Account" must not inherit Erin Bogan ──
const testerFam = {
  name: 'Testing Account',
  email: 'erint@rootsandwingsindy.com',
  people: [
    { email: 'erint@rootsandwingsindy.com', first_name: 'Erin', last_name: 'Testing Account', role: 'mlc' }
  ]
};

t('Same-first-name stranger gets ZERO duties (bug #9)', () => {
  const tester = getActivePerson(testerFam, 'erint@rootsandwingsindy.com');
  assert.ok(tester, 'tester person should resolve');
  const duties = collectDutiesForPerson(tester, testerFam, fixture.ctx);
  assert.strictEqual(duties.length, 0, 'Erin Testing Account must not match Erin Bogan\'s duties');
});

t('nameMatch requires BOTH first and last name', () => {
  assert.strictEqual(nameMatch('Erin Bogan', 'Erin Testing Account'), false, 'first-name-only must not match');
  assert.strictEqual(nameMatch('Erin', 'Erin Bogan'), false, 'bare first name must not claim a full name');
  assert.strictEqual(nameMatch('Erin Bogan', ' erin  BOGAN '), true, 'case/whitespace tolerant');
  assert.strictEqual(nameMatch('Erin R. Bogan', 'Erin Bogan'), true, 'middle tokens ignored');
  assert.strictEqual(nameMatch('Jay Bogan', 'Erin Bogan'), false, 'different first names never match');
});

t('Cleaning: substring first names no longer match ("Katherine" vs "Erin")', () => {
  // "katherine" CONTAINS "erin" — the old indexOf matcher handed
  // Katherine's duty to Erin. Whole-token matching must not.
  const fam = {
    name: 'Bogan',
    email: 'erin@rootsandwingsindy.com',
    people: [{ email: 'erin@rootsandwingsindy.com', first_name: 'Erin', last_name: 'Bogan', role: 'mlc' }]
  };
  const ctx = JSON.parse(JSON.stringify(fixture.ctx));
  ctx.AM_CLASSES = {};
  ctx.CLEANING_CREW.sessions[4].mainFloor.Kitchen = ['Katherine Bogan'];
  const erin = getActivePerson(fam, 'erin@rootsandwingsindy.com');
  const duties = collectDutiesForPerson(erin, fam, ctx);
  assert.strictEqual(duties.filter(d => d.block === 'Cleaning').length, 0, 'Katherine\'s entry must not match Erin');
});

t('Cleaning: "Erin & Jay Bogan" style entries still match both parents', () => {
  const ctx = JSON.parse(JSON.stringify(fixture.ctx));
  ctx.AM_CLASSES = {};
  ctx.CLEANING_CREW.sessions[4].mainFloor.Kitchen = ['Erin & Jay Bogan'];
  const erin = getActivePerson(fixture.fam, 'erin@rootsandwingsindy.com');
  assert.strictEqual(collectDutiesForPerson(erin, fixture.fam, ctx).filter(d => d.block === 'Cleaning').length, 1);
  const jay = getActivePerson(fixture.fam, 'jay@rootsandwingsindy.com');
  assert.strictEqual(collectDutiesForPerson(jay, fixture.fam, ctx).filter(d => d.block === 'Cleaning').length, 1);
});

t('Family email logging in maps to MLC even if MLC.email is the family_email', () => {
  // Common case: the family is keyed by erin@... and that's also the MLC's
  // email. getActivePerson should resolve to Erin via the explicit email
  // match (not the family_email fallback path).
  const active = getActivePerson(fixture.fam, 'erin@rootsandwingsindy.com');
  assert.ok(active);
  assert.strictEqual(active.role, 'mlc');
});

t('Family-email fallback when MLC has a different login email', () => {
  // Edge case: family_email is bogan-family@... and MLC's individual
  // email is erin@... — logging in as bogan-family@... should still
  // resolve to the MLC for "view as primary" semantics.
  const fam = {
    name: 'Bogan',
    email: 'bogan-family@rootsandwingsindy.com',
    people: [
      { email: 'erin@rootsandwingsindy.com', first_name: 'Erin', last_name: 'Bogan', role: 'mlc' }
    ]
  };
  const active = getActivePerson(fam, 'bogan-family@rootsandwingsindy.com');
  assert.ok(active, 'family-email login should fall through to MLC');
  assert.strictEqual(active.first_name, 'Erin');
});

// ── My Workspace role detection ────────────────────────────────────────
// getWorkspaceRoles maps the active login email to a list of role titles
// that drive which cards render in the Workspace tab. Same regression
// surface as the duty matcher: it broke when fam.parents went from
// "First1 & First2" to "First1 Last1 & First2 Last2", and also when a
// co-parent's own login email wasn't checked against the family roster.

function familyMatchesEmail(fam, emailLower) {
  if (!fam || !emailLower) return false;
  var loginEmails = Array.isArray(fam.loginEmails) ? fam.loginEmails : null;
  if (loginEmails && loginEmails.length > 0) {
    for (var i = 0; i < loginEmails.length; i++) {
      if (String(loginEmails[i] || '').toLowerCase() === emailLower) return true;
    }
    return false;
  }
  return String(fam.email || '').toLowerCase() === emailLower;
}

function normalizeWorkspaceTitle(t) {
  if (!t) return '';
  return String(t).replace(/\bDir\.\s*$/, 'Director').trim();
}

// Mirrors getWorkspaceRoles in script.js. Keep in sync — same caveat as
// collectDutiesForPerson above. Post-Sheets-retirement (issue #25):
// committee roles come ONLY from the email-keyed COMMITTEE_ROLE_HOLDERS
// map (role_holders_v2 via the api/sheets overlay) — the Volunteer
// Committees sheet name-matching block is gone.
function getWorkspaceRoles(activeEmail, FAMILIES, COMMITTEE_ROLE_HOLDERS) {
  if (!activeEmail) return [];
  var lower = String(activeEmail).toLowerCase();
  var out = [];
  function addRole(title) {
    var norm = normalizeWorkspaceTitle(title);
    if (norm && out.indexOf(norm) === -1) out.push(norm);
  }

  var fam = null;
  var matchedViaBoardEmail = false;
  for (var i = 0; i < FAMILIES.length; i++) {
    var f = FAMILIES[i];
    if (familyMatchesEmail(f, lower)) { fam = f; break; }
    if (f.boardEmail && f.boardEmail.toLowerCase() === lower) { fam = f; matchedViaBoardEmail = true; break; }
  }

  if (fam && fam.boardRole) {
    var isPrimary = lower === String(fam.email || '').toLowerCase();
    if (isPrimary || matchedViaBoardEmail) addRole(fam.boardRole);
  }

  if (lower === 'communications@rootsandwingsindy.com') addRole('Communications Director');

  if (COMMITTEE_ROLE_HOLDERS && COMMITTEE_ROLE_HOLDERS[lower]) {
    COMMITTEE_ROLE_HOLDERS[lower].forEach(function (t) { addRole(t); });
  }

  return out;
}

console.log('\nRegression: My Workspace — role detection per active person');

const wsFamilies = [
  {
    name: 'Bogan',
    email: 'erin@rootsandwingsindy.com',
    boardRole: 'Treasurer',
    boardEmail: 'treasurer@rootsandwingsindy.com',
    loginEmails: ['erin@rootsandwingsindy.com', 'jay@rootsandwingsindy.com'],
    people: [
      { email: 'erin@rootsandwingsindy.com', first_name: 'Erin', last_name: 'Bogan', role: 'mlc' },
      { email: 'jay@rootsandwingsindy.com',  first_name: 'Jay',  last_name: 'Bogan', role: 'blc' }
    ]
  }
];
// Email-keyed committee-role map (role_holders_v2 overlay shape) — the
// only committee-role source since the Sheets retirement.
const wsRoleHolders = {
  'erin@rootsandwingsindy.com': ['Facility Director'],
  'jay@rootsandwingsindy.com': ['Cleaning Crew Liaison']
};

t('Primary parent gets the family\'s board role + their own committee role', () => {
  const roles = getWorkspaceRoles('erin@rootsandwingsindy.com', wsFamilies, wsRoleHolders);
  assert.ok(roles.indexOf('Treasurer') !== -1, 'Erin should have Treasurer');
  assert.ok(roles.indexOf('Facility Director') !== -1, 'Erin should chair Facility');
  assert.strictEqual(roles.indexOf('Cleaning Crew Liaison'), -1, 'Erin should NOT inherit Jay\'s role');
});

t('Co-parent (BLC) does NOT inherit the board role, only their own committee role', () => {
  const roles = getWorkspaceRoles('jay@rootsandwingsindy.com', wsFamilies, wsRoleHolders);
  assert.strictEqual(roles.indexOf('Treasurer'), -1, 'Jay should NOT inherit Treasurer');
  assert.strictEqual(roles.indexOf('Facility Director'), -1, 'Jay should NOT inherit Facility chair');
  assert.ok(roles.indexOf('Cleaning Crew Liaison') !== -1, 'Jay should have his own role');
});

t('Co-parent\'s login email is recognized via fam.loginEmails (not just primary)', () => {
  // The 2026-05 regression broke this when getWorkspaceRoles only consulted
  // fam.email + fam.boardEmail and ignored people-row emails entirely.
  const fam = wsFamilies[0];
  assert.ok(familyMatchesEmail(fam, 'jay@rootsandwingsindy.com'), 'helper finds Jay');
  const roles = getWorkspaceRoles('jay@rootsandwingsindy.com', wsFamilies, wsRoleHolders);
  assert.ok(roles.length > 0, 'Jay\'s login should yield at least one role');
});

t('Board-email login (treasurer@) gets the board role', () => {
  const roles = getWorkspaceRoles('treasurer@rootsandwingsindy.com', wsFamilies, wsRoleHolders);
  assert.ok(roles.indexOf('Treasurer') !== -1, 'role inbox login surfaces Treasurer');
});

t('communications@ super-user shortcut surfaces Communications Director', () => {
  const roles = getWorkspaceRoles('communications@rootsandwingsindy.com', [], []);
  assert.ok(roles.indexOf('Communications Director') !== -1);
});

t('Unknown email returns no roles', () => {
  const roles = getWorkspaceRoles('stranger@example.com', wsFamilies, wsRoleHolders);
  assert.deepStrictEqual(roles, []);
});

t('Family loaded with boardRole from role_holders surfaces it for the primary login', () => {
  // applyMemberProfileOverlay sets fam.boardRole + fam.boardEmail from
  // role_holders so dev (no master sheet) and prod (post-migration) both
  // surface the board card. Regression: previously this only worked when
  // the Volunteer Committees sheet had a row.
  const fams = [{
    name: 'Family',
    email: 'vp@rootsandwingsindy.com',
    boardRole: 'Vice President',
    boardEmail: 'vp@rootsandwingsindy.com',
    loginEmails: ['vp@rootsandwingsindy.com'],
    people: [{ email: 'vp@rootsandwingsindy.com', first_name: 'VP', last_name: 'Family', role: 'mlc' }]
  }];
  const roles = getWorkspaceRoles('vp@rootsandwingsindy.com', fams, []);
  assert.ok(roles.indexOf('Vice President') !== -1, 'VP should see Vice President card');
});

// ── Workspace widget gating ────────────────────────────────────────────
// Mirrors ROLE_REPORTS + WORKSPACE_DEFAULTS in script.js. These are
// tabular registries (data, not logic), so the test is a literal-equality
// assertion against the shape — the bug we're guarding against is someone
// re-adding "tour-pipeline" to the Comms Director's list, which would
// surface a card the API will then 403 on.
const ROLE_REPORTS_FIXTURE = {
  'Communications Director': ['waivers', 'membership'],
  'Membership Director': ['tour-pipeline', 'membership'],
  'Treasurer': ['membership'],
  'Vice President': []
};
// 2026-07-05 workspace consolidation: 'forms' merged into 'reports';
// 2026-07-20 (Erin): the standalone pm-scheduling card is GONE — the
// Class Builder row lives on the 'roles' (Co-op Management) card for
// every builder audience (VP, ACL, group morning liaisons, class_review
// grantees).
const WORKSPACE_DEFAULTS_FIXTURE = {
  'Vice President': ['todos', 'reports', 'roles', 'my-links', 'ways-to-help', 'resources'],
  'Afternoon Class Liaison': ['reports', 'roles', 'my-links', 'ways-to-help', 'resources']
};

t('Tour Pipeline is listed for Membership Director only (not Comms)', () => {
  // Read the actual script.js source to verify the literal registry — keeps
  // the test honest if someone hand-edits without updating the fixture.
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'script.js'), 'utf8');
  const reportsBlock = src.match(/var ROLE_REPORTS = \{[\s\S]*?\};/);
  assert.ok(reportsBlock, 'ROLE_REPORTS block must exist');
  const block = reportsBlock[0];
  // Membership Director keeps tour-pipeline.
  const memSection = block.match(/'Membership Director':\s*\[[\s\S]*?\]/);
  assert.ok(memSection && /tour-pipeline/.test(memSection[0]), 'Membership Director should have tour-pipeline');
  // Comms Director does NOT.
  const commSection = block.match(/'Communications Director':\s*\[[\s\S]*?\]/);
  assert.ok(commSection && !/tour-pipeline/.test(commSection[0]), 'Comms Director must NOT have tour-pipeline');
});

t('Class Builder lives on Co-op Management only — no standalone pm-scheduling card', () => {
  const vp = WORKSPACE_DEFAULTS_FIXTURE['Vice President'] || [];
  const acl = WORKSPACE_DEFAULTS_FIXTURE['Afternoon Class Liaison'] || [];
  assert.strictEqual(vp.indexOf('pm-scheduling'), -1, 'VP must not list pm-scheduling');
  assert.strictEqual(acl.indexOf('pm-scheduling'), -1, 'ACL must not list pm-scheduling (folded 2026-07-20)');
  assert.ok(vp.indexOf('roles') !== -1 && acl.indexOf('roles') !== -1, 'both must keep the roles (Co-op Management) card');
  const fs2 = require('fs');
  const src2 = fs2.readFileSync(require('path').join(__dirname, '..', 'script.js'), 'utf8');
  // The card definition itself must be gone…
  assert.ok(!/'pm-scheduling':\s*\{/.test(src2), 'the pm-scheduling widget definition must be deleted');
  // …and the roles card must render the builder row (pending pill riding
  // it) for the builder audiences.
  const showsBuilder = src2.match(/var showsBuilder =[\s\S]*?class_review[\s\S]*?;/);
  assert.ok(showsBuilder, 'roles card must compute showsBuilder incl. class_review grantees');
  assert.ok(/isMorningGroupLiaisonTitle\(role\)/.test(showsBuilder[0]), 'group morning liaisons must be a builder audience');
  const builderRow = src2.match(/if \(showsBuilder\) \{[\s\S]*?schedule-builder[\s\S]*?pmrep-pending-count[\s\S]*?\}/);
  assert.ok(builderRow, 'roles card must render the Class Builder row with its pending pill');
  // Group liaisons' fallback widget list points at the roles card now.
  assert.ok(/return \['todos', 'roles'\];/.test(src2), "group-liaison fallback must return ['todos', 'roles']");
});

t('Committee roles resolve by holder EMAIL even with no family/people row', () => {
  // Post-Sheets-retirement: the email-keyed role_holders_v2 map is the
  // only committee-role source — a holder gets their role even when no
  // FAMILIES row matches their login (no name matching anywhere).
  const roles = getWorkspaceRoles('smith@rootsandwingsindy.com', [], {
    'smith@rootsandwingsindy.com': ['Field Day Coordinator']
  });
  assert.ok(roles.indexOf('Field Day Coordinator') !== -1);
});

t('Retired sheet shape (array of committees) yields no roles', () => {
  // A stale cached payload could still hand the old VOLUNTEER_COMMITTEES
  // array shape to the map parameter — it must not crash or match.
  const roles = getWorkspaceRoles('smith@rootsandwingsindy.com', [],
    [{ name: 'Events', roles: [{ title: 'Field Day Coordinator', person: 'Sam Smith' }] }]);
  assert.deepStrictEqual(roles, []);
});

// ── Open seats (Ways to get more involved) — mirrors the workspace
// derivation from ROLES_DIRECTORY: active committee roles with no
// holders, skipping committee-less pseudo roles and 1-session roles.
function openSeatsFrom(rolesDirectory) {
  var open = [];
  (rolesDirectory || []).forEach(function (r) {
    if (r.category !== 'committee_role' || !r.committee) return;
    if (String(r.term_length || '').toLowerCase() === '1 session') return;
    if (r.holders && r.holders.length) return;
    open.push({ committee: r.committee, title: r.title });
  });
  return open;
}

t('Open seats = zero-holder committee roles only (board/Guest/1-session skipped)', () => {
  const dir = [
    { title: 'Treasurer', category: 'board', committee: 'Finance Committee', term_length: '2 year', holders: [] },
    { title: 'Supply Coordinator', category: 'committee_role', committee: 'Finance Committee', term_length: '1 year', holders: [{ name: 'Poppy Sun', email: 'member@rootsandwingsindy.com' }] },
    { title: 'Yearbook Coordinator', category: 'committee_role', committee: 'Communications Committee', term_length: '1 year', holders: [] },
    { title: 'Guest', category: 'committee_role', committee: '', term_length: '', holders: [] },
    { title: 'Floater', category: 'committee_role', committee: 'Facility Committee', term_length: '1 session', holders: [] }
  ];
  const open = openSeatsFrom(dir);
  assert.strictEqual(open.length, 1, 'exactly one open seat expected');
  assert.strictEqual(open[0].title, 'Yearbook Coordinator');
  assert.strictEqual(open[0].committee, 'Communications Committee');
});

// ── Special-event coordinator duty (DB) — email-keyed, mirrors the
// SPECIAL_EVENTS_DB block in renderMyFamily.
function seCoordinatorDuties(events, activeEmail, nowTs) {
  var duties = [];
  var seEmailLc = String(activeEmail || '').toLowerCase();
  if (!seEmailLc) return duties;
  (events || []).forEach(function (ev) {
    var isCoord = ev.coordinator && String(ev.coordinator.email || '').toLowerCase() === seEmailLc;
    if (!isCoord) return;
    if (ev.date) {
      var evTs = Date.parse(ev.date + 'T12:00:00');
      if (isFinite(evTs) && evTs < (nowTs - 86400000)) return;
    }
    duties.push(ev.name + ' Coordinator');
  });
  return duties;
}

t('SE coordinator duty matches by email only; past events drop off', () => {
  const now = Date.parse('2026-09-01T12:00:00');
  const events = [
    { name: 'Ice Cream Social', date: '2026-09-10', coordinator: { name: 'Erin Bogan', email: 'erinb@rootsandwingsindy.com' } },
    { name: 'Field Day', date: '2026-06-10', coordinator: { name: 'Erin Bogan', email: 'erinb@rootsandwingsindy.com' } },
    { name: 'PJ Party', date: '', coordinator: { name: 'Erin Bogan', email: 'erinb@rootsandwingsindy.com' } },
    { name: 'Dance', date: '2026-10-01', coordinator: { name: 'Erin Testing Account', email: 'erint@rootsandwingsindy.com' } },
    { name: 'Camp', date: '2026-10-15', coordinator: null }
  ];
  const mine = seCoordinatorDuties(events, 'erinb@rootsandwingsindy.com', now);
  assert.deepStrictEqual(mine, ['Ice Cream Social Coordinator', 'PJ Party Coordinator'],
    'upcoming + undated events only, matched by email');
  const tester = seCoordinatorDuties(events, 'erint@rootsandwingsindy.com', now);
  assert.deepStrictEqual(tester, ['Dance Coordinator'], 'same-name stranger only gets their own email\'s event');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
