# Traceability

Status per requirement, with the code and tests that prove it.

PRD carries the status. This page carries the evidence. Evidence comes from the audit bundles at baseline `f4f21fd`,
confirmed against this checkout for the rows cited.

Built maps to Shipped, partial maps to Partial, and absent maps to Planned. PRD keeps Exists (faulty) only where no
audit covered the requirement. NFR rows use Open where work is known to be missing and Not audited where no audit
covered them, since PRD sets no NFR status.

Keep this page current: change the row in the same pull request that changes the behavior, and set the PRD status
from this page after an audit.

## Conversation

| ID   | Status  | Main Code Paths                              | Test Paths    | TRD Module     | Gap                                              |
| ---- | ------- | -------------------------------------------- | ------------- | -------------- | ------------------------------------------------ |
| FR-1 | Partial | src/gateway/request.ts, src/turn/pipeline.ts | tests/harness | system.md      | Core trusts the gateway's addressing pick.       |
| FR-2 | Shipped | src/turn/window.ts, src/turn/pipeline.ts     | tests/restart | storage.md     | None.                                            |
| FR-3 | Shipped | src/turn/pipeline.ts                         | tests/harness | reliability.md | Attachments live only in memory.                 |
| FR-4 | Shipped | src/turn/pipeline.ts                         | tests/harness | system.md      | A direct command answers in code, by design.     |
| FR-5 | Partial | src/turn/deliver.ts, src/turn/pipeline.ts    | tests/harness | reliability.md | Research deliveries bypass mute and quiet hours. |

## Characters And Per-Chat Settings

| ID    | Status          | Main Code Paths                                  | Test Paths     | TRD Module       | Gap                                                           |
| ----- | --------------- | ------------------------------------------------ | -------------- | ---------------- | ------------------------------------------------------------- |
| FR-6  | Shipped         | src/character/loader.ts, src/character/schema.ts | tests/contract | prompt-engine.md | None.                                                         |
| FR-7  | Exists (faulty) | —                                                | —              | data.md          | Not covered by an audit; status kept from the old core.       |
| FR-8  | Shipped         | src/settings/settings.ts, src/settings/keys.ts   | tests/contract | data.md          | None.                                                         |
| FR-9  | Shipped         | src/turn/pipeline.ts                             | tests/harness  | reliability.md   | None.                                                         |
| FR-10 | Partial         | src/turn/pipeline.ts, src/app.ts                 | tests/harness  | system.md        | The model breaker is shared, not keyed by chat and character. |

## Expression, Mood And Tone

| ID    | Status  | Main Code Paths                                                                   | Test Paths                                              | TRD Module       | Gap                                                                                                                       |
| ----- | ------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| FR-11 | Shipped | src/prompt/mood.ts, src/prompt/builder.ts                                         | tests/contract                                          | prompt-engine.md | None.                                                                                                                     |
| FR-12 | Shipped | src/prompt/shape.ts, src/prompt/builder.ts                                        | tests/harness                                           | prompt-engine.md | Research and command bypasses apply at clean time.                                                                        |
| FR-13 | Partial | src/prompt/stickers.ts, src/media/studio-expression.ts, deploy/gateway/patches.py | tests/contract/studio-expression.test.ts, tests/harness | prompt-engine.md | Studio converts uploads to 512 × 512 WebP within 100 KiB. The native sticker delivery path has separate gateway coverage. |
| FR-14 | Partial | src/character/schema.ts, src/turn/pipeline.ts                                     | tests/harness                                           | prompt-engine.md | Broken bindings and storage failures can end with no line.                                                                |

## Reply Formatting

| ID    | Status  | Main Code Paths                                        | Test Paths                       | TRD Module       | Gap                                                      |
| ----- | ------- | ------------------------------------------------------ | -------------------------------- | ---------------- | -------------------------------------------------------- |
| FR-15 | Shipped | src/format/render.ts                                   | tests/unit/format-corpus.test.ts | prompt-engine.md | Link labels stay with the bare URL; tables become lists. |
| FR-16 | Shipped | src/format/clean.ts, src/format/footer.ts              | tests/unit/format-corpus.test.ts | prompt-engine.md | None.                                                    |
| FR-17 | Partial | src/format/request.ts, src/prompt/shape.ts             | tests/unit                       | prompt-engine.md | Only a fixed phrase set lifts the length.                |
| FR-18 | Partial | src/format/bubbles.ts, deploy/gateway/brain/bubbles.py | tests/harness                    | prompt-engine.md | Long code or list units can split; excess bubbles drop.  |

