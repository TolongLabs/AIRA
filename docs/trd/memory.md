# Memory

Typed records in one table, one write path, a judge model beside the main model, and a hard boundary at the chat.

## Item Model

All memory is rows in `memory_item`.

| Column                     | Meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `id`                       | Primary key                                                          |
| `chat_id`                  | The chat instance that owns the row. Never null                      |
| `kind`                     | `fact`, `episode` or `media`                                         |
| `subject_id`               | The person a fact is about, or null for a fact about the chat itself |
| `key`                      | Normalised slot for a fact, such as `likes.food`                     |
| `value`                    | The content, at most 500 characters                                  |
| `status`                   | `active`, `upcoming`, `superseded`, `retired` or `forgotten`         |
| `pinned`                   | True for facts that must always be recalled                          |
| `source_turn`              | The turn id it came from                                             |
| `source_job`               | The memory job that wrote it, if one did                             |
| `source_message_id`        | The window message that supports a fact                              |
| `valid_until`              | Lapse time for an `upcoming` fact                                    |
| `created_at`, `updated_at` | Set by code                                                          |

- A partial unique index allows one `active` fact, and one `upcoming` fact, per `(chat_id, subject_id, key)`.
- Keys that start with `note.` or `lingo.` are written only by the `note` and `lingo_note` tools. Extraction can
  never write or change them.
- A key holds lower-case words joined by dots, such as `likes.food`. Code normalises a proposed key before it
  checks it. Comparison of values and quotes is NFKC, lower case, WhatsApp markup removed, blanks collapsed.
- CHECK constraints reject an unknown `kind` or `status`, and an empty `value`.
- `episode` and `media` rows carry an embedding in a side table. Facts are recalled by key and keyword.

## Scope

- Every read and write is filtered by `chat_id`. The data layer exposes no query without it. A test fails when
  SQL that names a memory table appears outside the memory and storage modules.
- A search reads its text from `memory_item`, joined on the item id and the chat id. It never returns text from
  the full-text index itself, so a stale index row can show nothing.
- Inside one chat, facts about any member may be used in any member's turn.
- A fact never appears in another chat, including the same person's DM and group. The same person in two chats has
  two separate sets of facts.
- A WhatsApp phone id and its linked id for one person map to one `subject_id` through the `identity` table.

## Write Path

![Memory write path: an episode closes, is queued, admitted by the judge, extracted by the main model, checked, confirmed and applied in one transaction](../diagrams/memory-write-path.svg)

1. **Capture.** Each delivered turn appends its messages to `session_message`.
2. **Close.** An episode closes after `memory.episodeIdleMs` without a message, or after the chat's
   `memory.pageMessages` messages (default 25). A per-chat value must be an integer from 5 to 50, else code uses
   the deployment fallback `memory.episodeMaxMessages`. The closer selects at most that many rows into one job.
3. **Queue.** A job row is written to `memory_job`, and the chat's cursor moves to the last message the job
   covers, in one transaction. The queue lives in SQLite and survives a restart. The job holds the range, the
   count of its messages, and the chat's forget counter. A job that later finds fewer messages than it counted
   fails as `episode_pruned`: it never ends as done on a part of its episode.
4. **Precheck.** Code drops episodes that hold only greetings, reactions or AIRA's own lines.
5. **Admit.** The judge model answers whether the episode holds anything lasting. Below the threshold, the job ends.
6. **Extract.** The main model returns proposed operations as structured output: `add`, `update`, `supersede`,
   `retire`, each with its subject, key, value and the quoted message that supports it. The parsed schema allows
   at most 50 operations, and code keeps at most 12. Field bounds are subject 40, key 120, quote 2000, and value
   and summary each twice the 500-character fact limit.
7. **Validate.** Code checks each operation against the schema and against its quote. An operation that fails is
   rejected alone; it does not fail the batch. The quote rules:
   - The quote is found in the text of one user message of the episode, after both are normalised. AIRA's own
     lines, scheduled messages and attachment lines never count.
   - That message was written by the person the fact is about. A fact about the chat itself may quote anyone. A
     fact one member states about another member is rejected as `third_party`.
   - The quote has at least three words, and its message is not a question.
   - Every number in the value occurs in that message.
   - The key does not start with `note.` or `lingo.`.
   - A message a member already stored by hand with `note` is not extracted from again.
8. **Verify.** The judge model answers yes or no for each remaining operation. A no, a timeout or an error rejects
   that operation. The judge fails closed. Every judge request clips its state to the final 24,000 characters
   before it is sent.
