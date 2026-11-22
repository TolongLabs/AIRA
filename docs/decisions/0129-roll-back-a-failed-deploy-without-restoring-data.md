# ADR-0129: Roll Back a Failed Deploy Without Restoring Data

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A failed deploy returns to the previous image without restoring data. This reverses the earlier step that restored a
backup when a migration had run.

## Rationale

A restore would drop every turn written since the snapshot. Migrations now keep the previous release working instead.

## Source

Migrated from row 7 of the Data table in the former `docs/DECISIONS.md`.
