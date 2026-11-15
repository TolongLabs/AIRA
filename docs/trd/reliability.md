# Reliability

Who gets a turn, what stops one, how failures are contained, and how mute and quiet rules reach every delivery path.

## Turn Admission

Checked in this order at step 3 of a turn. The first failing check ends the turn with the stated outcome.

| #   | Check                                                            | Outcome When It Fails                              |
| --- | ---------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Chat is known and bound to a valid character                     | No reply. Failure record and operator alert.       |
| 2   | Sender is allowed in this chat                                   | No reply. Record only.                             |
| 3   | Group message is addressed to AIRA, or the chat is free response | No reply. No record beyond the gateway's.          |
| 4   | Scheduled turn, and the chat is muted or in quiet hours          | No send. Record with reason `muted` or `quiet`.    |
| 5   | One turn per chat                                                | The message joins the pending batch for that chat. |
| 6   | Spend cap                                                        | The pack's limit line.                             |

## Mute And Quiet

- Mute and quiet hours are settings. See [Data](data.md).
- **One function decides.** `mayDeliver(chat, kind, now)` is the only code that answers whether a message may be
  sent. Replies to a user message are always allowed. Proactive messages, reminders set by others and scheduled
  routines are blocked while muted or quiet.
- **It runs twice for scheduled turns:** at admission, and again immediately before the reply is returned, because a
  mute can arrive while the turn runs.
- A reminder a member set for themselves fires during quiet hours but not during a mute they set.

## Batching

Messages that arrive while a turn runs are held and merged into the next turn for that chat. Messages that arrive
within `turn.batchMs` of each other, before a turn starts, form one turn. A photo with no caption waits
`turn.mediaWaitMs` for a following text.

## Deadlines

| Limit                    | Default | Applies To                       |
| ------------------------ | ------- | -------------------------------- |
| `llm.turnDeadlineMs`     | 45000   | All model work in one turn       |
| `tools.defaultTimeoutMs` | 15000   | One tool call                    |
| `judge.timeoutMs`        | 1500    | One judge call on the reply path |
| `media.timeoutMs`        | 30000   | One media read                   |

When the turn deadline passes, the runner is cancelled and the turn ends with the pack's slow line. Nothing waits
without a limit.

## Containment

- A handler, a judge call, a media read or a memory job that fails is recorded and contained. It never ends the
  process.
- The core answers the gateway with a deliverable reply in every case. See [System](system.md#gateway-contract).
- Background work runs outside the reply path and cannot delay a reply.
- An uncaught exception is logged with the turn id, the turn ends with the pack's error line, and the process stays
  up.

## Start-Up And Shutdown

- Start-up validates `config.yml`, every character pack, the database schema and every chat's binding. A deployment
  fault stops start-up with one clear message. A fault in one pack or one chat disables that pack or chat only, and
  alerts the operator.
- The full start-up order, with the storage checks and the recovery pass, is in
  [Persistence](storage.md#start-up-sequence). A health endpoint reports ready only after all of it passes.
- On SIGTERM the core stops admitting turns, lets running turns finish up to `shutdown.graceMs`, releases its job
  leases and closes the database. See [Persistence](storage.md#shutdown).

## Operator Alerts

An alert is a message to the owner's own chat, sent through the gateway, plus a failure record. Alerts are rate
limited per kind. Kinds: invalid pack or binding, auth failure on a model role, breaker open, memory job failed
after its last retry, spend at 80% and 100%, migration or deploy health failure.

## Configuration

| Key                | Default | Effect                                 |
| ------------------ | ------- | -------------------------------------- |
| `turn.batchMs`     | 1500    | Window that merges quick messages      |
| `turn.mediaWaitMs` | 8000    | Wait for a caption after a bare photo  |
| `shutdown.graceMs` | 20000   | Time for running turns at shutdown     |
| `alerts.minGapMs`  | 900000  | Minimum gap between alerts of one kind |
