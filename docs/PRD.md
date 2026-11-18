# Product Requirements

What AIRA must do, for whom, and how far each requirement stands today. Contracts will live in `TRD.md`.

Status: draft 0.1, 15 Nov 2026. Not yet approved by the owner.

## At a Glance

| Item     | Value                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| Product  | A WhatsApp chatbot agent that plays a configured character in each chat                     |
| Users    | The owner, his family and his clients who chat with it, and the two maintainers who run it  |
| Surfaces | WhatsApp DMs and small groups: mention, reply, free-response chats, and text slash commands |
| Host     | One Linux machine on a private network, behind the Hermes Agent WhatsApp gateway            |
| Scope    | The chatbot only. The owner's operations tools on the same machine are out of scope         |
| Status   | 46 requirements: 24 Shipped, 20 Partial, 1 Exists (faulty), 1 Planned                       |

## Problem

AIRA answers real people in live chats, and it fails them in ways they notice. Measured on the live system in the
week after its last redesign (64 chat turns, 4 chats):

- **Slow.** Median reply 18 s, 90th percentile 43 s, and 27 s median when a tool is called. The owner's target is 5 s.
- **Inconsistent.** The model subscription hit its limit 16 times. Each time, every chat moved to different models on
  a second agent loop with a different prompt and tool set.
- **Forgetful.** The memory file has no lock. Each rewrite replaces the whole file and drops lines it cannot parse.
  Three processes write it.
- **Unreliable tools.** Every tool is registered twice, once per loop. A tool call has no timeout. A save can report
  failure after it succeeded.
- **Regressed.** The last redesign dropped the mute check at delivery, the reminder store writer, the fact check on
  saved memories and lesson settlement.
- **Fragile storage.** State sits in text files, JSON files and several databases. Jobs save their state only when
  they finish, so a restart repeats or loses them. When the host's disk filled, the database could not be opened,
  and every backup was on that same disk.
- **Hard to diagnose.** One summary line is logged per turn. Finding the causes above took a full audit.

The code that produces this is about 133,000 lines of Python around a pinned, patched copy of Hermes Agent. One
person cannot maintain it, and a second maintainer cannot learn it.

## Objectives

1. **One Character Per Chat:** each DM or group is bound to a character card and its own settings.
2. **In Character By Construction:** expression, mood, tone and reply format are chosen and enforced by code, not left
   to prompt wording.
3. **Fast And Steady:** one agent loop, one tool set, one voice, with replies inside the latency targets below.
4. **Memory That Holds:** typed records, one writer, validated input, and no fact ever leaving its chat.
5. **Explainable Failures:** every turn and every failure leaves a record that supports a post-mortem.
6. **Testable Without Users:** a harness simulates, replays and benchmarks AIRA offline, and gates changes.
7. **Safe Across Restarts:** a restart, a full disk or a lost disk loses nothing that was acknowledged.
8. **Maintainable By Two:** a public repository, clear documents, and a codebase both maintainers can read.

## Target Users

| User Type    | Description                                         | Primary Need                                            |
| ------------ | --------------------------------------------------- | ------------------------------------------------------- |
| Chat Members | Family and clients in DMs and small WhatsApp groups | Quick, in-character, correct replies that remember them |
| The Owner    | Runs the machine and talks to AIRA daily            | A bot that does what it says, at a known cost           |
| Maintainers  | The owner and one other developer                   | Find a fault from records, fix it, prove the fix        |

Volume is small: 4 to 16 chat turns a day across about 4 active chats. Reliability and speed matter more than cost
per reply.

## User Workflow

1. A member writes in a DM, or mentions or replies to AIRA in a group.
2. The gateway hands the message to AIRA with the chat's identity. AIRA never takes identity from the model.
3. AIRA resolves the chat's binding: character card, settings, permissions and mute state.
4. If the text starts with a known slash command, AIRA runs that command's handler and replies.
5. Otherwise AIRA builds the turn: recent messages, recalled memory, detected mood and a reply shape.
6. The model answers and may call tools. Retries and a same-family fallback cover failures inside a deadline.
7. Code cleans and formats the reply for WhatsApp, splits it into bubbles and sends it, with an expression image when
   the card has one.
8. The turn record is written. Memory extraction continues in the background.

## Functional Requirements

