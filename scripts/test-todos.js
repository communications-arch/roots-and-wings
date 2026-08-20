// To Do notifications registry + engine (#368, 2026-08-20).
//
// Guards:
//  - every TODO_KINDS entry has a label, role list and count(); kinds whose
//    source already sends a targeted notification are NOT registered (a
//    generic "New To Do" on top would double-buzz).
//  - every kind named by a touchTodos()/TODO_TRIGGERS call in api/ exists.
//  - sweepTodos: no prior state → baseline only; equal → silent; rise →
//    exactly one notification per recipient; fall → state updated, silent.
//  - the daily cron is wired (vercel.json + the notifications.js gate), and
//    the retired client-diff hack (todo_alert) is gone.
//
// Usage: node scripts/test-todos.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const todos = require(path.join(ROOT, 'api', '_todos.js'));
const apiDir = path.join(ROOT, 'api');
const apiSrc = {};
fs.readdirSync(apiDir).filter(f => f.endsWith('.js')).forEach(f => { apiSrc[f] = fs.readFileSync(path.join(apiDir, f), 'utf8'); });
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

let passed = 0, failed = 0;
function t(name, fn) {
  const p = Promise.resolve().then(fn);
  return p.then(() => { console.log('  ✓ ' + name); passed++; },
    err => { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; });
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assert') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a));
}

// A fake neon `sql` tag: routes by the SQL text, records writes.
function fakeSql(opts) {
  const writes = { state: [], notifications: [] };
  const tag = (strings, ...vals) => {
    const q = strings.join('?');
    if (/FROM role_holders_v2\b/.test(q) && /MAX\(school_year\)/.test(q)) return Promise.resolve([{ sy: '2026-2027' }]);
    if (/FROM role_holders_v2 rhv JOIN roles r/.test(q)) return Promise.resolve(opts.holders || []);
    if (/FROM co_op_sessions/.test(q)) return Promise.resolve([]);
    if (/FROM todo_notify_state/.test(q)) return Promise.resolve(opts.state || []);
    if (/INSERT INTO todo_notify_state/.test(q)) { writes.state.push({ kind: vals[0], email: vals[1], count: vals[3], notified: vals[4] }); return Promise.resolve([]); }
    if (/INSERT INTO notifications/.test(q)) { writes.notifications.push({ email: vals[0], title: vals[1], body: vals[2] }); return Promise.resolve([{ id: 1, recipient_email: vals[0], title: vals[1], body: vals[2], link_url: vals[3] }]); }
    if (/COUNT\(\*\)::int AS n FROM tours WHERE status = 'requested'/.test(q)) return Promise.resolve([{ n: opts.count }]);
    throw new Error('unexpected query: ' + q.slice(0, 80));
  };
  tag.writes = writes;
  return tag;
}
// Silence the push fan-out (no VAPID keys in tests → _push no-ops anyway).
const holders = [{ title: 'membership director', email: 'mem@x.org' }];

