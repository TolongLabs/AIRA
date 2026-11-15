# Tools And Commands

One registry of tools, two ways to call them, and a standby path for external tool servers.

## Registry

Each tool is defined once, in `src/tools/`.

| Field         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `name`        | Stable id, used by the model, by commands and in records              |
| `description` | What the model is told                                                |
| `schema`      | Zod schema for the arguments                                          |
| `handler`     | One function. It receives validated arguments and the turn context    |
| `mutates`     | True when the tool changes state. Such a tool must return a receipt   |
| `permission`  | The setting a chat needs for this tool                                |
| `timeoutMs`   | Hard limit for one call                                               |
| `command`     | Optional. The `/name` and argument grammar that call the same handler |
| `feature`     | Optional. The per-chat feature switch that enables it                 |

The prompt text about tools, the leak guard's name list and `/help` are all generated from the registry. No second
list is maintained by hand.

## Turn Context

A handler never receives identity from the model. The turn context carries the chat id, sender id, character id,
resolved settings, the turn id and a deadline. It is built in code at step 2 of the turn.

## Implicit Calls

1. Before the model is called, code computes the tools offered for this turn: registered, enabled by the chat's
   features, allowed by its permissions, and not withheld by a turn rule.
2. Tools that are not offered are removed from the model's declarations. The model cannot call what it cannot see.
3. Each call is validated against the schema, run under its timeout, and recorded with its outcome.
4. A failure returns a typed result the model can read: `timeout`, `refused`, `invalid`, `unavailable` or `error`,
   with a short reason. A handler never throws into the loop.
5. A turn allows at most `tools.maxCallsPerTurn` calls.

## Receipts

A tool with `mutates: true` returns a receipt: what changed, where, and the new state. Code attaches receipts to the
turn record and, when the pack asks for it, renders one line under the reply. The cleaning chain does not accept a
claim of a state change without a matching receipt from this turn.

## Explicit Calls: Text Commands

WhatsApp has no native commands, so a command is plain text.

- **Detection.** A message whose first token is `/name`, where `name` is a registered command the chat may use, is a
  command. In a group it must also be addressed to AIRA, like any other message.
- **Unknown Names.** `/name` that matches no command is ordinary text and goes to the model.
- **Parsing.** The rest of the line is parsed by the command's grammar into the tool's schema. A parse failure
  replies with the command's usage line from the registry.
- **Execution.** The command calls the tool's handler directly, with the same context, timeout, permission check and
  receipt. No model call is made unless the command is defined to need one.
- **Reply.** The result is rendered by a fixed template in the character's voice, taken from the pack's lines.

First command set:

| Command            | Does                                                  | Shares A Handler With |
| ------------------ | ----------------------------------------------------- | --------------------- |
| `/help`            | Lists the commands this chat may use                  | Registry only         |
| `/list`            | Lists the tools and features switched on in this chat | Registry and settings |
| `/remind`          | Creates a reminder                                    | `set_reminder`        |
| `/reminders`       | Lists or cancels reminders                            | `list_reminders`      |
| `/recall`          | Shows what AIRA remembers in this chat                | `recall`              |
| `/forget`          | Forgets one named fact                                | `forget`              |
| `/search`          | Runs a web search and answers from it                 | `web_search`          |
| `/mute`, `/unmute` | Stops and resumes proactive messages in this chat     | `set_mute`            |

## Tool Set At Launch

Memory recall, note and forget. Web search and read a page. Read a social post. Send a photo. Reminders. Mute.
Media watching is not a tool: it runs at intake. See [Models](models.md).

The existing gateway cron stores and fires reminders. The reminder handler is the only code that talks to it, and it
writes the reminder row in SQLite in the same step.

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

- A server's tools enter the registry under `<server id>.<tool>` with `mutates: true` assumed and no command.
- Only allowlisted tools are registered, and only for the listed chats.
- Results from an external server are untrusted text and are labelled as such in the prompt.
- A server that fails to start, or times out, is marked unavailable. The turn continues without it.

The core is also a Model Context Protocol server for one client only: the subscription runner. It serves the same
registry over that protocol so both runners use identical tools. See [Models](models.md).

## Configuration

| Key                      | Default | Effect                          |
| ------------------------ | ------- | ------------------------------- |
| `tools.maxCallsPerTurn`  | 6       | Limit on tool calls in one turn |
| `tools.defaultTimeoutMs` | 15000   | Timeout when a tool sets none   |
| `search.provider`        | `off`   | Web search backend, or `off`    |
| `mcp.servers`            | `[]`    | External tool servers           |
