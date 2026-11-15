# Runbook

Operational procedures for running AIRA on the host.

Status: nothing is deployed yet. This is a skeleton pointing to the TRD modules that specify each procedure.

## Install

Host layout, compose file, secrets and data volume setup are specified in [`docs/trd/deployment.md`](trd/deployment.md).

## Configure

Configuration files, secrets, character packs and chat settings are specified in [`docs/trd/data.md`](trd/data.md).

## Deploy

CI, release image publishing and the pull-based host updater are specified in
[`docs/trd/deployment.md`](trd/deployment.md).

## Health Check

Start-up validation and the readiness health endpoint are specified in [`docs/trd/reliability.md`](trd/reliability.md)
and [`docs/trd/site.md`](trd/site.md).

## Backups

Daily SQLite backups, retention and pre-deploy backups are specified in [`docs/trd/data.md`](trd/data.md).

## Cutover

The one-night cutover steps from the old core to the new core are specified in
[`docs/trd/deployment.md`](trd/deployment.md).

## Rollback

Rolling back to the old core and restoring gateway configuration are specified in
[`docs/trd/deployment.md`](trd/deployment.md).

## Read a Turn Record

Inspecting a turn record and generating summary reports are specified in [`docs/trd/records.md`](trd/records.md).

## Common Failures

Failure kinds, alerts and containment rules are specified in [`docs/trd/models.md`](trd/models.md),
[`docs/trd/reliability.md`](trd/reliability.md) and [`docs/trd/records.md`](trd/records.md).
