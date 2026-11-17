-- Research jobs use subject ids. The gateway address comes only from chat at delivery.
CREATE TABLE research_job (
  job_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  requester_id TEXT NOT NULL CHECK (requester_id <> ''),
  topic TEXT NOT NULL CHECK (topic <> ''),
  wants_pdf INTEGER NOT NULL DEFAULT 0 CHECK (wants_pdf IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  findings TEXT CHECK (findings IS NULL OR json_valid(findings)),
  report_file_id TEXT REFERENCES file (sha256),
  offer TEXT NOT NULL DEFAULT 'none' CHECK (offer IN ('none', 'open', 'accepted', 'declined', 'expired')),
  offer_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  delivered_at TEXT
) STRICT;
CREATE UNIQUE INDEX research_busy_chat ON research_job (chat_id) WHERE state IN ('queued', 'running');
CREATE INDEX research_queue ON research_job (state, run_after, created_at);
