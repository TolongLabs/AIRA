# ADR-0142: Remove a Fact Only When Named by ID

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

`forget` removes a fact only when it is named by id. A search returns candidates and removes nothing.

## Rationale

A search can match the wrong fact, or another member's. The contract already forbids a match by a shared word.

## Source

Migrated from row 20 of the Data table in the former `docs/DECISIONS.md`.
