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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS curricula_author_idx ON curricula (author_email);
CREATE INDEX IF NOT EXISTS curricula_subject_idx ON curricula (subject);

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
  pre_enroll_kids       TEXT NOT NULL DEFAULT '',
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
CREATE INDEX IF NOT EXISTS class_submissions_school_year_idx ON class_submissions (school_year);
