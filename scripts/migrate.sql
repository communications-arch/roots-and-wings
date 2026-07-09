-- Roots & Wings database schema
-- Idempotent: safe to re-run.

-- ──────────────────────────────────────────────
-- Supply Closet Inventory
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supply_closet (
  id SERIAL PRIMARY KEY,
  item_name TEXT NOT NULL,
  location TEXT DEFAULT '',
  category TEXT NOT NULL CHECK (category IN (
    'permanent',
    'currently_available',
    'classroom_cabinet',
    'game_closet'
  )),
  notes TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS supply_closet_category_idx ON supply_closet (category);

-- Restock flag (any member can flag; Supply Coordinator clears) +
-- coordinator-only quantity tracking. Idempotent adds for existing deploys.
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS needs_restock BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS restock_flagged_at TIMESTAMPTZ;
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS restock_flagged_by TEXT DEFAULT '';
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS quantity_level TEXT
  CHECK (quantity_level IS NULL OR quantity_level IN ('empty','low','medium','high'));
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS quantity_updated_at TIMESTAMPTZ;
ALTER TABLE supply_closet ADD COLUMN IF NOT EXISTS quantity_updated_by TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS supply_closet_restock_idx ON supply_closet (needs_restock) WHERE needs_restock = TRUE;

-- ──────────────────────────────────────────────
-- Curriculum: 5-week lesson plans
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS curricula (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT DEFAULT '',
  age_range TEXT DEFAULT '',
  overview TEXT DEFAULT '',
  tags TEXT[] DEFAULT '{}',
  author_email TEXT NOT NULL,
  author_name TEXT DEFAULT '',
  parent_id INTEGER REFERENCES curricula(id) ON DELETE SET NULL,
  edit_policy TEXT NOT NULL DEFAULT 'author_only'
    CHECK (edit_policy IN ('author_only', 'open')),
  lesson_count INTEGER NOT NULL DEFAULT 5
    CHECK (lesson_count BETWEEN 1 AND 5),
  -- 'AM' / 'PM' / 'both' — helps PM submitters browse relevant past plans.
  block TEXT DEFAULT ''
    CHECK (block IN ('', 'AM', 'PM', 'both')),
  -- VP + Afternoon Class Liaison can star lessons kids loved or rushed to sign up for.
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Back-compat: pick up the new columns on existing deployments. Must run
-- before the indexes below that reference them.
ALTER TABLE curricula ADD COLUMN IF NOT EXISTS block TEXT DEFAULT '';
ALTER TABLE curricula ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS curricula_author_idx ON curricula (author_email);
CREATE INDEX IF NOT EXISTS curricula_subject_idx ON curricula (subject);
CREATE INDEX IF NOT EXISTS curricula_block_idx ON curricula (block);
CREATE INDEX IF NOT EXISTS curricula_favorite_idx ON curricula (is_favorite) WHERE is_favorite;

CREATE TABLE IF NOT EXISTS lessons (
  id SERIAL PRIMARY KEY,
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  lesson_number INTEGER NOT NULL CHECK (lesson_number BETWEEN 1 AND 5),
  title TEXT DEFAULT '',
  overview TEXT DEFAULT '',
  room_setup TEXT DEFAULT '',
  activity TEXT[] DEFAULT '{}',
  instruction TEXT[] DEFAULT '{}',
  links JSONB DEFAULT '[]',
  UNIQUE (curriculum_id, lesson_number)
);
CREATE INDEX IF NOT EXISTS lessons_curriculum_idx ON lessons (curriculum_id);

-- Idempotent column add for existing deployments
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS room_setup TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS curriculum_supplies (
  id SERIAL PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  qty TEXT DEFAULT '',
  qty_unit TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  closet_item_id INTEGER REFERENCES supply_closet(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS curriculum_supplies_lesson_idx ON curriculum_supplies (lesson_id);

-- Idempotent column add for existing deployments
ALTER TABLE curriculum_supplies ADD COLUMN IF NOT EXISTS qty_unit TEXT DEFAULT '';
ALTER TABLE curriculum_supplies ADD COLUMN IF NOT EXISTS source TEXT DEFAULT '';

-- ──────────────────────────────────────────────
-- Supply Storage Locations (managed by coordinator)
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS supply_locations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- ──────────────────────────────────────────────
-- Absence & Coverage System
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS absences (
  id SERIAL PRIMARY KEY,
  family_email TEXT NOT NULL,
  family_name TEXT NOT NULL,
  absent_person TEXT NOT NULL,
  session_number INTEGER NOT NULL,
  absence_date DATE NOT NULL,
  blocks TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS absences_date_idx ON absences (absence_date);
CREATE INDEX IF NOT EXISTS absences_session_idx ON absences (session_number);
-- Partial unique index: only one active (non-cancelled) absence per
-- person/date, but cancelled rows don't block re-submission.
CREATE UNIQUE INDEX IF NOT EXISTS absences_active_unique_idx
  ON absences (absent_person, absence_date)
  WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS coverage_slots (
  id SERIAL PRIMARY KEY,
  absence_id INTEGER NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
  block TEXT NOT NULL,
  role_type TEXT NOT NULL,
  role_description TEXT NOT NULL,
  group_or_class TEXT DEFAULT '',
  claimed_by_email TEXT,
  claimed_by_name TEXT,
  claimed_at TIMESTAMPTZ,
  assigned_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS coverage_slots_absence_idx ON coverage_slots (absence_id);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link_url TEXT DEFAULT '',
  related_absence_id INTEGER REFERENCES absences(id) ON DELETE SET NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_email, is_read);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_email TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_sub_email_idx ON push_subscriptions (user_email);

CREATE TABLE IF NOT EXISTS class_curriculum_links (
  id SERIAL PRIMARY KEY,
  session_number INTEGER NOT NULL,
  class_key TEXT NOT NULL,
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  attached_by TEXT DEFAULT '',
  attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_number, class_key)
);

-- ──────────────────────────────────────────────
-- Cleaning Crew Management
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cleaning_areas (
  id SERIAL PRIMARY KEY,
  floor_key TEXT NOT NULL CHECK (floor_key IN ('mainFloor', 'upstairs', 'outside', 'floater')),
  area_name TEXT NOT NULL,
  tasks TEXT[] DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT '',
  UNIQUE (floor_key, area_name)
);

CREATE TABLE IF NOT EXISTS cleaning_assignments (
  id SERIAL PRIMARY KEY,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 5),
  cleaning_area_id INTEGER NOT NULL REFERENCES cleaning_areas(id) ON DELETE CASCADE,
  family_name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT '',
  UNIQUE (session_number, cleaning_area_id, family_name)
);
CREATE INDEX IF NOT EXISTS cleaning_assign_session_idx ON cleaning_assignments (session_number);

CREATE TABLE IF NOT EXISTS cleaning_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  liaison_name TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);
INSERT INTO cleaning_config (liaison_name) VALUES ('') ON CONFLICT (id) DO NOTHING;

-- ──────────────────────────────────────────────
-- Role Descriptions
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS role_descriptions (
  id SERIAL PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  job_length TEXT DEFAULT '',
  overview TEXT DEFAULT '',
  duties TEXT[] DEFAULT '{}',
  committee TEXT DEFAULT '',
  last_reviewed_by TEXT DEFAULT '',
  last_reviewed_date TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT DEFAULT ''
);
-- Long-form playbook / handoff doc. Shared across whoever holds the role;
-- editable from the Workspace by the current role holder.
ALTER TABLE role_descriptions ADD COLUMN IF NOT EXISTS playbook TEXT DEFAULT '';

-- Hierarchy + state. parent_role_id points up the org chart (e.g., a
-- Facility Committee role's parent is the President). category groups
-- rows in the Roles management UI ('board' | 'committee_role' |
-- 'cleaning_area' | 'class'). status toggles between 'active' and
-- 'archived' — archived rows stay in the DB for history but hide from
-- the default lists. display_order lets the President reorder within a
-- committee without renaming.
ALTER TABLE role_descriptions
  ADD COLUMN IF NOT EXISTS parent_role_id INTEGER
    REFERENCES role_descriptions(id) ON DELETE SET NULL;
ALTER TABLE role_descriptions
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'committee_role';
ALTER TABLE role_descriptions
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE role_descriptions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- Tightly validate status + category values. Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS" and the migration runner splits on
-- semicolons, so DO-blocks break parsing — drop-then-add is the
-- idempotent equivalent and lets future value tweaks land cleanly.
ALTER TABLE role_descriptions DROP CONSTRAINT IF EXISTS role_descriptions_status_chk;
ALTER TABLE role_descriptions ADD CONSTRAINT role_descriptions_status_chk CHECK (status IN ('active','archived'));
ALTER TABLE role_descriptions DROP CONSTRAINT IF EXISTS role_descriptions_category_chk;
ALTER TABLE role_descriptions ADD CONSTRAINT role_descriptions_category_chk CHECK (category IN ('board','committee_role','cleaning_area','class'));

CREATE INDEX IF NOT EXISTS role_descriptions_parent_idx
  ON role_descriptions (parent_role_id);
CREATE INDEX IF NOT EXISTS role_descriptions_status_idx
  ON role_descriptions (status);
CREATE INDEX IF NOT EXISTS role_descriptions_category_idx
  ON role_descriptions (category);

-- ──────────────────────────────────────────────
-- Role Holders
-- ──────────────────────────────────────────────
-- Who currently holds each board / committee role for a given school
-- year. Many-to-one with role_descriptions: multiple holders per role
-- are allowed (e.g., Classroom Instructor in a session, co-chairs).
-- Cleaning-crew assignments stay in cleaning_assignments (per-session,
-- different cadence), so role_holders only concerns board +
-- committee_role categories in practice.
--
-- Phase A: this table is seeded from the volunteer sheet for read-only
-- display. The sheet stays authoritative for permission checks until
-- Phase B cuts _permissions.js and the participation tracker over to
-- read from here.
-- person_name + family_name are SNAPSHOTS at assignment time — they
-- preserve historical attribution (who held this role for school_year X)
-- even if the underlying people row is later edited or deleted. They are
-- NOT the source of truth for the holder's *current* display name. For
-- live UI / outbound email, resolve the name by joining role_holders.email
-- to people (LOWER(p.email) = LOWER(rh.email) OR p.family_email = rh.email,
-- AND p.role = 'mlc'), and fall back to person_name only if no people row
-- matches.
CREATE TABLE IF NOT EXISTS role_holders (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES role_descriptions(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  person_name TEXT NOT NULL DEFAULT '',
  family_name TEXT NOT NULL DEFAULT '',
  school_year TEXT NOT NULL DEFAULT '2025-2026',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);
-- Prevent the same person being listed twice for the same role in the
-- same year (normalize email to lowercase via a functional index).
CREATE UNIQUE INDEX IF NOT EXISTS role_holders_unique_idx
  ON role_holders (role_id, LOWER(email), school_year);
CREATE INDEX IF NOT EXISTS role_holders_role_idx ON role_holders (role_id);
CREATE INDEX IF NOT EXISTS role_holders_year_idx ON role_holders (school_year);
CREATE INDEX IF NOT EXISTS role_holders_email_idx ON role_holders (LOWER(email));

-- ──────────────────────────────────────────────
-- Board photo cache (for the public site)
-- Populated as a side effect of /api/photos calls from logged-in members.
-- Served unauthenticated via /api/photos?scope=board so index.html can
-- render real Workspace profile photos without requiring sign-in.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS board_photos (
  email TEXT PRIMARY KEY,
  photo_url TEXT NOT NULL,
  role_title TEXT DEFAULT '',
  full_name TEXT DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS board_photos_role_idx ON board_photos (role_title);

-- ──────────────────────────────────────────────
-- Member Registrations (new + returning families each co-op year)
-- Populated by the public /register.html form. Next year this table replaces
-- the Google Sheet as the source of truth for member records.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS registrations (
  id SERIAL PRIMARY KEY,
  season TEXT NOT NULL,
  email TEXT NOT NULL,
  existing_family_name TEXT,
  main_learning_coach TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  track TEXT NOT NULL,
  track_other TEXT DEFAULT '',
  kids JSONB NOT NULL DEFAULT '[]'::jsonb,
  placement_notes TEXT DEFAULT '',
  waiver_member_agreement BOOLEAN NOT NULL DEFAULT FALSE,
  waiver_photo_consent TEXT NOT NULL DEFAULT 'no',
  waiver_liability BOOLEAN NOT NULL DEFAULT FALSE,
  signature_name TEXT NOT NULL,
  signature_date DATE NOT NULL,
  student_signature TEXT DEFAULT '',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  paypal_transaction_id TEXT DEFAULT '',
  payment_amount NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_email_season_idx
  ON registrations (LOWER(email), season);
CREATE INDEX IF NOT EXISTS registrations_season_idx ON registrations (season);
CREATE INDEX IF NOT EXISTS registrations_payment_status_idx ON registrations (payment_status);

-- Member onboarding checklist columns (Phase 1, manual). Comms Director
-- ticks each as she completes the step in Workspace; the welcome email
-- is gated on the first two being done. NULL = not done; TIMESTAMPTZ =
-- when it was marked done. Doesn't apply to returning families
-- (existing_family_name set) — they're already onboarded.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS workspace_account_created_at TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS distribution_list_added_at  TIMESTAMPTZ;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS welcome_email_sent_at        TIMESTAMPTZ;

-- ──────────────────────────────────────────────
-- Backup Learning Coach waivers
-- One row per backup adult (spouse, grandparent, etc.) the Main LC listed at
-- registration. Each row carries a unique token used to sign via waiver.html.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_coach_waivers (
  id SERIAL PRIMARY KEY,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  signed_at TIMESTAMPTZ,
  signature_name TEXT DEFAULT '',
  signature_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS backup_coach_waivers_registration_idx ON backup_coach_waivers (registration_id);
CREATE INDEX IF NOT EXISTS backup_coach_waivers_token_idx ON backup_coach_waivers (token);
-- Per-adult photo opt-out captured at sign time. NULL means not-yet-signed
-- (pre-opt-out waivers default to consent=true on the app side).
ALTER TABLE backup_coach_waivers ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN NOT NULL DEFAULT TRUE;

-- ──────────────────────────────────────────────
-- One-off waivers (Comms Director sends ad-hoc to a last-minute adult who
-- is not tied to a registration — e.g. a visiting guardian, a substitute
-- helper, or a new member whose paperwork got missed). Shares the same
-- signing flow as backup_coach_waivers; tour.js token lookup falls back
-- to this table when a token isn't found in backup_coach_waivers.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS one_off_waivers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  sent_by_email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at TIMESTAMPTZ,
  signature_name TEXT DEFAULT '',
  signature_date DATE,
  note TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS one_off_waivers_token_idx ON one_off_waivers (token);
CREATE INDEX IF NOT EXISTS one_off_waivers_email_idx ON one_off_waivers (email);
ALTER TABLE one_off_waivers ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN NOT NULL DEFAULT TRUE;

-- "Last resend" timestamp for both waiver tables. Set when Comms hits
-- the Resend action on a pending row in the Waivers Report; the
-- waivers-report GET reads COALESCE(last_sent_at, original) so the
-- report shows the most recent send date for prioritization.
ALTER TABLE backup_coach_waivers ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
ALTER TABLE one_off_waivers      ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;

-- ──────────────────────────────────────────────
-- Waiver signatures — consolidated, versioned record of every signed waiver.
--
-- Replaces the three split sources (registrations.signature_*, backup_coach_waivers,
-- one_off_waivers) with one row per (person_email, season). The waiver_version
-- column is a date string (e.g. '2026-04-27') that maps to an archived copy in
-- /waivers/<version>.html, so any future reader can see the exact text someone
-- agreed to. New signatures land here; the legacy tables stay populated by the
-- backfill until callers are fully migrated, then drop in a follow-up.
--
-- Annual re-signing is implicit: a new season produces a fresh row. The unique
-- index on (LOWER(person_email), season) prevents accidental duplicates while
-- still allowing the same person to sign year over year.
--
-- pending_token is set only while a backup-coach or one-off recipient hasn't
-- signed yet; on sign it stays in place (so the token URL keeps resolving) but
-- signed_at / signature_name / signature_date / waiver_version become populated.
--
-- waiver_version is set at *sign time* (not row creation), so a backup coach
-- who reads a newer version reflects what they actually agreed to. NULL until
-- signed.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waiver_signatures (
  id SERIAL PRIMARY KEY,
  season TEXT NOT NULL,
  waiver_version TEXT,
  role TEXT NOT NULL CHECK (role IN ('main_lc', 'backup_coach', 'one_off')),
  person_name TEXT NOT NULL,
  person_email TEXT NOT NULL,
  family_email TEXT DEFAULT '',
  registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
  signed_at TIMESTAMPTZ,
  signature_name TEXT DEFAULT '',
  signature_date DATE,
  photo_consent BOOLEAN NOT NULL DEFAULT TRUE,
  pending_token TEXT UNIQUE,
  sent_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  sent_by_email TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS waiver_signatures_person_season_idx
  ON waiver_signatures (LOWER(person_email), season);
CREATE INDEX IF NOT EXISTS waiver_signatures_registration_idx
  ON waiver_signatures (registration_id);
CREATE INDEX IF NOT EXISTS waiver_signatures_family_email_idx
  ON waiver_signatures (LOWER(family_email));
CREATE INDEX IF NOT EXISTS waiver_signatures_role_signed_idx
  ON waiver_signatures (role, signed_at);

-- ──────────────────────────────────────────────
-- Tours — prospective-family pipeline managed by the Membership Director.
-- One row per request submitted via the public tour form. Status drives
-- the lifecycle: requested → scheduled → toured → joined / declined /
-- ghosted. preferred_* is what the family picked on the form;
-- scheduled_* is what the Membership Director confirmed (may differ).
-- Tours run on Wednesdays during active sessions only — the form's date
-- picker enforces this client-side and api/tour.js validates server-side.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tours (
  id              SERIAL PRIMARY KEY,
  family_name     TEXT NOT NULL,
  family_email    TEXT NOT NULL,
  phone           TEXT DEFAULT '',
  num_kids        INTEGER,
  ages            TEXT DEFAULT '',
  preferred_date  DATE,
  preferred_time  TIME,
  scheduled_date  DATE,
  scheduled_time  TIME,
  status          TEXT NOT NULL DEFAULT 'requested',
  internal_notes  TEXT DEFAULT '',
  decline_reason  TEXT DEFAULT '',
  -- Append-only audit trail — every status change pushes
  -- { at, by, from, to, note? } onto the array.
  status_history  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tours_status_idx     ON tours (status);
CREATE INDEX IF NOT EXISTS tours_created_at_idx ON tours (created_at DESC);
CREATE INDEX IF NOT EXISTS tours_email_idx      ON tours (family_email);
-- A `tours` row can originate from the public "Schedule a Tour" form
-- (source='tour-request', the default for every pre-existing row) or the
-- public "Contact Us" form (source='contact-form'), which captures a
-- general inquiry into the same pipeline. `message` holds the visitor's
-- free-text note from the contact form (empty for tour requests).
ALTER TABLE tours ADD COLUMN IF NOT EXISTS source  TEXT NOT NULL DEFAULT 'tour-request';
ALTER TABLE tours ADD COLUMN IF NOT EXISTS message TEXT DEFAULT '';

-- ──────────────────────────────────────────────
-- Member Profiles — editable overlay on top of the Directory sheet.
-- One row per family, keyed by the derived portal login email
-- (firstParentFirstName + familyLastInitial + @rootsandwingsindy.com).
-- The Google Sheet remains the membership coordinator's seed/import surface;
-- member-self-edits land here and are overlaid by /api/sheets at read time.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS member_profiles (
  family_email    TEXT PRIMARY KEY,
  family_name     TEXT NOT NULL,
  phone           TEXT DEFAULT '',
  address         TEXT DEFAULT '',
  parents         JSONB NOT NULL DEFAULT '[]'::jsonb,
  kids            JSONB NOT NULL DEFAULT '[]'::jsonb,
  placement_notes TEXT DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS member_profiles_family_name_idx ON member_profiles (LOWER(family_name));

-- ──────────────────────────────────────────────
-- Payments: Pending state between PayPal approval and Treasurer
-- marking the row "Paid" in the Family Payment Tracking sheet.
-- Source of truth for "Paid" is the sheet; this table only holds the
-- in-flight Pending records so the UI can show them while the
-- Treasurer reconciles.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  family_name TEXT NOT NULL,
  semester_key TEXT NOT NULL CHECK (semester_key IN ('fall', 'spring')),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('deposit', 'class_fee')),
  paypal_transaction_id TEXT DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  payer_email TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Paid', 'Failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payments_family_sem_type_idx
  ON payments (LOWER(family_name), semester_key, payment_type);
-- Each payment belongs to a specific school year (Aug-May cycle). Pre-2026
-- rows didn't track this; backfill defaults to '2025-2026'. New inserts
-- (registration auto-write, recordPendingPayment) populate this explicitly.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS school_year TEXT NOT NULL DEFAULT '2025-2026';
CREATE INDEX IF NOT EXISTS payments_school_year_idx ON payments (school_year);

-- Canonical family identity. Pre-Phase-4 we joined the My Family billing
-- card to the sheet/DB by family_name (last word of MLC), which silently
-- broke for compound surnames and existing_family_name mismatches. Going
-- forward all writes set family_email (member_profiles PK); the GET
-- overlay matches by email-then-name. Backfilled by
-- scripts/backfill-payments-family-email.js.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS family_email TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS payments_family_email_idx ON payments (LOWER(family_email));

-- ──────────────────────────────────────────────
-- Participation tracking: VP + Afternoon Class Liaison report
-- Weights are admin-editable so the scoring can be tuned without a
-- redeploy. Exemptions pro-rate the expected baseline for members on
-- health/family leave. Everything the report counts (AM/PM assignments,
-- cleaning sessions, events, coverage, absences) comes from existing
-- sheet data + DB tables — these two tables only hold config + overrides.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS participation_weights (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  value       NUMERIC(6, 2) NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  updated_by  TEXT DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS participation_exemptions (
  id           SERIAL PRIMARY KEY,
  member_email TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  start_date   DATE NOT NULL,
  end_date     DATE,
  reason       TEXT NOT NULL DEFAULT 'other'
               CHECK (reason IN ('medical', 'family', 'other')),
  note         TEXT DEFAULT '',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS participation_exemptions_email_idx
  ON participation_exemptions (LOWER(member_email));

-- Seed default weights (only inserts on first migration; won't overwrite
-- tuned values on re-runs).
INSERT INTO participation_weights (key, label, value, sort_order, description) VALUES
  ('board_role',               'Board role',                5, 10, 'Weight per member who holds a board position for the year.'),
  ('one_year_role',            '1-2 year volunteer role',   2, 20, 'Weight per named volunteer role (Supply Coordinator, AM/PM Class Liaison, Kitchen, Pavilion, etc.).'),
  ('am_lead',                  'AM class — Leading',        2, 30, 'Per session, per group the member teaches in the morning.'),
  ('am_assist',                'AM class — Assisting',      1, 40, 'Per session, per group the member assists in the morning.'),
  ('pm_lead',                  'PM elective — Leading',     2, 50, 'Per elective hour led (both-hour electives count twice).'),
  ('pm_assist',                'PM elective — Assisting',   1, 60, 'Per elective hour assisted.'),
  ('cleaning_session',         'Cleaning crew session',     1, 70, 'Per session the member is on the cleaning crew.'),
  ('event_lead',               'Special event — Leading',   2, 80, 'Per event coordinated.'),
  ('event_assist',             'Special event — Assisting', 1, 90, 'Per event support slot filled.'),
  ('annual_expected_points',   'Annual expected points',   14,100, 'Default baseline each member is expected to hit across the school year. Adjust as the co-op grows.'),
  ('new_member_baseline_pct',  'New-member baseline %',    60,110, 'Percent of normal expectation for a member''s first sessions after joining. 60 means a new member is "on track" at 60%% of the normal points.'),
  ('new_member_grace_sessions','New-member grace sessions', 2,120, 'How many sessions a new member gets the reduced baseline before the full expectation kicks in.')
ON CONFLICT (key) DO NOTHING;

-- ──────────────────────────────────────────────
-- PM class submissions
-- ──────────────────────────────────────────────
-- Replaces the "25/26 Afternoon Class Submission" Google Form. Members
-- submit a proposed PM elective; VP + Afternoon Class Liaison (PM
-- Assistant) review, assign to a session/hour/age slot, and mark as
-- scheduled. When status='scheduled' the row participates in PM_ELECTIVES
-- for 26/27+ sessions (no Google Sheet write-back — DB is source of truth
-- going forward).
CREATE TABLE IF NOT EXISTS class_submissions (
  id                    SERIAL PRIMARY KEY,
  submitted_by_email    TEXT NOT NULL,
  submitted_by_name     TEXT NOT NULL DEFAULT '',
  school_year           TEXT NOT NULL DEFAULT '2026-2027',

  -- Mirrors the Google Form fields.
  class_name            TEXT NOT NULL,
  session_preferences   TEXT[] NOT NULL DEFAULT '{}',   -- {'1','2','3','4','5','flexible'}
  hour_preference       TEXT[] NOT NULL DEFAULT '{}',   -- {'first','last','flexible','2hr-required','2hr-optional'}
  assistant_count       INTEGER[] NOT NULL DEFAULT '{}', -- {1,2,3}
  co_teachers           TEXT NOT NULL DEFAULT '',
  space_request         TEXT[] NOT NULL DEFAULT '{}',   -- {'any','pavilion','outside','larger-open','kitchen','dirty','noisy','quiet'}
  space_request_other   TEXT NOT NULL DEFAULT '',
  max_students          INTEGER NOT NULL DEFAULT 12,
  max_students_other    TEXT NOT NULL DEFAULT '',       -- free-text when submitter picks "Other"
  age_groups            TEXT[] NOT NULL DEFAULT '{}',   -- {'3-7','7-9','10-12','teens'}
  age_groups_other      TEXT NOT NULL DEFAULT '',
  pre_enroll_kids       TEXT NOT NULL DEFAULT '',       -- reserved for a future flow (not surfaced in v1 UI)
  open_to_teen_assistant BOOLEAN NOT NULL DEFAULT FALSE, -- teachers opting in to Pigeons-age assistants
  prerequisites         TEXT NOT NULL DEFAULT '',
  description           TEXT NOT NULL,
  other_info            TEXT NOT NULL DEFAULT '',

  -- Review + scheduling state.
  status                TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted','drafted','scheduled','declined','withdrawn')),
  scheduled_session     INTEGER,                        -- 1..5
  scheduled_hour        TEXT,                           -- 'PM1','PM2','both'
  scheduled_age_range   TEXT,                           -- e.g. 'Saplings (3-5)'
  scheduled_room        TEXT,
  reviewer_notes        TEXT NOT NULL DEFAULT '',
  reviewed_by_email     TEXT,
  reviewed_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS class_submissions_submitter_idx
  ON class_submissions (LOWER(submitted_by_email));
CREATE INDEX IF NOT EXISTS class_submissions_status_idx ON class_submissions (status);
-- Morning class proposals (2026-07-05): members submit AM classes through
-- the same pipeline. AM rows: exactly one age group, no hour preference,
-- no space request, max_students = 0 (the group's roster is the size);
-- placement uses scheduled_hour = 'AM' + scheduled_age_range = the group.
ALTER TABLE class_submissions ADD COLUMN IF NOT EXISTS class_period TEXT NOT NULL DEFAULT 'PM'
  CHECK (class_period IN ('AM','PM'));
-- Morning approval is independent of afternoon (2026-07-06, Erin):
-- age-assigned morning classes have no sign-up timing stakes, so the
-- Class Builder's Morning lens locks on its own columns. The original
-- approved_at/approved_by stay AFTERNOON's (they also gate sign-ups).
ALTER TABLE co_op_sessions ADD COLUMN IF NOT EXISTS am_approved_at TIMESTAMPTZ;
ALTER TABLE co_op_sessions ADD COLUMN IF NOT EXISTS am_approved_by TEXT;
CREATE INDEX IF NOT EXISTS class_submissions_school_year_idx ON class_submissions (school_year);

-- Back-compat: pick up the teen-assistant flag on existing deployments.
ALTER TABLE class_submissions ADD COLUMN IF NOT EXISTS open_to_teen_assistant BOOLEAN NOT NULL DEFAULT FALSE;

-- ──────────────────────────────────────────────
-- Phase 3 of directory→DB migration: secondary-email login resolution.
-- Lets a co-parent (e.g. Jay Shewan with login jays@) sign in with their own
-- Workspace email and have it resolve to the existing family row keyed by
-- the primary parent's family_email. Auth/ownership checks across the codebase
-- (tour.js, absences.js, photos.js) compare the JWT email to family_email +
-- additional_emails via the api/_family.js helpers.
-- ──────────────────────────────────────────────
ALTER TABLE member_profiles
  ADD COLUMN IF NOT EXISTS additional_emails TEXT[] NOT NULL DEFAULT '{}'::text[];
CREATE INDEX IF NOT EXISTS member_profiles_additional_emails_idx
  ON member_profiles USING GIN (additional_emails);

-- ──────────────────────────────────────────────
-- Normalized people + kids tables. Replace the JSONB blobs on
-- member_profiles.parents / .kids so each person and each kid is its own
-- row. The motivation is that responsibilities (AM/PM/cleaning/committee
-- duties) need to match the LOGGED-IN PERSON, not "all parents in this
-- family." Keying people by their own email makes that lookup direct
-- (person.email = JWT email), and giving each row its own first_name +
-- last_name handles maiden names + blended families without the family
-- last name being awkwardly appended.
--
-- Each row is owned by a member_profiles family via family_email FK.
-- ON DELETE CASCADE so a family removal cleans up its people + kids.
-- The JSONB columns on member_profiles stay through this migration
-- (frozen at backfill time) so a rollback can read them; a follow-up
-- migration drops them once prod is stable.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people (
  id             SERIAL PRIMARY KEY,
  -- Workspace email = primary login identity. Nullable because BLCs
  -- captured at registration time often don't have a Workspace email yet
  -- (it gets set later via the EMI form or when they sign their waiver).
  -- Unique among non-NULL values via a partial index.
  email          TEXT,
  family_email   TEXT NOT NULL REFERENCES member_profiles(family_email) ON DELETE CASCADE,
  first_name     TEXT NOT NULL DEFAULT '',
  last_name      TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'parent'
                 CHECK (role IN ('mlc', 'blc', 'parent')),
  personal_email TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  pronouns       TEXT NOT NULL DEFAULT '',
  photo_url      TEXT NOT NULL DEFAULT '',
  photo_consent  BOOLEAN NOT NULL DEFAULT TRUE,
  nicknames      JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS people_family_email_idx ON people (LOWER(family_email));
-- Email is unique among rows that have one. BLCs without a Workspace
-- email yet are skipped here (NULL values aren't compared in unique
-- indexes — exactly the semantics we want).
CREATE UNIQUE INDEX IF NOT EXISTS people_email_lc_idx
  ON people (LOWER(email)) WHERE email IS NOT NULL;
-- Within a family, names are unique too — protects against accidental
-- duplicate "Erin" rows from registration + EMI both writing.
CREATE UNIQUE INDEX IF NOT EXISTS people_family_first_lc_idx
  ON people (family_email, LOWER(first_name));
-- Exactly one MLC per family.
CREATE UNIQUE INDEX IF NOT EXISTS people_one_mlc_per_family_idx
  ON people (family_email) WHERE role = 'mlc';

CREATE TABLE IF NOT EXISTS kids (
  id             SERIAL PRIMARY KEY,
  family_email   TEXT NOT NULL REFERENCES member_profiles(family_email) ON DELETE CASCADE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL DEFAULT '',
  birth_date     DATE,
  pronouns       TEXT NOT NULL DEFAULT '',
  allergies      TEXT NOT NULL DEFAULT '',
  schedule       TEXT NOT NULL DEFAULT 'all-day'
                 CHECK (schedule IN ('all-day', 'morning', 'afternoon', '')),
  photo_url      TEXT NOT NULL DEFAULT '',
  photo_consent  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS kids_family_email_idx ON kids (LOWER(family_email));
-- A kid is identified within a family by first_name (case-insensitive),
-- which mirrors the existing JSONB merge logic in
-- upsertProfileFromRegistration. Hard-enforced so registration writes
-- can do ON CONFLICT (family_email, lower(first_name)) DO UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS kids_family_first_lc_idx
  ON kids (family_email, LOWER(first_name));
-- Age-group class assignment (Greenhouse, Saplings, Sassafras, …, Pigeons).
-- Free text so the brand-aligned group list can evolve without a schema
-- change; populated by scripts/backfill-kids-from-classlist.js (one-time
-- read of the legacy Classlist sheet) and going forward by the registration
-- flow / Membership Director edits. Empty string = unassigned.
ALTER TABLE kids ADD COLUMN IF NOT EXISTS class_group TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS kids_class_group_idx ON kids (class_group)
  WHERE class_group <> '';

-- ──────────────────────────────────────────────
-- Roles v2: clean redesign of role_descriptions + role_holders
-- ──────────────────────────────────────────────
-- Replaces role_descriptions, role_holders, and cleaning_config.liaison_name
-- with three first-class tables: committees, roles, role_holders_v2.
-- Lives alongside the old tables until the Phase 4 frontend cutover; the
-- Phase 5 cleanup drops role_descriptions + the old role_holders and renames
-- role_holders_v2 → role_holders.
--
-- Key design differences from the old schema:
--   - committees promoted from a free-text column on role_descriptions to its
--     own table, so chair assignment + ordering have a real home
--   - icon_emoji, card_summary, role_email moved out of hardcoded HTML and
--     hardcoded constants (BOARD_ROLE_EMAILS, .portal-board-grid)
--   - revision_history JSONB captures the full audit trail that lives in the
--     .docx headers today (multi-year stack of "Updated YYYY-MM-DD initials")
--   - person_name + family_name snapshot columns dropped from role_holders;
--     current holder names resolve via people join (see feedback memory
--     rw_role_holder_name_resolution)
CREATE TABLE IF NOT EXISTS committees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  chair_role_id INTEGER,
  display_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);
ALTER TABLE committees DROP CONSTRAINT IF EXISTS committees_status_chk;
ALTER TABLE committees ADD CONSTRAINT committees_status_chk
  CHECK (status IN ('active','archived'));

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'committee_role',
  committee_id INTEGER REFERENCES committees(id) ON DELETE SET NULL,
  parent_role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  term_length TEXT NOT NULL DEFAULT '',
  overview TEXT NOT NULL DEFAULT '',
  duties TEXT[] NOT NULL DEFAULT '{}',
  playbook TEXT NOT NULL DEFAULT '',
  icon_emoji TEXT NOT NULL DEFAULT '',
  card_summary TEXT[] NOT NULL DEFAULT '{}',
  role_email TEXT NOT NULL DEFAULT '',
  last_reviewed_by TEXT NOT NULL DEFAULT '',
  last_reviewed_date DATE,
  revision_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_category_chk;
ALTER TABLE roles ADD CONSTRAINT roles_category_chk
  CHECK (category IN ('board','committee_role'));
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_status_chk;
ALTER TABLE roles ADD CONSTRAINT roles_status_chk
  CHECK (status IN ('active','archived'));

-- FK from committees.chair_role_id → roles.id, added after roles exists to
-- avoid circular DDL ordering. Named explicitly so the IF EXISTS drop is
-- portable across re-runs.
ALTER TABLE committees DROP CONSTRAINT IF EXISTS committees_chair_role_fk;
ALTER TABLE committees ADD CONSTRAINT committees_chair_role_fk
  FOREIGN KEY (chair_role_id) REFERENCES roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS roles_category_idx ON roles (category);
CREATE INDEX IF NOT EXISTS roles_committee_idx ON roles (committee_id);
CREATE INDEX IF NOT EXISTS roles_parent_idx ON roles (parent_role_id);
CREATE INDEX IF NOT EXISTS roles_status_idx ON roles (status);

-- Refined role_holders. Named _v2 during the parallel phase so the old
-- role_holders table can continue serving _permissions.js and the sheet
-- overlay until Phase 4 cuts the readers over. Phase 5 drops the old and
-- renames this to role_holders.
CREATE TABLE IF NOT EXISTS role_holders_v2 (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  person_email TEXT NOT NULL,
  school_year TEXT NOT NULL DEFAULT '2025-2026',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS role_holders_v2_unique_idx
  ON role_holders_v2 (role_id, LOWER(person_email), school_year);
CREATE INDEX IF NOT EXISTS role_holders_v2_role_idx
  ON role_holders_v2 (role_id);
CREATE INDEX IF NOT EXISTS role_holders_v2_year_idx
  ON role_holders_v2 (school_year);
CREATE INDEX IF NOT EXISTS role_holders_v2_email_idx
  ON role_holders_v2 (LOWER(person_email));

-- ──────────────────────────────────────────────
-- Roles v2 Phase 5 cleanup: drop legacy tables
-- ──────────────────────────────────────────────
-- Drops were intentionally MOVED OUT of migrate.sql to avoid a
-- sequencing footgun: running run-migration.js before the v2 data is
-- in place would have dropped the legacy tables and erased the source
-- of the holder migration. Run scripts/drop-legacy-role-tables.js
-- AFTER:
--   1. run-migration.js  (creates committees, roles, role_holders_v2)
--   2. import-role-docs.js  (seeds committees + roles from the .docx files)
--   3. migrate-role-holders-to-v2.js  (copies role_holders → role_holders_v2)
--   4. Spot-check parity (counts, sample rows for the current school year)
--
-- The drop script is small and explicit so it can't accidentally fire
-- on a run-migration.js sweep.

-- ──────────────────────────────────────────────
-- Co-op Calendar (Phase B of the SESSION_DATES migration)
-- ──────────────────────────────────────────────
-- Source of truth for which sessions exist in which school year, with
-- their start + end dates. Replaces the hardcoded SESSION_DATES const
-- in script.js + api/tour.js. President + Vice-President manage rows
-- via the "Co-op Calendar" Workspace modal (api/cleaning.js
-- action=sessions, gated through canEditAsRole).
--
-- school_year is the canonical "2025-2026" / "2026-2027" string; matches
-- activeSchoolYear().label and role_holders_v2.school_year, so the same
-- value joins across the schema.
--
-- session_number is 1..N within a year. Stored as INT (not bounded by a
-- CHECK) so future years can extend past 5 sessions without a schema
-- change.
--
-- Initial seed below replays the 2025-2026 SESSION_DATES so the read
-- path has something to return on day one. Future-year rows land via the
-- management modal — no further SQL edits required.
CREATE TABLE IF NOT EXISTS co_op_sessions (
  id              SERIAL PRIMARY KEY,
  school_year     TEXT NOT NULL,
  session_number  INTEGER NOT NULL,
  name            TEXT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS co_op_sessions_year_num_idx
  ON co_op_sessions (school_year, session_number);
CREATE INDEX IF NOT EXISTS co_op_sessions_year_idx
  ON co_op_sessions (school_year);

-- Seed the 2025-2026 sessions from the prior hardcoded SESSION_DATES.
-- ON CONFLICT DO NOTHING — re-runs and prod backfills are no-ops once
-- the row exists, and a President who later edits Session 3's dates
-- through the UI won't have her edits clobbered by a re-run.
INSERT INTO co_op_sessions (school_year, session_number, name, start_date, end_date) VALUES
  ('2025-2026', 1, 'Fall Session 1',   '2025-09-03', '2025-10-01'),
  ('2025-2026', 2, 'Fall Session 2',   '2025-10-15', '2025-11-12'),
  ('2025-2026', 3, 'Winter Session 3', '2026-01-14', '2026-02-11'),
  ('2025-2026', 4, 'Spring Session 4', '2026-03-04', '2026-04-01'),
  ('2025-2026', 5, 'Spring Session 5', '2026-04-15', '2026-05-13')
ON CONFLICT (school_year, session_number) DO NOTHING;

-- ──────────────────────────────────────────────
-- Role-holder confirmations (Phase B follow-up)
-- ──────────────────────────────────────────────
-- After Field Day every May, the Communications Director sees a "Confirm
-- role holders" To Do until she explicitly marks the new school year as
-- confirmed. This table holds that per-year tick. A simple key-by-year
-- pattern; the existence of a row is the affirmative signal.
-- Comms can un-confirm (DELETE row) if mid-year a re-review is needed.
-- Confirmation is intentionally separate from role_holders_v2 so adding
-- or removing a holder doesn't reset the year's confirmed status —
-- Comms ticked the box, that's enough.
CREATE TABLE IF NOT EXISTS role_holder_confirmations (
  school_year         TEXT PRIMARY KEY,
  confirmed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by_email  TEXT NOT NULL DEFAULT ''
);
-- Seed the 2025-2026 row so on prod / dev the previous (completed)
-- year shows as confirmed by default. New years start unconfirmed.
INSERT INTO role_holder_confirmations (school_year, confirmed_by_email)
VALUES ('2025-2026', '')
ON CONFLICT (school_year) DO NOTHING;

-- ──────────────────────────────────────────────
-- Morning Class Builder (Membership Director)
-- ──────────────────────────────────────────────
-- The Membership Director groups each upcoming year's morning-track,
-- paid kids into the brand age-band classes (Greenhouse, Saplings, …,
-- Pigeons). Mirrors the Afternoon Schedule Builder's draft → finalize
-- lifecycle:
--   - morning_class_assignments holds the DRAFT placement per kid. Keyed
--     the same way as class_signup_picks / the kids table: school_year +
--     family_email + first name, stored lowercased so ON CONFLICT upserts
--     are case-insensitive. Editing here NEVER touches the live roster.
--   - morning_class_plans carries one row per school_year with the
--     finalize lock (status 'draft' | 'final'). Finalizing copies every
--     draft class_group into kids.class_group (the live Directory /
--     Classlist field); reopening flips status back to 'draft'.
CREATE TABLE IF NOT EXISTS morning_class_assignments (
  id              SERIAL PRIMARY KEY,
  school_year     TEXT NOT NULL,
  family_email    TEXT NOT NULL,
  kid_first_name  TEXT NOT NULL,
  class_group     TEXT NOT NULL DEFAULT '',
  updated_by      TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- family_email + kid_first_name are written lowercased, so a plain-column
-- unique index doubles as the case-insensitive key the upsert infers on.
CREATE UNIQUE INDEX IF NOT EXISTS morning_class_assignments_key_idx
  ON morning_class_assignments (school_year, family_email, kid_first_name);
CREATE INDEX IF NOT EXISTS morning_class_assignments_year_idx
  ON morning_class_assignments (school_year);

CREATE TABLE IF NOT EXISTS morning_class_plans (
  school_year    TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'final')),
  finalized_at   TIMESTAMPTZ,
  finalized_by   TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT NOT NULL DEFAULT ''
);
-- Initial age-based auto-placement is a one-time pass per season; seeded_at
-- stamps when it ran so later registrations land unplaced (manual review),
-- instead of being re-seeded on every open.
ALTER TABLE morning_class_plans ADD COLUMN IF NOT EXISTS seeded_at TIMESTAMPTZ;
-- Marks a draft placement as already written into the official roster by a
-- finalize. Placements made after a finalize stay finalized=FALSE until the
-- next finalize — so finalized kids stay locked while late additions can be
-- placed and confirmed without disturbing them.
ALTER TABLE morning_class_assignments ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT FALSE;

-- ──────────────────────────────────────────────
-- Merchandise (public order form + portal report)
-- ──────────────────────────────────────────────
-- Customers fill out a public form on the homepage Merch section; rows
-- land here. The Merchandise Manager (a new role under Communications)
-- and the Comms Director manage them via a portal report — Paid /
-- Delivered are click-to-toggle pills. Venmo handle is communicated via
-- a follow-up email; we don't store payment IDs here.
CREATE TABLE IF NOT EXISTS merch_orders (
  id              SERIAL PRIMARY KEY,
  customer_name   TEXT NOT NULL,
  customer_email  TEXT NOT NULL,
  customer_phone  TEXT NOT NULL DEFAULT '',
  item            TEXT NOT NULL,
  size            TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  qty             INTEGER NOT NULL DEFAULT 1,
  notes           TEXT NOT NULL DEFAULT '',
  paid_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS merch_orders_created_idx ON merch_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS merch_orders_paid_idx ON merch_orders (paid_at);
CREATE INDEX IF NOT EXISTS merch_orders_delivered_idx ON merch_orders (delivered_at);

-- Merchandise Manager role under the Communications Committee. Idempotent
-- via ON CONFLICT(role_key). The committee_id + parent_role_id lookups
-- resolve at insert time so this row stays linked even if those rows get
-- renumbered.
INSERT INTO roles (
  role_key, title, category, committee_id, parent_role_id, display_order,
  status, term_length, overview, duties, playbook,
  icon_emoji, card_summary, role_email, updated_by
)
SELECT
  'merchandise_manager',
  'Merchandise Manager',
  'committee_role',
  (SELECT id FROM committees WHERE name = 'Communications Committee'),
  (SELECT id FROM roles WHERE role_key = 'communications_director'),
  71,
  'active',
  '1 year',
  'Manages Roots & Wings merchandise — fulfilling orders submitted through the public site, coordinating with vendors on inventory, and keeping the Merchandise report up to date as orders are paid and delivered.',
  ARRAY[
    'Monitor the Merchandise Orders report for new submissions.',
    'Reach out to customers via email with Venmo payment details.',
    'Mark orders Paid in the report after Venmo confirmation.',
    'Coordinate fulfillment (printing, pickup, delivery) and mark Delivered when handed off.',
    'Track inventory and reorder timing for items with minimums (mug, tumbler, pin, patch).'
  ],
  '',
  '🎁',
  ARRAY['Fulfills orders', 'Tracks Paid / Delivered', 'Reports to Communications Director'],
  '',
  'migrate.sql'
ON CONFLICT (role_key) DO UPDATE SET
  committee_id   = EXCLUDED.committee_id,
  parent_role_id = EXCLUDED.parent_role_id,
  display_order  = EXCLUDED.display_order,
  category       = EXCLUDED.category,
  updated_at     = NOW();

-- ──────────────────────────────────────────────
-- Merchandise inventory
-- ──────────────────────────────────────────────
-- One row per (item, size, color) variant. on_hand is what's physically
-- on the shelf; low_threshold flags the variant on the Orders report
-- when it dips at or below that count; reorder_minimum is the supplier's
-- minimum batch (e.g. 24 mugs) so the manager knows the smallest order
-- they can place when restocking. Keys must match MERCH_CATALOG in
-- api/tour.js — the seed below mirrors that catalog exactly. Items with
-- no variants (mug/tumbler/pin/patch) use empty strings for size/color,
-- which matches how merch_orders also stores variant-less items.
CREATE TABLE IF NOT EXISTS merch_inventory (
  id              SERIAL PRIMARY KEY,
  item            TEXT NOT NULL,
  size            TEXT NOT NULL DEFAULT '',
  color           TEXT NOT NULL DEFAULT '',
  on_hand         INTEGER NOT NULL DEFAULT 0,
  low_threshold   INTEGER NOT NULL DEFAULT 0,
  reorder_minimum INTEGER NOT NULL DEFAULT 0,
  notes           TEXT NOT NULL DEFAULT '',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT NOT NULL DEFAULT '',
  UNIQUE (item, size, color)
);
CREATE INDEX IF NOT EXISTS merch_inventory_item_idx ON merch_inventory (item);
-- Vendor columns added 2026-05-22. Additive so re-running the migration
-- against an existing prod table just tacks them on without touching
-- any counts already entered.
ALTER TABLE merch_inventory ADD COLUMN IF NOT EXISTS vendor_name TEXT NOT NULL DEFAULT '';
ALTER TABLE merch_inventory ADD COLUMN IF NOT EXISTS vendor_url  TEXT NOT NULL DEFAULT '';

-- Seed: every variant in MERCH_CATALOG, on_hand = 0. ON CONFLICT keeps
-- this safe to re-run — adding a new size/color above and re-running
-- migrate.sql backfills the missing variant without disturbing counts
-- already entered for the existing ones.
INSERT INTO merch_inventory (item, size, color)
SELECT 'tshirt', s, c
FROM unnest(ARRAY[
  'Toddler 2T','Toddler 3T','Toddler 4T','Toddler 5T',
  'Kids XS','Kids S','Kids M','Kids L','Kids XL',
  'Adult S','Adult M','Adult L','Adult XL','Adult XXL'
]) AS s
CROSS JOIN unnest(ARRAY['Purple','Olive','Lime','Teal']) AS c
ON CONFLICT (item, size, color) DO NOTHING;

INSERT INTO merch_inventory (item, size, color)
SELECT 'tote', s, c
FROM unnest(ARRAY['Small','Large']) AS s
CROSS JOIN unnest(ARRAY['Black','Brown','Purple']) AS c
ON CONFLICT (item, size, color) DO NOTHING;

INSERT INTO merch_inventory (item, size, color) VALUES
  ('mug', '', ''),
  ('tumbler', '', ''),
  ('pin', '', ''),
  ('patch', '', '')
ON CONFLICT (item, size, color) DO NOTHING;

-- ──────────────────────────────────────────────
-- Afternoon class sign-ups (student-side selection + lottery).
-- Kids rank scheduled afternoon classes separately for PM1 and PM2; the VP /
-- Afternoon Class Liaison open the window, review fullness, run a lottery on
-- over-full classes (auto-cascading bumped kids to their next pick), then lock
-- to publish rosters. Available classes come from class_submissions
-- (status='scheduled') for the session + school_year.
--
-- Kids are identified by family_email + first name (lower-cased on match), NOT
-- kids.id — the EMI profile save deletes + re-inserts kids, so kids.id is not
-- stable and a FK would cascade-delete picks on every profile edit.
-- ──────────────────────────────────────────────

-- One control row per (school_year, session). Gates whether parents can edit
-- their kids' picks. open = parents rank; closed = parents locked out, VP /
-- Liaison still adjust; locked = final, rosters published.
CREATE TABLE IF NOT EXISTS class_signup_windows (
  id              SERIAL PRIMARY KEY,
  school_year     TEXT NOT NULL,
  session_number  INTEGER NOT NULL,            -- 1..5
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed','locked')),
  opened_by       TEXT,
  opened_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  locked_at       TIMESTAMPTZ,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_year, session_number)
);

-- A kid's ranked picks: one row per (kid, hour, rank). class_submission_id
-- references the scheduled class. A 2-hour class is ranked under PM1 and fills
-- both slots when assigned (no separate PM2 pick for that kid).
CREATE TABLE IF NOT EXISTS class_signup_picks (
  id                  SERIAL PRIMARY KEY,
  school_year         TEXT NOT NULL,
  session_number      INTEGER NOT NULL,
  family_email        TEXT NOT NULL,
  kid_first_name      TEXT NOT NULL,
  hour                TEXT NOT NULL CHECK (hour IN ('PM1','PM2')),
  rank                INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 8),
  class_submission_id INTEGER NOT NULL REFERENCES class_submissions(id) ON DELETE CASCADE,
  created_by_email    TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (school_year, session_number, family_email, kid_first_name, hour, rank),
  UNIQUE (school_year, session_number, family_email, kid_first_name, hour, class_submission_id)
);
CREATE INDEX IF NOT EXISTS class_signup_picks_class_idx
  ON class_signup_picks (school_year, session_number, hour, class_submission_id);
CREATE INDEX IF NOT EXISTS class_signup_picks_kid_idx
  ON class_signup_picks (school_year, session_number, LOWER(family_email), LOWER(kid_first_name));

-- ──────────────────────────────────────────────
-- Schedule Builder: per-session approval lock
-- ──────────────────────────────────────────────
-- When a session is "Approved" in the Schedule Builder, approved_at gets
-- stamped and the builder UI goes read-only for that session so accidental
-- drag/drop / +Add / edits can't change a finalized schedule. Clearing
-- approved_at via the "Reopen for editing" toggle re-enables editing.
ALTER TABLE co_op_sessions
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- Sign-up window date range: VP / Afternoon Liaison sets start + end dates
-- when opening sign-ups. The parent My Family widget appears only between
-- those dates (in addition to the existing status='open' gate). Distinct
-- from opened_at/closed_at, which are the audit timestamps of when an
-- admin clicked the buttons — these are the intentional date range the
-- VP chose for parents to make their picks.
ALTER TABLE class_signup_windows
  ADD COLUMN IF NOT EXISTS signup_start_date DATE,
  ADD COLUMN IF NOT EXISTS signup_end_date   DATE;

-- ──────────────────────────────────────────────
-- Board Calendar (any board member)
-- ──────────────────────────────────────────────
-- A single board-facing calendar of date-sensitive co-op events that don't
-- have their own home editor yet — registration opens/closes, "morning
-- classes finalized by", board meeting dates, and any future date the board
-- wants to track. Session start/end dates (co_op_sessions) and afternoon
-- sign-up windows (class_signup_windows) keep their own editors and are NOT
-- duplicated here; v1 of the calendar is just these standalone events. Any
-- board member can view and edit (server gate: isBoardMember). end_date is
-- optional — set it for a multi-day window (e.g. a registration window),
-- leave it NULL for a single-day event.
CREATE TABLE IF NOT EXISTS board_calendar_events (
  id           SERIAL PRIMARY KEY,
  school_year  TEXT NOT NULL,
  title        TEXT NOT NULL,
  event_date   DATE NOT NULL,
  end_date     DATE,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS board_calendar_events_year_idx
  ON board_calendar_events (school_year, event_date);

-- ── Welcome outreach ──────────────────────────────────────────────────
-- Tracks which new families the Welcome Coordinator has personally
-- reached out to. Intentionally SEPARATE from the Communications
-- Director's onboarding state (registrations.welcome_email_sent_at /
-- existing_family_name) so the two roles don't collide — a family can be
-- "welcomed" by the coordinator before, after, or independently of the
-- formal Comms onboarding email. One row per registration (the PK); the
-- row's presence means "welcomed", and deleting it un-marks. No FK on
-- registration_id to keep this additive-only migration order-independent.
CREATE TABLE IF NOT EXISTS welcome_outreach (
  registration_id INTEGER PRIMARY KEY,
  welcomed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  welcomed_by     TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT ''
);
-- Welcome is a lifecycle, not one-and-done: after the initial welcome the
-- Welcome Coordinator does a Meet & Greet. met_at/met_by track that stage.
ALTER TABLE welcome_outreach ADD COLUMN IF NOT EXISTS met_at TIMESTAMPTZ;
ALTER TABLE welcome_outreach ADD COLUMN IF NOT EXISTS met_by TEXT NOT NULL DEFAULT '';

-- ──────────────────────────────────────────────
-- AM class teaching assignments (participation sheet→DB migration, Phase B1)
-- Who leads / assists each morning group per session. Managed in the Morning
-- Class Builder (Membership Director + VP). Feeds the participation report's
-- am_lead / am_assist counts, replacing the master sheet's "AM Volunteer" tab.
-- One 'lead' + N 'assist' rows per (school_year, session_number, group_name);
-- saves replace the whole cell. person_email enables email-based participation
-- matching; person_name is the display fallback.
-- ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS am_class_assignments (
  id             SERIAL PRIMARY KEY,
  school_year    TEXT NOT NULL,
  session_number INTEGER NOT NULL CHECK (session_number BETWEEN 1 AND 5),
  group_name     TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('lead','assist')),
  person_email   TEXT NOT NULL DEFAULT '',
  person_name    TEXT NOT NULL DEFAULT '',
  sort_order     INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS am_class_assign_year_idx
  ON am_class_assignments (school_year);
CREATE INDEX IF NOT EXISTS am_class_assign_cell_idx
  ON am_class_assignments (school_year, session_number, group_name);

-- PM elective helpers (participation sheet→DB, Phase B2). Who assists each
-- scheduled afternoon class, set in the PM Schedule Builder. Feeds the
-- participation report's pm_assist count, replacing the master sheet's PM
-- tab assistants. One row per helper, attached to the class_submission.
CREATE TABLE IF NOT EXISTS class_assignment_helpers (
  id                  SERIAL PRIMARY KEY,
  class_submission_id INTEGER NOT NULL REFERENCES class_submissions(id) ON DELETE CASCADE,
  person_email        TEXT NOT NULL DEFAULT '',
  person_name         TEXT NOT NULL DEFAULT '',
  sort_order          INTEGER NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS class_helpers_sub_idx
  ON class_assignment_helpers (class_submission_id);

-- Special events (participation sheet→DB, Phase B3). Managed by the Special
-- Events Liaison (+ VP). Dates are proposed at the summer meeting then approved
-- (date_status). Each event has one lead (→ event_lead) and up to four
-- assistants (→ event_assist) in special_event_people. Seeded per year with the
-- standard event list. UNIQUE(school_year,name) lets the seed be idempotent.
CREATE TABLE IF NOT EXISTS special_events (
  id          SERIAL PRIMARY KEY,
  school_year TEXT NOT NULL,
  name        TEXT NOT NULL,
  event_date  DATE,
  date_status TEXT NOT NULL DEFAULT 'proposed' CHECK (date_status IN ('proposed','approved')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  notes       TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT NOT NULL DEFAULT '',
  UNIQUE (school_year, name)
);
CREATE INDEX IF NOT EXISTS special_events_year_idx ON special_events (school_year);

CREATE TABLE IF NOT EXISTS special_event_people (
  id           SERIAL PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES special_events(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('lead','assist')),
  person_email TEXT NOT NULL DEFAULT '',
  person_name  TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS special_event_people_idx ON special_event_people (event_id);

-- 2026-07-06: year-scope the cleaning rota (Erin: cleaning resets each
-- school year). Existing rows were the 2025-2026 rota; new assignments
-- are stamped with the active season year by api/cleaning.
ALTER TABLE cleaning_assignments ADD COLUMN IF NOT EXISTS school_year TEXT;
UPDATE cleaning_assignments SET school_year = '2025-2026' WHERE school_year IS NULL;
CREATE INDEX IF NOT EXISTS cleaning_assignments_year_idx ON cleaning_assignments (school_year);


-- 2026-07-06: seed the nine age-group Morning Class Liaison roles under
-- the Vice President (Erin: the VP selects the Morning Class Liaison for
-- each age group; that liaison then builds the group's morning classes).
-- Parent-chain permissions give the VP assign rights automatically, and
-- the "<Group> Morning Class Liaison" title scopes each holder's Class
-- Builder to their own group. Idempotent by role_key.
INSERT INTO roles (role_key, title, category, parent_role_id, display_order, term_length, overview, icon_emoji, updated_by)
SELECT
  v.key, v.title, 'committee_role',
  (SELECT id FROM roles WHERE LOWER(REPLACE(title, '-', ' ')) = 'vice president' AND category = 'board' LIMIT 1),
  v.ord, '1 year',
  '',  -- description lives on the Morning Class Liaison heading only
  E'🌅', 'migration'
FROM (VALUES
  ('greenhouse_morning_class_liaison', 'Greenhouse Morning Class Liaison', 'Greenhouse', 300),
  ('saplings_morning_class_liaison', 'Saplings Morning Class Liaison', 'Saplings', 301),
  ('sassafras_morning_class_liaison', 'Sassafras Morning Class Liaison', 'Sassafras', 302),
  ('oaks_morning_class_liaison', 'Oaks Morning Class Liaison', 'Oaks', 303),
  ('maples_morning_class_liaison', 'Maples Morning Class Liaison', 'Maples', 304),
  ('birch_morning_class_liaison', 'Birch Morning Class Liaison', 'Birch', 305),
  ('willows_morning_class_liaison', 'Willows Morning Class Liaison', 'Willows', 306),
  ('cedars_morning_class_liaison', 'Cedars Morning Class Liaison', 'Cedars', 307),
  ('pigeons_morning_class_liaison', 'Pigeons Morning Class Liaison', 'Pigeons', 308)
) AS v(key, title, grp, ord)
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.role_key = v.key);


-- (2026-07-07) The 2026-07-06 description-copy block was removed: the job
-- description lives ONLY on the generic Morning Class Liaison heading.


-- 2026-07-07: the VP board role is titled 'Vice-President' (hyphen), so
-- the liaison seed above originally parented nothing. Re-parent any
-- orphaned per-group liaison roles under the VP (idempotent no-op once
-- they have a parent).
UPDATE roles t
SET parent_role_id = v.id, updated_at = NOW(), updated_by = 'migration'
FROM (
  SELECT id FROM roles
  WHERE LOWER(REPLACE(title, '-', ' ')) = 'vice president' AND category = 'board'
  LIMIT 1
) v
WHERE t.role_key LIKE '%_morning_class_liaison'
  AND t.parent_role_id IS NULL;


-- 2026-07-07 (Erin): group the nine age-group liaison roles UNDER the
-- generic "Morning Class Liaison" role (restored to active as the group
-- heading + description holder, itself under the VP), and shorten their
-- titles to "<Group> Liaison". All idempotent.
UPDATE roles
SET status = 'active',
    parent_role_id = COALESCE(parent_role_id,
      (SELECT id FROM roles r2 WHERE LOWER(REPLACE(r2.title, '-', ' ')) = 'vice president' AND r2.category = 'board' LIMIT 1)),
    updated_at = NOW(), updated_by = 'migration'
WHERE LOWER(title) = 'morning class liaison'
  AND (status <> 'active' OR parent_role_id IS NULL);

UPDATE roles
SET title = REPLACE(title, ' Morning Class Liaison', ' Liaison'),
    updated_at = NOW(), updated_by = 'migration'
WHERE role_key LIKE '%_morning_class_liaison'
  AND title LIKE '% Morning Class Liaison';

UPDATE roles t
SET parent_role_id = g.id, updated_at = NOW(), updated_by = 'migration'
FROM (SELECT id FROM roles WHERE LOWER(title) = 'morning class liaison' AND status = 'active' LIMIT 1) g
WHERE t.role_key LIKE '%_morning_class_liaison'
  AND t.parent_role_id IS DISTINCT FROM g.id;


-- 2026-07-07 (Erin): the per-group liaison roles carry NO description of
-- their own - the job description lives only on the Morning Class
-- Liaison heading. Clear the copied/seeded text; anything hand-written
-- since (not matching the generic's text or the seed placeholder) stays.
UPDATE roles t
SET overview = '', duties = '{}', playbook = '',
    updated_at = NOW(), updated_by = 'migration'
FROM (SELECT overview, duties, playbook FROM roles WHERE LOWER(title) = 'morning class liaison' LIMIT 1) g
WHERE t.role_key LIKE '%_morning_class_liaison'
  AND (t.overview = g.overview OR t.overview LIKE 'Builds the %' OR t.overview = '')
  AND (t.duties = g.duties OR COALESCE(array_length(t.duties, 1), 0) = 0)
  AND (t.overview <> '' OR COALESCE(array_length(t.duties, 1), 0) > 0 OR t.playbook <> '');


-- 2026-07-09 (Erin): Permissions admin — feature access per role, editable
-- by the Comms Director. Zero rows for a capability = the hardcoded
-- defaults in api/_capabilities.js apply (seeded behavior unchanged);
-- any rows = that row set IS the granted role list. The reserved
-- role_title '__none__' marks a capability customized down to no roles
-- (super users always pass everything regardless).
CREATE TABLE IF NOT EXISTS capability_grants (
  id SERIAL PRIMARY KEY,
  capability_key TEXT NOT NULL,
  role_title TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (capability_key, role_title)
);
