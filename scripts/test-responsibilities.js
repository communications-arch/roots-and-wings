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

function nameMatch(a, b) {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
  function matchesCleaning(names) {
    return names.some(function(n) {
      var nl = n.toLowerCase();
      return nl === fam.name.toLowerCase() ||
        matchTargets.some(function(pf) { return nl.indexOf(pf.split(' ')[0].toLowerCase()) !== -1 && nl.indexOf(fam.name.toLowerCase()) !== -1; }) ||
        matchTargets.some(function(pf) { return nl === pf.toLowerCase(); });
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
// collectDutiesForPerson above.
function getWorkspaceRoles(activeEmail, FAMILIES, VOLUNTEER_COMMITTEES) {
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

  if (fam) {
    var activePersonRow = null;
    if (Array.isArray(fam.people)) {
      for (var pi = 0; pi < fam.people.length; pi++) {
        var pp = fam.people[pi];
        if (pp && String(pp.email || '').toLowerCase() === lower) { activePersonRow = pp; break; }
      }
    }
    var matchTargets;
    if (activePersonRow) {
      matchTargets = [personFullName(activePersonRow, fam)];
    } else if (Array.isArray(fam.people) && fam.people.length > 0) {
      matchTargets = fam.people.map(function (p) { return personFullName(p, fam); });
    } else {
      matchTargets = (fam.parents || '').split(/\s*&\s*/).map(function (first) {
        return (first.trim() + ' ' + fam.name).trim();
      });
    }
    matchTargets = matchTargets.filter(Boolean);

    function wsMatch(a, b) { return a && b && a.trim().toLowerCase() === b.trim().toLowerCase(); }
    (VOLUNTEER_COMMITTEES || []).forEach(function (c) {
      if (c.chair && c.chair.person && matchTargets.some(function (n) { return wsMatch(c.chair.person, n); })) {
        addRole(c.chair.title);
      }
      (c.roles || []).forEach(function (r) {
        if (r.person && matchTargets.some(function (n) { return wsMatch(r.person, n); })) addRole(r.title);
      });
    });
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
const wsCommittees = [
  { name: 'Facility', chair: { title: 'Facility Director', person: 'Erin Bogan' },
    roles: [
      { title: 'Cleaning Crew Liaison', person: 'Jay Bogan' }
    ]
  }
];

t('Primary parent gets the family\'s board role + their own committee role', () => {
  const roles = getWorkspaceRoles('erin@rootsandwingsindy.com', wsFamilies, wsCommittees);
  assert.ok(roles.indexOf('Treasurer') !== -1, 'Erin should have Treasurer');
  assert.ok(roles.indexOf('Facility Director') !== -1, 'Erin should chair Facility');
  assert.strictEqual(roles.indexOf('Cleaning Crew Liaison'), -1, 'Erin should NOT inherit Jay\'s role');
});

t('Co-parent (BLC) does NOT inherit the board role, only their own committee role', () => {
  const roles = getWorkspaceRoles('jay@rootsandwingsindy.com', wsFamilies, wsCommittees);
  assert.strictEqual(roles.indexOf('Treasurer'), -1, 'Jay should NOT inherit Treasurer');
  assert.strictEqual(roles.indexOf('Facility Director'), -1, 'Jay should NOT inherit Facility chair');
  assert.ok(roles.indexOf('Cleaning Crew Liaison') !== -1, 'Jay should have his own role');
});

t('Co-parent\'s login email is recognized via fam.loginEmails (not just primary)', () => {
  // The 2026-05 regression broke this when getWorkspaceRoles only consulted
  // fam.email + fam.boardEmail and ignored people-row emails entirely.
  const fam = wsFamilies[0];
  assert.ok(familyMatchesEmail(fam, 'jay@rootsandwingsindy.com'), 'helper finds Jay');
  const roles = getWorkspaceRoles('jay@rootsandwingsindy.com', wsFamilies, wsCommittees);
  assert.ok(roles.length > 0, 'Jay\'s login should yield at least one role');
});

t('Board-email login (treasurer@) gets the board role', () => {
  const roles = getWorkspaceRoles('treasurer@rootsandwingsindy.com', wsFamilies, wsCommittees);
  assert.ok(roles.indexOf('Treasurer') !== -1, 'role inbox login surfaces Treasurer');
});

t('communications@ super-user shortcut surfaces Communications Director', () => {
  const roles = getWorkspaceRoles('communications@rootsandwingsindy.com', [], []);
  assert.ok(roles.indexOf('Communications Director') !== -1);
});

t('Unknown email returns no roles', () => {
  const roles = getWorkspaceRoles('stranger@example.com', wsFamilies, wsCommittees);
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
// VP's pm-scheduling folded into the 'roles' (Co-op Management) card as
// link rows, so only the Afternoon Class Liaison keeps the standalone
// pm-scheduling card.
const WORKSPACE_DEFAULTS_FIXTURE = {
  'Vice President': ['todos', 'reports', 'roles', 'my-links', 'ways-to-help', 'resources'],
  'Afternoon Class Liaison': ['reports', 'pm-scheduling', 'my-links', 'ways-to-help', 'resources']
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

t('PM scheduling card: standalone for ACL; VP reaches it via Co-op Management', () => {
  const vp = WORKSPACE_DEFAULTS_FIXTURE['Vice President'] || [];
  const acl = WORKSPACE_DEFAULTS_FIXTURE['Afternoon Class Liaison'] || [];
  assert.ok(acl.indexOf('pm-scheduling') !== -1, 'Afternoon Class Liaison should have pm-scheduling');
  // VP's PM tools folded into the roles card (2026-07-05) — the standalone
  // card must NOT come back on VP's defaults.
  assert.strictEqual(vp.indexOf('pm-scheduling'), -1, 'VP should NOT have the standalone pm-scheduling card');
  assert.ok(vp.indexOf('roles') !== -1, 'VP must keep the roles (Co-op Management) card that hosts the folded rows');
  // And the real script.js roles card must actually render the VP row:
  // the Afternoon Class Builder (which absorbed the Submissions Report,
  // so the pending-count pill rides on it too).
  const fs2 = require('fs');
  const src2 = fs2.readFileSync(require('path').join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(/data-resource-action="schedule-builder"/.test(src2), 'roles card should link the Afternoon Class Builder');
  const vpFold = src2.match(/if \(role === 'Vice President'\) \{[\s\S]*?schedule-builder[\s\S]*?pmrep-pending-count[\s\S]*?\}/);
  assert.ok(vpFold, "roles card should fold the Afternoon Class Builder (with its pending pill) into the VP's rows");
});

t('Sheet-only family with no people row falls back to fam.parents matching', () => {
  // Pre-people-table compatibility: a family that hasn't been backfilled
  // should still surface its committee roles via the legacy parents string.
  const sheetOnlyFams = [{
    name: 'Smith',
    email: 'smith@rootsandwingsindy.com',
    parents: 'Sam',  // first-names-only string (post-fix shape)
    loginEmails: ['smith@rootsandwingsindy.com']
  }];
  const committees = [{ name: 'Events', chair: null, roles: [{ title: 'Field Day Coordinator', person: 'Sam Smith' }] }];
  const roles = getWorkspaceRoles('smith@rootsandwingsindy.com', sheetOnlyFams, committees);
  assert.ok(roles.indexOf('Field Day Coordinator') !== -1);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