9. **Apply.** All accepted operations for the job are applied in one transaction, each inside its own savepoint, so
   one that fails is rejected alone. A superseded fact keeps its row with status `superseded`. If a forget
   happened in this chat after the job started, the whole job is skipped and applies nothing.
10. **Record.** The job's outcome, counts and every rejection with its reason are written to `memory_event`.

Steps 4, 7 and 9 are code. Steps 5, 6 and 8 are model judgements with code deciding on their output.

- One worker processes one chat's jobs in order. Two jobs for one chat never run together. The worker leases one
  job per tick, closes due episodes first, and pauses while spend or the disk guard pauses background work.
- A failed job retries after 1, 5, 20 and 60 minutes. After the last retry it is marked `failed` and stays in the
  table with its error code, and the operator is alerted. It is never deleted silently.
- With no judge configured, or no judge key, nothing is admitted and `note` is refused: the judge fails closed.
- Extraction uses the deployment's main model and the judge thresholds. It waits while the spend cap or the disk
  guard pauses background work.
- An episode summary is at most 500 characters, and every number in it must occur in a quotable member message. It
  is stored only beside at least one accepted fact of the same job, after the judge confirms it.
- `memory_event` and a job's error hold reason codes only. They never hold message text, a fact's value or a
  model's words.

Code lives in `src/memory/episodes.ts`, `src/memory/worker.ts`, `src/memory/extract.ts`,
`src/memory/validate.ts`, `src/memory/store.ts` and `src/judge/systemone.ts`.

## Explicit Memory

The `note` tool writes one fact through steps 7 to 10, skipping admission. The judge verifies it before the tool
commits, against the member's own messages in this turn: the excerpt is those messages, and the operation names the
note's text. A turn with no message from that member stores no note. Its key is `note.` plus a random id. The message
that asked for the note is marked so that extraction does not store it a second time. The same text for the same
subject is stored once.

The `forget` tool marks one fact `forgotten`. It changes one fact per call, and only a call that names the fact by
its id, taken from a prior `recall`, removes anything. A call with words to search for removes nothing: it returns
the facts that match, with their ids, so the person can say which one.

A lingo word is stored under a key from its normalised form: a Latin word becomes lower-case letters and digits
joined with underscores, at most 40 characters; a word in another script becomes a truncated SHA-256 digest. The
stored value is the word's meaning. A repeated word with the same meaning returns the same row. A new meaning
replaces the old one, which becomes `superseded`.

Forgetting a fact also, in the same transaction:

- clears the value and replaces the key of that row, because a key can itself say the fact;
- clears the older versions of the same fact (rows of the same subject and key that are `superseded` or
  `retired`);
- forgets the episode summary that came from the same memory job;
- replaces the text of the window message that supported the fact with a marker.
- clears every stored quote of that message, because a quote is a copy of its text.

**Every forget is a barrier.** Whether or not it found a fact, a forget moves the chat's cursor to its newest
message, ends the chat's queued memory jobs as skipped, and increases the chat's forget counter. A job that is
already running reads the counter again when it applies, and applies nothing if it changed. So what was said
before a forget is never extracted after it. The cost is that other facts from those same messages are not
extracted either.

### What Forget Leaves

| Where                                                                      | Until                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| AIRA's own replies                                                         | The window's retention, `records.windowDays`                                    |
| Another message that said the same thing, and a summary of another episode | The window's retention; the summary stays until it is forgotten by its own fact |
| Local snapshots                                                            | `backup.keepDays`                                                               |
| The off-host copy                                                          | That repository's own prune horizon                                             |
| A restore from a snapshot                                                  | A restore from before the forget brings the fact back                           |

## Recall

![Recall for one turn: pinned facts, notes, ranked facts and episode summaries within the token budget, plus the recall and history tools](../diagrams/memory-recall.svg)

1. Pinned facts of this chat, about the chat itself or about the people present.
2. Facts a member stored by hand with `note`, then facts ranked by keyword match with the newest messages, recency
   and subject presence.
3. Episode and media summaries above the similarity floor.

Recall fills the memory part of prompt block 4 within `memory.recallTokenBudget`. The `recall` tool lets the model
search further within the same chat. The `recall` port names the asker as the person asking, and names everyone
else as another member.

Free-text search builds one full-text query: at most 12 distinct case-insensitive words of 2 or more letters or
digits, each in double quotes, joined with OR. A limit of zero, or a text with no usable word, searches nothing.

Turn recall orders pinned facts, then the newest 10 notes, then ranked facts, then summaries. It skips repeats,
and it estimates one token per three characters of each line. It stops before the first line that would exceed
the budget, so the returned lines always fit.

