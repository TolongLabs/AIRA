-- A user row can carry the message it quotes, beside its own text and never inside it
-- (docs/trd/system.md#gateway-contract). quote_mid is the quoted message's gateway id, so a forget that clears
-- that message's text can clear its quotes too.
ALTER TABLE session_message ADD COLUMN quote TEXT;
ALTER TABLE session_message ADD COLUMN quote_mid TEXT;
ALTER TABLE session_message ADD COLUMN quote_of_aira INTEGER NOT NULL DEFAULT 0 CHECK (quote_of_aira IN (0, 1));
