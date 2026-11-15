-- Memory (docs/trd/memory.md). Every row belongs to one chat. No query reads it without a chat id.

CREATE TABLE memory_item (
  id TEXT PRIMARY KEY,
  -- The chat instance that owns the row. Never null.
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'episode', 'media')),
  -- The person a fact is about, or NULL for a fact about the chat itself.
  subject_id TEXT CHECK (subject_id <> ''),
  -- The normalised slot of a fact, such as likes.food. A forgotten fact's key is replaced, because a key can
  -- itself say the fact.
  key TEXT,
  value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'upcoming', 'superseded', 'retired', 'forgotten')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  -- Where it came from. Not foreign keys: records and window messages are pruned, memory is kept.
  source_turn TEXT,
  source_job TEXT,
  source_message_id INTEGER,
  -- The lapse time of an upcoming fact.
  valid_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A forgotten row keeps its id and times and has its value cleared. Every other row has a value.
  CHECK ((status = 'forgotten') = (value = '')),
  CHECK (kind <> 'fact' OR key IS NOT NULL),
  CHECK (status <> 'upcoming' OR valid_until IS NOT NULL),
  UNIQUE (id, chat_id)
) STRICT;

-- One active fact, and one upcoming fact, per chat, subject and key.
CREATE UNIQUE INDEX memory_item_active_fact ON memory_item (chat_id, coalesce(subject_id, ''), key)
  WHERE kind = 'fact' AND status = 'active';
CREATE UNIQUE INDEX memory_item_upcoming_fact ON memory_item (chat_id, coalesce(subject_id, ''), key)
  WHERE kind = 'fact' AND status = 'upcoming';
CREATE INDEX memory_item_by_chat ON memory_item (chat_id, kind, status, updated_at);

-- The full-text index for keyword recall. Code keeps it in step with memory_item, in the same transaction.
-- Only rows that may be recalled are in it. Every search gives a chat id, and reads the text from memory_item.
CREATE VIRTUAL TABLE memory_fts USING fts5 (item_id UNINDEXED, chat_id UNINDEXED, text, tokenize = 'unicode61');

-- Embeddings of episode and media rows, compared in process.
CREATE TABLE memory_embedding (
  item_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vector BLOB NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id, chat_id) REFERENCES memory_item (id, chat_id)
) STRICT;

-- Per chat: the last window message a memory job already covers, and a counter that every forget increases.
-- A job that started before a forget must not apply after it.
CREATE TABLE memory_cursor (
  chat_id TEXT PRIMARY KEY REFERENCES chat (chat_id),
  through_message_id INTEGER NOT NULL DEFAULT 0,
  forget_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;

-- One row per memory job and per operation: what was accepted, what was rejected and why.
CREATE TABLE memory_event (
  id INTEGER PRIMARY KEY,
  job_id TEXT,
  chat_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('precheck', 'admit', 'extract', 'validate', 'verify', 'apply', 'note', 'forget', 'job')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'done', 'failed', 'skipped')),
  -- The kind of operation and the item it made or changed.
  op TEXT,
  item_id TEXT,
  -- A reason code such as quote_not_found. Never message text, a fact value or a model's words.
  reason TEXT CHECK (reason IS NULL OR reason NOT GLOB '*[^a-z0-9_.]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_event_by_job ON memory_event (job_id);
CREATE INDEX memory_event_by_chat ON memory_event (chat_id, created_at);

-- A window message that memory must not extract from: the text of a note the member already stored by hand.
ALTER TABLE session_message ADD COLUMN memory_skip INTEGER NOT NULL DEFAULT 0 CHECK (memory_skip IN (0, 1));

-- Which chain limit ended a turn's tool chain, if one did (docs/trd/tools.md#implicit-calls).
ALTER TABLE turn ADD COLUMN chain_limit TEXT CHECK (chain_limit IN ('calls', 'time'));
