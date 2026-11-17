# Technical Requirements

The canonical index of AIRA's technical contracts. Each subsystem has one module under `docs/trd/`.

Status: draft 0.1, 15 Nov 2026. This describes the revamped chatbot core. Nothing here is built yet.

## At a Glance

- **Canonical:** this index and its modules are the contract. Code, tests and guides follow them.
- **One Owner per Fact:** a behavior, limit, default or key lives in one module. Other pages link to it.
- **Start Here:** [System](trd/system.md) walks one turn end to end and links every other module.
- **Requirements:** [Product Requirements](PRD.md) says what AIRA must do. These modules say how.
- **Draft Markers:** a line tagged **Assumption** is a best guess to confirm. A line tagged **Spike** needs a short
  experiment before the contract is fixed. Both are listed in [System](trd/system.md#assumptions-and-spikes).

## Modules

| Module                                  | Covers                                                                                                      | File                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| [System Architecture](trd/system.md)    | Processes, the gateway contract, the tech stack, repository layout, one turn end to end                     | `docs/trd/system.md`        |
| [Prompt Engine](trd/prompt-engine.md)   | Character packs, prompt blocks, mood detection, reply shape, WhatsApp formatting, stickers                  | `docs/trd/prompt-engine.md` |
| [Tools and Commands](trd/tools.md)      | The tool registry, implicit and explicit calls, text commands, external tool servers                        | `docs/trd/tools.md`         |
| [Memory](trd/memory.md)                 | Typed items, the write path, the judge, scoping, recall, forgetting, migration                              | `docs/trd/memory.md`        |
| [Models](trd/models.md)                 | The two transports, turn runners, routing, fallback, spend                                                  | `docs/trd/models.md`        |
| [Reliability](trd/reliability.md)       | Turn admission, failure kinds, retries, deadlines, mute and quiet enforcement                               | `docs/trd/reliability.md`   |
| [Records](trd/records.md)               | Turn records, failure records, logs, redaction, retention                                                   | `docs/trd/records.md`       |
| [Data and Settings](trd/data.md)        | The SQLite file and tables, the settings hierarchy, configuration files                                     | `docs/trd/data.md`          |
| [Persistence](trd/storage.md)           | Stores, write promises, restart safety, the disk guard, snapshots, the off-host copy, analytics, migrations | `docs/trd/storage.md`       |
| [Test Harness](trd/harness.md)          | Test layers, recordings, the conversation and memory simulators, benchmarks, gates                          | `docs/trd/harness.md`       |
| [Research and Reports](trd/research.md) | `/research` jobs, the findings mold, the PDF offer, the report renderer                                     | `docs/trd/research.md`      |
| [Owner Site](trd/site.md)               | The revamped site, its API, the character studio, the design contract                                       | `docs/trd/site.md`          |
| [Deployment](trd/deployment.md)         | CI, the release image, the pull deploy, the shadow period, the one-night cutover                            | `docs/trd/deployment.md`    |

## Decisions

| #    | Decision                                                                                                                                         | Reason                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-1  | The core is a new TypeScript service on Node 24. The existing Python chatbot code is retired at cutover.                                         | The designs AIRA adopts are proven in TypeScript, and both maintainers can read a small typed codebase.                                                |
| D-2  | Hermes Agent stays as the WhatsApp transport at its pinned commit. It is not upgraded.                                                           | 55 of 67 local patches fail on current upstream, and upstream ships the same WhatsApp library.                                                         |
| D-3  | The core attaches at the seam that exists today: an OpenAI-compatible endpoint on `127.0.0.1:9881` that Hermes calls as a custom model provider. | Cutover and rollback are one address change. No new Hermes patch is needed to attach.                                                                  |
| D-4  | Hermes's fallback provider list is emptied. The core always returns a deliverable reply.                                                         | It removes the second agent loop, the duplicate tool set and the second voice.                                                                         |
| D-5  | One turn runner interface with two implementations: an API runner and a subscription runner.                                                     | The prompt, tools and cleaning chain stay identical on both transports (PRD FR-32).                                                                    |
| D-6  | The API runner uses Google's Agent Development Kit for the model loop and tool calls.                                                            | It gives callbacks at every stage the core must control, and the maintainers know it.                                                                  |
| D-7  | One SQLite file is the canonical store. One process writes it.                                                                                   | The memory faults came from several writers on unlocked text files.                                                                                    |
| D-8  | A character pack on disk is the only source of persona text.                                                                                     | Persona text hard-coded in program code cannot differ per chat.                                                                                        |
| D-9  | Chat settings live in the database, in a three-level hierarchy. Deployment settings live in `config.yml`. Secrets live in `.env`.                | Settings need transactions, validation and a change record. Deployment values need review in git.                                                      |
| D-10 | The owner site keeps its React front end and design contract. Chatbot pages call the core's API. Owner-tool pages keep their current API.        | It revamps the site without touching the owner tools.                                                                                                  |
| D-11 | A tagged release builds one container image. The host pulls and deploys it on a timer.                                                           | Updates cannot be forgotten, and no outside system holds a key to the host.                                                                            |
| D-12 | SQLite stays the system of record. DuckDB is the analysis engine, reading verified snapshots and a Parquet archive, never the live file.         | The core does many small transactions that must each survive a crash. Reports want aggregates across files. Each engine does the job it was built for. |
| D-13 | Every unit of work in flight is a database row with a state. A restart resumes it or fails it by rule.                                           | The old system kept work in memory and in files, so a restart lost it or repeated it.                                                                  |
| D-14 | A verified, encrypted copy of the data lives off the host, at most 15 minutes old, and a restore is rehearsed.                                   | The host has lost its disks before. Copies on the same disk are lost with it.                                                                          |

## Rules Across Modules

These rules hold in every module. A change that breaks one changes this page first.

### SQLite Is Canonical

Every durable fact lives in one SQLite file in WAL mode. Only the core process writes it. The owner site, scheduled
jobs and scripts change data through the core's API. No module keeps durable state in a text file or in process
memory. [Persistence](trd/storage.md) owns how that file is written, recovered and copied.

### Identity Comes From Code

The chat, the sender and the character are resolved by code from the gateway request. They reach tools through the
turn context. A model never supplies or changes an identity, a scope or a permission.

### A Fact Never Leaves Its Chat

Memory, style and behaviour state are keyed by chat instance. No query, cache or prompt block may read another chat's
rows. The memory simulator tests this on every change.

### One Loop, One Tool Set, One Voice

A turn runs one agent loop with one prompt, one tool list and one cleaning chain. A fallback changes the model and
nothing else.

### The Character Pack Is the Persona Source

All persona text, moods, lines and images come from the bound character pack. Program code holds no character name,
trait or phrase.

### Every State Change Has a Receipt

A tool that changes state returns a receipt built by code from the result. The reply may claim an action only when
its receipt exists.

### Every Turn Leaves a Record

A turn that starts writes a turn record, whatever happens next. A failure writes a failure record with the turn id.

### Untrusted Text Is Labelled

Text from users, web pages, media and tool results enters the prompt inside labelled blocks. It is never placed
where the model reads instructions.

### The System Prompt Has a Size Cap

The system prompt stays under a fixed token ceiling. A test enforces it for every character pack in the repository.

## Changing a Contract

1. Change the module that owns the fact, and this index if a rule or decision changes.
2. Add a line to `docs/DECISIONS.md` with the date and the reason.
3. Change the code and its tests in the same pull request.
