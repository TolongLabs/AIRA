# Runbook

Operational procedures for running AIRA on the host. The TRD modules own each contract; this page tells the
operator what to run, in order.

Status: the host deploys on every push to `main` through the self-hosted runner. See
[`docs/trd/deployment.md`](trd/deployment.md).

## Host Layout

One install lives in `~/aira/`: the compose file, `.env` (mode 600), `config.yml` (mounted read-only), and the
`data/` folder. The gateway reads the core's files from that folder. The full map is in
[`docs/trd/deployment.md`](trd/deployment.md#host-layout).

![The host units, what triggers them and what they run](diagrams/host-units.svg)

## Dashboard release checks

1. Run `bun install --frozen-lockfile` at the repository root. Run `bun install --frozen-lockfile` inside
   `site/`. From the root run `bun run --cwd site build`.
2. Install the browser engines and Linux dependencies with `bunx playwright install --with-deps chromium firefox webkit`.
   Run `bun run test:dashboard`. This exercises the production UI through the core listener with synthetic packs,
   temporary storage and a loopback host. Message tests use a fake gateway.
3. In the install directory run `docker compose ps aira`. Record the running image and health without printing
   its environment:

   ```sh
   docker inspect --format '{{.Config.Image}} {{.Image}} {{.State.Health.Status}}' "$(docker compose ps -q aira)"
   ```

4. Open the preview at `/app/preview/overview` on the private site. Check the current owner login and each
   [destination](trd/dashboard-routes.md). Use the isolated fixture suite for actions that would send a message,
   change a real character or restart a host service.
5. Follow the [entry switch and rollback procedure](trd/deployment.md#dashboard-entry-recovery). Record the
   installed image, snapshot identifier, observed window and readback results. Retain writes made since the switch.

## Install

Follow [`docs/trd/deployment.md`](trd/deployment.md#install). Confirm each step that changes the host first.
Point `gateway.hostDataDir` at the data folder's absolute path. When the install folder is not `~/aira`, edit
`deploy/host/aira-schedule.path` to match before enabling the units.

## Configure

Configuration files, secrets, character packs and chat settings are specified in
[`docs/trd/data.md`](trd/data.md). Change chat settings through the Chats page: each write validates like
start-up, commits with a `setting_change` row, and applies on the next turn. The owner enters the site credential in the browser. The browser sends it in the
`X-TolongAI-Token` header, and the core verifies it through the host owner service. The listener checks the request host and any supplied origin.
See [protected core queries](trd/site.md#protected-core-queries-and-scoped-settings) for the authorization
and revision checks. After changing deployment configuration, use System Health to verify its applied revision.

## Deploy

Every merge to `main` builds an image and deploys it. The deploy waits for an idle turn, snapshots, pulls, rewrites
`.env` in place, recreates the container, polls health and sends one synthetic turn. On failure it restarts the
previous image; it never restores data. The full sequence is in
[`docs/trd/deployment.md`](trd/deployment.md#deploy).

![How one merge to main becomes a running container](diagrams/release-deploy.svg)

To recover from a failed or half-finished deploy, read the append-only record: `deploys.jsonl` in the install
folder for the CI deploy, or `/var/lib/aira/deploys.jsonl` for the timer path. `failed_before_start` means nothing
was started; `rolled_back` means a start, health or turn check failed and the previous image was restarted. When
the rollback itself failed, start the previous image by hand with its `AIRA_VERSION`.

## Health Check

Poll `GET /health` until ready. Start-up validation and the readiness endpoint are specified in
[`docs/trd/reliability.md`](trd/reliability.md) and [`docs/trd/site.md`](trd/site.md). To change how long a deploy
waits for idle or health, set `AIRA_WAIT_FOR_IDLE_MS` or `AIRA_HEALTH_TIMEOUT_MS` in the deploy environment; the
`config.yml` keys of the same names have no effect.

## Backups

Snapshots, retention, the off-host copy and recovery are specified in
[`docs/trd/storage.md`](trd/storage.md).

The off-host copy is a restic repository behind an append-only REST server on
the owner's workstation (`deploy/offsite/`). Every 15-minute snapshot is
shipped; a `backup_run` row with reason `offsite` records each attempt, and
`backup_stale` alerts after 60 minutes without a good one. Backups pause while
the workstation or its Docker is off.

### Restore From The Off-Host Copy

1.  Confirm the workstation's REST server is up: from the host,
    `curl -s -o /dev/null -w '%{http_code}' http://<workstation>:8000/aira/config`
    answers `401` (up, needs a password).
2.  Restore into an empty folder with the deployed image, reading the
    credentials from the install's `.env`:

    ```sh
    mkdir -p ~/aira-restore && chmod 777 ~/aira-restore
    IMG=$(cd ~/aira && docker compose ps --format '{{.Image}}')
    docker run --rm --env-file ~/aira/.env \
      -v ~/aira/config.yml:/app/config.yml:ro -v ~/aira-restore:/restore \
      -w /app --entrypoint node "$IMG" dist/scripts/restore-offsite.js --to /restore
    ```

    It prints the snapshot id and time, `integrity_check: ok`, and row counts.

3.  To check it serves, copy the restored `data/snapshots/aira-*.db` to a
    scratch `data/aira.db`, start the image on that folder with no published
    ports, and send one `deploy check` request to its
    `/v1/chat/completions`.
4.  To replace live data, stop the core, move `~/aira/data/aira.db` aside,
    copy the restored database in as `aira.db`, start the core and check
    `/health`.

Drill, 18 Nov 2026: restore took 4 s; `integrity_check: ok`; the scratch core
started `ready` and answered the synthetic turn.

## Cutover

The one-night cutover steps from the old core to the new core are specified in
[`docs/trd/deployment.md`](trd/deployment.md#cutover). The shadow period did not run; NFR-8 still requires one.

## Rollback

Rolling back to the old core and restoring gateway configuration are specified in
[`docs/trd/deployment.md`](trd/deployment.md#rollback).

## Read a Turn Record

Inspect one turn with `bun run turn`, and print latency, failure, cost and fallback figures with `bun run report`.
The record format is specified in [`docs/trd/records.md`](trd/records.md).

## Common Failures

Failure kinds, alerts and containment rules are specified in [`docs/trd/models.md`](trd/models.md),
[`docs/trd/reliability.md`](trd/reliability.md) and [`docs/trd/records.md`](trd/records.md). Operator alerts append
to `alerts.jsonl` on the data volume and write a failure row.