## Tools And Commands

| ID    | Status  | Main Code Paths                                                               | Test Paths                                                | TRD Module | Gap                                                                                                  |
| ----- | ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| FR-19 | Shipped | src/tools/registry.ts, src/tools/types.ts                                     | tests/contract                                            | tools.md   | None.                                                                                                |
| FR-20 | Partial | src/tools/registry.ts, src/turn/pipeline.ts                                   | tests/contract                                            | tools.md   | PRD says 4 calls; code runs 3 per chat under a ceiling of 8.                                         |
| FR-21 | Partial | src/tools/commands.ts                                                         | tests/harness                                             | tools.md   | PRD says one leading command; code allows up to 5 anywhere.                                          |
| FR-22 | Shipped | src/tools/commands.ts, src/tools/core/describe.ts                             | tests/harness                                             | tools.md   | Code and PRD answer /report; tools.md names /doc.                                                    |
| FR-23 | Shipped | src/tools/registry.ts                                                         | tests/contract                                            | tools.md   | None.                                                                                                |
| FR-24 | Shipped | src/tools/core/index.ts                                                       | tests/harness                                             | tools.md   | None.                                                                                                |
| FR-39 | Partial | src/media/turn-media.ts, src/media/link-intake.ts, src/media/link-segments.ts | tests/contract/media*.test.ts, tests/replay/media.test.ts | models.md  | An attached video carries no duration, so its length limit is not checked; linked videos are capped. |
| FR-44 | Shipped | src/tools/lessons/index.ts                                                    | tests/harness                                             | tools.md   | None.                                                                                                |
| FR-25 | Partial | src/tools/registry.ts                                                         | tests/contract                                            | tools.md   | Seam built; no server enabled and startup lives elsewhere.                                           |

## Memory

| ID    | Status  | Main Code Paths                                             | Test Paths      | TRD Module | Gap                                                       |
| ----- | ------- | ----------------------------------------------------------- | --------------- | ---------- | --------------------------------------------------------- |
| FR-26 | Partial | src/memory/store.ts, src/storage/migrations/0005_memory.sql | tests/simulator | memory.md  | Schema holds types and keys; write proof sits with FR-27. |
| FR-27 | Shipped | src/memory/worker.ts, src/storage/leases.ts                 | tests/simulator | memory.md  | None.                                                     |
| FR-28 | Shipped | src/memory/worker.ts, src/judge/systemone.ts                | tests/simulator | memory.md  | None.                                                     |
| FR-29 | Shipped | src/memory/store.ts, src/memory/recall.ts                   | tests/simulator | memory.md  | None.                                                     |
| FR-30 | Shipped | src/memory/recall.ts, src/memory/port.ts                    | tests/simulator | memory.md  | None.                                                     |
| FR-31 | Partial | src/migration/memory-import.ts, src/migration/readers.ts    | tests/migration | memory.md  | Backup covers the export folder, not every original file. |

## Owner Site

| ID    | Status  | Main Code Paths                                                                                  | Test Paths                                                                        | TRD Module         | Gap                                                                                                                                                                                                                                  |
| ----- | ------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-40 | Shipped | site/src/dashboard/directory.tsx, site/src/dashboard/chat-defaults.tsx, site/src/pages/chats.tsx | dashboard-chat-access, dashboard-settings, dashboard-state.browser                | site.md            | The owner can inspect inherited sources and clear overrides on the protected dashboard.                                                                                                                                              |
| FR-41 | Shipped | site/src/dashboard/studio-editor.tsx, src/api/studio-packs.ts                                    | dashboard-studio, studio-packs, studio-expression-routes, dashboard-state.browser | site.md            | Catalogue, card and expression editing, prompt preview, simulation and chat selection have synthetic coverage.                                                                                                                       |
| FR-42 | Partial | src/api/writes.ts, src/settings/settings.ts, src/config/status.ts                                | dashboard-settings, studio-packs, dashboard-host-settings, dashboard-config       | dashboard-state.md | Core settings and packs validate, audit and take effect on the next resolution. External host writers support compare/readback where their API lacks atomic conditional writes. Deployment configuration takes effect after restart. |

## Models

