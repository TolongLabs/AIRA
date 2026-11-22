# ADR-0069: Make Live Context Settings per Chat

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Live context is per chat: `features.context` (on), `context.maxMessages` (40) and `memory.pageMessages` (25). Off keeps
logging, so memory still works.

## Rationale

The owner wants each chat to choose how much AIRA reads. 40 and 25 are the current values, unmeasured; a benchmark
follows.

## Source

Migrated from row 69 of the Architecture table in the former `docs/DECISIONS.md`.
