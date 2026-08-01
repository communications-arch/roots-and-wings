// Unit tests for the Participation Settings live preview + scoring mirror.
//
// participationWeightSlug / participationScoreMember /
// computeParticipationPreview (script.js, extracted like test-new-member.js
// does) mirror the server's buildParticipationReport scoring so the
// Settings panel can show "before → after" status counts as the reviewer
// edits values — WITHOUT a round trip. If the server scoring in
// api/sheets.js changes (per-role/per-event keys, hour splits, thresholds,
// new-member pct, exemption handling), these tests are the tripwire that
// the client mirror must change too.
//
// 2026-08-01 points handoff: scoring resolves per-role ('role_<slug>') and
// per-event ('event_<slug>_lead|assist') weights from each member's
// roleDetail/eventDetail, with fallback to the legacy generic weights;
// class hours score per hour-slot (whole-morning AM = both AM hours).
//
// Bucketing matches the report's count strip: an active exemption always
// groups under Exempt, so weight changes never move an exempt member.
//
// Usage: node scripts/test-participation-settings.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

// ── Extract the client-side helpers from script.js ──────────────────────────
const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(
  extract('participationWeightSlug') + '\n' +
  extract('participationScoreMember') + '\n' +
  extract('computeParticipationPreview') + '\n' +
  'return { participationWeightSlug, participationScoreMember, computeParticipationPreview };'
);
const { participationWeightSlug, participationScoreMember, computeParticipationPreview } = factory();

// ── Fixtures ────────────────────────────────────────────────────────────────
// Weights shaped like the server's map (participation_weights key → value).
// NEW-scheme defaults from the 2026-08-01 handoff, plus the legacy generic
// keys that remain in the DB as fallbacks.
const BASE = {
  // legacy generics (fallback-only)
  board_role: 5, one_year_role: 2,
  am_lead: 2, am_assist: 1, pm_lead: 2, pm_assist: 1,
  event_lead: 2, event_assist: 1,
  // expanded scheme
  am_hour1_lead: 15, am_hour1_assist: 5, am_hour2_lead: 15, am_hour2_assist: 5,
  pm_hour1_lead: 15, pm_hour1_assist: 5, pm_hour2_lead: 15, pm_hour2_assist: 5,
  floater_slot: 5, cleaning_session: 3,
  role_president: 90, role_secretary: 65, role_willows_liaison: 30,
  role_safety_coordinator: 20,
  event_camp_lead: 30, event_camp_assist: 10,
  event_pj_party_lead: 10, event_pj_party_assist: 3.5,
  annual_expected_points: 14, new_member_baseline_pct: 60
};
function w(overrides) { return Object.assign({}, BASE, overrides || {}); }
function member(over) {
  return Object.assign({
    displayName: 'Test Member', counts: {}, roleDetail: [], eventDetail: [],
    isNewMember: false, exemption: null
  }, over || {});
}

console.log('\nparticipationWeightSlug (script.js)');

t('slugs live role/event titles to seeded key fragments', () => {
  assert.strictEqual(participationWeightSlug('Vice-President'), 'vice_president');
  assert.strictEqual(participationWeightSlug("Maker's Market"), 'maker_s_market');
  assert.strictEqual(participationWeightSlug('Gratitude/Encouragement Leader'), 'gratitude_encouragement_leader');
  assert.strictEqual(participationWeightSlug('Admin/Organization'), 'admin_organization');
  assert.strictEqual(participationWeightSlug('  PJ Party  '), 'pj_party');
  assert.strictEqual(participationWeightSlug(''), '');
  assert.strictEqual(participationWeightSlug(null), '');
});

console.log('\nparticipationScoreMember (script.js)');

t('AM class instance earns BOTH morning hour-slots (lead 30, assist 10)', () => {
  assert.strictEqual(participationScoreMember(member({ counts: { am_lead: 1 } }), w()), 30);
  assert.strictEqual(participationScoreMember(member({ counts: { am_assist: 2 } }), w()), 20);
});

t('PM hours score per hour bucket with their own weights', () => {
  const m = member({ counts: { pm_hour1_lead: 1, pm_hour2_lead: 1, pm_hour1_assist: 1 } });
  assert.strictEqual(participationScoreMember(m, w()), 35);
  assert.strictEqual(participationScoreMember(m, w({ pm_hour2_lead: 20 })), 40);
});

