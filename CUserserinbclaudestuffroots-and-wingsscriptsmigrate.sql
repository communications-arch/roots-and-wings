
-- 2026-07-06: year-scope the cleaning rota (Erin: cleaning resets each
-- school year). Existing rows were the 2025-2026 rota; new assignments
-- are stamped with the active season year by api/cleaning.
ALTER TABLE cleaning_assignments ADD COLUMN IF NOT EXISTS school_year TEXT;
UPDATE cleaning_assignments SET school_year = '2025-2026' WHERE school_year IS NULL;
CREATE INDEX IF NOT EXISTS cleaning_assignments_year_idx ON cleaning_assignments (school_year);
