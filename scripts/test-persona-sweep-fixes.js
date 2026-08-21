// Guards for defects the 2026-08-21 Persona Bench sweep found (#374, #376).
//  - #374: class-signup's per-class `signedUp` (the N in the pickers' N/max)
//    counts 1st-choice, non-assistant kids only — backups don't take seats.
//  - #376: the Supply Coordinator restock To Do loader flattens the GROUPED
//    /api/supply-closet payload instead of reading it as an array.
// Usage: node scripts/test-persona-sweep-fixes.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'api', 'curriculum.js'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
let passed = 0, failed = 0;
function t(name, fn) { try { fn(); console.log('  ✓ ' + name); passed++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); failed++; } }
function eq(a, b, m) { if (a !== b) throw new Error((m || 'assert') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }

console.log('#374 — picker fullness counts first choices only');
t('signedUp filters rank === 1 and !assistant', () => {
  eq(/signedUp: detFor\(r, hourCtx\)\.filter\(d => d\.rank === 1 && !d\.assistant\)\.length/.test(api), true);
});
t('pickers still print signedUp/max', () => {
  eq((js.match(/c\.signedUp \+ \(c\.max \? '\/' \+ c\.max : ''\)/g) || []).length >= 2, true, 'two pickers');
});

console.log('#376 — restock To Do reads the grouped closet payload');
t('loadSupplyRestockCount flattens data.items when it is an object', () => {
  const fn = js.slice(js.indexOf('function loadSupplyRestockCount'), js.indexOf('function loadMerchTodos'));
  eq(/Object\.keys\(data\.items \|\| \{\}\)\.reduce/.test(fn), true, 'flatten');
  eq(/Array\.isArray\(data\.items\) \? data\.items\s*:\s*\[\]/.test(fn), false, 'old array-only fallback gone');
});
t('GET /api/supply-closet still returns grouped items (the shape the fix handles)', () => {
  const sc = fs.readFileSync(path.join(ROOT, 'api', 'supply-closet.js'), 'utf8');
  eq(/const grouped = \{ permanent: \[\], currently_available: \[\]/.test(sc), true);
  eq(/json\(\{ items: grouped, bookings: bookings \}\)/.test(sc), true);
});
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
