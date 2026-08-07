// Phantom coverage-slot cleanup (prod incident 2026-08-06: a poisoned
// client cache wrote another database's duties — "Assisting Free Art
// Club" — into coverage_slots via the absence reconciler).
//
// READ-ONLY by default: lists every coverage slot whose duty names
// nothing in THIS database, using the same known-targets rule as the
// api/absences.js guard. Nothing is changed without --delete.
//
//   node --env-file=.env.local.dev scripts/cleanup-phantom-coverage.js
//   node --env-file=.env.local.dev scripts/cleanup-phantom-coverage.js --family someone@rootsandwingsindy.com
//   node --env-file=<prod env> scripts/cleanup-phantom-coverage.js --delete
//
// --delete removes UNCLAIMED phantom slots only. Claimed phantoms are
// reported but left alone (a human should release the claimant first).
// Absences whose slots were ALL phantom also get their coverage_needed
// notifications removed so members stop seeing the ghost broadcast.
// The absences rows themselves (real dates) are never touched.

const { neon } = require('@neondatabase/serverless');

const EXEMPT = ['general', 'floater', 'board', 'prep'];
const GROVES = ['greenhouse', 'saplings', 'sassafras', 'oaks', 'maples', 'birch', 'willows', 'cedars', 'pigeons'];

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  const doDelete = process.argv.includes('--delete');
  const famIdx = process.argv.indexOf('--family');
  const famFilter = famIdx !== -1 ? String(process.argv[famIdx + 1] || '').toLowerCase() : null;

  const names = new Set(GROVES);
  const add = v => { const s = String(v || '').trim().toLowerCase(); if (s) names.add(s); };
  (await sql`SELECT class_name FROM class_submissions WHERE status = 'scheduled'`).forEach(r => add(r.class_name));
  (await sql`SELECT area_name FROM cleaning_areas`).forEach(r => add(r.area_name));
  try { (await sql`SELECT title FROM roles`).forEach(r => add(r.title)); } catch (e) { console.log('(roles table lookup failed — role duties will not validate)'); }

  const rows = await sql`
    SELECT cs.id, cs.absence_id, cs.block, cs.role_type, cs.role_description, cs.group_or_class,
           cs.claimed_by_email, cs.claimed_by_name,
           a.family_email, a.absent_person, a.absence_date, a.cancelled_at
    FROM coverage_slots cs JOIN absences a ON a.id = cs.absence_id
    ORDER BY cs.absence_id, cs.id`;

  const isKnown = s => {
    if (EXEMPT.includes(String(s.role_type || '').toLowerCase())) return true;
    const goc = String(s.group_or_class || '').trim().toLowerCase();
    if (goc && names.has(goc)) return true;
    const desc = String(s.role_description || '').toLowerCase();
    for (const n of names) { if (n.length >= 4 && desc.includes(n)) return true; }
    return false;
  };

  const scoped = famFilter ? rows.filter(r => String(r.family_email || '').toLowerCase() === famFilter) : rows;
  const phantoms = scoped.filter(r => !isKnown(r));
  const claimed = phantoms.filter(r => r.claimed_by_email || r.claimed_by_name);
  const deletable = phantoms.filter(r => !r.claimed_by_email && !r.claimed_by_name);

  console.log(`Scanned ${scoped.length} slot(s)${famFilter ? ' for ' + famFilter : ''} — ${phantoms.length} phantom(s).`);
  phantoms.forEach(r => console.log(
    `  [slot ${r.id}] absence ${r.absence_id} · ${r.family_email} · ${r.absent_person} · ${String(r.absence_date).slice(0, 10)}` +
    ` · ${r.block} · "${r.role_description}"${r.claimed_by_name ? ' · ⚠ CLAIMED by ' + r.claimed_by_name : ''}${r.cancelled_at ? ' · (absence cancelled)' : ''}`
  ));
  if (claimed.length) console.log(`⚠ ${claimed.length} phantom(s) are CLAIMED — left alone; release the claimant first.`);

  if (!doDelete) { console.log('(Read-only — nothing was changed. Re-run with --delete to remove the unclaimed phantoms.)'); return; }
  if (!deletable.length) { console.log('Nothing deletable.'); return; }

  const byAbsence = {};
  scoped.forEach(r => { (byAbsence[r.absence_id] = byAbsence[r.absence_id] || []).push(r); });
  for (const r of deletable) {
    await sql`DELETE FROM coverage_slots WHERE id = ${r.id}`;
    console.log(`  deleted slot ${r.id} ("${r.role_description}")`);
  }
  // Ghost-broadcast cleanup: absences whose every slot was phantom (and
  // now has none left) lose their coverage_needed notifications.
  const allPhantomAbsences = Object.keys(byAbsence).filter(aid =>
    byAbsence[aid].every(r => !isKnown(r) && !r.claimed_by_email && !r.claimed_by_name));
  for (const aid of allPhantomAbsences) {
    const gone = await sql`DELETE FROM notifications WHERE type = 'coverage_needed' AND related_absence_id = ${parseInt(aid, 10)} RETURNING id`;
    if (gone.length) console.log(`  removed ${gone.length} coverage_needed notification(s) for absence ${aid}`);
  }
  console.log('Done.');
}
main().catch(e => { console.error(e.message); process.exit(1); });
