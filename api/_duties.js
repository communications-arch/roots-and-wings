// Server-side duty derivation (prod incident 2026-08-06, follow-up per
// Erin: "the server is the authority"). The absence flow used to trust
// the CLIENT's duty list, which let a browser painting another
// database's schedule write phantom duties ("Leading Willows",
// "Assisting Free Art Club") into coverage_slots. Now the server derives
// the person's REAL class duties for the session and a posted
// teacher/assistant slot must match one — phantoms are structurally
// impossible, not merely filtered by name.
//
// Sources (same ones the portal renders from):
//   - am_class_assignments: the Grove Builder's whole-morning teaching
//     map (lead/assist per grove per session).
//   - class_submissions status='scheduled' for the session (AM + PM):
//     lead (submitter), co-leads (co_teachers names), and the
//     class_assignment_helpers roster (per-hour or whole-class).
// Matching mirrors the client: email when the row has one, display-name
// equality otherwise (trimmed, case-insensitive).

const norm = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Every block key a duty spanning `period`/`hour` covers. Whole-morning
// duties cover AM plus both hour twins — the client posts either form.
function dutyBlocks(period, hour) {
  if (period === 'AM') {
    if (hour === 'AM1') return ['AM1'];
    if (hour === 'AM2') return ['AM2'];
    return ['AM', 'AM1', 'AM2'];
  }
  if (hour === 'both') return ['PM1', 'PM2'];
  if (hour === 'PM2') return ['PM2'];
  return ['PM1'];
}

// Derive the person's class-duty keys for one session.
// opts: { schoolYear, session, absentPerson, familyEmail }
// Returns { has(block, roleType, groupOrClass), classNames: Set }.
async function deriveClassDutyKeys(sql, opts) {
  const keys = new Set();
  const classNames = new Set();
  const addKey = (blocks, type, name) => {
    const n = norm(name);
    if (!n) return;
    classNames.add(n);
    blocks.forEach(b => keys.add(b + '|' + type + '|' + n));
  };

  const personName = norm(opts.absentPerson);
  const famEmail = norm(opts.familyEmail);
  // The person's own emails: the family alias plus any people-row login
  // whose display name is the absent person.
  const emails = new Set();
  if (famEmail) emails.add(famEmail);
  try {
    const ppl = await sql`
      SELECT email, personal_email, first_name, last_name
      FROM people WHERE LOWER(family_email) = ${famEmail}`;
    ppl.forEach(p => {
      if (norm((p.first_name || '') + ' ' + (p.last_name || '')) !== personName) return;
      if (p.email) emails.add(norm(p.email));
      if (p.personal_email) emails.add(norm(p.personal_email));
    });
  } catch (e) { console.error('deriveClassDutyKeys people lookup (non-fatal):', e); }

  const isPerson = (email, name) =>
    (email && emails.has(norm(email))) || (name && norm(name) === personName);

  // Grove Builder teaching map — whole-morning grove duties.
  const amRows = await sql`
    SELECT group_name, role, person_email, person_name
    FROM am_class_assignments
    WHERE school_year = ${opts.schoolYear} AND session_number = ${opts.session}`;
  amRows.forEach(r => {
    if (!isPerson(r.person_email, r.person_name)) return;
    addKey(['AM', 'AM1', 'AM2'], r.role === 'lead' ? 'teacher' : 'assistant', r.group_name);
  });

  // Scheduled classes: lead, co-leads (#232: co-leads ARE leads), helpers.
  const cls = await sql`
    SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.age_groups,
           c.submitted_by_email, c.submitted_by_name, c.co_teachers,
           (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
             WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                OR LOWER(p.personal_email) = LOWER(c.submitted_by_email)
             LIMIT 1) AS person_name
    FROM class_submissions c
    WHERE c.school_year = ${opts.schoolYear} AND c.scheduled_session = ${opts.session}
      AND c.status = 'scheduled'`;
  const clsIds = cls.map(c => c.id);
  const helpers = clsIds.length ? await sql`
    SELECT class_submission_id, person_email, person_name, block
    FROM class_assignment_helpers WHERE class_submission_id = ANY(${clsIds})` : [];
  cls.forEach(c => {
    const blocks = dutyBlocks(c.class_period, c.scheduled_hour || '');
    // A morning class's duty may be posted under the CLASS name or its
    // GROVE name (the schedule surfaces both) — accept either.
    const names = [c.class_name];
    if (c.class_period === 'AM' && Array.isArray(c.age_groups) && c.age_groups[0]) names.push(c.age_groups[0]);
    const leadHit = isPerson(c.submitted_by_email, c.person_name) || isPerson(c.submitted_by_email, c.submitted_by_name)
      || String(c.co_teachers || '').split(/[,;]+/).some(nm => norm(nm) === personName);
    if (leadHit) names.forEach(n => addKey(blocks, 'teacher', n));
    helpers.forEach(h => {
      if (h.class_submission_id !== c.id || !isPerson(h.person_email, h.person_name)) return;
      const hBlocks = h.block ? [h.block] : blocks;
      names.forEach(n => addKey(hBlocks, 'assistant', n));
    });
  });

  return {
    has: (block, roleType, groupOrClass) => keys.has(String(block || '') + '|' + String(roleType || '') + '|' + norm(groupOrClass)),
    classNames
  };
}

module.exports = { deriveClassDutyKeys, norm };
