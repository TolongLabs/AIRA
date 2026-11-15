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

```
WhatsApp  <->  bridge  <->  Hermes gateway  --HTTP-->  AIRA core (container)
               (host, pinned, patched)                 | prompt engine, tools, memory, records
                    |                                  +--> model API  (API runner)
                    | cron, delivery                   +--> host runner service --> claude program
                    v                                  +--> judge model, media model, search
               owner tools (unchanged)                 +--> SQLite file (data volume)
                                                       ^
owner site (React)  --HTTP-->  core API (chatbot pages) |   legacy site API (owner-tool pages)
```

- **Gateway:** receives and sends WhatsApp messages, keeps its sessions, and runs its cron. It calls the core as its
  model. Its fallback provider list is empty.
- **Core:** owns the turn. It resolves the chat, builds the prompt, runs the loop, cleans the reply and returns it.
- **Host Runner Service:** exists only when the subscription transport is selected. It runs the `claude` program on
  the host with the owner's login and exposes it to the core on a loopback port. See [Models](models.md).
- **Owner Tools:** market alerts, news digest, session notices and file sending keep running as they do today.

## Gateway Contract

The gateway calls `POST /v1/chat/completions` on the core.

| Direction | Field                        | Meaning                                                                        |
| --------- | ---------------------------- | ------------------------------------------------------------------------------ |
| Request   | Session id header            | Identifies the chat instance. The core maps it to a chat row.                  |
| Request   | `messages`                   | The gateway's transcript. The core reads only the newest user content from it. |
| Request   | Sender and quote metadata    | Who wrote the message in a group, and what it replies to.                      |
| Response  | `choices[0].message.content` | The cleaned reply text, ready for WhatsApp.                                    |
| Response  | Attachments                  | Stickers, photos and files, named for the gateway to send.                     |
| Response  | HTTP status                  | Always 200 with a deliverable reply. Failures become an in-character line.     |

- The core keeps its own conversation window in SQLite. It does not trust the gateway's transcript for history,
  because the gateway compresses and rewrites it.
- The core never returns an error status for a model or tool failure. An error status is reserved for a request the
  core cannot parse, which is a deployment fault.
- Scheduled messages (reminders, proactive messages) arrive through the same endpoint from the gateway's cron. The
  core applies mute and quiet rules to them like any other turn. See [Reliability](reliability.md).

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

## Assumptions And Spikes

| ID  | Kind       | Statement                                                                                             | Affects               |
| --- | ---------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| A-1 | Assumption | Bun manages packages and runs scripts. Node 24 runs the service in the container.                     | Tech stack            |
| A-2 | Assumption | The gateway's session id header is enough to identify the chat and the sender in a group.             | Gateway contract      |
| A-3 | Assumption | The judge model is reachable from the host network with acceptable latency for the mood override.     | Prompt engine, memory |
| S-1 | Spike      | Send a native sticker through the pinned bridge, and find how the core names it in a response.        | Delivery              |
| S-2 | Spike      | Decide who splits bubbles: the existing gateway patch or the core returning several messages.         | Delivery              |
| S-3 | Spike      | Confirm what the gateway does with an empty fallback list when the core is down.                      | D-4, cutover          |
| S-4 | Spike      | Benchmark the two transports on the live machine with the same prompts.                               | Launch default        |
| S-5 | Spike      | Build the shadow tap: copy real requests to the new core without sending its replies.                 | Cutover               |
| S-6 | Spike      | List which of the 67 gateway patches the chatbot still needs once the core owns replies and failures. | Maintenance           |