Status values: **Planned** (not built), **Exists (faulty)** (kept from the old core where no audit covered
it), **Partial** (built in part; the gap is named in `docs/trd/traceability.md`), **Shipped** (built and evidenced
at this commit).

### Conversation

| ID   | Requirement                                                                                                                           | Status  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-1 | Answer every DM from an allowed sender. In a group, answer a mention, a reply to AIRA, or any message in a chat set to free response. | Partial |
| FR-2 | Keep one conversation window per chat, rebuilt from storage after a restart.                                                          | Shipped |
| FR-3 | Merge messages sent in quick succession into one turn. Allow one active turn per chat.                                                | Shipped |
| FR-4 | Run exactly one agent loop per turn. No second loop with a different prompt or tool set may answer a chat.                            | Shipped |
| FR-5 | Honour mute and quiet hours on every delivery path, including proactive and scheduled messages.                                       | Partial |

### Characters And Per-Chat Settings

| ID    | Requirement                                                                                                                                                                                                                                                                                                         | Status          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| FR-6  | Load characters from character cards: identity, speech, moods, lines for errors and refusals, optional assets. Validate each card at start-up and refuse a bad one with a clear message.                                                                                                                            | Shipped         |
| FR-7  | Bind each chat to one character card. Two chats may use two characters at the same time.                                                                                                                                                                                                                            | Exists (faulty) |
| FR-8  | Resolve each chat's settings through a hierarchy: global defaults, then chat type (DM or group), then the chat instance. The nearest level wins. Settings cover character, language, free response, permissions, model override, proactive messages, voice, and an on or off switch for each optional chat feature. | Shipped         |
| FR-9  | Fail loudly on a broken binding or settings file. Never fall back silently to a default character.                                                                                                                                                                                                                  | Shipped         |
| FR-10 | Key all behaviour state by chat and by character. No mood, breaker or learned style may be shared across characters by accident.                                                                                                                                                                                    | Partial         |

### Expression, Mood And Tone

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| FR-11 | Each card defines its own moods. Detect the mood for a turn with rules at no model cost. An optional small judge model may override the rules above a set confidence; if it fails, the rule result stands.                                                                                                                                                                                                                                                                                 | Shipped |
| FR-12 | For the detected mood, code draws the reply shape: opener, ending, faces and length. Length has a fixed default. Code lifts it only for listed cases, such as an explicit request for detail or a research answer. The model receives the shape as the last prompt block.                                                                                                                                                                                                                  | Shipped |
| FR-13 | Expression images are optional per card and per mood, stored in the card's asset folder and chosen by code for the detected mood without repeating the last one. On WhatsApp an expression is sent as a native sticker message (WebP, 512 by 512 pixels, within WhatsApp's sticker size limit) in a second message after the text reply. Card images are converted to that format when the card is saved. A card or mood with no image sends text only. A chat can switch expressions off. | Partial |
| FR-14 | Send every error, limit and refusal as an in-character line from the card. Never send raw error text to a chat.                                                                                                                                                                                                                                                                                                                                                                            | Partial |

### Reply Formatting

| ID    | Requirement                                                                                                                                                                                                                  | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-15 | Render replies in the markup WhatsApp supports: bold, italic, strikethrough, monospace, inline code, bulleted and numbered lists, block quotes. Convert or remove everything else, including headings, tables and link text. | Shipped |
| FR-16 | Apply one fixed cleaning chain to every reply: remove narrated tool calls and name tags, enforce the reply shape, repair list formats, then check for leaked prompt text.                                                    | Shipped |
| FR-17 | Honour an explicit format request from the user over the default shape and the default length.                                                                                                                               | Partial |
| FR-18 | Split long replies into bubbles at a paragraph, else a sentence, else a word. Never cut inside a code block or list item.                                                                                                    | Partial |

