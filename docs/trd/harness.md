# Test Harness

How AIRA is run, simulated, replayed and measured without WhatsApp and without live users, and which checks gate a
change.

## Principle

The core's only inbound interface is the gateway endpoint. The harness is a fake gateway: it posts the same requests
the real gateway would and reads the same responses. Everything behind the endpoint runs as it does in production.

## Test Layers

| Layer     | Runs                                                                      | Model Calls         | Where            |
| --------- | ------------------------------------------------------------------------- | ------------------- | ---------------- |
| Unit      | Pure functions: renderer, cleaning steps, resolver, parsers               | None                | Every commit, CI |
| Contract  | The gateway endpoint, the site API, tool schemas, config and pack schemas | None                | Every commit, CI |
| Replay    | Scripted conversations against recorded model replies                     | Replayed, zero live | Every commit, CI |
| Simulator | The memory simulator with ground truth                                    | Replayed, zero live | Every commit, CI |
| Benchmark | Latency and cost on fixed prompts                                         | Live                | On demand        |
| Live      | Tool triggering and persona checks against real models                    | Live                | Before a release |

A replay or simulator run that makes a live call fails. The harness counts live calls and asserts zero.

The portable-core contract adds real-listener tests in a temporary data volume for standalone cold boot.
With no model credentials or legacy owner service, the service reports ready and chatbot inactive; gateway
work is refused before turn creation. Test legacy missing-key failure, invalid storage/deployment failures,
and the legacy health envelope alongside the new readiness fields. Inactive startup and admission must make
zero model calls. Later installer gates exercise the release image itself, not just an injected app.

The host CLI unit suite uses Python stdlib unittest and fake subprocess/API ports (no Docker daemon or
real install). A separate candidate-image suite runs the actual CLI on a disposable Linux amd64 user with
real rootful Docker/Compose, loopback HTTP, missing keys, alternate UID/GID, collisions, failed setup retry,
credential denial, and state persistence. A Docker restart is not an OS reboot; the latter requires its own
disposable VM evidence. A failed or skipped required install gate cannot merge.

## Recordings

- Every model request is hashed from its role, model, prompt blocks, window, tool list and parameters.
- The hash is SHA-256 over the canonicalized role, model, system blocks, messages, tools and parameters. Key order
  does not matter.
- In `record` mode the harness calls the real model and stores the response under that hash.
- In `replay` mode it returns the stored response. A missing hash fails the test with a line diff against the closest
  stored request, so an unintended prompt change is visible.
- A recording file holds version 1 with entries keyed by hash. Each entry keeps the request and the response or error.
- Recordings are files in the repository. They contain only invented conversations. No real chat text is ever
  recorded.
- `bun run harness:refresh <scenario>` re-records one scenario on purpose.
- Recording and replay live in `tests/harness/recordings.ts`.

## Conversation Scenarios

A scenario is a file that describes chats, members, a character and a timeline of messages with times. Parsing
rejects unknown fields, duplicate members, a DM with anything but one member, a sender who is not a member, and a
step time earlier than the one before it. Scenario ids are invented (`test-chat-<id>`, `test-member-<name>`) and never
look like real WhatsApp ids. Scenario helpers live in `tests/harness/scenario.ts`; the gateway request shapes live in
`tests/harness/gateway.ts`.

```yaml
chat: { id: g1, type: group, character: example }
members: [alice, bob]
steps:
  - at: '09:00'
    from: alice
    text: "@aira what's the plan for tonight?"
    expect:
      mood: playful
      maxChars: 400
      tools: []
  - at: '09:01'
    from: bob
    text: '/remind 6pm dinner'
    expect:
      command: remind
      receipt: reminder.created
```

Expectations check facts code controls: the mood, the shape, the tools called, receipts, the outcome, format rules,
and timing budgets. They do not assert exact model wording.

## Memory Simulator

- A generated set of chats and members with scripted facts, corrections, retractions and upcoming changes, and a
  ground-truth file stating what should be remembered at each point.
