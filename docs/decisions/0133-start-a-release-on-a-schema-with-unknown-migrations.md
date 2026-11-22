# ADR-0133: Start a Release on a Schema With Unknown Migrations

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A release starts on a schema that holds migrations it does not know.

## Rationale

An image rollback runs the previous release on the newer schema. Refusing to start would turn every rollback into a
restore.

## Source

Migrated from row 11 of the Data table in the former `docs/DECISIONS.md`.
