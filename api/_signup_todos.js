// Sign-up To Dos for one session (Erin, 2026-07-15) — VP + Afternoon
// Class Liaison: kids without afternoon picks, adults with an uncovered
// hour, classes short on assistants, over-full classes, un-sent lead
// confirmations, lottery moves not yet told, owner-edited placed classes.
//
// Pulled out of api/curriculum.js's signup-todos handler (#368 follow-up,
// 2026-08-20) so the To Do notification registry (api/_todos.js) can run
// the SAME read the portal's To Do card shows — counts can never disagree.
// The endpoint adds can_place and returns this object verbatim.

// Whole-year age as of today from a YYYY-MM-DD birth date (or Date).
// Returns null for a missing/invalid date.
function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const bd = new Date(birthDate);
  if (isNaN(bd.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - bd.getUTCFullYear();
  const mo = now.getUTCMonth() - bd.getUTCMonth();
  if (mo < 0 || (mo === 0 && now.getUTCDate() < bd.getUTCDate())) age--;
  return age >= 0 ? age : 0;
}

// ── Unplaced-kid predicate + counter (#32) ──
// Shared by signup-todos (the kids_unpicked To Do) and the
// class-confirm-send gate so the two can never disagree about who
// still needs afternoon placements. Greenhouse / under-3 kids never
// pick afternoon classes; morning-only / pending / not-returning kids
// are excluded by the enrollment-scoped kid query itself. "Picked"
// matches by kid_id when the pick row carries one (rename-proof),
// name key as the legacy fallback.
// k: { kid_id, first_name, class_group, birth_date, fam }
function kidLacksAfternoonPick(k, pickedIds, pickedKeys) {
  if (String(k.class_group || '').trim().toLowerCase() === 'greenhouse') return false;
  const age = ageFromBirthDate(k.birth_date);
  if (age != null && age < 3) return false;
  if (pickedIds.has(k.kid_id)) return false;
  return !pickedKeys.has(k.fam + '|' + String(k.first_name || '').toLowerCase());
}

async function computeSignupTodos(sql, year, sess) {

  // The season's afternoon pool comes from kid_enrollments (enrollment
  // re-key phase, 2026-07-19) — status='enrolled', schedule
  // all-day/afternoon — mirroring the Morning Builder's morning read.
  // Pending / not-returning / morning-only kids no longer show up as
  // "needs picks"; the kids table supplies display metadata only.
  const [stKids, stPicked, stCls, stHelpers, stSignups, stApproval, stWin, stFirsts] = await Promise.all([
    sql`SELECT k.id AS kid_id, k.first_name, k.class_group, k.birth_date,
               LOWER(e.family_email) AS fam,
               COALESCE(NULLIF(k.nickname, ''), k.first_name) AS display_first,
               COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last
        FROM kid_enrollments e
        JOIN kids k ON k.id = e.kid_id
        LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(e.family_email)
        WHERE e.season = ${year} AND e.status = 'enrolled'
          AND e.schedule IN ('all-day', 'afternoon')
          AND mp.withdrawn_at IS NULL
          AND EXISTS (SELECT 1 FROM registrations r WHERE r.season = ${year}
                AND (LOWER(NULLIF(r.family_email, '')) = LOWER(e.family_email)
                  OR LOWER(r.email) = LOWER(e.family_email)))`,
    sql`SELECT DISTINCT kid_id, LOWER(family_email) AS fam, LOWER(kid_first_name) AS kid
        FROM class_signup_picks WHERE school_year = ${year} AND session_number = ${sess}`,
    sql`SELECT c.id, c.class_name, c.class_period, c.scheduled_hour, c.assistant_count,
               c.max_students, c.lead_email_sent_at, c.lottery_run_at,
               c.owner_edited_at, c.owner_edited_by,
               LOWER(c.submitted_by_email) AS teacher_email,
               (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
                 WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                    OR LOWER(p.personal_email) = LOWER(c.submitted_by_email) LIMIT 1) AS teacher_name
        FROM class_submissions c
        WHERE c.school_year = ${year} AND c.scheduled_session = ${sess}
          AND c.status IN ('scheduled', 'drafted')`,
    sql`SELECT h.class_submission_id, LOWER(h.person_email) AS email, h.person_name, h.block
        FROM class_assignment_helpers h
        JOIN class_submissions c ON c.id = h.class_submission_id
        WHERE c.school_year = ${year} AND c.scheduled_session = ${sess}`,
    sql`SELECT block, LOWER(person_email) AS email, person_name FROM volunteer_signups
        WHERE school_year = ${year} AND session_number = ${sess}`,
    sql`SELECT approved_at FROM co_op_sessions
        WHERE school_year = ${year} AND session_number = ${sess}`,
    sql`SELECT status FROM class_signup_windows
        WHERE school_year = ${year} AND session_number = ${sess} LIMIT 1`,
    // Enrollment = 1st-choice picks (distinct kids) per class.
    // Transition-tolerant (2026-08-12, Colleen): count a pick UNLESS
    // the kid has an EXPLICIT non-enrolled row this season (withdrawn /
    // dropped). Kids mid-transition — pending, or no enrollment row yet
    // during pre-finalization — still count, so over-full classes read
    // as over-full and the lottery To Do fires. Matches the class-signup
    // and volunteer-matrix pick filters. NULL-kid_id legacy rows count.
    sql`SELECT p.class_submission_id,
               COUNT(DISTINCT (LOWER(p.family_email) || '|' || LOWER(p.kid_first_name)))::int AS firsts
        FROM class_signup_picks p
        WHERE p.school_year = ${year} AND p.session_number = ${sess} AND p.rank = 1
          AND (p.kid_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM kid_enrollments e
            WHERE e.kid_id = p.kid_id AND e.season = ${year}
              AND e.status <> 'enrolled'))
        GROUP BY p.class_submission_id`
  ]);
  const stPmApproved = !!(stApproval.length && stApproval[0].approved_at);
  const stWinStatus = stWin.length ? stWin[0].status : null;
  const stFirstBy = {};
  stFirsts.forEach(r => { stFirstBy[r.class_submission_id] = r.firsts; });

  // 1. Kids without afternoon picks. Morning-only / pending /
  // not-returning kids are already filtered out by the enrollment
  // read above; Greenhouse / under-3 never pick. "Picked" matches by
  // kid_id when the pick row carries one (rename-proof), name key as
  // the legacy fallback.
  const stPickedSet = new Set(stPicked.map(r => r.fam + '|' + r.kid));
  const stPickedIds = new Set(stPicked.map(r => r.kid_id).filter(Boolean));
  const kidsUnpicked = stKids.filter(k => kidLacksAfternoonPick(k, stPickedIds, stPickedSet)).map(k => ({
    name: ((k.display_first || '') + ' ' + (k.display_last || '')).trim(),
    first_name: k.first_name,
    family_email: k.fam,
    group: k.class_group || '',
    // Age so the liaison can eyeball class fit from the To Do
    // (Erin, 2026-07-16); null when no birth date is on file.
    age: ageFromBirthDate(k.birth_date)
  })).sort((a, b) => a.name.localeCompare(b.name));

  // Shared occupancy maps (mirrors volunteer-matrix semantics).
  const stBlocksOf = r => r.class_period === 'AM'
    ? (r.scheduled_hour === 'AM1' ? ['AM1'] : r.scheduled_hour === 'AM2' ? ['AM2'] : ['AM1', 'AM2'])
    : r.scheduled_hour === 'both' ? ['PM1', 'PM2']
    : r.scheduled_hour === 'PM2' ? ['PM2'] : ['PM1'];
  const stHelpersBySub = {};
  stHelpers.forEach(h => {
    (stHelpersBySub[h.class_submission_id] || (stHelpersBySub[h.class_submission_id] = [])).push(h);
  });
  // occupied['AM1'] = Set of emails + lowercased names committed that hour
  const occupied = { AM1: new Set(), AM2: new Set(), PM1: new Set(), PM2: new Set() };
  const mark = (b, email, name) => {
    if (email) occupied[b].add(email);
    const nl = String(name || '').trim().toLowerCase();
    if (nl) occupied[b].add(nl);
  };
  stCls.forEach(r => {
    const hs = stHelpersBySub[r.id] || [];
    stBlocksOf(r).forEach(b => {
      mark(b, r.teacher_email, r.teacher_name);
      hs.forEach(h => { if (!h.block || h.block === b) mark(b, h.email, h.person_name); });
    });
  });
  stSignups.forEach(s2 => {
    (s2.block === 'AM' ? ['AM1', 'AM2'] : [s2.block]).forEach(b => {
      if (occupied[b]) mark(b, s2.email, s2.person_name);
    });
  });

  // 2. Adults (Main Learning Coaches) with an uncovered hour. PM hours
  // only count once the session's afternoon schedule is approved.
  const stMlcs = await sql`
    SELECT LOWER(p.email) AS email, LOWER(p.personal_email) AS personal_email,
           NULLIF(TRIM(CONCAT_WS(' ', p.first_name, NULLIF(p.last_name, ''))), '') AS pname,
           p.first_name, mp.family_name
    FROM people p
    LEFT JOIN member_profiles mp ON mp.family_email = p.family_email
    WHERE p.role = 'mlc'
      AND mp.withdrawn_at IS NULL`;
  const stExpected = stPmApproved ? ['AM1', 'AM2', 'PM1', 'PM2'] : ['AM1', 'AM2'];
  const adultsUnplaced = [];
  stMlcs.forEach(m => {
    const fullName = (m.pname || ((m.first_name || '') + ' ' + (m.family_name || '')).trim()).toLowerCase();
    const ids = [m.email, m.personal_email, fullName].filter(Boolean);
    const missing = stExpected.filter(b => !ids.some(idv => occupied[b].has(idv)));
    if (missing.length) {
      adultsUnplaced.push({
        name: m.pname || ((m.first_name || '') + ' ' + (m.family_name || '')).trim(),
        email: m.email || '',
        missing
      });
    }
  });
  adultsUnplaced.sort((a, b) => a.name.localeCompare(b.name));

  // #340 (Lyndsey): classes whose OWNER edited after placement —
  // the class stays on the schedule; reviewers get this To Do to
  // look the changes over. #361 (Colleen): ANY session of the year
  // (a Session-4 class edited while Session 2 runs still needs eyes),
  // with the placement + a "what changed" line, and a Mark-read
  // (class-edit-ack) that dismisses it without re-saving the class.
  const editedRows = await sql`
    SELECT c.id, c.class_name, c.class_period, c.scheduled_session, c.scheduled_hour,
           c.owner_edited_at, c.owner_edited_by, c.owner_edit_summary,
           (SELECT NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), '') FROM people p
             WHERE LOWER(p.email) = LOWER(c.submitted_by_email)
                OR LOWER(p.personal_email) = LOWER(c.submitted_by_email) LIMIT 1) AS teacher_name,
           c.submitted_by_name
    FROM class_submissions c
    WHERE c.school_year = ${year} AND c.owner_edited_at IS NOT NULL
      AND c.status IN ('scheduled', 'drafted')
    ORDER BY c.owner_edited_at DESC`;
  const editedClasses = editedRows.map(r => ({
    id: r.id, class_name: r.class_name, class_period: r.class_period,
    session: r.scheduled_session, hour: r.scheduled_hour || '',
    teacher: r.teacher_name || r.submitted_by_name || '', edited_at: r.owner_edited_at,
    edited_by: r.owner_edited_by || '', summary: r.owner_edit_summary || ''
  }));

  // 3. Classes short on assistants (per hour for whole-morning classes,
  // once per class otherwise).
  const assistantGaps = [];
  stCls.forEach(r => {
    const hs = stHelpersBySub[r.id] || [];
    const wants = Math.min.apply(null, (r.assistant_count && r.assistant_count.length) ? r.assistant_count : [1]);
    const spansTwo = r.class_period === 'AM'
      ? (r.scheduled_hour !== 'AM1' && r.scheduled_hour !== 'AM2')
      : r.scheduled_hour === 'both';
    if (spansTwo) {
      // Two-hour classes take per-hour assists — gaps count per hour.
      stBlocksOf(r).forEach(b => {
        const n = hs.filter(h => !h.block || h.block === b).length;
        if (wants - n > 0) assistantGaps.push({ class_name: r.class_name, block: b, needs: wants - n });
      });
    } else {
      const gap = wants - hs.length;
      if (gap > 0) assistantGaps.push({ class_name: r.class_name, block: r.scheduled_hour || (r.class_period === 'AM' ? 'AM' : 'PM'), needs: gap });
    }
  });
  assistantGaps.sort((a, b) => a.class_name.localeCompare(b.class_name) || String(a.block).localeCompare(String(b.block)));

  // Post-close resolution (Erin, 2026-07-15). Over-max = 1st-choice
  // kids beyond max_students on a PM class. Once the window is
  // closed AND nothing is over-max, un-sent lead confirmations
  // become the next To Do.
  const overmax = [];
  const confirmPending = [];
  stCls.forEach(r => {
    if (r.class_period !== 'PM') return;
    const firsts = stFirstBy[r.id] || 0;
    const max = r.max_students || 0;
    if (max > 0 && firsts > max) {
      overmax.push({
        id: r.id, class_name: r.class_name, hour: r.scheduled_hour || 'PM1',
        max: max, firsts: firsts, over: firsts - max,
        lottery_run: !!r.lottery_run_at,
        // Lead's name so the liaison knows who to talk to before
        // raising the max or running a lottery (Erin, 2026-07-16).
        teacher: r.teacher_name || ''
      });
    }
    if (firsts > 0) {
      confirmPending.push({
        id: r.id, class_name: r.class_name, firsts: firsts,
        sent: !!r.lead_email_sent_at, teacher: r.teacher_name || ''
      });
    }
  });
  overmax.sort((a, b) => b.over - a.over);
  confirmPending.sort((a, b) => a.class_name.localeCompare(b.class_name));

  // Lottery moves the families haven't been told about yet (Erin,
  // 2026-07-16): each bump shows which class's lottery it was and
  // where the kid landed — their promoted 2nd choice (now rank 1 in
  // the same hour), or nothing if they had no 2nd choice. Derived
  // live so a later re-pick shows the family's current placement.
  const lotteryMoveRows = await sql`
    SELECT b.id, b.class_submission_id, LOWER(b.family_email) AS fam,
           b.kid_first_name,
           c.class_name AS from_class, c.scheduled_hour AS from_hour,
           COALESCE(NULLIF(k.nickname, ''), b.kid_first_name) AS display_first,
           COALESCE(NULLIF(k.last_name, ''), mp.family_name, '') AS display_last,
           (SELECT c2.class_name FROM class_signup_picks p2
              JOIN class_submissions c2 ON c2.id = p2.class_submission_id
             WHERE p2.school_year = b.school_year AND p2.session_number = b.session_number
               AND ((b.kid_id IS NOT NULL AND p2.kid_id = b.kid_id)
                 OR (LOWER(p2.family_email) = LOWER(b.family_email)
                     AND LOWER(p2.kid_first_name) = LOWER(b.kid_first_name)))
               AND p2.hour = (CASE WHEN c.scheduled_hour = 'PM2' THEN 'PM2' ELSE 'PM1' END)
               AND p2.rank = 1
             LIMIT 1) AS moved_to
    FROM class_lottery_bumps b
    JOIN class_submissions c ON c.id = b.class_submission_id
    LEFT JOIN kids k ON (b.kid_id IS NOT NULL AND k.id = b.kid_id)
                     OR (b.kid_id IS NULL
                         AND LOWER(k.family_email) = LOWER(b.family_email)
                         AND LOWER(k.first_name) = LOWER(b.kid_first_name))
    LEFT JOIN member_profiles mp ON LOWER(mp.family_email) = LOWER(b.family_email)
    WHERE b.school_year = ${year} AND b.session_number = ${sess}
      AND b.notified_at IS NULL
    ORDER BY c.class_name, b.kid_first_name`;
  const lotteryMoves = lotteryMoveRows.map(r => ({
    id: r.id,
    kid: ((r.display_first || '') + ' ' + (r.display_last || '')).trim(),
    family_email: r.fam,
    from_class: r.from_class,
    hour: r.from_hour || 'PM1',
    moved_to: r.moved_to || ''
  }));

  return {
    session: sess, school_year: year, pm_approved: stPmApproved,
    window_status: stWinStatus,
    kids_unpicked: kidsUnpicked,
    // Adult placement + assistant gaps are post-close work (Erin,
    // 2026-07-20): while sign-ups are open (or not yet opened) the
    // picture is still moving, so the VP To Dos stay hidden until
    // the session's window is closed. Empty arrays hide the rows.
    adults_unplaced: stWinStatus === 'closed' ? adultsUnplaced : [],
    assistant_gaps: stWinStatus === 'closed' ? assistantGaps : [],
    overmax: overmax,
    // Confirmations wait until EVERY kid is placed (#32, Erin's
    // rule): while kids_unpicked is non-empty the confirm To Do
    // stays hidden (empty list) — the send endpoint enforces the
    // same gate with a 409. The client explains the lock from
    // kids_unpicked, so no extra flag is needed.
    confirm_pending: kidsUnpicked.length > 0 ? [] : confirmPending,
    lottery_moves: lotteryMoves,
    // #340: owner-edited placed classes awaiting a reviewer look-over.
    // Not window-gated — an edit needs eyes whenever it happens.
    edited_classes: editedClasses
  };
}

module.exports = { computeSignupTodos, ageFromBirthDate, kidLacksAfternoonPick };
