# Data And Settings

The SQLite file, its tables, the settings hierarchy, and which file owns which kind of value.

## Where Values Live

| Kind               | Lives In                              | Changed By                     | Example                        |
| ------------------ | ------------------------------------- | ------------------------------ | ------------------------------ |
| Secret             | `.env`                                | The operator, on the host      | A model key                    |
| Deployment setting | `config.yml`                          | A reviewed commit              | Transport, deadlines, ceilings |
| Persona            | `characters/<id>/` on the data volume | The site's studio, or a commit | Moods, lines, stickers         |
| Chat setting       | SQLite `setting`                      | The site, or a command         | A chat's character             |
| Everything durable | SQLite                                | The core only                  | Memory, records                |

`config.yml` is validated at start-up against one schema. An unknown key or a wrong type stops start-up. The loader
is `src/config/loader.ts` and the schema is `src/config/schema.ts`, which also requires the host data volume path.

## The Database

One file on the data volume. Only the core process opens it for writing. How it is opened, migrated, recovered and
copied is specified in [Persistence](storage.md). This module owns what the tables are.

| Table                                                                          | Purpose                                                                                                      | Owner Module                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `chat`                                                                         | One row per chat instance: ids, type, label, status                                                          | This module                       |
| `identity`                                                                     | Maps WhatsApp ids for one person to one subject id                                                           | This module                       |
| `setting`                                                                      | The settings hierarchy                                                                                       | This module                       |
| `setting_change`                                                               | Change log for settings and packs                                                                            | [Records](records.md)             |
| `session_message`                                                              | The conversation window                                                                                      | [System](system.md)               |
| `memory_item`, `memory_job`, `memory_event`                                    | Memory                                                                                                       | [Memory](memory.md)               |
| `reminder`, `tool_result`, `receipt`                                           | Reminders, stored tool results by call id, and receipts                                                      | [Tools](tools.md)                 |
| `feedback_report`, `feedback_cursor`                                           | Private report references, turn links, answers and the Google sync cursor                                    | [Tools](tools.md)                 |
| `turn`, `model_call`, `tool_call`, `failure`, `job_run`, `failure_diagnostics` | Records                                                                                                      | [Records](records.md)             |
| `spend`                                                                        | Cost per role per month                                                                                      | [Models](models.md)               |
| `chat_state`                                                                   | Runtime state by chat and character: last opener, sticker                                                    | [Prompt Engine](prompt-engine.md) |
| `inbound_message`, `schema_migration`, `backup_run`, `file`                    | Inbound requests by chat and gateway message id, applied migrations, snapshot runs, files on the data volume | [Persistence](storage.md)         |

![The data model: every table by domain, with columns, keys and foreign keys](../diagrams/data-erd.svg)

### Chats And Identities

Record tables and logs never hold a WhatsApp id. Code maps each one to an internal id at the door.

