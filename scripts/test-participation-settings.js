// Unit tests for the Participation Settings live preview.
//
// computeParticipationPreview (script.js, extracted like test-new-member.js
// does) mirrors the server's buildParticipationReport scoring so the
// Settings panel can show "before → after" status counts as the reviewer
// edits values — WITHOUT a round trip. If the server scoring in
// api/sheets.js changes (thresholds, new-member pct, exemption handling),
// these tests are the tripwire that the preview must change too.
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

// ── Extract the client-side helper from script.js ───────────────────────────
const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(
  extract('computeParticipationPreview') + '\n' +
  'return computeParticipationPreview;'
);
const computeParticipationPreview = factory();

// ── Fixtures ────────────────────────────────────────────────────────────────
// Weights shaped like the server's map (participation_weights key → value).
const BASE = {
  board_role: 5, one_year_role: 2,
  am_lead: 2, am_assist: 1, pm_lead: 2, pm_assist: 1,
  cleaning_session: 1, event_lead: 2, event_assist: 1,
  annual_expected_points: 14, new_member_baseline_pct: 60
};
function w(overrides) { return Object.assign({}, BASE, overrides || {}); }
function member(over) {
  return Object.assign({ displayName: 'Test Member', counts: {}, isNewMember: false, exemption: null }, over || {});
}

console.log('\ncomputeParticipationPreview (script.js)');

t('same weights in and out → counts === was, no changes', () => {
  const members = [
    member({ counts: { board_role: 1, cleaning_session: 5, pm_lead: 2 } }), // 5+5+4 = 14 → on_track
    member({ counts: { cleaning_session: 3 } })                              // 3 → behind
  ];
  const p = computeParticipationPreview(members, w(), w());
  assert.deepStrictEqual(p.counts, p.was);
  assert.strictEqual(p.changes.length, 0);
});

t('scores counts × weights across all nine activity fields', () => {
  const m = member({ counts: {
    board_role: 1, one_year_role: 1, am_lead: 1, am_assist: 1, pm_lead: 1,
    pm_assist: 1, cleaning_session: 1, event_lead: 1, event_assist: 1
  } }); // 5+2+2+1+2+1+1+2+1 = 17 ≥ 14
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.on_track, 1);
});

t('meets goal exactly → on_track (threshold is ≥, not >)', () => {
  const m = member({ counts: { pm_lead: 7 } }); // 14
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.on_track, 1);
});

t('≥ 80% of goal → near ("Close")', () => {
  const m = member({ counts: { pm_lead: 6 } }); // 12 ≥ 11.2
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.near, 1);
});

t('below 80% of goal → behind', () => {
  const m = member({ counts: { pm_lead: 5 } }); // 10 < 11.2
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.behind, 1);
});

t('raising the annual goal moves an on-track member and reports the change', () => {
  const m = member({ displayName: 'Riley Chen', counts: { pm_lead: 7 } }); // 14
  const p = computeParticipationPreview([m], w(), w({ annual_expected_points: 20 }));
  assert.strictEqual(p.was.on_track, 1);
  assert.strictEqual(p.counts.behind, 1); // 14 < 16
  assert.deepStrictEqual(p.changes, [{ name: 'Riley Chen', from: 'on_track', to: 'behind' }]);
});

t('raising an activity weight moves a behind member up', () => {
  const m = member({ counts: { cleaning_session: 7 } }); // 7 → behind
  const p = computeParticipationPreview([m], w(), w({ cleaning_session: 2 }));
  assert.strictEqual(p.was.behind, 1);
  assert.strictEqual(p.counts.on_track, 1); // 14 ≥ 14
});

t('new member below their reduced goal buckets as new, not behind', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 3 } }); // 3 < 8.4
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts['new'], 1);
  assert.strictEqual(p.counts.behind, 0);
});

t('new member meeting the pct-reduced goal is on_track', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 9 } }); // 9 ≥ 14×0.6=8.4
  const p = computeParticipationPreview([m], w(), w());
  assert.strictEqual(p.counts.on_track, 1);
});

t('lowering new_member_baseline_pct moves a new member to on_track', () => {
  const m = member({ isNewMember: true, counts: { cleaning_session: 3 } });
  const p = computeParticipationPreview([m], w(), w({ new_member_baseline_pct: 20 })); // 3 ≥ 2.8
  assert.strictEqual(p.was['new'], 1);
  assert.strictEqual(p.counts.on_track, 1);
});

t('an active exemption always buckets Exempt, before AND after any change', () => {
  const m = member({ exemption: { reason: 'medical' }, counts: { pm_lead: 7 } });
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

t('missing weight key scores as 0 (no NaN poisoning)', () => {
  const noClean = w(); delete noClean.cleaning_session;
  const m = member({ counts: { cleaning_session: 50 } });
  const p = computeParticipationPreview([m], w(), noClean);
  assert.strictEqual(p.counts.behind, 1); // 50×0 = 0
});

t('string weight values are parsed (DB returns numerics as strings)', () => {
  const strW = w({ cleaning_session: '2', annual_expected_points: '14' });
  const m = member({ counts: { cleaning_session: 7 } });
  const p = computeParticipationPreview([m], w(), strW);
  assert.strictEqual(p.counts.on_track, 1);
});

t('null/empty member list → all-zero counts, no crash', () => {
  const p = computeParticipationPreview(null, w(), w());
  assert.deepStrictEqual(p.counts, { on_track: 0, near: 0, behind: 0, 'new': 0, exempt: 0 });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
