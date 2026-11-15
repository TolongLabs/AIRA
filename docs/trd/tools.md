# Tools And Commands

One registry of atomic tools, two ways to call them, and a standby path for external tool servers.

## Registry

Each tool is defined once, in `src/tools/`.

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `name`        | Stable id, used by the model, by commands and in records                |
| `description` | What the model is told                                                  |
| `schema`      | Zod schema for the arguments                                            |
| `handler`     | One function. It receives validated arguments and the turn context      |
| `mode`        | `both`, `implicit` or `explicit`. See [Modes](#modes)                   |
| `mutates`     | True when the tool changes state. Such a tool must return a receipt     |
| `permission`  | The setting a chat needs for this tool                                  |
| `feature`     | The per-chat feature switch that enables it, if any                     |
| `timeoutMs`   | Hard limit for one call                                                 |
| `command`     | For `both` and `explicit`: the `/name`, its kind and its one-line usage |

The prompt text about tools, the leak guard's name list and `/help` are all generated from the registry. No second
list is maintained by hand.

## Atomic Tools

A tool does one thing, and that thing happens fully or not at all.

1. **One action.** A tool never takes an `action` argument that selects among several operations. Create, list and
   cancel are three tools.
2. **One transaction.** A state change is one database transaction. The receipt is built after it commits. See
   [Persistence](storage.md#what-a-write-promises).
3. **Safe to repeat.** Every call carries a call id. A handler that sees a call id it has already completed returns
   the stored result and changes nothing.
4. **No hidden second effect.** A tool that reads does not also send. A tool that sends does not also file. Sending
   a file to the chat is its own step with its own receipt.
5. **One target for a removal.** A tool that removes or cancels acts on exactly one row, named by id. It never
   matches by a shared word.
6. **Bounded.** Every call has a timeout. A handler never throws into the loop.
7. **Checked first.** Permission, feature switch and scope are checked before the handler runs, by the registry, in
   one place.

A tool that cannot meet these rules is split until each part can.

## Turn Context

A handler never receives identity from the model. The turn context carries the chat id, sender id, character id,
resolved settings, the turn id, the call id and a deadline. It is built in code at step 2 of the turn.

## Modes

| Mode       | Called By                             | Use For                                                              |
| ---------- | ------------------------------------- | -------------------------------------------------------------------- |
| `both`     | The model, or a person with a command | Anything a person may ask for in words or want done exactly          |
| `implicit` | The model only                        | Housekeeping the model does while it works. Nobody types these       |
| `explicit` | A person with a command only          | Commands that describe the bot. The model has no reason to call them |

## Implicit Calls

The model decides when to call a tool, which one, and how many, in a chain where each result feeds the next.

1. Before the model is called, code computes the tools offered for this turn: registered, mode `both` or
   `implicit`, enabled by the chat's features, allowed by its permissions, and not withheld by a turn rule.
2. Tools that are not offered are removed from the model's declarations. The model cannot call what it cannot see.
3. Each call is validated against the schema, run under its timeout, and recorded with its outcome.
4. A failure returns a typed result the model can read: `timeout`, `refused`, `invalid`, `unavailable` or `error`,
   with a short reason.

Two limits end the chain. The first one reached wins.

| Limit      | Key                     | Default | When It Is Reached                                                 |
| ---------- | ----------------------- | ------- | ------------------------------------------------------------------ |
| Call count | `tools.maxCallsPerTurn` | 4       | The tool list is withdrawn, and the model answers with what it has |
| Tool time  | `tools.timeBudgetMs`    | 15000   | The same. A call in flight is cancelled at its own timeout         |

The turn record notes which limit was reached, in `chain_limit`. Both defaults are tuned from benchmark results.

## Receipts

A tool with `mutates: true` returns a receipt: what changed, where, and the new state. The handler makes its
change through one `commit` call that the registry gives it. That call is one transaction that holds the change,
the stored result of the call (table `tool_result`, by call id) and the receipt (table `receipt`). A handler cannot
commit twice, and a tool that does not mutate cannot commit at all. Code attaches receipts to the
turn record and, when the pack asks for it, renders one line under the reply. The cleaning chain does not accept a
claim of a state change without a matching receipt from this turn.

## Explicit Calls: Text Commands

WhatsApp has no native commands, so a command is plain text, and it works like a skill call: the person names the
tool and says the rest in their own words.

```text
/remind i have a mtg ltr at 6pm, ping me by then
```

### Detection

| Rule         | Behaviour                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------ |
| Position     | The command is the first word of the message. Case does not matter                         |
| Count        | One command per message. A later `/word` is part of the text                               |
| Unknown name | `/name` that matches no command the chat may use is ordinary text and goes to the model    |
| Groups       | A registered command addresses AIRA by itself. No mention is needed                        |
| Reply-to     | When the message replies to another, the quoted message is given to the command as context |

### Two Kinds

| Kind        | Steps                                                                                                                                                                                             | Model Call |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Direct      | Code runs the handler and answers from a pack template                                                                                                                                            | None       |
| Skill-style | The model receives the free text and only the named tool, and must fill its arguments. Code validates them, runs the handler and issues the receipt. The model then writes the reply in character | One        |

### Rules For Skill-Style Commands

- **The command decides the tool.** The first call of the turn is the named tool. The model cannot pick another
  tool first, and cannot answer without calling it.
- **Code decides whether it ran.** Arguments are validated against the schema. The receipt, not the model's words,
  says what happened.
- **Unclear means ask.** When a required argument is missing or the text can be read two ways, AIRA asks one short
  question in character and runs nothing. It does not guess.
- **One target for a removal.** A command that removes or cancels must resolve to exactly one row. Two candidates
  produce a question that lists them.
- **Chaining is allowed after the named tool,** within the limits in [Implicit Calls](#implicit-calls). `/search`
  may go on to read a page.
- A command counts as one tool call toward `tools.maxCallsPerTurn`.
- **Until the named tool has been called, it is the only tool the model is offered.** A call to any other tool
  in that step is dropped. The model may instead ask its one question and call nothing.
- **The model is shown what it must choose from.** Before the model fills the arguments of `/cancel` or `/forget`,
  code runs `reminder_list` or `recall` and adds the result to the message as a labelled, untrusted block. The
  model names one row by its id, or asks.

### Direct Command Answers

A character pack has no template for a command answer yet, so code writes the answer of a direct command from the
tool's result in plain words: a list for `/help`, `/list` and `/reminders`, one fixed sentence for `/mute` and
`/unmute`. The answer still passes the cleaning chain and the bubble splitter. Pack templates for these answers
are a later change to the pack contract.

## Tool Set

### Core

| Tool              | Does                                       | Mode     | Command            | Kind        | Feature Switch       |
| ----------------- | ------------------------------------------ | -------- | ------------------ | ----------- | -------------------- |
| `recall`          | Searches what AIRA remembers in this chat  | both     | `/recall`          | Skill-style | none                 |
| `note`            | Writes one fact into this chat's memory    | both     | `/remember`        | Skill-style | none                 |
| `forget`          | Forgets one named fact                     | both     | `/forget`          | Skill-style | none                 |
| `history_search`  | Searches what was said in this chat before | both     | `/history`         | Skill-style | none                 |
| `web_search`      | Searches the web                           | both     | `/search`          | Skill-style | `features.search`    |
| `read_page`       | Opens and reads one web page               | both     | `/read`            | Skill-style | `features.search`    |
| `read_post`       | Opens one social post with its media       | both     | `/read`            | Skill-style | `features.social`    |
| `send_photo`      | Finds one real photo and sends it          | both     | `/photo`           | Skill-style | `features.photos`    |
| `reminder_set`    | Creates one reminder                       | both     | `/remind`          | Skill-style | `features.reminders` |
| `reminder_list`   | Lists this chat's reminders                | both     | `/reminders`       | Direct      | `features.reminders` |
| `reminder_cancel` | Cancels one reminder                       | both     | `/cancel`          | Skill-style | `features.reminders` |
| `set_mute`        | Stops or resumes proactive messages        | both     | `/mute`, `/unmute` | Direct      | none                 |
| `make_report`     | Writes one long answer as a document       | both     | `/report`          | Skill-style | `features.reports`   |
| `lingo_note`      | Files what one of this chat's words means  | implicit | none               |             | none                 |
| `help`            | Lists the commands this chat may use       | explicit | `/help`            | Direct      | none                 |
| `list`            | Lists the tools and features switched on   | explicit | `/list`            | Direct      | none                 |

- `/read` routes by the address: a social post goes to `read_post`, anything else to `read_page`.
- `make_report` writes the document. Sending it to the chat is a separate delivery step with its own receipt.
- The existing gateway schedule stores and fires reminders. `reminder_set` and `reminder_cancel` are the only code
  that talks to it, and each writes the `reminder` row in the same step. The row commits first, because a
  transaction cannot span a call to the gateway. The call to the schedule follows. If it fails, the row stays and
  the start-up reconciliation in [Persistence](storage.md#everything-in-flight-is-a-row) creates the missing job.
- Media watching is not a tool. It runs at intake. See [Models](models.md#media-watching).

### Lessons And Library

Built after the core set, behind `features.lessons`. Their data model is specified when that work starts.

| Tool             | Does                                       | Mode     | Command   | Kind        |
| ---------------- | ------------------------------------------ | -------- | --------- | ----------- |
| `lyrics_search`  | Finds candidate lyrics for a song          | both     | `/lyrics` | Skill-style |
| `lyrics_fetch`   | Fetches the lyrics of one search result    | implicit | none      |             |
| `song_get`       | Fetches one filed song with its readings   | both     | `/song`   | Skill-style |
| `vocab_lookup`   | Looks up one word and where it appeared    | both     | `/word`   | Skill-style |
| `song_save`      | Files one worked song as study notes       | implicit | none      |             |
| `gloss_set`      | Fills in what one word or pattern means    | implicit | none      |             |
| `library_gaps`   | Says what the library still lacks          | implicit | none      |             |
| `library_search` | Searches the library and follows its links | implicit | none      |             |
| `library_write`  | Files one library node                     | implicit | none      |             |
| `library_open`   | Reads one library node by title            | implicit | none      |             |

### Changed From The Old Tool Set

| Old Tool                        | Now                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `cronjob`                       | Split into `reminder_set`, `reminder_list` and `reminder_cancel`                            |
| `lyrics_prepare`                | Removed. It bundled several actions; the single tools replace it                            |
| `lyrics_fetch`                  | Fetches only. It no longer sends a lesson by itself                                         |
| `vision_analyze`                | Removed as a tool. Pictures are read at intake                                              |
| `send_video`                    | Never existed. It was named in a list and registered nowhere                                |
| `brain_*` names                 | Renamed as in the tables above                                                              |
| Market and coding-session tools | Not decided. See the pending inputs in the [Product Requirements](../PRD.md#pending-inputs) |

### Faults This Design Removes

| Fault In The Old System                                | Rule That Removes It                      |
| ------------------------------------------------------ | ----------------------------------------- |
| No timeout on a tool call                              | Bounded                                   |
| Every tool registered twice, once per loop             | One registry, one loop                    |
| A save reports failure after it worked                 | One transaction, receipt after commit     |
| Forget can retire three facts that share a word        | One target for a removal                  |
| A report tool with no chat or permission check         | Checked first                             |
| Reminders that are never written to the reminder store | One transaction, one writer for reminders |

## External Tool Servers

The core is a Model Context Protocol client. This path is built and tested but ships with no server enabled.

```yaml
mcp:
  servers:
    - id: example
      transport: stdio
      command: ['example-server']
      tools: ['lookup'] # allowlist; anything else is ignored
      chats: [] # chat ids that may use it; empty means none
      timeoutMs: 10000
```

- A server's tools enter the registry under `<server id>.<tool>` with mode `implicit`, `mutates: true` assumed and
  no command.
- A model sees the name with the dot written as two underscores, as in `example__lookup`, because model APIs
  accept no dot in a function name. Records keep the registry name.
- A chat uses a server only when it is in the server's `chats` list and its setting `mcp.<server id>` is on.
- A server's tool description is cut to one line of 500 characters before it enters the prompt.
- A server process gets a minimal environment. It never receives the core's secrets.
- Only allowlisted tools are registered, and only for the listed chats.
- Results from an external server are untrusted text and are labelled as such in the prompt.
- An external tool cannot be made atomic by the core. Its calls count toward both limits, and its results never
  produce a receipt.
- A server that fails to start, or times out, is marked unavailable. The turn continues without it.

The core is also a Model Context Protocol server for one client only: the subscription runner. It serves the same
registry over that protocol so both runners use identical tools. See [Models](models.md).

## Configuration

| Key                      | Default | Effect                               |
| ------------------------ | ------- | ------------------------------------ |
| `tools.maxCallsPerTurn`  | 4       | Limit on tool calls in one turn      |
| `tools.timeBudgetMs`     | 15000   | Limit on total tool time in one turn |
| `tools.defaultTimeoutMs` | 15000   | Timeout when a tool sets none        |
| `search.provider`        | `off`   | Web search backend, or `off`         |
| `mcp.servers`            | `[]`    | External tool servers                |