- **Chat.** `chat` maps a chat's WhatsApp id to an internal `chat_id`. Every other table uses the internal id. The
  first message from an unseen chat creates its row as `pending`. A pending chat gets no reply: the turn ends at
  admission check 1 in [Reliability](reliability.md#turn-admission), with an operator alert. The owner site, the
  migration or an operator command sets a chat `active`.
- **Subject.** `identity` maps each WhatsApp id of a person to one `subject_id`. A sender seen for the first time
  gets a new subject. Two ids of one person are joined by the site or the migration, never by a model.
- **Ids.** A new chat id starts with `c_` and a new subject id with `s_`, each followed by 12 lowercase hex
  characters from 6 random bytes. They never change, and record tables use them instead of WhatsApp ids.
- **Display names.** The gateway's display name for a sender is kept on the identity, for names in the prompt and in
  mentions. The change log never stores a WhatsApp id or a label.

Chats, subjects and display names live in `src/settings/chats.ts`.

## Settings Hierarchy

A setting is resolved through three levels. The nearest level that has a value wins.

```
global  ->  chat type (dm | group)  ->  chat instance
```

| Column  | Meaning                                         |
| ------- | ----------------------------------------------- |
| `level` | `global`, `type` or `chat`                      |
| `scope` | Empty for global, `dm` or `group`, or a chat id |
| `key`   | The setting key                                 |
| `value` | JSON, validated against the key's schema        |

The primary key is `(level, scope, key)`. Deleting a row at a level restores inheritance from the level above.

### Setting Keys

| Key                      | Type                                                                                       | Default (Global)        |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------- |
| `character`              | Character pack id                                                                          | Set at install          |
| `language`               | `auto` or a language code                                                                  | `auto`                  |
| `freeResponse`           | Boolean                                                                                    | `false`                 |
| `allowedSenders`         | List of subject ids, or `all`                                                              | `all`                   |
| `model`                  | Role override, or `inherit`                                                                | `inherit`               |
| `replyLength`            | `short`, `default`, `long`                                                                 | `default`               |
| `expressions`            | Boolean                                                                                    | `true`                  |
| `quietHours`             | Start, end and time zone                                                                   | Unset                   |
| `muted`                  | Boolean, with who and when                                                                 | `false`                 |
| `features.proactive`     | Boolean                                                                                    | `false`                 |
| `features.reminders`     | Boolean                                                                                    | `true`                  |
| `features.search`        | Boolean                                                                                    | `true`                  |
| `features.social`        | Boolean                                                                                    | `true`                  |
| `features.identify`      | Boolean: allow reverse-image hints in this chat                                            | `false`                 |
| `features.photos`        | Boolean                                                                                    | `true`                  |
| `features.media`         | Boolean                                                                                    | `true`                  |
| `features.memory`        | Boolean: memory for this chat ([Memory](memory.md#per-chat-switch))                        | `true`                  |
| `features.think`         | Boolean: `/think` runs one turn at deeper effort ([Models](models.md#deeper-thinking))     | `true`                  |
| `features.context`       | Boolean: replay the chat log as context ([Prompt Engine](prompt-engine.md#live-context))   | `true`                  |
| `context.maxMessages`    | Integer 0 to 100: chat-log messages replayed per turn                                      | `40`                    |
| `memory.pageMessages`    | Integer 5 to 50: messages that close a memory episode                                      | `25`                    |
| `features.voice`         | Boolean                                                                                    | `false`                 |
| `features.lessons`       | Boolean                                                                                    | `false`                 |
| `features.reports`       | Boolean: `/doc` document creation                                                          | `true`                  |
| `features.research`      | Boolean: `/research` jobs and their PDF reports                                            | `true`                  |
| `features.feedback`      | Boolean: `/report` private feedback links                                                  | `false`                 |
| `report.format`          | Reserved: a per-chat report format profile ([Research](research.md#the-renderer))          | unset: `render.report`  |
| `report.defaultFormat`   | `pdf` or `markdown`: the format of `/doc` when the message names none                      | `pdf`                   |
| `features.owner`         | Boolean: the owner's market and coding-session tools                                       | `false`                 |
| `features.autofetch`     | Boolean: a group's or DM's post links get their media back ([System](system.md#autofetch)) | `false`                 |
| `features.toolFooter`    | Boolean                                                                                    | `true`                  |
| `nameCall`               | Boolean: answer a group message that only names the character                              | `false`                 |
| `nameCall.names`         | 1 to 5 names, each 2 to 24 letters, digits or spaces                                       | unset: the card's names |
| `reactions`              | Boolean: passive emoji reactions to members' messages                                      | `false`                 |
| `reactions.chance`       | Integer 0 to 100: percent chance to react when a rule trips                                | `33`                    |
| `commands.maxPerMessage` | Integer 1 to 5: commands run from one message                                              | `1`                     |
| `tools.maxPerMessage`    | Integer 1 to 8: tool calls one reply may make                                              | `3`                     |
| `footerEmoji`            | One emoji, at most 8 characters                                                            | unset: the card's icon  |
| `mcp.<server id>`        | Boolean                                                                                    | `false`                 |

For each supported social operation, `social.platforms.<id>` and `autofetch.platforms.<id>` are
independent Boolean settings. Each defaults to true. Chat, chat-type and global overrides follow the normal
hierarchy. Clearing the chat override restores the inherited value. The main feature and the server's
available operations still determine whether a platform can run. Setting a switch cannot enable a provider.

**Not built yet:** `report.defaultFormat` is not in the settings registry, so a write to it is rejected as unknown
(`src/settings/keys.ts`).

Each optional chat feature is one `features.*` key. A tool or behaviour names the key that enables it.

### Feedback Data

Migration `0013_feedback.sql` adds two add-only `STRICT` tables:

| Table             | Fields                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback_report` | `report_id`, unique `ref`, `chat_id`, `subject_id`, command `turn_id`, `turn_ids` as JSON containing the chat's five newest turns, state (`open`, `received`, `closed`, `expired`), `issued_at`, `expires_at`, `received_at`, `closed_at`, `form_seq`, and Zod-checked `answers` JSON with a cap on every key |
| `feedback_cursor` | The singleton Apps Script cursor: `after` and `updated_at`                                                                                                                                                                                                                                                    |

The report's chat and requesting subject are internal ids. Identity comes from that row, never from an answer. No
feedback table stores a WhatsApp id, phone number, form URL or Apps Script secret. The referenced turns stay in their
existing record tables under those tables' retention rules; feedback does not copy their text.

At most one `open` unexpired report exists for one `(chat_id, subject_id)` pair. Creating a report and its receipt is
one transaction. Accepting a row, or recording `feedback_rejected`, and advancing `feedback_cursor` is one transaction.
An unknown, expired or used reference never changes `answers`. These constraints make command retries and sync replay
safe.

The `mcp.<server id>` keys are dynamic: the part after `mcp.` holds 1 to 32 lowercase letters, digits, `_` or `-`.
Every such key defaults to `false`.

The registry is `src/settings/keys.ts`. It is the only list that decides which keys exist: an unknown key is
rejected at write time and at read time.

### Resolution Rules

- `resolve(chat)` returns every key with its value and the level it came from. The site shows that level.
- A value that fails its schema is rejected at write time. The store never holds an invalid value.
- A stored row that is not valid JSON, or that fails its key's schema, is skipped at read time. Resolution falls
  through to the less-specific level, then to the built-in default. A bad row never reaches a turn.
- A `character` that names a missing or invalid pack makes the binding invalid. The chat stops and the operator is
  alerted. Resolution never substitutes another character.
- Every write goes through one function that validates, writes and logs the change in one transaction.
- A change applies to the next turn. No restart is needed.

Resolution, writes and removal live in `src/settings/settings.ts`.

![How a chat setting resolves through global, type and chat levels, and how a site write is validated and
logged](../diagrams/settings-resolution.svg)

## Migration From The Old Store

The one-time migration reads the old binding file, per-chat state files and memory stores, and writes the tables
above. Old values that have no new key are listed in the migration report, not dropped silently. Memory migration is
specified in [Memory](memory.md#migration).

`bun run migrate:settings --from <private copy> --character <old personality>=<pack id> ...` is the dry run: it
prints the plan as counts and reasons, and writes nothing. Adding `--confirm` applies it in one transaction, with the
core stopped. A second real run changes nothing. It runs before the memory import, because that import needs the
chats. The copy holds the old `bindings.yaml` and the brain folder's `language.json`, `lessons.json`, `faces.json`
and `quiet.json`. Measured on the production host's layout, 16 Nov 2026:

| Old Value                                                          | New                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| A binding's `match` (platform `whatsapp`, kind, chat)              | The chat row, set `active`. A chat written as a phone number is reported (Assumption A-10)                       |
| `defaults.personality`, a binding's `personality`                  | `character` at the global or chat level, through the `--character` map. An unmapped name is reported and not set |
| A binding's `permissions.photos`                                   | `features.photos` at the chat level                                                                              |
| A binding's `permissions.autofetch`                                | `features.autofetch` at the chat level, on only for the literal `on`                                             |
| `language.json`, by chat                                           | `language` at the chat level, when it is `auto` or a language code                                               |
| `lessons.json`, by chat                                            | `features.lessons` at the chat level                                                                             |
| `quiet.json`, a mute until a time, by chat                         | `muted` at the chat level when the time has not passed or the mute has no end; else skipped                      |
| `mode`, `permissions.agent`, `models`, `faces.json` tones, `owner` | No new key: reported                                                                                             |

- Character pack ids are private, so the map is given on the command line and never stored in the repository.
- A chat in a state file with no binding is created too: the old core answered it with the defaults.
- A value a key's schema refuses is reported and not set. The run never guesses.
