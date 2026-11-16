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

`config.yml` is validated at start-up against one schema. An unknown key or a wrong type stops start-up.

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
| `turn`, `model_call`, `tool_call`, `failure`, `job_run`, `failure_diagnostics` | Records                                                                                                      | [Records](records.md)             |
| `spend`                                                                        | Cost per role per month                                                                                      | [Models](models.md)               |
| `chat_state`                                                                   | Runtime state by chat and character: last opener, sticker                                                    | [Prompt Engine](prompt-engine.md) |
| `inbound_message`, `schema_migration`, `backup_run`, `file`                    | Inbound requests by chat and gateway message id, applied migrations, snapshot runs, files on the data volume | [Persistence](storage.md)         |

### Chats And Identities

Record tables and logs never hold a WhatsApp id. Code maps each one to an internal id at the door.

- **Chat.** `chat` maps a chat's WhatsApp id to an internal `chat_id`. Every other table uses the internal id. The
  first message from an unseen chat creates its row as `pending`. A pending chat gets no reply: the turn ends at
  admission check 1 in [Reliability](reliability.md#turn-admission), with an operator alert. The owner site, the
  migration or an operator command sets a chat `active`.
- **Subject.** `identity` maps each WhatsApp id of a person to one `subject_id`. A sender seen for the first time
  gets a new subject. Two ids of one person are joined by the site or the migration, never by a model.

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

| Key                  | Type                          | Default (Global) |
| -------------------- | ----------------------------- | ---------------- |
| `character`          | Character pack id             | Set at install   |
| `language`           | `auto` or a language code     | `auto`           |
| `freeResponse`       | Boolean                       | `false`          |
| `allowedSenders`     | List of subject ids, or `all` | `all`            |
| `model`              | Role override, or `inherit`   | `inherit`        |
| `replyLength`        | `short`, `default`, `long`    | `default`        |
| `expressions`        | Boolean                       | `true`           |
| `quietHours`         | Start, end and time zone      | Unset            |
| `muted`              | Boolean, with who and when    | `false`          |
| `features.proactive` | Boolean                       | `false`          |
| `features.reminders` | Boolean                       | `true`           |
| `features.search`    | Boolean                       | `true`           |
| `features.social`    | Boolean                       | `true`           |
| `features.photos`    | Boolean                       | `true`           |
| `features.media`     | Boolean                       | `true`           |
| `features.voice`     | Boolean                       | `false`          |
| `features.lessons`   | Boolean                       | `false`          |
| `features.reports`   | Boolean                       | `true`           |
| `mcp.<server id>`    | Boolean                       | `false`          |

Each optional chat feature is one `features.*` key. A tool or behaviour names the key that enables it.

### Resolution Rules

- `resolve(chat)` returns every key with its value and the level it came from. The site shows that level.
- A value that fails its schema is rejected at write time. The store never holds an invalid value.
- A `character` that names a missing or invalid pack makes the binding invalid. The chat stops and the operator is
  alerted. Resolution never substitutes another character.
- Every write goes through one function that validates, writes and logs the change in one transaction.
- A change applies to the next turn. No restart is needed.

## Migration From The Old Store

The one-time migration reads the old binding file, per-chat state files and memory stores, and writes the tables
above. Old values that have no new key are listed in the migration report, not dropped silently. Memory migration is
specified in [Memory](memory.md#migration).

`bun run migrate:settings --from <private copy> --character <old personality>=<pack id> ...` is the dry run: it
prints the plan as counts and reasons, and writes nothing. Adding `--confirm` applies it in one transaction, with the
core stopped. A second real run changes nothing. It runs before the memory import, because that import needs the
chats. The copy holds the old `bindings.yaml` and the brain folder's `language.json`, `lessons.json`, `faces.json`
and `quiet.json`. Measured on the production host's layout, 16 Nov 2026:

| Old Value                                                                                   | New                                                                                                              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A binding's `match` (platform `whatsapp`, kind, chat)                                       | The chat row, set `active`                                                                                       |
| `defaults.personality`, a binding's `personality`                                           | `character` at the global or chat level, through the `--character` map. An unmapped name is reported and not set |
| A binding's `permissions.photos`                                                            | `features.photos` at the chat level                                                                              |
| `language.json`, by chat                                                                    | `language` at the chat level, when it is `auto` or a language code                                               |
| `lessons.json`, by chat                                                                     | `features.lessons` at the chat level                                                                             |
| `quiet.json`, a mute until a time, by chat                                                  | `muted` at the chat level when the time has not passed or the mute has no end; else skipped                      |
| `mode`, `permissions.agent`, `permissions.autofetch`, `models`, `faces.json` tones, `owner` | No new key: reported                                                                                             |

- Character pack ids are private, so the map is given on the command line and never stored in the repository.
- A chat in a state file with no binding is created too: the old core answered it with the defaults.
- A value a key's schema refuses is reported and not set. The run never guesses.
