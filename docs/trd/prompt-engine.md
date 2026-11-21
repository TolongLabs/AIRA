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

| File        | Holds                                                                                                                                                           | Required |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `card.yml`  | Id, display name, aliases, languages, core identity, speech rules, default reply length, tool footer                                                            | Yes      |
| `moods.yml` | The mood list: key, detection rules, tone guidance, openers, endings, faces, beats; face groups and beat lines                                                  | Yes      |
| `lines.yml` | Fixed lines for errors, limits, refusals, busy, slow, unreadable media, fallback and unavailable. Optional `feedback` and research lines get neutral fallbacks. | Yes      |
| `stickers/` | Expression images per mood, already converted to WhatsApp sticker format                                                                                        | No       |

- A pack that fails validation is not loaded. A chat bound to it stops with an operator alert. It never falls back to
  another character (PRD FR-9).
- Every mood named in the rules must exist in `moods.yml`. The validator checks required lines and validates any
  optional lines provided in `lines.yml`.
- Cross references are checked too. The default mood must exist in the map. Every pattern must compile with the
  `iu` flags. Every sticker a mood names must exist under `stickers/` and pass the WebP checks. Every face group
  and beat a mood names must be defined. The loader collects every fault and throws one `PackError` that lists
  them all. `loadPacks` still loads the other packs and returns each fault with its pack id
  (`src/character/loader.ts`).
- The `unavailable` line is what a chat sees when the core cannot be reached. At start-up, and whenever the global
  default character changes, the core writes that pack's line to `<hostDataDir>/gateway/unavailable.txt`, where the
  gateway's failure helper reads it. See [System](system.md#gateway-helper-modules).
- The optional `feedback` line introduces the private form link returned by `/report`. A pack without this line gets
  a plain prompt from code. Code appends the link on its own line. The prompt contains no URL, identity or report
  reference, and no model sees the report context.

![How a character pack is loaded and validated](../diagrams/pack-loading.svg)

## Live Context

The chat log is replayed to the model as the window: the chat's newest messages from the last `records.windowDays`
days, at most `context.maxMessages` (default 40, 0 to 100), oldest first. Both values are per chat.

- `features.context` off: the window holds only the messages this turn answers. AIRA still answers, without the
  earlier conversation. Messages are still logged, because memory reads the log; memory is governed by
  `features.memory` alone.
