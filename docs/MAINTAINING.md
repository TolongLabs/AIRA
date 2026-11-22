# Maintaining AIRA

How to keep AIRA running, task by task. For new developers and the owner.

- `docs/TRD.md` and its modules own every behavior, limit and default. This guide never restates them.
  Each task links the module that owns its contract.
- `docs/RUNBOOK.md` covers host operations: install, configure, deploy, backups, cutover and rollback.
- `docs/DECISIONS.md` records why each lasting choice was made. Check it before reversing one.
- To change a contract, change the owning TRD module, add a `docs/DECISIONS.md` row, and change
  the code and its tests in the same pull request.

## Gateway

### Add An AIRA Patch For A New Hermes Behavior

When the gateway changes an upstream behavior the core depends on.

1. Append an ordered entry to `patches()` in `deploy/gateway/patches.py`: name, target,
   present and absent markers, anchor edits, syntax and test commands, working directory, and why.
2. Run the patch script with `--check` first, then apply it against the gateway tree.
3. The runner checks every anchor before writing anything, and restores backups if validation fails.

Files: `deploy/gateway/patches.py`.

Check: `python -m pytest deploy/gateway/tests/test_patches.py`.

Contract: [System Architecture](trd/system.md).

### Change Scheduled Jobs After Reminder Or Research Rows Change

When reminders or research deliveries change and the gateway schedule must follow.

1. Let the core rewrite `gateway/schedule.json` from active reminders and undelivered
   completed research rows (`src/gateway/schedule.ts`).
2. Run the host reconciler with the data directory and the Hermes environment.
3. Pass `--check` to report what would change without touching cron jobs.

Files: `src/gateway/schedule.ts`, `deploy/gateway/schedule.py`.

Check: `tests/unit/schedule.test.ts`, `deploy/gateway/tests/test_schedule.py`.

Contract: [System Architecture](trd/system.md).

### Recover A Missing, Invalid, Or Unreadable Schedule File

When the reconciler refuses the schedule file.

1. Read its message: it reports that nothing changed and exits before importing cron jobs.
2. Restore or regenerate a version 1 schedule file.
3. Rerun reconciliation.

Files: `deploy/gateway/schedule.py`.

Check: `deploy/gateway/tests/test_schedule.py`.

Contract: [System Architecture](trd/system.md).

### Tag Or Untag An Owner's Gateway Job For Core Handling

When an owner gateway job must run as a core turn, or stop doing so.

1. Provide `HERMES_HOME`, the Hermes tree, and the listed job ids.
2. Run with `--check` and `--tag` or `--untag` first to preview.
3. Apply through `cron.jobs`.
4. Roll back by restoring the backed-up job file: untagging does not restore removed scope markers.

Files: `deploy/gateway/jobs.py`.

Check: `deploy/gateway/tests/test_jobs.py`.

Contract: [System Architecture](trd/system.md).

### Recover A Missing Or Unreadable Unavailable-Line File

When the gateway must answer while the core is unreachable.

1. Set `AIRA_HOST_DATA_DIR` to the host data volume.
2. Ensure `gateway/unavailable.txt` holds a readable line.
3. If the file stays missing or blank, the helper returns its fixed neutral line.

Files: `deploy/gateway/brain/failure.py`.

Check: `deploy/gateway/tests/test_brain.py`.

Contract: [System Architecture](trd/system.md).

### Install Or Roll Back Autofetch On The Gateway

Use this procedure when installing media delivery for opted-in groups and direct chats.

1. Copy `deploy/gateway/brain/autofetch.py` and `chatflags.py` into `HERMES_HOME/scripts/brain/`, keeping backups.
2. Back up the adapter. Run `patches.py --check`, then apply the patches. `autofetch-from-core` loads
   `brain.autofetch`. `autofetch-dm` offers accepted direct messages to the same module.
3. Restart `hermes-gateway` and verify the bridge reports `connected`. Chat owners can enable Post media per chat.
4. To roll back, restore the adapter and module backups, then restart the gateway.

Files: `deploy/gateway/brain/autofetch.py`, `deploy/gateway/patches.py`, `src/media/autofetch.ts`.

Check: `deploy/gateway/tests/test_autofetch.py`, `tests/contract/autofetch.test.ts`.

