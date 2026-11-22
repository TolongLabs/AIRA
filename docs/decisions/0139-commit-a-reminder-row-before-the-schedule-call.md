# ADR-0139: Commit a Reminder Row Before the Schedule Call

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A reminder row commits before the call to the gateway's schedule. Start-up reconciliation creates a missing job.

## Rationale

A transaction cannot span a network call. Writing the row first means a failed call leaves a reminder that is recreated,
never one that is lost.

## Source

Migrated from row 17 of the Data table in the former `docs/DECISIONS.md`.
