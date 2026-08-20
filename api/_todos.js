// To Do notifications — ONE registry, ONE engine (#368, 2026-08-20).
//
// The portal's My Workspace To Do card is ~35 items, each with its own
// loader. "Tell people when they get a new To Do" therefore can't live at
// the 35 mutation sites that create them — it lives HERE:
//
//   TODO_KINDS   the registry: for each kind, who sees it (role titles) and
//                how to count it (one SQL COUNT in the shape the portal's
//                own loader uses). Adding a To Do = adding one entry.
//   sweepTodos   the engine: count every (kind, recipient), compare with
//                todo_notify_state.last_count, and on a RISE write a bell
//                row + device push. Falls/no-change just record. No prior
//                row = baseline (record silently) so a fresh deploy never
//                floods anyone.
//   touchTodos   the one-line hook for mutation sites: runs the sweep for
//                the kinds that mutation can raise, AFTER the response
//                (waitUntil), errors swallowed. A daily cron sweeps all
//                kinds as the safety net (date-gated items, anything a
//                hook missed).
//
// Audience = current holders of the role titles (role_holders_v2 for the
// effective school year), falling back to the board mailbox when a board
// role has no holder row. Notifications are addressed to the holder's
// login; _push/_permissions' identity resolver fans that to their family
// alias / role mailbox devices exactly as every other notification.
//
// Deliberately NOT registered:
//   • kinds whose source already sends a targeted notification — adding a
//     generic one would double-buzz: restock (supply_low), blc-signin
//     (blc_signin_request), evseats (event_seat_interest), enroll-req
//     (enrollment_request), editedcls (class_resubmitted).
//   • the session-state kinds inside api/curriculum.js signup-todos
//     (vp-adults, vp-assist, kids-unpicked, acl-overmax, acl-confirm) —
//     register them once that block is pulled out into a reusable
//     computeSignupTodos(sql, year, session).
//   • purely date-gated nags (handbook, drbinder, coop-cal, role-holders,
//     welcome-outreach, pmplan) and compound ones (onboard, reginv-*,
//     welcome-*, morning) — candidates for the daily cron later.

const { waitUntil } = require('@vercel/functions');
const { BOARD_ROLE_EMAILS, effectiveSchoolYear } = require('./_permissions');
const { pushNotifications } = require('./_push');

const DEFAULT_SEASON = '2026-2027';
const LINK = '/members.html';

// ── helpers shared by count functions ──────────────────────────────────
function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Indiana/Indianapolis' }).format(new Date());
}
const dayStr = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));

// The session the portal calls "current": live today, else the next one
// to start, else the last one. null when the year has no sessions yet.
async function currentSession(sql, year) {
  const rows = await sql`SELECT session_number, start_date, end_date FROM co_op_sessions
    WHERE school_year = ${year} ORDER BY session_number`;
  if (!rows.length) return null;
  const today = todayET();
  const live = rows.find(r => dayStr(r.start_date) <= today && dayStr(r.end_date) >= today);
  if (live) return live.session_number;
  const next = rows.find(r => dayStr(r.start_date) > today);
  return (next || rows[rows.length - 1]).session_number;
}

const n = rows => (rows[0] && rows[0].n) || 0;