### Tools And Commands

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                        | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-19 | Define each tool once in one registry: name, schema, handler, mode, permission, timeout, whether it changes state. Every tool is atomic: one action, one transaction, safe to repeat, and a removal acts on exactly one named row.                                                                                                                                                                                                 | Shipped |
| FR-20 | Implicit use: the model decides when, which and how many tools to call, in a chain. Code removes tools the chat may not use before the model sees them. A chain ends at the chat's call limit (`tools.maxPerMessage`, default 3, under a deployment ceiling of 8) or a tool-time limit of 15 s.                                                                                                                                    | Partial |
| FR-21 | Explicit use: a `/name` anywhere in a message that matches a registered command names the tool, and the rest of the message is free text, as in `/remind i have a mtg ltr at 6pm`. The model fills the tool's arguments, code validates them and runs the handler, and the receipt says what happened. Up to the chat's `commands.maxPerMessage` commands per message (default 1). An unknown `/name` is treated as ordinary text. | Partial |
| FR-22 | Ship a first command set: `/help`, `/list`, `/recall`, `/remember`, `/forget`, `/history`, `/search`, `/photo`, `/remind`, `/reminders`, `/cancel`, `/mute`, `/unmute` and `/report`. An unclear command asks one short question and runs nothing. A command that removes something must resolve to exactly one target.                                                                                                            | Shipped |
| FR-23 | Give every tool call a timeout and a typed result. Every state change returns a receipt written by code; no receipt means it did not happen.                                                                                                                                                                                                                                                                                       | Shipped |
| FR-24 | Ship the core tool set, each tool marked as callable by the model, by command, or both: recall, note, forget, chat history search, web search, read a page, read a social post, send a photo, set, list and cancel a reminder, mute, write a report, and note a chat's own word.                                                                                                                                                   | Shipped |
| FR-39 | Watch media a member sends, embeds or links, including video from social posts, through a dedicated media model (planned: `gemini-3.5-flash-lite`) with its own key, under size and time limits. Say so in character when a file cannot be read.                                                                                                                                                                                   | Partial |
| FR-46 | Send a linked post's own media in a group whose switch is on (off by default): a message with up to 3 supported post links gets each post's video and photos back, up to 10 files a post, with no reply text and no model call. Never a thumbnail, link card or profile picture. A post that cannot be read sends nothing.                                                                                                         | Shipped |
| FR-44 | Provide the lessons and library tools behind a per-chat switch: lyrics, songs, vocabulary, glosses and the library. They follow the same registry rules and are built after the core set.                                                                                                                                                                                                                                          | Shipped |
| FR-25 | Host external tool servers through the Model Context Protocol. A server is added in configuration with an allowlist of its tools and the chats that may use them. No external server is enabled at launch.                                                                                                                                                                                                                         | Partial |

### Memory

| ID    | Requirement                                                                                                                                                                                                                                        | Status  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-26 | Store memory as typed records (facts, episodes, media) in one database with constraints and unique keys. No free-text memory file.                                                                                                                 | Partial |
| FR-27 | Write through one queue and one transaction per change. Failed jobs retry on a schedule and are never dropped silently.                                                                                                                            | Shipped |
| FR-28 | Extract in two roles: a hosted small judge model decides whether an episode is worth extracting and confirms each proposed change; the main model proposes the changes. The judge fails closed.                                                    | Shipped |
| FR-29 | Scope every record to its chat instance (one group or one DM) and to the person it is about. Facts may be used freely inside the chat they came from, including about other members of that chat. A fact never crosses into another chat instance. | Shipped |
| FR-30 | Recall for each turn within a fixed budget, and offer recall and forget as tools. "Forget" removes only the fact the user named and leaves a tombstone.                                                                                            | Shipped |
| FR-31 | Migrate existing memory into the new store. Never wipe it. Take a backup, run a dry run, and report what was kept, merged and rejected before the real run.                                                                                        | Partial |

### Owner Site

| ID    | Requirement                                                                                                                                                                                                                                                                                                                    | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| FR-40 | Revamp the existing owner site as the chatbot's console, under the site's own design contract (`DESIGN.md`). It stays on the private network behind its token. Its chat and settings pages show every chat instance and edit the hierarchy in FR-8, showing at each level which values are inherited and which are overridden. | Partial |
| FR-41 | Add a character studio page to the site: create and edit a character card, its moods, lines and expression images, validate it, and preview its prompt. A saved card appears as a choice in chat settings.                                                                                                                     | Planned |
| FR-42 | Write every site change through the same validation as start-up, under one lock, with a record of who changed what and when. A change applies to the next turn without a restart. The site never replaces a file it could not parse.                                                                                           | Partial |

