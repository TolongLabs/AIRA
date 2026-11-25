# Deployment

Container and Compose files for running AIRA on a host.

New standalone installations use the [host CLI](../docs/INSTALL.md), which copies `standalone.compose.yml` into an
owned installation directory. It maps the owner's UID/GID, selects private loopback ports and uses a generated
standalone owner credential. No existing legacy installation is converted. The host units and legacy Compose
configuration below remain in use on legacy hosts.

## At a Glance

| Item              | Location On The Host                                              |
| ----------------- | ----------------------------------------------------------------- |
| Compose file      | `deploy/compose.yml`, copied at install                           |
| Secrets           | `.env`, mode 600, never in git                                    |
| Data volume       | SQLite file, backups, uploaded stickers, packs made in the studio |
| Core port         | `127.0.0.1:9881`, published to loopback only                      |
| Site and API port | Private network address only                                      |
| Runner service    | A host unit, present only for the subscription transport          |

## Files In This Folder

| File                     | Purpose                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Dockerfile`             | Multi-stage Node 24 image running as non-root user `node`                                                                                              |
| `compose.yml`            | Single-service Compose definition bound to loopback 9881                                                                                               |
| `standalone.compose.yml` | Standalone private listeners, mapped owner UID/GID, bounded logs and restart policy                                                                    |
| `cli/`                   | Standard-library Python host CLI for setup, discovery, typed configuration, diagnostics, attachment and update                                         |
| `host/`                  | The systemd units that run the updater, and the user units that run the schedule reconciler every minute                                               |
| `gateway/`               | AIRA's gateway helper modules (`brain/`), its gateway patch script (`patches.py`) and the schedule reconciler (`schedule.py`), with their Python tests |

## Main-branch deployment

The self-hosted GitHub Actions runner deploys the SHA image after the main-branch checks pass.
It installs the directory watcher and the owner, probe and settings sockets as systemd user units.
The settings socket runs the bundled `dashboard-settings.mjs` CLI. The CLI accepts `status`, `save` and `apply`.
Pass save and apply JSON on stdin. The same handlers serve the authenticated dashboard. Replacement credentials
are write-only. Save updates the installed files. Apply recreates the current image and restores the previous
files if the core fails its health check. The site container keeps its configuration mount read-only.
The container mounts their directory read-only at `/gateway/directory`. Mount the parent directory so
the container sees a new directory file when the host replaces it.

The owner opens the site on `AIRA_SITE_PORT`. The browser sends core requests to `/api/` and host-owner
requests to `/owner-api/` on that origin. The host bridge checks that the upstream enforces authentication
before forwarding owner traffic. See [Site serving and routing](../docs/trd/site.md#serving-the-api).

## Release-driven updater

The optional user timer runs the updater every 15 minutes and follows release tags. The timer and the
main-branch deploy share a host lock. Both verify the site and a synthetic gateway turn before accepting
an update. The turn uses a temporary database and a deterministic model inside the deployed image.

See [Deployment](../docs/trd/deployment.md) for installation, health checks, snapshots and rollback.
