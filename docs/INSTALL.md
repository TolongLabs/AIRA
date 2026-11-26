# Install and Operate Standalone AIRA

Standalone AIRA opens the private owner dashboard before a model or messaging account is connected. It does not
migrate an existing legacy installation. See [legacy host installation](trd/deployment.md#install) for a host
already managed by the CI deployment or release timer.

## Supported Host

- Linux amd64 with systemd; tested on Ubuntu 24.04.
- Git, Python 3.10 or later (standard library), local rootful Docker Engine and Compose v2 or later.
- An ordinary non-root owner with Docker access, at least 2 GiB of free disk space and Docker enabled at boot.

The CLI does not install packages, invoke `sudo`, join groups or edit shell startup files. Node.js and Bun are not
needed on the installation host. No model key, Hermes or registry login is needed for setup. See the
[compatibility evidence](#compatibility-evidence) for native arm64 verification and unverified environments.

## Install and Open the Dashboard

```sh
git clone https://github.com/TolongLabs/AIRA.git
cd AIRA
./aira setup
```

1. Setup pulls `ghcr.io/tolonglabs/aira:stable`, verifies the service and prints the actual dashboard URL. A usable
   local desktop opens it; `--no-open` prints without opening. Opener failure does not stop the installed service.
2. On a headless or SSH host, use the printed SSH forwarding command on your laptop, replacing `<user>@<host>`
   with your login. Open the forwarded local URL and keep the SSH tunnel open. The two ends of a tunnel may use
   different ports; use the actual remote port, not a guessed default. If the local port is busy, select another
   local port and open that address instead.
3. On the installation host, run `./aira dashboard --show-token` in an interactive owner terminal, including an
   authorized SSH session with a TTY. Paste the token into the dashboard sign-in form and select **Save token**.
   There is no credential reveal in JSON or non-interactive mode. Never put the token in a URL, command argument
   or support log.

The CLI also installs `~/.local/bin/aira` and a private versioned runtime in `~/.local/share/aira/cli/`. Use that
launcher, or continue using `./aira` from the checkout. If the launcher is not on `PATH`, setup prints its path.
The commands below assume `aira` is available; substitute the printed path or `./aira` if necessary.

## Installation and State

The default install folder is `~/aira/`. If that is a source checkout, the default falls back to
`~/.local/share/aira/install/`. Select another install with `--home PATH` or `AIRA_HOME`; an explicit `--home`
takes precedence. Otherwise the CLI uses its private locator and default candidates. Ambiguity requires an explicit
selection. Read-only discovery never creates a new installation.

| Location in the install     | Purpose                                                               |
| --------------------------- | --------------------------------------------------------------------- |
| `install.json`              | Install identity, management channel, verified image and actual ports |
| `compose.yml`, `config.yml` | Compose service and read-only core configuration                      |
| `.env`                      | Private deployment inputs (mode 600)                                  |
| `data/`                     | Owner-written database, packs, files and verified backups             |
| `data/standalone/`          | Private owner/gateway credentials, model revisions and route state    |

Both published listeners bind to loopback, prefer site 9890 and core 9881, and select other free ports when needed.
Use `aira dashboard` to discover the actual mapping. Setup retries an automatic bind race; an explicit
`--site-port` or `--core-port` conflict fails. Successful setup and update keep the assigned ports. The container
runs as the installing user's UID and GID, and `restart: unless-stopped` lets it resume with Docker after boot.
An intentionally stopped container remains stopped, including after reboot. `aira setup` explicitly resumes it;
`status`, `dashboard` and `doctor` do not start it.

## Configure a Model

The Overview separates service, configuration, Hermes and chatbot state. A new service is running with
`setup_required` configuration and an inactive chatbot. In **System Settings**, choose a main API model, enter its
credential, save a revision and apply it. The saved revision is distinct from the applied revision until the core
restarts and verifies it. A confirmed activation failure preserves the previous applied revision. A timeout means
the CLI could not confirm completion; the restart can still finish. Run `aira config get` to read the actual applied
revision before retrying. Do not assume a timeout rolled back the revision.

The fictional Example pack is available in Character Studio. A global assignment is supported; real packs belong
only on the private data volume. Connect Hermes only after choosing the desired settings.

The same typed config actions are available from the host:

```sh
aira config get
aira config set-model --role main --provider openai-compatible --model MODEL_ID \
  --base-url PROVIDER_BASE_URL --prompt-key
aira config activate
aira config set-character --level global --pack example
```

Replace `MODEL_ID` and `PROVIDER_BASE_URL` with your provider's values. The supported roles are `main` and
`fallback` for `anthropic` and `openai-compatible`. The optional `media` role uses Gemini only on cores
that advertise it. Configure it in **System Settings** or with
`aira config set-model --role media --provider gemini --model MODEL_ID --prompt-key`, then apply the revision.
This configures the media model; inbound media also requires the explicit candidate attachment below.
Automatic social link media reading remains unavailable.
Use `--prompt-key` or `--key-stdin`, never an
API key argument. `--expected-revision` refuses a stale write. See [typed configuration commands](trd/deployment.md#typed-configuration-and-diagnostics-commands)
for additional flags. Setup and activation do not contact a paid model as a health probe; configure a real provider
only when ready to use one.

## Attach Hermes Deliberately

Standalone attachment supports the stock public **Hermes v0.23.4** source at the exact
[pinned revision](https://github.com/NousResearch/hermes-agent/tree/8fc0374447313e276f6b9a2764bfc750190c966a).
Use the [upstream release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.4) for its installation
instructions. AIRA does not install Hermes, pair an account or change group admission rules. Use an independent
selected profile that you already operate; a multiplexed or unfamiliar source/profile is refused. Do not downgrade
or overwrite a working legacy Hermes installation to satisfy this pin.

1. Check the selected profile without changing it:

   ```sh
   aira attach-hermes --profile default --dry-run
   ```

2. Review the result. If this is the intended profile, apply the reviewed adapter and confirm the prompt:

   ```sh
   aira attach-hermes --profile default --apply
   ```

3. Run `aira doctor` and check the dashboard. If the chosen independent gateway was stopped, it stays stopped;
   start it only when ready with `hermes -p default gateway start`. A running selected gateway is restarted and
   checked as part of apply. Replace `default` in all commands with the same named profile if appropriate.

For an alternate source tree or Hermes home, specify `--hermes-dir PATH` and `--hermes-home PATH` on both dry-run
and apply. The ordinary defaults use `~/.hermes/hermes-agent` and `~/.hermes`. A deliberate unattended apply needs
both `--apply` and `--yes`; dry-run does not modify the selected profile. Failed apply restores the touched adapter
files, profile marker and prior service state. See the [attachment contract](trd/deployment.md#hermes-attachment-transaction).

The supported standalone messaging baseline remains ordinary admitted WhatsApp text in DMs and groups, retaining
Hermes admission rules. The existing legacy integration is unchanged. The following candidate work is separate
from the supported messaging baseline.

## Compatibility Evidence

The verified foundation adds opt-in, synthetic-only compatibility evidence. It does not establish real account
pairing or live delivery. The supported messaging baseline is unchanged while
[#402](https://github.com/TolongLabs/AIRA/issues/402) remains open.

| Area                   | Evidence and Boundary                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native Linux           | Local rootful amd64 and arm64 install, update, rollback, restore and image publication tested on native CI runners. Arm64 is a verified host/image candidate, not a broader messaging claim. |
| Stock Hermes           | Synthetic admission, identity, attach and native text dispatch against exact v0.23.2, v0.23.3 and v0.23.4; unknown or modified source refused.                                               |
| Typed text and reports | Explicit v2 text and receipt-backed generated Markdown/PDF document delivery tested with a loopback fake bridge on all three pins. No real account or live send.                             |
| Direct inbound media   | Explicit candidate route for PNG/JPEG, Ogg/MPEG audio or voice, MP4 and PDF, one bounded direct cache file and applied Gemini role. No live message or provider call.                        |
| Other transport        | Arbitrary outbound files/media; quoted or remote media; sticker and reaction delivery; location and polls remain unavailable.                                                                |
| Host environment       | Remote Docker refuses. Rootless, Docker Desktop, WSL2, macOS and other OS/CPU rows remain unsupported. The isolated X11 desktop result below is not an actual owner-desktop claim.           |

See [exact text versions](https://github.com/TolongLabs/AIRA/pull/413),
[native image checks](https://github.com/TolongLabs/AIRA/pull/416),
[typed text](https://github.com/TolongLabs/AIRA/pull/418) and
[portable report document checks](https://github.com/TolongLabs/AIRA/pull/420) for evidence.

Typed transport is not the default. Its explicit candidate attachment requires the selected independent profile
to be stopped for a state change. Only the generated report can be delivered as a document; arbitrary paths,
other media, and legacy `MEDIA:` directives are not accepted. Stock Hermes may render reactions, polls or
contacts as ordinary text summaries; this is not structured capability support. For the precise capability and rollback rules,
see the [typed attachment contract](trd/deployment.md#hermes-attachment-transaction).

The direct-media candidate is separately selected with
`aira attach-hermes --profile default --protocol v2 --capabilities text,document,receive-image,receive-audio,receive-video,receive-pdf --dry-run`.
Only apply after the selected independent profile is stopped and the dry-run is verified. It uses the
[bounded direct-media contract](trd/media-pipelines.md#standalone-direct-media) and requires the
applied optional Gemini role. This is synthetic evidence, not an expansion of the supported baseline.

Host owner service, direct owner sends, file browsing and the subscription runner remain legacy-only. Library,
lesson and market integrations, MCP, research jobs and scheduled messages are not enabled in standalone.
Additional media and core-owned routines need independently negotiated capability, configuration and
delivery authority before they can be enabled. See the [inbound media evaluation](trd/media-pipelines.md#standalone-inbound-media-evaluation)
and [integration decisions](trd/site.md#portable-integration-decisions). Unsupported owner routes refuse rather
than contacting the host.

On an isolated X11 virtual display, the real XDG default-handler dispatch opened an actual Chromium window at
the mapped dashboard URL, without waiting on the browser's output pipes. Synthetic owner sign-in succeeded
on a fresh v1.7.0 native amd64 container. This tests the candidate CLI opener in a disposable desktop and
browser profile, not the unconfigured host owner's visible default browser. Actual rootless acceptance and
other desktop environments remain unverified.

Live verification remains pending until a separate isolated WhatsApp account and approved recipient are available.
No existing production account is used for acceptance.

## Diagnose and Recover

```sh
aira status
aira doctor
aira logs --component setup --lines 20
aira logs --component core --lines 50
```

Doctor checks the actual installation, private owned files, Docker state, mappings, image, service health,
authenticated owner health, configuration, persistence and the verified Hermes route. Missing models or optional
integrations are tasks/warnings rather than a ready chatbot. Logs read bounded redacted events; use `--follow` for
streaming. Setup, CLI and update events are in `$XDG_STATE_HOME/aira/operations.jsonl` (fallback
`~/.local/state/aira/operations.jsonl`, mode 600), with a 2 MiB file limit and four rotations. Core container logs
use the bounded Docker log driver (10 MiB times three files). Do not copy raw credentials or chat content into reports.

| Reason                                                | Recovery                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docker_missing`, `docker_permission`                 | Install or enable Docker access, then retry `aira setup`.                                 |
| `disk_full`, `path_unwritable`                        | Free disk or choose an owned writable path.                                               |
| `port_conflict`, `deploy_locked`, `install_ambiguous` | Free the explicit port, wait for the lock or select `--home`.                             |
| `operation_interrupted`, `image_pull_failed`          | Keep staged files and data; run `aira setup` again.                                       |
| `health_timeout`, `owner_auth_failed`                 | Run `aira doctor` and inspect bounded logs; never rotate keys implicitly.                 |
| `persistence_degraded`                                | Service may be running; ask the administrator to enable Docker at boot, then rerun setup. |
| `hermes_unsupported`, `attach_failed`                 | Review selected source/profile and dry-run again; do not replace unrelated files.         |

For automation, `--json --non-interactive` returns a single versioned object with operation ID, outcome, independent
state fields, checks, warnings, actual dashboard mapping and an error code/recovery when applicable. `logs --json
--follow` streams one event per line instead. Exit classes: 0 success (including expected keyless or stopped status),
1 operational failure, 2 invalid arguments, 3 prerequisite/unsupported host, 4 conflict/refused and 5 rollback failed.
The [CLI result contract](trd/deployment.md#cli-results-and-commands) defines these fields.

## Update, Roll Back and Restore

```sh
aira doctor
aira update
```

Standalone stable installations update explicitly; there is no automatic portable update timer. Update pins the
previous and candidate images, waits for idle, verifies a private backup and changes only the image selection. It
checks service/owner health, the actual ports and a deterministic isolated turn before accepting the new image.
It does not send a real message or contact a real model. Legacy and CI-managed installations keep their existing
deployment channel; `aira update` does not override it.

- `update_rolled_back` (exit 1): the previous image was restored and verified, with current data and the same ports.
  Inspect `aira logs --component update` and `aira doctor`; retry `aira update` after addressing the cause.
- `rollback_failed` (exit 5): keep the backup, pinned images and `update.json` journal. Inspect the error and logs;
  once the reported cause is resolved, `aira update` first recovers the unfinished transaction. Do not delete the
  journal or restore old data over later writes to force a retry.

Use the backup ID reported by the operation to verify a separate restored copy. The destination must be new,
private and outside the live installation:

```sh
aira restore --backup-id BACKUP_ID --destination ./aira-recovery-copy
```

Replace `BACKUP_ID` with the reported identifier. Restore verifies the snapshot and copies the private token,
settings, credentials and revision state with their permissions. It does not replace or start a live installation.
See [standalone deploy backup](trd/storage.md#standalone-deploy-backup) and
[standalone update](trd/deployment.md#standalone-stable-update) for the complete recovery contract.

## Existing Installations

From the new checkout, run `./aira status`, `./aira dashboard --no-open`, `./aira doctor` and `./aira logs`.
The CLI discovers the actual legacy Compose project, image, management channel, dashboard port and existing owner
authority. Read-only discovery never writes the old `.env`, Compose, config or Hermes files or restarts the service.
Do not switch an established installation to standalone. Use the [legacy runbook](RUNBOOK.md) for its normal deploy,
backups and rollback.

## Release Evidence

The [v1.6.0 release](https://github.com/TolongLabs/AIRA/releases/tag/v1.6.0) was promoted from its exact
[successful CI and deployment](https://github.com/TolongLabs/AIRA/actions/runs/45638976449).
[Promotion](https://github.com/TolongLabs/AIRA/actions/runs/45638976448) verifies the public stable manifest matches
the release SHA. The three-command install ran on a fresh non-1000 UID Ubuntu VM without keys, Hermes, Node.js, Bun
or registry login, including automatic port collision handling. An interactive SSH TTY revealed the owner token
and Chromium signed in through the forwarded dashboard; anonymous and wrong-token requests were refused. Hosted
verification exercises the actual candidate
image, private owner authentication, model save/apply, stock Hermes synthetic transport, upgrade/rollback and
backup/restore. No real messaging account or model provider was used in those fixtures.
