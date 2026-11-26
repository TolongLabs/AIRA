-- Route-bound self-reminders and their one-time text delivery obligations.
ALTER TABLE reminder ADD COLUMN standalone_route_id TEXT;
ALTER TABLE reminder ADD COLUMN standalone_profile TEXT
  CHECK ((standalone_route_id IS NULL) = (standalone_profile IS NULL));
CREATE INDEX reminder_by_standalone_route ON reminder (standalone_route_id, standalone_profile, state, due_at);

ALTER TABLE standalone_delivery ADD COLUMN reminder_id TEXT;
ALTER TABLE standalone_delivery ADD COLUMN reminder_due_at TEXT
  CHECK ((reminder_id IS NULL) = (reminder_due_at IS NULL) AND (reminder_id IS NULL OR kind = 'text'));
CREATE UNIQUE INDEX standalone_reminder_occurrence ON standalone_delivery (reminder_id, reminder_due_at)
  WHERE reminder_id IS NOT NULL;