| ID    | Status  | Main Code Paths                                                                  | Test Paths                                                               | TRD Module | Gap                                                                             |
| ----- | ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------- |
| FR-32 | Partial | src/models/api-runner.ts, src/models/routed-client.ts                            | tests/harness                                                            | models.md  | Both runners exist; the benchmark-backed default is unrecorded.                 |
| FR-33 | Shipped | src/models/routed-client.ts                                                      | tests/harness                                                            | models.md  | None.                                                                           |
| FR-45 | Shipped | src/turn/pipeline.ts, src/app.ts, src/settings/keys.ts                           | tests/replay/think.test.ts                                               | models.md  | None.                                                                           |
| FR-46 | Shipped | src/media/autofetch.ts, src/gateway/server.ts, deploy/gateway/brain/autofetch.py | tests/contract/autofetch.test.ts, deploy/gateway/tests/test_autofetch.py | system.md  | None.                                                                           |
| FR-47 | Partial | src/tools/core/feedback.ts, src/feedback/sync.ts, src/feedback/store.ts          | tests/contract/feedback.test.ts                                          | tools.md   | The form, Apps Script and secret are not on the host yet (PRD pending input 7). |

## Records And Test Harness

| ID    | Status  | Main Code Paths                                        | Test Paths      | TRD Module | Gap                                                             |
| ----- | ------- | ------------------------------------------------------ | --------------- | ---------- | --------------------------------------------------------------- |
| FR-34 | Shipped | src/records/turn-record.ts                             | tests/contract  | records.md | None.                                                           |
| FR-35 | Partial | src/records/turn-record.ts, src/records/kinds.ts       | tests/contract  | records.md | Job and failure rows exist; not every producer is shown.        |
| FR-36 | Partial | src/records/redact.ts, src/records/logger.ts           | tests/gates     | records.md | IDs and secrets are masked; message text and names are not.     |
| FR-37 | Partial | tests/harness/recordings.ts, tests/harness/scenario.ts | tests/simulator | harness.md | Replay, scenarios and bench exist; simulator proof is partial.  |
| FR-38 | Partial | tests/support/no-live-calls.ts                         | tests/gates     | harness.md | Only the loopback guard is shown; CI gates are not proven here. |
| FR-43 | Shipped | tests/harness/bridge.ts, tests/harness/sim/server.ts   | tests/harness   | harness.md | None.                                                           |

## Non-Functional Requirements

| ID     | Status      | Main Code Paths                                        | Test Paths    | TRD Module       | Gap                                                           |
| ------ | ----------- | ------------------------------------------------------ | ------------- | ---------------- | ------------------------------------------------------------- |
| NFR-1  | Not audited | bench/casual.yml, src/bench/run.ts                     | On demand     | harness.md       | No audited run against the PRD targets.                       |
| NFR-2  | Not audited | src/prompt/builder.ts                                  | tests/gates   | prompt-engine.md | The build throws past the ceiling; no gate run shown.         |
| NFR-3  | Not audited | src/turn/pipeline.ts                                   | tests/harness | system.md        | One loop and one tool list; fallback changes the model only.  |
| NFR-4  | Shipped     | src/storage/database.ts                                | tests/restart | storage.md       | None.                                                         |
| NFR-5  | Not audited | —                                                      | tests/gates   | harness.md       | The privacy scan gates it; fixtures were not verified here.   |
| NFR-6  | Partial     | .github/workflows/ci.yml                               | tests/gates   | deployment.md    | The scan runs gitleaks only; no id or name scan.              |
| NFR-7  | Partial     | scripts/deploy-host.ts, deploy/host/aira-updater.timer | —             | deployment.md    | Merge deploys run; timer values disagree with config.yml.     |
| NFR-8  | Open        | docs/trd/deployment.md                                 | —             | deployment.md    | Shadow and rehearsal dropped; rollback stays one step.        |
| NFR-9  | Not audited | —                                                      | —             | —                | Small modules and current docs; not measured here.            |
| NFR-10 | Not audited | src/models/spend.ts                                    | —             | models.md        | The monthly cap exists; no end-to-end spend proof shown.      |
| NFR-11 | Shipped     | src/storage/recovery.ts, src/storage/leases.ts         | tests/restart | storage.md       | A twice-interrupted research job fails terminally, by design. |
| NFR-12 | Open        | src/storage/snapshot.ts                                | —             | —                | Verified local snapshots only; no off-host copy shown.        |
