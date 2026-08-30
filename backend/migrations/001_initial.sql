CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_path TEXT,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  page_number INTEGER,
  video_id TEXT,
  start_time NUMERIC,
  end_time NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_search_idx ON chunks USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source_id);
CREATE INDEX IF NOT EXISTS chunks_video_idx ON chunks (video_id);
CREATE INDEX IF NOT EXISTS sources_hash_idx ON sources (content_hash);
