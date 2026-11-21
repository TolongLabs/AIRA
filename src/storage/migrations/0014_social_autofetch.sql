CREATE TABLE social_lookup (
  job_run_id INTEGER NOT NULL REFERENCES job_run(id),
  ordinal INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  platform TEXT NOT NULL,
  input_form TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  attempts TEXT NOT NULL CHECK (json_valid(attempts)),
  eligible_files INTEGER NOT NULL,
  downloaded_files INTEGER NOT NULL,
  PRIMARY KEY (job_run_id, ordinal)
) STRICT;

CREATE TABLE autofetch_delivery (
  job_run_id INTEGER PRIMARY KEY REFERENCES job_run(id),
  started_at TEXT NOT NULL,
  slots TEXT NOT NULL CHECK (json_valid(slots)),
  claimed_at TEXT,
  completed_at TEXT,
  outcomes TEXT CHECK (outcomes IS NULL OR json_valid(outcomes))
) STRICT;

-- Transient bearer material is stored separately from the exported records.
CREATE TABLE autofetch_delivery_key (
  job_run_id INTEGER PRIMARY KEY REFERENCES autofetch_delivery(job_run_id),
  digest TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE autofetch_repeat (
  digest TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX autofetch_repeat_expiry ON autofetch_repeat (expires_at);
