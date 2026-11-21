ALTER TABLE social_lookup ADD COLUMN redirect_hops INTEGER;
ALTER TABLE social_lookup ADD COLUMN resolve_ms INTEGER;
ALTER TABLE social_lookup ADD COLUMN missing_fields INTEGER NOT NULL DEFAULT 0;
ALTER TABLE social_lookup ADD COLUMN video_duration_band TEXT;

CREATE TABLE social_turn_lookup (
  turn_id TEXT REFERENCES turn(turn_id) ON DELETE CASCADE,
  tool_call_id INTEGER REFERENCES tool_call(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  started_at TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  platform TEXT NOT NULL,
  input_form TEXT NOT NULL,
  redirect_hops INTEGER,
  resolve_ms INTEGER,
  outcome TEXT NOT NULL,
  reason TEXT,
  attempts TEXT NOT NULL CHECK (json_valid(attempts)),
  missing_fields INTEGER NOT NULL DEFAULT 0,
  CHECK ((turn_id IS NOT NULL) + (tool_call_id IS NOT NULL) = 1)
) STRICT;

CREATE UNIQUE INDEX social_turn_lookup_intake_slot ON social_turn_lookup (turn_id, ordinal) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX social_turn_lookup_tool_slot ON social_turn_lookup (tool_call_id, ordinal) WHERE tool_call_id IS NOT NULL;
