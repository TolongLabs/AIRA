# Media Pipelines

How AIRA reads the files members send and the posts they link, and how it fetches a post's own media back to a chat.
This module owns the contracts of the intake read, the social post readers and autofetch. [Models](models.md),
[Tools](tools.md) and [System](system.md) link here.

## At a Glance

| Item                            | Value                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Intake read                     | Before the main model runs, the core watches the turn's files and its first YouTube or post link ([Media Watching](#media-watching))     |
| Social post readers             | One subsystem in `src/social` serves intake, `read_post` and autofetch ([Social Post And Reply Readers](#social-post-and-reply-readers)) |
| Autofetch                       | A chat that opts in gets a linked post's own media back, with no model call ([Autofetch](#autofetch))                                    |
| Media model                     | `media.watcher.model`, default `gemini-3.5-flash-lite`, on its own key `MEDIA_WATCHER_API_KEY` ([Configuration](#configuration))         |
| Where the model role is defined | [Models](models.md#roles)                                                                                                                |

## Contract Map

| Contract                             | Where                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acquisition                          | [How Media Reaches The Core](#how-media-reaches-the-core), [Quoted Media](#quoted-media)                                                                                 |
| Source validation                    | [Media Watching](#media-watching) rules 2 to 4, [Post URLs And Source Checks](#post-urls-and-source-checks), [Redirects And Safe Fetching](#redirects-and-safe-fetching) |
| Shared lookup                        | [Shared Lookup](#shared-lookup), [Media Watching](#media-watching) rule 5                                                                                                |
| Independent per-chat gates           | [Per-Chat Gates](#per-chat-gates)                                                                                                                                        |
| Reader chains and redirect rules     | [Reader Chains](#reader-chains), [Redirects And Safe Fetching](#redirects-and-safe-fetching)                                                                             |
| Metadata and video evidence          | [Metadata And Video Evidence](#metadata-and-video-evidence)                                                                                                              |
| Deadlines                            | [Deadlines](#deadlines)                                                                                                                                                  |
| Segmented YouTube reads              | [YouTube Links](#youtube-links), [Media Watching](#media-watching) rule 10                                                                                               |
| Receipt, dedup, repeat and lifecycle | [Autofetch](#autofetch)                                                                                                                                                  |
| Failure handling                     | [Media Failures](#media-failures), [Media Records](#media-records), [Post Result And Failure Mapping](#post-result-and-failure-mapping), [Autofetch](#autofetch)         |
| Key configuration                    | [Configuration](#configuration)                                                                                                                                          |
| Code and tests                       | [Implementation And Tests](#implementation-and-tests)                                                                                                                    |

## Standalone Inbound Media Evaluation

The released standalone transport still accepts admitted text only. Its explicitly negotiated document capability
delivers a core-generated report; it does not admit inbound media. Synthetic stock Hermes v0.23.2, v0.23.3 and
v0.23.4 tests in `tests/install/hermes_capabilities_fixture.py` exercise the actual event builder and installed
v1, v2 text and v2 document routes. All three routes refuse the normalized image, audio, voice, video, PDF, sticker,
location, remote-cache failure, quoted-media and inlined-text document events without a core POST, native send
or Hermes model fallback. An admitted text event is the positive control.

Stock reaction, poll creation/update and contact events are different: Hermes exposes their formatted summaries
as `MessageType.TEXT` while retaining distinct native metadata. All three released routes currently forward
these admitted summaries as untrusted ordinary text, not as structured reaction/poll/contact operations.
A native-event admission decision and exact-helper migration are still needed to enforce a stricter
ordinary-text-only policy; do not mistake this existing behavior for feature support.

Stock normalization is not a portable media authorization. It folds quoted content into the same attachment
arrays even when the quoted message ID is missing, can retain an image URL after caching fails, clears a
captionless voice placeholder and may prepend document contents to the text. Native file-send methods
do not prove a safe inbound path or sticker/reaction delivery. The next candidate must separately negotiate
direct, bounded, owned profile-cache content and an explicitly applied media role; it must not infer authority
from a path, URL, quoted array, file extension or inlined text. No additional capability or public support
is enabled by this evaluation.

## Standalone Direct Media

The new explicit direct-media helper generation uses only stock admitted native ordinary text
(`conversation`, `extendedTextMessage`) and direct native `imageMessage`, `audioMessage`, `pttMessage`,
`videoMessage` and `documentMessage` events. Raw and normalized native types, media arrays and admitted
identity must agree. Native summaries, quotes (even without a quote ID), inlined documents, remote
URLs, multiple files, alternate profiles, unsupported types and ambiguous input refuse with no fallback.
Older exact helpers retain their historical behavior.

The host reads one regular, owned, nonsymlink file directly inside the selected profile's canonical
stock cache directory (image, audio or document; stock video uses document cache). The finite MIME
and signature allowlist is PNG/JPEG, Ogg/MPEG audio, MP4 video and PDF; only the explicit Ogg Opus
parameter may be normalized. Enforce 5 MiB of nonempty bytes on both sides; format signatures are a
sanity check, not full decoding. Never transmit the original name, host path, remote URL or quote.
For captionless events use a neutral attachment placeholder.

The typed media turn adds `media:{kind,mime,sha256,base64}` to the strict v2 text turn. The kind is
`image`, `audio`, `voice`, `video` or `document`. The core verifies canonical base64, size, SHA-256,
MIME/kind/signature and current authenticated route, profile and chat. Only the media endpoint accepts
the bounded larger request (base64 limit plus 256 KiB); admit at most four concurrent media requests.
An active, known chat, resolved `features.media` and an explicitly applied media watcher are required.
The normal turn admission still enforces sender, mute, binding, spend and deduplication. Recheck route
and chat permission at intake; mixed-route batches cannot grant media authority. Replays cannot cause
another reading or native delivery claim.

The verified bytes are held only in the bounded process-owned turn queue, never persisted or mapped
from a legacy path/note. Restart cannot recover raw attachments. Use the existing media reading limits
and failure handling; no identify-image, social link intake or arbitrary outbound media is enabled.
Replies use existing [typed delivery](system.md#standalone-typed-delivery). No public live claim follows
from synthetic tests.

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
5. **The read.** Concurrent consumers of an identical social lookup or asset download share the pending work.
   Each keeps its own deadline. The last consumer to cancel stops the transfer. Only downloads with the same
   network policy, URL, headers, byte limit and range can share bytes.
   All files of a turn are read at once, each with its own timeout: `media.timeoutMs`, and at most
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
   segment attempt is its own request and its own `model_call` row. Only a final missing segment while another
   answers is one `failure` row of kind `media_unreadable`, handled by `coverage:partial`.
10. **Long YouTube videos.** The initial ranges run in parallel, with bounded same-range recovery only for
    eligible fast failures. Keep final readings in chronological order, and name any missing ranges in block 4.
    See [YouTube Links](#youtube-links) for the planner, deadlines, recovery, and evidence contract.

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

A YouTube video is watched from its URL, except for the verified Short fallback below. The start offset comes
from the `t` or `start` parameter or a `#t=` fragment, in seconds or clock form (`src/social/urls.ts`). The span is capped at
`media.maxLinkVideoSeconds` from that offset. A longer video is clipped, never refused.

The span is split by `planLinkSegments`: one short first segment (`media.linkFirstSegmentSeconds`, 60), then full
segments (`media.linkSegmentSeconds`, 180). A last segment under 30 s joins the one before. At most
`media.maxLinkSegments` (4) are kept; the rest stays unwatched (`src/media/link-segments.ts`).

All kept segments are initially watched at once. Each call sends its own `video_metadata` offsets at
`media.linkFps` (0.25) and low media resolution. Preserve the selected URL, start offset, plan and single whole-video
request. An unknown-length video gets one segment from its start offset and an explicit unknown-length label.

#### Watch Deadline And Recovery

The outer deadline is monotonic, set at link-reader entry from the effective media timeout. Lookup consumes it.
The URL deadline is the earlier of that outer deadline and the end of lookup plus `media.linkWatchMs` (22,000 ms).
An explicit configured value overrides the default. No lookup starts for a nonpositive caller or reader budget.
A usable lookup arriving after expiry starts no watcher or download. A found social post retains its ordinary
text-only disposition; YouTube retains available metadata and reports unreadable (or off if no URL watcher).
The finite lookup trace grace does not authorize work. Initial URL calls may use all remaining watch
time. On expiry, cancel all pending attempts and retry waits, retain completed results, and return even if the
watcher ignores cancellation. No attempt starts after expiry or return, and a reading completing after the
monotonic deadline is not credited even if the local timeout callback has not fired.

Each eligible failed range may retry once with the exact original URL, MIME, offsets, fps, model and prompt.
A link permits at most two retry launches, with one retry in flight. Process completions as they arrive, queue
by earliest due time then segment order, and release the initial slot before retrying. Default concurrent URL
calls never exceed four. Delay a retry by 500–1,000 ms with jitter; require at least 5,000 ms of watch time
after the wait, both when queuing and when launching. Do not extend either deadline.

The watcher exposes a media-local discriminated detail (`type` field) on `MediaWatchError.detail` (a
`ModelError`): `network`, `http_transient` (408/5xx), `rate_limit` (with optional finite `retryAfterMs`), `parse`, `http_client`,
`abort`, `auth`, or `refusal`. Intake exposes the same detail on failed `MediaOutcome.failureDetail`, also
distinguishing local `timeout`, `unavailable`, and plain alternate-watcher `transient`. Only network,
HTTP transient and unaborted plain transient failures are eligible outside rate limits. Keep the durable
failure kind unchanged, and preserve sanitized unavailable detection. No retries for local timeout, abort,
parse/client errors, unavailable, auth/refusal, budget or off. An auth failure stops retries and aborts remaining
URL calls while retaining completed readings. Parser accepts a nullable or empty transcript as omitted;
description is required (1–2,000 characters), transcript at most 6,000 characters. Invalid JSON or schema
remains malformed; explicit content-filter, recitation, escalation or account-policy blocks remain refusal,
not every non-STOP finish reason. See the provider's [finish reason contract](https://ai.google.dev/api/generate-content#FinishReason).

A 429 is retryable only with a valid, fitting Retry-After: nonnegative delay seconds or a valid HTTP-date
relative to receipt time (past date means zero), including obsolete HTTP-date forms interpreted in UTC per
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7). Invalid, missing, negative, nonfinite
and too-late hints do not authorize a retry for that range. A valid hint postpones every queued/new retry
until its due time (and local
minimum backoff). A second actual 429, including initial attempts, stops all queued and new retries. Existing
in-flight calls may settle. Do not log raw response headers or provider content.

For an eligible verified zero-offset Short with available byte downloader and duration within the existing
limits (unknown duration uses the existing 180 s estimate), cap the entire URL watch/recovery window at the
earlier of 12,000 ms, the configured watch limit, and remaining outer time. If no URL reading answered, the
existing verified Short download/read may use the remaining outer time, unless there was any auth/refusal or
an unresolved rate limit in the final URL outcomes. Neither download nor byte watch may start after expiry.
Preserve identity, size and duration checks. Normal or nonzero-offset videos do not use this fallback.

#### Coverage And Evidence

Keep the plan, known duration and one final reading slot per original segment as internal
`LinkSegmentEvidence` (`plan`, `durationSec`, `readings`). A successful URL watch attaches this to
`LinkReading.youtubeEvidence` alongside its derived legacy reading; a byte fallback does not fabricate
URL coverage. Recovered ranges replace their failed slot; successful slots appear once in chronological
order. Only final missing ranges beside answered ones become `coverage:partial` rows. All failed means
ordinary unreadable (private or removed videos use `unavailable`), not a reading from metadata.

Coverage means a valid reading of a requested interval, not proof of perceiving every frame or sentence.
Render structured evidence directly at the final item budget, reserving missing intervals, clip boundary
and unknown length first, then labels and nonempty prose for each successful range. No second whole-string
tail clipping. Keep the exact normal-plan interval labels. Under extreme pressure, use compact counts and
explicit evidence compression, not false unseen or fully watched claims. Keep exact gaps when a compression
notice can also fit; otherwise use the compact count and coverage-limited statement. Share remaining prose
proportionally to successful interval duration, with a target 160-character description floor where possible, and allocate
speech only to nonempty transcripts. Metadata is limited to the smaller of 450 characters and 20% of the
item's share, including labels and separators. The existing 4,500-character shared evidence budget and equal
per-item shares stay in force. Other media formatting, untrusted labels, footer and prompt ceiling stay unchanged.
A short full single-range watch needs no clock labels; a nonzero offset retains subspan context.

![One YouTube link watched in parallel segments under one time budget](../diagrams/youtube-watch.svg)

### Post Links

A social post reaches the turn through the reader in
[Social Post And Reply Readers](#social-post-and-reply-readers). Thirteen platforms are covered, as listed there.
Intake can look for links up to three user-message
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
continues to use the platform and native attachment rules in [Autofetch](#autofetch).
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

### Media Limits

| Limit                  | Key And Default                                    | At The Limit                                                                            |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Files from one message | Code `MAX_MEDIA_PER_MESSAGE`, 3                    | Extras are skipped, never failures (`src/media/turn-media.ts`)                          |
| Files in one turn      | Code `MAX_MEDIA_PER_TURN`, 6, newest first         | Extras are skipped (`src/media/turn-media.ts`)                                          |
| File size              | Code default, 20,000,000 bytes, no config key      | Refused as `too large` before the file is read (`src/media/limits.ts`)                  |
| Video length           | `media.maxVideoSeconds`, 300                       | Refused as `too long` (`src/media/limits.ts`)                                           |
| Audio length           | Code default, 600 seconds                          | Refused as `too long`, only when the sender reported one (`src/media/limits.ts`)        |
| One media read         | `media.timeoutMs`, 30000, at most two thirds left  | The read fails and the file is unreadable (`src/media/turn-media.ts`)                   |
| All YouTube segments   | `media.linkWatchMs`, 22000                         | Running segments abort; answered ones still merge (`src/media/link-intake.ts`)          |
| Photos from one link   | Code `MAX_LINK_PHOTOS`, 4                          | The rest are named as not watched (`src/media/link-intake.ts`)                          |
| Photos kept per post   | Code `MAX_POST_PHOTOS`, 20                         | The rest are dropped (`src/social/parsers.ts`)                                          |
| Media text in block 4  | Code `MEDIA_TEXT_BUDGET`, 4,500 characters         | Bounded shares across the turn's readable items (`src/media/turn-media.ts`)             |
| Watcher answer         | 120 words, 300-word transcript, schema 2,000 chars | Over-long text fails validation; the file is unreadable (`src/media/gemini-watcher.ts`) |

An attached video's length is never checked: a gateway attachment names only a kind and a path, so no duration
reaches the check (`src/media/files.ts`). A voice note's duration is likewise absent, so only its size applies.

With no media model or no `MEDIA_WATCHER_API_KEY`, media is off: the core logs `media.off` once at start-up, files
are not read, and each one gets the unreadable note with the reason `off`. The turn still answers.

### Media Records

- Every request to the media model is one `model_call` row with role `media`. It carries the tokens and a cost
  of 0. A failed call carries its failure kind. Each YouTube segment attempt is its own row
  (`src/media/turn-media.ts`, `src/media/link-intake.ts`).
- Every unreadable file is one `failure` row: kind `media_unreadable`, stage `media`, handled by
  `line:unreadableMedia`. Its message names the kind of file and the reason (`src/turn/pipeline.ts`).
- A YouTube URL initial attempt records `attempt: 1`; retry records `attempt: 2`. A queued attempt that
  never launches has no row. A recovered range retains both model-call rows but no partial failure row.
  Each final missing range beside an answered one has one `coverage:partial` failure row.
- The URL-free `media.link_segments` event records `segments`, `answered`, `failed`, `attempts`, `retried`,
  `recovered`, `timedOut`, `cancelled`, `failureKinds` (bounded durable enum counts), `watchMs`,
  `watchBudgetMs`, `rateLimitStopped`, `plannedSeconds`, `answeredSeconds`, `clipped`, and `unknownLength`.
  Counts reflect actual URL attempts and final gaps, not byte fallback or skipped lookups. No link, identifier,
  raw error, header or media text enters this event.
- The turn itself stays `delivered`.
- An `auth` failure of the media role also alerts the operator (`src/turn/pipeline.ts`).
- Never stored: the file, its path, the link URL. Logs carry platform and reason only
  (`src/media/link-intake.ts`). Block 4 notes name kind and reason only, never the path
  (`src/media/turn-media.ts`).

### Media Failures

Every media failure is contained. The turn continues and answers in character.

| Failure                                                                                                            | What The Member Sees                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Refused path, missing file, unsupported type, empty file, too large, too long, media off, failed read, failed link | An in-character acknowledgment beside the files that were read (rule 8) |
| One YouTube segment fails while another answers                                                                    | Nothing about the failure; the merged text names the unwatched part     |
| Every segment fails                                                                                                | The whole video unreadable; the post text stays when the lookup gave it |
| Private or removed video                                                                                           | Unreadable with the reason `unavailable`                                |
| Media model auth failure                                                                                           | The same unreadable outcome, plus an operator alert                     |

## Per-Chat Gates

Reading and fetching are separate switches, each set per chat. A switch that is off leaves the others as they are.

| Switch                     | Default | When Off                                                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `features.media`           | `true`  | No attached file and no YouTube link is read. Each file gets the unreadable note with the reason `off` |
| `features.social`          | `true`  | No post link is read at intake. `read_post` needs it                                                   |
| `features.autofetch`       | `false` | A post link in the chat gets none of its media back                                                    |
| `social.platforms.<id>`    | `true`  | That platform's links are plain text for intake, and `read_post` refuses them                          |
| `autofetch.platforms.<id>` | `true`  | Autofetch skips that platform's links                                                                  |

Defaults are the registered defaults in `src/settings/keys.ts`. `<id>` is a platform the adapters can read or fetch.

A disabled `social.platforms.<id>` makes that platform's link plain text for intake and refuses a
`read_post` call for the link or its source ID. The page tool and automatic page reads from typed search also respect that
choice while `features.search` is on, including when `features.social` is off. Recognise equivalent HTTP
links, explicit default ports and a trailing DNS dot for this local check before selecting a page for reading.
A disabled `autofetch.platforms.<id>` skips fetch independently in groups and DMs. Apply each check to the parsed
platform before resolving a share, calling a reader or fetching bytes. Record `platform_disabled` for
the skipped lookup with zero reader attempts. A skipped link leaves later eligible links and their
lookup slots available and creates no repeat reservation. The YouTube watch gate still applies.

## Social Post And Reply Readers

### Shared Lookup

Link intake and the social tools read public posts and their replies through one subsystem in `src/social`. It
covers thirteen platforms: X, Bluesky, Threads, YouTube, TikTok, Reddit, Instagram, Bilibili, Facebook, Lemon8, Rednote, Douyin and LinkedIn.

![How a shared link is normalised, fetched per platform, and cached](../diagrams/social-readers.svg)

Intake, `read_post` and chat autofetch use the same post resolver and reader dispatch. A reader may return
partial data. Previews, cards and quoted or earlier-thread media can describe a post to the reader. Group
delivery requires separate native attachment evidence. Enable a new operation only after verifying the
specific post identity, fields, retrieval permission and intended use. Xiaohongshu/Rednote, Douyin and
LinkedIn start off by default until `social.mirrors.rednote`, `social.mirrors.douyin` or
`social.mirrors.linkedin` and `APIFY_API_TOKEN` (or `APIFY_API_KEY`) are configured. Evaluate reading,
intake and redistribution independently. A public embed or a public browser
page does not establish permission for automated reads, model processing or redistribution. Douyin
documents OAuth-protected account capabilities. Record the approved fields and uses before enabling a provider.
[Douyin capabilities](https://partner.open-douyin.com/docs/resource/zh-CN/dop/ability/common-solution).

Concurrent consumers of an identical lookup share the pending work, as rule 5 of [Media Watching](#media-watching) sets out.

- **Post cache.** Successful lookups are cached by lookup key with a time limit and an entry cap; a time limit of 0
  switches the cache off. The key ignores YouTube timestamps, so a cached post is re-targeted to the link that asked
  for it. Only successes are cached.
- **Settings.** Timeouts, text caps, cache limits and the yt-dlp path come from the `social.*` settings, listed
  with their defaults in [Configuration](#configuration).

### Post URLs And Source Checks

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
  See [Redirects And Safe Fetching](#redirects-and-safe-fetching) for supported official paths.

A post link in a member's message is read
at intake instead of through `read_post`, with its media watched ([Post Links](#post-links)). A repeat read of that URL or a
recognised alias returns the same turn’s post and visual evidence without another provider request.
Both media pipelines extract the same URL candidates from message text. Terminal Chinese and Japanese
sentence punctuation and enclosing quotation marks are outside a link. An official HTTPS hostname with a
terminal DNS dot uses the same platform parser and canonical destination as its undotted spelling.
Decode percent-encoded unreserved ASCII characters in paths once. Keep encoded separators and the original URL
intact. YouTube watch pages accept a trailing slash, Reddit gallery links use the post ID, and official LinkedIn
embed links accept literal or encoded URN colons.
Profiles and home pages use `read_page`. Direct post paths can also be recognised on an unknown host when
their platform shape is strict. Lookups use the platform target. The unknown host is logged by hostname only.
YouTube requires an official host. Instagram's `/p/<id>` needs an Instagram-like hostname on an unknown host.
Facebook's unknown-host shapes require a long numeric id or a `pfbid` post id.

Excluded source hosts and their short links receive a generic refusal. Page reads, post reads, redirects and
search results must respect host exclusions before retrieving or passing content to the model.

### Reader Chains

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
  no post, or the post is a video, yt-dlp reads it. For an official group permalink, T0 keeps the group and post
  identity after resolving a share. A video with a different ID is deliverable only when the matching story lists
  that native video attachment and the extractor reports the same group permalink. Evidence is local to one lookup. Facebook video links, Bilibili and YouTube use yt-dlp. YouTube can fall back to oEmbed for title and author.
  Lemon8 uses its logged-out article page. See [Platform Mirrors And Readers](#platform-mirrors-and-readers)
  for the TikTok, Reddit, Rednote, Douyin and LinkedIn chains.
- **Photos.** A post keeps every photo of its own, in order, up to `MAX_POST_PHOTOS` (20): X's photos, Bluesky's
  images, the photo items of a Threads or Instagram carousel, and a Facebook post's photos. Its one picture (`imageUrl`) is separate: the first photo, else
  a video's thumbnail or the link card's image. Threads is read from the page's embedded post data, never its
  `og:image`, which for a post with no image is the author's profile picture. A post read through yt-dlp keeps no
  photos, only the thumbnail yt-dlp reports as its one picture.
- **Threads thread.** A Threads post that continues a thread carries the earlier posts the page holds for it
  (`containing_thread`), oldest first, at most 3: author, text and photos.

A chain runs readers in priority order within one social lookup deadline. Later readers can fill missing
fields without replacing a value already found, except that a photo list can improve a single picture.
A platform name or known access-block stub does not count as text. Any usable post fields can produce a
partial result. Only a first-party API can stop the chain on a confirmed private or removed post.

### Redirects And Safe Fetching

- **Safe fetching.** The pasted host for a shape match never enters network requests. The shared fetcher
  rejects forbidden and non-public addresses. A share redirect is read manually only on the platform's own
  domains, for at most two hops. Threads keeps its existing one-hop page lookup. The final address must parse
  as the same platform. Other redirects fail.
  yt-dlp runs in a fresh temporary home with an isolated environment and a 2 MiB output cap. When the binary
  is missing, lookups fail as `binary_missing`.

Official direct paths include Reddit comment permalinks, TikTok photos, Threads posts with or without an account,
Facebook stories and photos, Instagram TV, YouTube live and embeds, and X web-status links. Official short
links from Reddit, TikTok, Bilibili, Facebook and Instagram use a shared guarded resolver. It allows up to two
manual redirects within the platform and 1,500 ms total. Successful resolutions use a bounded TTL cache. The viewer reuses the resolved post key for shares and direct links.
Reddit media CDN addresses do not name posts. A failed intake blocks equivalent post and timestamp spellings
in the same turn using the same identity as a successful reading.
Threads keeps its existing one-hop guarded page lookup. The final address must parse as a post on the same platform.
TikTok and Reddit desktop, mobile and app share links for the same post converge on its canonical lookup key.
A share token remains provisional until the guarded resolver verifies a direct post URL. The resolved identity
is used for viewer lookup and for deduplication of eligible group fetches. URL recognition and resolution grant
no media capability.

Plain page reads follow their own redirect rules, set out in [Page Reads](tools.md#page-reads).

### Metadata And Video Evidence

Reader output can carry group attachment evidence from the source that proved the post identity and media
type. Bind evidence to the resolved native post and rendition before fallback. Keep duration with its video
rendition. A reader result that explicitly identifies a different post does not fill missing fields.
An extractor thumbnail, feed image, link card or cover cannot establish a native photo.

Video delivery requires a native video attachment bound to the selected post. Enable each non-YouTube
platform's video operation only after three successful live checks on each host. Keep a platform at its
verified capability if either host lacks a suitable attachment. Preserve mirror settings and per-chat scope.
A Bilibili link with an explicit positive part number keeps that part in the canonical URL, extractor URL,
lookup key and repeat reservation. Match the extractor's BV and part before delivery. An unqualified link cannot
deliver an ambiguous multipart result. Malformed or repeated part selectors remain recognizable for read
policy and cannot select a delivery attachment. The fetch catalog lists extractor-backed video operations
only when the extractor is installed. Live streams and playlists supply no delivery attachment.
For file limits, duration and receipt handling see [Autofetch](#autofetch).

### Platform Mirrors And Readers

Lemon8 uses its first-party logged-out article page for reading, model processing and native photo or
video delivery on both hosts. The owner confirmed those uses for this deployment. Parse official
`www.lemon8-app.com/@handle/{19-digit-id}` links including the encoded at sign and the equivalent apex-domain link. Preserve a valid two-letter region. Resolve alphanumeric
`s.lemon8-app.com/s/{code}` and `v.lemon8-app.com/al/{code}` shares through the existing bounded
resolver. Only a matching official post can supply content. Profiles, campaigns and expired shares
supply none. The page can redirect to the same post with a region parameter.

The single page reader matches the ID and author handle in its own article detail record. Read its
title and body as plain text. A gallery supplies its own ordered images. A video supplies its own
playable URL and a cover for preview. Bind each native rendition to the verified target. Omit avatars,
share cards, recommendations, summaries and comments. The replies operation is unsupported. Only use
HTTPS media from the verified CDN domain. The TikTok mirror setting does not govern first-party Lemon8 media.
Keep the shared MIME checks, download limits, receipt cleanup
and inherited per-chat read and fetch settings. The native video duration can omit a fractional second.
Measure a reported 300-second video before delivery, applying the shared 300-second limit. Enable photos
and video for delivery after three successful application checks per host. There is no extractor fallback.

LinkedIn uses an opt-in Apify mirror (`social.mirrors.linkedin`: `off`, `read`, or `read_and_group`,
default `off`) backed by `APIFY_API_TOKEN` (or `APIFY_API_KEY`) in `.env` and actor
`apimaestro~linkedin-post-detail`. Without both the mirror switch and token no reader runs and LinkedIn
stays out of the active capability lists. Recognise `/posts/{slug}-(activity|ugcPost)-{id}` and
`/feed/update/urn:li:(activity|ugcPost|share):{id}` on `linkedin.com` and `www.linkedin.com`, plus
`lnkd.in/{code}` and `lnkd.in/p/{code}` share links resolved through the guarded share resolver. Reserve
subdomains of `linkedin.com` and `lnkd.in` from unknown-host selection. The reader verifies a matching
post ID or URN, takes ordered gallery images or native video with duration from `media[]`, and accepts
only HTTPS media on `*.licdn.com` (excluding `/profile-displayphoto-` avatars). Lookups get a 20,000 ms
budget.

On the official Douyin Jingxuan feed, a single 19-digit `modal_id` identifies the selected video.
The category and tracking query fields do not change that identity.

Douyin uses an opt-in Apify mirror (`social.mirrors.douyin`: `off`, `read`, or `read_and_group`, default
`off`) backed by `APIFY_API_TOKEN` (or `APIFY_API_KEY`) in `.env` and actor
`natanielsantos~douyin-scraper`. Without both the mirror switch and token no reader runs and Douyin stays
out of the active capability lists. Recognise `www.douyin.com/video/{id}` and
`www.iesdouyin.com/share/video/{id}` with a 19-digit post ID, normalizing to
`https://www.douyin.com/video/{id}` (`douyin:{id}`). Recognise alphanumeric share codes on
`v.douyin.com/{code}` and resolve them through the guarded share resolver (up to 2 manual HTTPS hops
within `douyin.com` and `iesdouyin.com`) before calling Apify. Reserve both domains and their subdomains
from unknown-host post selection. Apify receives only the canonical video URL, never the original share
token or chat data. The reader requires a matching `id`, maps `videoMeta.duration` (ms) to seconds,
accepts `videoMeta.playUrl` on a verified Douyin media host (`*.douyinvod.com`, `*.zjcdn.com`,
`*.amemv.com`, or `*.bytecdn.cn`) downloaded cookieless across Douyin's CDN redirects, and takes previews
only from `*.douyinpic.com`. Lookups get a 20,000 ms budget.

Xiaohongshu (Rednote) uses an opt-in Apify mirror (`social.mirrors.rednote`: `off`, `read`, or
`read_and_group`, default `off`) backed by `APIFY_API_TOKEN` (or `APIFY_API_KEY`) in `.env` and actor
`socialdatax~socialdatax-xhs-data-api`. Both China and international note pages redirect logged-out
requests to login, so without both the mirror switch and token no reader runs and Rednote stays out of
the active capability lists. Recognise `/explore/{id}` and `/discovery/item/{id}` for 24 hexadecimal
digits on the apex or `www` hosts of `xiaohongshu.com` and `rednote.com`, normalizing to
`https://www.xiaohongshu.com/explore/{id}` (`rednote:{id}`). Recognise alphanumeric short codes at
`xhslink.com/{code}`, `xhslink.com/o/{code}` and `xhslink.cn/o/{code}`, resolving them through the
guarded share resolver. Upgrade legacy HTTP links on the exact short hosts locally before any request.
Use HTTPS for the resolution (up to 2 manual HTTPS hops within those domains, 8,000 ms budget) so invalid
shares stop before calling Apify and direct and share links converge on one lookup key. Reserve all
subdomains of those four domains from unknown-host selection. Apify receives only the resolved 24-hex
`note_id`, never the original share token or chat data. The reader requires a matching `note_id`, takes
ordered gallery photos from `image_items` for image notes and the playable `video_video_url` with
`video_duration_ms` for video notes (keeping `cover_image_url` as preview only), and accepts only HTTPS
media on `*.xhscdn.com` (excluding `sns-avatar-*` hosts from post media). Lookups get a 20,000 ms
budget to cover share resolution and the Apify run. Keep the query and short code out of logs.

TikTok, Reddit, Rednote, Douyin and LinkedIn can opt into a fixed mirror using `social.mirrors.tiktok`,
`social.mirrors.reddit`, `social.mirrors.rednote`, `social.mirrors.douyin` or `social.mirrors.linkedin`.
When `social.mirrors.tiktok` is enabled and `APIFY_API_TOKEN` (or `APIFY_API_KEY`) is set,
`tiktok.apify` (`gentle_cloud~tiktok-videos-watermark-free-scraper`) backs up `tiktok.tikwm` before
falling back to `yt-dlp`; its watermark-free MP4 on `https://api.apify.com/v2/key-value-stores/...`
downloads with the bearer token locked strictly to that origin and path prefix.
Each defaults to `off`. Use `read` after approving the mirror for post lookup and model processing.
Use `read_and_group` after also approving autofetch delivery in opted-in groups and DMs. Set `social.mirrors.redditGroupChatIds`
to limit Reddit attachments to listed internal chat IDs in the deployment config. An omitted list keeps the
instance-wide scope. An empty list admits no Reddit group fetches. The site capability list reports whether
the server offers Reddit group media in any group. TikWM receives the resolved canonical video URL and Arctic Shift receives the native
Reddit post ID. Neither receives the member’s original share token or chat data.

The reader requires a matching post identity and a supported first-party or mirror media origin. For a
fetched attachment, video needs verified post ownership. If the source supplies no duration, probe the
bounded MP4 before delivery. When `features.autofetch` is on for a chat (group or DM), mirror
`read_and_group` grants apply equally to both groups and DMs. A single native Reddit photo must come
from the image post's own original `i.redd.it` URL, with any destination override agreeing. A preview, a
crosspost, a gallery and an external image link do not qualify under this rule. TikWM uses the
watermarked rendition and can take up to 10,000 ms for lookup by default, within the shared lookup deadline.
Arctic Shift is an archive. Its Reddit fallback MP4 may be video-only. The Reddit reader checks the first-party feed
before the mirror and stops further attempts on Reddit's own refusal or rate limit; the archive's 403 or 429
does not. A feed that gives only an image post's thumbnail still lets the mirror supply the original photo. The normal watch and group byte,
duration and timeout limits apply, including linked MP4 compression. Mirror lookup endpoints disallow redirects,
and asset downloads keep redirects on the original origin. Other social media downloads may redirect to a
CDN on another origin, carry no cookies, and send forwarded headers only to the first origin. The watch path downloads a verified TikWM watermarked
MP4 from a TikTok CDN host (`*.tiktokcdn-us.com` or `*.tiktokcdn.com`, which rotate) in four parallel byte ranges when its declared size is at least 8 MB and within
the intake download cap; group autofetch uses the same ranges for a verified TikWM video, and every verified
mirror video gets 25 s to download. Each response must be a matching MP4 range of the declared total. Reassembly must
produce the complete file before watch or compression. A part whose body sends nothing for 4 s, drops or ends early
resumes from its last byte, up to twice. A resume sends the part's strong, quoted, non-empty ETag as `If-Range`;
without one, including when only Last-Modified is sent, the part starts over. A refusal that arrives after the idle
timer fired still stops the batch. An invalid, refused or redirected part stops the batch at once. The watch
deadline includes the lookup, downloads, compression, and model call. A failed mirror lookup grants no group attachment.
Facebook photo paths use the HTML post reader before falling back to the extractor. Supported platforms are X, Bluesky, Threads, YouTube, TikTok, Reddit, Instagram, Bilibili,
Facebook, Lemon8, Rednote, Douyin and LinkedIn. Bluesky and Threads fetch both photos and video.
`social.ytDlpTimeoutMs` defaults to 9,000 ms so Bilibili extractions complete on slower networks.

### Reply Readers

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

### Post Result And Failure Mapping

The model receives an untrusted result with a readable or partial status, a platform display name and a post.
A partial result gives its missing fields and a fixed sentence describing what was visible. A failed read uses
the ordinary tool failure outcome. Reader names, attempts, reasons and timings stay in records.
The post keeps `author`, `text` and `media` URLs, and adds `platform`, `handle`,
`createdAt`, `quotedText`, `replyCount`, `canonicalUrl`, `durationSec`, `thread`
and `replies`. `media` lists every photo the post keeps, else its one picture,
then its video. `thread` lists the earlier posts of a Threads thread, oldest
first, each with `author`, `text` and `media`. One reply lookup runs in parallel with the post lookup. It returns
up to five top replies by default, capped at 280 characters each; reply failure
leaves an empty list and never fails a readable post. All returned content is
untrusted external data; the social port marks its result with `untrusted: true`.

Post `timeout` maps to tool `timeout`, `binary_missing` to `unavailable`, and
HTTP failures, `no_post_data`, `missing_post` and other lookup failures to
`error`. Failure logs contain platform and reason. A shape match on an unknown host records its hostname without path or query. No cookies are used. X post
identifiers are sent to the third-party FxTwitter service. YouTube replies
require the optional `YOUTUBE_API_KEY`; other YouTube metadata remains usable
without it. Missing yt-dlp disables only extractor-dependent reads; Reddit
text and image feeds remain readable.

## Autofetch

### Selection And Eligibility

Only an official YouTube `/shorts/{id}` link may request a YouTube attachment. Before downloading,
require a successful first-party Shorts page with the matching canonical Shorts URL. Reject redirects to
ordinary watch pages. The extractor must confirm the same ID, a non-live video and a positive duration
within 180 seconds. Download a bounded MP4 with video and audio. Standard, live, embed and short-host
watch links stay outside autofetch regardless of duration. A zero-offset Short whose URL watcher returned
no usable segment may use the verified MP4 for a byte-based watch within the remaining turn deadline. Select only typed native
attachments owned by the resolved post, video first and photos in post order. The source response must
prove both identity and type. Keep verified photos when a video is ineligible. Reject live streams and playlists. For a bounded video, use the native attachment's duration when
known. Skip it before downloading if it exceeds 300 seconds. Otherwise, when the duration is missing,
download within the input cap and probe the MP4 with ffprobe before compression or delivery.
Duration probes share a bounded worker limit and respect caller cancellation and the local processing deadline. A duration
of exactly 300 seconds qualifies. Record `too_long` for longer videos and `unknown_duration` when the
probe cannot establish a finite positive duration. Preserve the duration band and all eligible sibling photos.
The watching switch governs intake independently.

### Opt-In And Hand-Off

An active, unmuted group or DM may opt into `features.autofetch`. It defaults off. In groups, the existing
mention-gate drop path offers a link to the core. In DMs, the gateway offers an authorized, accepted inbound message once
and continues its normal reply path. The same gateway delivery path sends the attachments in a separate batch
for that message. The normal reply does not send the fetched files again. Fetching never invokes the model.

### Delivery Steps

| Step | Who               | What                                                                                                                                                                                                                                 |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `brain.autofetch` | Skips the bot's own message, a chat without `autofetch: true` in `chats.json`, and text with no `http` link. Otherwise it posts `{ "chat": "<whatsapp chat id>", "text": "<message text>" }` to the core, one job per chat at a time |
| 2    | The core          | Answers only an active group or DM with `features.autofetch` on that is not muted. It takes up to 3 supported post links from the text, skipping excluded platforms and repeated targets in the ten-minute selection window          |
| 3    | The core          | Reads each post through the [social reader](#social-post-and-reply-readers) and takes its own media: its video, then its photos, at most 10 files a post. Never its one picture: a thumbnail, link card or avatar                    |
| 4    | The core          | Writes each file under a unique, delivery-specific name in `cache/autofetch/` and returns ordered `media` and a `deliveryKey` when files are ready                                                                                   |
| 5    | `brain.autofetch` | Claims the batch once through core, then calls `send_video` or `send_image_file` for each slot and reports adapter outcomes                                                                                                          |

### Autofetch Rules

- **Limits.** Three links per message and ten files per post. Images up to 8 MB and MP4 up to 16 MB
  require matching media signatures. Asset downloads send no cookies. Origin-bound requests keep redirects on the asset origin.
  Douyin play URLs use the cookieless media downloader for cross-origin CDN redirects.
  Each file has up to 25 s to download within the 60 s core job deadline (including before compression), and
  a large TikWM MP4 comes in byte ranges. The gateway waits up to 90 s for the core.
- **Repeats.** Core reserves a keyed digest of the chat and target for ten minutes, including failed reads.
  Resolved aliases must also win the canonical target reservation. Reservations survive restart.
- **Records.** A recognized target can create a `job_run` even when selection skips it. Outcomes include
  `ready`, `nothing`, `failed` and `interrupted`. A returned batch has an ordered slot list and a
  short-lived opaque key. The gateway calls `POST /v1/aira/autofetch/claim` with the key and, after adapter
  calls, `POST /v1/aira/autofetch/complete` with the key and an ordered boolean outcome per slot.
  A missing completion leaves delivery unknown. Each file has one slot and one adapter outcome.
  A completed or expired batch cannot be claimed again. Restart invalidates outstanding keys and clears leftovers.
- **Failure is silent.** Nobody asked the bot anything, so a post that cannot be read, a file over its limit or a
  refused download sends nothing to the chat.
- **Mirror delivery.** A mirror's `read_and_group` grant applies equally to opted-in groups and DMs. Direct chats can
  also fetch independently verified native attachments from platforms with direct delivery support. When configured,
  `social.mirrors.redditGroupChatIds` limits Reddit attachment lookup to listed internal chat IDs that also pass the
  active-chat and autofetch gates. An out-of-scope share is recorded as `platform_excluded` without contacting Reddit,
  the mirror or the media host.
- **Lifetime.** Files belong exclusively to one delivery. Accepted completion removes all files, including failed
  slots. At the ten-minute key expiry the core removes outstanding files even while idle. On startup it clears
  leftover delivery files, including the previous hash-named cache. A failed handoff also removes its files.
  Keep bytes out of `files/`, snapshots, archives and off-host copies.
- **Compression.** A verified MP4 over the 16 MB limit gets one attempt using the existing bounded compressor.
  Keep the 48 MB input cap. Skip and record a failure if output exceeds the delivery limit or compression fails.
- **Request shape.** The body is JSON of at most 64 KiB. A bad body gets 400 and a core that is not ready 503. Every
  other answer is 200, with an empty `media` list when nothing is sent.
- **Code lives in** `src/media/autofetch.ts`, `src/gateway/server.ts` and `deploy/gateway/brain/autofetch.py`.

## Deadlines

The turn deadline starts before intake. An attachment or link read receives the smaller of the configured
media timeout and two thirds of the time left in the turn. Lookup, download, compression and watcher attempts
consume that budget. The remaining turn time lets the main model answer with the evidence that arrived.
A host may set different deadlines in its mounted configuration. Autofetch runs as a separate gateway request
with its own job and per-download limits. See [Media Limits](#media-limits) and [Autofetch Rules](#autofetch-rules).

## Configuration

These are shipped defaults. Deployment operators set overrides in the host configuration.
The [model configuration](models.md#configuration) owns the overall turn deadline.

| Key                             | Default                 | Effect                                                             |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `media.watcher.model`           | `gemini-3.5-flash-lite` | The media model, on Google AI Studio. Key: `MEDIA_WATCHER_API_KEY` |
| `media.gatewayDirs`             | empty                   | `host` and `container` pairs of the gateway's media folders        |
| `media.timeoutMs`               | 30000                   | One media read, within two thirds of the time left in the turn     |
| `media.maxVideoSeconds`         | 300                     | Longest video that is watched                                      |
| `media.maxLinkVideoSeconds`     | 600                     | Longest span watched from a YouTube link                           |
| `YOUTUBE_API_KEY` (env)         | unset                   | Without it, YouTube reply lookup fails as `not_configured`         |
| `media.linkWatchMs`             | 22000                   | Total watcher time for YouTube segments after lookup               |
| `media.linkFirstSegmentSeconds` | 60                      | Seconds in the first segment                                       |
| `media.linkSegmentSeconds`      | 180                     | Seconds per later segment                                          |
| `media.maxLinkSegments`         | 4                       | Maximum segments per link                                          |
| `media.linkFps`                 | 0.25                    | Frames per second requested for a linked YouTube video             |

| Key                          | Default  | Effect                                                |
| ---------------------------- | -------- | ----------------------------------------------------- |
| `social.timeoutMs`           | 12000    | Hard deadline per lookup                              |
| `social.httpReaderTimeoutMs` | 2500     | Limit per HTTP reader, clipped to the lookup deadline |
| `social.ytDlpTimeoutMs`      | 9000     | Limit per extractor, clipped to the lookup deadline   |
| `social.cacheTtlMs`          | 900000   | Successful lookup cache lifetime; 0 disables caching  |
| `social.maxCacheEntries`     | 256      | Maximum entries per LRU cache                         |
| `social.maxTextChars`        | 1500     | Post text limit                                       |
| `social.maxReplies`          | 5        | Replies returned, at most 50                          |
| `social.maxReplyChars`       | 280      | Reply text limit, in Unicode code points              |
| `social.ytDlpPath`           | `yt-dlp` | Metadata extractor binary                             |

## Implementation And Tests

| Path                                                                                                           | Contract exercised                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Social URL recognition](../../src/social/urls.ts) and [guarded share resolution](../../src/social/share.ts)   | Official post identities and short-link redirects. [URL contract tests](../../tests/contract/social-url-identity.test.ts).                                                         |
| [Social viewer](../../src/social/viewer.ts) and [pending downloads](../../src/social/shared-download.ts)       | Reader selection, caching and independent cancellation. [Share tests](../../tests/contract/social-share.test.ts) and [concurrency tests](../../tests/unit/social-pending.test.ts). |
| [Turn media](../../src/media/turn-media.ts) and [linked media intake](../../src/media/link-intake.ts)          | Time budgets, watcher inputs and evidence for the reply. [Linked media tests](../../tests/contract/media-link.test.ts).                                                            |
| [Core autofetch](../../src/media/autofetch.ts) and [gateway delivery](../../deploy/gateway/brain/autofetch.py) | Eligibility, attachment ownership, file handoff and delivery receipts. [Autofetch tests](../../tests/contract/autofetch.test.ts).                                                  |
