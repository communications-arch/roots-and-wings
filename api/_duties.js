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

// ── #293: SERVER-AUTHORITATIVE coverage-slot GENERATOR ──────────────────
// deriveClassDutyKeys (above) is a MATCHER used to validate client-proposed
// slots. deriveCoverageSlots is its generator sibling: it produces the FULL
// set of coverage slots an absent person needs covered, straight from the DB,
// so the browser never computes or proposes slots (the 2026-08-06 phantom
// incident's root cause). It mirrors the client's getResponsibilitiesForBlocks
// but reads the authoritative DB tables that already hold every duty source:
//   class  → am_class_assignments + class_submissions + class_assignment_helpers
//   clean  → cleaning_assignments + cleaning_areas
//   opener/closer/supply_closet → role_holders_v2 + roles (committee roles)
//   floater→ volunteer_signups (self-serve support sign-ups)
// prep + board never need coverage (excluded), matching the client's filter.
//
// opts: { schoolYear, session, absentPerson, familyEmail, blocks }
//   blocks = the hour blocks the person is out (['AM','AM1','AM2','PM1','PM2','Cleaning']).
// Returns [{ block, role_type, role_description, group_or_class }].
async function deriveCoverageSlots(sql, opts) {
  const slots = [];
  const push = (block, role_type, role_description, group_or_class) =>
    slots.push({ block, role_type, role_description, group_or_class: group_or_class || '' });

  const famEmail = norm(opts.familyEmail);
  const blocks = Array.isArray(opts.blocks) && opts.blocks.length
    ? opts.blocks : ['AM', 'AM1', 'AM2', 'PM1', 'PM2', 'Cleaning'];
  // #293 review H2: whole-morning duties split onto the absence's SELECTED
  // hours (the board thinks in AM1/AM2 hour blocks, #198). A legacy 'AM'
  // block means both morning twins.
  const amHours = [];
  if (blocks.includes('AM') || blocks.includes('AM1')) amHours.push('AM1');
  if (blocks.includes('AM') || blocks.includes('AM2')) amHours.push('AM2');
  const wantAM = amHours.length > 0;
  const wantPM1 = blocks.includes('PM1');
  const wantPM2 = blocks.includes('PM2');
  const wantClean = blocks.includes('Cleaning');
  const amTime = h => h === 'AM1' ? '10:00–11:00' : '11:00–12:00';

  // #293 review M4: match on first + last name (ignore middles), like the
  // client's personNamesMatch — exact-string equality missed real duties.
  const firstLast = s => {
    const parts = norm(s).split(' ').filter(Boolean);
    return parts.length ? { first: parts[0], last: parts[parts.length - 1] } : null;
  };
  const target = firstLast(opts.absentPerson);
  const namesMatch = n => {
    const x = firstLast(n);
    return !!(x && target && x.first === target.first && x.last === target.last);
  };

  // #293 review M3: resolve ONLY the absent person's own logins — NOT the
  // shared family alias. Adding the family_email made a duty keyed to that
  // alias attach to whichever parent was reported out, generating the other
  // parent's slot. Class rows keyed to the alias fall back to name matching.
  const emails = new Set();
  let familyName = '';
  try {
    const ppl = await sql`
      SELECT email, personal_email, first_name, last_name, family_name
      FROM people WHERE LOWER(family_email) = ${famEmail}`;
    ppl.forEach(p => {
      if (p.family_name && !familyName) familyName = p.family_name;
      // #341 audit: absent_person is built as first name + FAMILY surname,
      // but a people row may carry a different legal last_name (maiden /
      // hyphenated) or none at all — mirror the client's personFullName
      // fallback and also try first + family_name. Widens only within this
      // family's rows, so the M3 alias protection is untouched.
      const legal = (p.first_name || '') + ' ' + (p.last_name || '');
      const familial = (p.first_name || '') + ' ' + (p.family_name || '');
      if (!namesMatch(legal) && !namesMatch(familial)) return;
      if (p.email) emails.add(norm(p.email));
      if (p.personal_email) emails.add(norm(p.personal_email));
    });
  } catch (e) { console.error('deriveCoverageSlots people lookup (non-fatal):', e); }
  const isPerson = (email, name) =>
    (email && emails.has(norm(email))) || (name && namesMatch(name));
  const emailList = Array.from(emails);

  // ── 1. Class duties (teacher / assistant) ──────────────────────────
  // Grove Builder whole-morning teaching map → one slot per selected AM hour.
  if (wantAM) {
    const amRows = await sql`
      SELECT group_name, role, person_email, person_name
      FROM am_class_assignments
      WHERE school_year = ${opts.schoolYear} AND session_number = ${opts.session}`;
    amRows.forEach(r => {
      if (!isPerson(r.person_email, r.person_name)) return;
      const grove = r.group_name || 'your grove';
      amHours.forEach(h => {
        if (r.role === 'lead') push(h, 'teacher', 'Leading ' + grove + ' ' + amTime(h), grove);
        else push(h, 'assistant', 'Assisting ' + grove + ' ' + amTime(h), grove);
      });
    });
  }
  // Scheduled classes: lead + co-leads (#232: co-leads are leads) + helpers.
  // #341 audit: the old single-name LIMIT 1 (no ORDER BY) subquery could
  // resolve a shared submitter email to the WRONG family member's name —
  // aggregate every matching people name and lead-match against them all.
  const cls = await sql`
    SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.scheduled_room,
           c.submitted_by_email, c.submitted_by_name, c.co_teachers,
           (SELECT ARRAY_AGG(NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '')) FROM people p
             WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                OR LOWER(p.personal_email) = LOWER(c.submitted_by_email)) AS person_names
    FROM class_submissions c
    WHERE c.school_year = ${opts.schoolYear} AND c.scheduled_session = ${opts.session}
      AND c.status = 'scheduled'`;
  const clsIds = cls.map(c => c.id);
  const helpers = clsIds.length ? await sql`
    SELECT class_submission_id, person_email, person_name, block
    FROM class_assignment_helpers WHERE class_submission_id = ANY(${clsIds})` : [];
  cls.forEach(c => {
    const isAM = c.class_period === 'AM';
    const room = c.scheduled_room ? ' ' + c.scheduled_room : '';
    // Hour blocks this class covers, intersected with the absence's blocks.
    const targets = []; // [{block, time}]
    if (isAM && wantAM) {
      if (c.scheduled_hour === 'AM1') { if (amHours.includes('AM1')) targets.push({ block: 'AM1', time: amTime('AM1') }); }
      else if (c.scheduled_hour === 'AM2') { if (amHours.includes('AM2')) targets.push({ block: 'AM2', time: amTime('AM2') }); }
      else amHours.forEach(h => targets.push({ block: h, time: amTime(h) })); // whole morning
    } else if (!isAM) {
      const isPM1 = c.scheduled_hour === 'PM1' || c.scheduled_hour === 'both';
      const isPM2 = c.scheduled_hour === 'PM2' || c.scheduled_hour === 'both';
      if (isPM1 && wantPM1) targets.push({ block: 'PM1', time: '1:00–1:55' });
      if (isPM2 && wantPM2) targets.push({ block: 'PM2', time: '2:00–2:55' });
    }
    if (!targets.length) return;
    const name = c.class_name;
    // #341 audit widenings (all name paths, M3-safe): every people name on
    // the submitter email; '(via …)' stripped from on-behalf names; co-
    // teachers split on & / and as well as commas (all real prod shapes).
    const typedName = String(c.submitted_by_name || '').replace(/\s*\(via[^)]*\)\s*$/i, '');
    const leadHit = isPerson(c.submitted_by_email, '')
      || (c.person_names || []).some(n => n && namesMatch(n))
      || (typedName && namesMatch(typedName))
      || String(c.co_teachers || '').split(/[,;&]+|\band\b/i).some(nm => nm.trim() && namesMatch(nm));
    if (leadHit) targets.forEach(t => push(t.block, 'teacher', 'Leading ' + name + ' ' + t.time + room, name));
    helpers.forEach(h => {
      if (h.class_submission_id !== c.id || !isPerson(h.person_email, h.person_name)) return;
      // A per-hour helper row only covers its own block (whole-class = all).
      targets.forEach(t => {
        if (h.block && h.block !== t.block && h.block !== 'AM') return;
        push(t.block, 'assistant', 'Assisting ' + name + ' ' + t.time + room, name);
      });
    });
  });

  // ── 2. Cleaning (per-session crew, keyed by family surname) ─────────
  if (wantClean && familyName) {
    const clean = await sql`
      SELECT a.area_name, a.floor_key
      FROM cleaning_assignments ca JOIN cleaning_areas a ON a.id = ca.cleaning_area_id
      WHERE ca.session_number = ${opts.session}
        AND (ca.school_year = ${opts.schoolYear} OR ca.school_year IS NULL)
        AND LOWER(ca.family_name) = ${norm(familyName)}`;
    clean.forEach(c => {
      if (c.floor_key === 'floater') push('Cleaning', 'cleaning', 'Cleaning Floater', 'Floater');
      else push('Cleaning', 'cleaning', 'Cleaning: ' + c.area_name, c.area_name);
    });
  }

  // ── 3. Committee building duties: opener / closer / supply_closet ───
  // #293 review M1: scope like the client's COMMITTEE_ROLE_HOLDERS —
  // active committee_role rows, current holders, latest school year.
  try {
    if (emailList.length) {
      const roleRows = await sql`
        SELECT r.title
        FROM role_holders_v2 rh JOIN roles r ON r.id = rh.role_id
        WHERE rh.ended_at IS NULL AND r.status = 'active' AND r.category = 'committee_role'
          AND rh.school_year = (SELECT MAX(school_year) FROM role_holders_v2)
          AND LOWER(rh.person_email) = ANY(${emailList})`;
      roleRows.forEach(r => {
        const title = String(r.title || '');
        // Opener is a first-hour duty (#198 / client absExpandMorningSlots).
        if (/\bopener\b/i.test(title) && amHours.includes('AM1')) {
          push('AM1', 'opener', 'Building Opener — unlock & morning set-up', '');
        }
        // #293 review F2: the closer slot lives on the 'Cleaning' block, which
        // only renders when Cleaning is selected — gate on wantClean so a
        // PM2-only absence doesn't create an un-showable, un-assignable slot
        // (matches the client, which drops non-selected-block slots).
        if (/\bcloser\b/i.test(title) && wantClean) {
          push('Cleaning', 'closer', 'Building Closer / Lost & Found — end of day', '');
        }
        if (/supply\s*closet/i.test(title) && wantPM1) {
          push('PM1', 'supply_closet', 'Supply Closet', '');
        }
      });
    }
  } catch (e) { console.error('deriveCoverageSlots committee roles (non-fatal):', e); }

  // ── 4. Support sign-ups (self-serve): floater needs coverage; prep/board
  // duties need none.
  // #293 review H1: morning floaters are stored per-hour (AM1/AM2), not 'AM'.
  try {
    if (emailList.length) {
      const vol = await sql`
        SELECT block, role FROM volunteer_signups
        WHERE school_year = ${opts.schoolYear} AND session_number = ${opts.session}
          AND LOWER(person_email) = ANY(${emailList})`;
      vol.forEach(v => {
        const amMatch = h => (v.block === 'AM' || v.block === h) && amHours.includes(h);
        if (v.role === 'floater') {
          if (amMatch('AM1')) push('AM1', 'floater', 'AM Floater ' + amTime('AM1'), '');
          if (amMatch('AM2')) push('AM2', 'floater', 'AM Floater ' + amTime('AM2'), '');
          if (v.block === 'PM1' && wantPM1) push('PM1', 'floater', 'PM Floater', '');
          if (v.block === 'PM2' && wantPM2) push('PM2', 'floater', 'PM Floater', '');
        }
      });
    }
  } catch (e) { console.error('deriveCoverageSlots support roles (non-fatal):', e); }

  // ── (Generic hour fillers REMOVED — Erin, 2026-08-12.) The #179 behavior
  // created a 'general' slot for any selected block with no specific duty,
  // so every pre-staffing absence flooded the board with "coverage needed"
  // for adults who weren't signed up for anything. Slots now exist only for
  // real duties (class / cleaning / opener / closer / supply closet /
  // floater). Existing unclaimed 'general' slots are pruned by the #320
  // read-refresh reconciler on the next Coverage Board load; claimed ones
  // are preserved.

  // De-dupe by identity (block|role_type|group_or_class) — a person can match
  // a class under multiple paths (grove map + scheduled submission).
  const seen = new Set();
  return slots.filter(s => {
    const k = s.block + '|' + s.role_type + '|' + norm(s.group_or_class);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

module.exports = { deriveClassDutyKeys, deriveCoverageSlots, norm };