- It drives the full write path and recall with replayed model and judge calls.

| Check       | Fails When                                                                   |
| ----------- | ---------------------------------------------------------------------------- |
| Isolation   | Any item or recalled text appears in a chat other than its own               |
| Lost Writes | An accepted operation is absent after concurrent jobs or a simulated crash   |
| Drift       | Recall precision or recall against ground truth falls below the stored floor |
| Forget      | A forgotten fact is recalled, or forgetting one fact changes another         |
| Recovery    | Jobs in flight at a crash are not completed or retried after restart         |

## Fixed Gates

| Gate            | Threshold                                                                        | Layer     |
| --------------- | -------------------------------------------------------------------------------- | --------- |
| Prompt Size     | Every pack under `prompt.maxSystemTokens`                                        | Contract  |
| Prompt Golden   | Assembled prompt for a fixed turn matches the stored copy                        | Contract  |
| Format          | No unsupported markup after the renderer, on a fixed corpus                      | Unit      |
| Persona Purity  | No character name or phrase in `src/`                                            | Unit      |
| Privacy Scan    | No phone number, WhatsApp id or real name in the tree                            | Unit      |
| Memory          | All simulator checks pass                                                        | Simulator |
| Zero Live Calls | Replay and simulator make no live call                                           | Replay    |
| Restart         | No lost acknowledged write, no reply sent twice, no stuck lease after a kill     | Replay    |
| Migration       | Every migration applies, and the previous release still passes on the new schema | Contract  |

A gate's stored value changes only in a pull request that says why.

Every gate is a test that `bun run test` runs, and CI runs that command on every pull request. A test that calls
any host but its own machine fails: the test setup refuses the request. The Privacy Scan finds WhatsApp ids and
phone numbers by pattern. It cannot find a real name: fixtures use invented names, and review checks that.

