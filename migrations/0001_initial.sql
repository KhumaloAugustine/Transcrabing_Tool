CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',
  zulu_segments TEXT NOT NULL DEFAULT '[]',
  english_segments TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_interviews_created_at
ON interviews(created_at DESC);