### Models

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                                                   | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-32 | Choose the model transport in the root configuration file: an OpenAI-compatible API with a key, or the subscription command-line wrapper. The rest of the system behaves the same on both. The launch default is the faster one in a recorded benchmark; the API key is the default until that benchmark exists.                                                                                              | Partial |
| FR-33 | Retry transient model errors inside a turn deadline, then fall back to a second model on the same loop with the same prompt and tools. Stop at a monthly spend cap.                                                                                                                                                                                                                                           | Shipped |
| FR-45 | Think deeper on request. A message that starts with `/think` runs that one turn at a higher effort set per role, and the prefix is not sent to the model. Manual use is required. A per-chat switch turns it on or off, and the turn record notes the raised effort. Optional, later: code raises effort on its own from listed reply-shape signals, only if the harness shows the command misses real cases. | Shipped |

### Records And Test Harness

| ID    | Requirement                                                                                                                                                                                                                                             | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FR-34 | Give every turn an id and write one turn record: chat, character, stage timings, model and transport, real token counts and cost, each tool call with its outcome, retries, fallbacks, the cleaning steps applied, and what was delivered.              | Shipped |
| FR-35 | Classify every failure by kind, and record it with the turn id, the stage and the full error. Record background jobs (memory, reminders, proactive) the same way.                                                                                       | Partial |
| FR-36 | Redact message text, phone numbers and keys from logs by default. Keep verbatim text only in a short-lived diagnostics store with a stated retention.                                                                                                   | Partial |
| FR-37 | Provide a harness that runs AIRA without WhatsApp: scripted conversations, recorded model replies replayed without live calls, a memory simulator with ground truth, and latency and cost benchmarks.                                                   | Partial |
| FR-38 | Gate every change in CI on the harness: prompt size ceiling, format rules, memory checks for privacy leaks and lost writes, and the unit tests.                                                                                                         | Partial |
| FR-43 | Provide a WhatsApp simulator in the harness: a fake bridge that stands in for the WhatsApp bridge, and a chat preview that draws what a member would see. A maintainer can check a reply's formatting, bubble order and sticker without using WhatsApp. | Shipped |

## Non-Functional Requirements

| ID     | Area                | Requirement                                                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NFR-1  | Latency             | Casual chat with no tool call: reply within 5 to 7 s at the median, 10 s at the 90th percentile. A request that needs tools or media may take longer, with a ceiling of 25 s at the 90th percentile and a visible typing state throughout. Today: 7 s and 11 s without tools, 27 s and 49 s with tools.                                          |
| NFR-2  | Prompt Size         | System prompt under a fixed token ceiling, enforced by a test (proposed: 8,000). Today about 43,000 per turn.                                                                                                                                                                                                                                    |
| NFR-3  | Consistency         | The same prompt, tools and cleaning chain on every turn, whichever model answers.                                                                                                                                                                                                                                                                |
| NFR-4  | Durability          | No acknowledged write is lost on a crash or a concurrent write. Proven by the memory simulator and the restart suite.                                                                                                                                                                                                                            |
| NFR-5  | Privacy             | No real name, phone number or WhatsApp id in the repository, its history, logs or test fixtures.                                                                                                                                                                                                                                                 |
| NFR-6  | Security            | No secret in the repository. Tools run with the chat's permissions only. Network services bind to loopback or the private network and require a token.                                                                                                                                                                                           |
| NFR-7  | Operability         | A tagged release builds a container image. The host checks for a new release on a timer, deploys it without a manual step, runs a health check, and returns to the previous image if the check fails. No outside system holds a key to the host. Old images are pruned on every deploy. Configuration errors stop start-up with a clear message. |
| NFR-8  | Cutover             | One switch in one night, at midnight Malaysia time, for all chats. Before that night the new core must pass the harness gates and a shadow period in which it processes real turns without sending. Rollback is one step and leaves the old memory untouched.                                                                                    |
| NFR-9  | Maintainability     | Small modules with one job each. Documents kept current: PRD, TRD, runbook, decisions.                                                                                                                                                                                                                                                           |
| NFR-10 | Cost                | A monthly spend cap in configuration, with background work stopping before replies do.                                                                                                                                                                                                                                                           |
| NFR-11 | Restart Safety      | A restart at any moment loses no acknowledged write, sends no reply twice and leaves no work stuck. Proven by the restart suite.                                                                                                                                                                                                                 |
| NFR-12 | Backup And Recovery | A verified, encrypted copy of the database and files exists off the host and is at most 15 minutes old. A restore takes at most 30 minutes and is rehearsed before cutover.                                                                                                                                                                      |

