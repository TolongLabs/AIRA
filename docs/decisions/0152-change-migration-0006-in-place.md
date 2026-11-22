# ADR-0152: Change Migration 0006 in Place

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Migration 0006 is changed in place rather than followed by a migration that drops its tables.

## Rationale

No release holds it (`releasedVersion` 0), so no database has applied it. A drop would break the add-first rule for no
gain.

## Source

Migrated from row 30 of the Data table in the former `docs/DECISIONS.md`.