The `history` tool searches the chat's own window and its episode summaries. Window search is an escaped substring
match on message text, newest first. Episode matches come from the same chat-scoped search, filtered to episodes.
The two lists merge by time, newest first, up to the asked limit.

Code lives in `src/memory/recall.ts` and `src/memory/port.ts`.

## Lifecycle

![A fact's statuses and the forget barrier: what a forget clears and which queued and running jobs it stops](../diagrams/forget-barrier.svg)

| Status       | Entered By                     | Recalled                                     |
| ------------ | ------------------------------ | -------------------------------------------- |
| `active`     | An applied `add` or `update`   | Yes                                          |
| `upcoming`   | A stated future change         | Yes, marked as upcoming, until `valid_until` |
| `superseded` | A newer fact for the same key  | No                                           |
| `retired`    | Expiry, or a judged retraction | No                                           |
| `forgotten`  | The `forget` tool or command   | No                                           |

No row is deleted by normal operation. A `forgotten` row keeps its id and time, has its value cleared and its key
replaced.

An `upcoming` fact whose time has passed becomes `retired` when a job applies. Only `active` and `upcoming` facts
are recalled. Summaries are recalled while they are not `forgotten`.

## Migration

![The legacy memory import: export, backup and checksums, dry run, report, confirmed real run](../diagrams/memory-migration.svg)

The existing memory is migrated, never wiped (PRD FR-31).

1. **Export** a private copy of the old brain folder. Readers turn its per-chat `memories.jsonl` and `lingo.json`
   files into legacy NDJSON exports: one remembered thing per line, with `kind`, the WhatsApp ids `chat` and
   `subject`, `key`, `text` and `updatedAt`. `bun run export:memory --from <copy of the old brain folder> --out
<private folder>` runs the readers on a copy, never on the live folder, and prints counts only.
2. **Back up** the export folder the import will read, with SHA-256 checksums of every file. The runner does not
   read or back up the live legacy database or the original memory files: only what the export step wrote.
3. **Read** the export. A line that fails to parse is written to a reject file, not dropped. Empty and expired
   facts are counted as skipped, and are not added to that reject list.
4. **Dry run** into a scratch database and produce a report: kept, merged, rejected and unassigned, with reasons.
5. **Review** the report. The real run needs an explicit confirmation flag and the same input digest.
6. **Import** in one transaction. The old stores are left in place and untouched.

`bun run migrate:memory --from <folder>` is the dry run. Adding `--confirm` is the real run.

- **Two stages.** A reader per old store writes a legacy export: `.ndjson` files, one remembered thing per line,
  with `kind` (`fact`, `note` or `lingo`), the WhatsApp ids `chat` and `subject`, `key`, `text` and `updatedAt`.
  The import works on that export alone.
- **What the readers read.** Measured on the production host's layout, 16 Nov 2026. A chat's folder is
  `<dm|group>/whatsapp/<chat>`, where `<chat>` is the WhatsApp id with `@` written as `.`:

  | Old Store                                 | Becomes                                                                                                                                                                                                                                    |
  | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `memories.jsonl`, the per-chat fact files | A `fact` per line. The subject is `about_id` (bare digits read as a LID, Assumption A-9), else the chat itself in a DM, else none. The old facts have no slot, so each is kept as a note of its person. A fact past its `until` is skipped |
  | `lingo.json`, the per-chat state files    | A `lingo` per confirmed word: `key` is the word, `text` its meaning. An unconfirmed word is skipped                                                                                                                                        |

  Not read: the retired-fact and episode files, saved posts and transcripts (`sources/`, `transcripts/`), which
  are not memory about a person, and the shared library, which belongs to the lessons feature. The knowledge
  database is not read: it is an index rebuilt from the files. Per-chat state files other than memory and lingo
  belong to the settings migration below.

- **The chats come first.** A fact's chat must be in the new database, or it is `unassigned`. The settings
  migration, which creates the chats, runs before the memory import.
- **Never guessed.** A line with no chat, or a chat the new database does not hold, is `unassigned` and is never
  imported. A text over the value limit is rejected, not cut. A line with an unknown field is rejected, because
  the export schema is strict.
- **Merged.** The newest version of a slot stays active and the older ones are kept as `superseded`. The same text
  twice is stored once. A fact the new core already learned is never replaced by an old one.
- **Kept as a note.** A fact with no usable key is kept word for word as a note of its person, only when it has a
  subject. A lingo record whose word holds no letter or digit is rejected.
- **Guarded.** The real run refuses to start without a dry-run report of exactly the same input files, checked by
  digest. It runs with the core stopped, as the only process on the database. A second real run changes nothing.
- **Private.** The backup, the reject file, the review file and the reports go to a private folder on the data
  volume. The reports hold file names, line numbers and reason codes only. None of these files enters the
  repository.

Song, vocabulary and library notes belong to the lessons feature. They are migrated with that work, once its data
model is specified. See [Tools](tools.md#lessons-and-library).

### Settings Migration

![The legacy chat settings and bindings migration: plan, unmapped values, apply](../diagrams/settings-migration.svg)

The settings migration runs before the memory import, because the import needs the chats. It reads a private copy
of the old binding file and state files, plans every change, and applies the plan only when asked.

`bun run migrate:settings --from <private copy> --character <old personality>=<pack id> ...` is the dry run: it
prints the plan as counts and reasons, and writes nothing. Adding `--confirm` applies it in one transaction, with
the core stopped. A second real run changes nothing.

- **What it plans.** The chat rows with their WhatsApp ids and types from `bindings.yaml` and from state-file keys.
  The character from `defaults.personality` and from a binding's `personality`, through the command-line map. The
  `features.photos`, `language`, `features.lessons` and `muted` settings from the old bindings, `language.json`,
  `lessons.json` and `quiet.json`. A mute that has already expired is skipped. A mute with no end still holds.
- **What it counts and skips.** Unmapped personality names, phone-number bindings, `mode`, `permissions.agent`,
  `permissions.autofetch`, `models`, `faces.json` tones, the owner block, unreadable bindings or state keys, and
  every value the key's schema refuses. Each is a reason code in the report. Nothing is guessed.
- **What it keeps.** A value already set in the database stays. Applying a plan never replaces a setting that is
  already present.

Code lives in `src/migration/readers.ts`, `src/migration/legacy.ts`, `src/migration/memory-import.ts` and
`src/migration/settings-import.ts`.

## Per-Chat Switch

`features.memory` turns memory on or off for one chat, at any level of the settings hierarchy. It is on by default,
so a chat that never sets it behaves as before. `memory.enabled` in `config.yml` stays the master switch for every
chat. Live context has its own switch: see [Data](data.md#setting-keys) for `features.context` and
`memory.pageMessages`.

- **Off means no new episode closes.** The closer skips a chat whose resolved setting is false, so no memory job
  is queued for it. A settings change fences the old window: messages written while memory was off are excluded
  when the switch is turned back on. Messages still enter the window, because a reply needs them; they are never
  extracted.
- **Queued work still runs.** The worker does not re-check the switch before it processes an already queued job.
  It still checks the forget counter, the spend cap and the disk guard.
- **Off means nothing is recalled.** Recall returns no facts for the chat, and the prompt has no memory block.
- **`note` (`/remember`) is refused** with the pack's refusal line, and `/help` leaves out `/remember` and `/recall`.
- **Stored facts are kept, not used.** Turning memory off does not delete anything. The facts stay out of every
  prompt while the switch is off, and come back when it is turned on. `/forget` still works while it is off, so a
  member can remove a named fact either way. Deleting by switch would make a mistaken click lose data for good.
- **Turning it on** starts from the next message; messages sent while it was off are not extracted later.

## Configuration

| Key                         | Default      | Effect                                   |
| --------------------------- | ------------ | ---------------------------------------- |
| `memory.enabled`            | `on`         | Master switch for passive memory         |
| `memory.episodeIdleMs`      | 180000       | Idle time that closes an episode         |
| `memory.episodeMaxMessages` | 25           | Deployment fallback for the page size    |
| `memory.pageMessages`       | 25           | Per-chat messages that close an episode  |
| `memory.recallTokenBudget`  | 1200         | Size of recalled memory in the prompt    |
| `judge.model`               | `jev-latest` | The judge's model id. Empty: no judge    |
| `judge.memoryAdmit`         | 0.5          | Admission threshold                      |
| `judge.memoryVerify`        | 0.5          | Verification threshold                   |
| `judge.timeoutMs`           | Set on host  | Longest wait for one judge answer        |
| `embeddings.provider`       | `off`        | Embedding backend for episodes and media |

`memory.pageMessages` is a chat setting from 5 to 50. `llm.main.model` is the model that extracts operations.
`llm.monthlyBudgetUsd` pauses background work from 80 percent of the cap. Code paths are listed under [Write
Path](#write-path), [Recall](#recall) and [Migration](#migration).
