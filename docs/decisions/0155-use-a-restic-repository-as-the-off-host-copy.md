# ADR-0155: Use a restic Repository as the Off-Host Copy

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The off-host copy is a restic repository: dev2 pushes to an append-only REST server on the owner's workstation; S3 or R2
later by changing the repository URL.

## Rationale

The owner chose the workstation for now, with a path to a bucket. Append-only keeps a stolen host key from deleting
backups; restic encrypts on the host.

## Source

Migrated from row 33 of the Data table in the former `docs/DECISIONS.md`.
