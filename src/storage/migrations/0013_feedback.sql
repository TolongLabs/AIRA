-- Member feedback reports and the outbound Apps Script cursor (issue #125).

CREATE TABLE feedback_report (
  report_id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE CHECK (length(ref) = 10),
  chat_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  -- Kept as an audit identifier after ordinary turn retention removes the source row.
  turn_id TEXT NOT NULL,
  turn_ids TEXT NOT NULL CHECK (json_valid(turn_ids) AND json_type(turn_ids) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('open', 'received', 'closed', 'expired')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  received_at TEXT,
  closed_at TEXT,
  form_seq INTEGER UNIQUE CHECK (form_seq IS NULL OR form_seq > 0),
  answers TEXT CHECK (answers IS NULL OR json_valid(answers)),
  CHECK ((state IN ('received', 'closed')) = (received_at IS NOT NULL)),
  CHECK ((state IN ('received', 'closed')) = (form_seq IS NOT NULL)),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX feedback_report_open_subject
ON feedback_report (chat_id, subject_id)
WHERE state = 'open';

CREATE INDEX feedback_report_by_state ON feedback_report (state, expires_at);
CREATE INDEX feedback_report_by_received ON feedback_report (received_at);

CREATE TABLE feedback_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  "after" INTEGER NOT NULL CHECK ("after" >= 0),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO feedback_cursor (singleton, "after", updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');