// ── the registry ───────────────────────────────────────────────────────
// count(sql, ctx) → integer. ctx = { year, season, session }.
const TODO_KINDS = {
  'classreview': {
    label: 'Review new class submissions',
    roles: ['Vice President'],
    count: (sql, c) => sql`SELECT COUNT(*)::int AS n FROM class_submissions
      WHERE status = 'submitted' AND school_year = ${c.year}`.then(n)
  },
  'classreview-pm': {
    label: 'Review new afternoon class submissions',
    roles: ['Afternoon Class Liaison'],
    count: (sql, c) => sql`SELECT COUNT(*)::int AS n FROM class_submissions
      WHERE status = 'submitted' AND school_year = ${c.year} AND class_period = 'PM'`.then(n)
  },
  'acl-lotmoves': {
    label: 'Tell families about lottery moves',
    roles: ['Afternoon Class Liaison'],
    count: (sql, c) => sql`SELECT COUNT(*)::int AS n FROM class_lottery_bumps
      WHERE school_year = ${c.year} AND notified_at IS NULL`.then(n)
  },
  'cleaning': {
    label: 'Assign cleaning areas',
    roles: ['Cleaning Crew Liaison'],
    count: (sql, c) => !c.session ? Promise.resolve(0) : sql`SELECT COUNT(*)::int AS n FROM cleaning_areas a
      WHERE a.floor_key <> 'floater' AND NOT EXISTS (
        SELECT 1 FROM cleaning_assignments ca
        WHERE ca.cleaning_area_id = a.id AND ca.session_number = ${c.session}
          AND ca.school_year = ${c.year})`.then(n)
  },
  'merch-restock': {
    label: 'Replenish merch stock',
    roles: ['Merchandise Manager'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM merch_variants v
      LEFT JOIN (SELECT oi.variant_id, SUM(oi.qty)::int AS backordered
                 FROM merch_desk_order_items oi JOIN merch_desk_orders o ON o.id = oi.order_id
                 WHERE oi.stock_status = 'backordered' AND o.status NOT IN ('cancelled', 'delivered')
                   AND o.screen_reason = '' GROUP BY oi.variant_id) b ON b.variant_id = v.id
      WHERE v.active = TRUE AND (COALESCE(b.backordered, 0) > 0 OR v.on_hand < v.restock_threshold)`.then(n)
  },
  'merch-open': {
    label: 'Outstanding merch pre-orders',
    roles: ['Merchandise Manager'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM merch_desk_orders
      WHERE status IN ('pending_payment', 'paid', 'ready') AND screen_reason = ''`.then(n)
  },
  'waivers': {
    label: 'Pending waivers',
    roles: ['Communications Director'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM waiver_signatures ws
      LEFT JOIN registrations r ON r.id = ws.registration_id
      WHERE ws.role IN ('backup_coach', 'one_off', 'guest', 'community_liaison', 'kid_addition')
        AND ws.signed_at IS NULL AND ws.last_sent_at IS NULL
        AND (ws.registration_id IS NULL OR r.declined_at IS NULL)`.then(n)
  },
  'gaccounts': {
    label: 'Remove Google accounts — withdrawn families',
    roles: ['Communications Director'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM member_profiles
      WHERE withdrawn_at IS NOT NULL AND account_removed_at IS NULL`.then(n)
  },
  'inquiry': {
    label: 'New inquiries',
    roles: ['Membership Director'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM tours WHERE status = 'inquiry'`.then(n)
  },
  'tours': {
    label: 'Tour requests',
    roles: ['Membership Director'],
    count: sql => sql`SELECT COUNT(*)::int AS n FROM tours WHERE status = 'requested'`.then(n)
  },
  'pending': {
    label: 'Pending-payment registrations',
    roles: ['Treasurer'],
    count: (sql, c) => sql`SELECT COUNT(*)::int AS n FROM registrations
      WHERE season = ${c.season} AND declined_at IS NULL
        AND LOWER(COALESCE(payment_status, '')) <> 'paid'`.then(n)
  }
};

// ── audience ───────────────────────────────────────────────────────────
// Every holder of each title this year; board mailbox when no one holds
// a board role (mirrors getRoleHolderEmail's fallback). Lower-cased.
async function audienceFor(sql, year, titles) {
  const lc = titles.map(t => t.toLowerCase());
  // roles.title keeps the hyphenated "Vice-President"; accept both.
  const variants = lc.concat(lc.map(t => t.replace(/\s+/g, '-')));
  const rows = await sql`SELECT LOWER(r.title) AS title, LOWER(rhv.person_email) AS email
    FROM role_holders_v2 rhv JOIN roles r ON r.id = rhv.role_id
    WHERE LOWER(r.title) = ANY(${variants}::text[])
      AND rhv.school_year = ${year} AND rhv.ended_at IS NULL`;
  const out = new Set();
  titles.forEach(t => {
    const hits = rows.filter(r => r.title === t.toLowerCase() || r.title === t.toLowerCase().replace(/\s+/g, '-'));
    if (hits.length) hits.forEach(h => h.email && out.add(h.email));
    else (BOARD_ROLE_EMAILS[t.toLowerCase()] || []).slice(0, 1).forEach(e => out.add(e));
  });
  return Array.from(out);
}

// ── the engine ─────────────────────────────────────────────────────────
// Returns { checked, notified } for logging / the cron response.
async function sweepTodos(sql, kinds) {
  const keys = (Array.isArray(kinds) && kinds.length ? kinds : Object.keys(TODO_KINDS))
    .filter(k => TODO_KINDS[k]);
  if (!keys.length) return { checked: 0, notified: 0 };
  const year = await effectiveSchoolYear(sql);
  const ctx = { year, season: DEFAULT_SEASON, session: await currentSession(sql, year) };
  const stateRows = await sql`SELECT kind, recipient_email, last_count FROM todo_notify_state
    WHERE school_year = ${year} AND kind = ANY(${keys}::text[])`;
  const state = {};
  stateRows.forEach(r => { state[r.kind + '|' + r.recipient_email] = r.last_count; });

  let checked = 0;
  const inserted = [];
  for (const key of keys) {
    const def = TODO_KINDS[key];
    let count;
    try { count = await def.count(sql, ctx); } catch (e) { console.error('[todos] count failed:', key, e.message); continue; }
    const people = await audienceFor(sql, year, def.roles);
    for (const email of people) {
      checked++;
      const prev = state[key + '|' + email];
      const rise = prev !== undefined && count > prev;
      if (prev === undefined || count !== prev) {
        await sql`INSERT INTO todo_notify_state (kind, recipient_email, school_year, last_count, last_notified_at, updated_at)
          VALUES (${key}, ${email}, ${year}, ${count}, ${rise ? new Date() : null}, NOW())
          ON CONFLICT (kind, recipient_email, school_year) DO UPDATE
            SET last_count = EXCLUDED.last_count, updated_at = NOW(),
                last_notified_at = COALESCE(EXCLUDED.last_notified_at, todo_notify_state.last_notified_at)`;
      }
      if (!rise) continue;
      const added = count - prev;
      const title = 'New To Do: ' + def.label;
      const body = (added === 1 ? 'One new item' : added + ' new items') + ' — ' + count + ' waiting in My Workspace.';
      const rows = await sql`INSERT INTO notifications (recipient_email, type, title, body, link_url)
        VALUES (${email}, 'todo', ${title}, ${body}, ${LINK})
        RETURNING id, recipient_email, title, body, link_url`;
      inserted.push(...rows);
    }
  }
  if (inserted.length) {
    try { await pushNotifications(sql, inserted); } catch (e) { console.error('[todos] push (non-fatal):', e.message); }
  }
  return { checked, notified: inserted.length };
}

// The mutation-site hook. Never throws, never delays the response.
function touchTodos(sql, kinds) {
  const work = sweepTodos(sql, kinds).catch(e => console.error('[todos] sweep (non-fatal):', e.message));
  if (typeof waitUntil === 'function') { try { waitUntil(work); return; } catch (e) { /* fall through */ } }
  // Outside Vercel (tests / scripts) there is nothing to hold the process
  // open for — the promise is already running.
}

module.exports = { TODO_KINDS, sweepTodos, touchTodos, audienceFor, currentSession };
