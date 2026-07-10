// Capability registry + grant resolution — the "Permissions" admin layer.
//
// Erin (2026-07-09): "I'm getting overwhelmed and lost with all the role
// views — give Comms an admin table to view and edit permissions." Every
// feature gate that used to hardcode role titles now resolves through a
// named CAPABILITY. Each capability carries the default role list that
// exactly matches the pre-existing hardcoded behavior; the Comms Director
// can override any of them from Workspace → Admin Consoles → Permissions.
//
// Resolution:
//   - capability_grants has NO rows for a key  → defaultRoles apply.
//   - capability_grants has rows for a key     → that row set IS the list
//     (the reserved title '__none__' marks "customized to no roles").
//   - hasCapability(email, key) passes when the email can act as ANY
//     granted title via canEditAsRole (board mailboxes + role_holders_v2).
//     It deliberately has NO super-user shortcut, mirroring canEditAsRole —
//     call sites keep their own isSuperUser handling where they had it.
//   - On a grants-table read error we fall back to the DEFAULTS (i.e. the
//     long-standing hardcoded behavior), never to "deny everything".
//
// LOCKED_RULES are structural rules shown read-only in the admin table so
// the whole permission story lives on one screen — they are enforced by
// dedicated code paths, not by this table.

const { neon } = require('@neondatabase/serverless');
const { canEditAsRole } = require('./_permissions');

const NONE_SENTINEL = '__none__';

