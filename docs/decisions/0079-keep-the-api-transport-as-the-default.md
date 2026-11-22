# ADR-0079: Keep the API Transport as the Default

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`llm.transport` stays `api`: the benchmark on dev2 put it 2.3 s ahead of the subscription runner on casual turns and
level on tool turns.

## Rationale

Measured (S-4): casual p50 3.2 s against 5.5 s; tool p50 6.9 s against 5.8 s, p90 9.0 s against 8.9 s.

## Source

Migrated from row 79 of the Architecture table in the former `docs/DECISIONS.md`.
