# ADR-0137: Store a First-Seen Chat as Pending

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A chat seen for the first time is stored as `pending` and gets no reply until it is set `active`.

## Rationale

The admission rules refuse an unknown chat. A pending row lets the owner see it and switch it on, and lets records name
it.

## Source

Migrated from row 15 of the Data table in the former `docs/DECISIONS.md`.
