# Reliability

Who gets a turn, what stops one, how failures are contained, and how mute and quiet rules reach every delivery path.

## Turn Admission

![Turn admission: arrival, replay, batching, queueing, claim, newest-only reply](../diagrams/turn-admission.svg)

Admission runs in two places. The per-chat queue serialises turns before a turn opens. Resolve and the checks
below run inside the turn, in this order. The first failing check ends the turn with the stated outcome.

| #   | Check                                                              | Outcome When It Fails                              |
| --- | ------------------------------------------------------------------ | -------------------------------------------------- |
| 1   | One turn per chat. The queue holds this rule before any turn opens | The message joins the pending batch for that chat. |
| 2   | Chat is known, active, and bound to a valid character              | No reply. Failure record and operator alert.       |
| 3   | Sender is allowed in this chat. Scheduled turns skip this check    | No reply. Record only.                             |
| 4   | Delivery allowed for its kind; replies and research always pass    | No send. Record with reason `muted` or `quiet`.    |
| 5   | Spend cap                                                          | The pack's limit line.                             |

- **Group addressing is the gateway's.** The core runs no mention, reply, or free-response check. The gateway
  forwards only addressed group messages, and the core answers every group message it receives. See
  [System](system.md#gateway-contract).

## Mute And Quiet

- Mute and quiet hours are settings. See [Data](data.md).
- **One function decides.** `mayDeliver(chat, kind, now)` is the only code that answers whether a message may be
  sent. Replies to a user message are always allowed. Proactive messages, reminders set by others and scheduled
  routines are blocked while muted or quiet.
- **It runs twice for scheduled turns:** at admission, and again immediately before the reply is returned, because a
  mute can arrive while the turn runs.
- A reminder a member set for themselves fires during quiet hours but not during a mute they set.
- Research deliveries always pass this check, like replies.

## Batching

One turn runs per chat. Messages that arrive while a turn runs wait in that chat's pending batch. The next turn
starts at once when the running turn ends: its messages have waited already.

- Before a turn starts, each new message restarts the batch timer. The wait ends `turn.batchMs` after the latest
  message, and at most three times `turn.batchMs` after the first pending message, however many keep arriving.
- One merged turn answers only its newest message. The reply goes to the newest request. The other merged requests
  get an empty reply, which the gateway seam sends as `NO_REPLY`. A repeat of one of them gets the same.
- A message that holds command-shaped text (`/name` at the start or after whitespace) is never merged. It runs as
  its own turn: the queue splits the pending batch before and after each command, and a turn claims only the
  messages up to its newest one.
- Attachments stay on their waiter in memory and are read after the batch starts. A restart answers from the stored
  text but loses the attachment reference. There is no photo-specific wait: `turn.mediaWaitMs` is accepted by the
  config schema but the turn pipeline does not read it.

### Repeat Requests

A repeated message id runs no second turn. The inbound row is keyed by chat and message id, so the same id is
inserted once. A repeat resolves like this:

| Repeat State | Outcome                                                                |
| ------------ | ---------------------------------------------------------------------- |
| Answered     | The stored reply, replayed.                                            |
| Dropped      | Empty, replayed.                                                       |
| Running      | Waits for that turn, then reads what it stored. Retried up to 3 times. |
| Otherwise    | Runs again as a retry.                                                 |

## Deadlines

| Limit                    | Default | Applies To                                                               |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `llm.turnDeadlineMs`     | 45000   | All model work in one turn                                               |
| `tools.defaultTimeoutMs` | 15000   | One tool call                                                            |
| `judge.timeoutMs`        | 1500    | One judge call on the reply path                                         |
| `media.timeoutMs`        | 30000   | One media read, at most two thirds of the time left in the turn deadline |
| `media.linkWatchMs`      | 12000   | All segment watches of one YouTube link, within the media timeout        |

When the turn deadline passes, the runner is cancelled and the turn ends with the pack's slow line. The runner has
its own per-turn deadline timer: it fires at the deadline, the run aborts with a transient failure, and the timer
is cleared in `finally`. Nothing waits without a limit.

## Containment

- A handler, a judge call, a media read or a memory job that fails is recorded and contained. It never ends the
  process.
- The core answers the gateway with a deliverable reply in every case. See [System](system.md#gateway-contract).
- Background work runs outside the reply path and cannot delay a reply.
- An uncaught exception is logged with the turn id, the turn ends with the pack's error line, and the process stays
  up.
- Storage that fails around a turn resolves an empty reply and sends nothing. Nothing was acknowledged, so no pack
  line is sent.

## Start-Up And Shutdown

- Start-up validates `config.yml`, every character pack, the database schema and every chat's binding. A deployment
  fault stops start-up with one clear message. A fault in one pack or one chat disables that pack or chat only, and
  alerts the operator.
- The full start-up order, with the storage checks and the recovery pass, is in
  [Persistence](storage.md#start-up-sequence). A health endpoint reports ready only after all of it passes.
- On SIGTERM the core stops admitting turns, lets running turns finish up to `shutdown.graceMs`, releases its job
  leases and closes the database. See [Persistence](storage.md#shutdown). Drain starts each queued batch at once,
  then waits for the running turns or the grace timeout.

## Operator Alerts

An alert is a durable JSON line appended to `alerts.jsonl` on the data volume, plus a failure record.
The operator reads this file; direct delivery to the owner's chat is not configured. Each line contains only the
alert kind and timestamp, never message text or identity. Alerts are rate limited per kind.
Spend alerts are raised when a recorded call crosses 80% or 100% of the monthly budget. Unmarked gateway
requests raise a binding alert. Start-up faults raise a deploy health alert when storage is available. Kinds: invalid pack or binding, auth failure on a model role, breaker open, memory job failed
after its last retry, spend at 80% and 100%, migration or deploy health failure.

## Configuration

| Key                  | Default             | Effect                                                        |
| -------------------- | ------------------- | ------------------------------------------------------------- |
| `turn.batchMs`       | 1500                | Window that merges quick messages                             |
| `shutdown.graceMs`   | 20000               | Time for running turns at shutdown                            |
| `alerts.minGapMs`    | 900000              | Minimum gap between alerts of one kind                        |
| `records.windowDays` | Set in `config.yml` | Window rows older than this are not read                      |
| `maxWindowMessages`  | 40                  | Cap on window rows read per turn; the app leaves this default |

Code lives in `src/turn/pipeline.ts` (queueing, admission, batching, deadlines), `src/turn/deliver.ts` (the
delivery rule), `src/turn/window.ts` (claims and reads), and `src/storage/turns.ts` (inbound rows, open and close).
Window mechanics (claims, ordering, replay of merged messages) are owned by
[System](system.md#gateway-contract).
