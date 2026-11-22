# ADR-0083: Set Deep Effort Levels for `/think`

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`/think` raises one turn to `llm.main.deepEffort` (`high`) and `llm.fallback.deepEffort` (`max`); `features.think`
switches it per chat.

## Rationale

One step above each role's normal effort (`medium`, `high`). The benchmark of effort levels (#28) measured transports
only, so these are a start.

## Source

Migrated from row 83 of the Architecture table in the former `docs/DECISIONS.md`.
