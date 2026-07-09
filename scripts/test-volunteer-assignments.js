// Unit tests for the Volunteer Assignments lenses (Roles Assignments).
//
// raAmSlotState mirrors the Class Builder's AM slot rule (sbAmSlotConflict):
// a group's morning holds ONE both-hours class ('AM') OR one Hour 1 ('AM1')
// + one Hour 2 ('AM2'). The lens colors cells full/partial/open from the
// same placed-classes input the builder uses, so if the builder's hour
// semantics change these tests are the tripwire that the lens must too.
//
// raPmHelpersNeeded: a teacher asks for a range ("1 or 2 assistants") —
// the MINIMUM satisfies the request; the lens flags a class only when it
// has fewer helpers than the smallest count asked for.
//
// Usage: node scripts/test-volunteer-assignments.js

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((label || 'value') + ': expected ' + e + ', got ' + a);
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
  extract('raAmSlotState') + '\n' +
  extract('raPmHelpersNeeded') + '\n' +
  'return { raAmSlotState: raAmSlotState, raPmHelpersNeeded: raPmHelpersNeeded };'
);
const { raAmSlotState, raPmHelpersNeeded } = factory();

console.log('\nraAmSlotState (script.js)');

t('no placed classes → open, both hours listed', () => {
  eq(raAmSlotState([]), { state: 'open', openHours: ['AM1', 'AM2'] });
});

t('one both-hours class (AM) → full', () => {
  eq(raAmSlotState([{ scheduled_hour: 'AM' }]), { state: 'full', openHours: [] });
});

t('blank scheduled_hour counts as both-hours (legacy AM rows)', () => {
  eq(raAmSlotState([{ scheduled_hour: '' }]), { state: 'full', openHours: [] });
  eq(raAmSlotState([{}]), { state: 'full', openHours: [] });
});

t('AM1 only → partial, Hour 2 open', () => {
  eq(raAmSlotState([{ scheduled_hour: 'AM1' }]), { state: 'partial', openHours: ['AM2'] });
});

t('AM2 only → partial, Hour 1 open', () => {
  eq(raAmSlotState([{ scheduled_hour: 'AM2' }]), { state: 'partial', openHours: ['AM1'] });
});

t('AM1 + AM2 pair → full', () => {
  eq(raAmSlotState([{ scheduled_hour: 'AM1' }, { scheduled_hour: 'AM2' }]),
    { state: 'full', openHours: [] });
});

t('null/undefined input → open (defensive)', () => {
  eq(raAmSlotState(null), { state: 'open', openHours: ['AM1', 'AM2'] });
  eq(raAmSlotState(undefined), { state: 'open', openHours: ['AM1', 'AM2'] });
});

console.log('\nraPmHelpersNeeded (script.js)');

t('asked [1], no helpers → needs 1', () => {
  eq(raPmHelpersNeeded({ assistant_count: [1], helpers: [] }), 1);
});

t('asked [1, 2], one helper → satisfied (min of range)', () => {
  eq(raPmHelpersNeeded({ assistant_count: [1, 2], helpers: [{ name: 'A' }] }), 0);
});

t('asked [2, 3], one helper → needs 1 more', () => {
  eq(raPmHelpersNeeded({ assistant_count: [2, 3], helpers: [{ name: 'A' }] }), 1);
});

t('more helpers than asked → 0, never negative', () => {
  eq(raPmHelpersNeeded({ assistant_count: [1], helpers: [{ name: 'A' }, { name: 'B' }] }), 0);
});

t('empty assistant_count defaults to wanting 1', () => {
  eq(raPmHelpersNeeded({ assistant_count: [], helpers: [] }), 1);
  eq(raPmHelpersNeeded({ assistant_count: [], helpers: [{ name: 'A' }] }), 0);
});

t('missing fields entirely → wants 1 (defensive)', () => {
  eq(raPmHelpersNeeded({}), 1);
  eq(raPmHelpersNeeded(null), 1);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
