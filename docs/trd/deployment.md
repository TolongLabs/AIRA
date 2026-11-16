# Deployment

How a change becomes a release, how the host updates itself, and how AIRA moves from the old core to the new one in
one night.

## CI

| Job       | Runs                                                            | Trigger                     |
| --------- | --------------------------------------------------------------- | --------------------------- |
| `check`   | Typecheck, lint, format, unit and contract tests                | Every push and pull request |
| `harness` | Replay scenarios and the memory simulator, with zero live calls | Every push and pull request |
| `scan`    | Secret scan and the privacy scan for ids, numbers and names     | Every push and pull request |
| `site`    | Site typecheck and build                                        | Every push and pull request |
| `release` | Version and changelog pull request from commit messages         | Push to `main`              |
| `image`   | Build and publish the container image                           | A release tag               |

## Release Image

- A release tag builds one image and publishes it to the repository's container registry with the version tag and
  a moving `stable` tag.
- Multi-stage build, non-root user, read-only root file system, one writable data volume.
- The image holds the core, the built site, the example character pack and the prompts. Real character packs are
  private and live on the data volume.
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
| `gateway.selfIds`   | empty                                                                                                                                                                                                       | The bot's own WhatsApp ids, so a mention of the bot is told from a name call |
| Gateway media       | The gateway's `~/.hermes/cache/` and `~/.hermes/audio_cache/`, mounted read-only at `/gateway/cache` and `/gateway/audio_cache` (`AIRA_GATEWAY_CACHE`, `AIRA_GATEWAY_AUDIO_CACHE`). See [Install](#install) |
| Gateway helpers     | AIRA's `brain.bubbles` and `brain.failure`, from `deploy/gateway/brain/`                                                                                                                                    |
| Schedule reconciler | `deploy/gateway/schedule.py`, run each minute by `aira-schedule.timer` in the gateway's environment                                                                                                         |
| Off-host copy       | An encrypted repository on another machine                                                                                                                                                                  |
| Core port           | `127.0.0.1:${AIRA_PORT}`, published to loopback only. 9881 after cutover; a spare port beside the old core                                                                                                  |
| Site API port       | `${AIRA_SITE_BIND}:${AIRA_SITE_PORT}`, the private-network address only; loopback beside the old core                                                                                                       |
| Runner service      | A host unit, present only for the subscription transport                                                                                                                                                    |

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
5. Send one synthetic turn to the core's port and check for a deliverable answer.
6. Install the updater's units with `AIRA_COMPOSE_FILE` and `AIRA_CORE_URL` pointing at this install. Its timer is
   enabled once a release image exists in the registry.

## Pull Deploy

A host timer runs the updater. No outside system connects to the host.

1. Read the newest release tag from the registry.
2. If it equals the running version, stop.
3. If a turn is in flight, wait up to `deploy.waitForIdleMs`.
4. Take a verified snapshot of the database.
5. Pull the image and start it. Start-up runs migrations inside a transaction.
6. Poll the health endpoint until ready, up to `deploy.healthTimeoutMs`.
7. Send one synthetic turn through the endpoint and check for a deliverable reply.
8. On success: record the deploy and remove images older than the previous one.
9. On failure: start the previous image, record the failure and alert the operator. No data is restored, because a
   migration keeps the previous release working. See [Persistence](storage.md#migrations).

- A release marked `manual` in its notes is skipped by the timer and waits for the operator. Use it for a release
  with a migration that cannot be reversed.
- Image pruning runs on every deploy. The host's storage pool filled once from cache churn, and this prevents it.

## Shadow Period

Before cutover, the new core runs beside the old one.

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
2. Untag the gateway jobs with `deploy/gateway/jobs.py --untag`. Restore the gateway config, `.env` and helper module backups. This restores the fallback list, turns the scope
   stamp off and gives the old core its own bubble and failure modules back.
3. Start the old core on port 9881.

The migration only reads the old stores, so the old core starts with the memory it had at step 2. Messages handled
by the new core since cutover exist only in the new database; the rollback record lists them.

## Configuration

| Key                      | Default | Effect                                                         |
| ------------------------ | ------- | -------------------------------------------------------------- |
| `deploy.checkEveryMin`   | 15      | How often the host looks for a release                         |
| `deploy.waitForIdleMs`   | 120000  | Longest wait for a running turn                                |
| `deploy.healthTimeoutMs` | 60000   | Longest wait for the new image to be ready                     |
| `gateway.hostDataDir`    | empty   | The data volume's path on the host. Start-up fails while empty |
