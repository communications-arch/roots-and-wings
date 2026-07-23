// Unit tests for the Roles & Committees print document (Erin, 2026-07-23:
// "add a print icon … that prints data from all the pills").
//
// buildRolesPrintHtml(d) is PURE — it takes a plain object shaped by
// rolesPrintData() and returns the whole document string. That split is what
// makes the print testable at all; the lens renderers themselves write
// straight to innerHTML and can't be extracted.
//
// Same extraction trick as test-helpers.js. NOTE: the extracted source is
// evaluated under 'use strict' because script.js's IIFE is strict — running
// it sloppy here would hide strict-only breakage.
//
// Usage: node scripts/test-roles-print.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SCRIPT_JS = path.resolve(__dirname, '..', 'script.js');
const src = fs.readFileSync(SCRIPT_JS, 'utf8');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
}

function extract(fnName) {
  const re = new RegExp('^  function ' + fnName + '\\b[\\s\\S]*?^  \\}', 'm');
  const m = src.match(re);
  if (!m) throw new Error('could not extract ' + fnName + ' from script.js');
  return m[0];
}

const factory = new Function(
  "'use strict';\n" +
  [extract('escapeHtml'), extract('raHourLabel'), extract('raAmSlotState'),
   extract('buildRolesPrintHtml')].join('\n\n') +
  '\nreturn buildRolesPrintHtml;'
);
const build = factory();

// ── Fixtures ──────────────────────────────────────────────────────────────
const ALL_ON = { roles: true, se: true, am: true, pm: true, cleaning: true };
const NONE_LOADING = { roles: false, se: false, am: false, pm: false, cleaning: false };

function role(over) {
  return Object.assign({
    title: 'A Role', depth: 0, archived: false, descOnly: false,
    holders: [], interested: [], term: '', overview: ''
  }, over);
}

function fullData(over) {
  return Object.assign({
    schoolYear: '2026-2027',
    showArchived: false,
    printedOn: '7/23/2026',
    sections: ALL_ON,
    loading: NONE_LOADING,
    branches: [{
      title: 'Vice President', emoji: '🌳', rows: [
        role({ title: 'Vice President', holders: ['Amy Chair'], term: '2 years' }),
        role({ title: 'Cleaning Crew Liaison', depth: 1, holders: [], interested: ['Hopeful Helper'] }),
        role({ title: 'Morning Class Lead', depth: 1, descOnly: true })
      ]
    }],
    orphans: [role({ title: 'Library Wrangler', holders: ['Odd Job'] })],
    events: [
      { name: 'Fall Festival', date: 'Oct 3', approved: true, lead: 'Sel Lead', assists: ['A One', 'A Two'] },
      { name: 'Field Day', date: '', approved: false, lead: '', assists: [] }
    ],
    amRows: [
      { group: 'Saplings', cells: [
        [{ scheduled_hour: 'AM', teacher: 'Tara Teach', className: 'Storytime', draft: false, helpers: ['Hank Help'] }],
        [{ scheduled_hour: 'AM1', teacher: 'Solo Hour', className: 'Half Day', draft: true, helpers: [] }],
        [], [], []
      ] }
    ],
    pmSessions: [{
      session: 1,
      rows: [
        { className: 'Woodworking', draft: false, hour: 'PM1', teacher: 'Wes Wood', helpers: ['Ada Assist'], wants: '2', needs: 1 },
        { className: 'Art', draft: true, hour: 'PM2', teacher: '', helpers: [], wants: '1', needs: 0 }
      ]
    }],
    cleaningFloors: [{
      label: 'Main Floor',
      areas: [{ name: 'Kitchen', cells: [['Smith Family'], [], [], [], []] }]
    }],
    cleaningYear: '2026-2027'
  }, over);
}

