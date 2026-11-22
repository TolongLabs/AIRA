-- Site-created routines are bound to an internal chat independently of member-visible prompt text.
CREATE TABLE site_job (
  tag TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat(chat_id)
) STRICT;