t('floater + cleaning use their per-slot / per-session weights', () => {
  const m = member({ counts: { floater_slot: 3, cleaning_session: 2 } });
  assert.strictEqual(participationScoreMember(m, w()), 3 * 5 + 2 * 3);
});

t('roles resolve per-role keys by slugged title', () => {
  const m = member({ roleDetail: [
    { title: 'President', category: 'board' },
    { title: 'Willows Liaison', category: 'committee_role' }
  ] });
  assert.strictEqual(participationScoreMember(m, w()), 120);
});

t('role without a dedicated key falls back to the generic tier weight', () => {
  const m = member({ roleDetail: [
    { title: 'Mystery Coordinator', category: 'committee_role' },
    { title: 'Mystery Director', category: 'board' }
  ] });
  assert.strictEqual(participationScoreMember(m, w()), 2 + 5);
});

t('events resolve per-event lead/assist keys; unknown events fall back', () => {
  const m = member({ eventDetail: [
    { name: 'Camp', role: 'lead' },        // 30
    { name: 'PJ Party', role: 'assist' },  // 3.5
    { name: 'Mystery Gala', role: 'lead' } // generic event_lead = 2
  ] });
  assert.strictEqual(participationScoreMember(m, w()), 35.5);
});

t('legacy DB (no expanded keys) scores with the old generic weights', () => {
  const legacy = {
    board_role: 5, one_year_role: 2, am_lead: 2, am_assist: 1,
    pm_lead: 2, pm_assist: 1, cleaning_session: 1, event_lead: 2,
    event_assist: 1, annual_expected_points: 14, new_member_baseline_pct: 60
  };
  const m = member({
    counts: { am_lead: 1, am_assist: 1, pm_hour1_lead: 1, pm_hour2_assist: 1, cleaning_session: 1 },
    roleDetail: [{ title: 'President', category: 'board' }],
    eventDetail: [{ name: 'Camp', role: 'lead' }]
  });
  // 2 + 1 + 2 + 1 + 1 + 5 + 2
  assert.strictEqual(participationScoreMember(m, legacy), 14);
});

t('string weight values are parsed (DB returns numerics as strings)', () => {
  const m = member({ counts: { cleaning_session: 2 }, roleDetail: [{ title: 'Secretary', category: 'board' }] });
  assert.strictEqual(participationScoreMember(m, w({ cleaning_session: '3', role_secretary: '65' })), 71);
});

t('empty member scores 0 (no NaN poisoning)', () => {
  assert.strictEqual(participationScoreMember(member(), w()), 0);
  assert.strictEqual(participationScoreMember(member({ counts: { cleaning_session: 50 } }), {}), 0);
});

console.log('\ncomputeParticipationPreview (script.js)');

t('same weights in and out → counts === was, no changes', () => {
  const members = [
    member({ roleDetail: [{ title: 'Secretary', category: 'board' }] }), // 65 → on_track
    member({ counts: { cleaning_session: 1 } })                          // 3 → behind
  ];
  const p = computeParticipationPreview(members, w(), w());
  assert.deepStrictEqual(p.counts, p.was);
  assert.strictEqual(p.changes.length, 0);
});

t('meets goal exactly → on_track (threshold is ≥, not >)', () => {
  const m = member({ counts: { cleaning_session: 1 } }); // 3
  const p = computeParticipationPreview([m], w({ annual_expected_points: 3 }), w({ annual_expected_points: 3 }));
  assert.strictEqual(p.counts.on_track, 1);
});

t('≥ 80% of goal → near ("Close")', () => {
  const m = member({ counts: { cleaning_session: 4 } }); // 12; 11.2 ≤ 12 < 14
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.near, 1);
});

t('below 80% of goal → behind', () => {
  const m = member({ counts: { cleaning_session: 3 } }); // 9 < 11.2
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.behind, 1);
});

t('raising the annual goal moves an on-track member and reports the change', () => {
  const m = member({ displayName: 'Riley Chen', counts: { pm_hour1_lead: 1 } }); // 15 ≥ 14
  const p = computeParticipationPreview([m], w(), w({ annual_expected_points: 166 }));
  assert.strictEqual(p.was.on_track, 1);
  assert.strictEqual(p.counts.behind, 1);
  assert.deepStrictEqual(p.changes, [{ name: 'Riley Chen', from: 'on_track', to: 'behind' }]);
});

