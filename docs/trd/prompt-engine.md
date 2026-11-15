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

| File        | Holds                                                                          | Required |
| ----------- | ------------------------------------------------------------------------------ | -------- |
| `card.yml`  | Id, display name, languages, core identity, speech rules, default reply length | Yes      |
| `moods.yml` | The mood list: key, detection rules, tone guidance, openers, endings, faces    | Yes      |
| `lines.yml` | Fixed lines for errors, limits, refusals, busy and unreadable media            | Yes      |
| `stickers/` | Expression images per mood, already converted to WhatsApp sticker format       | No       |

- A pack that fails validation is not loaded. A chat bound to it stops with an operator alert. It never falls back to
  another character (PRD FR-9).
- Every mood named in the rules must exist in `moods.yml`. Every line kind the core can send must exist in
  `lines.yml`. The validator checks both.

## Prompt Blocks

The system prompt is assembled in a fixed order. Blocks 1 to 3 are stable per character and form the cached prefix.

| #   | Block         | Source                                            | Changes Per Turn |
| --- | ------------- | ------------------------------------------------- | ---------------- |
| 1   | Core          | `card.yml` identity                               | No               |
| 2   | Speech        | `card.yml` speech rules                           | No               |
| 3   | Harness Rules | `prompts/` (tools, memory, safety, format)        | No               |
| 4   | Context       | Chat type, members present, time, recalled memory | Yes              |
| 5   | Tone          | The detected mood's guidance                      | Yes              |
| 6   | Reply Shape   | Drawn by code for this turn                       | Yes              |

- Blocks 4 to 6 carry only labelled data and short instructions. User text never enters the system prompt.
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

**Length bypass.** The default length is lifted only when code detects one of: an explicit request for detail or a
format, a turn that used a research tool, or a command whose output is a list. The bypass and its reason are written
to the turn record.

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

The chain never rewrites meaning. It removes, trims and re-marks. A reply it cannot repair is replaced by a pack
line, and the failure is recorded.

## WhatsApp Renderer

| Input                       | Output                              |
| --------------------------- | ----------------------------------- |
| Bold, italic, strikethrough | `*bold*`, `_italic_`, `~strike~`    |
| Inline code, code block     | `` `code` ``, triple-backtick block |
| Bulleted and numbered lists | `- item`, `1. item`                 |
| Block quote                 | `> quote`                           |
| Heading                     | A bold line                         |
| Table                       | A list, one row per item            |
| Link with text              | The text, then the bare address     |
| Anything else               | Plain text                          |

The renderer is the only code that knows WhatsApp markup. Everything before it works on a neutral structure.

## Bubbles

A reply longer than `format.bubbleMaxChars` is split at a paragraph, else a sentence, else a word. A code block or a
list item is never cut. Who performs the split at delivery is **Spike S-2** in [System](system.md).

## Stickers

- A sticker is a WebP image, 512 by 512 pixels, within WhatsApp's sticker size limit. The site converts uploaded
  images to this format when a pack is saved.
- After the reply is cleaned, code picks one sticker from the mood's set, not repeating the last one sent in this
  chat. The model never sees or chooses it.
- The sticker is sent as a second message after the text. A mood with no sticker, or a chat with expressions
  switched off, sends text only.
- The delivery mechanism is **Spike S-1** in [System](system.md).

## Configuration

| Key                        | Default | Effect                                     |
| -------------------------- | ------- | ------------------------------------------ |
| `prompt.maxSystemTokens`   | 8000    | Ceiling enforced by the size test          |
| `judge.mood`               | `on`    | Allows the judge to override the rule mood |
| `judge.moodMinProbability` | 0.3     | Threshold for the override                 |
| `format.bubbleMaxChars`    | 700     | Split point for bubbles                    |
| `format.leakCheck`         | `on`    | Step 6 of the cleaning chain               |

Per-chat switches for expressions and length are settings, not configuration. See [Data](data.md).
