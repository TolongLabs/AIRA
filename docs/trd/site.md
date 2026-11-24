# Owner Site

The existing owner site, revamped as the chatbot's console, with a character studio added.

## At a Glance

| Item            | Value                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Front End       | The existing React app, kept, in `site/`                                                    |
| Design Contract | [The AIRA web design contract](../DESIGN.md)                                                |
| Reach           | Private network only (loopback or Tailscale)                                                |
| Chatbot Data    | Read and written through the core's API                                                     |
| Owner-Tool Data | Host service through the same-origin owner API, with core-managed market and routine writes |

## Scope Of The Revamp

| Page                   | Change                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chats                  | Rebuilt on the settings hierarchy, with resolved settings and source levels                                                                                       |
| Studio                 | Create and edit writable packs, manage expressions, preview the draft and select the pack in Chats (FR-41)                                                        |
| Settings               | Edits host profiles, voice and models. Market writes use the core handler                                                                                         |
| Dashboard              | Reads the host dashboard and checks resulting service states after actions                                                                                        |
| Library, Graph         | Read the host graph and library. Local media requests carry the owner header                                                                                      |
| Reminders              | The Cron page reads the legacy `/api/cron` job list, preserves custom schedules unless edited, validates intervals, and keeps core-managed `aira:` jobs read-only |
| Feedback               | No page in this change; maintainers use the protected API or CLI                                                                                                  |
| Markets, Notices, Send | Market edits check for stale data. Notices verify the saved route. Send reconciles uncertain delivery                                                             |

![Which client and API each site page uses](../diagrams/site-pages.svg)

Every page follows the design contract's shell, palette, type system and shared components. A new component is
added to the contract before it is used.

## Core API

