# ADR-0082: Remove Config Keys That No Code Reads

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Config keys no code reads are removed (`turn.mediaWaitMs`, `deploy.*`); `storage.cacheMaxMb` is enforced by the disk
guard.

## Rationale

A key that does nothing misleads whoever edits it. The batching window already merges a late caption; the runner deploy
reads its environment.

## Source

Migrated from row 82 of the Architecture table in the former `docs/DECISIONS.md`.
