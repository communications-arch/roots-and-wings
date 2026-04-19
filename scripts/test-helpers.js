// Unit tests for the small helpers defined at the top of script.js:
//
//   normalizeAllergies  — strips sentinel values like "None", "N/A", "-"
//   lookupPerson        — resolves "First Last" to an allPeople entry
//   pronounTag          — returns an inline (she/her) span, or ''
//   studentAllergyCallout — builds the red-accent allergy callout block
//   escapeHtml          — &, <, >, ", ' → entities
//
// script.js is a big browser IIFE, so we can't require() it directly. Instead
// we grep out the helper function sources and re-hydrate them inside a
// Function that takes `allPeople` as a closure variable. If anyone renames or
// reshapes these helpers in script.js, this test will fail loudly at the
// extraction step — which is the behavior we want.
//
// Usage: node scripts/test-helpers.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); passed++; }
  catch (err) { console.log('  \u2717 ' + name + '\n      ' + err.message); failed++; }
}

// ── Extract helper source from script.js ───────────────────────────────────
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

function extract(fnName) {
  // Matches `  function <name>( ... ) { ... }` at two-space indent. The
  // closing brace is anchored to two-space indent on its own line, which is
  // how all helpers in the top-of-IIFE block are formatted.
  const re = new RegExp(
    '^  function ' + fnName + '\\b[\\s\\S]*?^  \\}',
    'm'
  );
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const sources = [
  extract('normalizeAllergies'),
  extract('lookupPerson'),
  extract('pronounTag'),
  extract('studentAllergyCallout'),
  extract('escapeHtml'),
].join('\n\n');

// Build a factory that closes over a caller-supplied `allPeople` array and
// returns the five helpers.
const factory = new Function(
  'allPeople',
  sources + '\nreturn { normalizeAllergies, lookupPerson, pronounTag, studentAllergyCallout, escapeHtml };'
);

// ── normalizeAllergies ────────────────────────────────────────────────────
console.log('\nnormalizeAllergies');
{
  const { normalizeAllergies } = factory([]);

  t('empty string → empty', () => assert.strictEqual(normalizeAllergies(''), ''));
  t('null → empty', () => assert.strictEqual(normalizeAllergies(null), ''));
  t('undefined → empty', () => assert.strictEqual(normalizeAllergies(undefined), ''));
  t('whitespace → empty', () => assert.strictEqual(normalizeAllergies('   '), ''));
  t('"None" → empty', () => assert.strictEqual(normalizeAllergies('None'), ''));
  t('"none" → empty (case-insensitive)', () => assert.strictEqual(normalizeAllergies('none'), ''));
  t('"NONE." → empty', () => assert.strictEqual(normalizeAllergies('NONE.'), ''));
  t('"N/A" → empty', () => assert.strictEqual(normalizeAllergies('N/A'), ''));
  t('"na" → empty', () => assert.strictEqual(normalizeAllergies('na'), ''));
  t('"no" → empty', () => assert.strictEqual(normalizeAllergies('no'), ''));
  t('"-" → empty', () => assert.strictEqual(normalizeAllergies('-'), ''));
  t('"---" → empty', () => assert.strictEqual(normalizeAllergies('---'), ''));
  t('"nope" → empty', () => assert.strictEqual(normalizeAllergies('nope'), ''));
  t('"." → empty', () => assert.strictEqual(normalizeAllergies('.'), ''));

  t('real allergy preserved: peanuts', () => assert.strictEqual(normalizeAllergies('peanuts'), 'peanuts'));
  t('real allergy preserved: "Tree nuts, dairy"', () => assert.strictEqual(normalizeAllergies('Tree nuts, dairy'), 'Tree nuts, dairy'));
  t('trims whitespace but keeps content', () => assert.strictEqual(normalizeAllergies('  peanuts  '), 'peanuts'));
  t('"no dairy" is a REAL allergy (starts with "no")', () => assert.strictEqual(normalizeAllergies('no dairy'), 'no dairy'));
  t('"none that we know of" is preserved', () => assert.strictEqual(normalizeAllergies('none that we know of'), 'none that we know of'));
}

// ── lookupPerson ──────────────────────────────────────────────────────────
console.log('\nlookupPerson');
{
  const people = [
    { name: 'Rey',    lastName: 'Hall',    family: 'Hall',    pronouns: 'they/them', allergies: '' },
    { name: 'Jody',   lastName: 'Wilson',  family: 'Wilson',  pronouns: '',          allergies: 'peanuts' },
    { name: 'Grace',  lastName: 'Hopper',  family: 'Hopper',  pronouns: 'she/her',   allergies: '' },
    { name: 'Amber',  lastName: 'Furnish', family: 'Furnish', pronouns: '',          allergies: '' },
    { name: 'Bobby',  lastName: 'Furnish', family: 'Furnish', pronouns: 'he/him',    allergies: '' },
  ];
  const { lookupPerson } = factory(people);

  t('matches on first + last name', () => {
    const p = lookupPerson('Jody Wilson');
    assert(p && p.allergies === 'peanuts');
  });

  t('returns null for unknown name', () => {
    assert.strictEqual(lookupPerson('Unknown Person'), null);
  });

  t('returns null for empty input', () => {
    assert.strictEqual(lookupPerson(''), null);
    assert.strictEqual(lookupPerson(null), null);
    assert.strictEqual(lookupPerson(undefined), null);
  });

  t('matches first-name-only when only first provided', () => {
    const p = lookupPerson('Rey');
    assert(p && p.lastName === 'Hall');
  });

  t('distinguishes siblings with same family by first name', () => {
    const a = lookupPerson('Amber Furnish');
    const b = lookupPerson('Bobby Furnish');
    assert(a && a.pronouns === '');
    assert(b && b.pronouns === 'he/him');
  });

  t('no-match if first names differ', () => {
    assert.strictEqual(lookupPerson('Zoe Wilson'), null);
  });

  t('handles extra whitespace', () => {
    const p = lookupPerson('  Grace   Hopper ');
    assert(p && p.pronouns === 'she/her');
  });
}

// ── pronounTag ────────────────────────────────────────────────────────────
console.log('\npronounTag');
{
  const { pronounTag } = factory([]);

  t('returns span for person with pronouns', () => {
    const out = pronounTag({ pronouns: 'she/her' });
    assert(out.indexOf('pronoun-inline') !== -1);
    assert(out.indexOf('(she/her)') !== -1);
  });

  t('leading space so it reads inline', () => {
    const out = pronounTag({ pronouns: 'they/them' });
    assert.strictEqual(out.charAt(0), ' ');
  });

  t('returns empty for no person', () => {
    assert.strictEqual(pronounTag(null), '');
    assert.strictEqual(pronounTag(undefined), '');
  });

  t('returns empty when pronouns missing', () => {
    assert.strictEqual(pronounTag({}), '');
    assert.strictEqual(pronounTag({ pronouns: '' }), '');
  });

  t('HTML-escapes hostile pronoun content', () => {
    // Defensive — sheet values should be clean, but we escape on render.
    const out = pronounTag({ pronouns: '<script>x</script>' });
    assert(out.indexOf('<script>') === -1);
    assert(out.indexOf('&lt;script&gt;') !== -1);
  });
}

// ── studentAllergyCallout ─────────────────────────────────────────────────
console.log('\nstudentAllergyCallout');
{
  const people = [
    { name: 'Rey',  lastName: 'Hall',   family: 'Hall',   allergies: '' },
    { name: 'Jody', lastName: 'Wilson', family: 'Wilson', allergies: 'peanuts' },
    { name: 'Sam',  lastName: 'Smith',  family: 'Smith',  allergies: 'dairy, tree nuts' },
  ];
  const { studentAllergyCallout } = factory(people);

  t('empty list → empty output', () => {
    assert.strictEqual(studentAllergyCallout([]), '');
  });

  t('all students with no allergies → empty output', () => {
    assert.strictEqual(studentAllergyCallout(['Rey Hall']), '');
  });

  t('one student with allergies → callout present', () => {
    const out = studentAllergyCallout(['Jody Wilson']);
    assert(out.indexOf('class-allergy-alerts') !== -1);
    assert(out.indexOf('Allergy & Medical Alerts') !== -1);
    assert(out.indexOf('Jody Wilson') !== -1);
    assert(out.indexOf('peanuts') !== -1);
  });

  t('multiple students — only those with allergies listed', () => {
    const out = studentAllergyCallout(['Rey Hall', 'Jody Wilson', 'Sam Smith']);
    assert(out.indexOf('Jody Wilson') !== -1);
    assert(out.indexOf('Sam Smith') !== -1);
    assert(out.indexOf('Rey Hall') === -1, 'Rey has no allergies — should not appear');
  });

  t('unknown student name (no match) → no callout for them', () => {
    const out = studentAllergyCallout(['Unknown Person']);
    assert.strictEqual(out, '');
  });

  t('null/undefined list → empty', () => {
    assert.strictEqual(studentAllergyCallout(null), '');
    assert.strictEqual(studentAllergyCallout(undefined), '');
  });
}

// ── escapeHtml ────────────────────────────────────────────────────────────
console.log('\nescapeHtml');
{
  const { escapeHtml } = factory([]);

  t('escapes all five chars', () => {
    assert.strictEqual(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  });

  t('null → empty string', () => assert.strictEqual(escapeHtml(null), ''));
  t('undefined → empty string', () => assert.strictEqual(escapeHtml(undefined), ''));
  t('number → stringified', () => assert.strictEqual(escapeHtml(42), '42'));
  t('plain text untouched', () => assert.strictEqual(escapeHtml('hello world'), 'hello world'));

  t('ampersand escaped FIRST (no double-escape)', () => {
    // If we escaped < → &lt; before &, the output would be &amp;lt;
    assert.strictEqual(escapeHtml('<'), '&lt;');
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
