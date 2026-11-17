# Diagrams

Each diagram has a JSON source in `src/` and a committed SVG beside this file. Documents embed the SVG. A source that cites code carries `meta.repository`; render it with `--repo-root .`.

| Diagram               | Shows                                        | Embedded In                                 |
| --------------------- | -------------------------------------------- | ------------------------------------------- |
| `system-overview`     | The processes and how they call each other   | `README.md`, `docs/trd/system.md`           |
| `message-path`        | One message from WhatsApp to the reply       | `docs/trd/system.md`                        |
| `memory-write-path`   | How a fact is admitted, checked and stored   | `docs/trd/memory.md`                        |
| `backups`             | Snapshots, Archive, and the Off-Host Copy    | `docs/trd/storage.md`                       |
| `benchmarks`          | Benchmark Run and Result Lifecycle           | `docs/trd/harness.md`                       |
| `command-routing`     | Command Detection and Routing                | `docs/trd/tools.md`                         |
| `gateway-files`       | Gateway Schedule and Chat-Flag Dataflow      | `docs/trd/system.md`                        |
| `gateway-request`     | Gateway Request and Reply Sequence           | `docs/trd/system.md`                        |
| `harness`             | Harness Replay, Fake Bridge and Preview      | `docs/trd/harness.md`                       |
| `host-units`          | Host Units And What They Run                 | `docs/RUNBOOK.md`, `docs/trd/deployment.md` |
| `lessons-tools`       | Lessons Tool Map                             | `docs/trd/tools.md`                         |
| `media-intake`        | Media Intake                                 | `docs/trd/models.md`                        |
| `model-routing`       | Model Routing                                | `docs/trd/models.md`                        |
| `release-deploy`      | Release And Deploy Path                      | `docs/RUNBOOK.md`, `docs/trd/deployment.md` |
| `site-api`            | Site API Request                             | `docs/trd/site.md`                          |
| `site-pages`          | Site Page To API Map                         | `docs/trd/site.md`                          |
| `social-readers`      | Social Readers                               | `docs/trd/models.md`                        |
| `storage-startup`     | Storage Start-Up and Recovery                | `docs/trd/storage.md`                       |
| `tool-call`           | Tool Call Lifecycle                          | `docs/trd/tools.md`                         |
| `turn-admission`      | Turn Admission                               | `docs/trd/reliability.md`                   |
| `turn-record`         | Turn Record Lifecycle                        | `docs/trd/records.md`                       |
| `report-render`       | Report Render, From Document To PDF          | `docs/trd/research.md`                      |
| `research-job`        | Research Job, From Command To PDF Offer      | `docs/trd/research.md`                      |
| `cleaning-chain`      | Reply Cleaning Chain, Bubbles and Sticker    | `docs/trd/prompt-engine.md`                 |
| `data-erd`            | AIRA Data Model                              | `docs/trd/data.md`                          |
| `forget-barrier`      | Forget Barrier                               | `docs/trd/memory.md`                        |
| `memory-migration`    | Memory Migration                             | `docs/trd/memory.md`                        |
| `memory-recall`       | Memory Recall                                | `docs/trd/memory.md`                        |
| `pack-loading`        | Character Pack Loading and Validation        | `docs/trd/prompt-engine.md`                 |
| `prompt-build`        | Prompt Build: From Turn Input to Model Input | `docs/trd/prompt-engine.md`                 |
| `settings-migration`  | Settings Migration                           | `docs/trd/memory.md`                        |
| `settings-resolution` | Settings Resolution And Update               | `docs/trd/data.md`                          |

## Change A Diagram

1. Edit the JSON source in `src/`.
2. Render it with the Archify skill's command, once per diagram:
   `node <archify>/bin/archify.mjs finalize workflow docs/diagrams/src/<name>.json .archify/<name>.html --quality showcase`
3. Run `bun run diagrams` to export every rendered page to an SVG here.
4. Commit the JSON source and the SVG together.

The SVGs carry their own colours and follow the reader's light or dark theme.
