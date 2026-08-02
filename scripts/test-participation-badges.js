// Unit tests for the member-facing milestone track + growth badges
// (2026-08-01 points redesign). participationStageIndex and
// participationBadgeState are extracted from script.js the same way
// test-participation-settings.js does.
//
// Spec (points-system-handoff.md §2): four stages Sprouting → Taking root
// → Flourishing → Full bloom, with "Flourishing" the one that lines up
// with the season goal; badges 1–4 tier Bronze/Silver/Gold by frequency,
// badges 5–6 (year-long position / board) are always Gold once earned.
//
// Usage: node scripts/test-participation-badges.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', 'script.js'), 'utf8');
function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}
// GROW_BADGE_DEFS references GROW_BADGE_SVGS keys only by name (strings),
// so the defs array can be evaluated standalone.
const defsMatch = src.match(/var GROW_BADGE_DEFS = \[[\s\S]*?\n  \];/);
if (!defsMatch) throw new Error('could not extract GROW_BADGE_DEFS from script.js');

const factory = new Function(
  extract('participationStageIndex') + '\n' +
  extract('participationBadgeState') + '\n' +
  defsMatch[0] + '\n' +
  'return { participationStageIndex, participationBadgeState, GROW_BADGE_DEFS };'
);
const { participationStageIndex, participationBadgeState, GROW_BADGE_DEFS } = factory();

function defByKey(key) {
  const d = GROW_BADGE_DEFS.filter(d => d.key === key)[0];
  if (!d) throw new Error('no badge def ' + key);
  return d;
}
function member(over) {
  return Object.assign({ counts: {}, isBoard: false }, over || {});
}

console.log('\nparticipationStageIndex (script.js)');

t('zero points → nothing filled; first point → Sprouting', () => {
  assert.strictEqual(participationStageIndex(0, 14), 0);
  assert.strictEqual(participationStageIndex(0.5, 14), 1);
});

t('#202 thirds-of-goal stages: ⅓ → Taking root; ⅔ → Flourishing; goal → Full bloom', () => {
  // Goal 15 for clean thirds: 5 and 10.
  assert.strictEqual(participationStageIndex(4.9, 15), 1);
  assert.strictEqual(participationStageIndex(5, 15), 2);
  assert.strictEqual(participationStageIndex(9.9, 15), 2);
  assert.strictEqual(participationStageIndex(10, 15), 3);  // Flourishing bar filling
  assert.strictEqual(participationStageIndex(14.9, 15), 3);
  assert.strictEqual(participationStageIndex(15, 15), 4);  // goal reached = Full bloom territory
  assert.strictEqual(participationStageIndex(40, 15), 4);
});

t('no goal (0/undefined) → any activity reads as Sprouting, never crashes', () => {
  assert.strictEqual(participationStageIndex(5, 0), 1);
  assert.strictEqual(participationStageIndex(5, undefined), 1);
});

console.log('\nparticipationBadgeState (script.js)');

t('frequency badges tier Bronze → Silver → Gold by count', () => {
  const lead = defByKey('leadClass'); // thresholds 1 / 3 / 5
  assert.strictEqual(participationBadgeState(lead, member()).tier, null);
  assert.strictEqual(participationBadgeState(lead, member({ counts: { am_lead: 1 } })).tier, 'bronze');
  assert.strictEqual(participationBadgeState(lead, member({ counts: { am_lead: 2, pm_lead: 1 } })).tier, 'silver');
  assert.strictEqual(participationBadgeState(lead, member({ counts: { am_lead: 3, pm_lead: 2 } })).tier, 'gold');
});

t('lead-class badge counts AM and PM leads together (assists likewise)', () => {
  const lead = defByKey('leadClass');
  assert.strictEqual(participationBadgeState(lead, member({ counts: { pm_lead: 1 } })).n, 1);
  const assist = defByKey('assist');
  assert.strictEqual(participationBadgeState(assist, member({ counts: { am_assist: 2, pm_assist: 2 } })).n, 4);
});

t('year-long position and board badges are Gold the moment they are earned', () => {
  const oneYear = defByKey('oneYear');
  assert.strictEqual(participationBadgeState(oneYear, member()).tier, null);
  assert.strictEqual(participationBadgeState(oneYear, member({ counts: { one_year_role: 1 } })).tier, 'gold');
  const board = defByKey('board');
  assert.strictEqual(participationBadgeState(board, member()).tier, null);
  assert.strictEqual(participationBadgeState(board, member({ isBoard: true })).tier, 'gold');
});

t('cleaning and event-lead badges use their own thresholds', () => {
  const clean = defByKey('cleaning'); // 1 / 2 / 4
  assert.strictEqual(participationBadgeState(clean, member({ counts: { cleaning_session: 2 } })).tier, 'silver');
  assert.strictEqual(participationBadgeState(clean, member({ counts: { cleaning_session: 4 } })).tier, 'gold');
  const ev = defByKey('eventLead'); // 1 / 2 / 3
  assert.strictEqual(participationBadgeState(ev, member({ counts: { event_lead: 3 } })).tier, 'gold');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
