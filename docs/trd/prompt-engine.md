# Prompt Engine

How a character pack becomes a prompt, how mood and reply shape are chosen in code, and how a reply is cleaned and
rendered for WhatsApp.

## Character Pack

A pack is one folder named by its id. The loader validates it at start-up and when the site saves it.

Packs are read from two places. A pack on the data volume wins over one in the repository with the same id.

| Location                              | Holds                                             | In Git |
| ------------------------------------- | ------------------------------------------------- | ------ |
| `characters/<id>/` in the repository  | One example pack, used by tests and as a template | Yes    |
| `characters/<id>/` on the data volume | Real character packs and their stickers           | No     |

Real character packs are private. They never enter the repository, the release image, test fixtures or recordings.

| File        | Holds                                                                                       | Required |
| ----------- | ------------------------------------------------------------------------------------------- | -------- |
| `card.yml`  | Id, display name, languages, core identity, speech rules, default reply length, tool footer | Yes      |
| `moods.yml` | The mood list: key, detection rules, tone guidance, openers, endings, faces                 | Yes      |
| `lines.yml` | Fixed lines for errors, limits, refusals, busy, unreadable media and unavailable            | Yes      |
| `stickers/` | Expression images per mood, already converted to WhatsApp sticker format                    | No       |

- A pack that fails validation is not loaded. A chat bound to it stops with an operator alert. It never falls back to
  another character (PRD FR-9).
- Every mood named in the rules must exist in `moods.yml`. Every line kind the core can send must exist in
  `lines.yml`. The validator checks both.
- The `unavailable` line is what a chat sees when the core cannot be reached. At start-up, and whenever the global
  default character changes, the core writes that pack's line to `<hostDataDir>/gateway/unavailable.txt`, where the
  gateway's failure helper reads it. See [System](system.md#gateway-helper-modules).

## Prompt Blocks

The system prompt is assembled in a fixed order. Blocks 1 to 3 are stable per character and form the cached prefix.

| #   | Block         | Source                                                                | Changes Per Turn |
| --- | ------------- | --------------------------------------------------------------------- | ---------------- |
| 1   | Core          | `card.yml` identity                                                   | No               |
| 2   | Speech        | `card.yml` speech rules                                               | No               |
| 3   | Harness Rules | `prompts/` (tools, memory, safety, format)                            | No               |
| 4   | Context       | Chat type, members present, time, recalled memory, media descriptions | Yes              |
| 5   | Tone          | The detected mood's guidance                                          | Yes              |
| 6   | Reply Shape   | Drawn by code for this turn                                           | Yes              |