// ── Every pill lands in one document ──────────────────────────────────────
console.log('buildRolesPrintHtml — all pills in one doc');
{
  const html = build(fullData());

  t('is a complete standalone document', () => {
    assert.ok(html.startsWith('<!doctype html>'), 'missing doctype');
    assert.ok(html.trim().endsWith('</html>'), 'missing closing html');
    assert.ok(html.includes('<title>Roles &amp; Committees — 2026-2027</title>'));
  });

  t('carries a scope/provenance meta line', () => {
    assert.ok(html.includes('2026-2027 · active roles only · printed 7/23/2026'));
  });

  t('ALL FIVE section heads are present', () => {
    ['Board &amp; Committees', '🎉 Special Events', '🌅 Morning Classes',
     '🌇 Afternoon Helpers', '🧹 Cleaning'].forEach(head => {
      assert.ok(html.includes(head), 'missing section: ' + head);
    });
  });

  t('data from every pill actually appears', () => {
    assert.ok(html.includes('Amy Chair'), 'roles data missing');
    assert.ok(html.includes('Fall Festival'), 'special events data missing');
    assert.ok(html.includes('Tara Teach'), 'morning data missing');
    assert.ok(html.includes('Woodworking'), 'afternoon data missing');
    assert.ok(html.includes('Smith Family'), 'cleaning data missing');
  });

  t('screen-only controls never reach the page', () => {
    ['<button', 'Assign', 'Archive', 'Open space', 'Manage Cleaning Crew',
     'Open Class Builder'].forEach(junk => {
      assert.ok(!html.includes(junk), 'print doc contains screen control: ' + junk);
    });
  });
}

// ── Section gating follows the pills the viewer can see ───────────────────
console.log('\nsection gating');
{
  t('a hidden pill omits its whole section', () => {
    const html = build(fullData({ sections: { roles: true, se: false, am: false, pm: false, cleaning: false } }));
    assert.ok(html.includes('Board &amp; Committees'));
    ['🎉 Special Events', '🌅 Morning Classes', '🌇 Afternoon Helpers', '🧹 Cleaning'].forEach(head => {
      assert.ok(!html.includes(head), 'gated-off section leaked: ' + head);
    });
    assert.ok(!html.includes('Fall Festival'), 'gated-off DATA leaked');
    assert.ok(!html.includes('Smith Family'), 'gated-off DATA leaked');
  });

  t('cleaning-liaison view: only roles + cleaning', () => {
    const html = build(fullData({ sections: { roles: true, se: false, am: false, pm: false, cleaning: true } }));
    assert.ok(html.includes('🧹 Cleaning'));
    assert.ok(!html.includes('🌅 Morning Classes'));
    assert.ok(!html.includes('Tara Teach'));
  });
}

// ── Counts ────────────────────────────────────────────────────────────────
console.log('\ncount lines');
{
  const html = build(fullData());

  t('role counts skip archived and description-only rows', () => {
    // VP (held) + Cleaning Crew Liaison (open) + Library Wrangler (held) = 3;
    // Morning Class Lead is descOnly so it is not a staffing slot.
    assert.ok(html.includes('2 of 3 roles filled · 1 open'), 'got: ' + (html.match(/\d+ of \d+ roles filled[^<]*/) || [])[0]);
  });

  t('special-events counts split lead / no lead', () => {
    assert.ok(html.includes('1 with a lead · 1 need a lead'));
  });

  t('morning coverage counts full / partial / open slots', () => {
    // 5 session slots: one both-hours (full), one AM1-only (partial), 3 empty.
    assert.ok(html.includes('1 covered · 1 hour open · 3 open'), 'got: ' + (html.match(/\d+ covered[^<]*/) || [])[0]);
  });

  t('afternoon counts scheduled classes and helper gaps', () => {
    assert.ok(html.includes('2 scheduled · 1 helper spot to fill'));
  });

  t('afternoon says "all helped" when nothing is short', () => {
    const d = fullData();
    d.pmSessions[0].rows.forEach(r => { r.needs = 0; });
    assert.ok(build(d).includes('2 scheduled · all helped'));
  });

  t('cleaning counts filled vs open cells', () => {
    assert.ok(html.includes('1 filled · 4 open'));
  });
}

