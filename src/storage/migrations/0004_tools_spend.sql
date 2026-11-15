-- Tools (docs/trd/tools.md) and spend (docs/trd/models.md).

-- The stored result of every completed tool call, by call id. A handler that sees a call id it has already
-- completed returns this result and changes nothing.
CREATE TABLE tool_result (
  call_id TEXT PRIMARY KEY,
  turn_id TEXT REFERENCES turn (turn_id),
  chat_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX tool_result_by_turn ON tool_result (turn_id);

-- A receipt: what changed, where, and the new state. Built by code after the change committed.
CREATE TABLE receipt (
  receipt_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES tool_result (call_id),
  turn_id TEXT REFERENCES turn (turn_id),
  chat_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  -- What happened, such as reminder.created.
  kind TEXT NOT NULL,
  -- The id of the row that changed, and its new state as JSON. No message text.
  target TEXT,
  state TEXT CHECK (state IS NULL OR json_valid(state)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX receipt_by_turn ON receipt (turn_id);
CREATE INDEX receipt_by_chat ON receipt (chat_id, created_at);

-- Reminders and their gateway job ids. The reminder tools are the only code that writes this table.
CREATE TABLE reminder (
  reminder_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  -- The subject who set it, and the subject it is for.
  owner_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'fired', 'cancelled')),
  -- When it fires, and the rule for repeating it, if any.
  due_at TEXT NOT NULL,
  repeat TEXT,
  -- What to say. Verbatim text the member asked to be reminded of; pruned with the reminder.
  text TEXT NOT NULL,
  gateway_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX reminder_by_chat ON reminder (chat_id, state, due_at);

-- Cost per role per month.
CREATE TABLE spend (
  month TEXT NOT NULL,
  role TEXT NOT NULL,
  -- Whether the cost counts against the cap. The subscription transport records an estimate that does not.
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month, role, counted)
) STRICT;
