# Deployment

How a change becomes a release, how the host updates itself, and how AIRA moves from the old core to the new one in
one night.

## CI

| Job              | Runs                                                                                              | Trigger                     |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------------------------- |
| `check`          | Typecheck, lint, format, unit, contract and replay tests                                          | Every push and pull request |
| `scan`           | Secret scan of the repository history with gitleaks                                               | Every push and pull request |
| `site`           | Site typecheck and build                                                                          | Every push and pull request |
| `image-platform` | Builds and verifies each native Linux image and publishes its proved child on main                | Every push and pull request |
| `image`          | Requires both native jobs; on main assembles their exact proved manifests as `sha-<7>` and `edge` | After `image-platform`      |
| `images-ok`      | Re-reports the image result, so a skipped or failed build still fails the gate                    | After `image`, always       |
| `deploy`         | Deploys the pushed image on the host, through the self-hosted runner                              | Push to `main` only         |
| `release`        | Version and changelog pull request from commit messages                                           | Push to `main`              |
| `promote`        | Tags the image the host runs `vX.Y.Z`, `vX.Y` and `stable`, after the exact commit's CI passes    | Published release or retry  |

The hosted install gate builds and loads the candidate locally on native Linux amd64 and arm64,
then runs `tests/install/smoke.py` on a non-root, non-1000 UID Ubuntu runner for each architecture.
It exercises the real CLI, protected service, occupied ports, model save/restart, selected stock Hermes profile
dry-run/apply, deterministic synthetic transport, update/rollback and private backup/restore. It never sends a WhatsApp
message or contacts a real model. The pinned Hermes upstream admission/group and platform delivery fixtures
run under an isolated profile root. The historical v1.6.1 refusal fixture runs on amd64 only, since that
released image has no arm64 manifest. An absent native image or failed smoke fails `image` and therefore `images-ok`;
the production runner cannot start before this gate. Release promotion waits for the exact main commit's
successful CI run (including deployment) and re-tags the already-built manifest, not a newer `edge`.
The target is the published version tag resolved to its commit, not the release workflow's triggering push SHA:
release-please can create a release for a newer main commit while an earlier push workflow is running.
A manual dispatch of `release` on `main` retries promotion of the latest published non-prerelease version only,
without creating a release. Promotion serializes image tag writes without replacing pending jobs, and rechecks
the latest release and its commit before writing; a superseded target is skipped and a moved tag or mismatched digest fails the job.

## Release Image

- Every push to `main` builds native Linux amd64 and arm64 images. Only after each exact loaded image passes
  its smoke test may that job publish its architecture-specific child to `ghcr.io/tolonglabs/aira`.
  Record the tested local image ID before smoke and check it has not changed before publishing that exact ID.
  Verify the published manifest's config digest against the build metadata and its platform with an anonymous
  digest pull. Each native job records the full source commit, platform, local image ID, config digest and child
  manifest digest. The classic Docker store uses config IDs; the containerd store can use manifest or index IDs.
  Treat these as distinct digests, not interchangeable strings.
- The `image` gate requires both proofs for the exact commit, with no missing or duplicate platform. Assemble
  only those children as the public `sha-<first 7 of the commit>` and `edge` index. Verify the index contains
  exactly the proved Linux amd64 and arm64 manifest digests and both tags name the same index. No PR pushes.
  A release re-tags that same index by immutable digest after the exact commit's CI succeeds; nothing is rebuilt.
  Do not wrap a historical single-platform manifest in a new index when retrying its release promotion.
  The legacy dev2 host selects the amd64 child.
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

## Installation Modes

