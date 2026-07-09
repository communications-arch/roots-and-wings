// Unit tests for the Permissions admin layer (capability grants).
//
// Three tiers:
//   1. Registry sanity — api/_capabilities.js CAPABILITIES entries are
//      well-formed and unique; locked rules have labels.
//   2. Grant resolution — _effectiveRolesFor: no rows → defaults, rows →
//      row set, '__none__' sentinel → empty, unknown key → empty.
//   3. Call-site tripwire — every capability key referenced by
//      hasCapability(...) in api/*.js, and by clientHasCapability /
//      grantTitlesFor / CAPABILITY_SURFACES in script.js, must exist in
//      the registry. A typo'd key would silently deny (server) or fall
//      back to legacy behavior (client) — this catches it at test time.
//
// Usage: node scripts/test-capabilities.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const caps = require(path.join(ROOT, 'api', '_capabilities.js'));

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
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('\nCapability registry (api/_capabilities.js)');

t('registry is a non-empty array with unique keys', () => {
  ok(Array.isArray(caps.CAPABILITIES) && caps.CAPABILITIES.length > 0, 'empty registry');
  const seen = new Set();
  caps.CAPABILITIES.forEach(c => {
    ok(!seen.has(c.key), 'duplicate key: ' + c.key);
    seen.add(c.key);
  });
});

t('every capability has key, area, label, desc, and non-empty defaultRoles', () => {
  caps.CAPABILITIES.forEach(c => {
    ok(/^[a-z][a-z0-9_]+$/.test(c.key), 'bad key format: ' + c.key);
    ok(c.area && c.label && c.desc, c.key + ' missing area/label/desc');
    ok(Array.isArray(c.defaultRoles) && c.defaultRoles.length > 0,
      c.key + ' has no defaultRoles — a default-empty capability would deny everyone on day one');
  });
});

t('locked rules all have label + desc', () => {
  ok(Array.isArray(caps.LOCKED_RULES) && caps.LOCKED_RULES.length > 0, 'no locked rules');
  caps.LOCKED_RULES.forEach(r => ok(r.label && r.desc, 'locked rule missing label/desc'));
});

console.log('\n_effectiveRolesFor (grant resolution)');

const KEY = caps.CAPABILITIES[0].key;
const DEFAULTS = caps.CAPABILITIES[0].defaultRoles;

t('no grant rows → registry defaults', () => {
  eq(caps._effectiveRolesFor(KEY, {}), DEFAULTS);
  eq(caps._effectiveRolesFor(KEY, null), DEFAULTS);
});

t('grant rows replace the defaults entirely', () => {
  const rows = {}; rows[KEY] = ['Treasurer', 'Secretary'];
  eq(caps._effectiveRolesFor(KEY, rows), ['Treasurer', 'Secretary']);
});

t("'__none__' sentinel → no roles (super users only)", () => {
  const rows = {}; rows[KEY] = [caps.NONE_SENTINEL];
  eq(caps._effectiveRolesFor(KEY, rows), []);
});

t('sentinel mixed with real titles keeps the titles', () => {
  const rows = {}; rows[KEY] = [caps.NONE_SENTINEL, 'Treasurer'];
  eq(caps._effectiveRolesFor(KEY, rows), ['Treasurer']);
});

t('unknown capability key → empty (deny)', () => {
  eq(caps._effectiveRolesFor('no_such_capability', {}), []);
});

t('returned defaults are a copy, not the registry array', () => {
  const out = caps._effectiveRolesFor(KEY, {});
  out.push('MUTATED');
  eq(caps._effectiveRolesFor(KEY, {}), DEFAULTS, 'registry defaults were mutated');
});

console.log('\nCall-site tripwire (typo\'d capability keys)');

const registered = new Set(caps.CAPABILITY_KEYS);

t('every hasCapability() key in api/*.js is registered', () => {
  const apiDir = path.join(ROOT, 'api');
  const unknown = [];
  fs.readdirSync(apiDir).filter(f => f.endsWith('.js') && f !== '_capabilities.js').forEach(f => {
    const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
    const re = /hasCapability\([^)]*?'([a-z0-9_]+)'\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!registered.has(m[1])) unknown.push(f + ': ' + m[1]);
    }
  });
  eq(unknown, [], 'unregistered keys');
});

const clientSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

t('every clientHasCapability / grantTitlesFor key in script.js is registered', () => {
  const unknown = [];
  const re = /(?:clientHasCapability|grantTitlesFor)\('([a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(clientSrc)) !== null) {
    if (!registered.has(m[1])) unknown.push(m[1]);
  }
  eq(unknown, [], 'unregistered keys');
});

t('every CAPABILITY_SURFACES key in script.js is registered', () => {
  const blockMatch = clientSrc.match(/var CAPABILITY_SURFACES = \{[\s\S]*?\n  \};/);
  ok(blockMatch, 'could not extract CAPABILITY_SURFACES from script.js');
  const unknown = [];
  const re = /'([a-z0-9_]+)':\s*\{/g;
  let m;
  while ((m = re.exec(blockMatch[0])) !== null) {
    if (!registered.has(m[1])) unknown.push(m[1]);
  }
  eq(unknown, [], 'unregistered keys');
});

console.log('\nreconcileRoleRows (script.js — workspace row sync)');

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = clientSrc.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}
const reconcileRoleRows = new Function(extract('reconcileRoleRows') + '\nreturn reconcileRoleRows;')();
const ITEM = { key: 'tour-pipeline', title: 'Tour Pipeline' };

t('adds the row to newly granted roles', () => {
  const map = { 'Membership Director': [{ key: 'tour-pipeline', title: 'Tour Pipeline' }] };
  reconcileRoleRows(map, ITEM, ['Membership Director', 'Treasurer']);
  ok(map['Treasurer'].some(r => r.key === 'tour-pipeline'), 'Treasurer did not gain the row');
  eq(map['Membership Director'].filter(r => r.key === 'tour-pipeline').length, 1, 'no duplicate for existing holder');
});

t('removes the row from revoked roles, leaves other rows alone', () => {
  const map = {
    'Membership Director': [
      { key: 'tour-pipeline', title: 'Tour Pipeline' },
      { key: 'membership', title: 'Membership' }
    ]
  };
  reconcileRoleRows(map, ITEM, ['Treasurer']);
  ok(!map['Membership Director'].some(r => r.key === 'tour-pipeline'), 'revoked row still present');
  ok(map['Membership Director'].some(r => r.key === 'membership'), 'unrelated row was removed');
  ok(map['Treasurer'].some(r => r.key === 'tour-pipeline'), 'granted role missing the row');
});

t('no granted roles → row removed everywhere', () => {
  const map = { 'Membership Director': [{ key: 'tour-pipeline', title: 'Tour Pipeline' }] };
  reconcileRoleRows(map, ITEM, []);
  eq(map['Membership Director'], []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