// ── Open / unassigned flagging ────────────────────────────────────────────
console.log('\nopen-slot flagging');
{
  const html = build(fullData());

  t('unfilled role reads Unassigned', () => assert.ok(html.includes('>Unassigned<')));
  t('description-only role reads "per schedule"', () => assert.ok(html.includes('per schedule')));
  t('interested members ride along under the holder', () => {
    assert.ok(html.includes('🙋 Interested: Hopeful Helper'));
  });
  t('leadless event is flagged OPEN', () => {
    assert.ok(/<span class="rp-open">OPEN<\/span>/.test(html));
  });
  t('empty morning slot is flagged OPEN, half-covered names the hour', () => {
    assert.ok(html.includes('>Hour 2 open<'), 'AM1-only slot should flag Hour 2');
  });
  t('short-handed afternoon class says how many more', () => {
    assert.ok(html.includes('needs 1 more'));
  });
  t('draft placements are tagged', () => {
    assert.ok(html.includes('(draft)'));
  });
}

// ── Archived + description text ───────────────────────────────────────────
console.log('\narchived and descriptions');
{
  t('meta line reflects the Show archived toggle', () => {
    assert.ok(build(fullData()).includes('active roles only'));
    assert.ok(build(fullData({ showArchived: true })).includes('including archived roles'));
  });

  t('archived rows are labelled and excluded from the filled count', () => {
    const d = fullData({ showArchived: true });
    d.branches[0].rows.push(role({ title: 'Retired Job', depth: 1, archived: true, holders: ['Old Hand'] }));
    const html = build(d);
    assert.ok(html.includes('Retired Job'));
    assert.ok(html.includes('(archived)'));
    assert.ok(html.includes('2 of 3 roles filled'), 'archived row must not change the count');
  });

  t('the FULL overview prints — screen truncates at 120 chars, paper should not', () => {
    const long = 'x'.repeat(400);
    const d = fullData();
    d.branches[0].rows[0].overview = long;
    const html = build(d);
    assert.ok(html.includes(long), 'overview was truncated');
    assert.ok(!html.includes('…'), 'ellipsis leaked into the print');
  });
}

// ── Loading + empty states ────────────────────────────────────────────────
console.log('\nloading and empty states');
{
  t('a lens still in flight says so instead of printing blank', () => {
    const html = build(fullData({ loading: { roles: false, se: false, am: true, pm: true, cleaning: true } }));
    assert.ok(html.includes('🌅 Morning Classes'), 'head should still render');
    assert.ok(html.includes('Still loading when this was printed'));
    assert.ok(!html.includes('Tara Teach'), 'must not print half-loaded data');
  });

  t('empty collections get a plain-English note, not an empty table', () => {
    const html = build(fullData({
      events: [], pmSessions: [], cleaningFloors: [], branches: [], orphans: []
    }));
    assert.ok(html.includes('No special events for this year yet.'));
    assert.ok(html.includes('No afternoon classes scheduled for 2026-2027 yet.'));
    assert.ok(html.includes('No cleaning areas defined for this year.'));
    assert.ok(html.includes('No roles to show for this year.'));
  });

  t('survives a bare object without throwing', () => {
    const html = build({ sections: ALL_ON });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('Board &amp; Committees'));
  });
}

// ── Escaping ──────────────────────────────────────────────────────────────
console.log('\nescaping');
{
  t('role titles, holders and descriptions are escaped', () => {
    const d = fullData();
    d.branches[0].rows[0].title = '<script>x</script>';
    d.branches[0].rows[0].holders = ['A & B'];
    d.branches[0].rows[0].overview = 'needs "care" & <thought>';
    const html = build(d);
    assert.ok(!html.includes('<script>x</script>'), 'unescaped title');
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('A &amp; B'));
    assert.ok(html.includes('&lt;thought&gt;'));
  });

  t('event, class and family names are escaped', () => {
    const d = fullData();
    d.events[0].name = '<b>Fest</b>';
    d.pmSessions[0].rows[0].className = '<i>Wood</i>';
    d.cleaningFloors[0].areas[0].cells[0] = ['<em>Smith</em>'];
    const html = build(d);
    assert.ok(!html.includes('<b>Fest</b>'));
    assert.ok(!html.includes('<i>Wood</i>'));
    assert.ok(!html.includes('<em>Smith</em>'));
  });
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
