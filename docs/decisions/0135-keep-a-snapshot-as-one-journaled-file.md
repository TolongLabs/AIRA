# ADR-0135: Keep a Snapshot as One Journaled File

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A snapshot is one file with a rollback journal, and the recovery pass empties `snapshots/` of everything else.

## Rationale

The Restart suite found that a kill during verification left a stray file beside a snapshot.

## Source

Migrated from row 13 of the Data table in the former `docs/DECISIONS.md`.