## Non-Goals

- The owner's operations tools: market alerts, news digest, coding-session notices and delegation, and file sending.
  They keep working as they do today. Their pages on the owner site keep their function when the site is revamped.
- Replacing or upgrading Hermes Agent. It stays as the WhatsApp transport at its pinned version. Measured on
  15 Nov 2026: 55 of its 67 local patches fail against current upstream, and upstream ships the same WhatsApp library.
- A second chat platform.
- New chat features beyond those listed, until the listed ones meet their targets.

## Tracking

Each group of requirements has one issue. An issue lists its requirements as a checklist and links back here.

| Requirements                      | Issue                                                 |
| --------------------------------- | ----------------------------------------------------- |
| FR-1 to 5                         | [#7](https://github.com/TolongLabs/AIRA/issues/7)     |
| FR-6, FR-7, FR-9, FR-10           | [#8](https://github.com/TolongLabs/AIRA/issues/8)     |
| FR-8                              | [#9](https://github.com/TolongLabs/AIRA/issues/9)     |
| FR-11, FR-12, FR-14               | [#10](https://github.com/TolongLabs/AIRA/issues/10)   |
| FR-15 to 18                       | [#11](https://github.com/TolongLabs/AIRA/issues/11)   |
| FR-13                             | [#12](https://github.com/TolongLabs/AIRA/issues/12)   |
| FR-19, FR-20, FR-23, FR-24        | [#13](https://github.com/TolongLabs/AIRA/issues/13)   |
| FR-21 to 22                       | [#14](https://github.com/TolongLabs/AIRA/issues/14)   |
| FR-25                             | [#15](https://github.com/TolongLabs/AIRA/issues/15)   |
| FR-26 to 30                       | [#16](https://github.com/TolongLabs/AIRA/issues/16)   |
| FR-31                             | [#17](https://github.com/TolongLabs/AIRA/issues/17)   |
| FR-32 to 33                       | [#18](https://github.com/TolongLabs/AIRA/issues/18)   |
| FR-39                             | [#19](https://github.com/TolongLabs/AIRA/issues/19)   |
| FR-34 to 36                       | [#20](https://github.com/TolongLabs/AIRA/issues/20)   |
| FR-37 to 38                       | [#21](https://github.com/TolongLabs/AIRA/issues/21)   |
| FR-40 to 42                       | [#22](https://github.com/TolongLabs/AIRA/issues/22)   |
| NFR-7                             | [#23](https://github.com/TolongLabs/AIRA/issues/23)   |
| NFR-8                             | [#24](https://github.com/TolongLabs/AIRA/issues/24)   |
| FR-43                             | [#33](https://github.com/TolongLabs/AIRA/issues/33)   |
| Cutover readiness: NFR-1 to NFR-5 | [#32](https://github.com/TolongLabs/AIRA/issues/32)   |
| NFR-4, NFR-11                     | [#35](https://github.com/TolongLabs/AIRA/issues/35)   |
| NFR-12                            | [#36](https://github.com/TolongLabs/AIRA/issues/36)   |
| FR-44                             | [#38](https://github.com/TolongLabs/AIRA/issues/38)   |
| FR-45                             | [#90](https://github.com/TolongLabs/AIRA/issues/90)   |
| FR-46                             | [#214](https://github.com/TolongLabs/AIRA/issues/214) |

## Pending Inputs

| #   | Input                                                                                                                                                         | Waiting on  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | Key for the media model (FR-39).                                                                                                                              | The owner   |
| 2   | Transport benchmark: wrapper against API key, on the live machine (FR-32).                                                                                    | Maintainers |
| 3   | Confirmation that the owner site may be revamped (FR-40 to FR-42).                                                                                            | The owner   |
| 4   | Language and agent kit for the chatbot core, and how it attaches to the gateway. Decided in the TRD.                                                          | Maintainers |
| 5   | The off-host backup destination: another machine on the private network, or a storage bucket (NFR-12).                                                        | The owner   |
| 6   | What serves the six owner tools in chat after cutover (four market tools, two coding-session tools). The old core that runs them today is retired that night. | The owner   |
