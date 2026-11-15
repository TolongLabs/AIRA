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
| `valid_until`              | Lapse time for an `upcoming` fact                                    |
| `created_at`, `updated_at` | Set by code                                                          |

- A partial unique index allows one `active` fact per `(chat_id, subject_id, key)`.
- CHECK constraints reject an unknown `kind` or `status`, and an empty `value`.
- `episode` and `media` rows carry an embedding in a side table. Facts are recalled by key and keyword.

## Scope

- Every read and write is filtered by `chat_id`. The data layer exposes no query without it.
- Inside one chat, facts about any member may be used in any member's turn.
- A fact never appears in another chat, including the same person's DM and group. The same person in two chats has
  two separate sets of facts.
- A WhatsApp phone id and its linked id for one person map to one `subject_id` through the `identity` table.

## Write Path

1. **Capture.** Each delivered turn appends its messages to `session_message`.
2. **Close.** An episode closes after `memory.episodeIdleMs` without a message, or `memory.episodeMaxMessages`.
3. **Queue.** A job row is written to `memory_job`. The queue lives in SQLite and survives a restart.
4. **Precheck.** Code drops episodes that hold only greetings, reactions or AIRA's own lines.
5. **Admit.** The judge model answers whether the episode holds anything lasting. Below the threshold, the job ends.
6. **Extract.** The main model returns proposed operations as structured output: `add`, `update`, `supersede`,
   `retire`, each with its subject, key, value and the quoted message that supports it.
7. **Validate.** Code checks each operation against the schema and checks that the quote exists in the episode. An
   operation that fails is rejected alone; it does not fail the batch.
8. **Verify.** The judge model answers yes or no for each remaining operation. A no, a timeout or an error rejects
   that operation. The judge fails closed.
9. **Apply.** All accepted operations for the job are applied in one transaction. A superseded fact keeps its row
   with status `superseded`.
10. **Record.** The job's outcome, counts and every rejection with its reason are written to `memory_event`.

Steps 4, 7 and 9 are code. Steps 5, 6 and 8 are model judgements with code deciding on their output.

- One worker processes one chat's jobs in order. Two jobs for one chat never run together.
- A failed job retries after 1, 5, 20 and 60 minutes. After the last retry it is marked `failed` and stays in the
  table with its error. It is never deleted silently.

## Explicit Memory

The `note` tool writes one fact through steps 7 to 10, skipping admission. The `forget` tool marks one fact
`forgotten`. It matches by id from a prior `recall`, or by an exact key. It never matches by a shared word, and it
changes one row per call.

## Recall

1. Pinned facts for the chat and for the people present.
2. Facts ranked by keyword match with the newest messages, recency and subject presence.
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

No row is deleted by normal operation. A `forgotten` row keeps its id and time and has its value cleared.

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

Song and vocabulary study notes belong to an optional feature. They are migrated only when that feature is in scope.

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
