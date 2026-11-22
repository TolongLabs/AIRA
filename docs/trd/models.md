# Models

Two transports behind one interface, the roles a model can play, routing, fallback and spend.

## Roles

| Role       | Used For                                         | Default Source  |
| ---------- | ------------------------------------------------ | --------------- |
| `main`     | The reply loop, memory extraction                | `llm.main`      |
| `fallback` | The reply loop when `main` fails                 | `llm.fallback`  |
| `judge`    | Mood override, memory admission and verification | `judge` section |
| `media`    | Watching pictures, audio and video at intake     | `media.watcher` |

Each role has its own key in `.env`. A role with no key is switched off, and features that need it say so in
character.

## Transport Setting

```yaml
llm:
  transport: api # api | subscription
  main: { provider: anthropic, model: claude-haiku-5-5, effort: medium, baseUrl: 'https://api.anthropic.com' }
  fallback:
    provider: openai-compatible
    model: deepseek-ai/DeepSeek-V4.1-Flash-1017
    effort: high
    baseUrl: 'https://api-inference.modelscope.ai/v1'
  turnDeadlineMs: 45000
  monthlyBudgetUsd: 50
```

- `api` calls the role's endpoint with its key: `LLM_API_KEY` for `main`, `LLM_FALLBACK_API_KEY` for `fallback`.
- `subscription` runs the `claude` program on the owner's login through the host runner service.
- Both transports run the main role on the same `llm.main.model` at the same `llm.main.effort`. Only the way the
  model is reached differs.
- The launch default is `api`, the faster transport in the benchmark (S-4, measured on dev2, 17 Nov 2026, same image,
  same model `claude-haiku-5-5` at `medium`, one chat per set; latency from arrival to return, including the 1.5 s
  batch wait):

  | Set              | API p50 / p90 | Subscription p50 / p90 |
  | ---------------- | ------------- | ---------------------- |
  | Casual, 12 turns | 3.2 s / 3.4 s | 5.5 s / 5.9 s          |
  | Tool, 8 turns    | 6.9 s / 9.0 s | 5.8 s / 8.9 s          |

  Both delivered every turn. The subscription runner adds about 2.3 s to a casual turn, the program's start-up, and
  ties on tool turns. The subscription runner stays available as `llm.transport: subscription` with the host runner
  in `deploy/host-runner/`, which is not installed on dev2.

- The launch models above hold. Claude Sonnet 5.5 is the candidate for a later main model.

## Providers And Effort

A role's `provider` decides the request shape. Both providers serve both roles.

| Provider            | Endpoint                            | Effort Sent As                                          | Prompt Caching                      |
| ------------------- | ----------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `anthropic`         | Claude's native `POST /v1/messages` | `thinking: {type: adaptive}` and `output_config.effort` | The stable prompt blocks and tools  |
| `openai-compatible` | `POST <baseUrl>/chat/completions`   | `reasoning_effort`                                      | Whatever the server does on its own |

- `effort` is optional. Empty sends nothing, and the model's own default applies. The accepted values belong to
  the model: Claude takes `low`, `medium`, `high`, `xhigh` and `max`. DeepSeek V4.1 Flash takes `none` (thinking
  off), `low`, `high` and `max`, and maps the other names onto those. Start-up refuses an `anthropic` effort
  outside Claude's list. An OpenAI-compatible server checks its own: ModelScope answers an unknown value with 400.
- Claude is never reached through its OpenAI-compatible layer. Measured on 16 Nov 2026: that layer accepts any
  effort, including an invalid one, and ignores it, and it has no prompt caching. The native endpoint rejects an
  invalid effort, and the same question took 147 output tokens at `low` and 482 at `max`.
- The `anthropic` provider sends no sampling parameter. Claude 5 models refuse a non-default `temperature`. A
  response schema is sent as `output_config.format`. Without `max_tokens` in the request, the client sends 16,000.
- The subscription runner passes `llm.main.effort` to the program as `--effort`, and `medium` when it is empty,
  which is Claude Haiku 5.5's own default.

### Deeper Thinking

A member asks for one deeper turn by starting the message with `/think` (PRD FR-45).

- **Prefix.** `/think` as the first word of the newest message, in any case, followed by a space or the end of the
  message. Code removes it before the text is stored or reaches the model. Anywhere else in a message it is ordinary
  text. It is not a tool command and is not listed by `/help` as one; `/help` names it in one line.
- **Effort.** That turn runs the main role at `llm.main.deepEffort` (default `high`) and the fallback at
  `llm.fallback.deepEffort` (default `max`), each checked against its provider's list as `effort` is. Empty means
  the role's normal `effort`. The subscription runner passes `deepEffort` as `--effort`. Memory, the judge and media
  keep their own settings.
