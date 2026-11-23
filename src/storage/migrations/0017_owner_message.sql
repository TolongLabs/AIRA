CREATE TABLE IF NOT EXISTS owner_message (
  submission_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown', 'acknowledged', 'refused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