- Blocks 4 to 6 carry only labelled data and short instructions. User text never enters the system prompt.
- **Media in block 4.** When the sender attached files, block 4 ends with a line saying the model cannot open them,
  then a `<media untrusted="true">` block: one line per file with its kind and description, and the transcript on a
  second line when there is speech. Line breaks and `<media` tags are stripped from the text. The whole block is
  clipped to 4,500 characters, shared evenly between the files, so media cannot push the prompt over its ceiling.
  A file that could not be read adds a short `<media-unreadable>` note with its kind, the reason, and the pack's
  `unreadableMedia` line. The model says that line in its own voice. A message that holds only a file has no text,
  and a model API refuses an empty message, so the model sees `(no text, only a file)` in its place. See
  [Models](models.md#media-watching).
- The whole prompt stays under the ceiling in `config.yml` (`prompt.maxSystemTokens`, default 8,000). A test builds
  the prompt for every pack and fails above it.

## Mood Detection

1. **Rules.** Each mood has patterns in `moods.yml`. Code scores the newest user messages in the window and picks
   the best match, or the pack's default mood. This costs no model call.
2. **Judge Override.** When `judge.mood` is on, the judge model receives the mood list and the recent messages. Its
   choice replaces the rule result when its probability is at or above `judge.moodMinProbability`.
3. **Failure.** A judge timeout or error keeps the rule result. The turn record notes which source chose the mood.

Mood state is keyed by chat and character. AIRA's own replies are excluded from rule scoring.

## Reply Shape

Code draws the shape after the mood is known. The model receives it as block 6.

| Element | Drawn From                                                          |
| ------- | ------------------------------------------------------------------- |
| Length  | The pack's default, unless a bypass applies                         |
| Opener  | The mood's opener set, not repeating the last one used in this chat |
| Ending  | The mood's ending set                                               |
| Faces   | The mood's face set, with a per-reply limit                         |

**Lengths.** The limits count characters, not words: `short` 280, `default` 600, `long` 1,400. The pack's
`defaultReplyLength` picks one.

**Length bypass.** Code lifts the default length only in these cases. The bypass and its reason are written to the
turn record.

| Case                                                                                  | Detected                             | Limit               |
| ------------------------------------------------------------------------------------- | ------------------------------------ | ------------------- |
| An explicit request for detail or a form: table, steps, list, code, detail            | In the newest message, at build      | None                |
| A research answer: the turn ran `web_search`, `read_page` or `read_post` successfully | From the turn's tool calls, at clean | `long`, 1,400 chars |
| A command whose output is a list                                                      | From the command, at clean           | None                |

With no limit, the bubble rules below still cap the reply at `format.maxBubbles` bubbles.

Randomness uses a seeded generator. The seed is stored in the turn record so a replay draws the same shape.

## Cleaning Chain

Every reply passes through the same steps, in this order. Each step that changes the text is logged in the turn
record.

1. Remove narrated tool calls and tool-call syntax.
2. Remove speaker name tags and leading indentation.
3. Apply an explicit format request, if code detected one. It wins over the shape.
4. Enforce the reply shape's length. A bypass skips this step.
5. Repair list formatting.
6. Check for leaked prompt text against the fixed blocks. A hit replaces the reply with the pack's fallback line.
7. Render for WhatsApp.
8. Split into bubbles.
9. Capitalise the first letter of each bubble and each paragraph. The step skips a bubble that starts with code, a link, a command or
   a mention or a list, and a first word that already holds a capital, such as `iPhone`. Leading markup, quote marks and emoji
   are passed over. This holds for every pack, whatever its speech rules say.
10. Add the tool footer, below.

The chain never rewrites meaning. It removes, trims and re-marks. A reply it cannot repair is replaced by a pack
line, and the failure is recorded.

## Tool Footer

A reply from a turn that ran a tool ends with one footer line saying what was done, in the way rokabot does on
Discord. WhatsApp has no subscript, so the footer is an italic line.

- It lists each tool that ran with outcome `ok`, once, in call order, as `_<icon> <label> · <label> +N_`. At most 2
  labels show; `+N` counts the rest. A turn with no such call has no footer.
- It sits in the last bubble, after a blank line, and counts toward neither the length limit nor the bubble cap.
- Labels come from the card's `toolFooter.labels`, keyed by tool name. A tool the card does not name uses its plain
  default label from code, such as `searched the web`. Plain labels hold no persona text. The icon is
  `toolFooter.icon`, `🛠️` by default.
- A direct command answer, which runs no model, has no footer.
- The stored reply keeps the footer, so a repeated request returns the same message. When the window is replayed to
  the model, code removes the footer line, bubble breaks and `MEDIA:` lines from assistant rows, so the model never
  sees them and never imitates them.

## WhatsApp Renderer

The gateway converts Markdown to WhatsApp markup on every outgoing message, after the core. Measured: `*x*` becomes
`_x_`, `**x**` becomes `*x*`, `~~x~~` becomes `~x~`, `# x` becomes `*x*`, `[t](u)` becomes `t (u)`; code spans and
code blocks are left alone. So the renderer writes the form that survives that step, never a single-asterisk bold.

| Input                       | Renderer Writes                     | WhatsApp Shows |
| --------------------------- | ----------------------------------- | -------------- |
| Bold                        | `**bold**`                          | `*bold*`       |
| Italic, strikethrough       | `_italic_`, `~strike~`              | The same       |
| Inline code, code block     | `` `code` ``, triple-backtick block | The same       |
| Bulleted and numbered lists | `- item`, `1. item`                 | The same       |
| Block quote                 | `> quote`                           | The same       |
| Heading                     | A `**bold**` line                   | A bold line    |
| Table                       | A list, one row per item            | The same       |
| Link with text              | The text, then the bare address     | The same       |
| Anything else               | Plain text                          | The same       |

The renderer is the only code that knows WhatsApp markup. Everything before it works on a neutral structure. A test
runs the renderer's output through a copy of the gateway's conversion and checks what WhatsApp would show.

## Bubbles

The core decides the bubbles. The gateway only delivers them.

- A reply longer than `format.bubbleMaxChars` is split at a paragraph, else a sentence, else a word. A code block or
  a list item is never cut. A reply is at most `format.maxBubbles` bubbles.
- Between two bubbles the core writes a bubble break: a line holding only the character U+2063.
- The gateway's bubble patch sends each bubble as its own message, with a typing pause before every bubble after the
  first. Only the first bubble quotes the user's message. Measured on the staging gateway code, 16 Nov 2026.
- If the gateway's helper module is missing, the reply goes out as one message. The gateway strips U+2063, so the
  break never shows.
- Every bubble stays under the gateway's own chunk limit of 4,096 characters, so the gateway never splits a bubble or
  adds a page marker.

## Stickers

- A sticker is a WebP image, 512 by 512 pixels, within WhatsApp's sticker size limit. The site converts uploaded
  images to this format when a pack is saved.
- After the reply is cleaned, code picks one sticker from the mood's set, not repeating the last one sent in this
  chat. The model never sees or chooses it.
- The sticker is sent as a second message after the text. A mood with no sticker, or a chat with expressions
  switched off, sends text only.
- The core names the sticker as the last line of the content: `MEDIA:<hostDataDir>/characters/<id>/stickers/<file>.webp`.
  The gateway sends every `MEDIA:` file after all text bubbles.
- The gateway sends a `.webp` as a photo unless told otherwise. The gateway patch `sticker-media-type` sends a `.webp`
  under a `stickers/` folder as a sticker. The bridge's sticker route then delivers a native WhatsApp sticker: a pack
  sticker sent that way arrived as a sticker in a real group on 16 Nov 2026.

## Configuration

| Key                        | Default             | Effect                                                                                       |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| `prompt.maxSystemTokens`   | 8000                | Ceiling enforced by the size test                                                            |
| `judge.mood`               | `on`                | Allows the judge to override the rule mood                                                   |
| `judge.moodMinProbability` | 0.3                 | Threshold for the override                                                                   |
| `format.bubbleMaxChars`    | 700                 | Split point for bubbles                                                                      |
| `format.maxBubbles`        | 3                   | Most bubbles in one reply                                                                    |
| `format.leakCheck`         | `on`                | Step 6 of the cleaning chain                                                                 |
| `format.timeZone`          | `Asia/Kuala_Lumpur` | The time zone code uses when it writes a time in a reply, such as a due time in `/reminders` |

Per-chat switches for expressions and length are settings, not configuration. See [Data](data.md).
