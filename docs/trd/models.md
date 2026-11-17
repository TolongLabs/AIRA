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
- If the service is down, the core treats the transport as unavailable and uses the fallback role.
- On this transport the fallback model answers on the API runner, with a breaker of its own. Memory extraction
  uses `llm.main` when it has a key, else `llm.fallback`. With neither, nothing is extracted.
- One run is one program start. There is no retry inside the subscription runner.

### Run Request

The core sends one request per turn to `POST <runnerUrl>/run`, with the shared secret `RUNNER_TOKEN` as a bearer
token. The service answers with the program's output lines as they arrive, one JSON object per line.

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
   two thirds of the time left in the turn deadline, so the main model keeps at least a third. The media model returns
   a description, and a transcript where there is speech. It runs on the free tier of its own key, so its calls record
   their tokens with a cost of 0 and do not count against the spend cap.
6. **Into the prompt.** The descriptions enter prompt block 4 as one labelled, untrusted block, clipped to a fixed
   budget so that media cannot push the prompt over its ceiling. The budget is 4,500 characters, split evenly across
   the readable files and links of the turn. The main model never receives the file.
   See [Prompt Engine](prompt-engine.md#prompt-blocks).
7. **Links.** The first link in the turn's messages to a YouTube video or a supported social post (newest message text
   first, then quoted text) is opened at intake, at most one per turn, unless the turn's commands already name
   `read_post` or `read_page`. `features.media` off means no file (rule 8 notes it as `off`) and no YouTube link is
   read; `features.social` off means no post link is read. A YouTube video is sent to the media model as its own
   URL (`file_data`) at low media resolution (`MEDIA_RESOLUTION_LOW`), starting from its offset if any (the `t=`
   or `start=` parameter or a `#t=` fragment, in seconds or clock form), and watched for at
   most `media.maxLinkVideoSeconds` (default 600) through `video_metadata` offsets (measured: a 3-minute video in 5 s,
   about 19,000 tokens). A longer YouTube video is clipped, never refused, and the description the model receives says
   it covers only the first part; a private or removed video fails with reason `unavailable`. A post's video is fetched
   under the same size and `media.maxVideoSeconds` limits as a file, falling back to its image or text only. A failed
   link lookup adds an unreadable note with the platform and reason `link`; neither the note nor any log carries the
   URL. The result enters block 4 like a file's description, and failures follow rule 8. Ported from rokabot's media
   and social readers.
8. **Failure.** A file that is refused, over a limit, of an unsupported type, unread because media is off, or whose
   read fails or times out, does not end the turn. Block 4 gets a short note naming the kind of file and why, and the
   pack's `unreadableMedia` line. The model tells the sender in its own voice, so the reply can also answer the
   files that were read and the text that came with them. The note never carries the path.
9. **Record.** Every request to the media model is one `model_call` row with role `media`, with its tokens and its
   failure kind when it failed. Every unreadable file is one `failure` row with kind `media_unreadable`, stage
   `media`, handled by `line:unreadableMedia`, and a message with the kind of file and the reason, never the path.
   The turn itself stays `delivered`. An `auth` failure of the media role also alerts the operator.

![How attached files and shared links are read at intake, with limits and refusals](../diagrams/media-intake.svg)

With no media model or no `MEDIA_WATCHER_API_KEY`, media is off: the core logs `media.off` once at start-up, files
are not read, and each one gets the unreadable note with the reason `off`. The turn still answers.

Video from a linked social post is fetched by the social tool and passed through the same path.

A link read at intake is not opened again in the same turn: `read_page` and `read_post` refuse its canonical URL with
kind `refused`, and the link note tells the model it is already open. A link whose watch or read failed is not
refused, so the model may read the page instead, and the footer then shows a page read.

## Social Post And Reply Readers

Link intake and the social tools read public posts and their replies through one subsystem in `src/social`. It
covers eight platforms: X, Bluesky, Threads, YouTube, TikTok, Reddit, Instagram and Bilibili.

![How a shared link is normalised, fetched per platform, and cached](../diagrams/social-readers.svg)

- **URLs.** `parseSocialPostUrl` accepts only `https` links with no user info, port or IP host. Each platform has a
  fixed host list and an id pattern, and yields a canonical URL, an extractor URL and a lookup key. The Bluesky key
  carries the profile; the YouTube target carries the start offset from rule 7 of Media Watching.
- **Post dispatch.** X is read through the fxtwitter API, Bluesky through its public API after handle-to-DID
  resolution (video comes from the author's data server when found), and Threads through its logged-out page, which
  holds only the first batch of replies. Reddit is read through its RSS feed first: a refused feed (403 or 429) is
  reported, and a feed with no video is returned without calling yt-dlp. Every other platform is read through
  yt-dlp. When yt-dlp fails on YouTube, the oEmbed endpoint still returns the title and author.
- **Safe fetching.** The shared fetcher rejects forbidden and non-public addresses and never follows redirects, so
  a redirect cannot smuggle in a private host. yt-dlp runs in a fresh temporary home with an isolated environment,
  and its output is capped at 2 MiB. When the binary is missing, lookups fail as `binary_missing`.
- **Post cache.** Successful lookups are cached by lookup key with a time limit and an entry cap; a time limit of 0
  switches the cache off. The key ignores YouTube timestamps, so a cached post is re-targeted to the link that asked
  for it. Only successes are cached.
- **Reply dispatch.** `ReplyReader` fans out to one fetcher per platform under a single timeout, and caches successes
  per lookup key and reply limit. The reply limit is clamped to between 1 and 50. X reads the conversation API
  ranked by likes with views as the tiebreak, and strips the leading mentions every reply repeats. Bluesky reads a
  depth-1 thread. Threads reuses its page batch. YouTube reads the Data API in relevance order and re-ranks by
  likes; a disabled comment section is reported, not an error. TikTok reads its comment API. Reddit reads the RSS
  feed in top order, which carries no like counts, so its order is kept. Instagram reads yt-dlp's comment dump and
  keeps only top-level comments. Bilibili resolves the id to an aid and reads one page of 20.
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
| `llm.maxRetries`                                               | 2                       | Retries for a `transient` failure                                  |
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
| `media.maxVideoSeconds`                                        | 180                     | Longest video that is watched                                      |
| `media.maxLinkVideoSeconds`                                    | 600                     | Longest span watched from a YouTube link                           |
| `YOUTUBE_API_KEY` (env)                                        | unset                   | Without it, YouTube reply lookup fails as `not_configured`         |
