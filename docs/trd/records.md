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

![Turn record lifecycle: stage stamps and child rows written during a turn, then retention pruning and operator reads](../diagrams/turn-record.svg)

The writers live in `src/records/turn-record.ts`: `markStage`, `updateTurnRecord`, `recordModelCall`,
`recordToolCall`, `recordFailure` and `saveDiagnostics`.

## Child Records

Each redacted social lookup row belongs to one parent and ordinal. In `social_turn_lookup`, automatic
intake uses the turn ID and `read_post` uses the exact `tool_call.id`. Group autofetch uses the job ID
in `social_lookup`.
The row carries bounded reader attempts, a missing-field bitset, elapsed time, outcome, and a reason code.
Metrics write failures leave the surrounding read and its parent result available.

For eligible group platforms, core records the verified video duration in one of five bands: at most 60,
over 60 through 120, over 120 through 180, above 180 seconds, or unknown. Boundaries use unrounded seconds. These bands measure
the effect that proposed limits would have on candidate videos.

A duration-policy skip records its reason and does not increment the failed-file count.
Group selection and download counts are distinct from the returned slots and their gateway confirmations.
A file counts as delivered only after the adapter reports success. Missing reports and legacy `sent` outcomes
leave delivery unknown. Core stores ordered slot kinds and acknowledgements in `autofetch_delivery` and
ignores duplicate reports.

| Table            | One Row Per                   | Key Fields                                                                  |
| ---------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `model_call`     | Request to any model role     | `turn_id`, role, model, attempt, duration, tokens, cost, failure kind       |
| `tool_call`      | Tool or command call          | `turn_id`, tool, source (`model`, `command`), duration, outcome, receipt id |
| `failure`        | Failure of any kind           | `turn_id` or job id, stage, kind, message, stack, handled-by                |
| `memory_event`   | Memory job and each operation | Job id, chat, step, accepted or rejected, reason                            |
| `job_run`        | Scheduled or background run   | Job kind, chat, started, ended, outcome                                     |
| `setting_change` | Change to a setting or pack   | Who, when, level, key, old and new value                                    |

Every feedback poll writes one `job_run` row with kind `feedback_sync`, including a no-row success and a failed
request. A rejected form row also writes one `failure` row without storing its answer text.