t('raising one role\'s value moves that holder up', () => {
  const m = member({ roleDetail: [{ title: 'Safety Coordinator', category: 'committee_role' }] }); // 20... goal 14 → on_track already; use goal 30
  const p = computeParticipationPreview([m], w({ annual_expected_points: 30 }), w({ annual_expected_points: 30, role_safety_coordinator: 35 }));
  assert.strictEqual(p.was.behind, 1);
  assert.strictEqual(p.counts.on_track, 1);
});

t('new member below their reduced goal buckets as new, not behind', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 1 } }); // 3 < 8.4
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts['new'], 1);
  assert.strictEqual(p.counts.behind, 0);
});

t('new member meeting the pct-reduced goal is on_track', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 3 } }); // 9 ≥ 8.4
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.on_track, 1);
});

t('lowering new_member_baseline_pct moves a new member to on_track', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 1 } }); // 3
  const p = computeParticipationPreview([m], w(), w({ new_member_baseline_pct: 20 })); // 3 ≥ 2.8
  assert.strictEqual(p.was['new'], 1);
  assert.strictEqual(p.counts.on_track, 1);
});

t('an active exemption always buckets Exempt, before AND after any change', () => {
  const m = member({ exemption: { reason: 'medical' }, counts: { pm_hour1_lead: 1 } });
  const p = computeParticipationPreview([m], w(), w({ annual_expected_points: 100 }));
  assert.strictEqual(p.was.exempt, 1);
  assert.strictEqual(p.counts.exempt, 1);
  assert.strictEqual(p.changes.length, 0);
});

t('goal of 0 → everyone non-exempt is on_track (server parity: total ≥ 0)', () => {
  const m = member({ counts: {} });
  const p = computeParticipationPreview([m], w(), w({ annual_expected_points: 0 }));
  assert.strictEqual(p.counts.on_track, 1);
});

t('null/empty member list → all-zero counts, no crash', () => {
  const p = computeParticipationPreview(null, w(), w());
  assert.deepStrictEqual(p.counts, { on_track: 0, near: 0, behind: 0, 'new': 0, exempt: 0 });
});

// ── Server mirror parity ────────────────────────────────────────────────────
// Extract the SERVER copies from api/sheets.js and run the same members +
// weights through both — totals must agree exactly.
const API_JS = fs.readFileSync(path.resolve(__dirname, '..', 'api', 'sheets.js'), 'utf8');
function extractServer(fnName) {
  const re = new RegExp('^function ' + fnName + '\\b[\\s\\S]*?^\\}', 'm');
  const m = API_JS.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from api/sheets.js');
  return m[0];
}
const serverFactory = new Function(
  extractServer('participationWeightSlug') + '\n' +
  extractServer('participationScoreMember') + '\n' +
  'return participationScoreMember;'
);
const serverScore = serverFactory();

console.log('\nclient/server scoring parity');

t('client mirror and server scoring agree on a kitchen-sink member', () => {
  const m = member({
    counts: {
      am_lead: 2, am_assist: 1, pm_lead: 3, pm_assist: 2,
      pm_hour1_lead: 1, pm_hour2_lead: 2, pm_hour1_assist: 2,
      floater_slot: 3, cleaning_session: 2
    },
    roleDetail: [
      { title: 'President', category: 'board' },
      { title: 'Willows Liaison', category: 'committee_role' },
      { title: 'Mystery Coordinator', category: 'committee_role' }
    ],
    eventDetail: [
      { name: 'Camp', role: 'lead' },
      { name: 'PJ Party', role: 'assist' },
      { name: 'Mystery Gala', role: 'assist' }
    ]
  });
  const weightSets = [w(), w({ pm_hour2_lead: 22, role_president: 100 }), {
    board_role: 5, one_year_role: 2, am_lead: 2, am_assist: 1,
    pm_lead: 2, pm_assist: 1, cleaning_session: 1, event_lead: 2, event_assist: 1
  }];
  weightSets.forEach(ws => {
    assert.strictEqual(participationScoreMember(m, ws), serverScore(m, ws));
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
