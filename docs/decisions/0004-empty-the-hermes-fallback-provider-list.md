# ADR-0004: Empty the Hermes Fallback Provider List

- **Date:** 2026-11-15
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Hermes's fallback provider list is emptied. The core always returns a deliverable reply.

## Rationale

It removes the second agent loop, the duplicate tool set and the second voice.

## Source

Migrated from row 4 of the Architecture table in the former `docs/DECISIONS.md`.
