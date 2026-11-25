# Decision Records

The lasting choices behind AIRA, one record per decision, with why each was made. Check here before reversing one.
Each decision is one short file in this folder.

Contents:

1. [How to Read a Record](#how-to-read-a-record)
1. [Publishing a Decision](#publishing-a-decision)
1. [Architecture](#architecture)
1. [Data](#data)
1. [Site](#site)
1. [Deployment](#deployment)
1. [Search Depth](#search-depth)

## How to Read a Record

Every record is named `NNNN-short-title.md`, where `NNNN` is a four-digit ID. A record holds these parts:

- **Date:** the day the decision was made.
- **Status:** `Accepted`, or a note that a later record supersedes it. A record that replaces another names it in a
  **Supersedes** line, and the replaced record names its replacement in its status.
- **Group:** the heading of the former table the decision came from.
- **Decision:** what was decided.
- **Rationale:** why it was decided.
- **Consequences:** a cost that the source states. Most records have none.
- **Source:** where the record came from.

The records were migrated from the [original decision log][original-log]. The IDs follow the order of the rows in that
table, group by group. The rows were not sorted by date, so a lower ID is not always an earlier decision. The Decision
and Rationale text is the text of the row's Decision and Why cells. Only the titles, IDs, Source lines and the links to
other records were added, and the two links to TRD pages were rebased to this folder.

Five rows of the Deployment group appear twice in the source with identical text. Both copies keep a record (ADR-0163
to ADR-0167 repeat as ADR-0170 to ADR-0174), and each names the other.

Some rows say that they replace or reverse an earlier row. Where that row is in the log, the records link to each
other. Where it is not, the statement stays in the Decision text and no link is made.

## Publishing a Decision

1. If the decision changes a contract, change the owning module in `docs/trd/` first, and `docs/TRD.md` if a rule or
   decision there changes.
1. Take the next ID: the highest `NNNN` in this folder plus one. Never reuse or renumber an ID.
1. Create `NNNN-short-title.md` in this folder. The short title is the record title in lower case, with hyphens.
1. Write the record in the layout below. The title is Title Case and names the decision, not the topic.
1. If it replaces an earlier decision, add a **Supersedes** line to the new record. In the same pull request, change
   the status of the old record to `Superseded by [ADR-NNNN](NNNN-short-title.md)`. Leave the old record's other
   text as it is.
1. Add a row to the table of the right group below, in ID order, with its reference link. For a new group, add a
   heading here and a heading with a link to it in `docs/DECISIONS.md`.
1. Cite measurements, issues and TRD pages in the Rationale. Link TRD pages with a path such as
   `../trd/system.md#autofetch`.

```markdown
# ADR-NNNN: Title of the Decision

- **Date:** YYYY-MM-DD
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-NNNN](NNNN-short-title.md)

## Decision

What was decided, in one or two sentences.

## Rationale

Why it was decided, with the evidence.

## Consequences

Only a cost or effect the source states. Leave the section out if there is none.

## Source

Where the record came from.
```

## Architecture

Process boundaries, the gateway contract, turns, tools, commands, models, reply formatting, media and social readers. 124 records, in ID order.

| ID       | Date       | Decision                                                                                | Status                                                        |
| -------- | ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ADR-0001 | 2026-11-15 | [Build the Core as a TypeScript Service on Node 24][ADR-0001]                           | Accepted                                                      |
| ADR-0002 | 2026-11-15 | [Keep Hermes Agent as the Pinned WhatsApp Transport][ADR-0002]                          | Accepted                                                      |
| ADR-0003 | 2026-11-15 | [Attach the Core Through an OpenAI-Compatible Endpoint on Port 9881][ADR-0003]          | Accepted                                                      |
| ADR-0004 | 2026-11-15 | [Empty the Hermes Fallback Provider List][ADR-0004]                                     | Accepted                                                      |
| ADR-0005 | 2026-11-15 | [Use One Turn Runner Interface With Two Implementations][ADR-0005]                      | Accepted                                                      |
| ADR-0006 | 2026-11-15 | [Use Google's Agent Development Kit in the API Runner][ADR-0006]                        | Accepted                                                      |
| ADR-0007 | 2026-11-16 | [Make Every Tool Atomic][ADR-0007]                                                      | Accepted                                                      |
| ADR-0008 | 2026-11-16 | [Fill Text Command Arguments From Free Text][ADR-0008]                                  | Accepted                                                      |
| ADR-0009 | 2026-11-16 | [End a Tool Chain at 4 Calls or 15 Seconds][ADR-0009]                                   | Superseded by [ADR-0066]                                      |
| ADR-0010 | 2026-11-16 | [Read Chat Identity From the Gateway Scope Marker][ADR-0010]                            | Accepted                                                      |
| ADR-0011 | 2026-11-16 | [Let the Core Decide Reply Bubbles With Break Lines][ADR-0011]                          | Accepted                                                      |
| ADR-0012 | 2026-11-16 | [Send a Sticker as a `MEDIA:` Line][ADR-0012]                                           | Accepted                                                      |
| ADR-0013 | 2026-11-16 | [Send No Late Reply From the Core][ADR-0013]                                            | Accepted                                                      |
| ADR-0014 | 2026-11-16 | [Split the 68 Gateway Patches Into Keep, Dead and Removed][ADR-0014]                    | Accepted                                                      |
| ADR-0015 | 2026-11-16 | [Store Each User Message in the Window on Arrival][ADR-0015]                            | Accepted                                                      |
| ADR-0016 | 2026-11-16 | [Return One Reply for a Merged Turn][ADR-0016]                                          | Accepted                                                      |
| ADR-0017 | 2026-11-16 | [Refuse Requests With Disagreeing Scope Markers][ADR-0017]                              | Accepted                                                      |
| ADR-0018 | 2026-11-16 | [Return `NO_REPLY` for a Turn With Nothing to Send][ADR-0018]                           | Accepted                                                      |
| ADR-0019 | 2026-11-16 | [Identify a Scheduled Turn by the Core's Tag and Job Row][ADR-0019]                     | Accepted                                                      |
| ADR-0020 | 2026-11-16 | [Treat a Request With No Tools as an Auxiliary Chore][ADR-0020]                         | Accepted                                                      |
| ADR-0021 | 2026-11-16 | [Answer an Unmarked Tool Request With `NO_REPLY` and a Record][ADR-0021]                | Accepted                                                      |
| ADR-0022 | 2026-11-16 | [Take Quote and Media Notes Out of the Message Text][ADR-0022]                          | Accepted                                                      |
| ADR-0023 | 2026-11-16 | [Split Bubbles Only at Break Lines in `brain.bubbles`][ADR-0023]                        | Accepted                                                      |
| ADR-0024 | 2026-11-16 | [Find the Data Volume Through `AIRA_HOST_DATA_DIR`][ADR-0024]                           | Accepted                                                      |
| ADR-0025 | 2026-11-16 | [Keep AIRA's Gateway Patches in `deploy/gateway/patches.py`][ADR-0025]                  | Accepted                                                      |
| ADR-0026 | 2026-11-16 | [Remove the Reply-Prefix Test Edit and Defer `aira-trace` Removal to Cutover][ADR-0026] | Accepted                                                      |
| ADR-0027 | 2026-11-16 | [Store a Quoted Message Beside the Message That Quotes It][ADR-0027]                    | Accepted                                                      |
| ADR-0028 | 2026-11-16 | [Declare Reminders in `gateway/schedule.json` for a Host Reconciler][ADR-0028]          | Accepted                                                      |
| ADR-0029 | 2026-11-16 | [Run Gateway Jobs as One-Time Jobs][ADR-0029]                                           | Accepted                                                      |
| ADR-0030 | 2026-11-16 | [Honour a Scheduled Tag Only in an Unmarked Request][ADR-0030]                          | Accepted                                                      |
| ADR-0031 | 2026-11-16 | [Reach Claude Through the Native Messages API][ADR-0031]                                | Accepted                                                      |
| ADR-0032 | 2026-11-16 | [Run Both Transports at the Main Model and Effort][ADR-0032]                            | Accepted                                                      |
| ADR-0033 | 2026-11-16 | [Choose the Launch Models for Main and Fallback][ADR-0033]                              | Accepted                                                      |
| ADR-0034 | 2026-11-16 | [Keep Provider Turn State for the Turn Only][ADR-0034]                                  | Accepted                                                      |
| ADR-0035 | 2026-11-16 | [Ask for Deeper Thinking With `/think`][ADR-0035]                                       | Accepted                                                      |
| ADR-0036 | 2026-11-17 | [Run the Owner's Gateway Jobs as Routine Turns][ADR-0036]                               | Accepted                                                      |
| ADR-0037 | 2026-11-17 | [Use Exa for Web Search][ADR-0037]                                                      | Accepted                                                      |
| ADR-0038 | 2026-11-16 | [Offer Only the Named Tool for a Skill-Style Command][ADR-0038]                         | Accepted                                                      |
| ADR-0039 | 2026-11-16 | [Write Direct Command Answers in Plain Words][ADR-0039]                                 | Accepted                                                      |
| ADR-0040 | 2026-11-16 | [Show the Model the Candidate Rows Before Cancel and Forget][ADR-0040]                  | Accepted                                                      |
| ADR-0041 | 2026-11-17 | [Read Media Only Through Read-Only Gateway Mounts][ADR-0041]                            | Accepted                                                      |
| ADR-0042 | 2026-11-17 | [Lift Research Answers to the Long Length Limit][ADR-0042]                              | Accepted                                                      |
| ADR-0043 | 2026-11-17 | [Capitalise the First Letter of Each Bubble][ADR-0043]                                  | Accepted, partly superseded by [ADR-0185]                     |
| ADR-0044 | 2026-11-17 | [Never Merge a Slash Command With Other Messages][ADR-0044]                             | Accepted                                                      |
| ADR-0045 | 2026-11-17 | [Give the Model Local Time With Zone and Offset][ADR-0045]                              | Accepted                                                      |
| ADR-0046 | 2026-11-17 | [Keep the Character in Role When Asked What It Is][ADR-0046]                            | Accepted                                                      |
| ADR-0047 | 2026-11-17 | [Draw Openers and Endings at Set Odds][ADR-0047]                                        | Accepted                                                      |
| ADR-0048 | 2026-11-17 | [Write the Tool Footer in Superscript With Source Domains][ADR-0048]                    | Superseded by [ADR-0051]                                      |
| ADR-0049 | 2026-11-21 | [Mark Used Sources and List Them in the Footer][ADR-0049]                               | Accepted                                                      |
| ADR-0050 | 2026-11-21 | [Offer Short Source Links From a Cloudflare Worker][ADR-0050]                           | Accepted                                                      |
| ADR-0051 | 2026-11-17 | [Make Both Footer Lines Italic][ADR-0051]                                               | Accepted                                                      |
| ADR-0052 | 2026-11-17 | [Send One Text Message and at Most One Sticker per Reply][ADR-0052]                     | Accepted                                                      |
| ADR-0053 | 2026-11-17 | [Draw Faces From Face Groups With Guarded Characters][ADR-0053]                         | Accepted                                                      |
| ADR-0054 | 2026-11-17 | [Take the Sender Display Name From the Group Message Prefix][ADR-0054]                  | Accepted                                                      |
| ADR-0055 | 2026-11-17 | [Answer Name-Only Group Messages When Name Call Is On][ADR-0055]                        | Accepted                                                      |
| ADR-0056 | 2026-11-17 | [Port the Owner's Market and Coding-Session Tools Into the Core][ADR-0056]              | Accepted                                                      |
| ADR-0057 | 2026-11-17 | [Cut Over Without the Shadow Period and Staging Rehearsal][ADR-0057]                    | Accepted                                                      |
| ADR-0058 | 2026-11-17 | [Count a Reply to the Bot as Addressed With `reply-to-bot-ids`][ADR-0058]               | Accepted                                                      |
| ADR-0059 | 2026-11-17 | [Declare Voice and Reaction Settings in `gateway/chats.json`][ADR-0059]                 | Accepted                                                      |
| ADR-0060 | 2026-11-17 | [Read Pages Through Exa Contents With a Plain Fetch Fallback][ADR-0060]                 | Accepted                                                      |
| ADR-0061 | 2026-11-17 | [Open YouTube and Social Post Links at Intake][ADR-0061]                                | Accepted                                                      |
| ADR-0062 | 2026-11-17 | [Set Name-Call Names per Chat][ADR-0062]                                                | Accepted                                                      |
| ADR-0063 | 2026-11-17 | [Make `/research` an Explicit Background Job][ADR-0063]                                 | Accepted                                                      |
| ADR-0064 | 2026-11-17 | [Render the Research PDF From a Validated Findings Object With Typst][ADR-0064]         | Accepted                                                      |
| ADR-0065 | 2026-11-17 | [Append and Read the PDF Offer in Code][ADR-0065]                                       | Accepted                                                      |
| ADR-0066 | 2026-11-17 | [Set the Tool-Call Limit per Chat Under a Deployment Ceiling][ADR-0066]                 | Accepted                                                      |
| ADR-0067 | 2026-11-17 | [Replace `make_report` With `/doc`][ADR-0067]                                           | Accepted                                                      |
| ADR-0068 | 2026-11-17 | [Switch Memory per Chat][ADR-0068]                                                      | Accepted                                                      |
| ADR-0069 | 2026-11-17 | [Make Live Context Settings per Chat][ADR-0069]                                         | Accepted                                                      |
| ADR-0070 | 2026-11-17 | [Label Replayed Replies That Code Wrote][ADR-0070]                                      | Accepted                                                      |
| ADR-0071 | 2026-11-17 | [Let the Gateway Alone Decide Which Group Messages Are Addressed][ADR-0071]             | Accepted                                                      |
| ADR-0072 | 2026-11-17 | [Wake on a Name Only Through Per-Chat Names][ADR-0072]                                  | Accepted                                                      |
| ADR-0073 | 2026-11-17 | [Run the Schedule Reconciler on Rewrite and Tick the Cron Every 10 Seconds][ADR-0073]   | Accepted                                                      |
| ADR-0074 | 2026-11-17 | [Remove the Scope Marker From Tagged Gateway Jobs][ADR-0074]                            | Accepted                                                      |
| ADR-0075 | 2026-11-17 | [Allow Commands Anywhere in a Message][ADR-0075]                                        | Accepted                                                      |
| ADR-0076 | 2026-11-17 | [Add Passive Reactions Through an Adapter Patch][ADR-0076]                              | Accepted                                                      |
| ADR-0077 | 2026-11-17 | [Strip the Gateway Timestamp and Read Image Attachment Lines][ADR-0077]                 | Accepted                                                      |
| ADR-0078 | 2026-11-17 | [Drop Schema Limits for Claude and Enforce Them With zod][ADR-0078]                     | Accepted                                                      |
| ADR-0079 | 2026-11-17 | [Keep the API Transport as the Default][ADR-0079]                                       | Accepted                                                      |
| ADR-0080 | 2026-11-17 | [Name What Intake Read in the Footer][ADR-0080]                                         | Accepted                                                      |
| ADR-0081 | 2026-11-17 | [Watch YouTube Links in Parallel Segments][ADR-0081]                                    | Accepted, partly superseded by [ADR-0189]                     |
| ADR-0082 | 2026-11-17 | [Remove Config Keys That No Code Reads][ADR-0082]                                       | Accepted                                                      |
| ADR-0083 | 2026-11-18 | [Set Deep Effort Levels for `/think`][ADR-0083]                                         | Accepted                                                      |
| ADR-0084 | 2026-11-18 | [Follow One Redirect for Threads Short Links][ADR-0084]                                 | Accepted                                                      |
| ADR-0085 | 2026-11-18 | [Keep Every Photo of a Post][ADR-0085]                                                  | Accepted                                                      |
| ADR-0086 | 2026-11-18 | [Read Instagram Posts From Page Data Before yt-dlp][ADR-0086]                           | Accepted                                                      |
| ADR-0087 | 2026-11-18 | [Read Facebook Video Links Through yt-dlp][ADR-0087]                                    | Accepted, partly superseded by [ADR-0091]                     |
| ADR-0088 | 2026-11-18 | [Move Autofetch Into the Core][ADR-0088]                                                | Superseded by [ADR-0119]                                      |
| ADR-0089 | 2026-11-18 | [Store Autofetch Files in `cache/autofetch/`][ADR-0089]                                 | Superseded by [ADR-0120]                                      |
| ADR-0090 | 2026-11-18 | [Remove `/read` and Keep the Read Tools Model-Only][ADR-0090]                           | Accepted                                                      |
| ADR-0091 | 2026-11-18 | [Read Facebook Post Links From the Logged-Out Page][ADR-0091]                           | Accepted                                                      |
| ADR-0092 | 2026-11-18 | [Make `/report` the Direct Feedback Link Command][ADR-0092]                             | Accepted                                                      |
| ADR-0093 | 2026-11-18 | [Pull Feedback Rows From an Apps Script Web App][ADR-0093]                              | Accepted                                                      |
| ADR-0094 | 2026-11-19 | [Prefix the Newest Message With a Media Note][ADR-0094]                                 | Accepted                                                      |
| ADR-0095 | 2026-11-19 | [Tell the Model to Speak of Media as Its Own Experience][ADR-0095]                      | Accepted                                                      |
| ADR-0096 | 2026-11-21 | [Give the Model a Fixed Outcome Sentence on Tool Failure][ADR-0096]                     | Accepted                                                      |
| ADR-0097 | 2026-11-21 | [Derive a Canonical Target From a Strict Post Shape on Unknown Hosts][ADR-0097]         | Accepted                                                      |
| ADR-0098 | 2026-11-21 | [Resolve Official Share Links Through Two Guarded Redirects][ADR-0098]                  | Accepted                                                      |
| ADR-0099 | 2026-11-21 | [Log Platform and Hostname for Unknown-Host Social Matches][ADR-0099]                   | Accepted                                                      |
| ADR-0100 | 2026-11-21 | [Find Social Links Three Quote Hops Back][ADR-0100]                                     | Accepted                                                      |
| ADR-0101 | 2026-11-21 | [Use Google Lens Through SerpApi for Reverse-Image Hints][ADR-0101]                     | Accepted                                                      |
| ADR-0102 | 2026-11-21 | [Read Only URLs Registered in the Current Turn][ADR-0102]                               | Accepted                                                      |
| ADR-0103 | 2026-11-21 | [Block State-Changing Tools After a Successful Page or Post Read][ADR-0103]             | Accepted                                                      |
| ADR-0104 | 2026-11-21 | [Read Each Platform Through an Ordered Reader Chain][ADR-0104]                          | Accepted                                                      |
| ADR-0105 | 2026-11-21 | [Limit Plain Page Reads to Five Guarded Redirects][ADR-0105]                            | Accepted                                                      |
| ADR-0106 | 2026-11-21 | [Keep Cookies per Host for One Page Lookup][ADR-0106]                                   | Accepted                                                      |
| ADR-0107 | 2026-11-21 | [Reject Access-Block Pages as Failed Reads][ADR-0107]                                   | Accepted                                                      |
| ADR-0108 | 2026-11-21 | [Require Verified Native Attachments for Group Autofetch][ADR-0108]                     | Partially superseded by [ADR-0180]                            |
| ADR-0109 | 2026-11-21 | [Separate Media Handoff From Confirmed Delivery][ADR-0109]                              | Accepted                                                      |
| ADR-0110 | 2026-11-22 | [Raise the TikWM Lookup Timeouts][ADR-0110]                                             | Accepted                                                      |
| ADR-0111 | 2026-11-22 | [Use the First-Party Lemon8 Article Page][ADR-0111]                                     | Accepted                                                      |
| ADR-0112 | 2026-11-22 | [Recognise Verified Douyin Routes at T0][ADR-0112]                                      | Accepted                                                      |
| ADR-0113 | 2026-11-22 | [Recognise Xiaohongshu and Rednote Links at T0][ADR-0113]                               | Accepted, superseded by [ADR-0114] when the mirror is enabled |
| ADR-0114 | 2026-11-22 | [Promote Rednote to an Opt-In Apify Mirror][ADR-0114]                                   | Accepted                                                      |
| ADR-0115 | 2026-11-22 | [Promote Douyin and TikTok to Opt-In Apify Mirrors][ADR-0115]                           | Accepted                                                      |
| ADR-0116 | 2026-11-22 | [Promote LinkedIn to an Opt-In Apify Mirror][ADR-0116]                                  | Accepted                                                      |
| ADR-0117 | 2026-11-22 | [Recognise LinkedIn URLs Locally][ADR-0117]                                             | Accepted                                                      |
| ADR-0118 | 2026-11-22 | [Give Each Platform Separate Read and Fetch Switches][ADR-0118]                         | Accepted                                                      |
| ADR-0119 | 2026-11-22 | [Deliver Autofetch Media in Active DMs and Groups][ADR-0119]                            | Accepted                                                      |
| ADR-0120 | 2026-11-22 | [Give Autofetch Files Per-Delivery Lifetimes][ADR-0120]                                 | Accepted                                                      |
| ADR-0121 | 2026-11-22 | [Extend Native Attachments to Verified Non-YouTube Video][ADR-0121]                     | Accepted                                                      |
| ADR-0122 | 2026-11-22 | [Raise the Shared Short-Video Limit to 300 Seconds][ADR-0122]                           | Accepted                                                      |
| ADR-0180 | 2026-11-23 | [Fetch Only Verified YouTube Shorts][ADR-0180]                                          | Accepted                                                      |
| ADR-0181 | 2026-11-23 | [Recover Malformed Replies Within the Turn Deadline][ADR-0181]                          | Accepted                                                      |
| ADR-0185 | 2026-11-25 | [Let a Pack Switch Off Bubble Capitals][ADR-0185]                                       | Accepted                                                      |
| ADR-0188 | 2026-11-25 | [Use a Fail-Closed Standalone Hermes Adapter][ADR-0188]                                 | Accepted                                                      |
| ADR-0189 | 2026-11-26 | [Recover YouTube Watch Gaps][ADR-0189]                                                  | Accepted                                                      |

[ADR-0185]: 0185-let-a-pack-switch-off-bubble-capitals.md
[ADR-0188]: 0188-use-a-fail-closed-standalone-hermes-adapter.md
[ADR-0189]: 0189-recover-youtube-watch-gaps.md
[ADR-0181]: 0181-recover-malformed-api-replies.md
[ADR-0180]: 0180-fetch-only-verified-youtube-shorts.md
[ADR-0001]: 0001-build-the-core-as-a-typescript-service-on-node-24.md
[ADR-0002]: 0002-keep-hermes-agent-as-the-pinned-whatsapp-transport.md
[ADR-0003]: 0003-attach-the-core-through-an-openai-compatible-endpoint-on.md
[ADR-0004]: 0004-empty-the-hermes-fallback-provider-list.md
[ADR-0005]: 0005-use-one-turn-runner-interface-with-two-implementations.md
[ADR-0006]: 0006-use-google-s-agent-development-kit-in-the-api-runner.md
[ADR-0007]: 0007-make-every-tool-atomic.md
[ADR-0008]: 0008-fill-text-command-arguments-from-free-text.md
[ADR-0009]: 0009-end-a-tool-chain-at-4-calls-or-15-seconds.md
[ADR-0010]: 0010-read-chat-identity-from-the-gateway-scope-marker.md
[ADR-0011]: 0011-let-the-core-decide-reply-bubbles-with-break-lines.md
[ADR-0012]: 0012-send-a-sticker-as-a-media-line.md
[ADR-0013]: 0013-send-no-late-reply-from-the-core.md
[ADR-0014]: 0014-split-the-68-gateway-patches-into-keep-dead-and-removed.md
[ADR-0015]: 0015-store-each-user-message-in-the-window-on-arrival.md
[ADR-0016]: 0016-return-one-reply-for-a-merged-turn.md
[ADR-0017]: 0017-refuse-requests-with-disagreeing-scope-markers.md
[ADR-0018]: 0018-return-no-reply-for-a-turn-with-nothing-to-send.md
[ADR-0019]: 0019-identify-a-scheduled-turn-by-the-core-s-tag-and-job-row.md
[ADR-0020]: 0020-treat-a-request-with-no-tools-as-an-auxiliary-chore.md
[ADR-0021]: 0021-answer-an-unmarked-tool-request-with-no-reply-and-a-record.md
[ADR-0022]: 0022-take-quote-and-media-notes-out-of-the-message-text.md
[ADR-0023]: 0023-split-bubbles-only-at-break-lines-in-brain-bubbles.md
[ADR-0024]: 0024-find-the-data-volume-through-aira-host-data-dir.md
[ADR-0025]: 0025-keep-aira-s-gateway-patches-in-deploy-gateway-patches-py.md
[ADR-0026]: 0026-remove-the-reply-prefix-test-edit-and-defer-aira-trace.md
[ADR-0027]: 0027-store-a-quoted-message-beside-the-message-that-quotes-it.md
[ADR-0028]: 0028-declare-reminders-in-gateway-schedule-json-for-a-host.md
[ADR-0029]: 0029-run-gateway-jobs-as-one-time-jobs.md
[ADR-0030]: 0030-honour-a-scheduled-tag-only-in-an-unmarked-request.md
[ADR-0031]: 0031-reach-claude-through-the-native-messages-api.md
[ADR-0032]: 0032-run-both-transports-at-the-main-model-and-effort.md
[ADR-0033]: 0033-choose-the-launch-models-for-main-and-fallback.md
[ADR-0034]: 0034-keep-provider-turn-state-for-the-turn-only.md
[ADR-0035]: 0035-ask-for-deeper-thinking-with-think.md
[ADR-0036]: 0036-run-the-owner-s-gateway-jobs-as-routine-turns.md
[ADR-0037]: 0037-use-exa-for-web-search.md
[ADR-0038]: 0038-offer-only-the-named-tool-for-a-skill-style-command.md
[ADR-0039]: 0039-write-direct-command-answers-in-plain-words.md
[ADR-0040]: 0040-show-the-model-the-candidate-rows-before-cancel-and-forget.md
[ADR-0041]: 0041-read-media-only-through-read-only-gateway-mounts.md
[ADR-0042]: 0042-lift-research-answers-to-the-long-length-limit.md
[ADR-0043]: 0043-capitalise-the-first-letter-of-each-bubble.md
[ADR-0044]: 0044-never-merge-a-slash-command-with-other-messages.md
[ADR-0045]: 0045-give-the-model-local-time-with-zone-and-offset.md
[ADR-0046]: 0046-keep-the-character-in-role-when-asked-what-it-is.md
[ADR-0047]: 0047-draw-openers-and-endings-at-set-odds.md
[ADR-0048]: 0048-write-the-tool-footer-in-superscript-with-source-domains.md
[ADR-0049]: 0049-mark-used-sources-and-list-them-in-the-footer.md
[ADR-0050]: 0050-offer-short-source-links-from-a-cloudflare-worker.md
[ADR-0051]: 0051-make-both-footer-lines-italic.md
[ADR-0052]: 0052-send-one-text-message-and-at-most-one-sticker-per-reply.md
[ADR-0053]: 0053-draw-faces-from-face-groups-with-guarded-characters.md
[ADR-0054]: 0054-take-the-sender-display-name-from-the-group-message-prefix.md
[ADR-0055]: 0055-answer-name-only-group-messages-when-name-call-is-on.md
[ADR-0056]: 0056-port-the-owner-s-market-and-coding-session-tools-into-the.md
[ADR-0057]: 0057-cut-over-without-the-shadow-period-and-staging-rehearsal.md
[ADR-0058]: 0058-count-a-reply-to-the-bot-as-addressed-with-reply-to-bot-ids.md
[ADR-0059]: 0059-declare-voice-and-reaction-settings-in-gateway-chats-json.md
[ADR-0060]: 0060-read-pages-through-exa-contents-with-a-plain-fetch-fallback.md
[ADR-0061]: 0061-open-youtube-and-social-post-links-at-intake.md
[ADR-0062]: 0062-set-name-call-names-per-chat.md
[ADR-0063]: 0063-make-research-an-explicit-background-job.md
[ADR-0064]: 0064-render-the-research-pdf-from-a-validated-findings-object.md
[ADR-0065]: 0065-append-and-read-the-pdf-offer-in-code.md
[ADR-0066]: 0066-set-the-tool-call-limit-per-chat-under-a-deployment-ceiling.md
[ADR-0067]: 0067-replace-make-report-with-doc.md
[ADR-0068]: 0068-switch-memory-per-chat.md
[ADR-0069]: 0069-make-live-context-settings-per-chat.md
[ADR-0070]: 0070-label-replayed-replies-that-code-wrote.md
[ADR-0071]: 0071-let-the-gateway-alone-decide-which-group-messages-are.md
[ADR-0072]: 0072-wake-on-a-name-only-through-per-chat-names.md
[ADR-0073]: 0073-run-the-schedule-reconciler-on-rewrite-and-tick-the-cron.md
[ADR-0074]: 0074-remove-the-scope-marker-from-tagged-gateway-jobs.md
[ADR-0075]: 0075-allow-commands-anywhere-in-a-message.md
[ADR-0076]: 0076-add-passive-reactions-through-an-adapter-patch.md
[ADR-0077]: 0077-strip-the-gateway-timestamp-and-read-image-attachment-lines.md
[ADR-0078]: 0078-drop-schema-limits-for-claude-and-enforce-them-with-zod.md
[ADR-0079]: 0079-keep-the-api-transport-as-the-default.md
[ADR-0080]: 0080-name-what-intake-read-in-the-footer.md
[ADR-0081]: 0081-watch-youtube-links-in-parallel-segments.md
[ADR-0082]: 0082-remove-config-keys-that-no-code-reads.md
[ADR-0083]: 0083-set-deep-effort-levels-for-think.md
[ADR-0084]: 0084-follow-one-redirect-for-threads-short-links.md
[ADR-0085]: 0085-keep-every-photo-of-a-post.md
[ADR-0086]: 0086-read-instagram-posts-from-page-data-before-yt-dlp.md
[ADR-0087]: 0087-read-facebook-video-links-through-yt-dlp.md
[ADR-0088]: 0088-move-autofetch-into-the-core.md
[ADR-0089]: 0089-store-autofetch-files-in-cache-autofetch.md
[ADR-0090]: 0090-remove-read-and-keep-the-read-tools-model-only.md
[ADR-0091]: 0091-read-facebook-post-links-from-the-logged-out-page.md
[ADR-0092]: 0092-make-report-the-direct-feedback-link-command.md
[ADR-0093]: 0093-pull-feedback-rows-from-an-apps-script-web-app.md
[ADR-0094]: 0094-prefix-the-newest-message-with-a-media-note.md
[ADR-0095]: 0095-tell-the-model-to-speak-of-media-as-its-own-experience.md
[ADR-0096]: 0096-give-the-model-a-fixed-outcome-sentence-on-tool-failure.md
[ADR-0097]: 0097-derive-a-canonical-target-from-a-strict-post-shape-on.md
[ADR-0098]: 0098-resolve-official-share-links-through-two-guarded-redirects.md
[ADR-0099]: 0099-log-platform-and-hostname-for-unknown-host-social-matches.md
[ADR-0100]: 0100-find-social-links-three-quote-hops-back.md
[ADR-0101]: 0101-use-google-lens-through-serpapi-for-reverse-image-hints.md
[ADR-0102]: 0102-read-only-urls-registered-in-the-current-turn.md
[ADR-0103]: 0103-block-state-changing-tools-after-a-successful-page-or-post.md
[ADR-0104]: 0104-read-each-platform-through-an-ordered-reader-chain.md
[ADR-0105]: 0105-limit-plain-page-reads-to-five-guarded-redirects.md
[ADR-0106]: 0106-keep-cookies-per-host-for-one-page-lookup.md
[ADR-0107]: 0107-reject-access-block-pages-as-failed-reads.md
[ADR-0108]: 0108-require-verified-native-attachments-for-group-autofetch.md
[ADR-0109]: 0109-separate-media-handoff-from-confirmed-delivery.md
[ADR-0110]: 0110-raise-the-tikwm-lookup-timeouts.md
[ADR-0111]: 0111-use-the-first-party-lemon8-article-page.md
[ADR-0112]: 0112-recognise-verified-douyin-routes-at-t0.md
[ADR-0113]: 0113-recognise-xiaohongshu-and-rednote-links-at-t0.md
[ADR-0114]: 0114-promote-rednote-to-an-opt-in-apify-mirror.md
[ADR-0115]: 0115-promote-douyin-and-tiktok-to-opt-in-apify-mirrors.md
[ADR-0116]: 0116-promote-linkedin-to-an-opt-in-apify-mirror.md
[ADR-0117]: 0117-recognise-linkedin-urls-locally.md
[ADR-0118]: 0118-give-each-platform-separate-read-and-fetch-switches.md
[ADR-0119]: 0119-deliver-autofetch-media-in-active-dms-and-groups.md
[ADR-0120]: 0120-give-autofetch-files-per-delivery-lifetimes.md
[ADR-0121]: 0121-extend-native-attachments-to-verified-non-youtube-video.md
[ADR-0122]: 0122-raise-the-shared-short-video-limit-to-300-seconds.md

## Data

The SQLite store, memory and forgetting, the lessons library, backups and the shape of stored records. 34 records, in ID order.

| ID       | Date       | Decision                                                                 | Status   |
| -------- | ---------- | ------------------------------------------------------------------------ | -------- |
| ADR-0123 | 2026-11-15 | [Keep One SQLite File as the Canonical Store][ADR-0123]                  | Accepted |
| ADR-0124 | 2026-11-15 | [Use a Character Pack as the Only Source of Persona Text][ADR-0124]      | Accepted |
| ADR-0125 | 2026-11-15 | [Split Settings Across the Database, `config.yml` and `.env`][ADR-0125]  | Accepted |
| ADR-0126 | 2026-11-16 | [Keep SQLite as the System of Record and DuckDB for Analysis][ADR-0126]  | Accepted |
| ADR-0127 | 2026-11-16 | [Store Every Unit of Work in Flight as a Database Row][ADR-0127]         | Accepted |
| ADR-0128 | 2026-11-16 | [Keep a Verified Encrypted Off-Host Copy][ADR-0128]                      | Accepted |
| ADR-0129 | 2026-11-16 | [Roll Back a Failed Deploy Without Restoring Data][ADR-0129]             | Accepted |
| ADR-0130 | 2026-11-16 | [Key `inbound_message` by Chat and Message ID][ADR-0130]                 | Accepted |
| ADR-0131 | 2026-11-16 | [Store a Turn's Reply Once in `session_message`][ADR-0131]               | Accepted |
| ADR-0132 | 2026-11-16 | [Track Data Volume Files in a `file` Table][ADR-0132]                    | Accepted |
| ADR-0133 | 2026-11-16 | [Start a Release on a Schema With Unknown Migrations][ADR-0133]          | Accepted |
| ADR-0134 | 2026-11-16 | [Return Every Job Lease to the Queue at Start-Up][ADR-0134]              | Accepted |
| ADR-0135 | 2026-11-16 | [Keep a Snapshot as One Journaled File][ADR-0135]                        | Accepted |
| ADR-0136 | 2026-11-16 | [Use Internal Chat and Subject IDs in Every Table][ADR-0136]             | Accepted |
| ADR-0137 | 2026-11-16 | [Store a First-Seen Chat as Pending][ADR-0137]                           | Accepted |
| ADR-0138 | 2026-11-16 | [Change State Only Through One `commit` Call][ADR-0138]                  | Accepted |
| ADR-0139 | 2026-11-16 | [Commit a Reminder Row Before the Schedule Call][ADR-0139]               | Accepted |
| ADR-0140 | 2026-11-16 | [Carry Token Prices in `config.yml`][ADR-0140]                           | Accepted |
| ADR-0141 | 2026-11-16 | [Make Forget a Barrier for Pending Memory Work][ADR-0141]                | Accepted |
| ADR-0142 | 2026-11-16 | [Remove a Fact Only When Named by ID][ADR-0142]                          | Accepted |
| ADR-0143 | 2026-11-16 | [Clear Every Trace When Forgetting a Fact][ADR-0143]                     | Accepted |
| ADR-0144 | 2026-11-16 | [Require an Extracted Fact to Quote Its Subject's Own Message][ADR-0144] | Accepted |
| ADR-0145 | 2026-11-16 | [Run the Database With `secure_delete` On][ADR-0145]                     | Accepted |
| ADR-0146 | 2026-11-16 | [Make Forget Move the Memory Cursor and End Queued Jobs][ADR-0146]       | Accepted |
| ADR-0147 | 2026-11-16 | [Remove Only on a Forget That Names a Fact by ID][ADR-0147]              | Accepted |
| ADR-0148 | 2026-11-16 | [Import Only Fact Files and Confirmed Words Into Memory][ADR-0148]       | Accepted |
| ADR-0149 | 2026-11-16 | [Set the Judge Model Through `judge.model`][ADR-0149]                    | Accepted |
| ADR-0150 | 2026-11-16 | [Share One Lessons Library Across Chats][ADR-0150]                       | Accepted |
| ADR-0151 | 2026-11-16 | [Keep Meanings per Language][ADR-0151]                                   | Accepted |
| ADR-0152 | 2026-11-16 | [Change Migration 0006 in Place][ADR-0152]                               | Accepted |
| ADR-0153 | 2026-11-16 | [Use `jev-latest` as the Judge Model][ADR-0153]                          | Accepted |
| ADR-0154 | 2026-11-17 | [Import the Old Library's Markdown Folder by Script][ADR-0154]           | Accepted |
| ADR-0155 | 2026-11-17 | [Use a restic Repository as the Off-Host Copy][ADR-0155]                 | Accepted |
| ADR-0156 | 2026-11-18 | [Expire Feedback Answers After 90 Days][ADR-0156]                        | Accepted |

[ADR-0123]: 0123-keep-one-sqlite-file-as-the-canonical-store.md
[ADR-0124]: 0124-use-a-character-pack-as-the-only-source-of-persona-text.md
[ADR-0125]: 0125-split-settings-across-the-database-config-yml-and-env.md
[ADR-0126]: 0126-keep-sqlite-as-the-system-of-record-and-duckdb-for-analysis.md
[ADR-0127]: 0127-store-every-unit-of-work-in-flight-as-a-database-row.md
[ADR-0128]: 0128-keep-a-verified-encrypted-off-host-copy.md
[ADR-0129]: 0129-roll-back-a-failed-deploy-without-restoring-data.md
[ADR-0130]: 0130-key-inbound-message-by-chat-and-message-id.md
[ADR-0131]: 0131-store-a-turn-s-reply-once-in-session-message.md
[ADR-0132]: 0132-track-data-volume-files-in-a-file-table.md
[ADR-0133]: 0133-start-a-release-on-a-schema-with-unknown-migrations.md
[ADR-0134]: 0134-return-every-job-lease-to-the-queue-at-start-up.md
[ADR-0135]: 0135-keep-a-snapshot-as-one-journaled-file.md
[ADR-0136]: 0136-use-internal-chat-and-subject-ids-in-every-table.md
[ADR-0137]: 0137-store-a-first-seen-chat-as-pending.md
[ADR-0138]: 0138-change-state-only-through-one-commit-call.md
[ADR-0139]: 0139-commit-a-reminder-row-before-the-schedule-call.md
[ADR-0140]: 0140-carry-token-prices-in-config-yml.md
[ADR-0141]: 0141-make-forget-a-barrier-for-pending-memory-work.md
[ADR-0142]: 0142-remove-a-fact-only-when-named-by-id.md
[ADR-0143]: 0143-clear-every-trace-when-forgetting-a-fact.md
[ADR-0144]: 0144-require-an-extracted-fact-to-quote-its-subject-s-own-message.md
[ADR-0145]: 0145-run-the-database-with-secure-delete-on.md
[ADR-0146]: 0146-make-forget-move-the-memory-cursor-and-end-queued-jobs.md
[ADR-0147]: 0147-remove-only-on-a-forget-that-names-a-fact-by-id.md
[ADR-0148]: 0148-import-only-fact-files-and-confirmed-words-into-memory.md
[ADR-0149]: 0149-set-the-judge-model-through-judge-model.md
[ADR-0150]: 0150-share-one-lessons-library-across-chats.md
[ADR-0151]: 0151-keep-meanings-per-language.md
[ADR-0152]: 0152-change-migration-0006-in-place.md
[ADR-0153]: 0153-use-jev-latest-as-the-judge-model.md
[ADR-0154]: 0154-import-the-old-library-s-markdown-folder-by-script.md
[ADR-0155]: 0155-use-a-restic-repository-as-the-off-host-copy.md
[ADR-0156]: 0156-expire-feedback-answers-after-90-days.md

## Site

The owner site: its front end, write protection, hosting and footer editing. 10 records, in ID order.

| ID       | Date       | Decision                                                              | Status   |
| -------- | ---------- | --------------------------------------------------------------------- | -------- |
| ADR-0157 | 2026-11-15 | [Keep the React Front End and Design Contract][ADR-0157]              | Accepted |
| ADR-0158 | 2026-11-16 | [Require a Literal Host and Allowed Origin for Site Writes][ADR-0158] | Accepted |
| ADR-0159 | 2026-11-16 | [Serve the Built Site Under `/app/` on the Site API Port][ADR-0159]   | Accepted |
| ADR-0160 | 2026-11-17 | [Edit a Pack's `toolFooter` Through the Site][ADR-0160]               | Accepted |
| ADR-0161 | 2026-11-22 | [Show Up to Three Tool Footer Labels][ADR-0161]                       | Accepted |
| ADR-0162 | 2026-11-23 | [Abolish `SITE_TOKEN`][ADR-0162]                                      | Accepted |
| ADR-0182 | 2026-11-23 | [Enforce Site Binding, Footer, and Cron Guards][ADR-0182]             | Accepted |
| ADR-0183 | 2026-11-23 | [Route Owner Actions Through the Core Site][ADR-0183]                 | Accepted |
| ADR-0184 | 2026-11-24 | [Use typed core commands for the dashboard][ADR-0184]                 | Accepted |
| ADR-0186 | 2026-11-25 | [Select Owner Authority by Installation Mode][ADR-0186]               | Accepted |

[ADR-0157]: 0157-keep-the-react-front-end-and-design-contract.md
[ADR-0158]: 0158-require-a-literal-host-and-allowed-origin-for-site-writes.md
[ADR-0159]: 0159-serve-the-built-site-under-app-on-the-site-api-port.md
[ADR-0160]: 0160-edit-a-pack-s-toolfooter-through-the-site.md
[ADR-0161]: 0161-show-up-to-three-tool-footer-labels.md
[ADR-0162]: 0162-abolish-site-token.md
[ADR-0183]: 0183-route-owner-actions-through-the-core-site.md
[ADR-0184]: 0184-use-typed-dashboard-commands.md
[ADR-0186]: 0186-select-owner-authority-by-installation-mode.md
[ADR-0182]: 0182-enforce-site-binding-footer-and-cron-guards.md

## Deployment

Images, deploys, repository process, records of failures and retention checks. 18 records, in ID order.

| ID       | Date       | Decision                                                               | Status                   |
| -------- | ---------- | ---------------------------------------------------------------------- | ------------------------ |
| ADR-0163 | 2026-11-15 | [Build One Container Image per Tagged Release][ADR-0163]               | Superseded by [ADR-0164] |
| ADR-0164 | 2026-11-17 | [Deploy Every Merge to `main` Through a Self-Hosted Runner][ADR-0164]  | Accepted                 |
| ADR-0165 | 2026-11-16 | [Install as One Folder][ADR-0165]                                      | Accepted                 |
| ADR-0166 | 2026-11-17 | [Assign Every Issue][ADR-0166]                                         | Accepted                 |
| ADR-0167 | 2026-11-17 | [Require the Pull Request Template Header][ADR-0167]                   | Accepted                 |
| ADR-0168 | 2026-11-17 | [Record Failed Model Attempts and Arrival-to-Return Latency][ADR-0168] | Accepted                 |
| ADR-0169 | 2026-11-17 | [Append Operator Alerts to `alerts.jsonl`][ADR-0169]                   | Accepted                 |
| ADR-0170 | 2026-11-15 | [Build One Container Image per Tagged Release][ADR-0170]               | Superseded by [ADR-0171] |
| ADR-0171 | 2026-11-17 | [Deploy Every Merge to `main` Through a Self-Hosted Runner][ADR-0171]  | Accepted                 |
| ADR-0172 | 2026-11-16 | [Install as One Folder][ADR-0172]                                      | Accepted                 |
| ADR-0173 | 2026-11-17 | [Assign Every Issue][ADR-0173]                                         | Accepted                 |
| ADR-0174 | 2026-11-17 | [Require the Pull Request Template Header][ADR-0174]                   | Accepted                 |
| ADR-0175 | 2026-11-17 | [Check Retention at Start-Up and Hourly][ADR-0175]                     | Accepted                 |
| ADR-0176 | 2026-11-18 | [Run Live Checks Before a Release][ADR-0176]                           | Accepted                 |
| ADR-0177 | 2026-11-18 | [Give Production Dependencies Their Own Image Stage][ADR-0177]         | Accepted                 |
| ADR-0178 | 2026-11-18 | [Open Release Pull Requests With a GitHub App Token][ADR-0178]         | Accepted                 |
| ADR-0187 | 2026-11-25 | [Install with a Portable Host CLI][ADR-0187]                           | Accepted                 |
| ADR-0190 | 2026-11-26 | [Promote the Published Release Commit][ADR-0190]                       | Accepted                 |

[ADR-0163]: 0163-build-one-container-image-per-tagged-release.md
[ADR-0164]: 0164-deploy-every-merge-to-main-through-a-self-hosted-runner.md
[ADR-0165]: 0165-install-as-one-folder.md
[ADR-0166]: 0166-assign-every-issue.md
[ADR-0167]: 0167-require-the-pull-request-template-header.md
[ADR-0168]: 0168-record-failed-model-attempts-and-arrival-to-return-latency.md
[ADR-0169]: 0169-append-operator-alerts-to-alerts-jsonl.md
[ADR-0170]: 0170-build-one-container-image-per-tagged-release.md
[ADR-0171]: 0171-deploy-every-merge-to-main-through-a-self-hosted-runner.md
[ADR-0172]: 0172-install-as-one-folder.md
[ADR-0173]: 0173-assign-every-issue.md
[ADR-0174]: 0174-require-the-pull-request-template-header.md
[ADR-0175]: 0175-check-retention-at-start-up-and-hourly.md
[ADR-0176]: 0176-run-live-checks-before-a-release.md
[ADR-0177]: 0177-give-production-dependencies-their-own-image-stage.md
[ADR-0178]: 0178-open-release-pull-requests-with-a-github-app-token.md
[ADR-0187]: 0187-install-with-a-portable-host-cli.md
[ADR-0190]: 0190-promote-the-published-release-commit.md

## Search Depth

How deep a search goes before the reply. 1 record, in ID order.

| ID       | Date       | Decision                                         | Status   |
| -------- | ---------- | ------------------------------------------------ | -------- |
| ADR-0179 | 2026-11-21 | [Bound Search Briefs for Typed Fields][ADR-0179] | Accepted |

[ADR-0179]: 0179-bound-search-briefs-for-typed-fields.md
[original-log]: https://github.com/TolongLabs/AIRA/blob/79e18f980f8031b78cd6f26740a218fae44df10b/docs/DECISIONS.md
