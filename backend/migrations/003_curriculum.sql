-- Curriculum awareness.
--
-- The corpus is an ordered course, so a chunk's position in that order is a
-- first-class retrieval dimension: it lets a query be answered with only the
-- material a student has actually reached, and it lets the pipeline say where
-- a concept is first taught rather than quietly reaching ahead.
--
-- lesson_order is denormalised onto chunks on purpose. The keyword search hits
-- chunks and bounds by order in the same WHERE clause; making it join sources
-- to learn the position would cost a join on the hot path.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS lesson_order INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS module_order INTEGER;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS lesson_label TEXT;

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS lesson_order INTEGER;

CREATE INDEX IF NOT EXISTS chunks_lesson_order_idx ON chunks (lesson_order);
CREATE INDEX IF NOT EXISTS sources_lesson_order_idx ON sources (lesson_order);

-- Where each concept is FIRST taught. Filled by an offline LLM pass over the
-- transcripts (src/cli/buildConceptGraph.js), not at query time.
CREATE TABLE IF NOT EXISTS concepts (
  concept_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  aliases TEXT[] NOT NULL DEFAULT '{}',
  -- The lesson that introduces the concept; everything after this can assume it.
  first_taught_order INTEGER,
  first_taught_video_id TEXT,
  first_taught_at NUMERIC,
  summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS concepts_first_taught_idx ON concepts (first_taught_order);

-- Every lesson that touches a concept, so "where is this covered" is one query.
CREATE TABLE IF NOT EXISTS concept_mentions (
  concept_id TEXT NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  video_id TEXT NOT NULL,
  lesson_order INTEGER NOT NULL,
  start_time NUMERIC,
  role TEXT NOT NULL DEFAULT 'mention',
  PRIMARY KEY (concept_id, video_id, role)
);

CREATE INDEX IF NOT EXISTS concept_mentions_lesson_idx ON concept_mentions (lesson_order);

-- Directed prerequisite edges: understanding `concept_id` assumes `requires_id`.
CREATE TABLE IF NOT EXISTS concept_edges (
  concept_id TEXT NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  requires_id TEXT NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  weight NUMERIC NOT NULL DEFAULT 1,
  PRIMARY KEY (concept_id, requires_id),
  CHECK (concept_id <> requires_id)
);
