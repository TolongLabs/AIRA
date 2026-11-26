-- A returned core turn is not a confirmed transport send. Typed items are claimed once before delivery.
CREATE TABLE standalone_delivery (
  delivery_id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  inbound_mid TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turn (turn_id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'document')),
  file_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'confirmed', 'failed', 'unknown')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  UNIQUE (turn_id, position),
  CHECK ((kind = 'text') = (file_sha256 IS NULL)),
  CHECK ((state = 'pending') = (claimed_at IS NULL)),
  CHECK ((state IN ('confirmed', 'failed', 'unknown')) = (finished_at IS NOT NULL))
) STRICT;
