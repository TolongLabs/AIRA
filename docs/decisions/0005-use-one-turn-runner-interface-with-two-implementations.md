# ADR-0005: Use One Turn Runner Interface With Two Implementations

- **Date:** 2026-11-15
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

One turn runner interface with two implementations: an API runner and a subscription runner.

## Rationale

The prompt, tools and cleaning chain stay identical on both transports (PRD FR-32).

## Source

Migrated from row 5 of the Architecture table in the former `docs/DECISIONS.md`.
