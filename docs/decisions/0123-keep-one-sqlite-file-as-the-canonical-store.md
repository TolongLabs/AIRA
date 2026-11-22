# ADR-0123: Keep One SQLite File as the Canonical Store

- **Date:** 2026-11-15
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

One SQLite file is the canonical store. One process writes it.

## Rationale

The memory faults came from several writers on unlocked text files.

## Source

Migrated from row 1 of the Data table in the former `docs/DECISIONS.md`.
