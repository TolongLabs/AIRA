-- Lessons and library (docs/trd/tools.md#lessons-data-model). Every row belongs to one chat. No query reads a
-- row without a chat id. Titles and words are matched without case through their *_key column, set by code.

CREATE TABLE lesson_song (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  artist TEXT NOT NULL DEFAULT '' CHECK (length(artist) <= 120),
  -- Lower case, trimmed: the title, a line feed, the artist.
  song_key TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '' CHECK (length(language) <= 40),
  -- Where the lyrics came from: a provider's name and its reference, never a full address the model gave.
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, song_key),
  UNIQUE (id, chat_id)
) STRICT;

CREATE TABLE lesson_song_line (
  song_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  reading TEXT NOT NULL DEFAULT '' CHECK (length(reading) <= 500),
  meaning TEXT NOT NULL DEFAULT '' CHECK (length(meaning) <= 500),
  PRIMARY KEY (song_id, position),
  FOREIGN KEY (song_id, chat_id) REFERENCES lesson_song (id, chat_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE lesson_word (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  kind TEXT NOT NULL CHECK (kind IN ('word', 'pattern')),
  word TEXT NOT NULL CHECK (length(word) BETWEEN 1 AND 120),
  -- Lower case, trimmed.
  word_key TEXT NOT NULL,
  reading TEXT NOT NULL DEFAULT '' CHECK (length(reading) <= 200),
  -- Empty until gloss_set fills it in.
  meaning TEXT NOT NULL DEFAULT '' CHECK (length(meaning) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, kind, word_key),
  UNIQUE (id, chat_id)
) STRICT;

CREATE TABLE lesson_word_seen (
  word_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (word_id, song_id, position),
  FOREIGN KEY (word_id, chat_id) REFERENCES lesson_word (id, chat_id) ON DELETE CASCADE,
  FOREIGN KEY (song_id, chat_id) REFERENCES lesson_song (id, chat_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX lesson_word_seen_by_song ON lesson_word_seen (song_id);

-- One result of a lyrics search. A fetch names a row of this table by its id, in its own chat.
CREATE TABLE lesson_lyrics_candidate (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  provider TEXT NOT NULL,
  -- The provider's own reference for the result.
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX lesson_lyrics_candidate_by_chat ON lesson_lyrics_candidate (chat_id, created_at);

CREATE TABLE library_node (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat (chat_id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- Lower case, trimmed.
  title_key TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (chat_id, title_key),
  UNIQUE (id, chat_id)
) STRICT;

-- One link from a note to a title. The target may have no note yet: that is a gap.
CREATE TABLE library_link (
  node_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  target_title TEXT NOT NULL,
  target_key TEXT NOT NULL,
  PRIMARY KEY (node_id, target_key),
  FOREIGN KEY (node_id, chat_id) REFERENCES library_node (id, chat_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX library_link_by_target ON library_link (chat_id, target_key);

-- The full-text index of library notes. Code keeps it in step with library_node, in the same transaction. Every
-- search gives a chat id, and reads the text from library_node.
CREATE VIRTUAL TABLE library_fts USING fts5 (node_id UNINDEXED, chat_id UNINDEXED, text, tokenize = 'unicode61');
