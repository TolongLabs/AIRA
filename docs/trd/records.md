# Records

What AIRA writes down about every turn and every failure, so a fault can be explained afterwards without guessing.

## Principles

- **One id joins everything.** Every turn has a `turn_id`. Every log line, tool call, model call, memory job and
  failure that belongs to it carries that id.
- **Records are rows, logs are lines.** Facts needed for a post-mortem go in SQLite tables. Logs add detail and are
  not the only copy of anything important.
- **Real numbers.** Token counts and costs come from the provider's response, never from an estimate.
- **Redacted by default.** See [Redaction](#redaction).

## Turn Record

One row in `turn`, opened at step 1 and closed at step 8.

| Group    | Fields                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------ |
| Identity | `turn_id`, `chat_id`, `sender_id`, `character_id`, kind (`reply`, `command`, `scheduled`)        |
| Timing   | Arrival, received, admitted, built, model done, cleaned, returned. One duration per stage        |
| Prompt   | System token count, window size, recalled item ids, mood, mood source, shape seed, length bypass |
| Model    | Transport, role, model id, attempts, input, output and cached tokens, cost                       |
| Outcome  | `delivered`, `declined`, `muted`, `failed`, with the failure kind                                |
| Delivery | Reply length, bubble count, sticker id, attachments, receipts                                    |
| Cleaning | Which cleaning steps changed the text                                                            |

`arrived_at` is the oldest inbound arrival in the batch; `received_at` is when the turn opens. `queue_ms` spans
arrival to turn open. `media_ms` measures intake reads and `tool_ms` sums tool call durations. These are parts of
stage time, not extra time to add. `total_ms` spans arrival to core return, including batching and queue waits.
Stage stamps persist as stages finish; timing totals commit with turn close and appear on `turn.returned`.
Direct commands stamp built and model done too. The non-streaming clients have no first-byte timing contract.
Gateway delivery happens after core return and is outside these timings. Reports use arrival, falling back to turn
open for older records.

## Child Records

| Table            | One Row Per                   | Key Fields                                                                  |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `model_call`     | Request to any model role     | `turn_id`, role, model, attempt, duration, tokens, cost, failure kind       |
| `tool_call`      | Tool or command call          | `turn_id`, tool, source (`model`, `command`), duration, outcome, receipt id |
| `failure`        | Failure of any kind           | `turn_id` or job id, stage, kind, message, stack, handled-by                |
| `memory_event`   | Memory job and each operation | Job id, chat, step, accepted or rejected, reason                            |
| `job_run`        | Scheduled or background run   | Job kind, chat, started, ended, outcome                                     |
| `setting_change` | Change to a setting or pack   | Who, when, level, key, old and new value                                    |

A file the core could not read is a handled failure: one `failure` row of kind `media_unreadable`, stage `media`, and one
`model_call` row of role `media` for each request to the media model. See [Models](models.md#media-watching).

A `failure` row is written for handled failures too. A retry that succeeds still leaves the failed attempt on record.
The pipeline receives each attempt even when the runner throws. Each failed attempt keeps its redacted error in a
`failure` row, handled by `retry`, `fallback`, or the final pack line. Failed turns keep model routing and attempt
counts too. A spend write failure keeps the reply, emits a warning and records a `storage_error` failure.

## Failure Kinds

One list, used by records, alerts and tests: the model kinds in [Models](models.md#failure-kinds), plus
`tool_timeout`, `tool_error`, `tool_refused`, `judge_unavailable`, `media_unreadable`, `memory_rejected`,
`memory_job_failed`, `config_invalid`, `binding_invalid`, `gateway_malformed`, `gateway_unmarked`, `turn_interrupted`, `storage_error`,
`storage_low_space`, `backup_failed`, `internal`.

## Logs

- Structured JSON lines on standard output, collected by the container runtime with rotation.
- Every line has: time, level, `turn_id` or job id, module, event name.
- Errors are serialised with name, message and stack. A test checks that an error passed to the logger is not lost.
- Levels: `error` for a failure that reached a user or lost work, `warn` for a handled failure, `info` for one line
  per stage, `debug` for detail that is off in production.

## Redaction

- Message text, names, phone numbers and WhatsApp ids are replaced with stable hashes in logs and in every record
  table except the two below.
- Tool arguments are logged by shape (keys and types), not by value.
- Keys and tokens are never logged. The logger masks any value read from `.env`.

Verbatim text is kept in two places only:

| Store                 | Holds                                                     | Retention                  |
| --------------------- | --------------------------------------------------------- | -------------------------- |
| `session_message`     | The conversation window the bot needs to work             | `records.windowDays`       |
| `failure_diagnostics` | The request and reply of a failed turn, for a post-mortem | `records.diagnosticsHours` |

## Retention

A daily job prunes by table. Defaults: turn and child records 90 days, diagnostics 72 hours, window messages 7
days, setting changes kept. Pruning writes its own `job_run` row with counts. Rows are exported to the archive before
they are deleted. See [Persistence](storage.md#analytics-and-the-archive).

## Operator Views

- `scripts/turn.ts <turn_id>` prints one turn: stages, model calls, tool calls, failures, in time order.
- `scripts/report.ts` prints latency percentiles by turn kind, failure counts by kind, cost, and fallback rate for a
  date range.
- The site's dashboard page shows the same figures. See [Owner Site](site.md).

## Configuration

| Key                        | Default | Effect                           |
| -------------------------- | ------- | -------------------------------- |
| `records.retentionDays`    | 90      | Turn and child records           |
| `records.diagnosticsHours` | 72      | Verbatim failed-turn diagnostics |
| `records.windowDays`       | 7       | Conversation window messages     |
| `log.level`                | `info`  | Minimum log level                |
