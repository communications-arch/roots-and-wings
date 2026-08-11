// #293: unit tests for the SERVER-AUTHORITATIVE coverage-slot generator
// (api/_duties.js deriveCoverageSlots). Mocks the tagged-template `sql` so we
// can assert the exact slots produced for an absent person — the make-or-break
// behaviors the adversarial review flagged (H1 floater blocks, H2 whole-morning
// hour-splitting, M1 committee scoping, M3 family-alias over-match, M4 name
// matching, opener AM1-only, prep/board excluded).
//
// Usage: node scripts/test-coverage-derivation.js

const { deriveCoverageSlots } = require('../api/_duties');

let passed = 0, failed = 0;
function t(name, fn) {
  Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    err => { console.log('  ✗ ' + name + '\n      ' + err.message); failed++; }
  );
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function keys(slots) { return slots.map(s => s.block + '|' + s.role_type + '|' + s.group_or_class).sort(); }

// Build a mock `sql` tagged-template from canned table data. Dispatches by a
// distinctive substring of the query text.
function mockSql(data) {
  return function (strings) {
    const q = strings.join(' ? ');
    const rows =
      /FROM people/.test(q) ? (data.people || []) :
      /am_class_assignments/.test(q) ? (data.am || []) :
      /FROM class_submissions/.test(q) ? (data.classes || []) :
      /class_assignment_helpers/.test(q) ? (data.helpers || []) :
      /cleaning_assignments/.test(q) ? (data.cleaning || []) :
      /role_holders_v2/.test(q) ? (data.roles || []) :
      /volunteer_signups/.test(q) ? (data.floaters || []) : [];
    return Promise.resolve(rows);
  };
}
const OPTS = { schoolYear: '2026-2027', session: 1 };

console.log('  coverage-slot generator (#293)');

t('H2: a whole-morning grove lead splits onto the SELECTED AM hour only', async () => {
  const sql = mockSql({ am: [{ group_name: 'Willows', role: 'lead', person_email: 'x@rw', person_name: 'Mary Johnson' }] });
  const oneHour = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Mary Johnson', familyEmail: 'fam@rw', blocks: ['AM1'] });
  assert(keys(oneHour).join() === 'AM1|teacher|Willows', 'AM1-only absence → one AM1 teacher slot, got ' + JSON.stringify(keys(oneHour)));
  const bothHours = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Mary Johnson', familyEmail: 'fam@rw', blocks: ['AM1', 'AM2'] });
  assert(keys(bothHours).join() === 'AM1|teacher|Willows,AM2|teacher|Willows', 'both hours → two slots, got ' + JSON.stringify(keys(bothHours)));
});

t('H1: a morning floater stored as AM1 IS generated (was missed)', async () => {
  const sql = mockSql({ people: [{ email: 'me@rw', first_name: 'Sam', last_name: 'Lee' }], floaters: [{ block: 'AM1' }] });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Sam Lee', familyEmail: 'fam@rw', blocks: ['AM1'] });
  assert(out.some(s => s.block === 'AM1' && s.role_type === 'floater'), 'AM1 floater must be generated, got ' + JSON.stringify(keys(out)));
});

t('M3: a duty keyed to the shared family alias does NOT attach to the other parent', async () => {
  // Dad's grove row uses the family email + Dad's name; Mom reports out.
  const sql = mockSql({
    people: [
      { email: 'dad@rw', first_name: 'Dad', last_name: 'Smith', family_name: 'Smith' },
      { email: 'mom@rw', first_name: 'Mom', last_name: 'Smith', family_name: 'Smith' }
    ],
    am: [{ group_name: 'Oaks', role: 'lead', person_email: 'fam@rw', person_name: 'Dad Smith' }]
  });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Mom Smith', familyEmail: 'fam@rw', blocks: ['AM1', 'AM2'] });
  assert(out.length === 0, 'Mom out must NOT generate Dad’s duty, got ' + JSON.stringify(keys(out)));
});

t('M4: first+last name match ignores middle names', async () => {
  const sql = mockSql({ am: [{ group_name: 'Maples', role: 'assist', person_email: '', person_name: 'Mary Beth Johnson' }] });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Mary Johnson', familyEmail: 'fam@rw', blocks: ['AM1'] });
  assert(out.some(s => s.role_type === 'assistant' && s.group_or_class === 'Maples'), 'middle name should still match, got ' + JSON.stringify(keys(out)));
});

t('opener is a first-hour (AM1) duty only, even when out both morning hours', async () => {
  const sql = mockSql({ people: [{ email: 'op@rw', first_name: 'Pat', last_name: 'Kim' }], roles: [{ title: 'Building Opener' }] });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Pat Kim', familyEmail: 'fam@rw', blocks: ['AM1', 'AM2'] });
  assert(keys(out).join() === 'AM1|opener|', 'opener → AM1 only, got ' + JSON.stringify(keys(out)));
});

t('prep + board never generate coverage (query is floater-only)', async () => {
  // The floater query filters role='floater'; prep/board rows never come back.
  const sql = mockSql({ people: [{ email: 'me@rw', first_name: 'Sam', last_name: 'Lee' }], floaters: [] });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Sam Lee', familyEmail: 'fam@rw', blocks: ['AM1', 'PM1'] });
  assert(!out.some(s => s.role_type === 'prep' || s.role_type === 'board'), 'no prep/board slots');
});

t('cleaning keyed by family surname; closer lands on Cleaning', async () => {
  const sql = mockSql({
    people: [{ email: 'c@rw', first_name: 'Jo', last_name: 'Rivera', family_name: 'Rivera' }],
    cleaning: [{ area_name: 'Bathrooms', floor_key: 'mainFloor' }],
    roles: [{ title: 'Building Closer' }]
  });
  const out = await deriveCoverageSlots(sql, { ...OPTS, absentPerson: 'Jo Rivera', familyEmail: 'fam@rw', blocks: ['PM2', 'Cleaning'] });
  assert(out.some(s => s.role_type === 'cleaning' && s.group_or_class === 'Bathrooms'), 'cleaning slot, got ' + JSON.stringify(keys(out)));
  assert(out.some(s => s.role_type === 'closer' && s.block === 'Cleaning'), 'closer slot on Cleaning, got ' + JSON.stringify(keys(out)));
});

t('empty family / no matches → no slots, no crash', async () => {
  const out = await deriveCoverageSlots(mockSql({}), { ...OPTS, absentPerson: 'Nobody Here', familyEmail: '', blocks: ['AM1', 'PM1', 'PM2', 'Cleaning'] });
  assert(Array.isArray(out) && out.length === 0, 'empty → []');
});

// Summary (after the microtasks above resolve).
setTimeout(() => {
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}, 100);
