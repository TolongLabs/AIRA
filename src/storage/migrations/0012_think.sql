-- Deeper thinking turns and per-call effort (docs/trd/models.md#deeper-thinking).
ALTER TABLE turn ADD COLUMN think INTEGER NOT NULL DEFAULT 0 CHECK (think IN (0, 1));
ALTER TABLE model_call ADD COLUMN effort TEXT;