The core exposes the operations below on the private site listener. The table gives the classic route spelling.
The dashboard calls the same handlers under `/owner-api/core/`. With the dashboard entry selected, both paths
require the owner credential. Studio writes and configuration readback use the protected prefix exclusively.
See the [Studio contract](#character-studio-operation-contract) and [owner text contract](#confirmed-owner-text).

| Method | Path                         | Purpose                                           | Access | Handler             |
| ------ | ---------------------------- | ------------------------------------------------- | ------ | ------------------- |
| `GET`  | `/api/health`                | Readiness, version, active turns, per-role status | Read   | `src/api/routes.ts` |
| `GET`  | `/api/chats`                 | Chats with resolved settings and source levels    | Read   | `src/api/routes.ts` |
| `PUT`  | `/api/chats/:id/status`      | Switch one chat on (`active`) or off (`pending`)  | Write  | `src/api/writes.ts` |
| `PUT`  | `/api/chats/:id/label`       | Set or clear a chat's display label               | Write  | `src/api/writes.ts` |
| `GET`  | `/api/settings`              | Raw values at one level (`level`, `scope`)        | Read   | `src/api/routes.ts` |
| `PUT`  | `/api/settings`              | Set or clear one key at one level                 | Write  | `src/api/writes.ts` |
| `GET`  | `/api/characters`            | Loaded packs, plus the packs that failed to load  | Read   | `src/api/routes.ts` |
| `PUT`  | `/api/characters/:id/footer` | Set or clear a data pack's footer icon and labels | Write  | `src/api/writes.ts` |
| `GET`  | `/api/tools`                 | Tools grouped by feature, with modes and commands | Read   | `src/api/routes.ts` |
| `GET`  | `/api/turns`                 | Newest turn rows, newest first                    | Read   | `src/api/routes.ts` |
| `GET`  | `/api/turns/:id`             | One turn with its model, tool and failure rows    | Read   | `src/api/routes.ts` |
| `GET`  | `/api/report`                | Latency, failure, cost and fallback figures       | Read   | `src/api/routes.ts` |
| `GET`  | `/api/memory`                | One chat's memory items (`chat` is required)      | Read   | `src/api/routes.ts` |
| `GET`  | `/api/feedback/:id`          | One report's answers beside its referenced turns  | Read   | `src/api/routes.ts` |

- Requests are JSON with a declared content type. Other content types are refused.
- The Origin and Host headers are checked on every write.
- Routes that read another chat's memory do not exist. The chat id is required.

### Serving The API

- The core starts the API on `site.port` (default 9890). Compose publishes it only on the configured private
  address. The gateway uses a separate listener.
- The dashboard checks the owner token for API access. Host and Origin checks also apply.
  In classic mode, legacy core operations under `/api/` retain their private-network access behavior.
- Only the write paths accept `PUT`. A wrong method on a known route gets 405 `method_not_allowed`, and a path the API
  does not know gets 404.
- Answers are JSON. A bad query gets 400, an unknown id 404, a body over 16 KB 413 `body_too_large`, and a write
  that is not JSON 415. An error body is `{ "error": "<reason code>" }` and never holds message text.

![One site API request, from route check to record](../diagrams/site-api.svg)

### Read Routes

The owner `GET /api/tools` response retains `features` and adds `socialCapabilities`, keyed by
`features.social` and `features.autofetch`. Each list contains enabled platform IDs, display names and
their operation labels, derived from server dispatch and attachment eligibility. Chat settings show both
lists as nested platform switches under their respective main toggles. Each row shows the platform name,
operations, effective value and source. An editable chat override can be cleared with Use inherited.
Read-only rows preserve the saved override. The main switch
disables all nested controls while off, preserving their settings. If Social posts is off while Media
watching is on, the YouTube row explains that its saved value still applies to intake. Writes and clears use validated
`PUT /api/settings` and create the usual `setting_change` record. Show the YouTube exclusion, loading, empty and unavailable states.
Both active DMs and groups can opt in to media delivery and configure its nested switches. The catalog describes installation-wide support. Effective values and
inheritance still come from `GET /api/chats` and writes use the existing settings endpoint.

| Route                   | Answer                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`       | `status` (`ready` or `starting`), `version`, `activeTurns`, and per model role whether it is configured and whether its breaker is open                                                                                                                   |
| `GET /api/chats`        | `chats`: each chat's id, WhatsApp id, type, storedLabel (editable), label (falling back to `channel_directory.json` by `waId`, or `identity.display_name` for DMs, when empty), status, and every setting key with its value and the level it came from   |
| `GET /api/settings`     | With `level` and `scope`: the raw values set at that one level. A bad level or scope gets 400                                                                                                                                                             |
| `GET /api/turns`        | The newest turn rows, newest first, at most `limit` (default 50, at most 200), optionally for one `chat` and `before` a time. A `limit` outside 1 to 200 gets 400 `invalid_limit`; a `before` that is not an ISO-8601 timestamp gets 400 `invalid_before` |
| `GET /api/turns/:id`    | One turn row with its model calls, tool calls and failure rows. The id is URL-decoded; a malformed escape gets 400 `invalid_turn_id`                                                                                                                      |
| `GET /api/report`       | The figures of `bun run report`, always over the last 7 days, read from the newest verified snapshot. With no snapshot it gets 404 `no_snapshot`                                                                                                          |
| `GET /api/memory`       | With `chat` (required, else 400): that chat's memory items: id, kind, subject, key, value, status, updated time                                                                                                                                           |
| `GET /api/characters`   | `characters`: each loaded pack's id, display name, aliases when configured, source (`repository` or `data`) and languages. `faults`: each pack that did not load, with its id and reason                                                                  |
| `GET /api/tools`        | `features`: tools grouped by feature `key`, each with `name`, `mode` (`implicit`, `explicit` or `both`) and slash-prefixed `commands`, read from the registry                                                                                             |
| `GET /api/feedback/:id` | One report by `report_id`: state, issued and received times, checked answers, and the existing turn records named by `turn_ids`. It never returns `ref`; unknown ids get 404. Answers are untrusted text and never enter a model prompt                   |

### Write Routes

| Route                            | Body                                                                        | Answer                                          |
| -------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| `PUT /api/chats/:id/status`      | `{ "status": "active" }` or `"pending"`                                     | `chatId`, `status`, and `changed` true or false |
| `PUT /api/chats/:id/label`       | `{ "label": string }` (trimmed, max 120 chars)                              | `chatId`, `label`, and `changed` true or false  |
| `PUT /api/settings`              | `{ "level", "scope", "key", "value" }`; `value: null` clears the row        | `level`, `scope`, `key`, `value`, `changed`     |
| `PUT /api/characters/:id/footer` | `{ "icon"?, "labels"?: { "<kind>": string or null } }`; `null` clears a key | `id`, `toolFooter`, `changed`                   |

The dashboard footer editor reads `GET /owner-api/core/characters/:id/footer` for `id`, `toolFooter` and
the full pack `revision`. Its `PUT` to the same path includes `expectedRevision`. A missing revision returns 428. A stale revision returns 409 and preserves the local draft until the owner chooses to reload. The Studio
writer verifies the resulting pack and returns the saved footer, revision and `changed`. A no-op leaves the
revision and audit count intact. The classic direct API still accepts its original request shape.

- The footer route edits `toolFooter` in a data pack's `card.yml` in place, keeping its comments. A repository pack
  gets 409 `pack_read_only`; a card that does not parse or validate gets 409 `pack_unparseable`, and nothing is
  written. A label or icon that breaks the footer rule ([Prompt Engine](prompt-engine.md#tool-footer)) gets 400
  `invalid_footer`; a kind that is neither a tool name nor an intake kind gets 400 `unknown_footer_kind`. Inside
  the one writer lock the file is written to a temporary file and renamed over the card, and one `setting_change`
  row per changed key is written with target `pack`. If writing the `setting_change` audit rows fails after
  replacing `card.yml`, the previous `card.yml` bytes are restored before the error propagates. If the saved pack
  then fails to load, the old file is put back and the inserted `setting_change` rows are deleted; reload failure
  returns 409 `pack_unparseable` if the pack had a pre-existing load fault not caused by the footer edit, or 400
  `invalid_footer` otherwise. Packs reload on every turn, so the next turn uses the new labels.

- A write needs `Content-Type: application/json` (else 415) and a body of at most 16 KB (else 413 `body_too_large`)
  that the route's schema accepts (else 400). Only `PUT` is accepted on a write path (else 405). An unknown chat
  gets 404. A chat id in a path is URL-decoded; a malformed escape gets 400 `invalid_chat_id`.
- `Host` must be an IP address or `localhost`, with a port. Any other name gets 403 `host_refused`, so a page that
  rebinds its own name to the private address cannot reach the API.
- A request that carries `Origin` gets 403 `origin_refused` unless that origin is the API's own (`http://` and the
  request's `Host`) or is listed in `site.allowedOrigins`, which is empty by default. A request with no `Origin` is
  accepted when `Host` passes the check.
- `PUT /api/chats/:id/status` with `status: "active"` requires the chat to have a loaded effective `character`;
  otherwise it is refused with 400 `missing_character`. Switching to `"pending"` is always accepted.
- A setting is checked as start-up checks it: a known key, a valid scope for its level, a value its schema accepts
  (else 400 `invalid_setting`), and for `character` a pack that is loaded (else 400 `unknown_character`; the pack
  loader's message never reaches the client). A chat scope that does not exist gets 404. Clearing a value restores
  inheritance from the level above. `PUT /api/settings` clearing `character` (`value: null`) at `chat` level on an
  active chat whose inherited `character` is unset or not loaded is refused with 400 `missing_character`.
- Every applied change writes a `setting_change` row with actor `site`. Setting the status or label a chat already has
  changes nothing and writes no row. Setting a chat's label writes a `setting_change` row with key `label` and `NULL`
  values so label text never enters the log. A status or setting write that changed something also calls `onWrite`,
  which rewrites the gateway's `chats.json` flags; a write that changed nothing rewrites nothing. Writing the global
  `character` key also rewrites the gateway's unavailable line for that pack.

The site is the owner's console on the private network, so it may show a chat's WhatsApp id. Record tables and logs
still never hold one.

## Hierarchy Editing

- Feature switches show registry-derived Implicit, Explicit or Both chips, with hover and keyboard-focus tooltips.
- The Chats page shows, for each key, the resolved value and a marker: inherited from global, inherited from chat
  type, or set here.
- Setting a value writes one row at the chosen level. Clearing it deletes the row and restores inheritance.
- Feature switches are listed as a group with their inherited state.
- The Replies switch requires a loaded effective character to activate a chat. An active chat can always be switched off.
- A change that binds a chat to a pack that is not loaded is refused with 400 `unknown_character`.

## Character Studio

The catalogue at `/characters` lists loaded packs and reports load failures. Create a writable pack or copy
a repository example, then edit its card, moods, lines, expressions and tool footer. The editor previews the
draft prompt and opens a separate simulator tab. The owner can select a saved pack in Chat Settings.

The [operation contract](#character-studio-operation-contract) describes validation, revisions, expression
conversion and recovery. The [state matrix](dashboard-state.md) identifies read-only sources and activation.

## Writes That Send Or Restart

The chat composer resolves one recipient and requests explicit confirmation. The core records a submission
before handing it to the gateway. The [confirmed owner text contract](#confirmed-owner-text) defines duplicate
and unknown outcomes. System service actions use the host owner service and verify the resulting unit state.

## Build

Vite builds the dashboard entry and nine classic HTML entries into the release image. The dashboard loads its
workspaces on demand. The [site build instructions](../../site/README.md) cover local setup and the preview.

## Serving The Site

- The selected dashboard entry sends `/` and `/app/` to `/overview`. Known deep links load the dashboard
  document. Legacy HTML bookmarks map to their corresponding destinations. Selecting the classic entry restores
  the original site under `/app/`. The [route matrix](dashboard-routes.md) lists both sets of paths.
- Static files support GET and HEAD. Fingerprinted files under `/app/assets/` use an immutable year-long cache.
  Other static files use `no-cache`. Unknown assets and API paths keep their error status.
- The browser stores the owner credential under `tolongai-token` and sends it in the `X-TolongAI-Token` header.
  A 401 prompts for the credential. Legacy token and theme migrations are scoped to their corresponding keys.
- Dashboard core operations use `/owner-api/core/`. Host-owned operations use `/owner-api/` on the same
  origin. The proxy streams protected media and uploads. On dev2 the core connects through a private Unix
  socket to the host owner bridge. The bridge checks that an anonymous settings request is refused.
- Gateway names can supply display names. Clearing an owner label keeps the stored label empty across new messages.
  Container installs expose only the gateway directory index to the core. The index refreshes after replacement. Each chat row includes the time of its latest inbound message, or null
  for a record with no inbound messages. Phone and linked-device identities remain separate unless verified.

Clearing a character at global, type or chat level must leave each active chat that uses that binding
with a loaded effective character. A more specific binding keeps its precedence.

## Owner Page Edits

The Settings editor keeps its selected file and unsaved buffer until Save or Revert. A failed read disables
writes to that target until Retry load succeeds. Save checks the returned kind, name and UTF-8 byte count. Models, Voice and Files change the host owner service. The core uses its own deployed
configuration and the chat's character binding. The Ollama probe checks the entered origin from the host,
authenticates the owner's token and reads only the model list. It never saves the entered endpoint.

Market list replacements carry the field values seen by the editor. A conflicting write returns 409.
Per-chat watchlist edits check the returned scope and render the stored tickers and inheritance flag.
A successful market edit returns a `markets` object with the persisted watchlist and alerts arrays.
The client rejects an incomplete acknowledgement. The core writes the same markets file read by the owner tools. Digest changes preserve the other recipients
and hours. Notice routes store the gateway's prefixed WhatsApp target. Core lookups accept both that form
and older bare targets. A refused write retains its draft. Service actions check the resulting unit state.
A lost upload acknowledgement requires checking recent sends before retrying.

Arming an alert for the default destination preserves rules for individual chats, including gateway IDs saved by the core.
Renaming a routine preserves its full stored prompt even when the host returns only a shortened preview.
Core-managed owner mutations require the same owner token as a protected settings read. A credential refusal returns HTTP 401.
The core uses the host’s scoped WhatsApp key for each chat watchlist and reads older bare-ID entries.
Alert delivery retains the destination ID supplied by the gateway.

## Dashboard command boundary

The dashboard uses typed same-origin core queries and commands. The core resolves authority and validates each
operation. See [route parity](dashboard-routes.md) and [state ownership](dashboard-state.md). The approved visual
contract is [the AIRA web design contract](../DESIGN.md).

### Confirmed owner text

POST /owner-api/messages accepts a submissionId (UUID), chatId (internal core ID) and text. GET
/owner-api/messages/:submissionId returns the recorded outcome. Both operations verify the private Host, allowed
Origin and the owner credential through the existing protected host settings read. Responses use no-store.
Resolve exactly one known DM or group. Reject invalid input before dispatch. Trim outer whitespace, preserve
internal newlines and accept 1–4,000 Unicode code points. The client allocates the UUID once per confirmation.

Before calling the existing host send transport, commit a reservation with the internal target, submission ID,
request fingerprint, timestamp and outcome unknown. Only the caller that creates the reservation may dispatch.
The host transport submits plain text with stamp false and one validated whatsapp-prefixed target.
The host returns 200 with the exact target, text and null sent_at after gateway success. Compare the entire
acknowledgement before recording it, and omit text and target from the response and logs. Never invoke a model or change chat settings. A duplicate
with matching content returns the recorded outcome. Reuse with different content or target returns 409.
A confirmed acknowledgement changes the record to acknowledged. A definite pre-dispatch refusal returns refused.
An interrupted call, ambiguous response or crash leaves unknown until positive evidence permits reconciliation.
Return the submission ID and outcome only. A lookup miss returns 404. No retry dispatches an unknown reservation.

### Preview mount

The staging entry is `/app/preview/overview`. A direct GET or HEAD on a registered preview route returns
the dashboard document. The classic entry preserves the original nine documents and root redirect. Resolve fingerprinted
assets under /app/assets/ and local font and glyph assets under /app/dashboard/. An unknown page or file
returns 404. The preview uses the same API origin and credential controls as the installed console.

### Protected core queries and scoped settings

Preview clients address core queries and writes via /owner-api/core/ followed by the relative core API route.
The listener checks Host, Origin and the existing protected owner settings read on each request before dispatch.
All responses on this path use no-store. The compatibility /api/ surface retains its legacy behavior during preview.
With the dashboard entry selected, private owner data and mutations require the protected boundary on every reachable route.

A scoped settings query returns raw overrides, effective values with source, and an opaque revision. The revision
covers the rows eligible at that scope, including applicable inherited rows. Protected settings writes require an
expectedRevision obtained on read. Compare it under the write transaction before storing either the row or its audit.
A missing revision returns 428. A stale revision returns 409 and leaves the draft available for comparison.

A deployment config query returns only opaque revisions and status (see
[state ownership](dashboard-state.md#deployment-activation-readback)). `GET /owner-api/core/config` answers
`{ appliedRevision, currentRevision, status, checkedAt, appliedAt }` with no config value, secret or path.
Any non-`GET` method returns `405`. The same path without the protected prefix is not a public route.

### Character Studio operation contract

The protected core prefix exposes GET characters/:id/studio, POST characters and PUT characters/:id/studio.
GET returns id, source, writable, revision and the validated card, moods and lines documents. A repository card
supports creating an editable copy with a distinct id. POST accepts id and the three typed documents, or a
sourceId and new id for a copy. An existing id, including a repository id, is a conflict. PUT requires an
expectedRevision and a patch of document fields. Preserve comments and unchanged fields in the source YAML.
A failed parse returns a sanitized fault with no write. Persist no prompt or file bytes in the audit.
The simulator opens in a separate tab, takes the current draft and never invokes a delivery transport.

Canonical trees are data/characters/:id. Reject symlinks, unknown file names, paths outside the pack root
and active media. Data packs may retain up to 64 regular document backups named `<document>.yml.bak-YYYYMMDD`,
each within the document size limit. Their bytes contribute to the revision and survive edits and recovery.
Studio omits backups from API responses and new copies. Stage on the same filesystem, verify all assets and validate the complete staged pack under
its intended id and compare its source revision before publish. Keep a recoverable intent and prior version
across the multi-file publish and audit. Recover before serving reads or turns after restart. Only one owner
writer can publish a pack at a time. Uncoordinated external editors must refetch and apply through the
coordinated writer for strict concurrency. An invalid external change remains available to the owner for repair.

The protected expressions collection under characters/:id/expressions returns revision and a list of names and
descriptions. An authenticated item GET returns static image/webp and no-store. POST accepts the displayed name,
description, MIME type, base64 data and expectedRevision. Conversion accepts static PNG, JPEG or WebP, at most
4 MiB compressed, 4096 pixels per dimension and 16 million pixels decoded. Publish at most 50 expressions per
writable pack, comparing version and capacity again after conversion under the pack writer. A published sticker
is 512 by 512 pixels. Conversion caps the encoded result at 100 KiB; the pack loader enforces
the stricter 100,000-byte limit for a static sticker before publication. See the [WhatsApp sticker requirements](https://github.com/WhatsApp/stickers).

Every protected dashboard response carries a generated X-Request-Id. The listener records request ID, build
identifier, timestamp, fixed route category, HTTP method, status, elapsed time and a fixed reason code. A bounded
event window limits volume. Omit URL parameters, bodies, credentials, prompt text and target identifiers.

The release image supports AIRA_DASHBOARD_ENTRY=dashboard as an operator switch. An unset value serves the
legacy entry. With the switch enabled, root and the previous HTML entries redirect to canonical dashboard paths.
The preview and canonical mounts use the same build. Hashed assets remain under /app/assets. Unknown assets and
API paths return a real 404. Protected data requires the owner credential on both direct and proxied API routes,
including direct compatibility calls. Switching back uses the previous entry and preserves the current data volume.

An owner can change allowedSenders from the preview Access tab for a single group or DM. The editor stages the
registered value ("all" or an explicit sender list), shows who will be admitted after the change and requires
confirmation. A clear uses the scoped settings operation to restore inheritance. A conflict or refusal keeps
the draft. Admission on subsequent incoming turns uses the same resolved setting as the existing runtime.
