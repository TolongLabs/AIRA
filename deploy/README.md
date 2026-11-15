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

| File          | Purpose                                                   |
| ------------- | --------------------------------------------------------- |
| `Dockerfile`  | Multi-stage Node 24 image running as non-root user `node` |
| `compose.yml` | Single-service Compose definition bound to loopback 9881  |

## What Is Not Here Yet

The pull-deploy updater, the host runner service, and the cutover scripts are specified in `docs/trd/deployment.md` and
not built yet.
