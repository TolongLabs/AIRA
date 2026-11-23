# Deployment

How a change becomes a release, how the host updates itself, and how AIRA moves from the old core to the new one in
one night.

## CI

| Job         | Runs                                                                               | Trigger                     |
| ----------- | ---------------------------------------------------------------------------------- | --------------------------- |
| `check`     | Typecheck, lint, format, unit, contract and replay tests                           | Every push and pull request |
| `scan`      | Secret scan of the repository history with gitleaks                                | Every push and pull request |
| `site`      | Site typecheck and build                                                           | Every push and pull request |
| `image`     | Builds the release image. On a push to `main` it pushes it as `sha-<7>` and `edge` | Every push and pull request |
| `images-ok` | Re-reports the image result, so a skipped or failed build still fails the gate     | After `image`, always       |
| `deploy`    | Deploys the pushed image on the host, through the self-hosted runner               | Push to `main` only         |
| `release`   | Version and changelog pull request from commit messages                            | Push to `main`              |
| `promote`   | Tags the image the host runs `vX.Y.Z`, `vX.Y` and `stable`                         | A release commit            |

## Release Image

- Every push to `main` builds one image and publishes it to `ghcr.io/tolonglabs/aira` as `sha-<first 7 of the commit>`
  and `edge`. The package is public, so the host pulls without a token; the job checks an anonymous pull.
- A release re-tags that same image; nothing is rebuilt.
- Multi-stage build, non-root user, one writable data volume. The image holds the core, the built site, the example
  character pack and the prompts. Real character packs are private and live on the data volume.
- A separate stage installs production dependencies from `package.json` and `bun.lock` alone, with the version and
  the `prepare` script taken out of `package.json` first, so a release bump changes nothing it reads. The runtime
  image copies `node_modules` before the application output, so a code-only change or a release reuses that layer
  and a deploy pulls a few MB.
- No secret and no chat data is in the image. Secrets come from the host's `.env`. Data lives on the volume.

## Host Layout

Everything of one install lives in one folder owned by the host user that runs the gateway, `~/aira/` by default.
The container's user has the same uid, so the core writes the data folder and the gateway reads it.

