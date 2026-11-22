# ADR-0153: Use `jev-latest` as the Judge Model

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

`judge.model` is `jev-latest`, TypeSafe's Jev. Its release date at the time is 22 October 2026; the memory thresholds
are re-checked whenever the alias moves to a new release.

## Rationale

The owner chose Jev. TypeSafe lists no versioned id, only `jev-latest` and `jev-preview`, so the release date stands in
for a version.

## Source

Migrated from row 31 of the Data table in the former `docs/DECISIONS.md`.
