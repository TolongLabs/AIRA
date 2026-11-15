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

One file on the data volume, opened in WAL mode with foreign keys on. Only the core process opens it for writing.
Schema changes are numbered migrations applied at start-up inside a transaction.

| Table                                                                          | Purpose                                                 | Owner Module                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------- |
| `chat`                                                                         | One row per chat instance: id, type, label              | This module                       |
| `identity`                                                                     | Maps WhatsApp ids for one person to one subject id      | This module                       |
| `setting`                                                                      | The settings hierarchy                                  | This module                       |
| `setting_change`                                                               | Change log for settings and packs                       | [Records](records.md)             |
| `session_message`                                                              | The conversation window                                 | [System](system.md)               |
| `memory_item`, `memory_job`, `memory_event`                                    | Memory                                                  | [Memory](memory.md)               |
| `reminder`                                                                     | Reminders and their gateway job ids                     | [Tools](tools.md)                 |
| `turn`, `model_call`, `tool_call`, `failure`, `job_run`, `failure_diagnostics` | Records                                                 | [Records](records.md)             |
| `spend`                                                                        | Cost per role per month                                 | [Models](models.md)               |
| `chat_state`                                                                   | Per-chat runtime state: last opener, last sticker, mute | [Prompt Engine](prompt-engine.md) |

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

## Backups

A daily job writes a consistent copy of the database with SQLite's backup call, keeps `backup.keepDays` copies, and
records the run. The deploy and the migration each take a backup first.
