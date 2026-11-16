# System Architecture

How the processes fit together, what the gateway and the core promise each other, and one turn from message to reply.

## At a Glance

| Item         | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| Core         | One TypeScript service on Node 24, in one container                                     |
| Transport    | Hermes Agent gateway and its WhatsApp bridge, on the host, unchanged                    |
| Attach Point | OpenAI-compatible HTTP endpoint on `127.0.0.1:9881`                                     |
| Store        | One SQLite file on a mounted data volume                                                |
| Model Loop   | Google Agent Development Kit (API runner) or the `claude` program (subscription runner) |
| Judge Model  | A hosted small model for mood, memory admission and memory verification                 |

## Processes

![System overview: WhatsApp reaches the Hermes gateway, which calls the AIRA core; the core uses one SQLite file and the model services; the owner site calls the core's API](../diagrams/system-overview.svg)

- **Gateway:** receives and sends WhatsApp messages, keeps its sessions, and runs its cron. It calls the core as its
  model. Its fallback provider list is empty.
- **Core:** owns the turn. It resolves the chat, builds the prompt, runs the loop, cleans the reply and returns it.
- **Host Runner Service:** exists only when the subscription transport is selected. It runs the `claude` program on
  the host with the owner's login and exposes it to the core on a loopback port. See [Models](models.md).
- **Owner Tools:** market alerts, news digest, session notices and file sending keep running as they do today.

## Gateway Contract

The gateway calls `POST /v1/chat/completions` on the core. The shapes below were measured on the pinned, patched
gateway with a fake bridge and a fake core (spikes S-1 to S-3, 16 Nov 2026).

| Direction | Field                        | Meaning                                                                                                                                   |
| --------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Request   | Headers                      | OpenAI client headers only. No chat, sender or message id travels in a header.                                                            |
| Request   | Scope marker                 | `[HERMES-SCOPE v1 platform= kind= chat= sender= mid=]` before each user message's text, with `qid=` added when the message quotes another |
| Request   | `messages`                   | The gateway's transcript. The core reads only the newest user content from it.                                                            |
| Request   | `stream`                     | `true` for a chat turn, with `stream_options.include_usage`. The core answers in the shape asked for                                      |
| Request   | `tools`, system message      | The gateway's own prompt and tool schemas. The core ignores both, except that `tools` tells a turn from a chore                           |
| Response  | `choices[0].message.content` | The cleaned reply text, with bubble breaks and attachment lines, or `NO_REPLY`. See below                                                 |
| Response  | HTTP status                  | Always 200 with a deliverable reply. Failures become an in-character line.                                                                |

Each request is one of four kinds, decided in this order (measured on the staging gateway, 16 Nov 2026):

| Kind      | Recognised By                                                | The Core Does                                                                |
| --------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Auxiliary | No `tools`, whatever the text holds                          | Fixed short text. No model call, no turn record                              |
| Chat turn | `tools` and a scope marker in the newest user content        | Runs a turn                                                                  |
| Scheduled | `tools`, no marker, and the core's scheduled tag in the text | Runs a scheduled turn. See [Scheduled Turns](#scheduled-turns)               |
| Unmarked  | `tools`, no marker and no tag                                | `NO_REPLY`, no model call, a `gateway_unmarked` record and an operator alert |

- **Identity comes from the scope marker.** The gateway's scope stamp patch writes it when `WHATSAPP_SCOPE_STAMP=1`.
  It is off on the live gateway today and is switched on at cutover. The marker's `mid` is the gateway message id
  that keys `inbound_message` in [Persistence](storage.md).
- **Earlier unanswered messages ride along.** After a failed turn the gateway keeps the user's message, with its own
  marker, and puts it before the next one, separated by a blank line. The text after each earlier marker is an
  earlier message from the same sender that got no reply.
- **Gateway notes are removed.** On a chat's first message the gateway appends a `[System note: ...]` block to the
  user text. The core strips every such block before the text enters a turn.
- **Quotes and media are notes before the marker.** The gateway writes what it knows about a message as bracketed
  notes just before that message's marker. The core takes them out of the message text and keeps what they carry:

  | Note Starts With                                                           | Carries                                                                   |
  | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | `[Replying to: "`                                                          | The quoted text, at most 500 characters. `qid` is its id                  |
  | `[Replying to your previous message: "`                                    | The same, for a message AIRA sent                                         |
  | `[The user sent an image~`, `[The user sent an image but`                  | The picture's path on the host, after `image_url:`                        |
  | `[The user sent a voice message`                                           | The voice note's path on the host, when the gateway did not transcribe it |
  | `[The user sent an audio file`, `a video`, `a document`, `a text document` | The file's path on the host, after `saved at:`                            |

  The quote is stored with its message in `session_message` (`quote`, `quote_mid`, `quote_of_aira`), never in the
  message text: memory and mood read the text only, so a quoted member's words never count as the sender's. The
  model sees it as a labelled block before that message, `<quoted from="aira|member" untrusted="true">...</quoted>`.
  A voice note the gateway transcribed arrives as one quoted line, `"<transcript>"`, before a marker followed by no
  text. That line is the message text. The image description the gateway writes is the core's own auxiliary answer,
  so the core ignores it. Media is read by the core at intake, and only from a path under the gateway's media cache
  folders: a note is text, and an earlier message's text could imitate one. See [Models](models.md#media-watching).

- **Auxiliary requests.** The gateway also calls the same endpoint for its own chores: a session title, a context
  summary, a picture description. Such a request has no `tools`. Its text can hold markers, because a title or a
  summary request quotes the transcript. The core answers it with a short fixed text, makes no model call and writes
  no turn record.
- **Unmarked requests.** A request with `tools` and no marker comes from the gateway's own background work, such as
  its skill review, or from a gateway with the scope stamp off. The core sends nothing to the chat and records it, so
  a stamp that is off shows in the records and alerts on the first turn. At cutover the gateway's skill review is
  switched off (`skills.creation_nudge_interval: 0`).
- **Attachments are lines in the content.** Each attachment is one `MEDIA:<path>` line at the end of the content. The
  path is the file's path on the host, under `gateway.hostDataDir`, because the gateway reads it there. The gateway
  sends attachments after every text bubble. Stickers are in [Prompt Engine](prompt-engine.md#stickers).
- The core keeps its own conversation window in SQLite. It does not trust the gateway's transcript for history,
  because the gateway compresses and rewrites it. A user message is stored in the window, with its message id, in
  the transaction that records its arrival. A turn claims the messages it answers when it opens, and its reply is
  ordered after them. So a message that arrives while a turn runs is answered by the next turn, and a turn that was
  interrupted leaves its messages for the turn that runs again.
- **A marker in message text changes nothing.** Message text is the user's, so it can hold a forged marker. When
  the newest user content holds more than one marker, all of them must name the same platform, kind, chat and
  sender, or the request is refused. A forged marker can then change only the forger's own message id.
- **No reply is `NO_REPLY`.** When a turn ends with nothing to send (a sender who is not allowed, a muted scheduled
  turn, a chat that is not switched on, a merged request whose reply went with the newest one), the content is
  exactly `NO_REPLY`. The gateway sends nothing for it. Empty content is never returned: the gateway reads it as a
  failed model, asks 3 more times, then sends its own "No reply" notice to the chat. Measured.
- **Group addressing is the gateway's.** The request does not say whether a group message mentions AIRA or replies
  to it. The gateway forwards a group message only when it mentions AIRA, replies to AIRA, or the chat is set to free
  response, and only from an allowed group. So the core treats every group message it receives as addressed.
  Measured with all five cases.
- The core never returns an error status for a model or tool failure. An error status is reserved for a request the
  core cannot parse, which is a deployment fault.

### Scheduled Turns

Reminders are jobs the gateway's schedule fires. The core never calls the gateway to make one: it writes the jobs
it wants to a file, and a host reconciler makes the gateway's schedule match.

- **The core writes the wanted jobs.** At start-up and after every reminder change, the core writes its active
  reminders to `gateway/schedule.json` on the data volume, atomically: per reminder its id, the chat's WhatsApp id and
  its next due time. The reminder's text is never in the file or in a gateway job.
- **The reconciler makes them so.** `deploy/gateway/schedule.py` runs every minute on the host, in the gateway's own
  environment, and changes jobs only through the gateway's `cron.jobs` functions and their lock. Each wanted reminder
  is one one-time job named `aira:<reminder>:<due>`, whose text is the tag
  `[AIRA-SCHEDULED v1 kind=reminder id=<reminder> due=<due>]`, with the due time in UTC as `YYYYMMDDTHHMMSSZ`. It creates the missing ones and removes `aira:` jobs no longer
  wanted. A missing or unreadable file changes nothing. A due time already past is scheduled one minute ahead.
- **A set or cancel takes effect within a minute.** A job that still fires after a cancel finds its reminder
  cancelled and sends nothing.

When a job is due, the gateway calls the same endpoint. Measured with a one-time job, 16 Nov 2026:

- The request has `tools`, is not streamed, and carries **no scope marker**: the scope stamp runs only on incoming
  WhatsApp messages.
- The newest user content is the gateway's `[IMPORTANT: You are running as a scheduled cron job. ...]` block, a blank
  line, then the job's text unchanged.
- The gateway delivers the reply to the job's chat. `NO_REPLY` or `[SILENT]` sends nothing.
- The gateway wraps a delivered reply in a "Cronjob Response" header and footer unless `cron.wrap_response` is
  `false`. It is `false` on the live gateway. Cutover checks it.

The core then does this:

- **Only an unmarked request can be scheduled.** The tag is honoured only in a request with tools and no scope
  marker, which only the gateway's schedule sends. A member who types a tag sends an ordinary message.
- **Identity comes from the reminder row.** The tag names a reminder and the firing's due time, nothing else. The
  chat, the owner and the target come from the core's row. A tag whose reminder is not `active`, or whose due time is
  not the row's, is an unmarked request: a job left over from a cancel or an earlier time sends nothing.
- **A firing is used up once.** The transaction that stores the firing as an inbound message, keyed by reminder and
  due time, also marks a one-time reminder `fired` or moves a repeating one to its next due time. A repeated request
  is answered from that row. A turn that fails is not tried again: a late reminder would come out of order.
- The scheduled turn's user message is written by code from the row: the tag, then the reminder's text.
- The core applies mute and quiet rules to a scheduled turn like any other turn. See [Reliability](reliability.md).

### Gateway Jobs

The owner's routines (a daily lesson, a commute check) are jobs set up in the gateway's schedule, outside the core.
The core runs them as turns in their chat, with the bound character and the chat's tools.

- **A job is listed, then tagged.** `gateway.jobs` in the host's `config.yml` lists each job the core runs: the job's
  id and the WhatsApp id of the chat it belongs to. The repository's file lists none. `deploy/gateway/jobs.py --tag`
  puts the line `[AIRA-SCHEDULED v1 kind=job id=<job id>]` first in each listed job's text, through the gateway's
  `cron.jobs` functions and their lock; `--untag` takes it out. Cutover tags, rollback untags.
- **Identity comes from the list.** A job tag is honoured only in an unmarked request, like a reminder's. The chat
  comes from `gateway.jobs`, never from the text. An id that is not listed, or whose chat is not active, is an
  unmarked request and sends nothing.
- **The turn.** The job's text, without the gateway's block and the tag, is stored in the chat's window as an
  instruction from the schedule, sender `routine`, behind the tag. Memory never reads it as a member's words. The
  reply is a `routine` delivery: mute and quiet hours hold it back.
- **One firing, one turn.** The firing's message id is the job id and the 10-minute window it arrives in, so the
  gateway's repeated requests for one firing are answered from the stored reply. No job of the owner's runs more
  often than hourly.

### When the Core Is Slow or Down

| Case                           | What the Gateway Does (Measured)                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused             | Retries the identical request, 6 attempts in two rounds of 3, then sends the failure line. About 22 s                                     |
| Connection dropped mid-request | Same: 6 identical requests with the same `mid`, then the failure line. About 35 s to 50 s                                                 |
| Error status 500               | 3 identical requests, then the failure line                                                                                               |
| No answer                      | Waits up to its read timeout of 1,800 s. The core's own turn deadline must end the turn long before                                       |
| Every attempt failed           | Sends one line from the helper module `brain.failure` (see [Gateway Helper Modules](#gateway-helper-modules)), quoting the user's message |

- A restarted core that is back within the retry window receives the same request again and answers it once, by the
  rules in [Persistence](storage.md#interrupted-turns).
- The core never sends a late reply on its own. The bridge's loopback `POST /send` route would allow it, but by then
  the gateway has sent the failure line, and a late reply would arrive out of order.

### Gateway Helper Modules

Three gateway patches import a small Python module by name from `HERMES_HOME/scripts`. Today that folder is the old
core's code. AIRA ships its own versions in `deploy/gateway/brain/` and installs them over the old ones at cutover,
keeping the originals for rollback.

| Module          | Used By Patch                           | AIRA's Version Does                                                                                                            |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `brain.bubbles` | `aira-bubbles`, `aira-bubble-interrupt` | Splits the content at the core's bubble breaks only, returns the typing pause per bubble, and keeps the "wait" or "stop" check |
| `brain.failure` | `aira-failure-line`                     | Returns the unavailable line the core last wrote to `<hostDataDir>/gateway/unavailable.txt`, or a fixed neutral line           |

- **Only these two files are replaced.** The other `brain` modules some patches import stay as they are. The patches
  call `for_chat`, `typing_pause`, `is_interrupt` and `receipts_of` in `brain.bubbles`, and `for_failed_turn` and
  `for_exception` in `brain.failure`. Each name keeps its signature.
- **Bubbles do not depend on the chat.** After cutover the core answers every chat and splits every reply itself, so
  `for_chat` reads no binding. A reply with no break line is one message.
- **An interrupt drops the rest.** When a member writes only "wait" or "stop" while bubbles go out, the bubbles not
  yet sent are dropped, receipt lines included. The turn record keeps every receipt.
- **The failure line finds the data volume by `AIRA_HOST_DATA_DIR`** in the gateway's `.env`, set at cutover. Unset,
  or with no readable line, the chat gets the fixed neutral line. Raw error text never reaches a chat.
- The modules are Python's standard library only, for the gateway's Python 3.11. Their tests run in `bun run test`.

Both versions were run on the staging gateway code with a fake bridge: three bubbles went out in order with typing
pauses, and a refused connection produced the fixed line.

## Tech Stack

| Layer           | Choice                                                       |
| --------------- | ------------------------------------------------------------ |
| Language        | TypeScript, strict mode, ES modules                          |
| Runtime         | Node 24                                                      |
| Package Manager | Bun (**Assumption A-1**)                                     |
| Model Loop      | `@google/adk` for the API runner                             |
| Validation      | Zod for every config file, card, tool schema and model reply |
| Store           | SQLite through `better-sqlite3`, WAL mode                    |
| HTTP            | A small server for the gateway endpoint and the site API     |
| Logs            | Structured JSON lines with redaction                         |
| Tests           | Vitest, in the layers defined in [Test Harness](harness.md)  |
| Lint and Format | Biome and Prettier, commit messages checked by commitlint    |
| Analytics       | DuckDB, for report and benchmark scripts only                |
| Off-Host Backup | An encrypted, deduplicated backup tool on a timer            |
| Site            | React, Vite and Tailwind, as the site uses today             |

## Repository Layout

```
config.yml              deployment settings, reviewed in git
.env.example            names of every secret, no values
characters/example/     one example character pack; real packs live on the data volume
prompts/                harness prompt blocks shared by all characters
src/
  gateway/              the OpenAI-compatible endpoint and delivery mapping
  turn/                 turn context, admission, the turn pipeline
  character/            pack schema, loader, validator
  prompt/               block assembly, mood detection, reply shape
  format/               cleaning chain, WhatsApp renderer, bubble splitter
  tools/                registry, handlers, command parser, MCP client
  memory/               items, write queue, judge calls, recall, forget
  models/               runners, transports, routing, spend
  records/              turn records, failure records, logger
  settings/             hierarchy resolver, validation, change log
  storage/              database, migrations
  api/                  site API for chatbot pages
site/                   the revamped owner site
scripts/                migration, replay, benchmark, operator tools
tests/                  unit tests and the harness
docs/                   PRD, TRD, runbook, decisions, guides
deploy/                 Dockerfile, compose file, host units
```

## One Turn

![Message path: resolve the chat, build the turn, run one agent loop, clean and format, then reply](../diagrams/message-path.svg)

1. **Receive.** The gateway posts the request. The core assigns a turn id and writes the opening turn record.
2. **Resolve.** Code maps the session id to a chat, resolves its settings through the hierarchy, and loads the bound
   character pack. A broken binding stops the turn with a record and an operator alert. See [Data](data.md).
3. **Admit.** One turn runs per chat. Mute, quiet hours, permissions and the spend cap are checked here. See
   [Reliability](reliability.md).
4. **Command Check.** If the text starts with a registered `/name`, the command handler runs and the turn skips to
   step 8. See [Tools](tools.md).
5. **Build.** The core reads the window, recalls memory, detects the mood, draws the reply shape and assembles the
   prompt. See [Prompt Engine](prompt-engine.md) and [Memory](memory.md).
6. **Run.** The selected runner runs the loop. The model may call the tools offered for this chat. Retries and the
   fallback model stay inside the turn deadline. See [Models](models.md).
7. **Clean.** The cleaning chain runs, the reply is rendered for WhatsApp and split into bubbles, and a sticker is
   chosen when the pack has one. See [Prompt Engine](prompt-engine.md).
8. **Return.** The core returns the reply and attachments, stores the window, and closes the turn record. See
   [Records](records.md).
9. **After.** Memory extraction is queued. It never delays the reply.

## Gateway Patches

The pinned gateway carries 68 local patches (67 applied, one manual) and seven unregistered edits. Once the core
owns replies, tools and failures, each one falls in one group below. Classified from the patch inventory and the
spike runs, 16 Nov 2026.

| Verdict              | Count | Patches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Still needed         | 44    | Gateway: `session-guard-orphan`, `merge-quotes-newest`, `followup-quotes-followup`, `followup-quotes-followup-base`, `aira-queue-merge`, `whatsapp-group-allowed-chats`, `aira-failure-line`, `aira-failure-line-base`, `no-bg-review-chatter`. Adapter: `scope-stamp`, `whatsapp-forward-caption-window`, `aira-bubbles`, `aira-batch-quiet`, `aira-bubble-interrupt`, `whatsapp-log-reply-quote`. Bridge: `bridge-groups-not-dm-allowlist`, `quoted-media`, `bridge-groups-endpoint`, `bridge-resolve-lid`, `bridge-reaction-helpers`, `bridge-react-and-sticker`, `bridge-live-wa-version`, `bridge-companion-reg-refresh`, `bridge-atomic-creds`, `bridge-send-timer-at-dequeue`, `bridge-typing-presence`, `bridge-presence-route`, `bridge-media-retry-helpers`, `bridge-media-retry`. Cron: `cron-unresolved-origin-is-a-failure`, `cron-bare-platform-keeps-origin` and its test, `cron-failure-not-into-the-chat` and its two tests, `cron-failure-keeps-the-job`, `cron-repeat-limit-resets-completed`, `cron-delivery-visible` and its test. Voice: `tts-quiet-skip`, `tts-quiet-skip-gateway`, `tts-chat-id`, `tts-stderr-on-success`, `voice-after-text` |
| Unregistered, keep   | 4     | Standalone-send whitespace, inbound sticker as photo, view-once unwrapping, the edit jitter. Each has an entry in `deploy/gateway/patches.py`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| New                  | 1     | `sticker-media-type`: a `.webp` under a `stickers/` folder goes to the bridge as `sticker`, not `image`. In `deploy/gateway/patches.py`. See [Prompt Engine](prompt-engine.md#stickers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Replaced by the core | 21    | Agent loop: `aira-quiet-fallback`, `aira-quiet-fallback-declined` and its test, `aira-fallback-max-tokens`, `aira-primary-error` (the fallback list is empty and the core never fails a request). Gateway tools the core no longer calls: `send-photo-media-extract`, `send-photo-history-dedup`, `send-photo-attachable`, `send-photo-visible`, `make-report-attachable`, `ddgs-japanese-region`, `ddgs-test-fake-kwargs`, `web-search-depth`, `web-search-mode`, `whatsapp-no-session-search`, `cron-deliver-alias`, `cron-media-attach`, `cron-provider-error`, unregistered Tavily. Logging: `busy-ack-logging`, `no-leading-blank-lines` (the cleaning chain trims)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Owner tools only     | 2     | `cron-origin-in-summary`, `channel-directory-group-names`. Their fate follows the decision on the owner tools (PRD pending input 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Remove               | 4     | `whatsapp-passive-reactions` (manual, never applied), `whatsapp-autofetch` (answers unaddressed links; no requirement asks for it), unregistered `aira-trace` (writes the start of every outgoing message to `/tmp`), the unregistered reply-prefix test edit (expects a quote order no code writes, and fails; the upstream test is restored)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

- **AIRA's own patches** are in `deploy/gateway/patches.py`: the new patch, the four kept edits and the two
  removals marked as AIRA's (`aira-trace`, the reply-prefix test). The older patches stay in the old core's reapply
  script, which runs first. The script follows the same rules: every anchor found exactly once before a write, a mark
  that makes it idempotent, and a syntax check and tests with the backup restored on failure. Run with `--check`
  first. Proven on a copy of the staging tree: the four kept edits came out byte for byte as on staging.
- A "Replaced" patch is harmless while it stays. It is dropped the next time the gateway is re-pinned, not at
  cutover, so cutover changes as little as possible.
- `scope-stamp` counts as needed only because `WHATSAPP_SCOPE_STAMP=1` is set at cutover. See
  [Gateway Contract](#gateway-contract).

## Assumptions And Spikes

| ID   | Kind       | Statement                                                                                                                                                                                                                                                                                      | Affects               |
| ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A-1  | Assumption | Bun manages packages and runs scripts. Node 24 runs the service in the container.                                                                                                                                                                                                              | Tech stack            |
| A-3  | Assumption | The judge model is reachable from the host network with acceptable latency for the mood override.                                                                                                                                                                                              | Prompt engine, memory |
| A-7  | Assumption | The `claude` program accepts the window as one transcript prompt. That it names a served tool `mcp__aira__<name>` was confirmed with the real program on the host (version 2.1.220, 16 Nov 2026); that run hit the subscription's session limit, so the transcript is still to confirm in S-4. | Subscription runner   |
| A-9  | Assumption | The old fact files keep a group member as `about_id` in bare digits, which are a LID: the memory reader writes `<digits>@lid`. To check in the real dry run against the senders the new database knows.                                                                                        | Memory migration      |
| A-10 | Assumption | An old binding written as a phone number names the DM `<digits>@s.whatsapp.net`. The live gateway names most DMs by their LID, so such a binding may not match: the settings migration reports each one for review.                                                                            | Settings migration    |
| S-4  | Spike      | Benchmark the two transports on the live machine with the same prompts. Tracked in [#28](https://github.com/TolongLabs/AIRA/issues/28).                                                                                                                                                        | Launch default        |
| S-5  | Spike      | Build the shadow tap: copy real requests to the new core without sending its replies. Tracked in [#29](https://github.com/TolongLabs/AIRA/issues/29).                                                                                                                                          | Cutover               |
