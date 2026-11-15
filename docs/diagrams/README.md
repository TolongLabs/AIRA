# Diagrams

Each diagram has a JSON source in `src/` and a committed SVG beside this file. Documents embed the SVG.

| Diagram             | Shows                                      | Embedded In                       |
| ------------------- | ------------------------------------------ | --------------------------------- |
| `system-overview`   | The processes and how they call each other | `README.md`, `docs/trd/system.md` |
| `message-path`      | One message from WhatsApp to the reply     | `docs/trd/system.md`              |
| `memory-write-path` | How a fact is admitted, checked and stored | `docs/trd/memory.md`              |

## Change A Diagram

1. Edit the JSON source in `src/`.
2. Render it with the Archify skill's command, once per diagram:
   `node <archify>/bin/archify.mjs finalize workflow docs/diagrams/src/<name>.json .archify/<name>.html --quality showcase`
3. Run `bun run diagrams` to export every rendered page to an SVG here.
4. Commit the JSON source and the SVG together.

The SVGs carry their own colours and follow the reader's light or dark theme.
