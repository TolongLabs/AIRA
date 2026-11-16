-- Lessons and library (docs/trd/tools.md#lessons-data-model). One library shared by every chat with lessons on:
-- study material, never memory, so no table here holds a subject id. Only a lyrics search's results belong to a
-- chat. Titles and words are matched without case through their *_key column, set by code.

CREATE TABLE lesson_song (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  artist TEXT NOT NULL DEFAULT '' CHECK (length(artist) <= 120),
  -- Lower case, trimmed: the title, a line feed, the artist.
  song_key TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL DEFAULT '' CHECK (length(language) <= 40),
  -- Where the lyrics came from: a provider's name and its reference, never a full address the model gave.
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE lesson_song_line (
  song_id TEXT NOT NULL REFERENCES lesson_song (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  reading TEXT NOT NULL DEFAULT '' CHECK (length(reading) <= 500),
  PRIMARY KEY (song_id, position)
) STRICT;

-- What one line means in one language, such as en or zh.
CREATE TABLE lesson_song_line_meaning (
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 16),
  meaning TEXT NOT NULL CHECK (length(meaning) BETWEEN 1 AND 500),
  PRIMARY KEY (song_id, position, language),
  FOREIGN KEY (song_id, position) REFERENCES lesson_song_line (song_id, position) ON DELETE CASCADE
) STRICT;

CREATE TABLE lesson_word (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('word', 'pattern')),
  word TEXT NOT NULL CHECK (length(word) BETWEEN 1 AND 120),
  -- Lower case, trimmed.
  word_key TEXT NOT NULL,
  reading TEXT NOT NULL DEFAULT '' CHECK (length(reading) <= 200),
  -- What the old library knew, when known: a level such as N3, a part of speech, other forms (a JSON list of
  -- strings) and one example.
  level TEXT NOT NULL DEFAULT '' CHECK (length(level) <= 20),
  pos TEXT NOT NULL DEFAULT '' CHECK (length(pos) <= 40),
  forms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(forms) AND json_type(forms) = 'array'),
  example TEXT NOT NULL DEFAULT '' CHECK (length(example) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, word_key)
) STRICT;

-- What one word or pattern means in one language. A word with no row here has no meaning yet: that is a gap.
CREATE TABLE lesson_word_meaning (
  word_id TEXT NOT NULL REFERENCES lesson_word (id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 16),
  meaning TEXT NOT NULL CHECK (length(meaning) BETWEEN 1 AND 500),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (word_id, language)
) STRICT;

CREATE TABLE lesson_word_seen (
  word_id TEXT NOT NULL REFERENCES lesson_word (id) ON DELETE CASCADE,
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (word_id, song_id, position),
  FOREIGN KEY (song_id, position) REFERENCES lesson_song_line (song_id, position) ON DELETE CASCADE
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
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  -- Lower case, trimmed.
  title_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- One link from a note to a title. The target may have no note yet: that is a gap.
CREATE TABLE library_link (
  node_id TEXT NOT NULL REFERENCES library_node (id) ON DELETE CASCADE,
  target_title TEXT NOT NULL,
  target_key TEXT NOT NULL,
  PRIMARY KEY (node_id, target_key)
) STRICT;

CREATE INDEX library_link_by_target ON library_link (target_key);

-- The full-text index of library notes. Code keeps it in step with library_node, in the same transaction. A search
-- reads the text from library_node.
CREATE VIRTUAL TABLE library_fts USING fts5 (node_id UNINDEXED, text, tokenize = 'unicode61');