The Restart, Disk Full, Restore and Migration suites are specified in [Persistence](storage.md#tests).

## Benchmarks

`bun run bench` runs fixed prompt sets through the full turn against live models and writes one result file per run.

| Set       | Measures                                                     |
| --------- | ------------------------------------------------------------ |
| Casual    | Median and 90th percentile reply time with no tool call      |
| Tool      | The same for turns that call search and page reading         |
| Transport | Both transports on identical prompts, for the launch default |
| Cost      | Tokens and cost per turn, and cache hit rate                 |

Results are compared with the targets in the PRD (NFR-1). A benchmark does not gate a commit; it gates a release.

![Benchmark run: a validated prompt set runs through a local core session, then a summary is written as JSONL](../diagrams/benchmarks.svg)

- Sets are YAML with a non-empty name and description and 1 to 50 non-empty prompts. `loadBenchSet` rejects anything
  else.
- Prompts run in order through one local core session (`openChatSession`), which uses a scratch data folder unless a
  test gives it one. Each prompt writes one row. The local session reads that message's turn through its exact
  internal chat ID and generated message ID; wall-clock adjustments cannot attribute a prior turn to a later prompt.
- `p50` and `p90` are nearest-rank percentiles over delivered turns only. Cost and token totals cover all rows. A run
  with no input tokens reports a null cache hit rate.
- `writeBenchResult` writes one JSON line per prompt row plus a final summary line with `"summary": true`. The file
  name is timestamp plus set name; writing the same path replaces it.
- Shipped sets: `bench/casual.yml` (12 everyday messages that need no tool) and `bench/tool.yml` (8 search and
  page-read prompts).
- The runner lives in `src/bench/run.ts`; the local session lives in `src/bench/chat.ts`.

## Live Checks

`bun run live` runs fixed case sets through the full turn against live models, before a release. It is the Live layer
in [Test Layers](#test-layers). It does not gate a commit; a failed case blocks the release.

- A set is YAML with a non-empty name and description and 1 to 50 cases. A case has a non-empty `prompt` and an
  optional `expect`: `tools`, a list of tool names of which the turn must call at least one, or `noTools: true`, for a
  turn that must call none. `loadLiveSet` rejects anything else, including a case with both.
- Cases run in order through one local core session (`openChatSession`), as benchmarks do. The tools a turn called
  are read from its `tool_call` rows.
- Every case also runs the persona checks on its delivered reply. The reply is not empty and is not `NO_REPLY`. It
  never names itself an AI, a language model, a bot or an assistant, and never claims to be human. It holds no
  Markdown heading, table or link text. It is at most `format.bubbleMaxChars` characters long.
- A case passes when its turn is delivered, its tool expectation holds and every persona check passes. A failed case
  records the name of each check it failed, never the reply text.
- `writeLiveResult` writes one JSON line per case plus a summary line with `"summary": true`, named like a benchmark
  result. The script exits 1 when any case fails.
- Shipped sets: `live/tools.yml` (search, page reading, reminders and recall) and `live/persona.yml` (identity
  questions, format requests and casual messages that must call no tool).
- The runner lives in `src/live/run.ts`; the script lives in `scripts/live.ts`.

## Manual Tools

- `bun run sim` opens the WhatsApp simulator. See [WhatsApp Simulator](#whatsapp-simulator).
- `bun run chat --chat <id>` opens a terminal conversation through the fake gateway, with the turn record printed
  after each reply.
- `bun run turn <turn_id>` and `bun run report` are described in [Records](records.md).
- `bun run pack:check <id>` validates one character pack and prints its prompt size.

## WhatsApp Simulator

The simulator lets a maintainer see what a chat member would see, without a WhatsApp account. It has three levels.
Each level replaces less of the real system and catches a different kind of fault.

| Level           | Replaces                 | Runs For Real                              | Catches                                                            |
| --------------- | ------------------------ | ------------------------------------------ | ------------------------------------------------------------------ |
| 1. Fake Gateway | The gateway and WhatsApp | The core                                   | Mood, tools, memory and reply text                                 |
| 2. Fake Bridge  | The bridge process only  | The gateway with its patches, and the core | Bubble splitting, sticker and media sending, mute, scheduled sends |
| 3. Chat Preview | The phone                | Nothing; it draws recorded calls           | Formatting, bubble order, the sticker after the text               |

### Fake Bridge

The gateway talks to its bridge over a local HTTP port (3000 by default). The fake bridge is a small server that
answers the same routes, so the gateway cannot tell the difference.

| Route                                                                | Direction                              | The Fake Bridge Does                                     |
| -------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `GET /health`                                                        | Gateway asks                           | Reports connected                                        |
| `GET /messages`                                                      | Gateway polls for inbound              | Returns the messages a maintainer or a scenario injected |
| `POST /send`, `POST /edit`                                           | Gateway sends text                     | Records the call and returns a message id                |
| `POST /send-media`                                                   | Gateway sends a sticker, photo or file | Records the call and keeps a copy of the file            |
| `POST /react`, `POST /typing`, `POST /read`                          | Gateway signals                        | Records the call                                         |
| `GET /chat/:id`, `GET /groups`, `GET /presence`, `POST /resolve-lid` | Gateway looks up                       | Answers from the scenario's chats and members            |

- Inbound messages are injected through a control route that exists only on the fake bridge: a sender, a chat, text,
  an optional quoted message, an optional mention and an optional media file.
- Every recorded call keeps its time, route and full payload. Scenario expectations assert on these records.
- Two more control routes let a preview read the records over HTTP: `GET /control/calls?after=<n>` lists the calls
  after number `n`, and `GET /control/file/<n>` returns the file that call `n` sent. Neither is recorded. Each
  `/send` and `/send-media` call also keeps the message id the bridge answered with, so a reply that names a message
  can be matched to it.
- A `/send-media` file path is copied and served only when its real path, symlinks resolved, lies under a configured
  media root. Any other path is recorded but never read.
- The control file route serves recognized image types as images and every other file as `application/octet-stream`.
- The route list above is read from the pinned bridge's source and the local patches. It is checked against that
  source whenever the gateway version changes.
- The fake bridge binds loopback only and refuses a `Host` that is not loopback. Scenario injection and send
  assertions live in `tests/harness/bridge-scenario.ts`; the bridge itself lives in `tests/harness/bridge.ts`.
- The fake bridge binds to loopback and never contacts WhatsApp.

### Chat Preview

A local page that draws the recorded calls as a conversation. The preview server accepts JSON request bodies up to
64 KiB, binds loopback, and answers only requests whose `Host` is its own address with an absent or matching
same-origin `Origin`, so another site cannot drive the sim. The server lives in `tests/harness/sim/server.ts`; the
backends live in `tests/harness/sim/backend.ts`.

![Harness replay: a validated scenario feeds recording replay or the fake bridge, and the preview draws the recorded sends](../diagrams/harness.svg)

- One column per chat, with member bubbles and AIRA's bubbles in send order.
- Text is drawn with WhatsApp's published markup rules: bold, italic, strikethrough, monospace, inline code, lists
  and block quotes. Markup WhatsApp does not support is drawn as the raw characters, so a formatting fault is
  visible.
- A sticker is drawn at sticker size, as its own message after the text. A photo or file is drawn as an attachment.
- Light and dark themes, and a narrow phone width.
- Each bubble links to its turn record.

### Fixture Check

A simulator shows what the project believes WhatsApp does. It is checked against the real app once, and again when
the renderer changes.

1. A fixed set of formatted messages is sent to a real test chat.
2. Screenshots are compared with the preview of the same messages.
3. Differences are fixed in the preview, and the set is stored as the reference.

The sticker path was proven on the real bridge on 16 Nov 2026: a sticker sent to the bridge's sticker route arrived
as a native sticker.

The spikes ran a gateway against a fake bridge this way: the gateway adopts a bridge that is already running when its
`GET /health` reports `connected` with the hash of the `bridge.js` on disk and the same read-receipt setting. Run it
with a scratch `HERMES_HOME`, and start it through `gateway.run.start_gateway`, not `hermes gateway run`, which
rewrites the user's service unit.

### Commands

- `bun run sim` is level 1. It starts the core in this process and the chat preview on `127.0.0.1:9900`, with two
  chats, one DM and one group, bound to one character. Messages reach the core in the gateway's request shape, so the
  core runs as in production. It needs the same model key as `bun run chat`, read from the environment or `.env`.
- `bun run sim --gateway` is level 2. It starts no core. It starts the fake bridge on `127.0.0.1:3000`, which a staging
  gateway uses as its bridge, and the preview draws the calls that gateway makes to it. `--bridge <url>` uses a fake
  bridge that already runs. The preview reads the bridge's recorded calls over `GET /control/calls`, which the bridge
  does not record, and sends messages through `POST /control/inject`.
- Flags: `--port` (preview port), `--character` (default: the data folder's global binding, else `example`), `--data`
  (the data folder, whose `characters/` folder holds private packs; default a scratch folder removed on exit),
  `--bridge-port`, `--dm-id` and `--group-id` (level 2).
- The preview serves a sticker only as a `.webp` from a pack's `stickers/` folder, under the data folder or the
  repository. It binds to loopback and answers only requests that name its own address.

## Shadow Mode

Before cutover, the harness's request format is fed from production: real gateway requests are copied to the new
core, which runs the full turn and records it but returns nothing to WhatsApp. See [Deployment](deployment.md).

## Dashboard browser checks

Build the production site, install the browsers with `bunx playwright install --with-deps chromium firefox webkit`
and run `bun run test:dashboard` from the repository root. Each engine opens a new browser context pointed at a
loopback core listener, temporary SQLite data, and a controlled owner service. The smoke journey checks summary
values, navigation, refresh, phone drawer focus, 320-pixel reflow and automated accessibility rules.
