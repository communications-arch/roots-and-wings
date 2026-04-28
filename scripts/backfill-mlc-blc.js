// One-time backfill: tag every member_profiles.parents entry with the
// MLC/BLC role + per-person email + phone, so the JSONB shape lines up
// with the new "Main Learning Coach + Back Up Learning Coach" model.
//
// Heuristic per row:
//   - parents[0]            → role='mlc', email=row.family_email, phone=row.phone
//   - parents[1..]          → role='blc' by default ('parent' if 3+ adults)
//                             email = derived (firstname+lastinitial@…) if
//                                     it appears in row.additional_emails;
//                                     else null (member can fill in later)
//                             phone = null (registration didn't capture it)
//
// Idempotent: rows already carrying a role on every parent are left alone.
//
// Run with:
//   node --env-file=.env.local scripts/backfill-mlc-blc.js          # dry run
//   node --env-file=.env.local scripts/backfill-mlc-blc.js --confirm

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { neon } = require('@neondatabase/serverless');

const DOMAIN = '@rootsandwingsindy.com';

function parseArgs(argv) {
  const out = { confirm: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--confirm') out.confirm = true;
  }
  return out;
}

function deriveEmail(firstName, familyName) {
  const first = String(firstName || '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
  const initial = String(familyName || '').charAt(0).toLowerCase();
  if (!first || !initial) return null;
  return first + initial + DOMAIN;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);

  const rows = await sql`
    SELECT family_email, family_name, phone, parents, additional_emails
    FROM member_profiles
    ORDER BY family_email
  `;
  console.log(`Inspecting ${rows.length} member_profiles rows.`);

  let updated = 0, skipped = 0;
  for (const row of rows) {
    const parents = Array.isArray(row.parents) ? row.parents : [];
    if (parents.length === 0) { skipped++; continue; }

    // Skip if every parent already has a role + first_name + last_name
    // populated (idempotent across multiple backfill passes).
    const allTagged = parents.every(p =>
      p
      && typeof p.role === 'string' && p.role
      && typeof p.first_name === 'string'
      && typeof p.last_name === 'string'
    );
    if (allTagged) { skipped++; continue; }

    const additionalLc = (row.additional_emails || []).map(e => String(e || '').toLowerCase());
    const familyEmailLc = String(row.family_email || '').toLowerCase();

    const next = parents.map((p, idx) => {
      const merged = Object.assign({}, p);
      if (idx === 0) {
        merged.role = merged.role || 'mlc';
        merged.email = merged.email || familyEmailLc;
        merged.phone = (merged.phone == null) ? (row.phone || '') : merged.phone;
      } else {
        merged.role = merged.role || (idx === 1 ? 'blc' : 'parent');
        if (merged.email == null || merged.email === '') {
          const derived = deriveEmail(p.name, row.family_name);
          merged.email = (derived && additionalLc.includes(derived)) ? derived : '';
        }
        if (merged.phone == null) merged.phone = '';
      }
      if (merged.personal_email == null) merged.personal_email = '';
      // Split the legacy `name` field into first_name + last_name for
      // each adult. Heuristic: last whitespace-separated word becomes
      // last_name, everything before it becomes first_name. Single-word
      // names (e.g. "Jessica") get last_name="" — display falls back to
      // family_name. Members can edit either via the new EMI form.
      if (merged.first_name == null || merged.last_name == null) {
        const parts = String(merged.name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          merged.first_name = merged.first_name || '';
          merged.last_name = merged.last_name || '';
        } else if (parts.length === 1) {
          merged.first_name = merged.first_name || parts[0];
          merged.last_name = merged.last_name || '';
        } else {
          merged.first_name = merged.first_name || parts.slice(0, -1).join(' ');
          merged.last_name = merged.last_name || parts[parts.length - 1];
        }
      }
      return merged;
    });

    console.log(`  ${row.family_email}  ${row.family_name}`);
    next.forEach((p, i) => {
      console.log(`    [${i}] ${p.role.padEnd(6)} name=${JSON.stringify(p.name)} email=${p.email || '(none)'} phone=${p.phone || '(none)'}`);
    });

    if (args.confirm) {
      await sql`
        UPDATE member_profiles
           SET parents = ${JSON.stringify(next)}::jsonb,
               updated_at = NOW(),
               updated_by = 'backfill-mlc-blc'
         WHERE family_email = ${row.family_email}
      `;
    }
    updated++;
  }

  console.log('──');
  console.log(`Would update / updated: ${updated}`);
  console.log(`Skipped (already tagged or empty): ${skipped}`);
  if (!args.confirm) console.log('(dry run — re-run with --confirm to write.)');
}

main().catch(err => { console.error(err); process.exit(1); });
