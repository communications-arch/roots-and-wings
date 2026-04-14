// Unit test for the cleaning-session seed logic.
//
// The real implementation lives inside script.js (a browser IIFE) so we can't
// require() it directly. Instead, this test replicates the post-building
// portion of ensureSessionSeeded() verbatim and exercises it against mock
// sheet state. If the logic in script.js ever diverges from this test, the
// test will silently pass against the wrong implementation — so keep them
// in sync when changing either.
//
// Run with: node scripts/test-cleaning-seed.js

const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (err) { console.log('  \u2717 ' + name + '\n      ' + err.message); failed++; }
}

// Mirrors the sheet-to-POST builder inside ensureSessionSeeded().
function buildSeedPosts(sessionNumber, cleaningDB, CLEANING_CREW) {
  function findAreaId(floorKey, areaName) {
    for (var i = 0; i < cleaningDB.areas.length; i++) {
      if (cleaningDB.areas[i].floor_key === floorKey && cleaningDB.areas[i].area_name === areaName) return cleaningDB.areas[i].id;
    }
    return null;
  }

  sessionNumber = parseInt(sessionNumber, 10);
  if (!sessionNumber) return null; // skipped
  const hasDB = (cleaningDB.assignments || []).some(a => a.session_number === sessionNumber);
  if (hasDB) return null; // would short-circuit (already seeded)

  const sess = CLEANING_CREW && CLEANING_CREW.sessions && CLEANING_CREW.sessions[sessionNumber];
  if (!sess) return [];

  const posts = [];
  ['mainFloor', 'upstairs', 'outside'].forEach(floor => {
    const floorData = sess[floor] || {};
    Object.keys(floorData).forEach(areaName => {
      const areaId = findAreaId(floor, areaName);
      if (!areaId) return;
      (floorData[areaName] || []).forEach(familyName => {
        if (familyName) posts.push({ session_number: sessionNumber, cleaning_area_id: areaId, family_name: familyName });
      });
    });
  });
  if (Array.isArray(sess.floater)) {
    const floaterId = findAreaId('floater', 'Floater');
    if (floaterId) {
      sess.floater.forEach(familyName => {
        if (familyName) posts.push({ session_number: sessionNumber, cleaning_area_id: floaterId, family_name: familyName });
      });
    }
  }
  return posts;
}

// ── Fixture: matches the shape of cleaningDB + CLEANING_CREW in script.js ──
const areasFixture = [
  { id: 1, floor_key: 'mainFloor', area_name: 'Main Classroom' },
  { id: 2, floor_key: 'mainFloor', area_name: 'Bathrooms' },
  { id: 3, floor_key: 'upstairs', area_name: 'Library' },
  { id: 4, floor_key: 'outside', area_name: 'Playground' },
  { id: 5, floor_key: 'floater', area_name: 'Floater' }
];

// ── Tests ───────────────────────────────────────────────────────────────
console.log('\nbuildSeedPosts');

t('returns null (skip) when session already has DB rows', () => {
  const cleaningDB = {
    areas: areasFixture,
    assignments: [{ session_number: 4, cleaning_area_id: 1, family_name: 'Existing' }]
  };
  const CC = { sessions: { 4: { mainFloor: { 'Main Classroom': ['Should not be seeded'] } } } };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts, null, 'expected null to signal short-circuit');
});

t('returns [] when there is no sheet data for the session', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = { sessions: {} };
  assert.deepStrictEqual(buildSeedPosts(4, cleaningDB, CC), []);
});

t('builds one POST per sheet-derived family in a single area', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = { sessions: { 4: { mainFloor: { 'Main Classroom': ['Smith', 'Jones'] } } } };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts.length, 2);
  assert.deepStrictEqual(posts[0], { session_number: 4, cleaning_area_id: 1, family_name: 'Smith' });
  assert.deepStrictEqual(posts[1], { session_number: 4, cleaning_area_id: 1, family_name: 'Jones' });
});

t('covers all three non-floater floors', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = {
    sessions: {
      4: {
        mainFloor: { 'Main Classroom': ['A'] },
        upstairs:  { 'Library': ['B'] },
        outside:   { 'Playground': ['C'] }
      }
    }
  };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  const names = posts.map(p => p.family_name).sort();
  assert.deepStrictEqual(names, ['A', 'B', 'C']);
});

t('covers the floater section via its own area record', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = { sessions: { 4: { floater: ['Wilson', 'Park'] } } };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[0].cleaning_area_id, 5);
  assert.strictEqual(posts[0].family_name, 'Wilson');
  assert.strictEqual(posts[1].family_name, 'Park');
});

t('skips areas that exist in the sheet but not in cleaning_areas', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = {
    sessions: {
      4: { mainFloor: { 'Unknown Room': ['Ghost'], 'Main Classroom': ['Real'] } }
    }
  };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts.length, 1, 'Unknown Room should be skipped');
  assert.strictEqual(posts[0].family_name, 'Real');
});

t('skips empty / falsy family names', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = { sessions: { 4: { mainFloor: { 'Main Classroom': ['', 'Valid', null, 'Also Valid'] } } } };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts.length, 2);
  assert.deepStrictEqual(posts.map(p => p.family_name), ['Valid', 'Also Valid']);
});

t('short-circuits on invalid session numbers', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = { sessions: { 4: { mainFloor: { 'Main Classroom': ['X'] } } } };
  assert.strictEqual(buildSeedPosts(0, cleaningDB, CC), null);
  assert.strictEqual(buildSeedPosts(null, cleaningDB, CC), null);
  assert.strictEqual(buildSeedPosts(undefined, cleaningDB, CC), null);
});

// Regression scenario that exactly matches Erin's bug:
//   sheet has multiple chips for session 4; DB has 0 rows; user clicks Add.
//   The seed must produce a POST for every chip so the subsequent
//   loadCleaningData() refresh doesn't wipe them.
t('regression: Erin\'s session-4 scenario preserves every sheet chip', () => {
  const cleaningDB = { areas: areasFixture, assignments: [] };
  const CC = {
    sessions: {
      4: {
        mainFloor: { 'Main Classroom': ['Bellner', 'Raymont'], 'Bathrooms': ['Smith'] },
        upstairs:  { 'Library': ['Shewan'] },
        outside:   { 'Playground': ['Newlin', 'Bogan'] },
        floater:   ['Furnish']
      }
    }
  };
  const posts = buildSeedPosts(4, cleaningDB, CC);
  assert.strictEqual(posts.length, 7, 'should produce one POST per existing chip');
  const seen = new Set(posts.map(p => p.family_name));
  ['Bellner', 'Raymont', 'Smith', 'Shewan', 'Newlin', 'Bogan', 'Furnish'].forEach(n => {
    assert(seen.has(n), 'expected ' + n + ' in seed posts');
  });
  posts.forEach(p => assert.strictEqual(p.session_number, 4));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
