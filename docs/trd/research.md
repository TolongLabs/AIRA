# Research And Reports

How `/research` finds, reads and summarises sources in the background, and how the report renderer turns the
findings into a PDF. [Tools](tools.md) owns the command list; this module owns the job, the findings shape, the PDF
offer and the renderer.

## At a Glance

| Topic     | Contract                                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| Trigger   | `/research <topic>` only. The tool is `explicit`: the model is never offered it                             |
| Shape     | A background job: an immediate short reply, then the findings in a later message                            |
| Budget    | At most 6 searches, 8 page reads, 3 model calls and 120 s per job; one job per chat at a time               |
| Findings  | One validated object, the mold, holding a summary, key findings, sections, limitations and numbered sources |
| PDF       | Rendered by code from the findings and a format profile. The model never writes the PDF                     |
| PDF offer | Mechanical: code appends the pack's offer line, and code reads the answer                                   |

## Why Explicit Only

A search and a page read answer most questions within the chat's tool limit (`tools.maxPerMessage`). A research job
costs up to ten times more. It runs only when a member types `/research`, so no model judgement can start it. When a
reply needs more than the tool limit allows, the model may suggest `/research <topic>` in words; only the member's
command starts a job.

## The Job

1. **Start.** `/research <topic>` is a direct command: code runs `research_start` with the words after the command
   as the topic, and the model is not called. An empty topic gets the pack's `researchTopic` line and no job. A chat
   with a job already queued or running gets the pack's `researchBusy` line.
2. **Asking for a PDF up front.** When the topic text holds `pdf` or `report` as a whole word, in any case, the job
   is marked `wantsPdf` and the words stay in the topic.
3. **Acknowledge.** Code answers at once with the pack's `researchStarted` line. A pack without the line gets a
   neutral fallback with no persona text.
