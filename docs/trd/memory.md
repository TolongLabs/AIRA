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
| `value`                    | The content                                                          |
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
2. **Close.** An episode closes after `memory.episodeIdleMs` without a message, or `memory.episodeMaxMessages`.
3. **Queue.** A job row is written to `memory_job`, and the chat's cursor moves to the last message the job
   covers, in one transaction. The queue lives in SQLite and survives a restart. The job holds the range and the
   count of its messages. A job that later finds fewer messages than it counted fails as `episode_pruned`: it
   never ends as done on a part of its episode.
4. **Precheck.** Code drops episodes that hold only greetings, reactions or AIRA's own lines.
5. **Admit.** The judge model answers whether the episode holds anything lasting. Below the threshold, the job ends.
6. **Extract.** The main model returns proposed operations as structured output: `add`, `update`, `supersede`,
   `retire`, each with its subject, key, value and the quoted message that supports it.
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
   that operation. The judge fails closed.
9. **Apply.** All accepted operations for the job are applied in one transaction, each inside its own savepoint, so
   one that fails is rejected alone. A superseded fact keeps its row with status `superseded`. If a forget
   happened in this chat after the job started, the whole job is skipped and applies nothing.
10. **Record.** The job's outcome, counts and every rejection with its reason are written to `memory_event`.

Steps 4, 7 and 9 are code. Steps 5, 6 and 8 are model judgements with code deciding on their output.

- One worker processes one chat's jobs in order. Two jobs for one chat never run together.
- A failed job retries after 1, 5, 20 and 60 minutes. After the last retry it is marked `failed` and stays in the
  table with its error code, and the operator is alerted. It is never deleted silently.
- `memory_event` and a job's error hold reason codes only. They never hold message text, a fact's value or a
  model's words.

## Explicit Memory

The `note` tool writes one fact through steps 7 to 10, skipping admission. The judge verifies it before the tool
commits. Its key is `note.` plus a random id. The message that asked for the note is marked so that extraction
does not store it a second time.

The `forget` tool marks one fact `forgotten`. It changes one fact per call, and only a call that names the fact by
its id, taken from a prior `recall`, removes anything. A call with words to search for removes nothing: it returns
the facts that match, with their ids, so the person can say which one.

Forgetting a fact also, in the same transaction:

- clears the value and replaces the key of that row, because a key can itself say the fact;
- clears the older versions of the same fact (rows of the same subject and key that are `superseded` or
  `retired`);
- forgets the episode summary that came from the same memory job;
- replaces the text of the window message that supported the fact with a marker.

**Every forget is a barrier.** Whether or not it found a fact, a forget moves the chat's cursor to its newest
message, ends the chat's queued memory jobs as skipped, and increases the chat's forget counter. A job that is
already running reads the counter again when it applies, and applies nothing if it changed. So what was said
before a forget is never extracted after it. The cost is that other facts from those same messages are not
extracted either.

### What Forget Leaves

| Where                     | Until                                                 |
| ------------------------- | ----------------------------------------------------- |
| AIRA's own replies        | The window's retention, `records.windowDays`          |
| Local snapshots           | `backup.keepDays`                                     |
| The off-host copy         | That repository's own prune horizon                   |
| A restore from a snapshot | A restore from before the forget brings the fact back |

## Recall

1. Pinned facts of this chat, about the chat itself or about the people present.
2. Facts a member stored by hand with `note`, then facts ranked by keyword match with the newest messages, recency
   and subject presence.
3. Episode and media summaries above the similarity floor.

Recall fills the memory part of prompt block 4 within `memory.recallTokenBudget`. The `recall` tool lets the model
search further within the same chat.

## Lifecycle

| Status       | Entered By                     | Recalled                                     |
| ------------ | ------------------------------ | -------------------------------------------- |
| `active`     | An applied `add` or `update`   | Yes                                          |
| `upcoming`   | A stated future change         | Yes, marked as upcoming, until `valid_until` |
| `superseded` | A newer fact for the same key  | No                                           |
| `retired`    | Expiry, or a judged retraction | No                                           |
| `forgotten`  | The `forget` tool or command   | No                                           |

No row is deleted by normal operation. A `forgotten` row keeps its id and time, has its value cleared and its key
replaced.

## Migration

The existing memory is migrated, never wiped (PRD FR-31).

1. **Back up** every existing memory file and database, with checksums.
2. **Read** the per-chat fact files, the knowledge database and the per-chat state files. Lines that fail to parse
   are written to a reject file, not dropped.
3. **Map** each fact to a chat and subject. A fact whose chat cannot be determined goes to a review file and is not
   imported.
4. **Dry run** into a scratch database and produce a report: kept, merged, rejected and unassigned, with reasons.
5. **Review** the report. The real run needs an explicit confirmation flag.
6. **Import** in one transaction. The old stores are left in place and untouched.

Song, vocabulary and library notes belong to the lessons feature. They are migrated with that work, once its data
model is specified. See [Tools](tools.md#lessons-and-library).

## Configuration

| Key                         | Default | Effect                                   |
| --------------------------- | ------- | ---------------------------------------- |
| `memory.enabled`            | `on`    | Master switch for passive memory         |
| `memory.episodeIdleMs`      | 180000  | Idle time that closes an episode         |
| `memory.episodeMaxMessages` | 25      | Message count that closes an episode     |
| `memory.recallTokenBudget`  | 1200    | Size of recalled memory in the prompt    |
| `judge.memoryAdmit`         | 0.5     | Admission threshold                      |
| `judge.memoryVerify`        | 0.5     | Verification threshold                   |
| `embeddings.provider`       | `off`   | Embedding backend for episodes and media |
