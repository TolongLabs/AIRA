# AIRA

A WhatsApp chatbot agent that plays a configured character in each chat.

## Contents

- [What AIRA Is](#what-aira-is)
- [Status](#status)
- [How It Fits Together](#how-it-fits-together)
- [Repository Layout](#repository-layout)
- [Development](#development)
- [Documentation](#documentation)
- [Licence](#licence)

## What AIRA Is

AIRA answers WhatsApp DMs and small groups on one Linux host behind the Hermes Agent WhatsApp gateway. Each chat is
bound to one character pack and its own settings. Expression, mood, tone and reply format are chosen and enforced by
code in one agent loop with one tool set. Memory is stored as typed records in one SQLite file, scoped strictly to each
chat, and every turn and failure leaves a record for post-mortem review and offline testing.

## Status

This repository is a scaffold only. Nothing runs yet, and no feature code exists. See [Product Requirements](docs/PRD.md)
for what AIRA must do and [Technical Requirements](docs/TRD.md) for the subsystem contracts.

## How It Fits Together

![System overview: WhatsApp reaches the Hermes gateway, which calls the AIRA core; the core uses one SQLite file and the model services; the owner site calls the core's API](docs/diagrams/system-overview.svg)

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

## Development

```sh
bun install
bun run typecheck
bun run lint
bun run test
```

## Documentation

| Document                                                  | Covers                                                   |
| --------------------------------------------------------- | -------------------------------------------------------- |
| [Product Requirements](docs/PRD.md)                       | Requirements, user workflows and non-functional targets  |
| [Technical Requirements](docs/TRD.md)                     | Canonical index of contracts, decisions and cross-module |
| [Architecture decision records](docs/decisions/README.md) | Lasting architectural and product choices                |
| [Conventions](docs/CONVENTIONS.md)                        | Repository rules, code style and commit rules            |
| [Runbook](docs/RUNBOOK.md)                                | Operations skeleton pointing to TRD modules              |
| [TRD Modules](docs/trd/system.md)                         | Subsystem contracts under `docs/trd/`                    |

## Licence

Released under the MIT Licence. Copyright (c) 2026 TolongLabs.