- **Switch.** `features.think` (default on) turns the prefix on per chat. Off: the prefix is removed and the turn runs
  at normal effort, so the member's text still reads naturally.
- **Record.** The turn record stores the effort each model call used and `think: true` when the prefix raised it.
- Raising effort without the prefix, from reply-shape signals, is not built (FR-45 optional part).

### Turn State Of A Provider

A thinking model returns state that must come back with the next request of the same loop: Claude's thinking
blocks, and an OpenAI-compatible server's `reasoning_content`. Claude refuses tool results without the thinking
that asked for them, and DeepSeek's own API does the same without `reasoning_content`.

- The client returns that state with the response. The API runner keeps it for the turn, keyed by the tool calls it
  came with, and the client sends it back with that assistant step.
- It never outlives the turn and is never stored. The window holds text only, so a later turn starts without it.
- The fallback can take over mid-loop, so the state carries its provider. A client sends back only state of its
  own provider and drops the rest.

## Turn Runner Interface

Both transports implement one interface.

```ts
interface TurnRunner {
  run(input: {
    system: PromptBlocks
    window: Message[]
    tools: OfferedTool[]
    context: TurnContext
    deadline: number
  }): Promise<{ text: string; toolCalls: ToolCallRecord[]; usage: Usage; model: string }>
}
```

| Aspect         | API Runner                          | Subscription Runner                                                   |
| -------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Loop Owner     | The agent kit, inside the core      | The `claude` program, on the host                                     |
| Tools          | Registry handlers called in process | The same registry, served by the core over the Model Context Protocol |
| Built-in Tools | None                                | All disabled                                                          |
| Prompt         | Blocks sent as the system prompt    | The same blocks, passed as the system prompt                          |
| Usage And Cost | From the provider response          | From the program's result line                                        |
| Start-up Cost  | None                                | One process start per turn                                            |
| Limits         | Provider rate limits, the spend cap | The subscription's rolling limits                                     |

Everything outside the runner is shared: prompt assembly, the offered tool list, the cleaning chain, records.

## Host Runner Service

The `claude` program needs the owner's login, which lives in his home folder on the host. A container cannot hold
it safely. When `transport: subscription` is set:

- A small host service listens on a loopback port and accepts a run request from the core.
- It starts the program with no built-in tools, no settings files, the system prompt, and the core's tool server
  address.
- It streams the result back. It holds no state and reads no AIRA data.
- If the service is down, the core treats the transport as unavailable and uses the fallback role. Once any tool
  starts in a subscription run, a later failure ends the run. Starting the fallback from the original prompt could
  repeat that action.
- On this transport the fallback model answers on the API runner, with a breaker of its own. Memory extraction
  uses `llm.main` when it has a key, else `llm.fallback`. With neither, nothing is extracted.
- One run is one program start. There is no retry inside the subscription runner.

### Run Request

