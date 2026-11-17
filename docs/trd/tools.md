# Tools And Commands

One registry of atomic tools, two ways to call them, and a standby path for external tool servers.

## Registry

Each tool is defined once, in `src/tools/`.

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Stable id, used by the model, by commands and in records                |
| `description` | What the model is told                                                  |
| `schema`      | Zod schema for the arguments                                            |
| `handler`     | One function. It receives validated arguments and the turn context      |
| `mode`        | `both`, `implicit` or `explicit`. See [Modes](#modes)                   |
| `mutates`     | True when the tool changes state. Such a tool must return a receipt     |
| `permission`  | The setting a chat needs for this tool                                  |
| `feature`     | The per-chat feature switch that enables it, if any                     |
| `timeoutMs`   | Hard limit for one call                                                 |
| `command`     | For `both` and `explicit`: the `/name`, its kind and its one-line usage |

The prompt text about tools, the leak guard's name list and `/help` are all generated from the registry. No second
list is maintained by hand.

![One tool call, from offering to receipt and outcome](../diagrams/tool-call.svg)

## Atomic Tools

A tool does one thing, and that thing happens fully or not at all.

1. **One action.** A tool never takes an `action` argument that selects among several operations. Create, list and
   cancel are three tools.
2. **One transaction.** A state change is one database transaction. The receipt is built after it commits. See
   [Persistence](storage.md#what-a-write-promises).
3. **Safe to repeat.** Every call carries a call id. A handler that sees a call id it has already completed returns
   the stored result and changes nothing.
4. **No hidden second effect.** A tool that reads does not also send. A tool that sends does not also file. Sending
   a file to the chat is its own step with its own receipt.
5. **One target for a removal.** A tool that removes or cancels acts on exactly one row, named by id. It never
   matches by a shared word.
6. **Bounded.** Every call has a timeout. A handler never throws into the loop.
7. **Checked first.** Permission, feature switch and scope are checked before the handler runs, by the registry, in
   one place.

A tool that cannot meet these rules is split until each part can.

## Turn Context

A handler never receives identity from the model. The turn context carries the chat id, sender id, character id,
resolved settings, the turn id, the call id and a deadline. It is built in code at step 2 of the turn.

## Modes

| Mode       | Called By                             | Use For                                                              |
| ---------- | ------------------------------------- | -------------------------------------------------------------------- |
| `both`     | The model, or a person with a command | Anything a person may ask for in words or want done exactly          |
| `implicit` | The model only                        | Housekeeping the model does while it works. Nobody types these       |
| `explicit` | A person with a command only          | Commands that describe the bot. The model has no reason to call them |

## Implicit Calls

The model decides when to call a tool, which one, and how many, in a chain where each result feeds the next.

1. Before the model is called, code computes the tools offered for this turn: registered, mode `both` or
   `implicit`, enabled by the chat's features, allowed by its permissions, and not withheld by a turn rule.
2. Tools that are not offered are removed from the model's declarations. The model cannot call what it cannot see.
3. Each call is validated against the schema, run under its timeout, and recorded with its outcome.
4. A failure returns a typed result the model can read: `timeout`, `refused`, `invalid`, `unavailable` or `error`,
   with a short reason.

Two limits end the chain. The first one reached wins.

| Limit      | Key                                                  | Default       | When It Is Reached                                                 |
| ---------- | ---------------------------------------------------- | ------------- | ------------------------------------------------------------------ |
| Call count | `tools.maxPerMessage` (cap: `tools.maxCallsPerTurn`) | 3 (ceiling 8) | The tool list is withdrawn, and the model answers with what it has |
| Tool time  | `tools.timeBudgetMs`                                 | 15000         | The same. A call in flight is cancelled at its own timeout         |

A turn with N commands may make at least N calls. The turn record notes which limit was reached, in `chain_limit`. Both
defaults are tuned from benchmark results.

Only `timeout`, `error` and `refused` outcomes write failure rows. `invalid` and `unavailable` results do not.

## Receipts

A tool with `mutates: true` returns a receipt: what changed, where, and the new state. The handler makes its
change through one `commit` call that the registry gives it. That call is one transaction that holds the change,
the stored result of the call (table `tool_result`, by call id) and the receipt (table `receipt`). A handler cannot
commit twice, and a tool that does not mutate cannot commit at all. Code attaches receipts to the
turn record and, when the pack asks for it, renders one line under the reply. The cleaning chain does not accept a
claim of a state change without a matching receipt from this turn.

## Explicit Calls: Text Commands

WhatsApp has no native commands, so a command is plain text, and it works like a skill call: the person names the
tool and says the rest in their own words.

```text
/remind i have a mtg ltr at 6pm, ping me by then
```

![How a /command anywhere in a message becomes a direct answer or a skill-style model turn](../diagrams/command-routing.svg)

### Detection

| Rule         | Behaviour                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Position     | A command is a `/name` token anywhere in the message: at the start, or after a space or a line break. Case does not matter. `and/or`, a path or a link is never a command |
| Count        | Up to the chat's `commands.maxPerMessage` commands per message, 1 by default, at most 5. Later ones are ordinary text, and the turn record lists them                     |
| Unknown name | `/name` that matches no command the chat may use is ordinary text and goes to the model                                                                                   |
| Groups       | A message that starts with a registered command addresses AIRA by itself. A command later in a group message needs the message to address AIRA as usual                   |
| Reply-to     | When the message replies to another, the quoted message is given to the commands as context                                                                               |

- **A message whose only command is a direct one** (`/help`, `/reminders`, `/mute` or `/unmute`) is answered by code
  with no model call, wherever the command stands. The words after it are its arguments, as in `/mute 2 hours`.
- **Anything else with commands** is one model turn. Every named skill-style tool is offered alone until it has been
  called once; then the chat's other tools are offered as usual. A direct command next to others is ordinary text,
  because the model is never offered a direct command's tool. The model writes one reply that covers them
  all. Its text is the message with the command tokens kept, so the model sees where each one was asked for.
- **`/help` is built per call** from the commands this chat may use right now: its feature switches, permissions and
  `commands.maxPerMessage`. A change on the site shows in the next `/help`.

### Two Kinds

| Kind        | Steps                                                                                                                                                                                             | Model Call |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Direct      | Code runs the handler and answers in plain words from the tool's result                                                                                                                           | None       |
| Skill-style | The model receives the free text and only the named tool, and must fill its arguments. Code validates them, runs the handler and issues the receipt. The model then writes the reply in character | One        |

### Rules For Skill-Style Commands

- **The command decides the tool.** The first call of the turn is the named tool. The model cannot pick another
  tool first, and cannot answer without calling it.
- **Code decides whether it ran.** Arguments are validated against the schema. The receipt, not the model's words,
  says what happened.
- **Unclear means ask.** When a required argument is missing or the text can be read two ways, AIRA asks one short
  question in character and runs nothing. It does not guess.
- **One target for a removal.** A command that removes or cancels must resolve to exactly one row. Two candidates
  produce a question that lists them.
- **Chaining is allowed after the named tool,** within the limits in [Implicit Calls](#implicit-calls). `/search`
  may go on to read a page.
- A command counts as one tool call toward `tools.maxPerMessage` (capped by `tools.maxCallsPerTurn`). A turn with N
  commands may make at least N calls.
- **Until the named tool has been called, it is the only tool the model is offered.** A call to any other tool
  in that step is dropped. The model may instead ask its one question and call nothing.
- **The model is shown what it must choose from.** Before the model fills the arguments of `/cancel` or `/forget`,
  code runs `reminder_list` or `recall` and adds the result to the message as a labelled, untrusted block. The
  model names one row by its id, or asks.

### Direct Command Answers

A character pack has no template for a command answer yet, so code writes the answer of a direct command from the
tool's result in plain words: a list for `/help`, `/list` and `/reminders`, one fixed sentence for `/mute` and
`/unmute`. The answer still passes the cleaning chain and the bubble splitter.

- `/help` lists each command with a plain one-line text written for members, never the description the model reads. A
  command with no plain entry of its own (such as `/lyrics`, `/song` or `/word`) falls back to the first sentence of
  its model description. `/list` names the tools and features switched on, in
  words, not tool ids. `/reminders` lists each reminder's text and due time, shown in `format.timeZone` (default
  `Asia/Kuala_Lumpur`) as a weekday, date and time, with the repeat when there is one. No internal id is shown.
- An answer never shows a raw field name, an internal id or a UTC timestamp. Pack templates for these answers
  are a later change to the pack contract.
- `/research` and `/pdf` pass the handler's character-line text through instead of a fixed sentence.

## Tool Set

### Core

| Tool              | Does                                                                       | Mode     | Command            | Kind        | Feature Switch       |
| ----------------- | -------------------------------------------------------------------------- | -------- | ------------------ | ----------- | -------------------- |
| `recall`          | Searches what AIRA remembers in this chat                                  | both     | `/recall`          | Skill-style | none                 |
| `note`            | Writes one fact into this chat's memory                                    | both     | `/remember`        | Skill-style | none                 |
| `forget`          | Forgets one named fact                                                     | both     | `/forget`          | Skill-style | none                 |
| `history_search`  | Searches what was said in this chat before                                 | both     | `/history`         | Skill-style | none                 |
| `web_search`      | Searches the web                                                           | both     | `/search`          | Skill-style | `features.search`    |
| `read_page`       | Opens and reads one web page                                               | both     | `/read`            | Skill-style | `features.search`    |
| `read_post`       | Opens one social post with its media                                       | both     | `/read`            | Skill-style | `features.social`    |
| `send_photo`      | Finds one real photo and sends it                                          | both     | `/photo`           | Skill-style | `features.photos`    |
| `reminder_set`    | Creates one reminder                                                       | both     | `/remind`          | Skill-style | `features.reminders` |
| `reminder_list`   | Lists this chat's reminders                                                | both     | `/reminders`       | Direct      | `features.reminders` |
| `reminder_cancel` | Cancels one reminder                                                       | both     | `/cancel`          | Skill-style | `features.reminders` |
| `set_mute`        | Stops or resumes proactive messages                                        | both     | `/mute`, `/unmute` | Direct      | none                 |
| `make_report`     | Writes one document as Markdown or PDF ([Research](research.md#documents)) | both     | `/doc`             | Skill-style | `features.reports`   |
| `research_start`  | Starts a research job ([Research](research.md))                            | explicit | `/research`        | Direct      | `features.research`  |
| `report_pdf`      | Renders the open offer's findings as a PDF                                 | explicit | `/pdf`             | Direct      | `features.research`  |
| `lingo_note`      | Files what one of this chat's words means                                  | implicit | none               |             | none                 |
| `help`            | Lists the commands this chat may use                                       | explicit | `/help`            | Direct      | none                 |
| `list`            | Lists the tools and features switched on                                   | explicit | `/list`            | Direct      | none                 |

- `/read` routes by the address: a social post or a YouTube video goes to `read_post`, anything else to `read_page`.
- **Not built yet:** `make_report` answers to `/report` and always writes a `.md` file. It takes no format argument,
  so PDF output is not built (src/tools/core/report.ts:33).
- `make_report` caps the title at 120 characters and the body at 50,000 characters.
- `read_page` reads through Exa's contents endpoint, with a live crawl when Exa has no copy, so a page that refuses
  plain fetches (such as openai.com, measured 403) still reads. A plain fetch is the fallback when Exa is off or fails.
  The text is clipped to `search.pageMaxChars` and labelled untrusted.
- `read_post` is ported from rokabot's social reader: X, Threads, Bluesky, Instagram, TikTok, Reddit, Bilibili and
  YouTube, with the post's text, author, most-liked replies where the site gives them, and its picture or video. A
  YouTube video, or a post's video, is watched by the media model as in [Models](models.md#media-watching).
- `make_report` writes the document. Sending it to the chat is a separate delivery step with its own receipt.
- The gateway's schedule fires reminders. `reminder_set` and `reminder_cancel` change the `reminder` row in one
  transaction and then rewrite the core's wanted-jobs file. A host reconciler makes the gateway's jobs match it within
  a minute. See [Scheduled Turns](system.md#scheduled-turns).
- `recall` returns 8 items and `history_search` 10. A query caps at 200 characters and note text at 500 characters.
- `note` is checked by the judge port before the commit, outside any transaction.
- `forget` with only a query removes nothing. It returns candidates and still commits a forget-barrier receipt.
- `reminder_set` needs a future ISO due time and text of at most 500 characters. `reminder_cancel` only cancels the
  sender's own active reminder. Another chat's id reads as nonexistent.
- A failed schedule-file rewrite warns `reminder_schedule_sync_failed` and leaves the committed row. The next change
  or start-up reconciliation rewrites the file.
- `send_photo` downloads at most 5 MB. It accepts only jpeg, png, webp and gif, and refuses a non-image as invalid.
- `research_start` refuses a second concurrent job per chat. A topic that names a pdf or a report presets the PDF want.
- `report_pdf` carries its own 25-second timeout, above the 15-second default.
- Media watching is not a tool. It runs at intake. See [Models](models.md#media-watching).

### Search Provider

`web_search` asks the backend named in `search.provider`. `off` leaves the tool unavailable, and it says so in
character.

- `exa`: one `POST https://api.exa.ai/search` per call, with `type: auto`, 5 results and highlights, and the key
  `EXA_API_KEY` in the `x-api-key` header. Each result is its title, its URL and its first highlight as the snippet,
  cut to 300 characters. Exa writes no answer of its own, so the model writes it from the snippets.
- The provider gets 10 seconds; the tool's own time limit still applies. A failure is the tool's `error` result and
  never shows the key or the provider's message.
- With `exa` set and no key in the environment, start-up logs `search.off` and the tool stays unavailable. The rest
  of the core is not affected.
- A fetch guard wraps every page and post read. It refuses non-http(s) addresses, credentials, localhost and private
  or link-local IPs. The page fetch re-checks DNS after each redirect, follows at most 3 redirects, and caps bodies
  at 2 MB and text at 8,000 characters.

### Social Post Reader

`read_post` takes one `url`; its argument schema stays unchanged. `/read` routes
only recognized post URLs to it. Profiles, home pages, Facebook and unsupported
share links use `read_page`. Supported platforms are X, Bluesky, Threads,
YouTube, TikTok, Reddit, Instagram and Bilibili.

The result keeps `author`, `text` and `media` URLs, and adds `platform`, `handle`,
`createdAt`, `quotedText`, `replyCount`, `canonicalUrl`, `durationSec` and
`replies`. One reply lookup runs in parallel with the post lookup. It returns
up to five top replies by default, capped at 280 characters each; reply failure
leaves an empty list and never fails a readable post. All returned content is
untrusted external data; the social port marks its result with `untrusted: true`.

Post `timeout` maps to tool `timeout`, `binary_missing` to `unavailable`, and
HTTP failures, `no_post_data`, `missing_post` and other lookup failures to
`error`. Logs contain platform and reason only. No cookies are used. X post
identifiers are sent to the third-party FxTwitter service. YouTube replies
require the optional `YOUTUBE_API_KEY`; other YouTube metadata remains usable
without it. Missing yt-dlp disables only extractor-dependent reads; Reddit
text and image feeds remain readable.

Social settings (kept here because the media configuration table is maintained
by the link-intake work order):

| Key                      | Default  | Effect                                               |
| ------------------------ | -------- | ---------------------------------------------------- |
| `social.timeoutMs`       | 6000     | Hard deadline per lookup                             |
| `social.cacheTtlMs`      | 900000   | Successful lookup cache lifetime; 0 disables caching |
| `social.maxCacheEntries` | 256      | Maximum entries per LRU cache                        |
| `social.maxTextChars`    | 1500     | Post text limit                                      |
| `social.maxReplies`      | 5        | Replies returned, at most 50                         |
| `social.maxReplyChars`   | 280      | Reply text limit, in Unicode code points             |
| `social.ytDlpPath`       | `yt-dlp` | Metadata extractor binary                            |

### Lessons And Library

Built after the core set, behind `features.lessons`. A chat with the switch off is offered none of these tools.
Their data is specified in [Lessons Data Model](#lessons-data-model).

![The lessons and library tools, grouped by feature, and the store they share](../diagrams/lessons-tools.svg)

| Tool             | Does                                       | Mode     | Command   | Kind        |
| ---------------- | ------------------------------------------ | -------- | --------- | ----------- |
| `lyrics_search`  | Finds candidate lyrics for a song          | both     | `/lyrics` | Skill-style |
| `lyrics_fetch`   | Fetches the lyrics of one search result    | implicit | none      |             |
| `song_get`       | Fetches one filed song with its readings   | both     | `/song`   | Skill-style |
| `vocab_lookup`   | Looks up one word and where it appeared    | both     | `/word`   | Skill-style |
| `song_save`      | Files one worked song as study notes       | implicit | none      |             |
| `gloss_set`      | Fills in what one word or pattern means    | implicit | none      |             |
| `library_gaps`   | Says what the library still lacks          | implicit | none      |             |
| `library_search` | Searches the library and follows its links | implicit | none      |             |
| `library_write`  | Files one library node                     | implicit | none      |             |
| `library_open`   | Reads one library node by title            | implicit | none      |             |

### Lessons Data Model

Lessons data is study material: songs worked through, the words and patterns in them, and library notes. It lives
in the same SQLite file, in its own tables. It is **one library shared by every chat** that has `features.lessons`
on, as the old core kept it (measured on the production host, 16 Nov 2026). Only a lyrics search's results belong to
the chat that searched.

| Table                      | One Row Is                                                                                    | Key                      |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------------ |
| `lesson_song`              | One filed song: title, artist, language, where it came from                                   | Title and artist         |
| `lesson_song_line`         | One line of a filed song: its text and reading                                                | Song and position        |
| `lesson_song_line_meaning` | What one line means in one language                                                           | Song, position, language |
| `lesson_word`              | One word or pattern: its reading, and its level, part of speech, forms and example when known | Kind and the word        |
| `lesson_word_meaning`      | What one word or pattern means in one language                                                | Word and language        |
| `lesson_word_seen`         | One place a word appeared: a song and a line                                                  | Word, song and position  |
| `lesson_lyrics_candidate`  | One result of a lyrics search, kept so a fetch can name it                                    | Chat and candidate id    |
| `library_node`             | One library note: a title and a body                                                          | Title                    |
| `library_link`             | One link from a note to a title                                                               | Note and target title    |

- **Shared, never personal.** The library holds study material, not memory. No lessons table holds a subject id or
  a fact about a member, and the lessons tools' descriptions say the library is shared by every chat. Memory stays
  in its own chat, by [Memory](memory.md#scope).
- **Meanings are per language.** A line, a word or a pattern can carry a meaning in several languages, keyed by a
  language code such as `en` or `zh`. `gloss_set` names the language it fills in. `song_get` and `vocab_lookup`
  return every meaning, the chat's own `language` setting first.
- **Words keep what the old library knew.** `level` (such as a JLPT level), `pos`, `forms` (a list) and `example`
  are optional. A pattern is a word row of kind `pattern`.
- **A lyrics candidate stays in its chat.** A fetch names a candidate of its own chat only.
- **Titles and words are matched without case.** A second song with the same title and artist, a second word and a
  second note with the same title replace the first. Nothing is filed twice.
- **A word starts without a meaning.** `song_save` files the words of a song with the lines they appeared in.
  `gloss_set` fills in what one word or pattern means in one language. A `kind` column tells a word from a pattern.
- **Links are written by code.** A note's body marks a link as `[[Title]]`. On `library_write`, code reads the marks
  and stores one `library_link` row for each. A link may name a title that has no note yet.
- **Gaps are computed.** `library_gaps` lists up to 20 link targets with no note and words with no meaning. It
  stores nothing.
- **Lyrics fetch truncates.** The fetch cuts provider text to 200 lines and 500 characters per line, and flags the
  result truncated.
- **Search follows one step.** `library_search` returns up to 8 notes that match by keyword, and the notes they
  link to. It uses a full-text index kept in step by code, in the same transaction.
- **Lyrics come from a provider.** `lyrics_search` asks the lyrics provider and stores its results as candidates.
  `lyrics_fetch` takes the id of one stored candidate of this chat, never an address from the model. Lyrics text is
  untrusted and is labelled as such. With `lessons.lyricsProvider` set to `off`, both tools answer that lyrics are
  not available.
- **Limits.** A title holds at most 120 characters, a note body 8,000, a song 200 lines, a line 500 characters.
  A text over a limit is refused, not cut.
- **Receipts.** `song_save`, `gloss_set` and `library_write` change state and return receipts of kind
  `lesson.song_saved`, `lesson.gloss_set` and `library.written`. The other seven tools change no lessons data;
  `lyrics_search` stores candidates only, which are a cache.

Measured against the old library on the production host, 16 Nov 2026 (it replaced Assumption A-8): one shared
library of about 2,100 notes (1,848 words, 240 patterns, 7 songs, 5 artists), words and lines with an English and a
Chinese meaning, and no chat with lessons switched on. Its migration follows the steps of the
[memory migration](memory.md#migration). An artist note with no body has no row to become and is reported.

### Owner Tools

The owner's market and coding-session tools, ported as atomic tools (the old `market_watch` and `session_notices` each bundled several actions) into the core in TypeScript, with the same behaviour as the old
Python (`plugins/markets`, `scripts/brain/markets.py`, `plugins/claudecode`). The state that host services still read
stays in its host file, mounted into the container, so the `market-alerts.timer` and the `cc-relay` service keep
working unchanged.

| Tool                                         | Does                                                                   | Mode | Changes State | Host State                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------- | ---- | ------------- | ----------------------------------------------------------- |
| `market_quote`                               | Live prices for one or more tickers, indices or coins                  | both | No            | None                                                        |
| `market_analyse`                             | One symbol: price, 52-week position, moving averages, volatility, news | both | No            | None                                                        |
| `market_news`                                | Recent headlines for a ticker or a market topic                        | both | No            | None                                                        |
| `market_watch_list`                          | The watchlist, holdings and alerts of this chat, with prices           | both | No            | `owner.marketsConfig`, read                                 |
| `market_symbol_search`                       | Find the ticker for a company or asset name                            | both | No            | None                                                        |
| `market_watch_add`, `market_watch_remove`    | Add or remove watchlist symbols                                        | both | Yes           | `owner.marketsConfig`, read and written by the alerts timer |
| `market_alert_set`, `market_alert_clear`     | Arm or disarm a price alert                                            | both | Yes           | `owner.marketsConfig`                                       |
| `market_holding_set`, `market_holding_clear` | Record or remove a holding                                             | both | Yes           | `owner.marketsConfig`                                       |
| `claude_sessions`                            | What Claude Code sessions are doing on the host                        | both | No            | `owner.claudeProjectsDir`, read only                        |
| `session_notices_status`                     | Whether Claude Code session notices arrive in this chat                | both | No            | `owner.noticeRoutesFile`, read                              |
| `session_notices_set`                        | Turn this chat's Claude Code session notices on or off                 | both | Yes           | `owner.noticeRoutesFile`, read by the `cc-relay` service    |

- **Gate:** every owner tool needs the chat setting `features.owner`, off by default. Code removes the tools from any
  other chat before the model sees them.
- **Providers:** the same keyless price and news sources the old code used. A provider call has the tool's timeout and
  fails as a typed result, never as raw error text.
- **Files:** each path is a container path under a read-write or read-only mount in compose. A path left empty turns
  its tool off. A write replaces the file atomically (write a temporary file, then rename) and keeps the old file's
  keys it does not own, so the host service that reads it never sees half a file.
- A tool that changes a file commits its receipt only after the write succeeds. Receipts name the chat by its internal id.
- `market_quote` takes up to 20 symbols. `market_news` defaults to 8 headlines, at most 15. `market_analyse` defaults
  to a 1-year span with news. Provider calls carry `owner.timeoutMs`, 10 seconds by default, inside the tool's own
  time limit, and news stays within 7 days. Short names resolve through ticker, index and coin alias tables before lookup.
- Watchlists, alerts and positions are keyed by WhatsApp chat id in the host file, while receipts name the chat by its
  internal id.
- `claude_sessions` shows active sessions within 30 minutes by default, clamped to one day. A remote machine name is
  refused without a query.
- Machine names resolve through synonym, leading-word and possessive stripping plus substring match. An unclear name
  matches nothing until the member picks one.
- An empty `owner.marketsConfig` leaves the watch tools off. An empty `owner.claudeProjectsDir` leaves session
  listing off, and an empty `owner.noticeRoutesFile` leaves the notice tools off.

### Changed From The Old Tool Set

| Old Tool                        | Now                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `cronjob`                       | Split into `reminder_set`, `reminder_list` and `reminder_cancel`                             |
| `lyrics_prepare`                | Removed. It bundled several actions; the single tools replace it                             |
| `lyrics_fetch`                  | Fetches only. It no longer sends a lesson by itself                                          |
| `vision_analyze`                | Removed as a tool. Pictures are read at intake                                               |
| `send_video`                    | Never existed. It was named in a list and registered nowhere                                 |
| `brain_*` names                 | Renamed as in the tables above                                                               |
| Market and coding-session tools | Ported into the core as atomic tools behind `features.owner`, in [Owner Tools](#owner-tools) |

### Faults This Design Removes

| Fault In The Old System                                | Rule That Removes It                      |
| ------------------------------------------------------ | ----------------------------------------- |
| No timeout on a tool call                              | Bounded                                   |
| Every tool registered twice, once per loop             | One registry, one loop                    |
| A save reports failure after it worked                 | One transaction, receipt after commit     |
| Forget can retire three facts that share a word        | One target for a removal                  |
| A report tool with no chat or permission check         | Checked first                             |
| Reminders that are never written to the reminder store | One transaction, one writer for reminders |

## External Tool Servers

The core is a Model Context Protocol client. This path is built and tested but ships with no server enabled.

```yaml
mcp:
  servers:
    - id: example
      transport: stdio
      command: ['example-server']
      tools: ['lookup'] # allowlist; anything else is ignored
      chats: [] # chat ids that may use it; empty means none
      timeoutMs: 10000
```

- A server's tools enter the registry under `<server id>.<tool>` with mode `implicit`, `mutates: true` assumed and
  no command.
- A model sees the name with the dot written as two underscores, as in `example__lookup`, because model APIs
  accept no dot in a function name. Records keep the registry name.
- A chat uses a server only when it is in the server's `chats` list and its setting `mcp.<server id>` is on.
- A server's tool description is cut to one line of 500 characters before it enters the prompt.
- A server process gets a minimal environment. It never receives the core's secrets.
- Only allowlisted tools are registered, and only for the listed chats.
- Results from an external server are untrusted text, cut to 8,000 characters and labelled with their server source
  in the prompt.
- An external tool cannot be made atomic by the core. Its calls count toward both limits, and its results never
  produce a receipt.
- A server that fails to start, or times out, is marked unavailable. The turn continues without it.

The core is also a Model Context Protocol server for one client only: the subscription runner. It serves the same
registry over that protocol so both runners use identical tools. See [Models](models.md).

## Configuration

| Key                      | Default | Effect                                                                           |
| ------------------------ | ------- | -------------------------------------------------------------------------------- |
| `tools.maxCallsPerTurn`  | 8       | Ceiling on tool calls in one turn; each chat sets `tools.maxPerMessage` below it |
| `tools.timeBudgetMs`     | 15000   | Limit on total tool time in one turn                                             |
| `tools.defaultTimeoutMs` | 15000   | Timeout when a tool sets none                                                    |
| `search.provider`        | `off`   | Web search backend, or `off`                                                     |
| `mcp.servers`            | `[]`    | External tool servers                                                            |
| `lessons.lyricsProvider` | `off`   | The lyrics provider, or `off`                                                    |
