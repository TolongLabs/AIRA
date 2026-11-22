# ADR-0028: Declare Reminders in `gateway/schedule.json` for a Host Reconciler

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core writes the reminders it wants to `gateway/schedule.json`, and a host reconciler makes the gateway's schedule
match. The core makes no call to the gateway. This replaces the call to the schedule in the reminder tools.

## Rationale

The container cannot reach the host without host networking, and the schedule has its own file lock on the host. A
declared file needs no network or token, and it survives any restart of either side.

## Source

Migrated from row 28 of the Architecture table in the former `docs/DECISIONS.md`.
