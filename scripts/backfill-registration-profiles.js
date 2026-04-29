// Backfill member_profiles from existing registrations rows.
//
// Before commit cd1b849 the registration handler only wrote photo_consent
// to member_profiles — kid birthdates / schedules / allergies / phone /
// address / placement_notes lived only on the registrations row, so they
// never surfaced in Edit My Info.
//
// This script replays every registrations row through the same
// upsertProfileFromRegistration merge that handleRegistration now uses
// going forward. Merge-not-clobber: existing EMI edits are preserved
// where registration doesn't have a value, so it's safe to re-run.
//
// Idempotent — running it twice produces no further changes (the merge
// would just write the same values back).
//
// Usage:
//   node --env-file=.env.local scripts/backfill-registration-profiles.js --dry
//   node --env-file=.env.local scripts/backfill-registration-profiles.js

const { neon } = require('@neondatabase/serverless');
const {
  upsertProfileFromRegistration,
  deriveFamilyName,
  deriveFamilyEmail
} = require('../api/tour');

const DRY = process.argv.includes('--dry');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);

  const regs = await sql`
    SELECT id, season, email, existing_family_name, main_learning_coach,
           address, phone, kids, placement_notes, waiver_photo_consent,
           track, created_at
    FROM registrations
    ORDER BY created_at ASC
  `;
  console.log(`Found ${regs.length} registration rows.\n`);
  if (regs.length === 0) {
    console.log('Nothing to backfill.');
    return;
  }

  // Pre-load backup_coach_waivers so we can attach per-registration backups.
  const allBackups = await sql`
    SELECT registration_id, name, email FROM backup_coach_waivers
  `;
  const backupsByReg = {};
  allBackups.forEach(b => {
    if (!backupsByReg[b.registration_id]) backupsByReg[b.registration_id] = [];
    backupsByReg[b.registration_id].push({ name: b.name, email: b.email });
  });

  let processed = 0, skipped = 0, errored = 0;
  for (const r of regs) {
    const famName = deriveFamilyName(r.main_learning_coach, r.existing_family_name);
    const famEmail = deriveFamilyEmail(r.main_learning_coach, famName);
    if (!famEmail) {
      console.warn(`  ! reg ${r.id} (${r.email}): no derivable family_email`);
      skipped++;
      continue;
    }

    const kids = Array.isArray(r.kids) ? r.kids
      : (typeof r.kids === 'string' ? (() => { try { return JSON.parse(r.kids); } catch { return []; } })() : []);

    const backupCoaches = backupsByReg[r.id] || [];

    if (DRY) {
      console.log(`  + reg ${r.id}: ${famName} (${famEmail}) — ${kids.length} kid(s), ${backupCoaches.length} backup(s)`);
      processed++;
      continue;
    }

    try {
      await upsertProfileFromRegistration(sql, {
        familyEmail: famEmail,
        familyName: famName,
        mlcName: r.main_learning_coach,
        mlcEmail: r.email,
        mlcPhotoConsent: String(r.waiver_photo_consent || '').toLowerCase() === 'yes',
        backupCoaches,
        kids,
        track: r.track,
        phone: r.phone,
        address: r.address,
        placementNotes: r.placement_notes
      });
      console.log(`  + reg ${r.id}: ${famName} → ${famEmail} (${kids.length} kid${kids.length === 1 ? '' : 's'})`);
      processed++;
    } catch (err) {
      console.error(`  ! reg ${r.id} (${famName}): ${err.message}`);
      errored++;
    }
  }

  console.log(`\nDone. ${DRY ? '(dry run) ' : ''}processed=${processed} skipped=${skipped} errored=${errored}`);
})().catch(err => { console.error(err); process.exit(1); });