An install records its authority in the private Compose environment: `AIRA_INSTALL_MODE=standalone` for a new
portable install, or `legacy` for the established host-managed install. An absent value means legacy; an
unrecognized value is a deployment error. Discovery and updates never migrate this value implicitly.
Standalone uses only the API model transport. Core service readiness is not evidence of model readiness;
see [Models](models.md#standalone-model-readiness) and [System](system.md#standalone-service-readiness).
The legacy installation instructions below remain valid for existing host-managed installations.

## Standalone CLI

The portable host launcher is a root executable `aira` backed by standard-library Python 3 modules.
It reads the selected install, not the source checkout or an unrelated Hermes profile. New installations
use the explicit standalone mode and existing ones remain legacy. The explicit
`aira dashboard --show-token` action reveals the local credential only to an interactive installation
owner TTY (including authorized interactive SSH); it never reveals it to JSON output, unattended callers,
a browser URL, logs or a subprocess argument. The CLI reads the token file internally for protected
standalone probes, not a new authorization mechanism. Legacy owner credentials remain under their existing
authority. The complete host-command contract is extended here before implementing the installer.

### Install Discovery and Host State

The default is `~/aira/`. If it is a source checkout rather than an install, use
`~/.local/share/aira/install/`. An explicit `--home` takes precedence over `AIRA_HOME`.
Otherwise use an owned locator at `$XDG_CONFIG_HOME/aira/cli.json` (fallback `~/.config/aira/cli.json`),
then the default candidates; conflicting plausible installations require a selection. Read-only commands
do not create a locator, manifest, lock or install directory. An install without a manifest but with the
established Compose, environment and config files is legacy. Adoption preserves the actual Compose project,
published ports, image, configuration and service state.

Version 1 `install.json` contains only `schemaVersion`, `installId`, `mode`, `project`, `management`
(`stable` or `ci`), `release`, `imageId`, `sitePort`, `corePort`, `uid`, `gid`, and `stage`
(`prepared` or `installed`). During preparation, image ID and the actual mapping may be unknown; candidate
ports are not committed as actual ports until verified. No credential or health status belongs in the manifest.
Reruns reconcile observed Compose state with the manifest; `repair_required` describes staged or mismatched state.
Any owned file write is private, atomic and fsynced; refuse symlink or unowned targets. Mutating operations
use the same bounded exclusive host `deploy.lock` as the updater. Read-only operations never take a write lock.

The installed launcher and runtime templates belong to the current owner under
`~/.local/share/aira/cli/` (versioned runtime), with an executable launcher in `~/.local/bin/aira`.
Publish a content-addressed runtime directory atomically before changing the launcher; verify an existing
bundle rather than rewriting its modules. A failed staging operation leaves the previous launcher usable.
Never modify shell startup or install system packages implicitly. The checkout launcher uses the same modules.
If PATH omits the installed command, print its exact path. Existing unrelated paths are not overwritten.

### Fresh Setup Transaction

Support native Linux amd64 and arm64, Python 3 standard library, rootful Docker with Compose v2 and a service
enabled at boot on a systemd host. Detect missing Python/Docker/Compose, permission denial, daemon failure and
unsupported host before provisioning; report remediation, not implicit sudo or group changes. Verify disk space
and writable owned installation paths. Detect Hermes separately; its absence does not prevent dashboard setup.
Normalize only Linux `x86_64`/`amd64` and `aarch64`/`arm64`; the local Linux daemon's native architecture must match.
Resolve the effective Docker context before daemon access. Refuse a conflicting `DOCKER_DEFAULT_PLATFORM`
even if a native child is also available in the local image store.
Standalone creation supplies its verified native platform to the Compose process, so a retained dotenv value
cannot change the platform selected by the generated Compose template.
Reject a mismatched or unknown image OS/architecture before starting a setup or stopping an installed service for
update. No emulation, remote Docker, Docker Desktop or rootless Docker support is implied by a native image.

Fresh portable installs use a standalone Compose template installed as `compose.yml`, a generated private
`.env`, the existing core config template with an absolute host data path, and a private `data/` directory.
Bind the two ports to loopback, keep `restart: unless-stopped`, and map the container process UID/GID to the
non-root installing user. Mount only the owned data and read-only configuration; absent host integrations
must not manufacture root-owned paths. The legacy template and existing host mounts remain unchanged.
No Docker socket in the container.

Reserve site port 9890 and core port 9881 by default; scan upward within 9881–9999, skipping the other
assigned port. Explicit `--site-port` or `--core-port` is exact or reports `port_conflict`. Docker bind
results are authoritative; retry a fresh automatic assignment up to three times when a concurrent listener
wins. Do not move committed ports on rerun or update. The fresh default image is
`ghcr.io/tolonglabs/aira:stable`; explicit `--image REF` may use a locally loaded candidate image for
integration tests (otherwise pull the specified reference). An incompatible image is a failed setup, not
a successful HTML probe. Pull under a bounded 20 minute budget, start within 60 seconds and verify health
within 60 seconds. No paid model probe.

Setup stages: discover and preflight; plan under lock; prepare/pull; start and verify; commit/report.
Keep private staged state after interruption; never delete prior user data to retry. Verify actual
published mappings through Compose, service health with the standalone readiness schema, and authenticated
`/owner-api/core/health`. On success commit actual ports and image ID. Check daemon boot enablement:
a healthy service without verified persistence stays running and returns `persistence_degraded` with
exit 1 and the actual URL. An explicit setup on an intentionally stopped install may start it; dashboard,
status and doctor report stopped without starting. A healthy legacy setup does not pull, rewrite inputs,
or restart the service. Existing management channel remains authoritative.

`aira dashboard` prints the mapped `http://127.0.0.1:<sitePort>/overview` URL. On SSH/headless, print
the mapped-port SSH forwarding example. Only a usable local desktop invokes the browser; `--no-open`
suppresses it. JSON and non-interactive invocations do not open the browser by default. The CLI discards
opener stdout and stderr so a launched browser cannot keep its output pipes open and cause a false timeout.
The opener exit itself is bounded to 15 seconds; failure is a warning after service verification.
Expose only private loopback access for the initial portable path.

### CLI Results and Commands

Global flags: `--home PATH`, `--json`, `--non-interactive`. `--help` and `--version` are install-independent.
`setup` takes `--site-port`, `--core-port`, `--image`, `--no-open`; `dashboard` takes
`--open`, `--no-open`, `--show-token`. `status` and `doctor` are read-only. Config, attach, logs,
and update follow their typed contracts as integrated, not generic file or host operations.

For non-streaming `--json`, stdout is one object with `schemaVersion: 1`, `command`, `outcome`
(`ok` or `error`), `operationId`, `state`, `checks`, `warnings`, and `dashboard` when observed.
State dimensions are independent: `installation` (not_installed, installing, installed, repair_required),
`service` (starting, running, stopped, unhealthy), `persistence` (verified, degraded, unknown),
`configuration` (setup_required, configured, invalid, pending_activation), `hermes` (not_detected,
detected, unsupported, disconnected, connected), and `chatbot` (inactive, ready, degraded).
Report the reason when unknown, incomplete or degraded; do not guess unavailable runtime fields.
An error includes `code`, `stage`, `operationId`, `retryable`, safe `message`, `recovery`,
`exitClass`, and a safe log reference. Human progress is on stderr; no raw subprocess output,
secret, token, environment or private chat identity. Stable exits: 0 success (including expected unconfigured
state and stopped status); 2 invalid arguments; 3 prerequisite/unsupported host; 4 conflict/refused;
1 operational failure, including rolled-back failure; 5 rollback failed/manual recovery. Identity and
actual health are observed, never inferred from the manifest or tag.

### Typed Configuration and Diagnostics Commands

`aira config get` reads the selected authenticated core's sanitized saved/applied state. In standalone,
`aira config set-model --role main|fallback --provider anthropic|openai-compatible --model ID
--base-url URL` saves the specified full role and preserves the other role, with optional
`--effort`, `--deep-effort`, `--input-price`, `--output-price`, `--cached-price` (nonnegative USD per
million tokens), and `--expected-revision UUID`. An omitted expected revision uses a fresh readback.
`--key-stdin` reads one bounded secret from stdin, `--prompt-key` uses a protected interactive prompt,
`--clear-key` explicitly clears, and `--disable` disables the selected role. The key is never an argument.
Empty key input retains the previous credential. A stale revision is a conflict, not an overwrite.
`aira config set-model --role media --provider gemini --model ID` follows the
[optional media role contract](dashboard-state.md#model-revision-authority). The CLI refuses an older
core before reading a key or writing. Base URL, effort and price flags are not available for media.
Main/fallback edits omit the media role.
`aira config activate [--expected-revision UUID]` requests the exact saved revision and waits up to
60 seconds for the applied readback. An observed activation failure preserves the previous applied revision.
A readback timeout returns nonzero without claiming rollback: the restart may still complete. Run
`aira config get` to determine the actual applied revision before retrying the same saved revision.
`aira config set-character --level global|type|chat --scope SCOPE --pack ID` uses the existing scoped
settings API and its revision check (global scope empty). Legacy config get and character setting use
their established protected authority; standalone model editing does not rewrite legacy host config.

`aira doctor` returns ordered checks with `name`, `status` (ok, warning, failed, not_applicable),
`reason`, `durationMs` and `recovery`. Check runtime and Docker, selection and owned files, actual
Compose state/image/mapping, service and protected owner health, configuration/revision, persistence,
and Hermes compatibility/route. Required failures return nonzero. Expected unconfigured models and
missing optional integrations are warnings, not a false healthy chatbot. Reads do not start or
restart a stopped service, install software, contact a paid model, or send a message.

`aira logs --component setup|cli|core|gateway|update --lines N [--follow]` reads bounded redacted
recent events. Default is 50, maximum 1000. Setup/CLI/update use the private operation log; core
and gateway use the selected container's bounded log driver, normalizing allowlisted timestamp,
module/event, level and safe reason only. No raw log/exception, message or turn/chat identity is
printed. Missing sources return `component_unavailable`; stopped containers remain readable when
their logs exist. `--json --follow` emits one versioned event per line until interrupted; other
JSON commands emit one result object. The reader does not upload anything.

### Hermes Attachment Transaction

`aira attach-hermes --profile NAME --dry-run` checks the selected standalone install, pinned public
Hermes source tree, exact original or already-applied adapter file, profile scope and authenticated
route prerequisites without writing files, restarting, or contacting a real messaging account.
Optional `--hermes-dir PATH` and `--hermes-home PATH` select the public source checkout and profile root;
the ordinary defaults are the Hermes source beneath its default home and the default Hermes home.
A default profile with unrelated/multiplexed profiles is not automatically restarted; only an
independent selected profile is supported. Select an exact source revision from the finite
[standalone text registry](system.md#standalone-hermes-transport); unknown Git HEAD, unrelated tracked edits,
foreign consumer/adapter bytes or unverified profile scopes fail without changes. The ABI is not inferred
from a version range.

The candidate [typed protocol](system.md#standalone-typed-delivery) is selected explicitly with `--protocol v2`;
version 1 remains the default. Protocol migration has the same exclusive canonical source and prior-evidence
requirements as version migration. The core issues the route ID in the synthetic v2 handshake, and the final
private marker and host receipt retain that exact ID and negotiated capabilities. An incomplete or refused
handshake (including use against a v1-only core) rolls back the complete prior adapter transaction. The typed
candidate changes attachment files only while the selected gateway is stopped. A running profile refuses a
state-changing typed attachment before any writes: stock manual and supervised resume lifecycles are not yet
verified. A running identical attachment can read back the already verified files without mutation.
An unfinished v2 marker is present but inert for either reviewed adapter, so neither can fall through to Hermes.
Keep it inert until the
core receipt, helper/source, host receipt and selected service liveness have been verified. The final atomic
marker publication is the commit point; no fallible rollback after the new route can dispatch. On failure restore
the prior core receipt and source/helper while the gateway stays stopped and marker inert, then restore the prior
marker last. A concurrent start or foreign modification refuses recovery rather than replacing loaded code.
Abrupt interruption or a stalled core/filesystem can require private backup recovery; an expired handshake
prevents late dispatch, not an unbounded pause during a synchronous durable write.
No public compatibility claim until the actual adapter tests pass.

With `--protocol v2`, `--capabilities text,document` explicitly selects document delivery; `--capabilities text`
selects text only. A fresh v2 attach defaults to text, while an exact existing typed attachment preserves its
verified capability list if the option is omitted. V1 refuses this option. Capability change is a stopped
transaction with the same canonical exclusive source and prior-evidence rules as protocol migration. Keep the
exact previous v1 and typed-text helper bytes recognized; a text-only route retains that original typed helper.
Select `--capabilities text,document,receive-image,receive-audio,receive-video,receive-pdf` for the new
[direct-media candidate](media-pipelines.md#standalone-direct-media). This exact helper is distinct from
the previous text/document helpers, whose bytes remain recognized. An older core refuses the new
capability list; the existing stopped attachment transaction restores the prior state.

`aira attach-hermes --profile NAME --apply` is a deliberate apply; confirmation is required on a TTY,
or `--yes` with explicit non-interactive apply. The install must be standalone. Hold its shared deploy
lock and a bounded source-tree lock while modifying shared adapter source. Preserve the exact original
source and selected profile marker in an owned private backup under
`<data>/standalone/attach-backups/<operationId>/`. Verify source SHA/version and apply only the exact
reviewed adapter insertion plus its public helper module rendered with the exact adapter-version ID. Keep
the v0.23.4 helper byte-identical with the existing installation. Refuse any unfamiliar patch or helper.
For an operator-initiated version change, an explicit reattach may replace a previously known helper and
host record only if the owned old record, marker and authenticated connected route all describe the same
installation, source/root and selected profile, and the prior helper, host record and route versions agree.
Version-changing shared helper bytes are permitted only for the selected root's canonical, exclusive source
checkout, with no other profile marker under that root. The operator keeps this checkout exclusive; an
unproven shared/custom source refuses version migration without changes (fresh exact-version attachment
may still select a custom source). Different paths/profile, mismatched versions or partial/foreign prior state
refuse without writes.
Write the selected profile marker atomically. No legacy config, model/provider list, account credentials
or unrelated profile is edited. The selected gateway's existing service state is preserved: restart only
a running independent profile using its pinned Hermes command, and verify its liveness; a stopped
profile stays stopped with an explicit start instruction. Never start a second gateway for the same account.

Verify using the installed adapter's synthetic local handshake against the actual mapped core port,
not an arbitrary provider URL or a real message. Execute the selected rendered helper bytes for the
handshake, rather than the default template module. Authenticated readback must confirm both profile and the
selected exact adapter version. On failure restore the exact prior touched files
and service state, clear or restore the route receipt, return nonzero with safe recovery evidence.
An owned private `<data>/standalone/attach-host.json` records the pinned source and Hermes root paths and
selected profile and adapter version; doctor rechecks the exact source/helper/marker and liveness against that
record. It is not a credential or an
authorization source. A missing, moved or foreign source/marker cannot count as an installed route.
If rollback fails report exit 5 and the private backup location. The public adapter is limited to
ordinary WhatsApp text after Hermes admission; the legacy integration and its broader capabilities
remain unchanged. See [standalone Hermes transport](system.md#standalone-hermes-transport).

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

### Standalone stable update

The host CLI uses the same deployment transaction on a host without Bun or Node. A legacy or CI-managed install
keeps its existing updater and management channel: `aira update` reports that channel without changing it. Only an
installed, authenticated, running standalone stable install can enter the portable update transaction. An explicit
compatible local image is permitted for fixtures. The normal target is the public `stable` image.

Under `deploy.lock`, record the actual container image ID and mapped ports, pin the previous image to an owned
installation-specific local tag, pull the target without replacing the running container, and inspect its image
ID and `io.tolonglabs.aira.standalone-contract=1` label. A missing or incompatible label refuses the update before
service replacement. If the IDs match, report up to date. Pin the candidate to an installation-specific local tag,
so neither an external pull nor a moved registry tag can silently change the transaction. Wait at most 120 seconds
for idle; abort if not idle. Gracefully stop the old container and take a verified coherent private backup as defined
in [Persistence](storage.md#standalone-deploy-backup). If backup fails, restart the unchanged previous container.

Persist a private `update.json` journal before stopping, with the old and candidate image IDs, local tags, prior
image selection and backup ID (no credentials). Change only the two owned image-selection lines in `.env`; retain
the real ports, data, owner UID and all other configuration. Start the pinned candidate, check the actual image ID,
service and owner health and built dashboard using the setup verifier, and run the existing deterministic isolated
deployment probe inside the image in standalone mode. That probe uses a temporary database, example pack and fake
gateway transport, and never sends or invokes a real provider. Commit the manifest only after verification.

Any failure after stopping triggers recovery to the exact previous pinned image and verifies its health, owner
authentication and unchanged ports. Report `update_rolled_back` (exit 1), or `rollback_failed` (exit 5) with the safe
backup reference and journal retained. A later update first recovers an unfinished journal and never blindly starts
another candidate. A routine rollback uses current data; it never restores an older snapshot over later writes.
Do not prune images or mutate another project. Record the operation ID, stage, result and previous/candidate image
IDs in the bounded private update log. There is no automatic stable update timer in the portable milestone.

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

The preview at `/app/preview/overview` serves the candidate before the switch. From a checkout of the candidate on
the deployment host, record the installed image ID and use the entry switch helper:

```sh
release_image=$(docker inspect --format '{{.Image}}' "$(docker compose --project-directory ~/aira -f ~/aira/compose.yml ps -q aira)")
python3 scripts/dashboard-entry.py --install ~/aira --expect-image "$release_image" dashboard
```

To restore the classic entry, pass `classic` to the same command with the recorded image ID and reopen
`/app/`. The helper holds the deployment lock, verifies the current image and Compose selector, records
a fresh SQLite snapshot, and saves pack/config backups under `~/aira/dashboard-recovery/`. It changes
the entry key atomically and recreates the same service with pulling disabled. Failed health, owner or
entry checks restore the prior environment and service. Keep writes since cutover in place.
Use the private listener's explicit IP and port for the probe; loopback is also supported.

The deployment probe accepts the classic HTML response or the exact same-site redirect to `/overview`. It verifies
chat and host dashboard responses with the owner header. A private site health challenge requires the same owner
credential. The probe sends credentials only to the configured site and refuses further redirects.

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

### Dashboard staging rehearsal

The [preview deployment](https://github.com/TolongLabs/AIRA/actions/runs/45263573904) installed
`54a64c6216cfcbba741dc3111beea426148b6f05` with the classic entry selected. Chrome signed in on the
private host and loaded all seven preview destinations and the protected health endpoint. It recorded zero
asset failures and zero uncaught exceptions. An unbound synthetic character copy exercised create, edit,
stale rejection, unchanged save and readback. The two mutations produced two audit records. The probe
retired the fixture and verified its endpoint returned 404.

An isolated container from the installed image opened a data-free copy of the installed schema. It applied
zero migrations at schema 17. The verified online snapshot contained the first synthetic row. Reopening
the working database recovered both rows, including the later write. The rehearsal also restored the copied
pack and deployment configuration byte for byte. The [cutover issue](https://github.com/TolongLabs/AIRA/issues/372)
records the canonical-entry checks, observation window and installed release.

On the [installed dashboard](https://github.com/TolongLabs/AIRA/issues/372#issuecomment-7114777151),
the owner drill switched from dashboard to classic and back while preserving a synthetic pack revision and both
audit rows. The [observation record](https://github.com/TolongLabs/AIRA/issues/372#issuecomment-7114993525)
covers twelve probes over ten minutes, the installed Chrome task cycle and the isolated next-turn check.
