# ADR-0138: Change State Only Through One `commit` Call

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A mutating tool changes state only through one `commit` call that also stores the call's result and its receipt.

## Rationale

One transaction per state change, a receipt only after the commit, and a repeat by call id are then properties of the
registry, not promises each handler must keep.

## Source

Migrated from row 16 of the Data table in the former `docs/DECISIONS.md`.