- 40 messages and the 25-message memory page are unmeasured defaults. A harness benchmark of reply quality and cost
  against window size follows.

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
- **Media in block 4.** When the sender attached files, block 4 ends with a line telling the model to speak of them
  as things it saw or heard itself, without mentioning the description, then a `<media untrusted="true">` block: one
  line per file with its kind and description, and the transcript on a second line when there is speech. Line breaks and `<media` tags are stripped from the text. The whole block is
  clipped to 4,500 characters, shared evenly between the files, so media cannot push the prompt over its ceiling.
  A file or link that could not be opened adds a plain outcome note. The model expresses the outcome in character. A message that holds only a file has no text,
  and a model API refuses an empty message, so the model sees `(no text, only a file)` in its place. See
  [Models](models.md#media-watching).
- **Media marked on its message.** When block 4 holds media, code puts a fixed note on the line before the newest user
  message's text: the message came with the files or link that block 4 describes. Older messages get no note.
  Without it, a short caption such as "Explain" reads as a follow-up to the earlier topic, not as a question about the
  file.
- The whole prompt stays under the ceiling in `config.yml` (`prompt.maxSystemTokens`, default 8,000). A test builds
  the prompt for every pack and fails above it.
- Block 3 ends with the tool rules when the registry supplies them for this turn. Otherwise it holds the harness
  rules alone (`src/prompt/builder.ts`).
- In a group, each user message carries the sender's display name when the gateway gave one, else a stable
  per-window member number. Consecutive user messages join into one model message (`src/prompt/builder.ts`).
- A quote arrives as a `<quoted>` block before the message that quotes it. It names its source and is marked
  untrusted. Tag-like text inside is stripped, so a quote can never close its own block (`src/prompt/quote.ts`).
- Block 4 opens with the chat type and a local-time line: weekday, date, minute, time zone and UTC offset. The
  zone is `format.timeZone`; without one the line falls back to UTC. A `Language:` line appears only when the
  chat's `language` setting holds a string other than `auto` (`src/prompt/builder.ts`).
- The size estimate is the character count divided by three, rounded up. A prompt over the ceiling throws, and the
  turn fails instead of sending (`src/prompt/builder.ts`).

![How one turn's prompt is built from pack, memory, window, mood and shape](../diagrams/prompt-build.svg)

## Mood Detection

1. **Rules.** Code scores the newest three user messages against each mood's patterns. Newer messages weigh more:
   the newest weighs 3, the one before 2, the one before that 1. A tie keeps the earliest mood in the map. No
   match returns the pack's default mood. This costs no model call (`src/prompt/mood.ts`).
2. **Judge Override.** When `judge.mood` is on, the judge model receives the mood list with tones and the recent
   messages inside `<messages untrusted="true">`. It must answer with JSON holding a mood key and a probability
   from 0 to 1. Its choice replaces the rule result only for a known mood at or above
   `judge.moodMinProbability`.
3. **Failure.** A bad parse, an unknown mood, a low probability, or a timeout past `judge.timeoutMs` keeps the
   rule result. The judge call aborts on timeout. The turn record notes which source chose the mood.

Only user messages are scored. AIRA's own replies never count. The mood itself is not stored: what persists
across turns is continuity, the last opener, ending and sticker, each keyed by chat and character so no style
leaks across characters (`src/prompt/chat-state.ts`).

## Reply Shape

Code draws the shape after the mood is known. The model receives it as block 6.

| Element | Drawn From                                                                       |
| ------- | -------------------------------------------------------------------------------- |
| Length  | The pack's default, unless a bypass applies                                      |
| Opener  | The mood's opener set, for about 1 reply in 3, never the one this chat saw last  |
| Ending  | The mood's ending set, for about 1 reply in 4, never the one this chat saw last  |
| Faces   | 4 distinct faces from the mood's faces and face groups, offered fresh each reply |
| Beats   | Each beat the mood lists, drawn at its odds; a drawn beat adds its line          |

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

The `replyLength` chat setting wins when it is `short` or `long`; any other value uses the pack's default. The
request bypass is read from the newest pending message at build time and lifts the length with no limit. The
research and command-list bypasses apply at clean time, from the turn's tool calls (`src/format/request.ts`,
`src/format/clean.ts`).

Randomness uses a seeded generator. The seed is stored in the turn record so a replay draws the same shape.

**Faces.** A pack may group its kaomoji by feeling in `faceGroups`, and a mood names the groups it draws from in
`faceGroups` beside its own `faces`. Code offers 4 distinct faces from that pool each reply, so the faces keep
changing; the model may use one, or two when flustered or excited, and none in a sincere moment. Every face is
wrapped in round brackets, holds at most 20 characters inside them, and has no two ASCII letters or digits in a
row, so code can tell a face from a bracketed word. The validator checks each face.

**Beats.** A pack lists `beats`, each a name and one line of guidance, such as a roleplay action in italics or a
dramatic overreaction. A mood gives each beat it allows odds between 0 and 1. Code rolls each beat once per reply
with the turn's seed, and a drawn beat adds its line to block 6. Leaving beats to the prompt alone made a model
use them rarely (rokabot measured 8 to 11 per cent of replies on Haiku).

## Cleaning Chain

Every reply passes through the same steps, in this order. Each step that changes the text is logged in the turn
record.

1. Remove narrated tool calls and tool-call syntax.
2. Remove speaker name tags and leading indentation.
3. Apply an explicit format request, if code detected one. It wins over the shape.
4. Enforce the reply shape's length. A bypass skips this step.
5. Repair list formatting.
6. Guard faces: inside a face, `*`, `_`, `~` and `` ` `` become their full-width forms (`＊ ＿ ～ ｀`), so
   WhatsApp and the gateway's Markdown conversion never read them as formatting. WhatsApp has no escape character.
7. Check for leaked prompt text against the fixed blocks. A hit replaces the reply with the pack's fallback line.
   Then check for role breaks as described in [Staying In Role](#staying-in-role).
8. Render for WhatsApp.
9. Split into bubbles.
10. Capitalise the first letter of each bubble and each paragraph. The step skips a bubble that starts with code, a link, a command or
    a mention or a list, and a first word that already holds a capital, such as `iPhone`. Leading markup, quote marks and emoji
    are passed over. This holds for every pack, whatever its speech rules say.
11. Add the tool footer, below.

The chain never rewrites meaning. It removes, trims and re-marks. A reply it cannot repair is replaced by a pack
line, and the failure is recorded.

A throw anywhere in the chain returns empty content with zero bubbles and the steps collected so far. The caller
then sends nothing for that turn (`src/format/clean.ts`).

![How a reply passes the cleaning chain, bubbles and the sticker line](../diagrams/cleaning-chain.svg)

### Staying In Role

A fixed prompt rule asks every character to describe what it could see or do in its own voice. Failures in the
media and link intake use plain sentences that the character can express naturally.

After the prompt leak check, `fourthWall` flags internal mechanism phrases and tool names before rendering.
Tool names with underscores or dots match as whole words. Other tool names match in backticks or call syntax.
The turn tries one regeneration with the same prompt and model, with tools disabled, when the deadline allows.
If regeneration cannot run or still breaks role, the turn delivers the pack's in-character error line.
The cleaner records `fourth_wall`. The failure stores only the matched pattern name as `persona_leak`.

## Tool Footer

A reply from a turn that ran a tool ends with a footer, in the way rokabot does on Discord: one line saying what was
done and, for research, one line naming the sources. WhatsApp has no small text, so both lines are italic, which keeps
them alike and leaves the domains tappable.

- The first line lists each footer kind, once, in order: first what intake read (`media_video`, `media_youtube`,
  `media_image`, `media_audio`, `media_document`, `media_post`), then each tool that ran with outcome `ok`, in call
  order: `_<emoji> <label> · <label> +N_`. At most 2 labels show; `+N` counts the rest. Labels are lower case. A
  label text shows once, so a video file and a YouTube link both read `watched a video` once. An item intake could
  not read adds nothing.
- The second line, `_🔗 <domain> · <domain>_`, names up to 3 sites the turn read or found: a link read at intake
  first, then pages read, then
  search results in rank order, one per site, `www.` removed. WhatsApp makes a domain tappable inside italics, but it
  has no link text, so a tap opens the site, not the page. Superscript was tried and dropped: WhatsApp does not link
  a domain written in superscript letters.
- The footer sits after a blank line at the end of the reply and counts toward neither the length limit nor the
  bubble cap. A turn with neither an intake read nor an `ok` tool call has no footer. A direct command answer, which
  runs no model, has none.
- Labels come from the card's `toolFooter.labels`, keyed by footer kind (a tool name or an intake kind), else a
  plain default from code. A successful `identify_image` call defaults to `searched by image`.
  Plain labels hold no persona text. The intake defaults are `watched a video`
  (`media_video`, `media_youtube`), `looked at an image`, `listened to audio`, `read a document` and `read a post`.
  A label or icon holds no `_ * ~`, backtick, `<`, `>` or line break, and a label is 1 to 40 characters; the pack
  loader and the site check the same rule. The owner edits a data pack's labels and icon on the site
  ([Owner Site](site.md#write-routes)).
- The emoji is the chat's `footerEmoji` setting, else the card's `toolFooter.icon`, else `🛠️`. The chat setting
  `features.toolFooter` switches the footer off, both lines.
- The stored reply keeps the footer, so a repeated request returns the same message. When the window is replayed to
  the model, code removes both footer lines, bubble breaks and `MEDIA:` lines from assistant rows.
- A reply that code wrote with no model call, such as a direct command's answer, is replayed with a one-line
  label saying code wrote it from stored data. Without it the model took a `/help` list for its own words and
  disowned it. The cleaning chain removes the label if the model copies it.

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

- A reply longer than `format.bubbleMaxChars` is split at a paragraph, else a sentence, else a word. A code block
  or list item that exceeds the gateway chunk limit is split at its lines, and an overlong line is cut into
  fixed-size chunks. The per-bubble limit grows toward 4,095 characters to fit `format.maxBubbles` bubbles. Any
  bubble past the cap is dropped, and the turn record marks the reply trimmed (`src/format/bubbles.ts`). A reply
  is at most `format.maxBubbles` bubbles. The launch value is 1: one text message
  and at most one sticker per reply, because members of the old bot complained about several messages per reply.
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
- Stickers attach only for packs loaded from the data volume. Every file must be exactly 512 by 512 pixels, at
  most 100,000 bytes still or 500,000 bytes animated. The loader rejects anything else (`src/character/webp.ts`).
- Sticker load, selection, path and state-write errors are caught. The cleaned text goes out unchanged, with no
  sticker (`src/prompt/stickers.ts`).
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

| Key                        | Default             | Effect                                                                                                                                                        |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt.maxSystemTokens`   | 8000                | Ceiling enforced by the size test                                                                                                                             |
| `judge.mood`               | `on`                | Allows the judge to override the rule mood                                                                                                                    |
| `judge.moodMinProbability` | 0.3                 | Threshold for the override                                                                                                                                    |
| `judge.timeoutMs`          | 1500                | Judge wait per turn, in ms                                                                                                                                    |
| `format.bubbleMaxChars`    | 3800                | Split point for bubbles                                                                                                                                       |
| `format.maxBubbles`        | 1                   | Most bubbles in one reply                                                                                                                                     |
| `format.leakCheck`         | `on`                | Step 7 of the cleaning chain                                                                                                                                  |
| `format.timeZone`          | `Asia/Kuala_Lumpur` | The time zone code uses when it writes a time in a reply, such as a due time in `/reminders`, and the local time with its offset that block 4 gives the model |

Per-chat switches for expressions and length are settings, not configuration. See [Data](data.md).
