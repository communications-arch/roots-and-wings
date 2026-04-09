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

CREATE TABLE IF NOT EXISTS class_curriculum_links (
  id SERIAL PRIMARY KEY,
  session_number INTEGER NOT NULL,
  class_key TEXT NOT NULL,
  curriculum_id INTEGER NOT NULL REFERENCES curricula(id) ON DELETE CASCADE,
  attached_by TEXT DEFAULT '',
  attached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_number, class_key)
);
