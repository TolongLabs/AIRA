# ADR-0073: Run the Schedule Reconciler on Rewrite and Tick the Cron Every 10 Seconds

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The schedule reconciler runs when the core rewrites the schedule file, and the gateway's cron ticks every 10 s.

## Rationale

Measured: a reminder set 1 minute ahead fired 2 minutes late, after a 65 s host timer and a 60 s gateway tick.

## Source

Migrated from row 73 of the Architecture table in the former `docs/DECISIONS.md`.
