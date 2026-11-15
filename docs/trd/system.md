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

| Direction | Field                        | Meaning                                                                                     |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Request   | Headers                      | OpenAI client headers only. No chat, sender or message id travels in a header.              |
| Request   | Scope marker                 | `[HERMES-SCOPE v1 platform= kind= chat= sender= mid=]` before the newest user text          |
| Request   | `messages`                   | The gateway's transcript. The core reads only the newest user content from it.              |
| Request   | `stream`                     | `true`, with `stream_options.include_usage`. The core answers as a server-sent event stream |
| Request   | `tools`, system message      | The gateway's own prompt and tool schemas. The core ignores both                            |
| Response  | `choices[0].message.content` | The cleaned reply text, with bubble breaks and attachment lines. See below                  |
| Response  | HTTP status                  | Always 200 with a deliverable reply. Failures become an in-character line.                  |

- **Identity comes from the scope marker.** The gateway's scope stamp patch writes it when `WHATSAPP_SCOPE_STAMP=1`.
  It is off on the live gateway today and is switched on at cutover. A request without a marker is refused as a
  deployment fault. The marker's `mid` is the gateway message id that keys `inbound_message` in
  [Persistence](storage.md).
- **Earlier unanswered messages ride along.** After a failed turn the gateway keeps the user's text and prepends it
  to the next user content, separated by blank lines, before the marker. The core treats text before the marker as
  earlier messages from the same sender that got no reply.
- **Gateway notes are removed.** On a chat's first message the gateway appends a `[System note: ...]` block to the
  user text. The core strips every such block before the text enters a turn.
- **Auxiliary requests.** The gateway also calls the same endpoint for its own chores, such as a session title. Such
  a request has no `tools` and no scope marker. The core answers it with a short fixed text, makes no model call and
  writes no turn record.
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
- **No reply is an empty reply.** When a turn ends with nothing to send (a sender who is not allowed, a muted
  scheduled turn, a chat that is not switched on), the core returns status 200 with empty content
  (**Assumption A-4**).
- **A scheduled turn carries a tag.** The text of a job the core gives to the gateway's schedule starts with
  `[AIRA-SCHEDULED v1 kind=<reminder|proactive|routine> ...]`. A turn whose text starts with that tag is a
  scheduled turn (**Assumption A-5**).
- **Group addressing is the gateway's.** The request does not say whether a group message mentions AIRA or replies
  to it. The core treats every group message it receives as addressed (**Assumption A-6**).
- The core never returns an error status for a model or tool failure. An error status is reserved for a request the
  core cannot parse, which is a deployment fault.
- Scheduled messages (reminders, proactive messages) arrive through the same endpoint from the gateway's cron. The
  core applies mute and quiet rules to them like any other turn. See [Reliability](reliability.md).

### When the Core Is Slow or Down

| Case                           | What the Gateway Does (Measured)                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused             | Retries the identical request, 6 attempts in two rounds of 3, then sends the failure line. About 22 s                                     |
| Connection dropped mid-request | Same: 6 identical requests with the same `mid`, then the failure line. About 35 s to 50 s                                                 |
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
| Unregistered, keep   | 5     | Standalone-send whitespace, inbound sticker as photo, view-once unwrapping, the reply-prefix test, the edit jitter. Each must get a patch entry in the reapply script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| New                  | 1     | `sticker-media-type`: a `.webp` under a `stickers/` folder goes to the bridge as `sticker`, not `image`. See [Prompt Engine](prompt-engine.md#stickers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Replaced by the core | 21    | Agent loop: `aira-quiet-fallback`, `aira-quiet-fallback-declined` and its test, `aira-fallback-max-tokens`, `aira-primary-error` (the fallback list is empty and the core never fails a request). Gateway tools the core no longer calls: `send-photo-media-extract`, `send-photo-history-dedup`, `send-photo-attachable`, `send-photo-visible`, `make-report-attachable`, `ddgs-japanese-region`, `ddgs-test-fake-kwargs`, `web-search-depth`, `web-search-mode`, `whatsapp-no-session-search`, `cron-deliver-alias`, `cron-media-attach`, `cron-provider-error`, unregistered Tavily. Logging: `busy-ack-logging`, `no-leading-blank-lines` (the cleaning chain trims)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Owner tools only     | 2     | `cron-origin-in-summary`, `channel-directory-group-names`. Their fate follows the decision on the owner tools (PRD pending input 6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Remove               | 3     | `whatsapp-passive-reactions` (manual, never applied), `whatsapp-autofetch` (answers unaddressed links; no requirement asks for it), unregistered `aira-trace` (writes the start of every outgoing message to `/tmp`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- A "Replaced" patch is harmless while it stays. It is dropped the next time the gateway is re-pinned, not at
  cutover, so cutover changes as little as possible.
- `scope-stamp` counts as needed only because `WHATSAPP_SCOPE_STAMP=1` is set at cutover. See
  [Gateway Contract](#gateway-contract).

## Assumptions And Spikes

| ID  | Kind       | Statement                                                                                                                                                          | Affects               |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| A-1 | Assumption | Bun manages packages and runs scripts. Node 24 runs the service in the container.                                                                                  | Tech stack            |
| A-3 | Assumption | The judge model is reachable from the host network with acceptable latency for the mood override.                                                                  | Prompt engine, memory |
| A-4 | Assumption | The gateway sends nothing to the chat when the core returns empty content. To confirm on the staging gateway with the fake bridge in step 3.                       | Gateway contract      |
| A-5 | Assumption | A request the gateway's schedule starts carries the scope marker of the job's chat and the job's text unchanged. To confirm in step 3.                             | Scheduled turns       |
| A-6 | Assumption | The gateway forwards a group message only when it mentions AIRA, replies to AIRA, or the chat is free response there. To confirm in step 3.                        | Turn admission        |
| A-7 | Assumption | The `claude` program accepts the window as one transcript prompt, and names a served tool `mcp__aira__<name>`. Tested with a fake program only; to confirm in S-4. | Subscription runner   |
| S-4 | Spike      | Benchmark the two transports on the live machine with the same prompts. Tracked in [#28](https://github.com/TolongLabs/AIRA/issues/28).                            | Launch default        |
| S-5 | Spike      | Build the shadow tap: copy real requests to the new core without sending its replies. Tracked in [#29](https://github.com/TolongLabs/AIRA/issues/29).              | Cutover               |
