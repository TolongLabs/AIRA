# Deployment

Container and Compose files for running AIRA on a host.

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

| File          | Purpose                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`  | Multi-stage Node 24 image running as non-root user `node`                                                     |
| `compose.yml` | Single-service Compose definition bound to loopback 9881                                                      |
| `host/`       | The systemd service and timer that run the updater                                                            |
| `gateway/`    | AIRA's gateway helper modules (`brain/`) and its gateway patch script (`patches.py`), with their Python tests |

## The Updater

The host pulls: a timer runs `scripts/updater/main.ts` (built to `dist/scripts/updater/main.js`) every 15 minutes.
It follows the nine steps of Pull Deploy in `docs/trd/deployment.md`. It has never run on a host: it is unit-tested
with every effect faked.

## What Is Not Here Yet

The install step that copies the updater and its units to the host, the host runner service, and the cutover scripts
are specified in `docs/trd/deployment.md` and not built yet.