A file the core could not read is a handled failure: one `failure` row of kind `media_unreadable`, stage `media`, and one
`model_call` row of role `media` for each request to the media model. See [Media Records](media-pipelines.md#media-records),
including YouTube URL attempts and final-gap rules.

A `failure` row is written for handled failures too. A retry that succeeds still leaves the failed attempt on record.
The pipeline receives each attempt even when the runner throws. Each failed attempt keeps its redacted error in a
`failure` row, handled by `retry`, `fallback`, or the final pack line. Failed turns keep model routing and attempt
counts too. A spend write failure keeps the reply, emits a warning and records a `storage_error` failure.

Link media download failures log the platform, expected media type and a reason code. For a download
refusal, the code carries the HTTP status. The URL, headers and response body stay out of the log.

## Failure Kinds

One list, used by records, alerts and tests: the model kinds in [Models](models.md#failure-kinds), plus
`tool_timeout`, `tool_error`, `tool_refused`, `judge_unavailable`, `media_unreadable`, `memory_rejected`,
`persona_leak`, `memory_job_failed`, `config_invalid`, `binding_invalid`, `gateway_malformed`, `gateway_unmarked`, `turn_interrupted`, `storage_error`,
`storage_low_space`, `backup_failed`, `feedback_rejected`, `feedback_sync_failed`, `internal`.

The list lives in `src/records/kinds.ts`. Alert delivery follows the Deployment decisions.

## Logs

- Structured JSON lines on standard output, collected by the container runtime with rotation.
- Every line has: time, level, module, event name. It carries `turn_id` or `job_id` only when the call's context
  or fields supply one. The logger lives in `src/records/logger.ts`.
- Errors are serialised with name, message and stack. A test checks that an error passed to the logger is not lost.
- Levels: `error` for a failure that reached a user or lost work, `warn` for a handled failure, `info` for one line
  per stage, `debug` for detail that is off in production.
- Feedback logs hold only the report id, state and answer length. They never hold an answer, reference or form URL.

An unknown-host social path match logs the platform and hostname. Paths and queries stay out of the log.

### Host CLI Operations

The host CLI logs before an install exists in `$XDG_STATE_HOME/aira/operations.jsonl` (fallback
`~/.local/state/aira/operations.jsonl`), mode 0600 under a private directory. Concurrent append and rotation
are serialized. Keep the active log and at most four rotated files, each at most 2 MiB. Event fields are
UTC timestamp, level, component (setup, cli, core, gateway, update), operation ID, stage, stable reason,
outcome, attempt, duration, retryability, safe image/build metadata and a safe message. Do not log child
process output, request bodies, credentials, raw environment, chat identities, names or message content.
Record failures even if retry succeeds. Durable deploy/audit records keep their existing retention contract.
The component reader outputs bounded normalized redacted events; a missing source is not a healthy result.
No external telemetry or automatic diagnostic upload.

## Redaction

- WhatsApp ids and phone-like strings are replaced with stable hashes. Configured secrets are masked. Anything
  else, including message text and names, passes through unchanged.
- Tool arguments are logged by shape (keys and types), not by value.
- The default logger redacts every value found in `process.env`, not only `.env` entries. A value shorter than 6
  characters is not masked, so a short secret is not safe to rely on. Redaction lives in `src/records/redact.ts`.

Verbatim text is kept in three places only:

| Store                 | Holds                                                     | Retention                  |
| --------------------- | --------------------------------------------------------- | -------------------------- |
| `session_message`     | The conversation window the bot needs to work             | `records.windowDays`       |
| `failure_diagnostics` | The request and reply of a failed turn, for a post-mortem | `records.diagnosticsHours` |
| `feedback_report`     | Zod-checked answers submitted through the feedback form   | `records.feedbackDays`     |

## Retention

A daily job prunes by table. Start-up checks the newest successful `retention` run and prunes immediately when
none exists or it is at least 24 hours old. An hourly check repeats this decision, with no overlapping runs.
Each attempt opens a `job_run` row before work and closes it with its outcome, including failures. Defaults: turn and child records 90 days, diagnostics 72 hours, window messages 7
days, setting changes kept. Pruning writes its own `job_run` row with counts. Rows are exported to the archive before
they are deleted. See [Persistence](storage.md#analytics-and-the-archive).

Two rows never fall to the cutoff. A turn whose state is `running` is kept, and the newest `session_message` row
always stays: it is the high-water mark the memory cursors count from, and an empty window table would hand out the
same ids again. `pruneRecords` in `src/records/retention.ts` takes an optional `beforeDelete` callback, called inside
the same transaction with each table's rows before deletion, so an archive job can export them first.

Feedback answers are the exception to archival. The daily job marks unused references expired after
`feedback.refTtlHours` and sets `answers` to null `records.feedbackDays` after receipt. Answers never enter Parquet.
SQLite `secure_delete` applies when answers are cleared in the live database. Database snapshots
follow their own retention schedule. The referenced turn metadata follows the turn-record policy. When a turn is
pruned, stored tool results and receipts keep their call ids with their turn links cleared. The newest window row keeps
its cursor id. If it is a user message with a turn link, that turn stays until a newer row arrives, so the message does
not become pending again.

## Operator Views

- `scripts/turn.ts <turn_id>` prints one turn: stages, model calls, tool calls, failures, in time order.
  It reads through `readTurn` in `src/records/turn-view.ts`, which returns the turn with its child rows ordered by time.
- `scripts/report.ts` prints latency percentiles by turn kind, failure counts by kind, cost, and fallback rate for a
  date range. `buildReport` in `src/records/report.ts` reads the newest filename-matching snapshot that passes a
  `quick_check`, unions it with any Parquet archive files, and never opens the live database.
- The site's dashboard page shows the same figures. See [Owner Site](site.md).
- `bun run feedback <report_id>` reads one report's answers beside the turns named by `turn_ids`. The protected
  `GET /api/feedback/:id` route returns the same maintainer view. Neither view returns the opaque reference. There is
  no owner-site feedback page in this change.

## Configuration

| Key                        | Default | Effect                           |
| -------------------------- | ------- | -------------------------------- |
| `records.retentionDays`    | 90      | Turn and child records           |
| `records.diagnosticsHours` | 72      | Verbatim failed-turn diagnostics |
| `records.windowDays`       | 7       | Conversation window messages     |
| `records.feedbackDays`     | 90      | Submitted feedback answers       |
| `log.level`                | `info`  | Minimum log level                |

## Code

| Area                           | Code                                                |
| ------------------------------ | --------------------------------------------------- |
| Turn and child record writers  | `src/records/turn-record.ts`                        |
| Failure kinds                  | `src/records/kinds.ts`                              |
| Structured logs                | `src/records/logger.ts`                             |
| Redaction                      | `src/records/redact.ts`                             |
| Retention pruning              | `src/records/retention.ts`                          |
| Turn view and aggregate report | `src/records/turn-view.ts`, `src/records/report.ts` |
