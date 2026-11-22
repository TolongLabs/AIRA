# ADR-0134: Return Every Job Lease to the Queue at Start-Up

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

At start-up every job lease returns to the queue, expired or not.

## Rationale

One process writes the file, so every earlier lease owner is gone. Waiting for the expiry would only delay the work.

## Source

Migrated from row 12 of the Data table in the former `docs/DECISIONS.md`.
