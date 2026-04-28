// Family-membership resolver.
//
// Phase 3 of the directory→DB migration. Before this, every ownership check
// in the codebase compared the JWT email directly to member_profiles.family_email,
// which prevented co-parents (e.g. Jay Shewan with login jays@) from editing
// family-scoped data even when they're listed as a parent.
//
// The two helpers below are the central lookup. resolveFamily returns the
// family_profiles row for a given login email; canActAs answers the boolean
// "is this user authorized to act for this family" question. Every auth
// ownership check in tour.js / absences.js / photos.js uses canActAs.
//
// Email matching is case-insensitive on both sides. additional_emails is
// stored verbatim as written (the column has no LOWER() index, but the
// comparison normalizes via LOWER() / lower(unnest)) so a row inserted with
// 'Jays@…' still resolves for a JWT with 'jays@…'.

function normalizeEmail(e) {
  return e ? String(e).trim().toLowerCase() : '';
}

// Find the member_profiles row owned by this login email, checking the
// primary family_email first and additional_emails as a secondary lookup.
// Returns null if the email isn't tied to any family.
async function resolveFamily(sql, userEmail) {
  const email = normalizeEmail(userEmail);
  if (!email) return null;
  const rows = await sql`
    SELECT family_email, family_name, phone, address,
           parents, kids, placement_notes, additional_emails
    FROM member_profiles
    WHERE LOWER(family_email) = ${email}
       OR EXISTS (
         SELECT 1 FROM unnest(additional_emails) ae
         WHERE LOWER(ae) = ${email}
       )
    LIMIT 1
  `;
  return rows[0] || null;
}

// True iff userEmail is allowed to act for the family identified by
// targetFamilyEmail. Matches when:
//   - userEmail equals targetFamilyEmail (the primary parent), or
//   - userEmail appears in that family's additional_emails (a co-parent).
// Super-user override is intentionally NOT folded in here — call sites add
// their own super-user short-circuit so this helper stays focused.
async function canActAs(sql, userEmail, targetFamilyEmail) {
  const u = normalizeEmail(userEmail);
  const t = normalizeEmail(targetFamilyEmail);
  if (!u || !t) return false;
  if (u === t) return true;
  const rows = await sql`
    SELECT 1 FROM member_profiles
    WHERE LOWER(family_email) = ${t}
      AND EXISTS (
        SELECT 1 FROM unnest(additional_emails) ae
        WHERE LOWER(ae) = ${u}
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

module.exports = {
  resolveFamily,
  canActAs,
  // Exported for tests:
  _normalizeEmail: normalizeEmail
};