4. **Row.** One `research_job` row commits before any search: chat, requester, topic, `wants_pdf`, state `queued`.
   The job runs on the job queue ([Persistence](storage.md#everything-in-flight-is-a-row)). A restart requeues a
   `running` job once; a second interruption marks it `failed` and the chat gets the pack's `researchFailed` line.
5. **Plan.** One model call (the main role, structured output) writes 3 to 6 search queries for the topic.
6. **Search and read.** Each query runs through the search port (Exa, 5 results). Code ranks results by how many
   queries found them, drops duplicates and private addresses, and reads the top 8 through the page reader (Exa
   contents), each clipped to 4,000 characters and labelled untrusted.
7. **Synthesise.** One model call (structured output) fills the mold from the pages. One more call is allowed only
   to repair a findings object that failed validation.
8. **Validate.** Code checks the findings: every cited source number exists, every source URL is one the job read,
   no section is empty, and the text fits the limits below. A source the job did not read is dropped, and a claim
   left citing nothing is dropped with it.
9. **Deliver.** The job stores the findings on its row, sets state `done`, and declares a one-time gateway job due at
   once in `gateway/schedule.json`, tagged `[AIRA-SCHEDULED v1 kind=research id=<job id>]`, as reminders do
   ([System](system.md#scheduled-turns)). The firing runs a `research` turn in the job's chat (see Delivery).
10. **Limits.** A job that passes 120 s, or the monthly spend cap, stops and delivers what it has when it holds at
    least one read source; else it fails with the `researchFailed` line.

## The Mold

The findings object is the only thing the model writes for a report. Code renders everything else.

| Field         | Rule                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `title`       | 4 to 120 characters                                                                                    |
| `question`    | The topic as a question, at most 200 characters                                                        |
| `summary`     | Plain text, at most 700 characters                                                                     |
| `keyFindings` | 3 to 7 items: `text` (at most 300 characters) and `sources` (1 or more source numbers)                 |
| `sections`    | 2 to 6 items: `heading` (at most 80), `body` (at most 2,500, paragraphs and `-` lists only), `sources` |
| `limitations` | 0 to 4 short items: what the sources could not settle                                                  |
| `sources`     | 1 to 12 items: `n`, `title`, `url`, `domain`, `accessedAt` (filled by code, not the model)             |

The type lives in `src/render/types.ts` as `ReportDocument`, and its zod schema beside it. Research fills it; the
renderer reads it. A future document kind adds a new type beside it rather than changing this one.

## Delivery

- **Text.** The `research` turn is an ordinary model turn in the chat's character. The findings enter as one
  labelled, untrusted block, and the shape asks for a brief summary: the answer and 3 to 5 key points, at most 1,400
  characters. The footer lists the job's tools and its source domains, as any research reply does.
- **Without a PDF asked for.** Code appends the pack's `offerPdf` line on its own paragraph after the reply. The job
  row records `offer: open` with an expiry of 30 minutes (`research.offerMinutes`).
- **With a PDF asked for.** Code renders the PDF first and appends its `MEDIA:` line; there is no offer. The text is
  the same brief summary. The sticker follows as usual, so the chat sees text, then sticker, then the document.

## The PDF Offer

While a job's offer is open, the next message in that chat from the requester is read by code before anything else:

- **Accept.** The whole message, trimmed, is one of the accept words (`yes`, `y`, `ya`, `yeah`, `yep`, `ok`,
  `okay`, `sure`, `please`, `boleh`, `pdf`, `好`, `要`) with optional punctuation or a closing emoji, or it is
  `/pdf`. The offer closes as `accepted`, the PDF is rendered, and the turn replies in character with a one-line
  hand-over plus the document.
- **Decline.** The whole message is one of `no`, `nope`, `nah`, `tak`, `不用`. The offer closes as `declined` and
  the message is answered as usual.
- **Anything else** is an ordinary message. The offer stays open until it expires. Another member's yes does not
  count.

## The Renderer

`src/render/` turns a `ReportDocument` and a format profile into a PDF. It knows nothing about chats or research.

- **Engine.** Typst, a single pinned binary installed in the image with its SHA-256 checked, as yt-dlp is. Code
  writes the document as JSON beside a template (`src/render/templates/report.typ`) and runs `typst compile` with no
  network, in a temporary folder under `/tmp`, with a 20 s timeout. Fonts ship in the image: Noto Sans and Noto Sans
  CJK SC, so Chinese and Japanese text render.
- **Profile.** `ReportFormat`: page size (`A4` or `Letter`), accent colour, body font size (9 to 12 pt), a cover page
  on or off, a sources appendix on or off, and an optional header line. Defaults live in `config.yml` under
  `render.report`; the setting key `report.format` is reserved for a per-chat override that the owner site will edit.
- **Output.** At most 30 pages and 5 MB; past either, the render fails and the turn says so in the pack's error line.
  The PDF is stored through `putFile` in the `file` table with the files retention, named from the title.
- **Text safety.** The template prints every field as plain text. No field is evaluated as Typst markup, so a page's
  words cannot run code or reach the file system.

## Configuration

| Key                      | Default | Meaning                           |
| ------------------------ | ------- | --------------------------------- |
| `research.maxSearches`   | 6       | Search calls per job              |
| `research.maxPages`      | 8       | Page reads per job                |
| `research.deadlineMs`    | 120000  | Wall time per job                 |
| `research.offerMinutes`  | 30      | How long the PDF offer stays open |
| `render.report.pageSize` | `A4`    | Default page size                 |
| `render.timeoutMs`       | 20000   | One PDF render                    |

## Tests

- Research: the job never starts without the command, budgets stop the loop, a source not read is dropped,
  `wantsPdf` skips the offer, the offer accepts only the requester's whole-message yes within its time, a restart
  requeues once. All with fake search, page and model ports.
- Renderer: a fixture document renders to a PDF with the expected page count, CJK text renders, a field holding
  Typst syntax prints as text, the timeout and size limits refuse. Tests that need the Typst binary skip when it is
  absent and run in the image smoke test.
