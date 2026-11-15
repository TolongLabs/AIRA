-- Chats, identities, settings (docs/trd/data.md) and the record tables (docs/trd/records.md).
-- Record tables hold internal ids only: chat.chat_id and identity.subject_id, never a WhatsApp id.

-- One row per chat instance. A chat is created as pending at first sight and answers only once it is active.
CREATE TABLE chat (
  chat_id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
  label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL
) STRICT;

-- Maps each WhatsApp id of one person to one subject id.
CREATE TABLE identity (
  wa_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX identity_by_subject ON identity (subject_id);

-- The settings hierarchy: global, then chat type, then chat instance.
CREATE TABLE setting (
  level TEXT NOT NULL CHECK (level IN ('global', 'type', 'chat')),
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (level, scope, key),
  CHECK ((level = 'global') = (scope = '')),
  CHECK (level <> 'type' OR scope IN ('dm', 'group'))
) STRICT;

-- The change log for settings and packs. Kept; never pruned.
CREATE TABLE setting_change (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('setting', 'pack', 'chat')),
  actor TEXT NOT NULL,
  level TEXT,
  scope TEXT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TEXT NOT NULL
) STRICT;

CREATE INDEX setting_change_by_time ON setting_change (changed_at);

-- Per-chat runtime state, keyed by chat and by character so no state is shared across characters.
CREATE TABLE chat_state (
  chat_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, character_id, key)
) STRICT;

-- The turn record: one row, opened at step 1 and closed at step 8.
ALTER TABLE turn ADD COLUMN character_id TEXT;
ALTER TABLE turn ADD COLUMN outcome TEXT CHECK (outcome IN ('delivered', 'declined', 'muted', 'failed'));
ALTER TABLE turn ADD COLUMN failure_kind TEXT;
ALTER TABLE turn ADD COLUMN admitted_at TEXT;
ALTER TABLE turn ADD COLUMN built_at TEXT;
ALTER TABLE turn ADD COLUMN first_byte_at TEXT;
ALTER TABLE turn ADD COLUMN model_done_at TEXT;
ALTER TABLE turn ADD COLUMN cleaned_at TEXT;
ALTER TABLE turn ADD COLUMN returned_at TEXT;
ALTER TABLE turn ADD COLUMN system_tokens INTEGER;
ALTER TABLE turn ADD COLUMN window_size INTEGER;
ALTER TABLE turn ADD COLUMN recalled_ids TEXT CHECK (recalled_ids IS NULL OR json_valid(recalled_ids));
ALTER TABLE turn ADD COLUMN mood TEXT;
ALTER TABLE turn ADD COLUMN mood_source TEXT CHECK (mood_source IN ('rules', 'judge', 'default'));
ALTER TABLE turn ADD COLUMN shape_seed INTEGER;
ALTER TABLE turn ADD COLUMN length_bypass TEXT;
ALTER TABLE turn ADD COLUMN transport TEXT;
ALTER TABLE turn ADD COLUMN role TEXT;
ALTER TABLE turn ADD COLUMN model TEXT;
ALTER TABLE turn ADD COLUMN attempts INTEGER;
ALTER TABLE turn ADD COLUMN input_tokens INTEGER;
ALTER TABLE turn ADD COLUMN output_tokens INTEGER;
ALTER TABLE turn ADD COLUMN cached_tokens INTEGER;
ALTER TABLE turn ADD COLUMN cost_usd REAL;
ALTER TABLE turn ADD COLUMN reply_chars INTEGER;
ALTER TABLE turn ADD COLUMN bubble_count INTEGER;
ALTER TABLE turn ADD COLUMN sticker_id TEXT;
ALTER TABLE turn ADD COLUMN attachments TEXT CHECK (attachments IS NULL OR json_valid(attachments));
ALTER TABLE turn ADD COLUMN receipts TEXT CHECK (receipts IS NULL OR json_valid(receipts));
ALTER TABLE turn ADD COLUMN cleaning_steps TEXT CHECK (cleaning_steps IS NULL OR json_valid(cleaning_steps));

-- One row per request to any model role.
CREATE TABLE model_call (
  id INTEGER PRIMARY KEY,
  turn_id TEXT REFERENCES turn (turn_id),
  job_id TEXT,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  transport TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  failure_kind TEXT
) STRICT;

CREATE INDEX model_call_by_turn ON model_call (turn_id);

-- One row per tool or command call. Arguments are stored by shape, never by value.
CREATE TABLE tool_call (
  id INTEGER PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turn (turn_id),
  tool TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model', 'command')),
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  receipt_id TEXT,
  args_shape TEXT CHECK (args_shape IS NULL OR json_valid(args_shape))
) STRICT;

CREATE INDEX tool_call_by_turn ON tool_call (turn_id);

-- One row per scheduled or background run.
CREATE TABLE job_run (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  chat_id TEXT,
  job_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  counts TEXT CHECK (counts IS NULL OR json_valid(counts))
) STRICT;

CREATE INDEX job_run_by_kind ON job_run (kind, started_at);

-- The request and reply of a failed turn, verbatim, for a post-mortem. Pruned after records.diagnosticsHours.
CREATE TABLE failure_diagnostics (
  turn_id TEXT PRIMARY KEY REFERENCES turn (turn_id),
  request TEXT NOT NULL,
  reply TEXT,
  created_at TEXT NOT NULL
) STRICT;
