# ADR-0024: Find the Data Volume Through `AIRA_HOST_DATA_DIR`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

AIRA's `brain.failure` finds the data volume through `AIRA_HOST_DATA_DIR` in the gateway's `.env`.

## Rationale

The gateway's environment is already backed up and restored at cutover and rollback. A file beside the module would be
one more thing to install.

## Source

Migrated from row 24 of the Architecture table in the former `docs/DECISIONS.md`.