Contract: [System Architecture](trd/system.md#autofetch).

## Turn

### Change The Quick-Message Batch Delay Or Its Cap

When replies should wait longer or shorter for follow-up messages.

1. Change `turn.batchMs` in the deployment configuration.
2. Each message resets the timer, within a three-interval cap counted from the first pending message.

Files: `src/turn/pipeline.ts`, `config.yml`, `src/config/schema.ts`.

Check: `tests/replay/pipeline.test.ts`.

Contract: [Reliability](trd/reliability.md).

### Add Or Change A Command That Must Run Alone

When a new slash command must never share a turn with other messages.

1. Ensure the command router matches the intended text.
2. The pipeline marks command-shaped waiters and splits batches at them.
3. Only one direct command bypasses the runner; other commands go through the model with the named tool offered alone.

Files: `src/turn/pipeline.ts`.

Check: `tests/replay/commands.test.ts`, `tests/replay/commands-anywhere.test.ts`.

Contract: [Tools And Commands](trd/tools.md).

### Change The Window History Limit

When turns should see more or less history.

1. Set `records.windowDays` in configuration.
2. Change the injected `maxWindowMessages` dependency if the 40-message default is not wanted.

Files: `src/turn/pipeline.ts`, `src/turn/window.ts`.

Check: `tests/replay/pipeline-records.test.ts`.

Contract: [Records](trd/records.md).

### Change Which Delivery Kinds Mute Or Quiet Hours Suppress

When a kind of message should or should not break silence.

1. Update `mayDeliver` for the delivery kind, including the owner-equals-target reminder case.
2. The pipeline calls it at admission and rechecks scheduled deliveries before returning.

Files: `src/turn/deliver.ts`, `src/turn/pipeline.ts`.

Check: `tests/unit/deliver.test.ts`.

Contract: [Reliability](trd/reliability.md).

### Change Graceful Shutdown Behavior For Pending Turns

When deploys or restarts should wait longer or shorter for turns in flight.

1. App close marks the service unready and calls `turns.drain` with `shutdown.graceMs` (`src/app.ts`).
2. Drain starts pending queues at once and waits for current turns or the grace timeout.
3. Shutdown then closes servers and storage.

Files: `src/app.ts`, `src/turn/pipeline.ts`.

Check: `tests/restart/restart.test.ts`.

Contract: [Reliability](trd/reliability.md).

## Prompt

### Add Or Change A Character Mood

When a character pack needs a new mood or a mood needs new lines.

1. Edit `moods.yml` with a valid mood key, patterns, tone, openers, endings, faces and sticker names.
2. Add any referenced face groups and beat definitions to `moods.yml`.
3. Ensure every referenced sticker exists under `stickers/` and passes WebP validation.
4. Keep the default mood key present in the mood map.

Files: `src/character/schema.ts`, `src/character/loader.ts`, the pack's `moods.yml`.

Check: `bun test src/character`.

Contract: [Prompt Engine](trd/prompt-engine.md).

### Add A Sticker To A Pack

When a mood needs a new expression image.

1. Use a lowercase `.webp` filename matching `STICKER_FILE`.
2. Put the file under the pack's `stickers/` directory.
3. Reference the filename in the mood's `stickers` array.
4. Supply a valid 512 by 512 WebP within the still (100,000 bytes) or animated (500,000 bytes) limit.

Files: `src/character/schema.ts`, `src/character/loader.ts`, `src/character/webp.ts`.

Check: `bun test src/character`.

Contract: [Prompt Engine](trd/prompt-engine.md).

### Add A Reply Tool Footer Label

When a tool needs its own footer label.

1. Add a valid tool-name key and label to the pack card's `toolFooter.labels`.
2. Or add a plain default to `DEFAULT_TOOL_LABELS`.
3. The footer uses only the successful tool names passed in, and de-duplicates them.

Files: `src/character/schema.ts`, `src/format/footer.ts`.

Check: `bun test src/format`.

Contract: [Prompt Engine](trd/prompt-engine.md).

### Change Reply Length Behavior

When replies should run shorter or longer.

1. Change `LENGTH_CHARS` for the short, default or long code limit.
2. Check `drawShape` uses that limit unless a bypass removes it.
3. Check the cleaner: a command list lifts the limit, research tools raise it to at least long,
   and an explicit format request skips enforcement.

Files: `src/prompt/shape.ts`, `src/format/clean.ts`.

Check: `bun test src/prompt src/format`.

Contract: [Prompt Engine](trd/prompt-engine.md).

## Tools

### Add A New Tool

When a chat needs a capability no tool provides.

1. Create a factory returning a `ToolDefinition` in the matching subdir file.
2. Register it in that subdir's register function.
3. Keep the name lowercase and the schema a strict object without action keys.
4. Set mode, command and feature.
5. Commit once for state changes, so the receipt is stored with the result.

Files: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/core/index.ts`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Change A Command Word Or Its /help Text

When a slash word or its help line is wrong.

1. Edit the tool command names and usage string.
2. Keep names unique: the registry rejects duplicates at start-up.
3. Update the plain-words `HELP_TEXT` entry so `/help` stays consistent.

Planned rename: `make_report` becomes `/doc` (`docs/DECISIONS.md`, 2026-11-17).
**Not built yet:** the command is still `report` (`src/tools/core/report.ts:21`).

Files: `src/tools/core/report.ts`, `src/tools/registry.ts`, `src/tools/core/describe.ts`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Change A Tool Timeout

When a tool call needs more or less time.

1. Set `timeoutMs` on the tool definition for a per-tool override.
2. Otherwise the call uses `tools.defaultTimeoutMs` from the registry config.
3. External tools use the per-server `timeoutMs`.

Files: `src/tools/registry.ts`, `config.yml`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Recover From A Failed Schedule-File Rewrite

When the schedule sync warning fires.

1. Find the `reminder_schedule_sync_failed` warning with the turn and reminder ids.
2. The reminder row is already committed, so nothing is lost.
3. The file is rewritten on the next reminder change (the code also notes start-up reconciliation).

Files: `src/tools/core/reminders.ts`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Switch Tools On Or Off For One Chat

When a chat should gain or lose a capability.

1. Flip the matching `features.*` setting for the chat.
2. The registry drops disabled tools before the model sees them.
3. For MCP tools, also list the chat in the server chats allowlist and switch on `mcp.<server id>`.

Built-in defaults are on for memory, reminders, search, social, photos, media, research, reports
and the tool footer; off for proactive, voice, lessons and owner (`src/settings/keys.ts`).

Files: `src/tools/registry.ts`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Add An External MCP Server

When tools must come from an outside server.

1. Add the server id, transport, command, tool allowlist, chat list and `timeoutMs` in configuration.
2. Its tools register as `<server id>.<tool>` and reach the model with dots as double underscores.
3. Gate chats with the chats list and the `mcp.<server id>` setting.

Files: `src/tools/registry.ts`, `config.yml`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

### Diagnose A Refused Or Invalid Tool Call

When a tool call fails before or during its run.

1. Match the refusal reason against the mode, feature and permission checks.
2. Read the per-field schema message for invalid arguments.
3. Only timeout, error and refused outcomes write failure rows.

Files: `src/tools/registry.ts`.

Check: `bun test src/tools`.

Contract: [Tools And Commands](trd/tools.md).

## Memory

### Add A New Legacy Memory Source Format

When the old core kept memory in a format no reader covers.

1. Add a reader in `src/migration/readers.ts` that converts the copied source into `LegacyRecord` entries.
2. Write its records to an NDJSON export file, and route malformed source lines to the private reject output.
3. Import through `readLegacyExport` and `importRecords`, so mapping, validation, transaction
   and report behavior stay shared.

Files: `src/migration/readers.ts`, `src/migration/legacy.ts`, `src/migration/memory-import.ts`.

Check: `tests/contract/memory-readers.test.ts`, `tests/contract/memory-migration.test.ts`.

Contract: [Memory](trd/memory.md).

### Change Episode Close Thresholds

When episodes should close sooner or later.

1. Change `memory.episodeIdleMs` or `memory.episodeMaxMessages` in the deployment configuration.
2. The worker passes both values to `closeDueEpisodes`, which closes a chat episode
   when idle time or message count is due.

Files: `src/memory/worker.ts`, `src/memory/episodes.ts`.

Check: `tests/simulator/memory.test.ts`.

Contract: [Memory](trd/memory.md).

### Recover A Memory Job That Has Failed Permanently

When memory work stops with a failed job.

1. Inspect the `memory_job` row and its reason-code `memory_event` and failure record.
2. The job stays failed once the retry schedule (1, 5, 20, 60 minutes) is exhausted.
3. Correct the underlying cause before restoring or requeueing it through the job lease mechanism.

Files: `src/memory/worker.ts`, `src/storage/leases.ts`.

Check: `tests/replay/job-failures.test.ts`.

Contract: [Memory](trd/memory.md).

### Perform A Confirmed Legacy Memory Import

When old memory must move into the new store.

1. Run a dry run into the scratch database and review `report.json` and `report.txt`.
2. Keep the source export unchanged, then rerun with confirmation from the same output folder.
3. The input digest must match the reviewed report, or the run throws.
4. Review `import-report.json` and `import-report.txt` after the transaction.

Files: `src/migration/memory-import.ts`.

Check: `tests/contract/memory-migration.test.ts`.

Contract: [Memory](trd/memory.md#migration).

### Map A Newly Encountered Old Chat Setting

When the old settings hold a value no mapping covers.

1. Add or change the source mapping in `planSettingsMigration`.
2. Validate the proposed key and value through `definitionFor` before adding it to the plan.
3. Apply the plan transactionally; existing setting values are retained.

Files: `src/migration/settings-import.ts`.

Check: `tests/contract/settings-migration.test.ts`.

Contract: [Memory](trd/memory.md).

## Models

### Add A Provider Client

When a new model provider must serve a role.

1. Implement the `ModelClient` call and the request and response mapping.
2. Map provider failures to `ModelError` kinds, and return usage, cost, model id and any replay state.
3. Ensure the runner routes calls through `createRoutedClient`, so retry, fallback and records still apply.

Files: `src/models/types.ts`, `src/models/openai-client.ts`, `src/models/routed-client.ts`.

Check: `tests/contract/models.test.ts`, `tests/contract/providers.test.ts`.

Contract: [Models](trd/models.md).

### Change Retry, Breaker, Or Spend Behavior

When failures or spend need different handling.

1. Adjust retry classification and delay rules in `callTarget`.
2. Adjust breaker expiry in `createBreaker`.
3. Adjust counted-spend aggregation or threshold behavior in `spendState`, and check the routed client gate.

Files: `src/models/routed-client.ts`, `src/models/breaker.ts`, `src/models/spend.ts`.

Check: `tests/contract/models.test.ts`.

Contract: [Models](trd/models.md).

### Change Social Readers Or Restore Them Without yt-dlp

When a platform needs a new reader, or social extraction breaks because yt-dlp is missing.

1. Add host and URL normalization in `parseSocialPostUrl`.
2. Implement and dispatch the fetch path in `SocialPostViewer.lookupUncached`.
3. Add the parser mapping to `SocialPost`, and update URL and media selection where the platform exposes video.
4. Without yt-dlp, check `isYtDlpAvailable` for the configured binary path and set the availability
   state on both `SocialPostViewer` and `ReplyReader`.
5. The unavailable path returns `binary_missing`, or the platform's working fallback path.

Files: `src/social/urls.ts`, `src/social/viewer.ts`, `src/social/parsers.ts`,
`src/social/yt-dlp.ts`, `src/social/replies/service.ts`.

Check: `tests/contract/social-urls.test.ts`, `tests/contract/social-service.test.ts`.

Contract: [Models](trd/models.md).

## Data

### Add A Database Schema Migration

When the store needs a new table or column.

1. Add the next zero-padded `NNNN_name.sql` file, with no numbering gap.
2. Keep prior migration files unchanged: applied checksums are verified.
3. Use add-first changes, so the previous release still runs on the new schema.

Files: `src/storage/migrate.ts`, `src/storage/migrations/`.

Check: `tests/migration/migration.test.ts`.

Contract: [Persistence](trd/storage.md).

### Add Or Change A Chat Setting

When chats need a new knob, or a knob needs a new control on the site.

1. Add the key with its schema and built-in default to `SETTING_KEYS`,
   or extend `definitionFor` for a dynamic key family such as `mcp.<id>`.
2. Keep the value JSON-compatible.
3. Unknown keys are rejected; the Setting Keys table in `docs/trd/data.md` is the contract.
4. Add a `SettingRow` with a control on the Chats page, or add the key to the `FEATURES`
   list if it is a feature switch.
5. Add the row to the Setting Keys table in `docs/trd/data.md`.

Files: `src/settings/keys.ts`, `src/settings/settings.ts`, `site/src/pages/chats.tsx`, `docs/trd/data.md`.

Check: `tests/contract/settings.test.ts`, `tests/contract/site-api.test.ts`.

Contract: [Data And Settings](trd/data.md).

### Add A Job Table To Lease And Recover

When a new background worker needs crash-safe jobs.

1. Create the table with the lease columns and state values the helpers expect.
2. Add the table name to `JOB_TABLES`, so start-up releases its leases.
3. Use the matching job-specific lease state, and account for any terminal retry rule.
4. Note that `research_job` uses `running` instead of `leased`, with matching helper branches;
   a new table following the `memory_job` convention needs no helper changes.

Files: `src/storage/leases.ts`, `src/storage/recovery.ts`.

Check: `tests/contract/persistence.test.ts`, `tests/restart/restart.test.ts`.

Contract: [Persistence](trd/storage.md).

## Records

### Add A Benchmark Set

When the harness needs a new scripted conversation.

1. Create a YAML file with a non-empty name and description.
2. Add 1 to 50 non-empty prompt strings; `loadBenchSet` validates the shape.
3. Run the set through `openChatSession` and `runBench`, then pass the result to `writeBenchResult`.

Files: `src/bench/run.ts`, `src/bench/chat.ts`.

Check: `bun run test` (no dedicated bench test exists).

Contract: [Test Harness](trd/harness.md).

### Change Record Retention Windows

When records should live longer or shorter.

1. Supply `retentionDays`, `diagnosticsHours` and `windowDays` through `RetentionConfig`.
2. Call `pruneRecords`, with a `beforeDelete` callback if rows need export before deletion.
3. Read the returned counts and `jobRunId` from the retention result.

Files: `src/records/retention.ts`.

Check: `bun run test` (no dedicated retention test exists).

Contract: [Records](trd/records.md).

### Add Or Adjust Accepted PDF-Offer Answers

When members phrase yes or no in a way the offer misses.

1. Edit `ACCEPT_WORDS` or `DECLINE_WORDS`.
2. Keep acceptance matching whole-message after trimming and lowercasing; `/pdf` is a separate accept form.
3. `offerAnswer` returns undefined for messages that match neither list.

Files: `src/research/offer.ts`.

Check: `bun run test` (no dedicated offer test exists).

Contract: [Research And Reports](trd/research.md).

### Recover Research Work After A Worker Interruption

When research rows stay running past their lease.

1. Let the row lease expire; the tick checks for expired running rows and asks `leaseNextJob` for the next row.
2. The worker marks an error as failed with no retry delays, records an internal research failure,
   and synchronizes the schedule.
3. Inspect the returned tick state: idle, done, failed or lost.

Files: `src/research/worker.ts`.

Check: `bun run test` (no dedicated research worker test exists).

Contract: [Research And Reports](trd/research.md).

### Change A Report Profile Field

When rendered reports need a new look or option.

1. Update the profile schema and its default in `reportFormatSchema`.
2. Update `report.typ` where that field is rendered.
3. Research offer preparation parses the requester chat's `report.format` setting before calling the renderer.

Files: `src/render/types.ts`, `src/render/templates/report.typ`, `src/research/offer.ts`.

Check: `bun run test` (no dedicated render test exists).

Contract: [Research And Reports](trd/research.md).

## Site

### Add A Site API Route

When the owner site needs new data or a new write.

1. Write the handler in `src/api/` next to the matching existing handler, returning `ok(...)` or `error(status, code)`.
2. For a read, add the path to `STATIC_ROUTES` (or a regex like `TURN_BY_ID` if the path carries an id),
   and add the branch in `dispatchGet` before the 404 fallthrough.
3. For a write, add a body schema and handler following `writeSetting`, register the path in `isWriteRoute`,
   and dispatch it in `dispatchWrite` with a method check.
4. Write through a settings or chats function that runs one `storage.tx`, so the change and its
   `setting_change` row commit together.
5. Call `deps.onWrite?.()` only when something changed, so the gateway files are rewritten only on a real change.
6. Add the client method to the `core` object in `site/src/lib/core.ts` with a plain-words `reasonText` entry.
7. Add the route row to the Core API table in `docs/trd/site.md`.

The site tables also list character and memory routes with no code behind them yet
(`GET` and `PUT /api/characters/:id`, the sticker and preview posts, `POST /api/memory/:id/forget`).
Check before copying that pattern.

Files: `src/api/routes.ts`, `src/api/writes.ts`, `src/settings/settings.ts`,
`site/src/lib/core.ts`, `docs/trd/site.md`.

Check: `tests/contract/site-api.test.ts`.

Contract: [Owner Site](trd/site.md).

### Change Site Server Settings

When the token, port, address or allowed origins must change.

1. Set `SITE_TOKEN` to at least 32 characters in the install's `.env`, and restart the core
   (or deploy, which restarts it). The browser re-asks once on the next 401 and stores the new value.
2. Set `site.port` in the host's `config.yml`; the listener uses it. Set `AIRA_SITE_BIND` and
   `AIRA_SITE_PORT` in the install's `.env`; that is what compose publishes. The container port
   in the mapping is fixed, so it must equal `site.port`.
3. Add the origin to `site.allowedOrigins` in the host's `config.yml`. A write with no `Origin`
   header is unaffected; a write from any other origin gets 403.

Files: `src/app.ts`, `src/index.ts`, `src/api/writes.ts`, `src/api/server.ts`,
`deploy/compose.yml`, `config.yml`.

Check: `tests/contract/site-api.test.ts`.

Contract: [Owner Site](trd/site.md).

### Add A Page To The Owner Site

When the site needs a new page.

1. Add a source entry under `site/src/entries/` and register it in the `rollupOptions.input` map.
2. Add the `.html` file at the site root: the build is multi-page, not a single-page app.
3. Add the nav item to the `NAV` array and to the scope table in `docs/trd/site.md`.
4. `DESIGN.md` wins for anything visual; a new page needs a design pass first.

Files: `site/vite.config.ts`, `site/src/components/shell.tsx`, `docs/trd/site.md`.

Check: the `site` CI job (`bun run build`).

Contract: [Owner Site](trd/site.md).

## Deployment

### Change Deploy Timing

When the host should wait longer for turns or health, or check releases more or less often.

1. Set `AIRA_WAIT_FOR_IDLE_MS` or `AIRA_HEALTH_TIMEOUT_MS` in the environment the deploy runs in.
   The `config.yml` keys `deploy.waitForIdleMs` and `deploy.healthTimeoutMs` are never read.
2. For the CI deploy, add the value to the env block of the deploy step in `.github/workflows/ci.yml`.
3. For the timer path, add it to the `EnvironmentFile` named in `deploy/host/aira-updater.service`.
4. Edit `OnUnitActiveSec` in `deploy/host/aira-updater.timer` to change how often the host looks
   for a release; `deploy.checkEveryMin` in `config.yml` has no effect.
5. Reload the unit on the host after editing.

Files: `scripts/deploy-host.ts`, `scripts/updater/main.ts`,
`.github/workflows/ci.yml`, `deploy/host/aira-updater.service`, `deploy/host/aira-updater.timer`.

Check: `tests/unit/updater.test.ts`.

Contract: [Deployment](trd/deployment.md).

### Recover From A Failed Or Half-Finished Deploy

When a deploy leaves the host in doubt.

1. Read the append-only record file: `deploys.jsonl` in the install folder for the CI deploy,
   or `/var/lib/aira/deploys.jsonl` for the timer path.
2. Check the outcome field: `failed_before_start` means nothing was started; `rolled_back` means
   a start, health or synthetic turn check failed and the previous image was restarted.
3. If the rollback itself failed, the alert says the service is down. Start the previous image
   by hand with `docker compose up -d` and `AIRA_VERSION` set to it.

Files: `scripts/deploy-host.ts`, `scripts/updater/ops.ts`, `scripts/updater/main.ts`.

Check: `tests/unit/updater.test.ts`.

Contract: [Deployment](trd/deployment.md).

## Configuration Index

Every key the audits found: its kind, its default, and the TRD module that owns it.
"Undocumented" means no TRD module documents it. Few words here; the owning module says the rest.

| Key                                                                                  | Kind         | Default                                   | Owns It                                 |
| ------------------------------------------------------------------------------------ | ------------ | ----------------------------------------- | --------------------------------------- |
| `turn.batchMs`                                                                       | config.yml   | 1500                                      | [Reliability](trd/reliability.md)       |
| `llm.turnDeadlineMs`                                                                 | config.yml   | 45000                                     | [Reliability](trd/reliability.md)       |
| `alerts.minGapMs`                                                                    | config.yml   | 900000                                    | [Reliability](trd/reliability.md)       |
| `shutdown.graceMs`                                                                   | config.yml   | 20000                                     | [Reliability](trd/reliability.md)       |
| `prompt.maxSystemTokens`                                                             | config.yml   | 8000                                      | [Prompt Engine](trd/prompt-engine.md)   |
| `judge.mood`                                                                         | config.yml   | on                                        | [Prompt Engine](trd/prompt-engine.md)   |
| `judge.moodMinProbability`                                                           | config.yml   | 0.3                                       | [Prompt Engine](trd/prompt-engine.md)   |
| `judge.timeoutMs`                                                                    | config.yml   | not stated                                | undocumented                            |
| `format.timeZone`                                                                    | config.yml   | Asia/Kuala_Lumpur                         | [Prompt Engine](trd/prompt-engine.md)   |
| `format.bubbleMaxChars`                                                              | config.yml   | 3800                                      | [Prompt Engine](trd/prompt-engine.md)   |
| `format.maxBubbles`                                                                  | config.yml   | 1                                         | [Prompt Engine](trd/prompt-engine.md)   |
| `format.leakCheck`                                                                   | config.yml   | on                                        | [Prompt Engine](trd/prompt-engine.md)   |
| `tools.defaultTimeoutMs`                                                             | config.yml   | 15000                                     | [Tools And Commands](trd/tools.md)      |
| `tools.maxCallsPerTurn`                                                              | config.yml   | ceiling 8                                 | undocumented                            |
| `tools.timeBudgetMs`                                                                 | config.yml   | set in config                             | [System Architecture](trd/system.md)    |
| `search.provider`                                                                    | config.yml   | set in config                             | [System Architecture](trd/system.md)    |
| `social.*`                                                                           | config.yml   | set in config                             | [System Architecture](trd/system.md)    |
| `owner.timeoutMs`                                                                    | config.yml   | unset; port falls back 10000              | [Tools And Commands](trd/tools.md)      |
| `owner.marketsConfig`                                                                | config.yml   | empty; watch tools stay off               | [Tools And Commands](trd/tools.md)      |
| `owner.claudeProjectsDir`                                                            | config.yml   | empty; session tools stay off             | [Tools And Commands](trd/tools.md)      |
| `owner.noticeRoutesFile`                                                             | config.yml   | empty; notice tools stay off              | [Tools And Commands](trd/tools.md)      |
| `memory.episodeIdleMs`                                                               | config.yml   | 180000                                    | [Memory](trd/memory.md)                 |
| `memory.episodeMaxMessages`                                                          | config.yml   | 25                                        | [Memory](trd/memory.md)                 |
| `judge.memoryAdmit`                                                                  | config.yml   | 0.5                                       | [Memory](trd/memory.md)                 |
| `judge.memoryVerify`                                                                 | config.yml   | 0.5                                       | [Memory](trd/memory.md)                 |
| `judge.model`                                                                        | config.yml   | empty; memory admits nothing              | undocumented                            |
| `llm.transport`                                                                      | config.yml   | api                                       | [Models](trd/models.md)                 |
| `llm.maxRetries`                                                                     | config.yml   | 2                                         | [Models](trd/models.md)                 |
| `llm.breakerMs`                                                                      | config.yml   | 600000                                    | [Models](trd/models.md)                 |
| `llm.monthlyBudgetUsd`                                                               | config.yml   | 50                                        | [Models](trd/models.md)                 |
| `llm.<role>.provider`                                                                | config.yml   | set per role                              | [Models](trd/models.md)                 |
| `llm.<role>.model`                                                                   | config.yml   | set per role                              | [Models](trd/models.md)                 |
| `llm.<role>.baseUrl`                                                                 | config.yml   | set per role                              | [Models](trd/models.md)                 |
| `llm.<role>.effort`                                                                  | config.yml   | medium main, high fallback                | [Models](trd/models.md)                 |
| `llm.<role>.usdPerMTokIn, usdPerMTokOut, usdPerMTokCached`                           | config.yml   | set in config                             | [Models](trd/models.md)                 |
| `llm.subscription.runnerUrl`                                                         | config.yml   | `http://127.0.0.1:9882`                   | [Models](trd/models.md)                 |
| `llm.subscription.toolServerPort`, `llm.subscription.toolServerUrl`                  | config.yml   | 9883                                      | [Models](trd/models.md)                 |
| `media.watcher.model`                                                                | config.yml   | gemini-3.5-flash-lite                     | [Models](trd/models.md)                 |
| `media.gatewayDirs`                                                                  | config.yml   | empty                                     | [Models](trd/models.md)                 |
| `media.timeoutMs`                                                                    | config.yml   | 30000                                     | [Models](trd/models.md)                 |
| `media.maxVideoSeconds`                                                              | config.yml   | 180                                       | [Models](trd/models.md)                 |
| `media.maxLinkVideoSeconds`                                                          | config.yml   | 600                                       | [Models](trd/models.md)                 |
| `media.maxBytes`                                                                     | config.yml   | 20000000                                  | undocumented                            |
| `media.maxAudioSeconds`                                                              | config.yml   | 600                                       | undocumented                            |
| `SocialPostSettings.timeoutMs, maxTextChars, cacheTtlMs, maxCacheEntries, ytDlpPath` | config.yml   | required; no defaults                     | undocumented                            |
| `ReplyReaderSettings.maxReplies, maxReplyChars`                                      | config.yml   | required; `maxReplies` clamps 1 to 50     | undocumented                            |
| `gateway.selfIds`, `gateway.jobs`                                                    | config.yml   | empty; no ids or jobs                     | [System Architecture](trd/system.md)    |
| `storage.path`                                                                       | config.yml   | `/data`                                   | [Persistence](trd/storage.md)           |
| `storage.minFreeMb`, `storage.criticalFreeMb`, `storage.checkEveryMin`               | config.yml   | 2048, 512, 5                              | [Persistence](trd/storage.md)           |
| `storage.cacheMaxMb`                                                                 | config.yml   | 512                                       | [Persistence](trd/storage.md)           |
| `backup.everyMin`, `backup.keepDays`, `backup.offsite`                               | config.yml   | 15, 14, off                               | [Persistence](trd/storage.md)           |
| `archive.enabled`                                                                    | config.yml   | on                                        | [Persistence](trd/storage.md)           |
| `records.retentionDays`                                                              | config.yml   | 90                                        | [Records](trd/records.md)               |
| `records.diagnosticsHours`                                                           | config.yml   | 72                                        | [Records](trd/records.md)               |
| `records.windowDays`                                                                 | config.yml   | 7                                         | [Records](trd/records.md)               |
| `log.level`                                                                          | config.yml   | info                                      | [Records](trd/records.md)               |
| `research.maxSearches`                                                               | config.yml   | 6                                         | [Research And Reports](trd/research.md) |
| `research.maxPages`                                                                  | config.yml   | 8                                         | [Research And Reports](trd/research.md) |
| `research.deadlineMs`                                                                | config.yml   | 120000                                    | [Research And Reports](trd/research.md) |
| `research.offerMinutes`                                                              | config.yml   | 30                                        | [Research And Reports](trd/research.md) |
| `render.report.pageSize`                                                             | config.yml   | A4                                        | [Research And Reports](trd/research.md) |
| `render.report.accent`                                                               | config.yml   | `#2f6fde`                                 | [Research And Reports](trd/research.md) |
| `render.report.fontSize`                                                             | config.yml   | 10.5                                      | [Research And Reports](trd/research.md) |
| `render.report.cover`                                                                | config.yml   | true                                      | [Research And Reports](trd/research.md) |
| `render.report.sourcesAppendix`                                                      | config.yml   | true                                      | [Research And Reports](trd/research.md) |
| `render.report.header`                                                               | config.yml   | empty string                              | [Research And Reports](trd/research.md) |
| `render.timeoutMs`                                                                   | config.yml   | 20000                                     | [Research And Reports](trd/research.md) |
| `site.port`                                                                          | config.yml   | 9890                                      | [Owner Site](trd/site.md)               |
| `site.allowedOrigins`                                                                | config.yml   | empty list                                | [Owner Site](trd/site.md)               |
| `deploy.checkEveryMin`                                                               | config.yml   | 15; unread, timer rules                   | [Deployment](trd/deployment.md)         |
| `deploy.waitForIdleMs`                                                               | config.yml   | 120000; unread, env rules                 | [Deployment](trd/deployment.md)         |
| `deploy.healthTimeoutMs`                                                             | config.yml   | 60000; unread, env rules                  | [Deployment](trd/deployment.md)         |
| `gateway.hostDataDir`                                                                | config.yml   | empty; start-up fails                     | [Deployment](trd/deployment.md)         |
| `character`                                                                          | chat setting | unset; set at install                     | [Data And Settings](trd/data.md)        |
| `language`                                                                           | chat setting | auto                                      | [Data And Settings](trd/data.md)        |
| `freeResponse`                                                                       | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `allowedSenders`                                                                     | chat setting | all                                       | [Data And Settings](trd/data.md)        |
| `model`                                                                              | chat setting | inherit                                   | [Data And Settings](trd/data.md)        |
| `replyLength`                                                                        | chat setting | default                                   | [Data And Settings](trd/data.md)        |
| `expressions`                                                                        | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `quietHours`                                                                         | chat setting | unset                                     | [Data And Settings](trd/data.md)        |
| `muted`                                                                              | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `features.proactive`                                                                 | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `features.memory`                                                                    | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.reminders`                                                                 | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.search`                                                                    | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.social`                                                                    | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.photos`                                                                    | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.media`                                                                     | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.voice`                                                                     | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `features.lessons`                                                                   | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `features.research`                                                                  | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.reports`                                                                   | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.toolFooter`                                                                | chat setting | true                                      | [Data And Settings](trd/data.md)        |
| `features.owner`                                                                     | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `report.format`                                                                      | chat setting | unset; renderer defaults                  | [Data And Settings](trd/data.md)        |
| `nameCall`                                                                           | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `nameCall.names`                                                                     | chat setting | card names and aliases                    | [Data And Settings](trd/data.md)        |
| `reactions`                                                                          | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `reactions.chance`                                                                   | chat setting | 33                                        | [Data And Settings](trd/data.md)        |
| `commands.maxPerMessage`                                                             | chat setting | 1; at most 5                              | [Data And Settings](trd/data.md)        |
| `tools.maxPerMessage`                                                                | chat setting | 3                                         | [Data And Settings](trd/data.md)        |
| `footerEmoji`                                                                        | chat setting | card icon when unset                      | [Data And Settings](trd/data.md)        |
| `mcp.<server id>`                                                                    | chat setting | false                                     | [Data And Settings](trd/data.md)        |
| `AIRA_HOST_DATA_DIR`                                                                 | env          | unset; readers empty, schedule needs path | [System Architecture](trd/system.md)    |
| `HERMES_HOME`                                                                        | env          | unset; schedule and tagger refuse         | [System Architecture](trd/system.md)    |
| `AIRA_REACTION_CHANCE`                                                               | env          | 0.33 fallback                             | [System Architecture](trd/system.md)    |
| `AIRA_REACTION_COOLDOWN`                                                             | env          | 180 seconds                               | undocumented                            |
| `AIRA_REACTIONS`                                                                     | env          | on unless 0, off, no or false             | undocumented                            |
| `AIRA_BRIDGE_PORT`                                                                   | env          | 3000                                      | undocumented                            |
| `AIRA_EDIT_MIN`                                                                      | env          | 2.5 seconds                               | undocumented                            |
| `AIRA_EDIT_MAX`                                                                      | env          | 3.0 seconds                               | undocumented                            |
| `LLM_API_KEY`, `LLM_FALLBACK_API_KEY`                                                | env          | unset; API role off                       | [System Architecture](trd/system.md)    |
| `RUNNER_TOKEN`                                                                       | env          | unset; subscription needs it              | [Models](trd/models.md)                 |
| `TYPESAFE_API_KEY`                                                                   | env          | unset; judge off                          | [System Architecture](trd/system.md)    |
| `EXA_API_KEY`                                                                        | env          | unset; search off                         | [System Architecture](trd/system.md)    |
| `MEDIA_WATCHER_API_KEY`                                                              | env          | unset; media watcher off                  | [Models](trd/models.md)                 |
| `YOUTUBE_API_KEY`                                                                    | env          | unset; replies not configured             | undocumented                            |
| `PATH`                                                                               | env          | empty string when unset                   | undocumented                            |
| `process.env.*`                                                                      | env          | under 6 chars skipped for masking         | [Records](trd/records.md)               |
| `SITE_TOKEN`                                                                         | env          | none; API needs 32 chars                  | [Owner Site](trd/site.md)               |
| `AIRA_SITE_BIND`                                                                     | env          | `127.0.0.1`                               | [Deployment](trd/deployment.md)         |
| `AIRA_SITE_PORT`                                                                     | env          | 9890                                      | [Deployment](trd/deployment.md)         |
| `AIRA_PORT`                                                                          | env          | 9881                                      | [Deployment](trd/deployment.md)         |
| `AIRA_DATA_DIR`                                                                      | env          | `./data`                                  | [Deployment](trd/deployment.md)         |
| `AIRA_IMAGE`                                                                         | env          | `ghcr.io/tolonglabs/aira`                 | [Deployment](trd/deployment.md)         |
| `AIRA_VERSION`                                                                       | env          | stable                                    | [Deployment](trd/deployment.md)         |
| `AIRA_CORE_URL`                                                                      | env          | `http://127.0.0.1:9881`                   | [Deployment](trd/deployment.md)         |
| `AIRA_COMPOSE_FILE`                                                                  | env          | none; updater exits 2                     | [Deployment](trd/deployment.md)         |
| `AIRA_NTFY_URL`                                                                      | env          | unset; no post                            | undocumented                            |
| `AIRA_WAIT_FOR_IDLE_MS`                                                              | env          | 120000                                    | undocumented                            |
| `AIRA_HEALTH_TIMEOUT_MS`                                                             | env          | 60000                                     | undocumented                            |
| `AIRA_REPOSITORY`                                                                    | env          | `TolongLabs/AIRA`                         | undocumented                            |
| `AIRA_DEPLOY_LOG`                                                                    | env          | install or `/var/lib/aira` path           | undocumented                            |
| `RUNNER_PORT`                                                                        | env          | 9882                                      | undocumented                            |
| `RUNNER_PROGRAM`                                                                     | env          | `claude`                                  | undocumented                            |
