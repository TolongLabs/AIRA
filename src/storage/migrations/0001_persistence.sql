-- The persistence base (docs/trd/storage.md). Every unit of work in flight is a row with a state.
-- Times are ISO-8601 UTC text. Record tables hold ids and hashes; verbatim text lives in session_message only.

-- One row per turn. Records (docs/trd/records.md) adds its measurement columns in a later migration.
CREATE TABLE turn (
  turn_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'command', 'scheduled')),
  state TEXT NOT NULL CHECK (state IN ('running', 'delivered', 'declined', 'failed', 'interrupted')),
  stage TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK ((state = 'running') = (ended_at IS NULL))
) STRICT;

CREATE INDEX turn_by_state ON turn (state);
CREATE INDEX turn_by_chat ON turn (chat_id, received_at);

-- One row per gateway message, written before any other work. The gateway's message id is unique inside a chat,
-- so the chat is part of the key and one chat can never read another chat's stored reply.
CREATE TABLE inbound_message (
  chat_id TEXT NOT NULL,
  mid TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('received', 'answered', 'dropped')),
  turn_id TEXT REFERENCES turn (turn_id),
  received_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (chat_id, mid),
  CHECK ((state = 'received') = (closed_at IS NULL))
) STRICT;

CREATE INDEX inbound_message_by_turn ON inbound_message (turn_id);
CREATE INDEX inbound_message_open ON inbound_message (chat_id) WHERE state = 'received';

-- The conversation window. The assistant row of a turn holds the reply exactly as it was returned to the gateway,
-- so a repeated request gets the stored reply.
CREATE TABLE session_message (
  id INTEGER PRIMARY KEY,
  chat_id TEXT NOT NULL,
  turn_id TEXT REFERENCES turn (turn_id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX session_message_by_chat ON session_message (chat_id, id);
CREATE UNIQUE INDEX session_message_reply ON session_message (turn_id) WHERE role = 'assistant';

-- A failure of any kind, handled or not.
CREATE TABLE failure (
  id INTEGER PRIMARY KEY,
  turn_id TEXT REFERENCES turn (turn_id),
  job_id TEXT,
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  handled_by TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX failure_by_turn ON failure (turn_id);
CREATE INDEX failure_by_kind ON failure (kind, created_at);

-- The memory queue. Memory (docs/trd/memory.md) owns the payload; the lease columns are shared by every job table.
CREATE TABLE memory_job (
  job_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'done', 'failed')),
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL)),
  CHECK ((state = 'leased') = (lease_expires_at IS NOT NULL))
) STRICT;

CREATE INDEX memory_job_queue ON memory_job (state, run_after, created_at);
CREATE INDEX memory_job_by_chat ON memory_job (chat_id, state);

-- A content-addressed file on the data volume. The row is written after the file is renamed into place.
CREATE TABLE file (
  sha256 TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- One row per snapshot attempt.
CREATE TABLE backup_run (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('timer', 'migration', 'deploy', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('started', 'verified', 'failed')),
  file TEXT NOT NULL,
  bytes INTEGER,
  detail TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  removed_at TEXT
) STRICT;

CREATE INDEX backup_run_by_state ON backup_run (state, started_at);
