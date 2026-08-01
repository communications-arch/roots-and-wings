// Unit tests for the Absence Alert hour-block split (#195/#198, Colleen).
//
// absExpandMorningSlots (script.js, extracted the usual way) maps the duty
// scanner's whole-morning 'AM' slots onto the AM1/AM2 hour blocks the
// Absence Alert now works in. Hour-specific duties (floaters, preps,
// AM1/AM2-scheduled class submissions) must land in their own hour;
// whole-morning duties become one slot per selected hour; legacy callers
// that still pass an 'AM' block get everything through untouched.
//
// Usage: node scripts/test-absence-blocks.js

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
const absExpandMorningSlots = new Function(
  extract('absExpandMorningSlots') + '\nreturn absExpandMorningSlots;'
)();

function slot(block, role_type, desc, cls) {
  return { block, role_type, role_description: desc, group_or_class: cls || '' };
}
const HOURS = ['AM1', 'AM2', 'PM1', 'PM2', 'Cleaning'];

console.log('\nabsExpandMorningSlots (script.js)');

t('whole-morning class duty becomes one slot per selected morning hour', () => {
  const out = absExpandMorningSlots(
    [slot('AM', 'teacher', 'Leading Willows (10-12) 10:00–12:00 Room 4', 'Willows')], HOURS);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(s => s.block), ['AM1', 'AM2']);
  assert.ok(out.every(s => s.role_description.indexOf('Leading Willows') === 0));
});

t('only the selected morning hour gets the whole-morning duty', () => {
  const out = absExpandMorningSlots(
    [slot('AM', 'assistant', 'Assisting Oaks (7-9) 10:00–12:00')], ['AM2', 'PM1']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].block, 'AM2');
});

t('hour-ranged duties land only in their own hour (floater/prep style)', () => {
  const out = absExpandMorningSlots([
    slot('AM', 'floater', 'AM Floater 10-11'),
    slot('AM', 'floater', 'AM Floater 11-12'),
    slot('AM', 'prep', 'Prep Period 11-12')
  ], HOURS);
  assert.deepStrictEqual(out.map(s => s.block), ['AM1', 'AM2', 'AM2']);
});

t('AM1/AM2-scheduled class submissions keep their hour', () => {
  const out = absExpandMorningSlots([
    slot('AM', 'teacher', 'Leading Bugs & Botany 10:00–11:00', 'Bugs & Botany'),
    slot('AM', 'teacher', 'Leading Knots 101 11:00–12:00', 'Knots 101')
  ], HOURS);
  assert.deepStrictEqual(out.map(s => s.block), ['AM1', 'AM2']);
});

t('Building Opener (unlock & set-up) maps to the first hour only', () => {
  const out = absExpandMorningSlots(
    [slot('AM', 'opener', 'Building Opener — unlock & morning set-up')], HOURS);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].block, 'AM1');
});

t("an age range in the class name doesn't fake an hour range", () => {
  // Willows is (10-12) — must NOT read as a 10-till-12 time that eats an hour.
  const out = absExpandMorningSlots(
    [slot('AM', 'teacher', 'Leading Willows (10-12) 10:00–12:00')], ['AM1']);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].block, 'AM1');
});

t('legacy caller passing an AM block gets slots through untouched', () => {
  const raw = [
    slot('AM', 'teacher', 'Leading Willows (10-12) 10:00–12:00'),
    slot('AM', 'floater', 'AM Floater 10-11')
  ];
  const out = absExpandMorningSlots(raw, ['AM', 'PM1']);
  assert.strictEqual(out.length, 2);
  assert.ok(out.every(s => s.block === 'AM'));
});

t('non-morning slots pass through and filter by selected blocks', () => {
  const out = absExpandMorningSlots([
    slot('PM1', 'teacher', 'Leading Chess 1:00–1:55', 'Chess'),
    slot('PM2', 'assistant', 'Assisting Drama 2:00–2:55', 'Drama'),
    slot('Cleaning', 'cleaning', 'Cleaning: Kitchen', 'Kitchen')
  ], ['PM1', 'Cleaning']);
  assert.deepStrictEqual(out.map(s => s.block), ['PM1', 'Cleaning']);
});

t('slots are copied, not mutated — the source array keeps its AM block', () => {
  const raw = [slot('AM', 'teacher', 'Leading Maples 10:00–12:00')];
  absExpandMorningSlots(raw, HOURS);
  assert.strictEqual(raw[0].block, 'AM');
});

t('empty/absent input yields an empty list', () => {
  assert.deepStrictEqual(absExpandMorningSlots([], HOURS), []);
  assert.deepStrictEqual(absExpandMorningSlots(null, HOURS), []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
