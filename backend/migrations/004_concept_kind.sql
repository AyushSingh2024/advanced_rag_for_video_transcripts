-- Grades each concept by how load-bearing it is in the course.
--
-- The extraction is deliberately generous, so most of what it finds is a
-- one-off implementation detail — a helper from a mini-project, a prop
-- mentioned once. Those are worth keeping searchable but must not be presented
-- as course structure, and must not generate prerequisite noise.
--
--   background : never taught by the course; the entry requirements
--   core       : something depends on it, or more than one lesson covers it
--   detail     : taught once, nothing builds on it
--
-- `lessons` and `dependents` are the counts the grade is derived from, stored so
-- a client can rank without a second query.

ALTER TABLE concepts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'detail';
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS lessons INTEGER NOT NULL DEFAULT 0;
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS dependents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE concepts DROP CONSTRAINT IF EXISTS concepts_kind_check;
ALTER TABLE concepts ADD CONSTRAINT concepts_kind_check
  CHECK (kind IN ('core', 'detail', 'background'));

-- The common listing is "core concepts in course order".
CREATE INDEX IF NOT EXISTS concepts_kind_order_idx
  ON concepts (kind, first_taught_order NULLS LAST);

-- Ranking within a kind.
CREATE INDEX IF NOT EXISTS concepts_dependents_idx
  ON concepts (dependents DESC);
