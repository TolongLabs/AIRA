# ADR-0014: Split the 68 Gateway Patches Into Keep, Dead and Removed

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Of the 68 gateway patches, 44 stay, 20 become dead code left until the next re-pin, 2 follow the owner tools and 2 are
removed.

## Rationale

The core now owns replies, tools and failures. Leaving dead patches in place keeps cutover small.

## Source

Migrated from row 14 of the Architecture table in the former `docs/DECISIONS.md`.
