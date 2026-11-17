-- manual: rebuild backup_run so reason also allows offsite and check, and state allows ok.
CREATE TABLE backup_run_new (
  id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('timer', 'migration', 'deploy', 'manual', 'offsite', 'check')),
  state TEXT NOT NULL CHECK (state IN ('started', 'verified', 'failed', 'ok')),
  file TEXT NOT NULL,
  bytes INTEGER,
  detail TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  removed_at TEXT
) STRICT;

INSERT INTO backup_run_new (id, reason, state, file, bytes, detail, started_at, ended_at, removed_at)
SELECT id, reason, state, file, bytes, detail, started_at, ended_at, removed_at FROM backup_run;

DROP TABLE backup_run;

ALTER TABLE backup_run_new RENAME TO backup_run;

CREATE INDEX backup_run_by_state ON backup_run (state, started_at);