(async () => {
  console.log('api/_todos.js — registry');
  await t('every kind has label, roles[] and count()', () => {
    Object.keys(todos.TODO_KINDS).forEach(k => {
      const d = todos.TODO_KINDS[k];
      eq(typeof d.label, 'string', k + '.label');
      eq(Array.isArray(d.roles) && d.roles.length > 0, true, k + '.roles');
      eq(typeof d.count, 'function', k + '.count');
    });
  });
  await t('sources that already notify are NOT registered (no double-buzz)', () => {
    ['restock', 'blc-signin', 'evseats', 'enroll-req', 'editedcls'].forEach(k => eq(!!todos.TODO_KINDS[k], false, k));
  });
  await t('every kind named by touchTodos()/TODO_TRIGGERS in api/ is registered', () => {
    const named = new Set();
    Object.keys(apiSrc).forEach(f => {
      const src = apiSrc[f];
      const re = /touchTodos\([^,]+,\s*\[([^\]]*)\]/g;
      let m; while ((m = re.exec(src))) m[1].split(',').forEach(s => { const k = s.trim().replace(/^['"]|['"]$/g, ''); if (k) named.add(k); });
      const trig = src.match(/const TODO_TRIGGERS = \{([\s\S]*?)\n\};/);
      if (trig) { const re2 = /\[([^\]]*)\]/g; let m2; while ((m2 = re2.exec(trig[1]))) m2[1].split(',').forEach(s => { const k = s.trim().replace(/^['"]|['"]$/g, ''); if (k) named.add(k); }); }
    });
    eq(named.size > 5, true, 'found hooks');
    named.forEach(k => eq(!!todos.TODO_KINDS[k], true, 'unregistered kind in a hook: ' + k));
  });

  console.log('api/_todos.js — sweep engine');
  await t('no prior state → baseline recorded, nobody notified', async () => {
    const sql = fakeSql({ holders, state: [], count: 3 });
    const r = await todos.sweepTodos(sql, ['tours']);
    eq(r.notified, 0); eq(sql.writes.state.length, 1); eq(sql.writes.state[0].count, 3); eq(sql.writes.state[0].notified, null);
  });
  await t('unchanged count → silent, no state write', async () => {
    const sql = fakeSql({ holders, state: [{ kind: 'tours', recipient_email: 'mem@x.org', last_count: 3 }], count: 3 });
    const r = await todos.sweepTodos(sql, ['tours']);
    eq(r.notified, 0); eq(sql.writes.state.length, 0); eq(sql.writes.notifications.length, 0);
  });
  await t('rise → one notification per recipient, state stamped', async () => {
    const sql = fakeSql({ holders, state: [{ kind: 'tours', recipient_email: 'mem@x.org', last_count: 1 }], count: 3 });
    const r = await todos.sweepTodos(sql, ['tours']);
    eq(r.notified, 1); eq(sql.writes.notifications[0].email, 'mem@x.org');
    eq(sql.writes.notifications[0].title, 'New To Do: Tour requests');
    eq(/2 new items — 3 waiting/.test(sql.writes.notifications[0].body), true, 'body');
    eq(sql.writes.state[0].notified instanceof Date, true, 'last_notified_at');
  });
  await t('fall → state updated, silent', async () => {
    const sql = fakeSql({ holders, state: [{ kind: 'tours', recipient_email: 'mem@x.org', last_count: 3 }], count: 0 });
    const r = await todos.sweepTodos(sql, ['tours']);
    eq(r.notified, 0); eq(sql.writes.state[0].count, 0);
  });
  await t('board role with no holder row falls back to the board mailbox', async () => {
    const sql = fakeSql({ holders: [], state: [], count: 1 });
    const r = await todos.sweepTodos(sql, ['tours']);
    eq(r.checked, 1); eq(sql.writes.state[0].email, 'membership@rootsandwingsindy.com');
  });
  await t('unknown kinds are ignored', async () => {
    const r = await todos.sweepTodos(fakeSql({ holders, state: [], count: 0 }), ['nope']);
    eq(r.checked, 0);
  });

  console.log('wiring');
  await t('daily cron registered in vercel.json + gated in notifications.js', () => {
    eq(vercelJson.crons.some(c => c.path === '/api/notifications?cron=todo-sweep'), true, 'vercel.json');
    eq(/req\.query\.cron === 'todo-sweep'/.test(apiSrc['notifications.js']), true, 'gate');
    eq(/CRON_SECRET/.test(apiSrc['notifications.js']), true, 'secret check');
  });
  await t('the client-diff hack (todo_alert) is gone', () => {
    eq(/todo_alert/.test(scriptSrc), false, 'script.js');
    eq(/todo_alert/.test(apiSrc['notifications.js']), false, 'notifications.js');
  });
  await t('tour.js dispatcher routes every TODO_TRIGGERS kind through afterTodo', () => {
    const src = apiSrc['tour.js'];
    const trig = src.match(/const TODO_TRIGGERS = \{([\s\S]*?)\n\};/);
    const kinds = Array.from(trig[1].matchAll(/'([a-z-]+)':/g)).map(m => m[1]);
    kinds.forEach(k => eq(new RegExp("if \\(kind === '" + k + "'\\) return afterTodo\\(kind,").test(src), true, k));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