| Item                | Location On The Host                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose file        | `~/aira/compose.yml`, copied from `deploy/compose.yml` at install                                                                                                                                           |
| Secrets             | `~/aira/.env`, mode 600, never in git. Also holds the install's `AIRA_*` compose values                                                                                                                     |
| Configuration       | `~/aira/config.yml`, copied from the repository at install with `gateway.hostDataDir` set, mounted read-only over the image's own                                                                           |
| Data folder         | `~/aira/data/` (`AIRA_DATA_DIR`), bind-mounted at `/data`: the database, files, snapshots, archive and cache. See [Persistence](storage.md#stores)                                                          |
| Data folder path    | `gateway.hostDataDir`: the data folder's absolute path on the host, where the gateway finds stickers, the unavailable line and the wanted-jobs file                                                         |
| Bot's own ids       | `gateway.selfIds`: the bot's own WhatsApp ids, so a mention of the bot is told from a name call                                                                                                             |
| Gateway media       | The gateway's `~/.hermes/cache/` and `~/.hermes/audio_cache/`, mounted read-only at `/gateway/cache` and `/gateway/audio_cache` (`AIRA_GATEWAY_CACHE`, `AIRA_GATEWAY_AUDIO_CACHE`). See [Install](#install) |
| Gateway helpers     | AIRA's `brain.bubbles` and `brain.failure`, from `deploy/gateway/brain/`                                                                                                                                    |
| Schedule reconciler | `deploy/gateway/schedule.py`, run by `aira-schedule.path` as soon as the core rewrites `gateway/schedule.json`, and each minute by `aira-schedule.timer` as a safety net, in the gateway's environment      |
| Off-host copy       | An encrypted repository on another machine                                                                                                                                                                  |
| Core port           | `127.0.0.1:${AIRA_PORT}`, published to loopback only. 9881 after cutover; a spare port beside the old core                                                                                                  |
| Site API port       | `${AIRA_SITE_BIND}:${AIRA_SITE_PORT}`, the private-network address only; loopback beside the old core                                                                                                       |
| Updater units       | `aira-updater.timer` (every 15 minutes, hard-coded in the unit) with `aira-updater.service`, for the release-driven timer path                                                                              |
| Schedule units      | Path, timer and service units; the path unit watches a hard-coded folder (see below)                                                                                                                        |
| Runner service      | Host unit for the subscription transport only (see below)                                                                                                                                                   |

- The schedule path unit watches `%h/aira/data/gateway/schedule.json`, so an install folder other than `~/aira`
  needs the unit edited. `aira-schedule.timer` ticks every minute as a safety net.
- The runner service (`aira-runner.service`) needs `RUNNER_TOKEN` of at least 16 characters (else it exits 1), and
  reads `RUNNER_PORT` (default 9882) and `RUNNER_PROGRAM` (default `claude`, or a JSON array). A run is refused
  with 400 unless `tools.url` is a loopback http URL, `tools.token` is 16 to 128 hex characters, and `timeoutMs` is
  between 1000 and 600000. A timed-out or disconnected run is stopped with SIGTERM, then SIGKILL after 2 s. See
  [Models](models.md#run-request) for the run itself.
- For subscription installs, the release probe requests the configured runner's `GET /health` from inside the
  container and requires `{"ok":true}` within five seconds. API-only installs skip this request.
  The container and the host have separate loopback interfaces. A subscription install must provide a route from
  the core to the runner and a return route from the runner to the configured tool server. The runner health
  check covers only the first direction. The GitHub Actions runner used to deploy is a separate process.

![The host units, what triggers them and what they run](../diagrams/host-units.svg)

## Install

Run by the operator on the host, with each step that changes the host confirmed first.

1. Make `~/aira/` and `~/aira/data/`, mode 700. Copy `deploy/compose.yml` and `config.yml` in. Set
   `gateway.hostDataDir` to the data folder's absolute path.
2. Write `~/aira/.env`, mode 600: the secrets by name from `.env.example`, and `AIRA_PORT`, `AIRA_SITE_BIND`,
   `AIRA_SITE_PORT`, `AIRA_DATA_DIR`, `AIRA_IMAGE` and `AIRA_VERSION`. To let the core read the media members send,
   also set `AIRA_GATEWAY_CACHE` and `AIRA_GATEWAY_AUDIO_CACHE` to the gateway's media folders on the host, and
   `MEDIA_WATCHER_API_KEY` to the media model's key. Compose mounts each folder read-only. A variable left unset mounts
   an empty folder, `./unset`, and the core then refuses every media path.
   In `config.yml`, `media.gatewayDirs` maps each host folder to its mount. The repository's list is empty. The host's
   list is:

   ```yaml
   media:
     gatewayDirs:
       - { host: /home/user/.hermes/cache, container: /gateway/cache }
       - { host: /home/user/.hermes/audio_cache, container: /gateway/audio_cache }
   ```

   `host` is the path the gateway writes in its notes, so it must match that path exactly. `container` must match the
   mount point in `deploy/compose.yml`. See [Models](models.md#media-watching).

3. Get the image: pull the release, or, before the first release, build it from a checkout with
   `docker build -f deploy/Dockerfile -t aira-local:<commit> .` and set `AIRA_IMAGE=aira-local`,
   `AIRA_VERSION=<commit>`.
4. `docker compose --env-file .env up -d`, then poll `GET /health` until ready.
5. Verify the live site and run a marked synthetic turn through the deployed image with isolated storage.
6. Install the updater's units with `AIRA_COMPOSE_FILE` and `AIRA_CORE_URL` pointing at this install. Its timer is
   enabled once a release image exists in the registry.

## Deploy

A GitHub Actions runner on the host, labelled `aira-dev2`, takes the `deploy` job after `check`, `scan` and `image`
pass on a push to `main`. Deploys run one at a time. Like rokabot's, every merge to `main` goes live.

![How one merge to main becomes a running container](../diagrams/release-deploy.svg)

1. If a turn is in flight, wait up to `AIRA_WAIT_FOR_IDLE_MS` (default 120000).
2. Take a verified snapshot of the database. When no image runs yet, this step is skipped.
3. Pull `sha-<7>` under one 20-minute budget across up to 3 attempts. The first attempt gets 3 minutes, so a stalled
   first connection retries quickly; each later attempt gets the time left. When the budget runs out or all 3 attempts
   fail, the deploy fails as `pull_failed` before `.env` is touched. Otherwise
   atomically replace `AIRA_VERSION` and `AIRA_IMAGE` in the install's `.env` (every other line kept; a missing key is
   appended), and recreate the container. Start-up runs migrations inside a transaction.
4. Poll the health endpoint until ready, up to `AIRA_HEALTH_TIMEOUT_MS` (default 60000), and verify the built page, core chat list and
   authenticated owner dashboard. Inside the running container, start an isolated gateway with a temporary database,
   the example pack and a deterministic model. Send a tool-bearing, scope-marked DM fixture over HTTP. Require both
   the expected answer and a delivered turn row. The probe never sends a WhatsApp message.
5. On success: keep the previous image for rollback and remove older ones, append one JSON line (`from`, `to`,
   `outcome`, `reason`) to `deploys.jsonl` in the install folder, then post the result to the host's ntfy. When
   `AIRA_NTFY_URL` is unset no post is made, and the same text also goes to stderr.
6. On failure: start the previous image, append the record, post the failure, and fail the job. No data is
   restored, because a migration keeps the previous release working. See [Persistence](storage.md#migrations).

- **The repository is public.** The runner takes only the `deploy` job, which runs only on a push to `main`. The
  job runs inside the `production` GitHub environment and serialises on the `aira-deploy` concurrency group with
  `cancel-in-progress: false`. Workflows from forks and outside contributors need the owner's approval before they
  run, so no outside pull request can reach the runner.
- The CI runner deploys main-branch SHA images. The user timer follows release tags. They share a host
  `flock` for the full deployment, including rollback. A mutable running tag is pinned to its image ID before
  a pull. With a stopped core, take a fresh verified SQLite backup from the host volume. A failed restore or
  an unhealthy previous version is recorded as `rollback_failed`.

## Shadow Period

Not run. Cutover went ahead without this period and without the staging rehearsal (decision 2026-11-17). NFR-8
still requires a shadow period, so this section stays as the contract for one. Before cutover, the new core runs
beside the old one.

- The new core listens on a second loopback port. The old core keeps port 9881 and keeps answering every chat.
- A tap copies each real gateway request to the new core (**Spike S-5**). The new core runs the full turn, including
  memory writes into its own database, and records it. Its reply is discarded.
- Each day the operator compares the two: latency, failures, tool calls, and a sample of replies side by side.
- Exit conditions: the latency targets in the PRD are met, no unexplained failure remains, and the memory simulator
  and all gates pass on the release to be cut over.

## Cutover

One switch, one night, all chats. Start at 00:00 Malaysia time.

| Step | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Check Before Continuing                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1    | Confirm no turn is in flight. Pause the gateway's scheduled sends                                                                                                                                                                                                                                                                                                                                                                                                                                              | Idle for 2 minutes                                                                      |
| 2    | Stop the old core. Back up its memory stores, the gateway config and the binding file                                                                                                                                                                                                                                                                                                                                                                                                                          | Checksums recorded                                                                      |
| 3    | Run the memory and settings migration: dry run, read the report, then the real run                                                                                                                                                                                                                                                                                                                                                                                                                             | Report reviewed, no unassigned fact imported                                            |
| 4    | Empty the gateway's fallback provider list. Set `WHATSAPP_SCOPE_STAMP=1`, `AIRA_HOST_DATA_DIR` and `skills.creation_nudge_interval: 0`, and confirm `cron.wrap_response: false`. Back up and replace the two gateway helper modules. Install and start `aira-schedule.timer`. Tag the listed gateway jobs with `deploy/gateway/jobs.py --tag`. Run `deploy/gateway/patches.py` on the live tree, `--check` first; the gateway restarts its bridge because `bridge.js` changed. Point port 9881 at the new core | Health endpoint ready. A test turn carries a scope marker. No `gateway_unmarked` record |
| 5    | Send test messages from the operator's own DM and one test group                                                                                                                                                                                                                                                                                                                                                                                                                                               | Replies, sticker, a command, a tool call, a memory note                                 |
| 6    | Resume scheduled sends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | One reminder fires correctly                                                            |
| 7    | Watch the turn records until the first real morning turns succeed                                                                                                                                                                                                                                                                                                                                                                                                                                              | No failure record of an unknown kind                                                    |

## Rollback

Available at any step and for as long as the old stores are kept.

1. Stop the new core.
2. Untag the gateway jobs with `deploy/gateway/jobs.py --untag`. Restore the gateway config, `.env`, job file and helper module backups. This restores the fallback list, turns the scope
   stamp off and gives the old core its own bubble and failure modules back.
3. Start the old core on port 9881.

The migration only reads the old stores, so the old core starts with the memory it had at step 2. Messages handled
by the new core since cutover exist only in the new database; the rollback record lists them.

## Configuration

| Key                   | Default | Effect                                                         |
| --------------------- | ------- | -------------------------------------------------------------- |
| `gateway.hostDataDir` | empty   | The data volume's path on the host. Start-up fails while empty |

### Owner console release checks

A deploy checks the owner-facing site listener, a built page, the core chat schema and the routed owner API.
The synthetic gateway check must exercise the intended turn branch. A previous deployment counts as restored only
when its health checks pass. Preserve host-specific configuration, write credentials atomically with private file
permissions and require a fresh verified snapshot before a version change.

The built updater includes `offline-snapshot.py` beside its JavaScript entry point. When the core is unavailable,
the host runs this helper against the container’s data mount and verifies the backup with SQLite. After a verified
copy, it removes offline snapshots older than 14 days.

The timer skips a `sha-*` installation managed by main-branch CI. A version-tagged installation follows releases.
An unreachable owner console records `owner_console_failed`. An isolated turn failure records `synthetic_turn_failed`.
Install the release timer in the gateway owner’s systemd user manager so its checks use that owner’s site token.

### Dashboard entry recovery

The dashboard preview is available under `/app/preview/` before the entry switch. On an installation that runs
the candidate image, set only `AIRA_DASHBOARD_ENTRY=dashboard` in the deployment environment file and recreate
the existing service from its Compose directory with `docker compose up -d --no-deps --force-recreate aira`.
Removing that setting and recreating the same service restores the classic entry. Keep the installed image
selector, data volume, owner socket and private bind intact. A process restart alone does not reread an env file.

Record the running image ID, service health, private entry responses and snapshot identifier before changing
the entry. Revert the switch on an owner lockout or authorization failure, incorrect state readback, ambiguous
duplicate submission, failed health or cold-link checks, or sustained regression beyond the
[measured limits](dashboard-routes.md#legacy-performance-baseline). Recheck health and the classic routes.
Keep the current database and packs. Open snapshot copies separately to investigate or reconcile a failed write.

On 2026-11-24 the previous image passed an isolated dev2 recovery rehearsal at schema 17. The test used the
bundled example character, image configuration and synthetic chat rows. The verified online SQLite snapshot
contained one pre-snapshot row. Reopening the working database retained both rows, including a later write.
Restoring the copied pack card and configuration reproduced their original bytes. The temporary container
had no network or production mounts. Repeat the rehearsal on the installed candidate before cutover.
