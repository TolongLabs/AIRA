# ADR-0107: Reject Access-Block Pages as Failed Reads

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Both page providers reject access-block pages as failed reads.

## Rationale

The character must react to a failed read instead of repeating a block page as its answer.

## Source

Migrated from row 107 of the Architecture table in the former `docs/DECISIONS.md`.
