# Decisions

The lasting choices behind AIRA, with why they were made. Check here before reversing one. Add a row in the pull request
that makes a new decision.

## Architecture

| Date       | Decision                                                                                                                                         | Why                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 2026-11-15 | The core is a new TypeScript service on Node 24. The existing Python chatbot code is retired at cutover.                                         | The designs AIRA adopts are proven in TypeScript, and both maintainers can read a small typed codebase. |
| 2026-11-15 | Hermes Agent stays as the WhatsApp transport at its pinned commit. It is not upgraded.                                                           | 55 of 67 local patches fail on current upstream, and upstream ships the same WhatsApp library.          |
| 2026-11-15 | The core attaches at the seam that exists today: an OpenAI-compatible endpoint on `127.0.0.1:9881` that Hermes calls as a custom model provider. | Cutover and rollback are one address change. No new Hermes patch is needed to attach.                   |
| 2026-11-15 | Hermes's fallback provider list is emptied. The core always returns a deliverable reply.                                                         | It removes the second agent loop, the duplicate tool set and the second voice.                          |
| 2026-11-15 | One turn runner interface with two implementations: an API runner and a subscription runner.                                                     | The prompt, tools and cleaning chain stay identical on both transports (PRD FR-32).                     |
| 2026-11-15 | The API runner uses Google's Agent Development Kit for the model loop and tool calls.                                                            | It gives callbacks at every stage the core must control, and the maintainers know it.                   |

## Data

| Date       | Decision                                                                                                                          | Why                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 2026-11-15 | One SQLite file is the canonical store. One process writes it.                                                                    | The memory faults came from several writers on unlocked text files.                               |
| 2026-11-15 | A character pack on disk is the only source of persona text.                                                                      | Persona text hard-coded in program code cannot differ per chat.                                   |
| 2026-11-15 | Chat settings live in the database, in a three-level hierarchy. Deployment settings live in `config.yml`. Secrets live in `.env`. | Settings need transactions, validation and a change record. Deployment values need review in git. |

## Site

| Date       | Decision                                                                                                                                  | Why                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 2026-11-15 | The owner site keeps its React front end and design contract. Chatbot pages call the core's API. Owner-tool pages keep their current API. | It revamps the site without touching the owner tools. |

## Deployment

| Date       | Decision                                                                               | Why                                                                         |
| ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2026-11-15 | A tagged release builds one container image. The host pulls and deploys it on a timer. | Updates cannot be forgotten, and no outside system holds a key to the host. |
