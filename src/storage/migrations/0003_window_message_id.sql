-- A user row in the conversation window carries its gateway message id, so a message that is received twice is
-- stored once. The window is then the durable input of a turn: a turn answers what is in it.
ALTER TABLE session_message ADD COLUMN mid TEXT;

CREATE UNIQUE INDEX session_message_by_mid ON session_message (chat_id, mid) WHERE mid IS NOT NULL;
