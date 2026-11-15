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
