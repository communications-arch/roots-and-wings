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
  cancelled_at TIMESTAMPTZ,
  UNIQUE (absent_person, absence_date)
);
CREATE INDEX IF NOT EXISTS absences_date_idx ON absences (absence_date);
CREATE INDEX IF NOT EXISTS absences_session_idx ON absences (session_number);

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
