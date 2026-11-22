# Owner Site

The existing owner site, revamped as the chatbot's console, with a character studio added.

## At a Glance

| Item            | Value                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Front End       | The existing React app, kept, in `site/`                                                    |
| Design Contract | The site's own `DESIGN.md`. It wins over code for anything visual                           |
| Reach           | Private network only (loopback or Tailscale)                                                |
| Chatbot Data    | Read and written through the core's API                                                     |
| Owner-Tool Data | Host service through the same-origin owner API, with core-managed market and routine writes |

## Scope Of The Revamp

| Page                   | Change                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chats                  | Rebuilt on the settings hierarchy, with resolved settings and source levels                                                                                       |
| Studio                 | Planned, not built. No studio page or character write route exists yet (FR-41)                                                                                    |
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

Served by the core on the private network, with no bearer token. Every write checks `Host` and `Origin`, goes through
the same validation as start-up, and is logged to `setting_change`. This is every route the core serves. The only
character write is the footer route. No sticker, preview or memory forget route exists.

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

- The core serves the API on its own port, `site.port` (default 9890), never on the gateway's port. The compose file
  publishes it on the host's private-network address only, `AIRA_SITE_BIND`. While the new core runs beside the old
  one, that address is loopback.
- The core always starts the site API server on `site.port`, with no bearer token. Protection relies on private
  loopback or Tailscale binding (`AIRA_SITE_BIND`) and the `Host` and `Origin` checks on write routes.
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

Planned, not built (FR-41). No studio page exists in the site build. The first pack write is the footer route: the
Chats page edits a data pack's footer icon and labels, showing each kind's default and whether the pack sets it. The
core has no other character write, and no sticker or preview route. The only character surface is a read: `GET /api/characters` lists each loaded pack's id, display
name, source and languages, plus the packs that failed to load with their reasons. The Chats page uses that list
for the character choice. What FR-41 still needs: a studio page, a pack save route with the start-up validator, a
sticker upload route, and a prompt preview route.

## Writes That Send Or Restart

Service restart buttons and message sending stay on the owner-tool side of the site with their current checks. The
chatbot pages have no control that sends a message to a chat or restarts a service.

## Build

The site builds with Vite in CI and ships inside the release image. Built output is not committed. The build is
multi-page, not a single-page app: nine entries (`index`, `markets`, `graph`, `library`, `cron`, `chats`,
`settings`, `notices`, `send`), one shared shell, and no studio entry. The chatbot client (`site/src/lib/core.ts`)
exposes seven calls (`tools`, `chats`, `characters`, `setStatus`, `setLabel`, `setSetting`, `setFooter`) without a
bearer token.

## Serving The Site

- The core serves the built site on the site API's port, under `/app/`. `/` redirects to `/app/`. Only the nine
  built file types (`.html`, `.js`, `.css`, `.json`, `.svg`, `.png`, `.webp`, `.ico`, `.woff2`) are served, and only
  `GET` and `HEAD` are accepted; anything else gets 404 or 405. Files under `/app/assets/` carry an immutable
  year-long cache header; every other file is `no-cache`. Every answer carries `x-content-type-options: nosniff`
  and `referrer-policy: no-referrer`.
- Neither the site's static files nor the core's `/api/` routes require a bearer token.
- The chatbot client (`site/src/lib/core.ts`) sends no token. Every owner-tool page keeps the legacy token under
  `tolongai-token`; its first 401 asks for it once, it is kept in the browser's local storage, and it is sent on
  legacy calls. It never goes in a URL.
- On load the legacy client migrates an old `mirai-token` or `memento-token` into `tolongai-token`, and the shell
  migrates `mirai-theme` into `tolongai-theme`.
- A page calls the API on its own origin, so a browser write carries the API's own `Origin` and is accepted.
- The Chats page is the only page on the core's API. Dashboard, Settings, Library, Graph, Cron, Markets, Notices
  and Send reach the host owner service through the same origin under `/owner-api/`. The core strips this prefix
  and sends the request to the corresponding `/api/` endpoint on the configured owner service. Core paths
  such as `/api/chats` retain their independent response shapes. Owner credentials travel only in the
  `X-TolongAI-Token` header. The proxy streams uploads and media and propagates refusal or service failure.
  On dev2 the container connects through a private Unix socket. A systemd user socket forwards to the host's
  bridge address only after an anonymous settings request returns 401. Using loopback here would bypass owner
  authentication.
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