const CAPABILITIES = [
  // ── Classes & Scheduling ──
  {
    key: 'class_review',
    area: 'Classes & Scheduling',
    label: 'Class Builder — review & schedule',
    desc: 'Full Class Builder access: review submitted classes, place morning + afternoon schedules, assign helpers, approve sessions. (Age-group liaisons separately keep morning access for their own group — see the fixed rules below.)',
    defaultRoles: ['Vice President', 'Afternoon Class Liaison']
  },
  {
    key: 'morning_builder',
    area: 'Classes & Scheduling',
    label: 'Morning Class Builder — view',
    desc: 'Open the Morning Class Builder (kid → age group placement view).',
    defaultRoles: ['Membership Director', 'Vice President']
  },
  {
    key: 'morning_builder_place',
    area: 'Classes & Scheduling',
    label: 'Morning Class Builder — place kids',
    desc: 'Move kids between age groups, seed the year, and finalize placements.',
    defaultRoles: ['Membership Director']
  },
  {
    key: 'session_dates_edit',
    area: 'Classes & Scheduling',
    label: 'Session dates — edit',
    desc: 'Set each session’s start and end dates on the Admin Calendar (drives the whole year: billing windows, participation reset, derived board tasks).',
    defaultRoles: ['President', 'Vice President']
  },
  {
    key: 'room_assign',
    area: 'Classes & Scheduling',
    label: 'Classrooms — assign to classes',
    desc: 'Pick which room each placed class meets in, from the class editor in the Class Builder. A room can only host one class per hour.',
    defaultRoles: ['President', 'Vice President', 'Afternoon Class Liaison']
  },
  {
    key: 'facilities_manage',
    area: 'Classes & Scheduling',
    label: 'Facilities — manage rooms',
    desc: 'Add, edit, and archive rooms plus the notes the Class Builder shows (“smaller class”, “has sinks”, …).',
    defaultRoles: ['President', 'Vice President', 'Afternoon Class Liaison']
  },

  // ── Participation ──
  {
    key: 'participation_view',
    area: 'Participation',
    label: 'Participation Tracker — view',
    desc: 'Open the Member Participation report.',
    defaultRoles: ['Vice President', 'Afternoon Class Liaison']
  },
  {
    key: 'participation_edit',
    area: 'Participation',
    label: 'Participation Tracker — edit settings',
    desc: 'Change the season goal, points per activity, and exemptions.',
    defaultRoles: ['Vice President', 'Afternoon Class Liaison']
  },

  // ── Membership & Tours ──
  {
    key: 'membership_report_act',
    area: 'Membership & Tours',
    label: 'Membership Report — act on registrations',
    desc: 'See the Actions column in the Membership Report. (Every board member can already VIEW the report read-only — that part is fixed.)',
    defaultRoles: ['Membership Director', 'Communications Director', 'Treasurer']
  },
  {
    key: 'registration_decline',
    area: 'Membership & Tours',
    label: 'Registrations — decline',
    desc: 'Decline a family’s registration (sends the decline email).',
    defaultRoles: ['Membership Director']
  },
  {
    key: 'registration_mark_paid',
    area: 'Membership & Tours',
    label: 'Registrations — mark payment received',
    desc: 'Confirm a pending cash/check registration as paid.',
    defaultRoles: ['Treasurer']
  },
  {
    key: 'registration_invite',
    area: 'Membership & Tours',
    label: 'Send Registration Form',
    desc: 'Email a family the registration form link.',
    defaultRoles: ['Membership Director', 'Communications Director']
  },
  {
    key: 'tours_view',
    area: 'Membership & Tours',
    label: 'Tour Pipeline — view',
    desc: 'See prospective-family tour requests and their status.',
    defaultRoles: ['Membership Director']
  },
  {
    key: 'tours_manage',
    area: 'Membership & Tours',
    label: 'Tour Pipeline — schedule & update',
    desc: 'Schedule tours, mark them toured/joined/declined.',
    defaultRoles: ['Membership Director']
  },

  // ── Waivers & Onboarding ──
  {
    key: 'waivers_manage',
    area: 'Waivers & Onboarding',
    label: 'Waivers — report, send & resend',
    desc: 'Open the Waivers Report, send one-off waivers, and resend pending signing links.',
    defaultRoles: ['Communications Director']
  },
  {
    key: 'member_onboarding',
    area: 'Waivers & Onboarding',
    label: 'Member Onboarding checklist',
    desc: 'Work the new-family onboarding queue (Workspace account, distribution list, welcome email).',
    defaultRoles: ['Communications Director']
  },
  {
    key: 'welcome_manage',
    area: 'Waivers & Onboarding',
    label: 'Welcome List — mark families welcomed',
    desc: 'Toggle welcomed / met status on the Welcome Coordinator’s list. (Every board member can view the list — that part is fixed.)',
    defaultRoles: ['Welcome Coordinator']
  },

  // ── Roles & Events ──
  {
    key: 'roles_structure',
    area: 'Roles & Events',
    label: 'Roles — create, archive & restructure',
    desc: 'Add roles, archive them, move them between committees, and change categories.',
    defaultRoles: ['President']
  },
  {
    key: 'board_roles_assign',
    area: 'Roles & Events',
    label: 'Board seats — assign holders',
    desc: 'Assign or remove who holds a board seat (tied to the Google Workspace role mailboxes).',
    defaultRoles: ['Communications Director']
  },
  {
    key: 'committee_roles_assign',
    area: 'Roles & Events',
    label: 'Committee roles — assign any holder',
    desc: 'Assign or remove holders on ANY committee/volunteer role. (Committee chairs can always assign within their own committee — see the fixed rules below.)',
    defaultRoles: ['Vice President']
  },
  {
    key: 'board_confirm',
    area: 'Roles & Events',
    label: 'Board roles — biennial confirmation',
    desc: 'Mark the two-year board term as confirmed (syncs Google Admin + portal).',
    defaultRoles: ['Communications Director']
  },
  {
    key: 'special_events_manage',
    area: 'Roles & Events',
    label: 'Special Events — dates, leads & assistants',
    desc: 'Propose/approve event dates on the Admin Calendar and assign each event’s lead + assistants.',
    defaultRoles: ['Special Events Liaison', 'Vice President']
  },

  // ── Operations ──
  {
    key: 'supply_closet_edit',
    area: 'Operations',
    label: 'Supply Closet — edit inventory & locations',
    desc: 'Add/edit closet items and manage storage locations.',
    defaultRoles: ['Supply Coordinator']
  },
  {
    key: 'merch_manage',
    area: 'Operations',
    label: 'Merchandise orders — manage',
    desc: 'View and fulfill merch orders.',
    defaultRoles: ['Communications Director', 'Merchandise Manager']
  },
  {
    key: 'coverage_admin',
    area: 'Operations',
    label: 'Absences & coverage — act for any member',
    desc: 'Cancel any member’s absence and manage coverage slots on their behalf (members always manage their own).',
    defaultRoles: ['Vice President']
  }
];

