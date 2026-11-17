-- Arrival-to-core-return timings. Existing rows keep unknown totals.
ALTER TABLE turn ADD COLUMN arrived_at TEXT;
ALTER TABLE turn ADD COLUMN queue_ms INTEGER;
ALTER TABLE turn ADD COLUMN media_ms INTEGER;
ALTER TABLE turn ADD COLUMN tool_ms INTEGER;
ALTER TABLE turn ADD COLUMN total_ms INTEGER;
