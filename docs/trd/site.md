# Owner Site

The existing owner site, revamped as the chatbot's console, with a character studio added.

## At a Glance

| Item            | Value                                                             |
| --------------- | ----------------------------------------------------------------- |
| Front End       | The existing React app, kept, in `site/`                          |
| Design Contract | The site's own `DESIGN.md`. It wins over code for anything visual |
| Reach           | Private network only, behind the site token                       |
| Chatbot Data    | Read and written through the core's API                           |
| Owner-Tool Data | Read and written through the site's existing API, unchanged       |

## Scope Of The Revamp

| Page                   | Change                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Chats                  | Rebuilt on the settings hierarchy. Shows each chat, its resolved settings and their source level |
| Settings               | Rebuilt for global and chat-type defaults, model roles, and feature defaults                     |
| Studio                 | New. Create and edit character packs                                                             |
| Dashboard              | Rebuilt on turn records: latency, failures, cost, fallback rate, service health                  |
| Library, Graph         | Rebuilt on memory items, per chat                                                                |
| Reminders              | The scheduled-message page, limited to chatbot reminders                                         |
| Markets, Notices, Send | Kept as they are. Only the shared shell changes with the rest of the site                        |

Every page follows the design contract's shell, palette, type system and shared components. A new component is
added to the contract before it is used.

## Core API

Served by the core on the private network. Every route requires the site token. Every write goes through the same
validation as start-up and is logged to `setting_change`.

| Method And Path                        | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/chats`                       | Chats with their resolved settings and source levels              |
| `PUT /api/chats/:id/status`            | Switch one chat on (`active`) or off (`pending`)                  |
| `GET /api/settings?level=&scope=`      | Raw values at one level                                           |
| `PUT /api/settings`                    | Set or clear one key at one level                                 |
| `GET /api/characters`                  | Packs, with validation state and prompt size                      |
| `GET /api/characters/:id`              | One pack's files                                                  |
| `PUT /api/characters/:id`              | Save a pack. Validates first; an invalid pack is not saved        |
| `POST /api/characters/:id/stickers`    | Upload an image. Converts it to sticker format                    |
| `POST /api/characters/:id/preview`     | Assemble the prompt for a sample turn and return it with its size |
| `GET /api/memory?chat=`                | Memory items for one chat                                         |
| `POST /api/memory/:id/forget`          | Forget one item                                                   |
| `GET /api/turns`, `GET /api/turns/:id` | Turn records                                                      |
| `GET /api/report`                      | Latency, failure, cost and fallback figures                       |
| `GET /api/health`                      | Core, gateway, runner and model role status                       |

- Requests are JSON with a declared content type. Other content types are refused.
- The Origin and Host headers are checked on every write.
- The token is sent in a header, never in a URL.
- Routes that read another chat's memory do not exist. The chat id is required.

### Serving The API

- The core serves the API on its own port, `site.port` (default 9890), never on the gateway's port. The compose file
  publishes it on the host's private-network address only, `AIRA_SITE_BIND`. While the new core runs beside the old
  one, that address is loopback.
- Every route needs `Authorization: Bearer <SITE_TOKEN>`. `SITE_TOKEN` is a secret of at least 32 characters in
  `.env`, compared in constant time. With no token set, the API does not start and the core logs why; the gateway
  endpoint is not affected.
- Answers are JSON. A missing or wrong token gets 401, a bad query 400, an unknown id 404, a write that is not JSON 415. An error body is `{ "error": "<reason code>" }` and never holds message text.

### Read Routes

| Route                | Answer                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`    | `status` (`ready` or `starting`), `version`, `activeTurns`, and per model role whether it is configured and whether its breaker is open                        |
| `GET /api/chats`     | `chats`: each chat's id, WhatsApp id, type, label, status, and every setting key with its value and the level it came from                                     |
| `GET /api/settings`  | With `level` and `scope`: the raw values set at that one level                                                                                                 |
| `GET /api/turns`     | The newest turn records, newest first, at most `limit` (default 50, at most 200), optionally for one `chat` and `before` a time. Records only: no message text |
| `GET /api/turns/:id` | One turn record with its model calls, tool calls and failure records                                                                                           |
| `GET /api/report`    | The figures of `bun run report`: latency, failures, cost and fallback rate                                                                                     |
| `GET /api/memory`    | With `chat` (required): that chat's memory items: id, kind, subject, key, value, status, updated time                                                          |

### Write Routes

| Route                       | Body                                                                 | Answer                                          |
| --------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `PUT /api/chats/:id/status` | `{ "status": "active" }` or `"pending"`                              | `chatId`, `status`, and `changed` true or false |
| `PUT /api/settings`         | `{ "level", "scope", "key", "value" }`; `value: null` clears the row | `level`, `scope`, `key`, `value`, `changed`     |

- A write needs `Content-Type: application/json` (else 415) and a body of at most 16 KB that the route's schema
  accepts (else 400). An unknown chat gets 404.
- `Host` must be an IP address or `localhost`, with a port. Any other name gets 403 `host_refused`, so a page that
  rebinds its own name to the private address cannot reach the API.
- A request that carries `Origin` gets 403 `origin_refused` unless that origin is listed in `site.allowedOrigins`.
  The list is empty by default. A request from a server, with no `Origin`, relies on the token.
- A setting is checked as start-up checks it: a known key, a valid scope for its level, a value its schema accepts
  (else 400 `invalid_setting`), and for `character` a pack that is loaded (else 400 `unknown_character`). A chat
  scope that does not exist gets 404. Clearing a value restores inheritance from the level above.
- Every applied change writes a `setting_change` row with actor `site`. Setting the status a chat already has
  changes nothing and writes no row.

The site is the owner's console on the private network, so it may show a chat's WhatsApp id. Record tables and logs
still never hold one.

## Hierarchy Editing

- The Chats page shows, for each key, the resolved value and a marker: inherited from global, inherited from chat
  type, or set here.
- Setting a value writes one row at the chosen level. Clearing it deletes the row and restores inheritance.
- Feature switches are listed as a group with their inherited state.
- A change that would bind a chat to an invalid pack is refused with the validator's message.

## Character Studio

1. **List.** Packs with a validity badge and prompt size.
2. **Edit.** Forms for the card, the mood list (rules, guidance, openers, endings, faces) and the fixed lines.
3. **Stickers.** Upload per mood. The preview shows the converted sticker.
4. **Validate.** The same validator as start-up runs on every save and shows each problem beside its field.
5. **Preview.** The assembled prompt for a sample message, with the token count against the ceiling.
6. **Use.** A valid pack appears in the character choice on the Chats and Settings pages.

A pack that a chat is bound to cannot be deleted. A save that would make a bound pack invalid is refused.

## Writes That Send Or Restart

Service restart buttons and message sending stay on the owner-tool side of the site with their current checks. The
chatbot pages have no control that sends a message to a chat or restarts a service.

## Build

The site builds with Vite in CI and ships inside the release image. Built output is not committed.
