# ADR-0018: Return `NO_REPLY` for a Turn With Nothing to Send

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A turn with nothing to send returns `NO_REPLY`. This reverses the earlier row that returned empty content.

## Rationale

Measured: the gateway reads empty content as a failed model, asks 3 more times, then sends its own notice. It sends
nothing for `NO_REPLY`.

## Source

Migrated from row 18 of the Architecture table in the former `docs/DECISIONS.md`.
