ALTER TABLE sources ADD COLUMN IF NOT EXISTS video_id TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS channel_id TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS module TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS duration NUMERIC;

CREATE INDEX IF NOT EXISTS sources_video_idx ON sources (video_id);
CREATE INDEX IF NOT EXISTS chunks_video_time_idx ON chunks (video_id, start_time, end_time);