The core sends one request per model run to `POST <runnerUrl>/run`, with the shared secret `RUNNER_TOKEN` as a
bearer token. The service answers with the program's output lines as they arrive, one JSON object per line.
A turn can start one additional run when the [role check](prompt-engine.md#staying-in-role) flags a reply.
The additional run uses the same model and an empty tool session.

| Field       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `system`    | The prompt blocks joined in order, passed as the program's whole system prompt |
| `prompt`    | The conversation, as text. See below                                           |
| `model`     | `llm.main.model`                                                               |
| `effort`    | `llm.main.effort`, or `medium` when it is empty                                |
| `tools`     | The address of the core's tool server for this turn, and this turn's token     |
| `timeoutMs` | The time left before the turn deadline. The service stops the program after it |

- The program starts with: print mode, stream output, no built-in tools, no settings sources, no saved session, no
  slash commands, and only the tool server named in the request. The prompt is written to its standard input.
- The program takes one prompt, not a list of messages. The core writes the earlier messages of the window as a
  labelled transcript and the messages this turn answers after it (A-7, confirmed by the S-4 benchmark, 17 Nov 2026).
- The last output line of type `result` holds the reply text, the token counts and the estimated cost.
- A failed run is a `result` line with `is_error` true, even when its `subtype` says `success`. Its kind comes from
  `api_error_status` (429 or 529 is a rate limit, 401 or 403 is auth), then from the program's own `error` on the
  assistant line, then from the text: "You've hit your session limit" is a rate limit. The program then exits with
  an error, so the service's exit line is the cause only when no failed result came. Measured on the host with a
  spent subscription, 16 Nov 2026.
- The system prompt holds recalled memory, and the tool server address comes with this turn's token. The service
  passes both in private temporary files, removed when the program ends, so neither shows in the host's process
  list. The program never receives the service's own secret.
- The service keeps no state and reads no AIRA data. A second request while one runs is accepted:
  each request is its own program.

### Tool Server For The Program

- The core listens on `llm.subscription.toolServerPort`, on loopback, only while the transport is `subscription`.
- Each turn gets a random token. A request with a token of no running turn is refused. The token dies when the
  turn's run ends.
- The server lists exactly the tools offered to that turn, and calls them through the registry, so permissions,
  timeouts, receipts and records are the same as on the API runner.
- The two chain limits of [Tools](tools.md#implicit-calls) are enforced here: past a limit every call is refused.
- For a skill-style command, the named tool is the only one listed until it has been called.
- Tool calls arrive as JSON bodies of at most 1 MiB. A larger declared or streamed body is refused with 413.
- The program shows a tool to the model under a prefixed name. The prompt's tool list is written with the same
  prefix on this transport (A-7, confirmed by the S-4 benchmark, 17 Nov 2026).

## Failure Kinds

| Kind         | Examples                        | Action                                   |
| ------------ | ------------------------------- | ---------------------------------------- |
| `transient`  | Timeout, 5xx, connection reset  | Retry with backoff inside the deadline   |
| `rate_limit` | 429, subscription limit reached | Switch to fallback, open the breaker     |
| `auth`       | 401, 403, expired login         | Switch to fallback, alert the operator   |
| `refusal`    | The model declines              | Send the pack's refusal line             |
| `malformed`  | Empty or unparseable reply      | One retry, then the pack's fallback line |
| `budget`     | Monthly cap reached             | Send the pack's limit line               |

## Fallback

- The fallback model answers on the same runner interface with the same prompt and tools.
- For an API reply, retry only the failed model request, keeping any completed tool results. Transient failures
  wait 250 ms, then double the wait up to 4 s. When a fallback is available, switch after `llm.maxRetries` retries
  on the main model. On the last available or pinned model, keep retrying while the next wait fits inside the
  original turn deadline. Cancellation and the spend cap stop further calls. Setting `llm.maxRetries` to 0
  disables these waits and retries on every role.
- A breaker per role opens after a `rate_limit` or `auth` failure and stays open for `llm.breakerMs`. While open,
  turns go straight to the fallback. The breaker state is process-wide for a role, not per chat or character,
  because the limit it guards is account-wide.
- Each fallback is written to the turn record with the failure kind that caused it.
- If both roles fail, the turn ends with the pack's error line and a failure record.

![Sequence of a model call: runner choice, retries, fallback, spend cap, and recorded attempts](../diagrams/model-routing.svg)

## Media Watching

Media is read at intake, before the main model runs. The gateway saves each file on the host and names its path in a
note ([System](system.md#gateway-contract)). The core reads the file through its own read-only mount of the gateway's
media folders.

1. **Which files.** A turn reads the files of every message it answers: the first 3 of each message, and at most 6
   for the turn, the newest first. A bare photo and the caption that follows it merge into one turn
   ([Reliability](reliability.md#batching)), so the caption's message is not the only one that counts. Files past
   those limits are not read and are not recorded as failures. A turn that runs a direct command reads nothing.
   The files of a quoted message count as files of the message that quotes it: a member who replies to a picture or
   a video, AIRA's own included, gets it watched, within the same limits. The gateway's bridge downloads the quoted
   file and names it in that message's notes ([System](system.md#gateway-contract)).
2. **Where from.** `media.gatewayDirs` lists `host` and `container` folder pairs. A path from a note is read only if,
   after `..` is resolved and every symlink is followed, it lies under one of the `host` folders. It is then opened
   at the same place under the paired `container` folder. A symlink that leaves the mounted folder, a path outside
   every pair, a path that is not a file and a missing file are refused. The core never reads a path anywhere else:
   a note is text, and a member's message could imitate one.
3. **Which kind.** The kind comes from the MIME type the file's extension maps to: `.jpg`, `.jpeg`, `.png`, `.webp`,
   `.gif`, `.heic` for an image; `.ogg`, `.oga`, `.opus`, `.mp3`, `.m4a`, `.aac`, `.wav` (as `audio/x-wav`) for audio
   and voice notes; `.mp4`, `.mov`, `.webm`, `.3gp` (as `video/3gpp`) for video; `.pdf` for a document. Any other
   extension is an unsupported type.
4. **Limits.** Code checks type and size against fixed limits before it reads the file into memory: at most
   20,000,000 bytes, and an empty file is refused. Duration is checked only when the sender
   reported one. A gateway attachment names only a kind and a path, so an attached video's length is never checked.
   Remote link downloads carry a duration, and audio longer than 600 seconds is refused. A
   voice note's duration is not in the gateway's note, so the size limit is the only length limit that applies to it.
5. **The read.** All files of a turn are read at once, each with its own timeout: `media.timeoutMs`, and at most
   two thirds of the time left in the turn deadline, so the main model keeps at least a third. For an attachment this
   budget includes loading the file, watcher calls and retry waits. A transient watcher failure retries the same bytes
   after 250 ms, doubling the delay to a 4-second maximum. Each attempt must start before the original budget expires
   and can use only the time left. Other failures end the read. Each watcher attempt records its own call.
   The media model returns
   a description, and a transcript where there is speech. It runs on the free tier of its own key, so its calls record
   their tokens with a cost of 0 and do not count against the spend cap.
6. **Into the prompt.** The descriptions enter prompt block 4 as one labelled, untrusted block, clipped to a fixed
   budget so that media cannot push the prompt over its ceiling. The budget is 4,500 characters, split evenly across
   the readable files and links of the turn. The main model never receives the file.
   See [Prompt Engine](prompt-engine.md#prompt-blocks).
7. **Links.** The first link in the turn's messages to a YouTube video or a supported social post (newest message text
   first, then quoted text) is opened at intake, at most one per turn. `features.media` off means no file (rule 8 notes it as `off`) and no YouTube link is
   read; `features.social` off means no post link is read. A YouTube video is sent to the media model as its own
   URL (`file_data`) at low media resolution (`MEDIA_RESOLUTION_LOW`), starting from its offset if any (the `t=`
   or `start=` parameter or a `#t=` fragment, in seconds or clock form), and watched for at
   most `media.maxLinkVideoSeconds` (default 600) in segments, as rule 10 sets out (measured: a 3-minute video in
   5 s, about 19,000 tokens). A longer YouTube video is clipped, never refused, and the description the model
   receives says it covers only the first part; a private or removed video fails with reason `unavailable`. A post's
   video is fetched under the same size and `media.maxVideoSeconds` limits as a file, and watched at once with up to
   4 of its photos, as [Post Links](#post-links) sets out; with none of them read, its one picture, then its text
   only. A failed
   link lookup adds an unreadable note with the platform and reason `link`; neither the note nor any log carries the
   URL. The result enters block 4 like a file's description, and failures follow rule 8. Ported from rokabot's media
   and social readers.
8. **Failure.** A file that is refused, over a limit, of an unsupported type, unread because media is off, or whose
   read fails or times out, does not end the turn. Block 4 gets a short note naming the kind of file and why, and the
   pack's `unreadableMedia` line for link-only failures. For direct attachments the model briefly acknowledges
   the failed read in character, without asking the sender to resend the file. It can still answer from the files
   that were read and the text that came with them. The note never carries the path.
9. **Record.** Every request to the media model is one `model_call` row with role `media`, with its tokens and its
   failure kind when it failed. Every unreadable file is one `failure` row with kind `media_unreadable`, stage
   `media`, handled by `line:unreadableMedia`, and a message with the kind of file and the reason, never the path.
   The turn itself stays `delivered`. An `auth` failure of the media role also alerts the operator. A YouTube
   segment is its own request and its own `model_call` row. A segment that fails while another answers is one
   `failure` row of kind `media_unreadable`, handled by `coverage:partial`, with no note in block 4.
10. **Long YouTube videos.** A span longer than `media.linkSegmentSeconds` (180) is split: a first segment of
    `media.linkFirstSegmentSeconds` (60), then segments of 180 s, a last segment under 30 s joining the one before,
    and at most `media.maxLinkSegments` (4). All segments are watched at once, each with its own `video_metadata`
    offsets and a frame rate of `media.linkFps` (0.25, one frame every 4 s, for spans up to 10 minutes), with no
    retry. They share one budget, `media.linkWatchMs` (12,000), from the end of the lookup, never past the link
    reader's timeout. Code merges the answered segments in order under clock labels, and the description names the
    parts not watched. Only when every segment fails is the video unreadable. A video of unknown length is watched
    for one segment from its start offset, and the description says so.

![How attached files and shared links are read at intake, with limits and refusals](../diagrams/media-intake.svg)

### How Media Reaches The Core

Every path starts in the gateway's notes. The table in [System](system.md#gateway-contract) lists each note shape.

- **An attached file.** The gateway saves the file on the host and writes its path in a note before the message's
  marker. A picture, a voice note, an audio file, a video and a document each have their own note. The core parses
  them into attachments (`src/gateway/request.ts`, `src/gateway/request.ts`).
- **A transcribed voice note.** The gateway writes the transcript as one quoted line before a marker with no text
  after it. That line becomes the message text (`src/gateway/request.ts`).
- **An inline image.** The gateway sends `image_url` parts with one `[Image attached at: <path>]` line per picture at
  the end of the text. The core takes at most one line per part, from the end, and drops them from the text
  (`src/gateway/request.ts`).
- **A quoted file.** The bridge downloads the file a reply quotes and names it in the quoting message's notes. It
  then arrives as that message's attachment. See [Quoted Media](#quoted-media).
- **A link.** The first supported link in the turn's texts: newest message first, then quoted text. See
  [YouTube Links](#youtube-links) and [Post Links](#post-links).
- **A leading timestamp.** The gateway may start a message with a bracketed timestamp on the same line as its first
  note. The core strips it before reading notes, so no note is lost and the stamp never enters the text
  (`src/gateway/request.ts`).

A note is text, so a member could imitate one. The core opens a path only when it lies under a `media.gatewayDirs`
pair, after `..` is resolved and every symlink is followed. Anything else is refused (`src/media/files.ts`,
`src/media/files.ts`).

### Quoted Media

A reply to a picture or a video gets the quoted file watched. This covers AIRA's own messages too.

The gateway's bridge downloads the quoted file and names its path in the quoting message's notes. The core reads it
as that message's file, within the same per-message and per-turn limits. Quoted media is always watched, even on a
turn that would otherwise read nothing else.

The quoted text is stored beside the message, never in it. The model sees it as a labelled block, while memory and
mood read the text only. Forget clears the quotes of a cleared message. See [System](system.md#gateway-contract)
and [Memory](memory.md).

The link reader also scans quoted text. A link there counts when no newer message holds one
(`src/turn/pipeline.ts`).

![A member replies to a media message and the quoted file is watched](../diagrams/quoted-media.svg)

### YouTube Links

One link is read per turn. The reader takes the first supported target from the turn's texts, newest message first,
then quoted text. A disabled platform never shadows a later allowed link. YouTube needs `features.media`; a post
link needs `features.social` (`src/media/link-intake.ts`, `src/turn/pipeline.ts`).

A failed lookup adds one unreadable note with the platform and the reason `link`. It writes no model call, and no
log or note carries the URL (`src/media/link-intake.ts`).

A YouTube video is watched from its URL, never downloaded. The start offset comes from the `t` or `start` parameter
or a `#t=` fragment, in seconds or clock form (`src/social/urls.ts`). The span is capped at
`media.maxLinkVideoSeconds` from that offset. A longer video is clipped, never refused.

The span is split by `planLinkSegments`: one short first segment (`media.linkFirstSegmentSeconds`, 60), then full
segments (`media.linkSegmentSeconds`, 180). A last segment under 30 s joins the one before. At most
`media.maxLinkSegments` (4) are kept; the rest stays unwatched (`src/media/link-segments.ts`).

All kept segments are watched at once. Each call sends its own `video_metadata` offsets at `media.linkFps` (0.25)
and low media resolution. The segments share one budget, `media.linkWatchMs` (12,000), counted from the end of the
lookup and never past the link timeout. There is no retry (`src/media/link-intake.ts`,
`src/media/gemini-watcher.ts`).

Code merges the answered segments in order under clock labels. The merged text names the parts not watched: clipped
ranges, failed segments and unknown length (`src/media/link-segments.ts`).

A failed segment is one `failure` row, handled by `coverage:partial`, with no note in block 4. It still leaves its
own `model_call` row. Only when every segment fails is the video unreadable. A private or removed video fails as
`unavailable` (`src/media/link-intake.ts`, `src/turn/pipeline.ts`).

A video of unknown length is watched for one segment from its start offset. The description says the length is
unknown (`src/media/link-segments.ts`).

![One YouTube link watched in parallel segments under one time budget](../diagrams/youtube-watch.svg)

### Post Links

A social post reaches the turn through the reader in
[Social Post And Reply Readers](#social-post-and-reply-readers). Nine platforms are covered: X, Bluesky, Threads,
YouTube, TikTok, Reddit, Instagram, Bilibili and Facebook. Intake can look for links up to three user-message
quote hops in the same chat. It uses the stored text and respects the existing bounds on intake lookups.

Video from a linked social post is fetched by the social tool and passed through the same watch path as a file. It
must fit the same size limit and `media.maxVideoSeconds`. The downloader uses a reader-supplied user agent
and referrer for that video when present. A remote audio download over 600 seconds is refused
(`src/media/link-intake.ts`).

An otherwise eligible linked MP4 may be downloaded up to 48 MB and compressed locally if it exceeds the
consumer’s byte limit. Intake still requires at most 20 MB and group autofetch at most 16 MB after compression.
A transient watch failure may retry the same downloaded asset once within the original deadline.
Use the post or preview that was actually read. Keep duration policy internal to the character.

Only an MP4 of up to 300 seconds can use compression. That bound limits transcoding work. Group eligibility
continues to use the platform and native attachment rules in [Autofetch](system.md#autofetch).
The core runs at most one transcode at a time. The attempt takes at most 12 seconds within the caller’s remaining
budget. It fits the video within 960×540 at up to 24 frames per second without cropping, and keeps the full duration
and an audio track when one is present. If the source or output fails validation,
intake can still use its preview and group autofetch omits the failed attachment.

A post's photos are watched as images, at most `MAX_LINK_PHOTOS` (4) per link: the linked post's photos in order,
then those of the earlier posts in its thread, oldest first. The video and the photos are watched at once, each its
own call under the link's time limit. One answer enters block 4 as it is; several are merged in order, each labelled
(`video`, `photo 2`, `earlier post, photo 1`), and the merged text names how many photos were not watched or could
not be read. When nothing was read, the reader falls back to the post's one picture (a video's thumbnail or the link
card's image), and then to its text only (`src/media/link-intake.ts`). The prompt labels a fallback
picture as a preview. Without a successful watch the character uses the post or still image and does
not invent playback, sound, or a technical explanation. Only successful video watches can supply a transcript for a linked post.

When intake reads a social post and successfully watches its video in the same turn, both the configured
`media_post` and `media_video` labels enter the [tool footer](prompt-engine.md#tool-footer).
A successful fallback preview uses `media_image`. YouTube uses its dedicated `media_youtube` label.

The post's text, author, most-liked replies and media enter block 4 as lines with its platform, author, date, reply
count and canonical URL. The earlier posts of its thread come first, each with its author and text
(`src/media/turn-media.ts`).

A failed social link attempted at intake is recorded for this turn under its original and resolved URL when
available. Either page or post reading returns the same plain refusal if the model asks for that failed link.
For a link whose video or image intake watched, `read_post` and `read_page` return the saved post and visual
evidence as a successful read without fetching it again. A link
intake read as text only, or whose watch failed, stays open, so the model may fetch the post's replies and media;
the footer then shows that read as well. The turn records the URL so the tools know it: the post's canonical URL,
and the shared link's own when a redirect resolved it (`src/turn/pipeline.ts`).

### Limits

| Limit                  | Key And Default                                    | At The Limit                                                                            |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Files from one message | Code `MAX_MEDIA_PER_MESSAGE`, 3                    | Extras are skipped, never failures (`src/media/turn-media.ts`)                          |
| Files in one turn      | Code `MAX_MEDIA_PER_TURN`, 6, newest first         | Extras are skipped (`src/media/turn-media.ts`)                                          |
| File size              | Code default, 20,000,000 bytes, no config key      | Refused as `too large` before the file is read (`src/media/limits.ts`)                  |
| Video length           | `media.maxVideoSeconds`, 300                       | Refused as `too long` (`src/media/limits.ts`)                                           |
| Audio length           | Code default, 600 seconds                          | Refused as `too long`, only when the sender reported one (`src/media/limits.ts`)        |
| One media read         | `media.timeoutMs`, 30000, at most two thirds left  | The read fails and the file is unreadable (`src/media/turn-media.ts`)                   |
| All YouTube segments   | `media.linkWatchMs`, 12000                         | Running segments abort; answered ones still merge (`src/media/link-intake.ts`)          |
| Photos from one link   | Code `MAX_LINK_PHOTOS`, 4                          | The rest are named as not watched (`src/media/link-intake.ts`)                          |
| Photos kept per post   | Code `MAX_POST_PHOTOS`, 20                         | The rest are dropped (`src/social/parsers.ts`)                                          |
| Media text in block 4  | Code `MEDIA_TEXT_BUDGET`, 4,500 characters         | Clipped evenly across the turn's items (`src/media/turn-media.ts`)                      |
| Watcher answer         | 120 words, 300-word transcript, schema 2,000 chars | Over-long text fails validation; the file is unreadable (`src/media/gemini-watcher.ts`) |

An attached video's length is never checked: a gateway attachment names only a kind and a path, so no duration
reaches the check (`src/media/files.ts`). A voice note's duration is likewise absent, so only its size applies.

With no media model or no `MEDIA_WATCHER_API_KEY`, media is off: the core logs `media.off` once at start-up, files
are not read, and each one gets the unreadable note with the reason `off`. The turn still answers.

### Records

- Every request to the media model is one `model_call` row with role `media`. It carries the tokens and a cost of 0. A failed call carries its failure kind. Each YouTube segment is its own row (`src/media/turn-media.ts`,
  `src/media/link-intake.ts`).
- Every unreadable file is one `failure` row: kind `media_unreadable`, stage `media`, handled by
  `line:unreadableMedia`. Its message names the kind of file and the reason (`src/turn/pipeline.ts`).
- A failed segment beside an answered one is one `failure` row handled by `coverage:partial`
  (`src/turn/pipeline.ts`).
- The turn itself stays `delivered`.
- An `auth` failure of the media role also alerts the operator (`src/turn/pipeline.ts`).
- Never stored: the file, its path, the link URL. Logs carry platform and reason only
  (`src/media/link-intake.ts`). Block 4 notes name kind and reason only, never the path
  (`src/media/turn-media.ts`).

### Failures

Every media failure is contained. The turn continues and answers in character.

| Failure                                                                                                            | What The Member Sees                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Refused path, missing file, unsupported type, empty file, too large, too long, media off, failed read, failed link | An in-character acknowledgment beside the files that were read (rule 8) |
| One YouTube segment fails while another answers                                                                    | Nothing about the failure; the merged text names the unwatched part     |
| Every segment fails                                                                                                | The whole video unreadable; the post text stays when the lookup gave it |
| Private or removed video                                                                                           | Unreadable with the reason `unavailable`                                |
| Media model auth failure                                                                                           | The same unreadable outcome, plus an operator alert                     |

## Social Post And Reply Readers

Reader output can carry group attachment evidence from the source that proved the post identity and media
type. Bind evidence to the resolved native post and rendition before fallback. Keep duration with its video
rendition. A reader result that explicitly identifies a different post does not fill missing fields.
An extractor thumbnail, feed image, link card or cover cannot establish a native photo.

Link intake and the social tools read public posts and their replies through one subsystem in `src/social`. It
covers nine platforms: X, Bluesky, Threads, YouTube, TikTok, Reddit, Instagram, Bilibili and Facebook.

![How a shared link is normalised, fetched per platform, and cached](../diagrams/social-readers.svg)

- **URLs.** `parseSocialPostUrl` accepts only `https` links with no user info, port or IP host. Each platform has a
  fixed host list and an id pattern, and yields a canonical URL, an extractor URL and a lookup key. The Bluesky key
  carries the profile; the YouTube target carries the start offset from rule 7 of Media Watching. Threads also takes
  its short link (`/t/<code>`) and its share link (`/share/<id>`); both redirect to the post. Instagram also takes
  `/reels/<code>` and the account name before `/p/` or `/reel/`. Facebook takes its video links
  (`/share/v/<id>`, `/share/r/<id>`, `/reel/<id>`, `/watch?v=<id>`, `/<page>/videos/<id>`, `fb.watch/<id>`) and its
  post links (`/share/p/<id>`, `/groups/<group>/permalink/<id>`, `/groups/<group>/posts/<id>`, `/<page>/posts/<id>`,
  `/permalink.php?story_fbid=<id>`). Strict direct-post path shapes can also match on an unknown host, with
  YouTube limited to official hosts. Facebook requires a long numeric id or a `pfbid` post id. An Instagram
  `/p/<id>` match needs a hostname containing `insta`. Link extraction strips matched WhatsApp formatting marks
  around a link and preserves unwrapped identifiers.
  See [Social Post Reader](tools.md#social-post-reader) for supported official paths.
- **Ordered readers.** A lookup resolves share links first, then runs the platform's normal readers in order.
  Later readers fill gaps only, and run only when they can supply a missing field. Finish on author plus text
  or media for text and photo posts, with any known video filled. Video-first targets need author, text
  and playable video. YouTube needs author, text or a title, and duration. A verified terminal result from
  a first-party API can stop the chain. A deadline or exhausted chain returns a partial result when any
  author, text, media or video was found. Intake identifies which fields it could see.
- **Post dispatch.** X is read through the fxtwitter API, Bluesky through its public API after handle-to-DID
  resolution (video comes from the author's data server when found), and Threads through its logged-out page, which
  holds only the first batch of replies. Instagram is read from its logged-out post page first, which carries the
  post in the same Meta shape as Threads (`xig_polaris_media`); when the page holds no post (gated, removed or
  refused), yt-dlp reads it. Reddit is read through its RSS feed first: a refused feed (403 or 429) is reported, and
  a feed with no video is returned without calling yt-dlp. A Facebook post link is read from its logged-out page:
  the post's text, author, date and photos (`all_subattachments`, each photo's `viewer_image`); when the page holds
  no post, or the post is a video, yt-dlp reads it. A Facebook video link and every other platform are read through yt-dlp. When yt-dlp fails on YouTube, the oEmbed endpoint still returns the title and author.
- **Photos.** A post keeps every photo of its own, in order, up to `MAX_POST_PHOTOS` (20): X's photos, Bluesky's
  images, the photo items of a Threads or Instagram carousel, and a Facebook post's photos. Its one picture (`imageUrl`) is separate: the first photo, else
  a video's thumbnail or the link card's image. Threads is read from the page's embedded post data, never its
  `og:image`, which for a post with no image is the author's profile picture. A post read through yt-dlp keeps no
  photos, only the thumbnail yt-dlp reports as its one picture.
- **Threads thread.** A Threads post that continues a thread carries the earlier posts the page holds for it
  (`containing_thread`), oldest first, at most 3: author, text and photos.
- **Safe fetching.** The pasted host for a shape match never enters network requests. The shared fetcher
  rejects forbidden and non-public addresses. A share redirect is read manually only on the platform's own
  domains, for at most two hops. Threads keeps its existing one-hop page lookup. The final address must parse
  as the same platform. Other redirects fail.
  yt-dlp runs in a fresh temporary home with an isolated environment and a 2 MiB output cap. When the binary
  is missing, lookups fail as `binary_missing`.
- **Post cache.** Successful lookups are cached by lookup key with a time limit and an entry cap; a time limit of 0
  switches the cache off. The key ignores YouTube timestamps, so a cached post is re-targeted to the link that asked
  for it. Only successes are cached.
- **Reply dispatch.** `ReplyReader` fans out to one fetcher per platform under a single timeout, and caches successes
  per lookup key and reply limit. The reply limit is clamped to between 1 and 50. X reads the conversation API
  ranked by likes with views as the tiebreak, and strips the leading mentions every reply repeats. Bluesky reads a
  depth-1 thread. Threads reuses its page batch, through the same redirect rule. YouTube reads the Data API in relevance order and re-ranks by
  likes; a disabled comment section is reported, not an error. TikTok reads its comment API. Reddit reads the RSS
  feed in top order, which carries no like counts, so its order is kept. Instagram reads yt-dlp's comment dump and
  keeps only top-level comments. Bilibili resolves the id to an aid and reads one page of 20. Facebook has no reply
  reader; its reply lookup fails as `unsupported`.
- **Reply shaping.** Deleted and removed texts are dropped. Each kept reply collapses whitespace, is sliced by code
  point so a cap cannot split an emoji, and is capped at the reply character limit. Ranking is by likes, then the
  platform tiebreak, then the order the platform returned. Totals are reported when the platform gives one.
- **Keys.** The YouTube reply fetcher reads `YOUTUBE_API_KEY` from the environment when no override is supplied.
  Without it, YouTube reply lookup fails as `not_configured`.
- **Settings.** Timeouts, text caps, cache limits and the yt-dlp path come from the `social.*` settings, listed
  with their defaults in [Tools](tools.md#social-post-reader).

## Spend

Real token counts and prices are recorded per call, in the `spend` table by month and role. The cost of a call is
the cost the provider's response reports. When it reports none, the cost is the token counts times the role's
prices in `config.yml`. A role with no reported cost and prices of 0 costs nothing on record, so set its prices
before relying on the cap. At 80% of `llm.monthlyBudgetUsd`, background work (memory
extraction, the mood judge) stops. At 100%, replies stop with the pack's limit line. A monthly budget of 0 or less
switches both gates off: background work and replies run with no spend check. The subscription transport
records estimated cost for comparison and does not count against the cap.

Claude's API reports no cost, so `main` carries Claude Haiku 5.5's prices: 0.10 in, 0.50 out and 0.01 for a cache
read, per million tokens, for prompts up to 100,000 tokens. The ModelScope fallback is paid in its own daily
credit, about one per call, not in dollars, so its prices are 0 and it does not count against the cap.

## Configuration

| Key                                                            | Default                 | Effect                                                             |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `llm.transport`                                                | `api`                   | Selects the runner                                                 |
| `llm.turnDeadlineMs`                                           | 45000                   | Hard limit for one turn's model work                               |
| `llm.maxRetries`                                               | 2                       | Main retries before fallback. Zero disables transient retries      |
| `llm.breakerMs`                                                | 600000                  | How long a breaker stays open                                      |
| `llm.monthlyBudgetUsd`                                         | 50                      | Spend cap for paid roles                                           |
| `llm.subscription.runnerUrl`                                   | `http://127.0.0.1:9882` | The host runner service                                            |
| `llm.subscription.toolServerPort`, `toolServerUrl`             | 9883                    | The core's tool server for the program                             |
| `llm.<role>.provider`                                          | see above               | `anthropic` or `openai-compatible`, for `main` and `fallback`      |
| `llm.<role>.model`, `baseUrl`                                  | see above               | The model id and its endpoint                                      |
| `llm.<role>.effort`                                            | `medium`, `high`        | Effort for `main` and `fallback`. Empty: the model's default       |
| `llm.<role>.usdPerMTokIn`, `usdPerMTokOut`, `usdPerMTokCached` | see `config.yml`        | Prices for `main` and `fallback`, in US dollars per million tokens |
| `media.watcher.model`                                          | `gemini-3.5-flash-lite` | The media model, on Google AI Studio. Key: `MEDIA_WATCHER_API_KEY` |
| `media.gatewayDirs`                                            | empty                   | `host` and `container` pairs of the gateway's media folders        |
| `media.timeoutMs`                                              | 30000                   | One media read, within two thirds of the time left in the turn     |
| `media.maxVideoSeconds`                                        | 300                     | Longest video that is watched                                      |
| `media.maxLinkVideoSeconds`                                    | 600                     | Longest span watched from a YouTube link                           |
| `YOUTUBE_API_KEY` (env)                                        | unset                   | Without it, YouTube reply lookup fails as `not_configured`         |
