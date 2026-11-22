# ADR-0104: Read Each Platform Through an Ordered Reader Chain

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

An ordered reader chain reads each platform; later readers fill only missing fields.

## Rationale

Partial results stay useful without treating blocked pages as readable posts.

## Source

Migrated from row 104 of the Architecture table in the former `docs/DECISIONS.md`.
