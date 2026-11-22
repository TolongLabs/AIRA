# ADR-0132: Track Data Volume Files in a `file` Table

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Files on the data volume are tracked in a `file` table, owned by Persistence.

## Rationale

The contract promised a database row per file but named no table for it.

## Source

Migrated from row 10 of the Data table in the former `docs/DECISIONS.md`.
