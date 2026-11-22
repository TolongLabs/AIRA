# ADR-0141: Make Forget a Barrier for Pending Memory Work

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Every forget is a barrier: the chat's pending and running memory work from before it applies nothing.

## Rationale

The message that states a fact stays in the window. Without the barrier, the next extraction would store the fact again
right after it was forgotten.

## Source

Migrated from row 19 of the Data table in the former `docs/DECISIONS.md`.
