# ADR-0127: Store Every Unit of Work in Flight as a Database Row

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Every unit of work in flight is a database row with a state. A restart resumes it or fails it by rule.

## Rationale

The old system kept work in memory and in files, so a restart lost it or repeated it.

## Source

Migrated from row 5 of the Data table in the former `docs/DECISIONS.md`.