// Structural rules displayed read-only in the Permissions table. These are
// enforced by dedicated code paths — listing them here keeps the whole
// permission story visible on one screen.
const LOCKED_RULES = [
  {
    label: 'Super users',
    desc: 'communications@ and vicepresident@/vp@ can View-As any family/role and administer everything, in every environment.'
  },
  {
    label: 'Board mailboxes = their role',
    desc: 'Signing in with a board mailbox (treasurer@, president@, …) always counts as holding that role, regardless of role assignments.'
  },
  {
    label: 'Committee chairs manage their own committee',
    desc: 'Whoever holds a role can edit content + assign holders for every role underneath it in the org chart (the parent-chain rule).'
  },
  {
    label: 'Age-group liaisons build their own group’s mornings',
    desc: 'A "<Group> Liaison" can review, place, and edit MORNING classes for their group only, inside the Class Builder.'
  },
  {
    label: 'Board members read core reports',
    desc: 'Every board member can view the Membership Report (read-only) and the Admin Calendar; members always see their own family’s data.'
  }
];

const CAPABILITY_KEYS = CAPABILITIES.map(c => c.key);
const CAPS_BY_KEY = {};
CAPABILITIES.forEach(c => { CAPS_BY_KEY[c.key] = c; });

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(process.env.DATABASE_URL);
}

// Pure resolution — exported for tests. rowsByKey: { key: [role_title, …] }
// straight from capability_grants. Returns the effective role list.
function effectiveRolesFor(key, rowsByKey) {
  const cap = CAPS_BY_KEY[key];
  if (!cap) return [];
  const rows = (rowsByKey || {})[key];
  if (!Array.isArray(rows) || rows.length === 0) return cap.defaultRoles.slice();
  return rows.filter(t => t && t !== NONE_SENTINEL);
}

// 60s module cache of the grants table (same TTL as the old perms cache).
// Failure → null map → defaults apply (today's behavior), never deny-all.
let _grantsCache = { at: 0, rowsByKey: null };
const GRANTS_TTL_MS = 60 * 1000;

async function grantRowsByKey() {
  const now = Date.now();
  if (_grantsCache.rowsByKey && (now - _grantsCache.at) < GRANTS_TTL_MS) {
    return _grantsCache.rowsByKey;
  }
  try {
    const sql = getSql();
    const rows = await sql`SELECT capability_key, role_title FROM capability_grants`;
    const byKey = {};
    rows.forEach(r => {
      (byKey[r.capability_key] || (byKey[r.capability_key] = [])).push(r.role_title);
    });
    _grantsCache = { at: now, rowsByKey: byKey };
    return byKey;
  } catch (err) {
    console.error('[capabilities] grants read failed (falling back to defaults):', err.message);
    return {};
  }
}

function invalidateGrantsCache() {
  _grantsCache = { at: 0, rowsByKey: null };
}

async function capabilityRoles(key) {
  const byKey = await grantRowsByKey();
  return effectiveRolesFor(key, byKey);
}

// Can this email act under capability `key`? True when the email can act
// as ANY of the granted role titles. Checks run in parallel; canEditAsRole
// handles board mailboxes + role_holders_v2 + title aliases.
async function hasCapability(userEmail, key) {
  if (!userEmail || !CAPS_BY_KEY[key]) return false;
  const titles = await capabilityRoles(key);
  if (titles.length === 0) return false;
  const results = await Promise.all(titles.map(t => canEditAsRole(userEmail, t)));
  return results.indexOf(true) !== -1;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_KEYS,
  LOCKED_RULES,
  NONE_SENTINEL,
  capabilityRoles,
  hasCapability,
  invalidateGrantsCache,
  // Exported for tests:
  _effectiveRolesFor: effectiveRolesFor
};
